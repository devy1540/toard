import "dotenv/config"; // 루트 .env 로드 (셸 env 우선)
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main(): Promise<void> {
  // providers (service.name 매핑 — 설계 §4.4)
  await pool.query(
    `INSERT INTO providers (key, display_name, service_name_patterns, collection_method, enabled)
     VALUES
       ('claude_code', 'Claude Code', ARRAY['claude-code','claude-code-desktop'], 'otel', true),
       ('codex', 'Codex', ARRAY['codex','codex_cli_rs','codex_exec'], 'otel', true),
       ('gemini', 'Gemini CLI', ARRAY[]::text[], 'logfile', true),
       ('qwen', 'Qwen Code', ARRAY[]::text[], 'logfile', true)
     ON CONFLICT (key) DO NOTHING`,
  );
  console.log("✓ providers");

  // 가격 시드 (LiteLLM 동기화 전 최소 — per-million USD)
  await pool.query(
    `INSERT INTO pricing_models
       (model_id, input_price_per_mtok, output_price_per_mtok, cache_read_price_per_mtok, cache_creation_price_per_mtok, effective_date)
     VALUES
       ('claude-sonnet-4-5', 3, 15, 0.3, 3.75, '2025-01-01'),
       ('claude-opus-4-5', 15, 75, 1.5, 18.75, '2025-01-01')
     ON CONFLICT (model_id, effective_date) DO NOTHING`,
  );
  console.log("✓ pricing_models");

  // admin 부트스트랩 (§10.4)
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  if (!adminEmail) {
    console.log("⚠ BOOTSTRAP_ADMIN_EMAIL 미설정 — admin/토큰 시드 생략");
    await pool.end();
    return;
  }
  const u = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, role) VALUES ($1, 'Admin', 'admin')
     ON CONFLICT (email) DO UPDATE SET role = 'admin' RETURNING id`,
    [adminEmail],
  );
  const adminId = u.rows[0]!.id;
  console.log(`✓ admin: ${adminEmail}`);

  // (선택) admin 비밀번호 — id/pw 로그인 부트스트랩 (ADR-007).
  // OAuth 없이 credentials 로만 운영할 때 최초 로그인 수단.
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (adminPassword) {
    const pwHash = await bcrypt.hash(adminPassword, 12);
    await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [pwHash, adminId]);
    console.log("✓ admin password 설정 (id/pw 로그인 가능)");
  }

  // dev ingest token (해시만 저장, 평문은 지금만 표시)
  const token = `tk_${randomBytes(24).toString("hex")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  await pool.query("INSERT INTO ingest_tokens (user_id, token_hash) VALUES ($1, $2)", [adminId, hash]);

  console.log("\n──────────────────────────────────────────────");
  console.log("  DEV INGEST TOKEN (평문은 지금만 노출):");
  console.log(`  ${token}`);
  console.log(`\n  shim/curl: Authorization: Bearer ${token}`);
  console.log("──────────────────────────────────────────────\n");

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
