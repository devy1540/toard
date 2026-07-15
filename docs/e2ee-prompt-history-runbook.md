# E2EE 프롬프트 히스토리 운영 런북

## 보호 범위

`e2ee_v1`은 shim에서 프롬프트·응답을 암호화한 뒤 서버로 보낸다. 서버 DB에는 콘텐츠 암호문, 암호화된 DEK, 무결성 검증용 메타데이터만 저장된다. UCK(User Content Key)는 연결된 기기의 OS 보안 저장소와 잠금 해제된 브라우저 메모리에만 존재한다.

- 서버 운영자·DB 백업·일반 관리자 UI: 본문 복호화 불가
- 다른 사용자: RLS와 사용자 소유권 검사로 암호문도 조회 불가
- 승인된 브라우저: UCK를 메모리에 푼 동안만 본문 복호화
- 서버가 제공하는 웹 코드 자체가 침해된 경우: 잠금 해제 뒤 평문 탈취 가능. E2EE가 악성 서버 코드까지 막지는 않는다.
- 사용자의 로컬 기기·OS 계정이 침해된 경우: keyring 또는 화면의 평문이 노출될 수 있다.

`TOARD_CONTENT_KEK_B64`는 기존 `server_v1` 본문에만 적용된다. 이 값을 가진 운영자도 `e2ee_v1` 본문은 복호화할 수 없다.

## 최초 활성화

1. 로그인 후 **설정 → 컴퓨터 연결**에서 `프롬프트와 응답도 기록`을 선택해 설치한다.
2. 설치 직후 `collect_content=off`, `e2ee_setup_requested=true`이므로 아직 본문을 보내지 않는다.
3. 연결된 컴퓨터에서 실행한다.

```bash
toard-shim e2ee setup
```

4. localhost로 열린 화면에서 24단어 Recovery Kit를 저장하고 요청된 세 단어를 확인한다.
5. 성공 후 아래 명령이 `E2EE 활성`, 키 버전, 기기 ID를 출력하면 완료다.

```bash
toard-shim e2ee status
```

setup 성공 시에만 UCK와 기기 private key가 OS 보안 저장소에 기록되고 credentials가 `collect_content=e2ee_v1`로 원자 교체된다. 원격 활성화 실패 시 로컬 키·활성 플래그를 남기지 않는다.

## 새 브라우저 승인

1. `/history`에서 **연결된 컴퓨터로 승인**을 선택한다.
2. 브라우저에 6자리 코드와 5분 제한 시간이 표시된다.
3. UCK를 가진 연결 컴퓨터에서 실행한다.

```bash
toard-shim e2ee approve
```

요청이 여러 개면 브라우저의 요청 ID를 사용한다.

```bash
toard-shim e2ee approve --request <request-uuid>
```

코드는 명령 인자로 받지 않고 로컬 입력으로만 받는다. 서버에는 `sha256(request_id + ':' + code)`만 저장된다. 승인 envelope는 한 번만 소비할 수 있다.

## Recovery Kit 복구

연결된 기기를 모두 잃었을 때만 `/history`의 **Recovery Kit 사용**을 선택한다. 24단어는 브라우저 메모리에서 BIP39 checksum 확인, HKDF-SHA-256, AES-256-GCM 복호화에만 사용되며 HTTP 요청·서버 로그·DB에 포함되지 않는다.

Recovery Kit까지 잃으면 운영자도 본문을 복구할 수 없다. 계정 로그인 복구와 E2EE 본문 복구는 별개다. 현재 슬라이스에는 안전한 키 회전·Recovery Kit 재발급이 없으므로 관련 버튼을 제공하지 않는다.

## 기존 기록 자동 전환

승인된 브라우저가 잠금 해제되고 visible·online 상태가 되면 기존 `server_v1` 기록을 자동으로 `e2ee_v1`으로 교체한다. 배치는 25건으로 시작하고 처리시간과 commit payload 크기에 따라 50건, 최대 100건까지 자동 조절한다. 페이지 응답과 commit 요청은 각각 4MB 이하로 제한하며, 배치 사이에는 50ms 동안 UI에 실행권을 양보한다. 사용자가 시작 버튼을 누를 필요는 없고, 브라우저를 닫으면 남은 `server_v1` 행부터 다음 접속 때 재개한다.

새 `server_v1` 기록도 E2EE ciphertext와 동일하게 본문 한 건당 UTF-8 1MB 이하만 받는다. 이 제한이 적용되기 전에 저장된 1MB 초과 기록은 정상 크기 기록의 이전을 막지 않도록 자동 이전 대상에서 격리하고 상태를 `blocked`로 표시한다. 해당 행은 삭제하거나 평문으로 노출하지 않고 `server_v1`으로 보존하므로, 별도 chunked migration을 제공하기 전까지 `TOARD_CONTENT_KEK_B64`를 유지해야 한다.

