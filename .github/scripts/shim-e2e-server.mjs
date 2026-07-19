import {
  appendFileSync,
  createReadStream,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { basename, join } from "node:path";

const [releaseDirectory, portFile, captureFile, failureControlFile] =
  process.argv.slice(2);
if (!releaseDirectory || !portFile) {
  throw new Error(
    "usage: shim-e2e-server.mjs <release-directory> <port-file> [capture-jsonl] [failure-control]",
  );
}

const ingestRoutes = new Map([
  ["/v1/logs", "POST"],
  ["/v1/events", "POST"],
  ["/v1/prompts", "POST"],
  ["/v1/tool-events", "POST"],
  ["/v1/tool-inventory", "PUT"],
  ["/v1/events/reconcile", "POST"],
]);

function ingestSuffix(pathname) {
  return [...ingestRoutes.keys()].find((suffix) => pathname.endsWith(suffix));
}

function shouldFail(pathname) {
  if (!failureControlFile || !existsSync(failureControlFile)) return false;
  return readFileSync(failureControlFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .some((marker) => pathname.includes(marker));
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const suffix = ingestSuffix(url.pathname);
  if (suffix && request.method === ingestRoutes.get(suffix)) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const authorization = request.headers.authorization ?? "";
      const authorizationScheme = authorization.match(/^([^\s]+)\s+/)?.[1] ?? null;
      if (captureFile) {
        appendFileSync(
          captureFile,
          `${JSON.stringify({
            method: request.method,
            path: url.pathname,
            authorizationScheme,
            bodyHash: createHash("sha256").update(body).digest("hex"),
          })}\n`,
        );
      }
      if (shouldFail(url.pathname)) {
        response.writeHead(503, { "content-type": "application/json" });
        response.end('{"error":"temporarily unavailable"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"inserted":1,"deduped":0,"reconciled":1}');
    });
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
