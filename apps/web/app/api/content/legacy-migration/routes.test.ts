import assert from "node:assert/strict";
import test from "node:test";
import { GET as pageGet } from "./page/route";
import { POST as commitPost } from "./commit/route";
import { GET as statusGet } from "./status/route";

test("open mode blocks every legacy migration endpoint with no-store", async () => {
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = "open";
  try {
    const responses = await Promise.all([
      statusGet(),
      pageGet(new Request("http://localhost/api/content/legacy-migration/page")),
      commitPost(new Request("http://localhost/api/content/legacy-migration/commit", { method: "POST" })),
    ]);
    for (const response of responses) {
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { code: "E2EE_AUTH_REQUIRED" });
    }
  } finally {
    if (previous === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = previous;
  }
});
