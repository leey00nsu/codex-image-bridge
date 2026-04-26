import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { test } from "node:test";
import { createBridgeServer } from "../src/http.mjs";
import { makeBridgeError } from "../src/codex-runner.mjs";

async function withServer(options, fn) {
  const server = createBridgeServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

async function requestJson(baseUrl, path, { method = "GET", token, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function defer() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function pollJob(baseUrl, jobId, token) {
  return requestJson(baseUrl, `/v1/images/jobs/${jobId}`, { token });
}

async function waitForJob(baseUrl, jobId, token, status) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await pollJob(baseUrl, jobId, token);
    if (response.body.status === status) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for job status ${status}`);
}

test("health endpoint does not require auth", async () => {
  await withServer(
    {
      token: "secret-token",
      runGeneration: async () => {
        throw new Error("should not run");
      },
      checkReady: async () => ({ ok: true }),
    },
    async (baseUrl) => {
      const response = await requestJson(baseUrl, "/health");
      assert.equal(response.status, 200);
      assert.equal(response.body.status, "ok");
    },
  );
});

test("generate endpoint requires bearer token and forwards normalized payload", async () => {
  const calls = [];
  await withServer(
    {
      token: "secret-token",
      runGeneration: async (payload) => {
        calls.push(payload);
        return { images: ["data:image/png;base64,AAAA"] };
      },
      checkReady: async () => ({ ok: true }),
    },
    async (baseUrl) => {
      const unauthorized = await requestJson(baseUrl, "/v1/images/generate", {
        method: "POST",
        body: { prompt: "x" },
      });
      assert.equal(unauthorized.status, 401);

      const authorized = await requestJson(baseUrl, "/v1/images/generate", {
        method: "POST",
        token: "secret-token",
        body: {
          prompt: "  x  ",
          modelId: "gpt-image-2",
          agentModel: "gpt-5.5",
          width: 1024,
          height: 1024,
          initImages: ["data:image/png;base64,AAAA"],
        },
      });
      assert.equal(authorized.status, 200);
      assert.deepEqual(authorized.body.images, ["data:image/png;base64,AAAA"]);
      assert.deepEqual(calls, [
        {
          prompt: "x",
          modelId: "gpt-image-2",
          agentModel: "gpt-5.5",
          width: 1024,
          height: 1024,
          initImages: ["data:image/png;base64,AAAA"],
        },
      ]);
    },
  );
});

test("generate endpoint maps runner errors to stable json responses", async () => {
  await withServer(
    {
      token: "secret-token",
      runGeneration: async () => {
        const error = new Error("CODEX_OAUTH_REQUIRED");
        error.status = 503;
        throw error;
      },
      checkReady: async () => ({ ok: false }),
    },
    async (baseUrl) => {
      const response = await requestJson(baseUrl, "/v1/images/generate", {
        method: "POST",
        token: "secret-token",
        body: { prompt: "x" },
      });
      assert.equal(response.status, 503);
      assert.equal(response.body.error.code, "CODEX_OAUTH_REQUIRED");
      assert.match(response.body.error.message, /ChatGPT OAuth/);
    },
  );
});

test("job endpoint requires bearer token and returns a pollable job", async () => {
  const generation = defer();
  const calls = [];
  await withServer(
    {
      token: "secret-token",
      runGeneration: async (payload) => {
        calls.push(payload);
        return generation.promise;
      },
      checkReady: async () => ({ ok: true }),
    },
    async (baseUrl) => {
      const unauthorized = await requestJson(baseUrl, "/v1/images/jobs", {
        method: "POST",
        body: { prompt: "x" },
      });
      assert.equal(unauthorized.status, 401);

      const created = await requestJson(baseUrl, "/v1/images/jobs", {
        method: "POST",
        token: "secret-token",
        body: {
          prompt: "  x  ",
          modelId: "gpt-image-2",
          agentModel: "gpt-5.5",
          width: 1024,
          height: 1024,
          initImages: ["data:image/png;base64,AAAA"],
        },
      });

      assert.equal(created.status, 202);
      assert.equal(typeof created.body.jobId, "string");
      assert.match(created.body.jobId, /^[0-9a-f-]+$/);
      assert.match(created.body.createdAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.match(created.body.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.ok(["queued", "processing"].includes(created.body.status));

      const processing = await pollJob(baseUrl, created.body.jobId, "secret-token");
      assert.equal(processing.status, 200);
      assert.ok(["queued", "processing"].includes(processing.body.status));

      generation.resolve({ images: ["data:image/png;base64,AAAA"] });
      const completed = await waitForJob(
        baseUrl,
        created.body.jobId,
        "secret-token",
        "completed",
      );

      assert.equal(completed.status, 200);
      assert.deepEqual(completed.body.images, ["data:image/png;base64,AAAA"]);
      assert.deepEqual(calls, [
        {
          prompt: "x",
          modelId: "gpt-image-2",
          agentModel: "gpt-5.5",
          width: 1024,
          height: 1024,
          initImages: ["data:image/png;base64,AAAA"],
        },
      ]);
    },
  );
});

test("job endpoint maps runner errors to failed job responses", async () => {
  await withServer(
    {
      token: "secret-token",
      runGeneration: async () => {
        throw makeBridgeError("CODEX_OAUTH_REQUIRED", 503);
      },
      checkReady: async () => ({ ok: true }),
    },
    async (baseUrl) => {
      const created = await requestJson(baseUrl, "/v1/images/jobs", {
        method: "POST",
        token: "secret-token",
        body: { prompt: "x" },
      });
      assert.equal(created.status, 202);

      const failed = await waitForJob(
        baseUrl,
        created.body.jobId,
        "secret-token",
        "failed",
      );

      assert.equal(failed.status, 200);
      assert.equal(failed.body.error.code, "CODEX_OAUTH_REQUIRED");
      assert.equal(failed.body.error.status, 503);
      assert.match(failed.body.error.message, /ChatGPT OAuth/);
    },
  );
});

test("job polling requires auth and reports unknown jobs as json 404", async () => {
  await withServer(
    {
      token: "secret-token",
      runGeneration: async () => ({ images: ["data:image/png;base64,AAAA"] }),
      checkReady: async () => ({ ok: true }),
    },
    async (baseUrl) => {
      const unauthorized = await requestJson(baseUrl, "/v1/images/jobs/missing");
      assert.equal(unauthorized.status, 401);

      const missing = await requestJson(baseUrl, "/v1/images/jobs/missing", {
        token: "secret-token",
      });
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, "NOT_FOUND");
    },
  );
});

test("ready endpoint reports the underlying readiness error", async () => {
  await withServer(
    {
      token: "secret-token",
      runGeneration: async () => {
        throw new Error("should not run");
      },
      checkReady: async () => {
        throw makeBridgeError("CODEX_OAUTH_REQUIRED", 503);
      },
    },
    async (baseUrl) => {
      const response = await requestJson(baseUrl, "/ready");
      assert.equal(response.status, 503);
      assert.equal(response.body.status, "not_ready");
      assert.equal(response.body.error.code, "CODEX_OAUTH_REQUIRED");
      assert.match(response.body.error.message, /ChatGPT OAuth/);
    },
  );
});

test("unknown routes return json 404", async () => {
  await withServer(
    {
      token: "secret-token",
      runGeneration: async () => ({ images: [] }),
      checkReady: async () => ({ ok: true }),
    },
    async (baseUrl) => {
      const response = await requestJson(baseUrl, "/missing");
      assert.equal(response.status, 404);
      assert.equal(response.body.error.code, "NOT_FOUND");
    },
  );
});
