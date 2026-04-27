# codex-image-bridge

Small HTTP service that runs Codex CLI image generation for containerized apps.

The service owns the Codex CLI and `CODEX_HOME`; client applications call it over HTTP and do not need Codex CLI installed.

The runner uses Codex CLI's built-in `imagegen` skill with `codex exec --full-auto --json --enable image_generation`, low reasoning effort, and direct artifact recovery from `CODEX_HOME/generated_images`.

## API

### `GET /health`

Returns `200` when the bridge process is alive.

### `GET /ready`

Returns `200` when Codex CLI is installed and `codex login status` reports ChatGPT OAuth login. This endpoint does not run image generation.

### `POST /v1/images/generate`

Compatibility endpoint for direct synchronous generation. Prefer the async job API below for public Coolify/Cloudflare routes because image generation can take longer than proxy request timeouts.

Requires:

```http
Authorization: Bearer <CODEX_BRIDGE_TOKEN>
Content-Type: application/json
```

Body:

```json
{
  "prompt": "두쫀쿠를 팔고 있는 매장을 찍은 사진",
  "modelId": "gpt-image-2",
  "agentModel": "gpt-5.5",
  "width": 1024,
  "height": 1024,
  "initImages": []
}
```

Response:

```json
{
  "images": ["data:image/png;base64,..."]
}
```

### `POST /v1/images/jobs`

Creates a generation job and returns quickly.

Requires the same auth header and body as `POST /v1/images/generate`.

Response:

```json
{
  "jobId": "7d1d4e58-8f06-43b0-81ba-f59d2f9c2d5f",
  "status": "queued",
  "createdAt": "2026-04-27T00:00:00.000Z",
  "updatedAt": "2026-04-27T00:00:00.000Z"
}
```

### `GET /v1/images/jobs/{jobId}`

Polls a generation job.

Queued or processing response:

```json
{
  "jobId": "7d1d4e58-8f06-43b0-81ba-f59d2f9c2d5f",
  "status": "processing",
  "createdAt": "2026-04-27T00:00:00.000Z",
  "updatedAt": "2026-04-27T00:00:01.000Z"
}
```

Completed response:

```json
{
  "jobId": "7d1d4e58-8f06-43b0-81ba-f59d2f9c2d5f",
  "status": "completed",
  "createdAt": "2026-04-27T00:00:00.000Z",
  "updatedAt": "2026-04-27T00:02:00.000Z",
  "images": ["data:image/png;base64,..."]
}
```

Failed response:

```json
{
  "jobId": "7d1d4e58-8f06-43b0-81ba-f59d2f9c2d5f",
  "status": "failed",
  "createdAt": "2026-04-27T00:00:00.000Z",
  "updatedAt": "2026-04-27T00:02:00.000Z",
  "error": {
    "code": "CODEX_OAUTH_REQUIRED",
    "message": "Codex CLI ChatGPT OAuth login is required.",
    "status": 503
  }
}
```

Jobs are stored in memory and completed/failed jobs expire after `CODEX_BRIDGE_JOB_TTL_MS` (default: 30 minutes). Generation concurrency defaults to one job and can be adjusted with `CODEX_BRIDGE_MAX_CONCURRENT_JOBS`.

Only `data:image/png|jpeg|webp;base64,...` init images are accepted. The bridge does not fetch remote input image URLs.

## Coolify Deployment

Create a separate Coolify application for this project.

Recommended settings:

- Build Pack: Dockerfile
- Port: `18080`
- Public domain: not required when only leesfield calls it internally
- Persistent Storage destination: `/app/.codex`

Runtime environment variables:

```env
CODEX_BRIDGE_TOKEN=<long-random-token>
CODEX_HOME=/app/.codex
CODEX_BRIDGE_PORT=18080
CODEX_BRIDGE_HOST=0.0.0.0
# Optional:
CODEX_BRIDGE_TIMEOUT_MS=900000
CODEX_BRIDGE_JOB_TTL_MS=1800000
CODEX_BRIDGE_MAX_CONCURRENT_JOBS=1
```

After the first deployment, open the Coolify terminal for this resource and run:

```bash
codex login
codex login status
```

`codex login status` must report ChatGPT login. The OAuth files are stored in `/app/.codex`, so normal redeployments keep the login state.

Use Codex CLI `0.124.0` or newer so `codex exec --full-auto`, `--json`, and `--enable image_generation` are available.

## Local Run

```bash
export CODEX_BRIDGE_TOKEN=dev-token
export CODEX_HOME="$HOME/.codex"
npm start
```

Smoke request:

```bash
JOB_ID=$(curl -sS http://127.0.0.1:18080/v1/images/jobs \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"두쫀쿠를 팔고 있는 매장을 찍은 사진","modelId":"gpt-image-2","agentModel":"gpt-5.5","width":1024,"height":1024,"initImages":[]}' \
  | node -pe 'JSON.parse(fs.readFileSync(0, "utf8")).jobId')

curl -sS "http://127.0.0.1:18080/v1/images/jobs/${JOB_ID}" \
  -H "Authorization: Bearer dev-token"
```

## Security Notes

- Keep the bridge off the public internet when possible.
- Always set `CODEX_BRIDGE_TOKEN`.
- Do not mount the same `CODEX_HOME` volume into unrelated applications.
- Codex receives only a small environment allowlist: `PATH`, home/temp/locale fields, and `CODEX_HOME`.
- Generated images are recovered from the request temp directory or `CODEX_HOME/generated_images`, and must pass image magic-byte validation before being returned.
