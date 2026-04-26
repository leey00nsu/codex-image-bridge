import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildCodexArgs,
  buildCodexEnv,
  decodeDataUrlImage,
  makeBridgeError,
  mapCodexError,
  runCodexGeneration,
} from "../src/codex-runner.mjs";

const BASE_PAYLOAD = {
  prompt: "두쫀쿠를 팔고 있는 매장을 찍은 사진",
  modelId: "gpt-image-2",
  agentModel: "gpt-5.5",
  width: 1024,
  height: 1024,
};

test("buildCodexArgs uses imagegen prompt and local sandboxed codex exec flags", () => {
  const args = buildCodexArgs({
    payload: BASE_PAYLOAD,
    tempDir: "/tmp/codex-bridge-123",
    outputPath: "/tmp/codex-bridge-123/result.png",
    inputImagePaths: [],
  });

  assert.deepEqual(args.slice(0, 2), ["--ask-for-approval", "never"]);
  assert.equal(args[2], "exec");
  assert.equal(args[args.indexOf("--model") + 1], "gpt-5.5");
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.ok(args.includes("--ephemeral"));
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--ignore-rules"));
  assert.ok(args.at(-1).includes("$imagegen Generate exactly one image with gpt-image-2"));
  assert.ok(args.at(-1).includes("Save or copy the final image to /tmp/codex-bridge-123/result.png"));
  assert.ok(args.at(-1).includes("CODEX_HOME/generated_images"));
  assert.ok(args.at(-1).includes("Do not use macOS-only tools"));
});

test("buildCodexArgs inserts prompt separator after image attachments", () => {
  const args = buildCodexArgs({
    payload: BASE_PAYLOAD,
    tempDir: "/tmp/codex-bridge-123",
    outputPath: "/tmp/codex-bridge-123/result.png",
    inputImagePaths: ["/tmp/codex-bridge-123/input-1.png"],
  });

  const imageIndex = args.indexOf("--image");
  assert.equal(args[imageIndex + 1], "/tmp/codex-bridge-123/input-1.png");
  assert.equal(args[imageIndex + 2], "--");
  assert.ok(args[imageIndex + 3].includes("Use the attached input image as visual edit/reference input."));
});

test("buildCodexEnv only forwards the small allowlist needed by codex", () => {
  const env = buildCodexEnv({
    sourceEnv: {
      PATH: "/usr/local/bin",
      HOME: "/home/bridge",
      CODEX_HOME: "/app/.codex",
      DATABASE_URL: "postgres://secret",
      OPENAI_API_KEY: "secret",
    },
    modelId: "gpt-image-2",
    outputPath: "/tmp/result.png",
  });

  assert.equal(env.PATH, "/usr/local/bin");
  assert.equal(env.HOME, "/home/bridge");
  assert.equal(env.CODEX_HOME, "/app/.codex");
  assert.equal(env.CODEX_IMAGE_MODEL, "gpt-image-2");
  assert.equal(env.CODEX_IMAGE_OUTPUT_PATH, "/tmp/result.png");
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
});

test("decodeDataUrlImage accepts real png data URLs and rejects non-images", () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ]);
  const decoded = decodeDataUrlImage(`data:image/png;base64,${png.toString("base64")}`);

  assert.equal(decoded.mime, "image/png");
  assert.equal(decoded.extension, "png");
  assert.deepEqual(decoded.buffer, png);
  assert.throws(
    () => decodeDataUrlImage(`data:text/plain;base64,${Buffer.from("no").toString("base64")}`),
    { code: "CODEX_BRIDGE_INPUT_INVALID" },
  );
});

test("mapCodexError normalizes operational failures without leaking raw stderr", () => {
  assert.equal(
    mapCodexError(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })).code,
    "CODEX_CLI_NOT_FOUND",
  );
  assert.equal(
    mapCodexError(Object.assign(new Error("timed out"), { killed: true })).code,
    "CODEX_IMAGE_TIMEOUT",
  );
  assert.equal(mapCodexError(new Error("CODEX_OAUTH_REQUIRED")).code, "CODEX_OAUTH_REQUIRED");
  assert.equal(
    mapCodexError(makeBridgeError("CODEX_OAUTH_REQUIRED", 503)).code,
    "CODEX_OAUTH_REQUIRED",
  );
  assert.equal(mapCodexError(new Error("unexpected stderr secret")).message.includes("secret"), false);
});

test("runCodexGeneration falls back to image files in the temp directory", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "codex-runner-test-"));
  const fakeCodex = path.join(tempRoot, "fake-codex.mjs");
  const pngBytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ];

  await writeFile(
    fakeCodex,
    [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "if (process.argv[2] === 'login' && process.argv[3] === 'status') {",
      "  console.log('Logged in using ChatGPT');",
      "  process.exit(0);",
      "}",
      `writeFileSync(path.join(process.cwd(), 'alternate-output.png'), Buffer.from([${pngBytes.join(",")}]))`,
      "console.log('image generated without printing a path');",
    ].join("\n"),
  );
  await chmod(fakeCodex, 0o755);

  try {
    const result = await runCodexGeneration(BASE_PAYLOAD, {
      command: fakeCodex,
      sourceEnv: {
        PATH: process.env.PATH,
        HOME: tempRoot,
      },
    });

    assert.equal(result.images.length, 1);
    assert.ok(result.images[0].startsWith("data:image/png;base64,"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
