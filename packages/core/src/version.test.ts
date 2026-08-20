import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compareSemver,
  compareToardVersions,
  formatVersion,
  isPublicReleaseVersion,
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

test("compareToardVersions — v* 레거시 계열보다 무접두 0.0.1 공개 계열이 최신", () => {
  assert.ok(compareToardVersions("0.15.55", "0.0.1") < 0);
  assert.ok(compareToardVersions("0.0.1", "0.15.55") > 0);
  assert.ok(compareToardVersions("0.0.1", "0.0.2") < 0);
  assert.ok(compareToardVersions("0.0.99", "1.0.0") < 0);
  assert.ok(compareToardVersions("0.15.16", "0.15.55") < 0);
});

test("isPublicReleaseVersion — 무접두 0.0.1 재시작 계열과 1.x 이상만 현재 공개 계열", () => {
  assert.equal(isPublicReleaseVersion("0.0.0"), false);
  assert.equal(isPublicReleaseVersion("0.0.1"), true);
  assert.equal(isPublicReleaseVersion("0.0.20"), true);
  assert.equal(isPublicReleaseVersion("0.15.55"), false);
  assert.equal(isPublicReleaseVersion("1.0.0"), true);
  assert.equal(isPublicReleaseVersion("main"), false);
});

test("isShimOutdated — shim < server 일 때만, dev(0.0.0)·비 semver 는 제외", () => {
  assert.equal(isShimOutdated("0.4.1", "0.5.0"), true);
  assert.equal(isShimOutdated("0.5.0", "0.5.0"), false);
  assert.equal(isShimOutdated("0.6.0", "0.5.0"), false);
  assert.equal(isShimOutdated("0.0.0", "0.5.0"), false);
  assert.equal(isShimOutdated("0.4.1", "0.0.0"), false);
  assert.equal(isShimOutdated("0.4.1", "main"), false);
  assert.equal(isShimOutdated("0.15.55", "0.0.1"), true);
  assert.equal(isShimOutdated("0.0.1", "0.15.55"), false);
});

test("normalizeVersion — v 접두 semver 만 벗기고 나머지는 원문", () => {
  assert.equal(normalizeVersion("v0.5.0"), "0.5.0");
  assert.equal(normalizeVersion("0.5.0"), "0.5.0");
  assert.equal(normalizeVersion("main"), "main");
  assert.equal(normalizeVersion("v2beta"), "v2beta");
});

test("formatVersion — 레거시는 v 접두, 새 공개 버전은 무접두로 표시", () => {
  assert.equal(formatVersion("0.5.0"), "v0.5.0");
  assert.equal(formatVersion("0.0.1"), "0.0.1");
  assert.equal(formatVersion("1.0.0"), "1.0.0");
  assert.equal(formatVersion("0.0.0"), "dev");
  assert.equal(formatVersion("main"), "main");
});
