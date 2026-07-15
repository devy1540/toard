import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DateRangePicker } from "./date-range-picker";

test("완성된 날짜 범위를 단일 shadcn trigger로 표시한다", () => {
  const html = renderToStaticMarkup(
    <DateRangePicker
      range={{ from: new Date(2026, 6, 12, 12), to: new Date(2026, 6, 15, 12) }}
      onSelect={() => {}}
      locale="ko"
      ariaLabel="날짜 범위"
      placeholder="날짜 범위 선택"
    />,
  );

  assert.match(html, /data-slot="date-range-picker"/);
  assert.match(html, /2026\. 7\. 12\./);
  assert.match(html, /2026\. 7\. 15\./);
  assert.match(html, /aria-label="날짜 범위"/);
  assert.doesNotMatch(html, /type="date"/);
});

test("완성된 범위가 없으면 번역된 placeholder를 표시한다", () => {
  const html = renderToStaticMarkup(
    <DateRangePicker
      range={undefined}
      onSelect={() => {}}
      locale="en"
      ariaLabel="Date range"
      placeholder="Select date range"
    />,
  );

  assert.match(html, /Select date range/);
});
