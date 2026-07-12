import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";
import { createIsolatedPostgresPoolConfig } from "./rollup-worker-state.integration-test-support";

const EXPECTED_ERROR =
  "integration test requires a localhost database whose name ends with _test";

function assertSafelyRejected(databaseUrl: string): void {
  assert.throws(
    () => createIsolatedPostgresPoolConfig(databaseUrl),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, EXPECTED_ERROR);
      assert.doesNotMatch(error.message, /secret-user|secret-password/);
      return true;
    },
  );
}

test("query host override를 연결 설정 생성 전에 거부한다", () => {
  assertSafelyRejected(
    "postgresql://secret-user:secret-password@localhost/sample_test?host=prod.example.com",
  );
});

test("query Unix socket override를 연결 설정 생성 전에 거부한다", () => {
  assertSafelyRejected(
    "postgresql://secret-user:secret-password@127.0.0.1/sample_test?host=%2Ftmp%2Fremote",
  );
});

test("pg가 환경변수로 대체하는 0번 포트를 거부한다", () => {
  assertSafelyRejected(
    "postgresql://secret-user:secret-password@localhost:0/sample_test",
  );
});

test("PostgreSQL startup packet을 바꾸는 database NUL을 거부한다", () => {
  assertSafelyRejected(
    "postgresql://secret-user:secret-password@localhost/prod%00application_name%00_test",
  );
});

test("안전한 localhost URL은 구조화된 로컬 연결 설정을 만든다", () => {
  const config = createIsolatedPostgresPoolConfig(
    "postgresql://test-user:test-password@localhost:55432/sample_test",
  );
  const client = new Client(config);

  assert.equal(config.connectionString, undefined);
  assert.equal(client.host, "localhost");
  assert.equal(client.port, 55432);
  assert.equal(client.database, "sample_test");
});
