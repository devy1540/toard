// 정적 데모용 집계 데이터 생성기 — GitHub Pages 정적 대시보드(site/demo)가 읽는 JSON을 만든다.
// scripts/seed-demo.ts 의 이벤트 생성 로직을 그대로 재현해 DB 없이 동일 숫자를 산출한다.
// (seed-demo 를 바꾸면 이 파일도 함께 맞춰야 한다 — 두 곳의 상수/공식이 일치해야 데모가 실제와 같다.)
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "site", "demo", "demo-data.json");

// ── seed-demo.ts 와 동일한 상수 ──
const DEPTS = [
  { name: "엔지니어링", members: [["eng-alice@example.com", "Alice"], ["eng-bob@example.com", "Bob"]] },
  { name: "프로덕트", members: [["pm-carol@example.com", "Carol"]] },
  { name: "디자인", members: [["design-dave@example.com", "Dave"]] },
];
const PRICE = { "claude-sonnet-4-5": [3, 15], "claude-opus-4-5": [15, 75] };
const MODELS = Object.keys(PRICE);
const DAYS = 5;

// ── seed-demo.ts 의 이벤트 루프 재현 → 이벤트 배열 ──
const events = [];
let seq = 0;
for (const d of DEPTS) {
  for (const [email, name] of d.members) {
    for (let day = 0; day < DAYS; day++) {
      const count = 2 + (day % 3);
      for (let i = 0; i < count; i++) {
        seq++;
        const model = MODELS[seq % MODELS.length];
        const [pi, po] = PRICE[model];
        const input = 1000 + ((seq * 137) % 8000);
        const output = 300 + ((seq * 71) % 2000);
        const cost = (input * pi + output * po) / 1e6;
        events.push({
          team: d.name,
          userKey: email,
          userLabel: name,
          dayOffset: day, // 0 = 오늘, 4 = 4일 전
          session: `${email}-${day}`,
          model,
          input,
          output,
          cost,
        });
      }
    }
  }
}

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const distinct = (arr, f) => new Set(arr.map(f)).size;

// ── 대시보드 SQL 과 동일 의미의 집계 ──
const overview = {
  totalSessions: distinct(events, (e) => e.session),
  activeUsers: distinct(events, (e) => e.userKey),
  totalCostUsd: sum(events, (e) => e.cost),
  totalInputTokens: sum(events, (e) => e.input),
  totalOutputTokens: sum(events, (e) => e.output),
};

// daily: dayOffset(0..4) 별 집계 — 클라이언트가 offset → 실제 날짜로 라벨링(항상 최근처럼 보이게)
const daily = [];
for (let day = 0; day < DAYS; day++) {
  const ev = events.filter((e) => e.dayOffset === day);
  daily.push({
    dayOffset: day,
    sessions: distinct(ev, (e) => e.session),
    costUsd: sum(ev, (e) => e.cost),
    inputTokens: sum(ev, (e) => e.input),
    outputTokens: sum(ev, (e) => e.output),
  });
}

function groupLeaders(keyOf, labelOf) {
  const map = new Map();
  for (const e of events) {
    const k = keyOf(e);
    let row = map.get(k);
    if (!row) {
      row = { key: k, label: labelOf(e), costUsd: 0, totalTokens: 0, _sessions: new Set() };
      map.set(k, row);
    }
    row.costUsd += e.cost;
    row.totalTokens += e.input + e.output;
    row._sessions.add(e.session);
  }
  return [...map.values()]
    .map((r) => ({ key: r.key, label: r.label, costUsd: r.costUsd, totalTokens: r.totalTokens, sessions: r._sessions.size }))
    .sort((a, b) => b.costUsd - a.costUsd);
}

const leaderboardUser = groupLeaders((e) => e.userKey, (e) => e.userLabel);
const leaderboardTeam = groupLeaders((e) => e.team, (e) => e.team);

const byModel = (() => {
  const map = new Map();
  for (const e of events) {
    let row = map.get(e.model);
    if (!row) {
      row = { model: e.model, costUsd: 0, totalTokens: 0, _sessions: new Set() };
      map.set(e.model, row);
    }
    row.costUsd += e.cost;
    row.totalTokens += e.input + e.output;
    row._sessions.add(e.session);
  }
  return [...map.values()]
    .map((r) => ({ model: r.model, costUsd: r.costUsd, totalTokens: r.totalTokens, sessions: r._sessions.size }))
    .sort((a, b) => b.costUsd - a.costUsd);
})();

const data = {
  meta: {
    source: "seed:demo (scripts/seed-demo.ts) 재현 — 합성 데이터",
    teams: DEPTS.length,
    members: sum(DEPTS, (d) => d.members.length),
    days: DAYS,
    provider: "claude_code",
    models: MODELS,
  },
  overview,
  daily,
  leaderboardUser,
  leaderboardTeam,
  byModel,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");

console.log("생성:", OUT);
console.log(
  `총비용 $${overview.totalCostUsd.toFixed(2)} · 세션 ${overview.totalSessions} · 사용자 ${overview.activeUsers} · 토큰 ${(
    (overview.totalInputTokens + overview.totalOutputTokens) /
    1000
  ).toFixed(1)}K`,
);
console.log("팀 순위:", leaderboardTeam.map((t) => `${t.label} $${t.costUsd.toFixed(2)}`).join(" · "));
