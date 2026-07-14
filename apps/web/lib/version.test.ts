import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  HISTORICAL_PRICING_MIN_READER_VERSION,
  supportsHistoricalPricingReader,
} from "./version";

test("과거 가격 revision reader는 v0.15.16부터 호환되고 로컬 dev는 허용한다", () => {
  assert.equal(HISTORICAL_PRICING_MIN_READER_VERSION, "0.15.16");
  assert.equal(supportsHistoricalPricingReader("0.15.15"), false);
  assert.equal(supportsHistoricalPricingReader("v0.15.16"), true);
  assert.equal(supportsHistoricalPricingReader("0.16.0"), true);
  assert.equal(supportsHistoricalPricingReader("0.0.0"), true);
});

test("ready 응답은 현재·최소 historical pricing reader 버전을 기록한다", () => {
  const route = readFileSync(new URL("../app/api/ready/route.ts", import.meta.url), "utf8");
  assert.match(route, /historicalPricingReader/);
  assert.match(route, /minimumVersion: HISTORICAL_PRICING_MIN_READER_VERSION/);
  assert.match(route, /compatible: supportsHistoricalPricingReader/);
});
