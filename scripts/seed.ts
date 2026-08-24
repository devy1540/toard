import "dotenv/config"; // 루트 .env 로드 (셸 env 우선)
import bcrypt from "bcryptjs";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main(): Promise<void> {
  // providers (service.name 매핑 — 설계 §4.4).
  // claude_code·codex 는 사용량을 트랜스크립트 pull 로 수집한다(collection_method='logfile',
  // docs/design-usage-pull). service_name_patterns 는 experimental OTLP(TOARD_EXPERIMENTAL_OTLP)
  // 되켤 때를 위해 보존한다. OTLP 로 되켜려면 collection_method 를 'otel' 로 바꾸면 된다.
  await pool.query(
    `INSERT INTO providers (key, display_name, service_name_patterns, collection_method, enabled)
     VALUES
       ('claude_code', 'Claude Code', ARRAY['claude-code','claude-code-desktop'], 'logfile', true),
       ('codex', 'Codex', ARRAY['codex','codex_cli_rs','codex_exec'], 'logfile', true),
       ('cursor', 'Cursor', ARRAY[]::text[], 'logfile', true),
       ('gemini', 'Gemini CLI', ARRAY[]::text[], 'logfile', true),
       ('qwen', 'Qwen Code', ARRAY[]::text[], 'logfile', true)
     ON CONFLICT (key) DO NOTHING`,
  );
  console.log("✓ providers");

  // 가격 시드 (LiteLLM 동기화 전 최소 — per-million USD)
  await pool.query(
    `INSERT INTO pricing_revisions
       (model_id, input_price_per_mtok, output_price_per_mtok, cache_read_price_per_mtok,
        cache_creation_price_per_mtok, effective_at, source)
     VALUES
       ('claude-sonnet-4-5', 3, 15, 0.3, 3.75, TIMESTAMPTZ '2025-01-01T00:00:00Z', 'litellm'),
       ('claude-opus-4-5', 15, 75, 1.5, 18.75, TIMESTAMPTZ '2025-01-01T00:00:00Z', 'litellm')
     ON CONFLICT (model_id, effective_at, source) DO NOTHING`,
  );
  console.log("✓ pricing_revisions");

  // admin 부트스트랩 (§10.4)
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  if (!adminEmail) {
    console.log("⚠ BOOTSTRAP_ADMIN_EMAIL 미설정 — admin 시드 생략");
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

  // ingest token은 배포/CI 로그에 평문이 남지 않도록 seed에서 만들지 않는다.
  // 관리자가 로그인한 뒤 Settings > Computers 온보딩에서 직접 1회 발급한다.
  console.log("✓ ingest token: 로그인 후 Settings > Computers에서 발급");

  await pool.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
