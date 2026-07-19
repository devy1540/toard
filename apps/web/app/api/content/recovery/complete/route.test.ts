import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "./route";

function streamingRequest(
  chunks: readonly string[],
  options: { contentLength?: string } = {},
): { request: Request; cancelled: () => boolean; reads: () => number } {
  let index = 0;
  let wasCancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) return controller.close();
      controller.enqueue(Buffer.from(chunks[index++]!));
    },
    cancel() { wasCancelled = true; },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "POST",
    headers: options.contentLength ? { "content-length": options.contentLength } : {},
    body: stream,
    duplex: "half",
  };
  return {
    request: new Request("http://localhost/api/content/recovery/complete", init),
    cancelled: () => wasCancelled,
    reads: () => index,
  };
}

const allowed = {
  isAuthOpen: () => false,
  requireSession: async () => "user-1",
  capability: async () => "recovery" as const,
  complete: async (_userId: string, input: unknown) => input,
};

test("recovery complete는 auth와 capability 뒤 256KiB Content-Length를 read 전에 거부한다", async () => {
  const input = streamingRequest(["{}"], { contentLength: String(256 * 1024 + 1) });
  const response = await POST.withDependencies(allowed)(input.request);
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(input.request.bodyUsed, false);
});

test("recovery complete는 disabled capability에서 body를 읽지 않고 no-store 410을 반환한다", async () => {
  const input = streamingRequest(["{}"]);
  const response = await POST.withDependencies({
    ...allowed,
    capability: async () => "disabled" as const,
  })(input.request);
  assert.equal(response.status, 410);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(input.request.bodyUsed, false);
});

test("recovery complete는 chunked oversize를 cancel하고 exact boundary와 malformed JSON 계약을 유지한다", async () => {
  const oversized = streamingRequest(["{\"x\":\"", "x".repeat(256 * 1024), "\"}"]);
  const oversizedResponse = await POST.withDependencies(allowed)(oversized.request);
  assert.equal(oversizedResponse.status, 413);
  assert.equal(oversizedResponse.headers.get("cache-control"), "no-store");
  assert.equal(oversized.request.bodyUsed, true);

  const exact = streamingRequest([" ".repeat(256 * 1024 - 2) + "{}"]);
  const exactResponse = await POST.withDependencies(allowed)(exact.request);
  assert.equal(exactResponse.status, 201);
  assert.equal(exactResponse.headers.get("cache-control"), "no-store");

  const malformed = await POST.withDependencies(allowed)(streamingRequest(["{"]).request);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.headers.get("cache-control"), "no-store");
});