E2EE 계정이 활성화된 뒤 구형 shim의 `server_v1` 수집은 `409 E2EE_REQUIRED`로 차단된다. shim을 현재 버전으로 갱신하고 `toard-shim e2ee status`를 확인한다.

운영자는 본문이나 ciphertext를 출력하지 않고 잔여 건수만 확인한다.

```sql
SELECT encryption_scheme, COUNT(*)
FROM prompt_records
GROUP BY encryption_scheme;
```

전체 `server_v1`이 0건이 되더라도 DB 백업 보존 기간이 끝나기 전에는 `TOARD_CONTENT_KEK_B64`를 제거하지 않는다. E2EE 행이 한 건이라도 생성된 뒤 migration 30 Down은 복호화 메타데이터 손실을 막기 위해 실패한다. 이 시점 이후 장애는 Down이 아니라 forward-fix로 복구한다.

## 서버 KEK 안전 폐기

1. 실제 PostgreSQL 자동 백업 보존기간과 같은 값으로 `TOARD_LEGACY_BACKUP_RETENTION_DAYS`를 설정하고 앱을 재시작한다. 백업을 생성하지 않는 설치에서만 `0`을 사용한다.
2. **관리 → 시스템 → 레거시 본문 키 폐기**에서 전체 `server_v1`이 0건인지 확인한다.
3. 표시된 가장 이른 키 폐기 시각까지 기다린다.
4. 자동 백업, WAL 보관본, 복제본, 수동 스냅샷에 복구 가능한 `server_v1` 데이터가 남지 않았는지 운영 인프라에서 확인한다.
5. 관리자 화면의 **백업 폐기 확인 기록**을 누른다. 이 동작은 백업을 삭제하지 않고 확인자·시각·당시 잔여 건수만 기록한다.
6. 상태가 **서버 키 폐기 가능**이면 외부 Secret Store에서 `TOARD_CONTENT_KEK_B64`를 제거하고 앱을 재시작한다.
7. 관리자 화면이 **Legacy 키 폐기 완료**이고 `/api/ready`가 200인지 확인한다.

`TOARD_CONTENT_KEK_B64`가 없는데 `server_v1`이 한 건이라도 남아 있으면 `/api/ready`는 503을 반환한다. 이 경우 새 키를 만들지 말고 기존 KEK를 Secret Store에서 복구해야 한다. 새 키는 기존 `server_v1` DEK를 복호화할 수 없다.

## 상태 점검

```bash
curl -fsS http://localhost:3000/api/health
curl -fsS http://localhost:3000/api/ready
toard-shim e2ee status
```

성공 기준:

- `/api/health`: HTTP 200
- `/api/ready`: HTTP 200
- shim status: `E2EE 활성`, 양의 키 버전, 기기 ID 출력
- 설정의 **히스토리 보안**: 활성, 같은 키 버전, Recovery 확인 시각, 승인 기기 표시
- `/history`: 잠금 해제 전 평문 미표시, 승인 후 `E2EE · 이 브라우저에서 잠금 해제됨` 표시

## 비활성·장애 진단

- `AUTH_MODE=open`: 사용자별 암호화 경계를 만들 수 없어 `/api/content/*`는 `403 E2EE_AUTH_REQUIRED`이다. 사용량 대시보드는 기존 open-mode 정책대로 동작한다.
- Linux keyring 없음/잠김: setup과 수집은 fail-closed로 종료하며 credentials를 E2EE 활성로 바꾸지 않는다. Secret Service 호환 keyring을 구성한 뒤 다시 setup한다.
- `CONTENT_UNAVAILABLE`: 레코드 메타데이터나 인증 태그가 맞지 않는 상태다. 해당 레코드만 격리하며 다른 턴은 계속 표시한다.
- 승인 만료: 새 요청을 만든다. 만료·잘못된 코드·다른 사용자·재사용은 모두 거부된다.
- 브라우저 IndexedDB 삭제: 기기 private key가 사라지므로 연결 기기 승인 또는 Recovery Kit가 다시 필요하다.

## 검증

```bash
node --import tsx --test scripts/e2ee-ciphertext-only.integration.test.ts
cargo test --manifest-path shim/rust/Cargo.toml
pnpm --filter @toard/web test
pnpm --filter @toard/web typecheck
pnpm --filter @toard/web build
pnpm test:migrations
```

canary 통합 테스트는 DB와 서버 방향 payload에 평문이 없고, 승인된 브라우저 복호화 결과에만 평문이 나타나는지 확인한다. Docker 테스트는 `finally`에서 컨테이너를 제거한다.
