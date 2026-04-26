# codex-image-bridge

Small HTTP service that runs Codex CLI image generation for containerized apps.

The service owns the Codex CLI and `CODEX_HOME`; client applications call it over HTTP and do not need Codex CLI installed.

## API

### `GET /health`

Returns `200` when the bridge process is alive.

### `POST /v1/images/generate`

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
```

After the first deployment, open the Coolify terminal for this resource and run:

```bash
codex login
codex login status
```

`codex login status` must report ChatGPT login. The OAuth files are stored in `/app/.codex`, so normal redeployments keep the login state.

## Local Run

```bash
export CODEX_BRIDGE_TOKEN=dev-token
export CODEX_HOME="$HOME/.codex"
npm start
```

Smoke request:

```bash
curl -sS http://127.0.0.1:18080/v1/images/generate \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"두쫀쿠를 팔고 있는 매장을 찍은 사진","modelId":"gpt-image-2","agentModel":"gpt-5.5","width":1024,"height":1024,"initImages":[]}'
```

## Security Notes

- Keep the bridge off the public internet when possible.
- Always set `CODEX_BRIDGE_TOKEN`.
- Do not mount the same `CODEX_HOME` volume into unrelated applications.
- Codex receives only a small environment allowlist: `PATH`, home/temp/locale fields, and `CODEX_HOME`.
- The generated image must be in the request temp directory and must pass image magic-byte validation.
