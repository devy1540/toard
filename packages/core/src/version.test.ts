import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareSemver,
  formatVersion,
  isShimOutdated,
  normalizeVersion,
  parseShimUserAgent,
} from "./version";

test("parseShimUserAgent — toard-shim UA 만 버전으로 인식", () => {
  assert.equal(parseShimUserAgent("toard-shim/0.5.0"), "0.5.0");
  assert.equal(parseShimUserAgent(" toard-shim/1.20.3 "), "1.20.3");
  assert.equal(parseShimUserAgent("curl/8.6.0"), null);
  assert.equal(parseShimUserAgent("toard-shim/abc"), null);
  assert.equal(parseShimUserAgent("toard-shim/0.5"), null);
  assert.equal(parseShimUserAgent(""), null);
  assert.equal(parseShimUserAgent(null), null);
  assert.equal(parseShimUserAgent(undefined), null);
});

test("compareSemver — 수치 비교 (사전순 아님)", () => {
  assert.ok(compareSemver("0.9.0", "0.10.0") < 0);
  assert.ok(compareSemver("1.0.0", "0.99.99") > 0);
  assert.ok(compareSemver("0.5.1", "0.5.2") < 0);
  assert.equal(compareSemver("0.5.0", "0.5.0"), 0);
});

test("isShimOutdated — shim < server 일 때만, dev(0.0.0)·비 semver 는 제외", () => {
  assert.equal(isShimOutdated("0.4.1", "0.5.0"), true);
  assert.equal(isShimOutdated("0.5.0", "0.5.0"), false);
  assert.equal(isShimOutdated("0.6.0", "0.5.0"), false);
  assert.equal(isShimOutdated("0.0.0", "0.5.0"), false);
  assert.equal(isShimOutdated("0.4.1", "0.0.0"), false);
  assert.equal(isShimOutdated("0.4.1", "main"), false);
});

test("normalizeVersion — v 접두 semver 만 벗기고 나머지는 원문", () => {
  assert.equal(normalizeVersion("v0.5.0"), "0.5.0");
  assert.equal(normalizeVersion("0.5.0"), "0.5.0");
  assert.equal(normalizeVersion("main"), "main");
  assert.equal(normalizeVersion("v2beta"), "v2beta");
});

test("formatVersion — semver 는 v 접두, dev·원문 유지", () => {
  assert.equal(formatVersion("0.5.0"), "v0.5.0");
  assert.equal(formatVersion("0.0.0"), "dev");
  assert.equal(formatVersion("main"), "main");
});
