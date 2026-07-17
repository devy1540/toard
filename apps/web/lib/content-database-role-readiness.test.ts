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

function safeRoleRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    rolname: "toard_app",
    rolsuper: false,
    rolbypassrls: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    session_user_matches_current_user: true,
    has_role_memberships: false,
    owns_rls_relations: false,
    ...overrides,
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
  const appRoleDb = database([safeRoleRow()]);
  const superuserDb = database([safeRoleRow({ rolsuper: true })]);
  const bypassRlsDb = database([safeRoleRow({ rolbypassrls: true })]);

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

test("관리형 본문은 current_user가 정확히 toard_app이어야 한다", async () => {
  await assert.rejects(
    assertManagedContentDatabaseRoleReady(
      database([safeRoleRow({ rolname: "other_app" })]),
      MANAGED_ENV,
    ),
    /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
  );
});

test("관리형 본문은 SET ROLE 세션을 허용하지 않는다", async () => {
  await assert.rejects(
    assertManagedContentDatabaseRoleReady(
      database([safeRoleRow({ session_user_matches_current_user: false })]),
      MANAGED_ENV,
    ),
    /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
  );
});

test("관리형 본문은 DB·role 생성과 replication 속성을 fail-closed한다", async () => {
  for (const attribute of ["rolcreatedb", "rolcreaterole", "rolreplication"] as const) {
    await assert.rejects(
      assertManagedContentDatabaseRoleReady(
        database([safeRoleRow({ [attribute]: true })]),
        MANAGED_ENV,
      ),
      /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
      attribute,
    );
  }
});

test("관리형 본문 role은 다른 role membership을 가질 수 없다", async () => {
  await assert.rejects(
    assertManagedContentDatabaseRoleReady(
      database([safeRoleRow({ has_role_memberships: true })]),
      MANAGED_ENV,
    ),
    /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
  );
});

test("관리형 본문 role은 RLS 보호 relation을 소유할 수 없다", async () => {
  await assert.rejects(
    assertManagedContentDatabaseRoleReady(
      database([safeRoleRow({ owns_rls_relations: true })]),
      MANAGED_ENV,
    ),
    /^Error: MANAGED_CONTENT_DATABASE_ROLE_UNSAFE$/,
  );
});

test("관리형 본문의 누락·복수·malformed role 결과와 DB 오류는 fail-closed한다", async () => {
  const unsafeRows: Array<Array<Record<string, unknown>>> = [
    [],
    [
      { rolname: "toard_app", rolsuper: false, rolbypassrls: false },
      safeRoleRow({ rolname: "other" }),
    ],
    [safeRoleRow({ rolsuper: "false" })],
    [{ ...safeRoleRow(), owns_rls_relations: undefined }],
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
    database([safeRoleRow()], calls),
    MANAGED_ENV,
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /FROM pg_roles/);
  assert.match(calls[0]!, /WHERE rolname = current_user/);
  assert.match(calls[0]!, /session_user = current_user/);
  assert.match(calls[0]!, /pg_has_role/);
  assert.match(calls[0]!, /relrowsecurity/);
  assert.doesNotMatch(calls[0]!, /\$1|SET ROLE|pg_authid/);
});
