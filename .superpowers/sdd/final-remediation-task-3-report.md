# Final remediation Task 3 report

## 구현 범위

- `saveE2eePromptRecords()`가 기존 owner/key version 검증을 유지한 채 account state `active`와 `migrated`를 모두 허용한다.
- `/api/v1/prompts`는 인증 후 `readBoundedJson(..., 4 MiB)`을 사용하고, recovery complete는 인증·capability 확인 후 `readBoundedJson(..., 256 KiB)`을 사용한다. 두 경로 모두 size error를 413으로 반환하며 recovery 응답은 계속 `Cache-Control: no-store`다.
- UCK cache에 기본 capacity 256의 LRU, 단일 unref expiry timer, explicit `clear()`를 추가했다. TTL/capacity/clear에서 cache buffer를 zeroize하고 stale timer callback은 현재 scheduler를 교체하지 않는다. 기존 single-flight 경로는 유지했다.
- AWS KMS decrypt는 SDK `Plaintext` 원본과 복사본을 각각 `finally`에서 zeroize한다. 정상, decode 실패, copy 실패, alias view를 모두 검증했다.
- PostgreSQL 통합 테스트가 실제 `/api/v1/prompts` handler를 통해 migrated E2EE account에 late ciphertext를 저장하고, trigger가 migration/account를 pending/active로 재개한 뒤 managed 재migration까지 완료하는 것을 검증한다.

## 검증 증적

```text
apps/web:
node --import tsx --test lib/prompt-records.test.ts app/api/v1/prompts/route.test.ts app/api/content/recovery/complete/route.test.ts lib/key-management/user-key-cache.test.ts lib/key-management/aws-kms-provider.test.ts
50 pass, 0 fail

repository root:
TSX_TSCONFIG_PATH=apps/web/tsconfig.json node --import tsx --test --test-concurrency=1 scripts/e2ee-to-managed-migration.integration.test.ts
1 pass, 0 fail

./apps/web/node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit
exit 0

git diff --check
exit 0
```

`pnpm typecheck`은 현재 Codex runtime의 pnpm 11이 기존 workspace `node_modules`를 purge하려다 비대화형 확인에서 중단되어 실행할 수 없었다. 위 TypeScript 명령은 동일한 `apps/web` typecheck script의 컴파일러/tsconfig을 직접 실행한 결과다.
