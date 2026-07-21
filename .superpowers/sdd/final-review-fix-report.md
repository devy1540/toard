# Final review remediation report

## 기준과 범위

- Base: `5510b7c5b0c40d1bf38debaf570a93d99d9f9ffc`
- 구현 commit: `08295a7` (`fix(clickhouse): share process operation budget`)
- 구현 scope: `operation-controller.ts`, `operation-controller.test.ts`, `storage.ts`, `storage.test.ts` 네 파일, 402 insertions / 30 deletions
- production DB, schema/data migration, deployment, `clickhouse/users.d/toard-limits.xml`, `.superpowers/sdd/progress.md`는 변경하지 않았다.

## Findings, root cause, fix

### 1. Next bundle별 module singleton 복제

Root cause는 `defaultClickHouseOperationController`가 module 하단의 평범한 `new`였다는 점이다. Next가 instrumentation과 route용 storage package를 서로 다른 server chunk로 emit하면 각 module 평가가 max-4 controller를 따로 만들 수 있었다.

기본 controller를 `Symbol.for("toard.clickhouse.operation-controller")`와 `globalThis` registry의 `??=`로 생성하도록 바꿨다. 명시적인 `new ClickHouseOperationController(...)` API는 그대로라 isolated unit test controller에는 영향이 없다.

회귀 test는 query string이 다른 두 module URL을 같은 JS realm에서 import한다. 두 module namespace가 서로 다른 object인 동시에 default controller는 object-identical임을 확인한다. 두 copy를 번갈아 사용해 8개 controlled promise 작업을 예약했을 때 최초 시작은 `[0, 1, 2, 3]`, 첫 반환 다음 시작은 `4`, aggregate `maxActive`는 정확히 4다.

### 2. Overload retry가 network opt-in에 종속

Root cause는 overload 분기에도 `options.retryTransient` 조건이 붙어 있던 것이다. overload 검사를 network opt-in과 분리했다.

- Code `202` 또는 `TOO_MANY_SIMULTANEOUS_QUERIES`: 모든 operation이 최대 2 attempts, jitter sleep 1회
- transient network: `retryTransient:true` operation만 최대 5 attempts
- command/insert network 기본값: 1 attempt
- 각 attempt의 lease는 `finally`에서 반환된 뒤 sleep하므로 backoff 동안 slot을 잡지 않는다.

무옵션 insert/command style action에서 반복 overload의 2 attempts와 typed final error, 두 번째 성공, controlled overload sleep 중 다른 작업의 입장을 각각 검증했다. 기존 무옵션 insert `ECONNRESET` 1 attempt와 opt-in network 5 attempts도 계속 통과한다.

### 3. Schema DDL network retry 회귀

Root cause는 `queryJson()`이 `ensureSchema()`를 retrying read callback 밖에서 먼저 기다리지만 schema command 자체에는 network opt-in이 없었던 것이다.

현재 runtime schema SQL을 확인했다. `CREATE`/`ADD`/`DROP`은 `IF NOT EXISTS` 또는 `IF EXISTS`를 사용하고, 나머지 `ALTER ... MODIFY SETTING/TTL`은 같은 목표 상태로 수렴하므로 response-loss 뒤 재실행해도 idempotent하다. 모든 schema DDL을 `runSchemaCommand()`로 모아 그 command operation 자체에만 `retryTransient:true`를 적용했다.

`ensureSchema()`는 outer read lease를 얻기 전에 실행되고 DDL retry sleep도 controller callback 밖에서 일어난다. 따라서 outer read slot을 잡은 채 schema command slot을 기다리는 nested-gate cycle은 없다. maxConcurrent 1 test에서 첫 DDL backoff 중 별도 operation이 실제 입장한 뒤 schema와 JSON read가 완료되는 것을 검증했다.

실측 attempts는 첫 DDL `ECONNRESET` 후 성공 2회, persistent DDL network 실패 5회다.

### 4. ClickHouse error `.type` 미인식

Root cause는 cause chain walker가 `.code`만 수집한 것이다. walker가 각 object의 `.code`와 normalized uppercase `.type`을 모두 수집하도록 바꿨고 cyclic cause visited guard는 유지했다.

- 실제 설치된 `ClickHouseError` shape(`code: "202"`, `type: "TOO_MANY_SIMULTANEOUS_QUERIES"`)를 사용한 회귀 test
- outer cause 안의 type-only overload 회귀 test
- `.type`을 포함한 cyclic object 회귀 test
- safe log가 message/SQL/parameter 대신 numeric `errorCode: "202"`만 남기는 회귀 test

로그 error code는 cause chain 전체의 numeric code를 우선하고, 다음으로 code, 마지막으로 normalized type을 사용한다.

### 5. Logger throw가 primary error를 masking

최종 structured logger 호출을 best-effort `try/catch`로 감쌌다. logger 실패를 별도로 기록하지 않아 민감 context가 추가로 노출되지 않는다. 일반 operation error는 exact object identity가 유지되고, overload는 typed `ClickHouseOverloadError`와 exact original `cause`가 유지됨을 검증했다.

### 6. Intentional compactor warning noise

