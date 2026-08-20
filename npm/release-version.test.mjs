import assert from "node:assert/strict";
import test from "node:test";
import { releaseTagFor } from "./release-version.mjs";

test("새 공개 버전은 무접두 태그를 사용한다", () => {
  assert.equal(releaseTagFor("0.0.1"), "0.0.1");
  assert.equal(releaseTagFor("0.0.2"), "0.0.2");
  assert.equal(releaseTagFor("1.0.0"), "1.0.0");
});

test("기존 0.x 버전과 명시적 v 태그는 레거시 다운로드 경로를 유지한다", () => {
  assert.equal(releaseTagFor("0.15.55"), "v0.15.55");
  assert.equal(releaseTagFor("v0.15.55"), "v0.15.55");
  assert.equal(releaseTagFor("latest"), "latest");
  assert.throws(() => releaseTagFor("release-1"), /invalid toard release version/);
});
