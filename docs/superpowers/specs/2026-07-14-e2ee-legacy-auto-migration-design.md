# E2EE 기존 기록 자동 전환 설계

## 1. 목적

기존 `server_v1` 프롬프트 기록을 사용자의 별도 조작 없이 `e2ee_v1`으로 전환한다. 최초 E2EE 설정과 현재 브라우저 승인만 끝나면 전환은 자동으로 시작되고, 브라우저를 닫거나 네트워크가 끊겨도 다음 잠금 해제 시 이어서 진행한다.

이 문서는 기존 [E2EE 프롬프트 히스토리 설계](2026-07-14-e2ee-prompt-history-design.md)의 기존 데이터 전환 부분을 구체화한다. 충돌하는 내용이 있으면 이 문서의 자동 전환·동일 행 교체·자동 잠금 해제 정책을 우선한다.

## 2. 확정한 사용자 정책

- E2EE 활성화 이후 새 `server_v1` 기록을 받지 않는다.
- 기존 기록 전환을 시작하는 버튼을 제공하지 않는다.
- 승인된 브라우저에서 UCK가 풀리면 자동 전환을 시작한다.
- 브라우저를 닫거나 전환이 실패해도 남은 `server_v1` 행을 기준으로 자동 재개한다.
- 같은 브라우저는 새로고침·브라우저 재실행 때 다시 승인하지 않는다.
- 새 브라우저, 시크릿 프로필, IndexedDB 삭제, 기기 폐기 때만 shim 승인 또는 Recovery Kit가 필요하다.
- 진행 중에는 방해하지 않는 상태만 표시하고, 운영자 조치가 필요한 오류만 사용자에게 알린다.
- 완료 조건은 해당 사용자의 `server_v1` 레코드가 0건인 것이다.
- 과거 기록의 보존 기간은 이번 전환에서 바꾸지 않는다. 레코드를 삭제하는 대신 같은 행의 암호화 방식을 원자적으로 교체한다.

## 3. 검토한 접근

### 3.1 사용자가 버튼으로 전환

구현은 단순하지만 사용자가 누르지 않으면 레거시 데이터가 계속 서버 복호화 가능 상태로 남는다. 채택하지 않는다.

### 3.2 shim이 로컬 로그를 다시 수집

서버가 레거시 평문을 브라우저에 내려주지 않아도 된다는 장점이 있다. 하지만 로컬 로그가 삭제됐거나 다른 컴퓨터에서 수집된 기록은 복원할 수 없다. 가능한 경우의 보조 경로로만 남기고 기본 전환 방식으로 채택하지 않는다.

### 3.3 승인된 브라우저가 자동 재암호화

서버가 기존 KEK로 한 번 복호화한 본문을 인증된 브라우저에 전달하고, 브라우저가 UCK로 다시 암호화한다. 모든 기존 기록을 다룰 수 있고 중단·재개가 가능하므로 채택한다.

## 4. 보안 경계

- 전환 페이지 API는 정상 로그인 세션, 활성 E2EE 계정, 승인·미폐기 브라우저 기기를 모두 요구한다.
- 브라우저는 IndexedDB의 비추출 P-256 private key로 UCK wrapper를 풀어야 한다.
- 서버는 UCK, Recovery Kit, 브라우저 private key를 받지 않는다.
- 레거시 평문 응답에는 `Cache-Control: no-store`를 적용하고 로그·오류·분석 이벤트에 본문을 기록하지 않는다.
- 전환 요청은 같은 origin에서만 허용하고 CSP 및 기존 CSRF 경계를 유지한다.
- 서버는 전환 전까지 기존 KEK로 `server_v1`을 복호화할 수 있다. 전환 완료 이전 기록을 zero-access라고 표시하지 않는다.
- 공식 브라우저 클라이언트는 암호화 직후 새 ciphertext를 로컬에서 다시 복호화해 원문과 바이트 단위로 비교한 뒤 commit한다.
- 서버는 UCK를 모르므로 새 ciphertext가 특정 평문을 담았다는 사실을 독립적으로 복호화 검증할 수 없다. 서버는 source digest, 소유자, 원본 행 상태, 메타데이터와 키 버전을 검증하고, ciphertext 의미 검증은 승인된 클라이언트의 로컬 round-trip에 의존한다.

