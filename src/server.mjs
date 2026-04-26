import { createBridgeServer } from "./http.mjs";

const host = process.env.CODEX_BRIDGE_HOST || "0.0.0.0";
const port = Number(process.env.CODEX_BRIDGE_PORT || 18080);

const server = createBridgeServer();

server.listen(port, host, () => {
  console.log(`codex-image-bridge listening on ${host}:${port}`);
});

function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  server.close(() => {
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
