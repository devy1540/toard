// 데모 시드: 부서·멤버·사용량 이벤트를 넣어 리더보드 부서 모드를 채운다.
// 운영 seed(scripts/seed.ts)와 분리된 데모 전용. 멱등(dedup_key/email ON CONFLICT).
import "dotenv/config"; // 루트 .env 로드 (셸 env 우선)
import { createHash } from "node:crypto";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const DEPTS: Array<{ name: string; members: Array<[string, string]> }> = [
  { name: "엔지니어링", members: [["eng-alice@example.com", "Alice"], ["eng-bob@example.com", "Bob"]] },
  { name: "프로덕트", members: [["pm-carol@example.com", "Carol"]] },
  { name: "디자인", members: [["design-dave@example.com", "Dave"]] },
];

const PRICE: Record<string, [number, number]> = {
  "claude-sonnet-4-5": [3, 15],
  "claude-opus-4-5": [15, 75],
};
const MODELS = Object.keys(PRICE);

async function deptId(name: string): Promise<string> {
  const ex = await pool.query<{ id: string }>("SELECT id FROM departments WHERE name = $1", [name]);
  if (ex.rows[0]) return ex.rows[0].id;
  const r = await pool.query<{ id: string }>("INSERT INTO departments (name) VALUES ($1) RETURNING id", [name]);
  return r.rows[0]!.id;
}

async function userId(email: string, name: string, dept: string): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, department_id, role) VALUES ($1, $2, $3, 'member')
     ON CONFLICT (email) DO UPDATE SET department_id = $3, name = $2 RETURNING id`,
    [email, name, dept],
  );
  return r.rows[0]!.id;
}

async function main(): Promise<void> {
  let seq = 0;
  for (const d of DEPTS) {
    const dept = await deptId(d.name);
    for (const [email, name] of d.members) {
      const uid = await userId(email, name, dept);
      for (let day = 0; day < 5; day++) {
        const count = 2 + (day % 3);
        for (let i = 0; i < count; i++) {
          seq++;
          const model = MODELS[seq % MODELS.length]!;
          const [pi, po] = PRICE[model]!;
          const input = 1000 + ((seq * 137) % 8000);
          const output = 300 + ((seq * 71) % 2000);
          const ts = new Date(Date.now() - day * 86400000 - i * 3600000);
          const cost = (input * pi + output * po) / 1e6;
          const dedup = createHash("sha256").update(`demo-${uid}-${seq}`).digest("hex");
          await pool.query(
            `INSERT INTO usage_events
               (dedup_key, provider_key, user_id, session_id, model, ts, input_tokens, output_tokens, cost_usd)
             VALUES ($1, 'claude_code', $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (dedup_key) DO NOTHING`,
            [dedup, uid, `demo-${uid}-${day}`, model, ts, input, output, cost],
          );
        }
      }
      console.log(`✓ ${name} (${d.name})`);
    }
  }
  console.log("데모 시드 완료 — 부서 3 · 멤버 4");
  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