## 5. 데이터 모델

별도의 복제 레코드나 영구 cursor 테이블을 만들지 않는다. `prompt_records.encryption_scheme='server_v1'`인 행 자체가 남은 작업 목록이다.

전환은 기존 행을 다음과 같이 동일 PK로 갱신한다.

- 유지: `id`, `dedup_key`, `user_id`, `session_id`, `provider_key`, `turn_role`, `ts`, `received_at`
- 교체: `key_version`, `wrapped_dek`, `iv`, `ciphertext`, `auth_tag`
- 설정: `encryption_scheme='e2ee_v1'`, `content_owner_id`, `content_key_version`, `dek_wrap_iv`, `dek_wrap_auth_tag`, `aad_version=1`

동일 행 UPDATE를 사용하므로 세션 링크, dedup 식별자, 정렬 순서가 바뀌지 않는다. 트랜잭션이 실패하면 행 전체가 `server_v1` 상태로 남는다.

## 6. API

### 6.1 상태

`GET /api/content/legacy-migration/status`

응답:

```json
{
  "state": "pending",
  "contentOwnerId": "018f47d0-4d47-7b04-950b-7d18a86e1b43",
  "contentKeyVersion": 1,
  "legacyRecords": 120,
  "migratableRecords": 119,
  "blockedRecords": 1,
  "e2eeRecords": 80,
  "totalRecords": 200
}
```

서버의 `state`는 `pending`, `complete`, `blocked` 중 하나다. DB에는 상태를 저장하지 않고 남은 행 수, E2EE의 1MB ciphertext 계약으로 이전 가능한 행 수, KEK 가용성으로 계산한다. `contentOwnerId`와 `contentKeyVersion`은 브라우저가 새 E2EE AAD와 DEK wrapper를 만들 때 사용한다. 브라우저는 worker가 실행 중일 때 `pending`을 화면의 `running` 상태로 바꾼다. 완료는 `legacyRecords === 0`으로만 판정한다. 과거 1MB 초과 행만 남으면 `blocked`이며, 행을 삭제하거나 전체 queue를 막지 않고 `server_v1`으로 보존한다.

### 6.2 페이지 조회

`GET /api/content/legacy-migration/page?limit={25|50|100}`

요청 헤더 `X-Toard-Content-Device-Id`의 브라우저가 현재 사용자 소유이며 승인됐고 폐기되지 않았는지 확인한다. E2EE의 1MB ciphertext 계약으로 이전 가능한 `server_v1` 행을 최대 100개까지 `id ASC`로 읽고 서버 KEK로 복호화하되, JSON 응답은 4MB를 넘기지 않는다.

각 항목은 다음 필드만 반환한다.

```ts
type LegacyMigrationSource = {
  id: string;
  dedupKey: string;
  sessionId: string | null;
  providerKey: string;
  turnRole: "user" | "assistant";
  ts: string;
  text: string;
  sourceDigest: string;
};
```

`sourceDigest`는 `SHA-256(UTF-8 text)`의 base64url 값이며 DB에 저장하지 않는다. 응답 전체에는 `Cache-Control: no-store`를 적용한다.

### 6.3 원자적 교체

`POST /api/content/legacy-migration/commit`

요청은 최대 100개의 `{ id, sourceDigest, record }`를 받되 전체 JSON은 4MB를 넘길 수 없다. `Content-Length`를 먼저 검사하고, 길이가 없거나 거짓인 요청도 stream을 읽는 도중 4MB에서 즉시 중단한다. `record`는 기존 `E2eePromptRecordWire` 계약을 사용한다.

서버는 한 트랜잭션에서 각 행을 `FOR UPDATE`로 잠그고 다음을 검증한다.

1. 행이 현재 사용자 소유다.
2. 행이 아직 `server_v1`이다. 이미 `e2ee_v1`이면 idempotent 성공으로 센다.
3. 서버 KEK로 복호화한 원문의 digest가 `sourceDigest`와 일치한다.
4. `dedupKey`, `sessionId`, `providerKey`, `turnRole`, `ts`가 원본과 일치한다.
5. `contentOwnerId`와 `contentKeyVersion`이 현재 활성 계정과 일치한다.
6. E2EE nonce, tag, wrapped DEK와 AAD shape가 기존 계약을 통과한다.

