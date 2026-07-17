# Final production remediation — Task 2 보고서

## 상태

DONE

## 구현

- `bootstrap-app-role.sql`은 broad table grant 뒤 `installation_identity`와
  `content_encryption_status`를 `SELECT` 전용으로 다시 닫고,
  `managed_content_keys`는 `SELECT`/`INSERT`/`UPDATE`만 남긴다.
- migration 35도 role-before topology에서 default broad privilege가 남지 않게 같은 세
  table을 먼저 `REVOKE ALL`한다. migration 40은 write-fence 함수의 toard_app grant를
  명시적 revoke 뒤 재부여한다.
- 모든 `toard-admin encryption` DB lease는 첫 query 전에
  `assertManagedContentDatabaseRoleReady`를 호출한다. managed-disabled에서는 helper가
  query 없이 return하고, enabled owner/BYPASSRLS는 기존 고정 secret-free 오류로 닫힌다.
- Deployment pod template에 encryption ConfigMap render의 SHA-256 annotation을 추가했다.
  동일 `migrate.releaseId`에서도 provider key ref, migration profile, cost 변경은 rollout을
  유발하며 annotation에는 ConfigMap 값/Secret 원문을 넣지 않는다.
- `--actor-user-id`를 인증된 CLI caller가 아닌 operator가 지정하고 DB admin role로
  확인되는 approval subject로 코드·런북·감사 DTO 설명에서 정정했다. 실제 operator
  attribution은 content-admin workload 및 외부 orchestration audit 책임이다.

## TDD 증거

### RED

- `각 managed content-admin DB lease는 첫 query 전에 role readiness를 확인한다`은 기존
  구현에서 `ADMIN_COMMAND_FAILED`(exit 1)로 실패했다.
- `동일 release ID에서도 encryption ConfigMap 변경은 ... checksum rollout`은 annotation
  부재로 실패했다.
- role-before PostgreSQL topology에서 `installation_identity INSERT` privilege가 `true`로
  남아 실패했다.

### GREEN

- `scripts/toard-admin.test.ts`: 16 pass.
- `scripts/bootstrap-app-role.integration.test.ts` +
  `scripts/managed-content-write-fence-migration.integration.test.ts`: 10 pass.
- bootstrap integration은 role-before/role-after/rebootstrap에서 exact
  `has_table_privilege`, singleton UPDATE/DELETE 거부, managed key DELETE 거부를 실제
  PostgreSQL 16 컨테이너로 확인했다. owner/BYPASSRLS/app role readiness도 같은 suite에서
  확인했다.
- `scripts/helm-encryption-render.test.ts`: 34 pass.
- `scripts/compose-encryption-config.test.ts`: 8 pass.
- `node --import tsx scripts/validate-helm-encryption.ts --set-string secrets.authSecret=dummy`:
  Helm lint/template 성공.
- `node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit`: 성공.
- `git diff --check`: 성공.

## 환경 메모

`pnpm --filter @toard/web typecheck`는 비대화형 환경에서 pnpm이 기존 modules directory
제거 확인을 요구해 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`로 중단됐다. 의존성 변경
없이 동일 web tsconfig를 로컬 `tsc --noEmit`으로 실행해 typecheck를 완료했다.
