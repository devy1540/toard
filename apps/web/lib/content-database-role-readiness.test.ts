import assert from "node:assert/strict";
import test from "node:test";
import {
  assertManagedContentDatabaseRoleReady,
  type ContentDatabaseRoleReadinessDb,
} from "./content-database-role-readiness";

const MANAGED_ENV = {
  TOARD_KEY_ACTIVE_PROVIDER: "aws-kms",
  TOARD_KEY_ACTIVE_AWS_KEY_ARN:
    "arn:aws:kms:ap-northeast-2:123456789012:key/12345678-1234-1234-1234-123456789012",
  TOARD_KEY_ACTIVE_AWS_REGION: "ap-northeast-2",
};

function database(
  rows: Array<Record<string, unknown>>,
  calls: string[] = [],
): ContentDatabaseRoleReadinessDb {
  return {
    async query(sql) {
      calls.push(sql);
      return { rows };
    },
  };
}

test("관리형 본문이 꺼져 있으면 role metadata를 조회하지 않는다", async () => {
  const calls: string[] = [];

  await assert.doesNotReject(
    assertManagedContentDatabaseRoleReady(database([], calls), {}),
  );

  assert.deepEqual(calls, []);
});

test("관리형 본문은 NOSUPERUSER NOBYPASSRLS 현재 role만 허용한다", async () => {
  const appRoleDb = database([
    { rolname: "toard_app", rolsuper: false, rolbypassrls: false },
  ]);
  const superuserDb = database([
    { rolname: "owner_role", rolsuper: true, rolbypassrls: false },
  ]);
  const bypassRlsDb = database([
    { rolname: "bypass_role", rolsuper: false, rolbypassrls: true },
  ]);

  await assert.doesNotReject(
    assertManagedContentDatabaseRoleReady(appRoleDb, MANAGED_ENV),
  );
  await assert.rejects(
    assertManagedContentDatabaseRoleReady(superuserDb, MANAGED_ENV),
    /MANAGED_CONTENT_DATABASE_ROLE_UNSAFE/,
  );
  await assert.rejects(
    assertManagedContentDatabaseRoleReady(bypassRlsDb, MANAGED_ENV),
    /MANAGED_CONTENT_DATABASE_ROLE_UNSAFE/,
  );
});

test("관리형 본문의 누락·복수·malformed role 결과와 DB 오류는 fail-closed한다", async () => {
  const unsafeRows: Array<Array<Record<string, unknown>>> = [
    [],
    [
      { rolname: "toard_app", rolsuper: false, rolbypassrls: false },
      { rolname: "other", rolsuper: false, rolbypassrls: false },
    ],
    [{ rolname: "toard_app", rolsuper: "false", rolbypassrls: false }],
    [{ rolname: "toard_app", rolsuper: false }],
  ];

  for (const rows of unsafeRows) {
    await assert.rejects(
      assertManagedContentDatabaseRoleReady(database(rows), MANAGED_ENV),
      /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
    );
  }

  const databaseFailure: ContentDatabaseRoleReadinessDb = {
    async query() {
      throw new Error("role=owner_role password=not-for-response");
    },
  };
  await assert.rejects(
    assertManagedContentDatabaseRoleReady(databaseFailure, MANAGED_ENV),
    /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
  );
});

test("현재 session role만 조회한다", async () => {
  const calls: string[] = [];
  await assertManagedContentDatabaseRoleReady(
    database([{ rolname: "toard_app", rolsuper: false, rolbypassrls: false }], calls),
    MANAGED_ENV,
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /FROM pg_roles/);
  assert.match(calls[0]!, /WHERE rolname = current_user/);
  assert.doesNotMatch(calls[0]!, /\$1|SET ROLE|pg_authid/);
});
