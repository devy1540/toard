import assert from "node:assert/strict";
import { test } from "node:test";
import { toHistoryPreview } from "./prompt-history";

test("toHistoryPreview extracts the request after generated attachment metadata", () => {
  const text = `# Files mentioned by the user:

## codex-clipboard-6f8ff59c.png: /var/folders/demo/codex-clipboard-6f8ff59c.png

## My request for Codex:
내 히스토리쪽이 지금 보기도 어렵고 개선이 필요할꺼같아.
<image name="capture" path="/tmp/capture.png">ignored</image>`;

  assert.equal(toHistoryPreview(text), "내 히스토리쪽이 지금 보기도 어렵고 개선이 필요할꺼같아.");
});

test("toHistoryPreview removes attachment-only preambles", () => {
  const text = `# File mentioned by the user:

## codex-clipboard-da9e61ae.png: /var/folders/demo/codex-clipboard-da9e61ae.png`;

  assert.equal(toHistoryPreview(text), "");
});

test("toHistoryPreview keeps normal prompts compact", () => {
  assert.equal(toHistoryPreview("정리하면 신규 파이프라인을 이용해서 진행할까?\n\n1번 작업은 어떻게 할까?"), "정리하면 신규 파이프라인을 이용해서 진행할까? 1번 작업은 어떻게 할까?");
});
