import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectProviderError,
  providerError,
} from "./provider-error";

const CODES = new Set(["TEMPORARY", "THROTTLED"]);

test("직접 brand된 provider error의 exact allowlisted code만 식별한다", () => {
  const error = providerError("aws-kms", "THROTTLED");
  assert.equal(error.message, "aws-kms:THROTTLED");
  assert.equal(inspectProviderError(error, "aws-kms", CODES), "THROTTLED");
  assert.equal(inspectProviderError(error, "gcp-kms", CODES), null);
  assert.equal(
    inspectProviderError(
      providerError("aws-kms", "AUTH_FAILED"),
      "aws-kms",
      CODES,
    ),
    null,
  );
});

test("raw Error, getter, Proxy는 exact 문자열이어도 provider brand로 인정하지 않는다", () => {
  const getter = new Error("placeholder");
  Object.defineProperty(getter, "message", {
    get() {
      return "aws-kms:THROTTLED";
    },
  });
  const branded = providerError("aws-kms", "THROTTLED");

  for (const error of [
    new Error("aws-kms:THROTTLED"),
    new Error("aws-kms:TEMPORARY requestId=secret"),
    new Error("gcp-kms:THROTTLED"),
    getter,
    new Proxy(branded, {}),
  ]) {
    assert.equal(inspectProviderError(error, "aws-kms", CODES), null);
  }
});
