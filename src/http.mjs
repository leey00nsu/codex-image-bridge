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

export function createBridgeServer({
  token = process.env.CODEX_BRIDGE_TOKEN,
  runGeneration = runCodexGeneration,
  checkReady,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  const readinessCheck = checkReady || checkCodexReady;

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
      const notFound = new Error("NOT_FOUND");
      notFound.code = "NOT_FOUND";
      notFound.status = 404;
      notFound.message = "Not found.";
      throw notFound;
    } catch (error) {
      errorResponse(response, error);
      logBridgeFailure(request, error, startedAt);
    }
  });
}
