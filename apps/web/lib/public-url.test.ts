import assert from "node:assert/strict";
import test from "node:test";
import { localShimTargetId } from "./public-url";

test("local shim target id matches the Rust normalized endpoint contract", () => {
  const expected = "b32c928e17b97eadcecf5a299019f204690787ad39dc98366347693f5eb59059";
  assert.equal(localShimTargetId("HTTPS://Toard.Example:443/team/api/"), expected);
  assert.equal(localShimTargetId("https://toard.example/team/api"), expected);
});