의도적으로 aggregate query를 실패시키는 compactor fixture에만 no-op structured logger가 있는 isolated controller를 주입했다. production/default logging은 바꾸지 않았다. rollback과 watermark 미진척 assertion은 그대로다.

## TDD RED / GREEN evidence

### RED

Controller test를 먼저 추가한 첫 실행:

```text
tests 17, pass 9, fail 8
```

의도대로 실패한 항목은 distinct module default identity, 무옵션 overload 2 attempts/second-attempt success/backoff slot 반환, ClickHouse `.type`, logger primary/typed error 보존이었다. 기존 module copy는 controller가 서로 달랐고 무옵션 overload attempt는 1이었다.

Schema/source guard test를 먼저 추가한 첫 실행:

```text
tests 4, pass 0, fail 4
first schema ECONNRESET: immediate failure
persistent schema network attempts: actual 1, expected 5
schema backoff entered: false
retryTransient source occurrences: actual 2, expected 3
```

Intentional compactor failure의 수정 전 focused 실행은 다음 safe warning을 실제 출력했다.

```text
{"event":"clickhouse_operation_failed","backend":"clickhouse","operation":"clickhouse_query","errorClass":"query","attempt":1,...}
```

### GREEN

```text
operation-controller focused: 17/17 pass
schema + source guard + compactor focused: 5/5 pass, warning 없음
storage-clickhouse full: 113 pass, 1 opt-in integration skip
```

## Next production build / chunk evidence

`corepack pnpm --filter @toard/web build`는 Next 15.5.19 production build를 5.9초에 compile했고 exit 0이었다.

현재 build output에서 instrumentation과 route는 실제로 다른 controller module copy를 가진다.

| Entry | Loaded controller chunk |
|---|---|
| `.next/server/instrumentation.js` | `chunks/8009.js` |
| `.next/server/app/api/ready/route.js` | `chunks/2730.js` |
| `.next/server/app/(dashboard)/org/page.js` | `chunks/2730.js` |

두 별도 chunk의 실측은 다음과 같다.

| Chunk | Bytes | Registry key count | `Symbol.for` offset | `globalThis` offset | `??= new` |
|---|---:|---:|---:|---:|---|
| `2730.js` | 79,100 | 1 | 3,449 | 3,503 | yes |
| `8009.js` | 78,809 | 1 | 3,431 | 3,485 | yes |

두 chunk 모두 정확히 `Symbol.for("toard.clickhouse.operation-controller")`와 `globalThis` registry initializer를 emit했다. 따라서 같은 Node realm에서 어느 copy가 먼저 평가되든 동일 controller object를 얻는다.

## Full verification matrix

모든 명령은 `corepack pnpm`으로 fresh 실행했다.

| Command | Result |
|---|---|
| `--filter @toard/core test` | exit 0, 42 pass |
| `--filter @toard/core typecheck` | exit 0 |
| `--filter @toard/storage-postgres test` | exit 0, 17 pass |
| `--filter @toard/storage-postgres typecheck` | exit 0 |
| `--filter @toard/storage-clickhouse test` | exit 0, 113 pass / 1 skip |
| `--filter @toard/storage-clickhouse typecheck` | exit 0 |
| `--filter @toard/web test` | exit 0, 814 pass / 2 skip |
| `--filter @toard/web typecheck` | exit 0 |
| `--filter @toard/web build` | exit 0 |
| `git diff --check` | exit 0 |

기존 storage regression은 `/org` snapshot이 core ClickHouse JSON read를 정확히 2개만 사용하고 background usage read와 겹쳐도 max 4임을 계속 검증한다.

## Real disposable ClickHouse integration and cleanup

- Image: repository-pinned `clickhouse/clickhouse-server:24-alpine`
- Owned container: `toard-final-review-6e09`, `--rm`, host volume 없음
- Binding: loopback-only `127.0.0.1:33078`
- `RUN_CLICKHOUSE_DASHBOARD_INTEGRATION=1` real test: 6/6 pass, snapshot exact parity pass
- Test 종료 뒤 `toard_dashboard_%` database count: `0`
- Owned container만 stop했고 `--rm` 제거를 확인했다.
- 종료 뒤 같은 loopback port의 connection 실패를 확인해 port release를 검증했다.
- 기존 `toard-clickhouse-dev` container는 작업 전후 모두 `Exited (0)` 상태로 건드리지 않았다.

## Final scope inspection and remaining concern

- `git diff 5510b7c..08295a7 -- clickhouse/users.d/toard-limits.xml migrations`: empty
- server `max_concurrent_queries_for_user=6`: 변경 없음
- schema/data migration, production DB, production endpoint, deploy: 수행하지 않음
- 모든 확정 finding에 대응하는 회귀 test가 있다.

미해결 finding은 없다. 이 gate는 설계대로 한 JS realm/process의 합산 상한을 4로 제한하며 app replica 사이의 분산 budget은 조정하지 않는다. production runtime은 이번 작업 범위에서 측정하지 않았고, chunk number 자체는 다음 build에서 달라질 수 있으므로 위 evidence는 이 commit의 fresh production build 결과다.