검증된 행만 동일 행 UPDATE로 교체한다. 한 항목이 검증에 실패하면 배치 전체를 rollback해 부분 성공을 만들지 않는다.

## 7. 자동 실행기

브라우저 실행기는 다음 조건이 모두 참일 때 동작한다.

- 로그인 세션이 유효하다.
- E2EE 계정이 `active`다.
- 승인된 로컬 브라우저 device key가 있다.
- UCK가 브라우저 메모리에 풀려 있다.
- 문서가 visible이며 브라우저가 online이다.
- 동일 탭에서 다른 migration batch가 실행 중이지 않다.

실행 순서:

1. 상태 API에서 남은 건수를 읽는다.
2. 남은 건수가 0이면 완료 상태를 표시하고 종료한다.
3. 25건으로 시작해 직전 배치의 처리시간과 payload 크기에 따라 50건, 최대 100건을 조회한다.
4. 각 원문을 기존 Rust/WebCrypto golden 계약과 동일한 `e2ee_v1` 형식으로 암호화한다.
5. 즉시 로컬 복호화해 원문과 동일한지 확인한다.
6. 배치를 commit한다.
7. 300ms 미만이면서 1MB 미만이면 다음 batch를 두 배로 늘리고, 1초 초과 또는 3MB 초과면 절반으로 줄인다.
8. 50ms 양보 후 다음 배치를 처리한다.

탭이 숨겨지거나 offline이 되면 현재 네트워크 요청까지만 마치고 중단한다. 다시 visible·online 상태가 되거나 다음 접속에서 남은 `server_v1` 행부터 재개한다. 별도 cursor가 없어 오래된 cursor 복구 문제가 생기지 않는다.

다중 탭이 같은 행을 처리할 수 있지만 commit의 행 잠금과 `encryption_scheme` 재검사로 중복 갱신을 막는다.

## 8. 승인된 브라우저 자동 잠금 해제

- 페이지 진입 시 저장된 non-extractable device key와 서버 device wrapper가 있으면 사용자 동작 없이 UCK를 푼다.
- 새로고침과 브라우저 재실행은 새 승인을 요구하지 않는다.
- 15분 동안 탭이 hidden이면 메모리의 UCK와 복호화된 목록을 지운다. 탭이 다시 visible이면 저장된 device key로 자동 잠금 해제한다.
- 사용자가 `지금 잠그기`를 누른 경우에는 즉시 자동 해제하지 않는다. `이 브라우저에서 잠금 해제`를 누르면 외부 승인 없이 로컬 device key로 해제한다.
- 로그아웃은 UCK를 지우지만 승인된 device key는 유지한다. 다음 로그인 후 자동 잠금 해제한다.
- IndexedDB 삭제, 기기 폐기, wrapper 누락 때만 shim 승인 또는 Recovery Kit 경로를 표시한다.

이 정책은 반복 승인을 없애지만, 로그인된 OS 세션과 승인된 브라우저 프로필을 사용하는 사람에게 별도의 사용자 존재 확인을 요구하지 않는다. Touch ID·Windows Hello 같은 사용자 존재 확인은 후속 Passkey PRF 단계에서 제공한다.

## 9. 구형 클라이언트와 쓰기 차단

E2EE 계정이 `active`가 된 사용자가 `server_v1` payload를 보내면 `/api/v1/prompts`는 `409 E2EE_REQUIRED`를 반환한다. 그렇지 않으면 구형 shim이 레거시 레코드를 계속 추가해 전환이 끝나지 않을 수 있다.

E2EE 비활성 사용자와 전환 전 설치의 기존 `server_v1` 수집 호환은 유지한다. 새 installer는 계속 `e2ee_v1` setup 경로만 안내한다.

## 10. 오류 처리

