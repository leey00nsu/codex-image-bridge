import crypto from "node:crypto";
import http from "node:http";
import {
  ERROR_MESSAGES,
  checkCodexReady,
  makeBridgeError,
  mapCodexError,
  normalizeGenerationPayload,
  runCodexGeneration,
} from "./codex-runner.mjs";

const DEFAULT_MAX_BODY_BYTES = 24 * 1024 * 1024;
const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX_CONCURRENT_JOBS = 1;

function asPositiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function jsonResponse(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

function errorResponse(response, error) {
  const normalized = mapCodexError(error);
  jsonResponse(response, normalized.status || 500, {
    error: {
      code: normalized.code || "CODEX_IMAGE_GENERATION_FAILED",
      message: normalized.message || ERROR_MESSAGES.CODEX_IMAGE_GENERATION_FAILED,
    },
  });
  return normalized;
}

function notReadyResponse(response, error) {
  const normalized = mapCodexError(error);
  jsonResponse(response, normalized.status || 503, {
    status: "not_ready",
    error: {
      code: normalized.code || "CODEX_IMAGE_GENERATION_FAILED",
      message: normalized.message || ERROR_MESSAGES.CODEX_IMAGE_GENERATION_FAILED,
    },
  });
  return normalized;
}

function logBridgeFailure(request, error, startedAt) {
  const normalized = mapCodexError(error);
  console.error(
    JSON.stringify({
      level: "error",
      event: "bridge_request_failed",
      method: request.method,
      path: new URL(request.url || "/", "http://127.0.0.1").pathname,
      status: normalized.status || 500,
      code: normalized.code || "CODEX_IMAGE_GENERATION_FAILED",
      durationMs: Date.now() - startedAt,
    }),
  );
}

function readJsonBody(request, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(makeBridgeError("CODEX_BRIDGE_INPUT_INVALID", 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch {
        reject(makeBridgeError("CODEX_BRIDGE_INPUT_INVALID", 400));
      }
    });
    request.on("error", reject);
  });
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function assertAuthorized(request, token) {
  if (!token) {
    throw makeBridgeError("BRIDGE_TOKEN_NOT_CONFIGURED", 503);
  }
  const authorization = request.headers.authorization || "";
  const expected = `Bearer ${token}`;
  if (!timingSafeEqualString(authorization, expected)) {
    const error = new Error("UNAUTHORIZED");
    error.code = "UNAUTHORIZED";
    error.status = 401;
    error.message = "Unauthorized.";
    throw error;
  }
}

function makeHttpError(code, status, message) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.message = message;
  return error;
}

function makeNotFoundError() {
  return makeHttpError("NOT_FOUND", 404, "Not found.");
}

function serializeJobError(error) {
  const normalized = mapCodexError(error);
  return {
    code: normalized.code || "CODEX_IMAGE_GENERATION_FAILED",
    message: normalized.message || ERROR_MESSAGES.CODEX_IMAGE_GENERATION_FAILED,
    status: normalized.status || 500,
  };
}

function createJobQueue({
  runGeneration,
  jobTtlMs,
  maxConcurrentJobs,
  now = Date.now,
}) {
  const jobs = new Map();
  const queue = [];
  let activeJobs = 0;

  function iso(timestamp) {
    return new Date(timestamp).toISOString();
  }

  function touch(job) {
    job.updatedAtMs = now();
  }

  function cleanupJobs() {
    const cutoff = now() - jobTtlMs;
    for (const [jobId, job] of jobs.entries()) {
      if (
        job.updatedAtMs < cutoff &&
        job.status !== "queued" &&
        job.status !== "processing"
      ) {
        jobs.delete(jobId);
      }
    }
  }

  function toResponseBody(job) {
    const body = {
      jobId: job.id,
      status: job.status,
      createdAt: iso(job.createdAtMs),
      updatedAt: iso(job.updatedAtMs),
    };
    if (job.status === "completed") {
      body.images = Array.isArray(job.images) ? job.images : [];
    }
    if (job.status === "failed") {
      body.error = job.error;
    }
    return body;
  }

  function processQueue() {
    while (activeJobs < maxConcurrentJobs && queue.length > 0) {
      const job = queue.shift();
      if (!job || !jobs.has(job.id)) {
        continue;
      }

      activeJobs += 1;
      job.status = "processing";
      touch(job);

      Promise.resolve()
        .then(() => runGeneration(job.payload))
        .then((result) => {
          job.status = "completed";
          job.images = Array.isArray(result?.images) ? result.images : [];
        })
        .catch((error) => {
          job.status = "failed";
          job.error = serializeJobError(error);
          console.error(
            JSON.stringify({
              level: "error",
              event: "bridge_job_failed",
              jobId: job.id,
              status: job.error.status,
              code: job.error.code,
            }),
          );
        })
        .finally(() => {
          touch(job);
          activeJobs -= 1;
          cleanupJobs();
          processQueue();
        });
    }
  }

  function create(payload) {
    cleanupJobs();
    const timestamp = now();
    const job = {
      id: crypto.randomUUID(),
      status: "queued",
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
      payload,
      images: undefined,
      error: undefined,
    };
    jobs.set(job.id, job);
    queue.push(job);
    processQueue();
    return toResponseBody(job);
  }

  function get(jobId) {
    cleanupJobs();
    const job = jobs.get(jobId);
    if (!job) {
      throw makeNotFoundError();
    }
    return toResponseBody(job);
  }

  return { create, get };
}

export function createBridgeServer({
  token = process.env.CODEX_BRIDGE_TOKEN,
  runGeneration = runCodexGeneration,
  checkReady,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  jobTtlMs = asPositiveInteger(
    process.env.CODEX_BRIDGE_JOB_TTL_MS,
    DEFAULT_JOB_TTL_MS,
  ),
  maxConcurrentJobs = asPositiveInteger(
    process.env.CODEX_BRIDGE_MAX_CONCURRENT_JOBS,
    DEFAULT_MAX_CONCURRENT_JOBS,
  ),
} = {}) {
  const readinessCheck = checkReady || checkCodexReady;
  const jobQueue = createJobQueue({
    runGeneration,
    jobTtlMs,
    maxConcurrentJobs,
  });

  return http.createServer(async (request, response) => {
    const startedAt = Date.now();
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") {
        jsonResponse(response, 200, { status: "ok" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/ready") {
        try {
          await readinessCheck();
          jsonResponse(response, 200, { status: "ready" });
        } catch (error) {
          notReadyResponse(response, error);
          logBridgeFailure(request, error, startedAt);
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/images/generate") {
        assertAuthorized(request, token);
        const body = await readJsonBody(request, maxBodyBytes);
        const payload = normalizeGenerationPayload(body);
        const result = await runGeneration(payload);
        jsonResponse(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/images/jobs") {
        assertAuthorized(request, token);
        const body = await readJsonBody(request, maxBodyBytes);
        const payload = normalizeGenerationPayload(body);
        jsonResponse(response, 202, jobQueue.create(payload));
        return;
      }
      const jobMatch = url.pathname.match(/^\/v1\/images\/jobs\/([^/]+)$/);
      if (request.method === "GET" && jobMatch) {
        assertAuthorized(request, token);
        jsonResponse(response, 200, jobQueue.get(decodeURIComponent(jobMatch[1])));
        return;
      }
      throw makeNotFoundError();
    } catch (error) {
      errorResponse(response, error);
      logBridgeFailure(request, error, startedAt);
    }
  });
}
