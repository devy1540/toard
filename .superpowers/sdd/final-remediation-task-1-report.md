# Final remediation Task 1 report

## RED

- `managed-user-keys.test.ts`에 같은 key version에서 registry-resolvable active 우선, active가 해석되지 않을 때만 deterministic retiring fallback을 추가했다.
- 같은 테스트에 신규 UCK가 distribution advisory lock → 최신 durable `provider_migration_started` target 조회 → target wrap → insert 순서를 따르고, target registry 누락 때 old provider로 fallback하지 않는 회귀를 추가했다.
- `content-encryption-readiness.test.ts`에 active/pending snapshot fingerprint가 현 registry에 없으면 close하고, retiring-only old fingerprint는 허용하며 aggregate/snapshot malformed mismatch를 close하는 회귀를 추가했다.
- `toard-admin.test.ts`에 target canary가 started audit보다 앞서고 started audit transaction에서 lock → actor validation → audit insert 순서임을 추가했다.
- 최초 RED 실행은 workspace의 pnpm 11이 pnpm 9 lockfile 설정을 거부해 테스트 실행 전 중단됐다. 같은 source test는 의존성 복구 전 readiness 회귀가 기대대로 실패함을 확인했고, 이후 pinned `pnpm@9.15.0` frozen install로 환경만 복구했다. 구현 전 추가한 readiness 회귀는 `MANAGED_KEY_DISTRIBUTION_UNRESOLVABLE`/`MANAGED_KEY_DISTRIBUTION_INVALID` 부재로 실패했다.

## Design invariants

1. Durable write provider fence는 migration profile의 존재가 아니라 마지막 committed `provider_migration_started` audit의 `(provider,fingerprint)`다.
2. UCK writer와 started audit은 동일한 `lock_managed_content_key_distribution()` transaction lock으로 직렬화한다. start 전 writer는 old row를 commit하고 enumeration에 보이며, start 뒤 writer는 target wrapper만 만든다.
3. fence target이 current registry에 없으면 old active로 되돌아가지 않고 fail-closed한다. 따라서 abort 후 target profile 유지 또는 reverse migration이 필요하다.
4. 동일 version read는 resolvable active를 먼저 쓴다. active 자체가 registry-unresolvable일 때만 created_at/id 순서의 resolvable retiring 후보를 사용하며, active unwrap 오류는 fallback 사유가 아니다.
5. readiness는 `content_encryption_status` count와 `managed_content_key_distribution` snapshot의 exact aggregate를 검사하고, 모든 active/pending identity의 current registry resolution을 요구한다. retiring old identity는 제거 후에도 허용한다.
6. target wrap/unwrap canary health는 started fence 및 rewrap enumeration 전에 필수이며 zero-wrapper cutover에서도 생략하지 않는다.

## GREEN evidence

- `npx --yes pnpm@9.15.0 --filter @toard/web exec node --import tsx --test 'lib/key-management/*.test.ts'` — 124 passed.
- `npx --yes pnpm@9.15.0 --filter @toard/web exec node --import tsx --test lib/managed-user-keys.test.ts lib/content-encryption-readiness.test.ts lib/encryption-admin-status.test.ts` — 51 passed.
- `TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test scripts/toard-admin.test.ts` — 14 passed.
- `TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test scripts/provider-rewrap.integration.test.ts scripts/provider-migration-audit.integration.test.ts scripts/managed-key-distribution-migration.integration.test.ts scripts/content-key-operations-migration.integration.test.ts` — 4 PostgreSQL/Docker integrations passed, including old-writer/start ordering and target-only restart writer.
- `npx --yes pnpm@9.15.0 --filter @toard/web typecheck` — passed.

## Concerns

- Shell-default pnpm is 11.9.0 while the repository pins pnpm 9.15.0. It attempts a frozen reinstall and rejects the lockfile override shape; verification commands use `npx --yes pnpm@9.15.0` to match the repository pin.
- The target-only PostgreSQL regression uses an injected deterministic test provider. No cloud credential or real external KMS activation was created or used; production activation still requires the separately configured real target canary.
