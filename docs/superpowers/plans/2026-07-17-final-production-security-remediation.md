# Final Production Security Remediation Plan

**Goal:** 최종 전체 브랜치 리뷰의 P1 7건과 P2 5건을 모두 해소하고, live traffic 중 provider 전환과 legacy late arrival에서도 데이터 유실 없이 production 배포 가능한 상태를 다시 증명한다.

## Global constraints

- 모든 수정은 RED 테스트부터 작성한다.
- 기존 ciphertext, wrapper, provider audit event를 삭제하지 않는다.
- provider 전환 중 신규 UCK writer와 완료 판정은 같은 distribution advisory lock으로 직렬화한다.
- credential, UCK, DEK, KEK, provider 원문 오류 및 DB role detail을 응답/로그에 노출하지 않는다.
- managed-disabled 기존 설치 호환을 유지한다.
- 외부 cloud credential은 만들지 않으며 실제 배포 activation 전 real target canary를 필수로 남긴다.

## Task 1 — Provider cutover continuity, durable write fence, readiness

**Primary files:**

- `apps/web/lib/managed-user-keys.ts`
- `apps/web/lib/managed-user-keys.test.ts`
- `apps/web/lib/content-encryption-readiness.ts`
- `apps/web/lib/content-encryption-readiness.test.ts`
- `apps/web/lib/encryption-admin-status.ts`
- `apps/web/lib/encryption-admin-status.test.ts`
- `scripts/toard-admin.ts`
- `scripts/toard-admin.test.ts`
- provider migration PostgreSQL integration tests

1. Same-version wrapper 조회는 `active`를 먼저 선택하고, active가 registry에서 해석되지 않을 때만 해석 가능한 `retiring` 후보로 fallback한다. 상태와 생성 시각/ID를 이용해 deterministic하게 선택한다.
2. `provider_migration_started` 기록 transaction은 `lock_managed_content_key_distribution()`을 먼저 잡는다.
3. 신규 UCK 생성 transaction도 같은 lock을 잡은 뒤 latest durable `provider_migration_started` target fingerprint를 조회한다. 값이 있으면 그 fingerprint provider로 wrap하고, 없을 때만 configured active provider를 사용한다. Registry에 target이 없으면 old로 fallback하지 않고 fail-closed한다.
4. 따라서 start 이전 writer는 old insert를 완료한 뒤 migration enumeration에 포함되고, start 이후 writer는 target만 사용한다. Abort 뒤에도 target profile을 유지하거나 reverse migration을 시작해야 하며 latest start가 지속 가능한 write provider fence가 된다.
5. Readiness는 `content_encryption_status`와 `managed_content_key_distribution` snapshot을 검증한다. 모든 `active`와 `pending` fingerprint가 current registry에서 해석 가능하고 aggregate row가 malformed/overflow가 아니어야 한다. 불일치는 generic 503으로 닫는다. `retiring`은 old provider 제거 뒤에도 허용한다.
6. Admin status는 active와 migration target health/credential source를 별도로 반환한다. Rewrap은 target wrap/unwrap canary가 healthy인 경우에만 started audit/fence를 기록하며 wrapper 0건이어도 생략하지 않는다.
7. Unit 및 실제 PostgreSQL concurrency 테스트로 old writer/start ordering, start 후 신규 target wrapper, completion 뒤 신규 writer, target-only restart, active/retiring deterministic read, wrapper fingerprint mismatch 503을 증명한다.

## Task 2 — Database/CLI deployment privilege boundary

**Primary files:**

- `scripts/bootstrap-app-role.sql`
- `scripts/bootstrap-app-role.integration.test.ts`
- `scripts/toard-admin.ts`
- `scripts/toard-admin.test.ts`
- `helm/toard/templates/deployment.yaml`
- Helm render tests and encryption validator
- `docs/content-encryption-runbook.md`

1. Broad grant 뒤 `installation_identity`와 `content_encryption_status`는 `REVOKE ALL` 후 SELECT-only, `managed_content_keys`는 정확히 SELECT/INSERT/UPDATE만 부여한다. DELETE/TRUNCATE/REFERENCES/TRIGGER 및 singleton UPDATE/DELETE를 거부한다.
2. Bootstrap의 role-before/role-after topology와 재실행 모두에서 exact privileges 및 실제 mutation denial을 PostgreSQL로 검증한다.
3. 모든 managed content-admin command는 DB lease 직후 `assertManagedContentDatabaseRoleReady`를 실행한다. Managed-disabled이면 추가 query 없이 기존 동작, managed-enabled owner/BYPASSRLS이면 secret-free 고정 오류로 종료한다.
4. Encryption ConfigMap 렌더 checksum을 Deployment pod-template annotation에 넣어 같은 release ID의 provider/key-ref/migration/cost 변경도 rollout을 일으킨다. Secret 값 자체는 annotation에 노출하지 않는다.
5. `actor_user_id`는 CLI operator의 인증 identity가 아니라 인프라 접근통제 아래 operator가 지정하고 DB에서 admin role을 확인한 approval subject임을 코드/런북/감사 문구에 정확히 정의한다. 실제 operator attribution은 content-admin workload 및 외부 orchestration audit에 둔다. 인증된 로그인 호출자라고 과장하는 문구를 제거한다.

## Task 3 — Lossless late E2EE, bounded input, memory zeroization

**Primary files:**

- `apps/web/lib/prompt-records.ts`
- `apps/web/app/api/v1/prompts/route.ts`
- `apps/web/app/api/content/recovery/complete/route.ts`
- relevant route/security/PostgreSQL integration tests
- `apps/web/lib/key-management/user-key-cache.ts`
- `apps/web/lib/key-management/user-key-cache.test.ts`
- `apps/web/lib/key-management/aws-kms-provider.ts`
- `apps/web/lib/key-management/aws-kms-provider.test.ts`

1. Legacy E2EE save는 owner/key-version 검증을 유지하면서 account state `active|migrated`를 허용한다. 실제 `/api/v1/prompts` late ciphertext가 DB trigger로 migration/account를 재개하고 재migration되는 PostgreSQL 통합 테스트를 추가한다.
2. Prompt POST는 인증 뒤 `readBoundedJson` 4 MiB streaming limit을 사용한다. Recovery complete는 auth/capability 뒤 256 KiB streaming limit을 사용한다. Content-Length 선거부, chunked early cancel, boundary, malformed JSON, 413 및 no-store 계약을 검증한다.
3. UCK cache는 unref 단일 expiry scheduler와 bounded LRU capacity를 사용한다. TTL이 지나면 재접근 없이 즉시 zeroize/delete하고, capacity eviction도 zeroize한다. Timer는 process 종료를 막지 않으며 clear도 모든 buffer/timer를 정리한다.
4. AWS KMS decrypt는 복사본뿐 아니라 SDK `Plaintext` 원본 Uint8Array도 `finally`에서 zeroize한다. Alias 여부와 성공/실패 모두를 테스트한다.

## Task 4 — Full production gate and final independent review

1. Focused remediation tests와 실제 PostgreSQL integration을 모두 통과시킨다.
2. `pnpm test`, `pnpm typecheck`, `pnpm build`, Docker 4 target build/inspect, Compose all-profile, Helm strict lint/template, Rust 1.88, runtime local-KMS readiness smoke를 fresh하게 재실행한다.
3. `git diff --check 30a9076..HEAD`와 clean worktree를 확인한다. Lint 구현 부재는 pass로 표현하지 않는다.
4. 최상위 독립 리뷰어가 P1/P2 12건 각각의 해소와 전체 branch regression을 재검토해 `Clean`일 때만 완료한다.
