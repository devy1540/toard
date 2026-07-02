// 샘플 사용 이벤트 1건을 "현재 시각"으로 스탬프해 전송 — 설치/배포 후 수집·대시보드 확인용.
// (fixtures/sample-otlp-logs.json 은 타임스탬프가 과거 고정이라 대시보드 "최근 30일"에 안 보임)
// 사용: TOARD_INGEST_TOKEN=tk_... pnpm exec tsx scripts/send-sample-event.ts [base URL]
//   base URL 기본 http://localhost:3000 (TOARD_URL env 로도 지정 가능)
import "dotenv/config"; // 루트 .env 로드 (셸 env 우선)
import { readFileSync } from "node:fs";

const token = process.env.TOARD_INGEST_TOKEN;
if (!token) {
  console.error("TOARD_INGEST_TOKEN=tk_... 이 필요합니다 (/onboarding 에서 발급).");
  process.exit(1);
}
const base = (process.argv[2] ?? process.env.TOARD_URL ?? "http://localhost:3000").replace(/\/$/, "");

const doc = JSON.parse(
  readFileSync(new URL("../fixtures/sample-otlp-logs.json", import.meta.url), "utf8"),
);
// 모든 레코드를 현재 시각 + 유니크 request_id 로 스탬프 (재실행 시 새 이벤트로 쌓임)
let seq = 0;
for (const rl of doc.resourceLogs ?? []) {
  for (const sl of rl.scopeLogs ?? []) {
    for (const lr of sl.logRecords ?? []) {
      lr.timeUnixNano = `${Date.now()}000000`;
      for (const a of lr.attributes ?? []) {
        if (a.key === "request_id") a.value = { stringValue: `req_sample_${Date.now()}_${seq++}` };
      }
    }
  }
}

const res = await fetch(`${base}/api/v1/logs`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(doc),
});
console.log(`${res.status} ${await res.text()}`);
if (!res.ok) process.exit(1);
console.log("→ 대시보드(/)와 마이페이지(/me)의 '최근 30일'에서 바로 확인할 수 있습니다.");
