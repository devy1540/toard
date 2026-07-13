import { createReadStream, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";

const [releaseDirectory, portFile] = process.argv.slice(2);
if (!releaseDirectory || !portFile) {
  throw new Error("usage: shim-e2e-server.mjs <release-directory> <port-file>");
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/api/v1/logs") {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
    return;
  }

  if (request.method !== "GET" || !url.pathname.startsWith("/release/")) {
    response.writeHead(404);
    response.end();
    return;
  }

  const name = decodeURIComponent(url.pathname.slice("/release/".length));
  if (!name || basename(name) !== name) {
    response.writeHead(400);
    response.end();
    return;
  }

  const stream = createReadStream(join(releaseDirectory, name));
  stream.on("error", () => {
    if (!response.headersSent) response.writeHead(404);
    response.end();
  });
  stream.pipe(response);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TCP address expected");
  writeFileSync(portFile, String(address.port));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