- `LEGACY_KEK_UNAVAILABLE`: 자동 전환을 멈추고 운영자 조치 필요 상태로 표시한다.
- `CONTENT_DEVICE_UNAPPROVED`: 새 브라우저 승인 화면으로 이동한다.
- `LEGACY_SOURCE_CHANGED`: 다른 탭과 경합한 것으로 보고 상태를 다시 읽는다.
- `LEGACY_SOURCE_CORRUPT`: 해당 배치를 멈추고 레코드 식별자만 기록한다. 본문은 로그에 남기지 않는다.
- 네트워크·5xx: 1초, 2초, 4초 backoff로 세 번 재시도한 뒤 현재 접속에서는 멈춘다. 다음 접속 때 자동 재개한다.
- 개별 브라우저 암호화 round-trip 실패: commit하지 않고 UCK를 잠근다.

사용자에게는 `기존 기록 보호를 잠시 완료하지 못했습니다`와 재시도 상태만 보여준다. KEK 누락·손상처럼 사용자가 해결할 수 없는 원인은 관리자 로그와 보안 상태 화면에서 구체화한다.

## 11. UI

히스토리와 설정의 보안 패널에 다음 상태를 작게 표시한다.

- `기존 기록 보호 준비 중`
- `기존 기록 보호 중 · 120건 남음`
- `모든 기록이 E2EE로 보호됨`
- `기존 기록 보호 일시 중단 · 자동으로 다시 시도합니다`
- `관리자 확인 필요`

모달, 확인 버튼, 페이지 이탈 경고를 사용하지 않는다. 진행 중에도 이미 전환된 E2EE 기록과 아직 레거시인 기록을 기존 UI에서 구분해 조회할 수 있다.

## 12. 배포와 롤백 정책

1. 스키마와 dual-read 코드를 먼저 배포한다.
2. E2EE 활성 사용자에 대한 `server_v1` 신규 쓰기를 차단한다.
3. 자동 migration API와 브라우저 실행기를 활성화한다.
4. 사용자별 및 전체 `server_v1` 잔여 건수를 관찰한다.
5. 잔여 건수가 0이 된 뒤에도 백업 보존 기간 동안 legacy KEK를 보관한다.
6. 백업 보존 기간이 끝나면 `TOARD_CONTENT_KEK_B64`와 legacy decrypt 경로를 별도 릴리스로 제거한다.

첫 `e2ee_v1` 행이 생긴 뒤 migration 28 Down은 E2EE DEK wrapper 메타데이터를 잃게 하므로 허용하지 않는다. Down migration은 E2EE 행이 존재하면 실패하도록 guard하고, 이후 장애는 forward-fix로 복구한다.

## 13. 테스트 기준

- migration 28 이전에 넣은 `server_v1` 행이 적용 후 그대로 유지된다.
- 승인된 브라우저만 legacy page API를 호출할 수 있다.
- legacy page와 오류 로그에 캐시 가능한 평문이나 평문 로그가 남지 않는다.
- 브라우저가 각 원문을 암호화한 뒤 로컬 round-trip 검증한다.
- commit 후 동일 PK와 메타데이터를 유지하면서 `e2ee_v1`으로 바뀐다.
- digest·소유자·키 버전·메타데이터 불일치 배치는 전부 rollback된다.
- 중간에 브라우저를 닫아도 다음 실행에서 남은 행만 처리한다.
- 두 탭이 같은 배치를 처리해도 데이터 손상이나 중복 행이 없다.
- E2EE 활성 사용자의 `server_v1` 신규 수집은 409로 차단된다.
- 새로고침·브라우저 재실행·hidden 복귀는 승인 요청 없이 자동 해제된다.
- IndexedDB 삭제와 폐기된 기기는 자동 해제되지 않는다.
- 실제 PostgreSQL 통합 테스트에서 전환 후 legacy canary 평문과 `server_v1` 행이 모두 0건이다.
- migration 28 Down은 E2EE 행이 있으면 실패한다.

## 14. 이번 범위에서 제외

- Passkey PRF, Touch ID, Windows Hello 사용자 존재 확인
- UCK 회전과 Recovery Kit 재발급
- 사용자 선택형 보존 기간과 계정 탈퇴 데이터 삭제
- 백업 시스템 자체의 삭제 자동화
- 전체 설치에서 legacy KEK를 제거하는 최종 릴리스
