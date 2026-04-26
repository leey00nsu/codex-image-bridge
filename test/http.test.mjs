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
