# toard 프롬프트 히스토리 E2EE 설계

- 상태: 사용자 방향 승인, 구현 전 문서 검토 단계
- 작성일: 2026-07-14
- 대상: shim 본문 수집, `/history`, 컴퓨터 연결, 로그인 및 보안, 관리자 보안 상태
- 기준: 연결된 컴퓨터가 기본 열쇠, 패스키는 선택적 편의 수단, 복구키는 최후의 수단

## 1. 결정 요약

toard의 프롬프트·응답 본문은 shim에서 암호화한 뒤 서버로 전송한다. 서버는 본문 복호화에 필요한 사용자 콘텐츠 키의 평문을 보유하지 않는다. PostgreSQL, 백업, 서버 환경변수 또는 관리자 권한만으로는 저장된 본문을 복호화할 수 없어야 한다.

사용자는 패스키가 없어도 E2EE 히스토리를 사용할 수 있다. 최초 연결된 컴퓨터의 shim이 기본 키 보관자이자 새 기기 승인자다. 패스키는 지원되는 환경에서 로그인과 잠금 해제를 간소화하는 선택 기능이다. 복구키는 승인된 컴퓨터와 패스키를 모두 잃었을 때만 사용한다.

계정 인증과 본문 암호화는 별도 경계로 유지한다. OAuth, 비밀번호 또는 패스키 로그인이 성공해도, 현재 브라우저가 콘텐츠 키를 보유하지 않으면 히스토리는 잠긴 상태다.

## 2. 배경과 현재 상태

현재 본문 수집 경로는 다음과 같다.

1. shim이 로컬 Claude/Codex 로그에서 `user`·`assistant` 턴을 추출한다.
2. 평문 본문을 `POST /api/v1/prompts`로 전송한다.
3. 서버가 `TOARD_CONTENT_KEK_B64`를 사용해 레코드별 DEK를 감싼다.
4. `prompt_records`에 암호문을 저장한다.
5. `/history` 서버 코드가 KEK로 본문을 복호화해 목록 미리보기와 상세 턴을 만든다.

현재 방식은 DB 덤프 단독 유출에는 강하지만, 서버 KEK를 가진 운영자와 실행 중인 서버는 본문을 복호화할 수 있다. E2EE 전환은 암호화 시점을 서버에서 shim으로 옮기고, 복호화를 승인된 사용자 클라이언트로 제한한다.

관련 현재 코드:

- `shim/rust/src/collect/mod.rs`: 본문 수집 opt-in과 별도 수집 루프
- `apps/web/app/api/v1/prompts/route.ts`: 본문 수신과 서버 암호화 진입점
- `apps/web/lib/content-crypto.ts`: 서버 KEK 기반 봉투 암호화
- `apps/web/lib/prompt-history.ts`: 서버 복호화와 미리보기 생성
- `apps/web/app/(dashboard)/settings/onboarding-wizard.tsx`: 컴퓨터 연결과 본문 수집 선택
- `apps/web/auth.ts`: Credentials·Google·GitHub 로그인 구성

## 3. 목표

### 3.1 보안 목표

- DB 덤프, 백업, DBA 조회만으로 저장된 프롬프트 본문을 복호화할 수 없다.
- 서버의 콘텐츠 암호화 환경변수가 유출되어도 E2EE 본문은 복호화되지 않는다.
- 서버는 사용자 콘텐츠 키의 평문과 WebAuthn PRF 출력을 수신하지 않는다.
- 다른 사용자의 암호문이 API/RLS 오류로 노출되더라도 본문 기밀성은 유지된다.
- 기기·패스키·복구키의 추가, 폐기, 회전 상태가 사용자에게 명확히 보인다.
- 키가 없는 관리자에게 사용자 본문 조회나 복구 기능을 제공하지 않는다.

### 3.2 제품 목표

- 패스키가 없는 사용자도 E2EE 히스토리를 사용할 수 있다.
- 같은 승인 브라우저에서는 반복적인 복구키 입력 없이 히스토리를 사용할 수 있다.
- 새 브라우저는 연결된 컴퓨터 승인으로 복구키 없이 등록할 수 있다.
- 패스키 PRF를 지원하는 환경에서는 로그인과 히스토리 잠금 해제를 한 번에 수행한다.
- PRF 미지원 환경은 로그인 성공 후 기기 승인 경로로 자연스럽게 전환한다.
- 토큰·비용·provider·시간 기반 대시보드는 기존 서버 집계를 유지한다.

## 4. 비목표와 보호 경계

이번 설계는 다음 상황까지 보호한다고 약속하지 않는다.

- 잠금 해제된 사용자 기기의 악성코드, 화면 캡처, 클립보드 탈취
- 사용자 브라우저에 실행 중인 악성 확장 프로그램
- 변조된 shim 바이너리 또는 신뢰가 깨진 배포·업데이트 공급망
- 사용자가 직접 외부 LLM이나 다른 서비스에 전송한 평문
- 사용 시각, provider, 토큰, 비용, 레코드 수 같은 최소 메타데이터

웹 서버가 제공한 JavaScript가 브라우저에서 복호화를 수행하므로, 서버가 활성 침해되어 악성 프런트엔드를 내려주는 동안 잠금 해제한 본문은 탈취될 수 있다. 따라서 제품 문구는 `서버에 저장된 본문은 서버 키로 복호화할 수 없습니다`처럼 저장 데이터에 대한 zero-access 보장을 사용한다. `어떤 상황에서도 서버가 볼 수 없습니다`와 같은 절대 표현은 사용하지 않는다.

활성 서버 침해까지 방어해야 하는 고보증 모드는 서명된 브라우저 확장 또는 데스크톱 로컬 뷰어가 복호화를 담당하는 별도 후속 범위로 둔다.

## 5. 검토한 접근법

### 5.1 현재 서버 KEK 유지

- 장점: 기존 서버 렌더링, 검색, 미리보기, 운영 복구를 그대로 유지한다.
- 단점: 서버·운영자가 복호화할 수 있어 zero-access가 아니다.
- 결정: 채택하지 않는다. 기존 데이터 전환 기간에만 레거시 방식으로 유지한다.

### 5.2 브라우저 비밀번호만으로 콘텐츠 키 파생

- 장점: 구현 개념이 단순하고 별도 기기 승인 없이 동작한다.
- 단점: 비밀번호 변경·분실·OAuth 로그인과 충돌하며, 낮은 엔트로피 비밀번호에 콘텐츠 보안이 종속된다.
- 결정: 채택하지 않는다.

### 5.3 사용자 콘텐츠 키 + 기기 승인 + 선택적 패스키 + 복구키

- 장점: 패스키가 없어도 사용할 수 있고, 서버는 키를 모른다. 기기별 폐기와 복구키를 함께 제공할 수 있다.
- 단점: 키 래핑, 승인 기기 관리, 브라우저 복호화, 레거시 전환이 필요하다.
- 결정: 채택한다.

## 6. 키 계층

### 6.1 사용자 콘텐츠 키

`User Content Key(UCK)`는 사용자마다 생성하는 256비트 무작위 키다.

- 최초 E2EE 활성화 시 shim이 CSPRNG로 생성한다.
- 서버에 평문으로 전송하지 않는다.
- 최초 shim에서는 OS 보안 저장소에 보관한다.
- 승인된 각 클라이언트에는 해당 클라이언트만 풀 수 있는 래퍼 형태로 전달한다.
- 키 버전을 저장해 회전과 레거시 읽기를 지원한다.

### 6.2 레코드 키

각 프롬프트·응답 레코드는 별도의 256비트 `Data Encryption Key(DEK)`로 AES-256-GCM 암호화한다.

- shim이 레코드마다 새 DEK와 nonce를 생성한다.
- DEK는 현재 UCK로 AES-256-GCM 래핑한다.
- 본문 ciphertext, content auth tag·nonce, wrapped DEK, DEK wrap auth tag·nonce, 키 버전만 서버로 보낸다.
- AAD에는 스키마 버전, 등록 시 서버가 발급한 불변 `content_owner_id`, dedup key, provider, role, timestamp를 정규화해 포함한다.
- nonce 재사용을 허용하지 않는다.

`content_owner_id`는 로그인 사용자 id에 서버에서 귀속되는 불투명 식별자다. 최초 E2EE 등록 응답으로 shim에 전달하며, 이후 ingest 요청에서 서버가 토큰 소유자와 일치하는지 검증한다.

### 6.3 기기 키

승인된 shim과 브라우저는 기기별 비대칭 키 쌍을 가진다.

- shim 개인키는 macOS Keychain, Windows Credential/DPAPI 계층, Linux Secret Service를 우선 사용한다.
- 브라우저 개인키는 Web Crypto의 non-extractable key로 만들고 IndexedDB에 보관한다.
- 서버에는 기기 공개키, 라벨, 종류, 생성·최근 사용·폐기 시각만 저장한다.
- 새 기기 승인은 감사된 HPKE(RFC 9180) 구현을 사용해 UCK를 새 기기 공개키에 암호화한다.
- 서버는 승인 요청과 암호화된 UCK envelope만 중계한다.

브라우저 저장소는 OS 보안 저장소와 동일한 보증을 제공하지 않는다. 브라우저 프로필을 읽을 수 있는 악성코드와 XSS 위험은 보호 경계 밖이며, CSP·Trusted Types·서드파티 스크립트 금지로 위험을 낮춘다.

### 6.4 패스키 래퍼

패스키는 인증 자격증명이며 콘텐츠 키 자체가 아니다. WebAuthn `prf` 확장을 지원하는 자격증명만 UCK 잠금 해제 수단으로 사용한다.

1. 등록 시 클라이언트가 자격증명별 무작위 PRF input을 만든다.
2. PRF 결과를 HKDF-SHA-256으로 확장해 `Passkey KEK`를 만든다.
3. Passkey KEK로 UCK를 AES-256-GCM 래핑한다.
4. 서버에는 credential id, PRF input, 암호화된 UCK wrapper, nonce, 키 버전만 저장한다.
5. PRF 결과와 Passkey KEK는 서버로 전송하지 않는다.

PRF 결과가 포함된 WebAuthn 응답 객체를 서버 인증 검증 payload로 직렬화하지 않는다. 인증 서명 검증에 필요한 필드와 클라이언트 로컬 PRF 결과를 분리한다.

PRF 지원 여부는 등록 시 실제 결과로 판단한다.

- 지원: `로그인 + 히스토리 잠금 해제 가능`
- 미지원: `로그인 가능 · 히스토리 잠금 해제 미지원`

PRF 미지원은 오류가 아니다. 연결된 컴퓨터 승인 또는 이미 승인된 브라우저 키를 사용한다.

### 6.5 복구키 래퍼

복구키는 256비트 무작위 recovery secret을 사람이 보관 가능한 24단어+checksum과 Recovery Kit 파일로 표현한다.

- recovery secret은 클라이언트에서 생성한다.
- 계정별 공개 salt와 HKDF-SHA-256으로 `Recovery KEK`를 만든다.
- Recovery KEK로 UCK를 AES-256-GCM 래핑한다.
- 서버는 복구키 원문이나 Recovery KEK를 저장하지 않는다.
- 사용자는 최초 활성화 완료 전에 Recovery Kit 저장과 단어 확인 절차를 통과한다.
- 복구키는 계정 로그인 수단이 아니라 E2EE 콘텐츠 키 복구 수단이다.

승인된 기기, PRF 패스키, 복구키를 모두 잃으면 본문은 복구할 수 없다.

## 7. 데이터 흐름

### 7.1 최초 활성화

1. 사용자가 컴퓨터 연결 화면에서 `프롬프트와 응답도 안전하게 기록`을 선택한다.
2. shim 설치와 ingest 토큰 연결을 완료한다.
3. shim이 UCK와 shim 기기 키 쌍을 생성한다.
4. shim이 Recovery Kit을 로컬 전용 화면에서 표시한다.
5. 사용자가 Recovery Kit을 저장하고 단어 확인을 완료한다.
6. shim이 recovery-wrapped UCK와 shim public key를 서버에 등록한다.
7. 선택적으로 패스키를 등록한다.
8. 모든 필수 단계가 성공한 뒤에만 `collect_content=e2ee_v1`을 활성화한다.

복구키는 터미널 인자, 설치 명령, 셸 히스토리, 서버 로그에 넣지 않는다.

### 7.2 본문 수집

1. shim이 로컬 로그에서 턴을 추출한다.
2. shim이 레코드 DEK를 생성하고 본문을 로컬에서 암호화한다.
3. shim이 DEK를 UCK로 래핑한다.
4. shim이 암호문과 최소 메타데이터를 `/api/v1/prompts`로 전송한다.
5. 서버는 인증, provider, role, timestamp, payload size와 암호화 스키마를 검증한다.
6. 서버는 평문 처리 없이 `prompt_records`에 저장한다.

### 7.3 승인된 브라우저 조회

1. 계정 인증을 완료한다.
2. 브라우저가 로컬 기기 키 존재 여부를 확인한다.
3. 기기 키로 UCK wrapper를 해제한다.
4. 서버에서 메타데이터와 암호문 페이지를 가져온다.
5. 브라우저가 노출되는 레코드만 복호화한다.
6. 세션 제목, 미리보기, 상세 턴은 브라우저에서 만든다.
7. 잠금 또는 로그아웃 시 메모리의 평문과 UCK 참조를 폐기한다.

### 7.4 새 브라우저 승인

1. 새 브라우저가 기기 키 쌍을 생성하고 승인 요청을 만든다.
2. 서버는 짧은 만료 시간을 가진 요청 id와 확인 코드를 발급한다.
3. 기존 shim은 요청 기기·브라우저·대략적 위치·확인 코드를 표시한다.
4. 사용자가 승인하면 shim이 새 공개키에 UCK를 암호화한다.
5. 서버는 암호화된 wrapper를 새 브라우저에 중계한다.
6. 새 브라우저가 UCK를 해제하고 승인 완료를 서버에 기록한다.

승인 요청은 일회용이며 5분 후 만료한다. 승인자와 요청자의 확인 코드가 일치하지 않으면 중단한다.

### 7.5 패스키 잠금 해제

1. 패스키로 계정 인증을 수행한다.
2. 같은 사용자 검증 동작에서 PRF 출력을 로컬로 받는다.
3. 브라우저가 Passkey KEK를 파생한다.
4. passkey-wrapped UCK를 해제한다.
5. PRF를 지원하지 않으면 로그인만 완료하고 기기 승인 화면을 표시한다.

### 7.6 복구키 사용

1. 사용자가 정상 계정 인증을 완료한다.
2. `모든 기기에 접근할 수 없음` 경로에서 복구키 사용을 선택한다.
3. 브라우저가 입력된 단어로 Recovery KEK를 파생한다.
4. recovery-wrapped UCK를 해제한다.
5. 현재 브라우저를 새 승인 기기로 등록한다.
6. 새 복구키 발급과 기존 복구 wrapper 폐기를 권장한다.

복구키 원문과 파생키는 서버로 보내지 않으므로 서버는 실제 단어 실패 여부를 알 수 없다. 서버는 인증된 recovery wrapper 다운로드 빈도만 제한하고, 클라이언트는 반복 입력에 UI 지연을 적용한다. 256비트 무작위 recovery secret은 암호문을 가진 공격자의 오프라인 추측을 현실적으로 불가능하게 하는 엔트로피를 전제로 한다.

## 8. 서버 데이터 모델

### 8.1 `prompt_records` 변경

기존 컬럼을 유지하면서 다음 의미를 명시한다.

- `encryption_scheme`: `server_v1` 또는 `e2ee_v1`
- `content_owner_id`: E2EE 등록 시 발급한 불변 소유자 식별자
- `content_key_version`: UCK 버전
- `wrapped_dek`: E2EE에서는 UCK로 감싼 레코드 DEK
- `dek_wrap_iv`, `dek_wrap_auth_tag`: DEK 래핑 AES-GCM 산출물
- `iv`, `ciphertext`, `auth_tag`: 본문 AES-GCM 산출물
- `aad_version`: AAD 정규화 버전

`e2ee_v1` 레코드에는 서버 복호화 경로를 제공하지 않는다.

### 8.2 `content_key_wrappers`

- `id`
- `user_id`
- `content_key_version`
- `wrapper_type`: `device`, `passkey_prf`, `recovery`
- `wrapper_ref`: device id 또는 credential id, recovery는 계정당 활성 1개
- `kdf_version`
- `public_salt_or_input`
- `nonce`
- `auth_tag`
- `wrapped_content_key`
- `created_at`, `last_used_at`, `revoked_at`

평문 UCK, PRF 결과, recovery secret은 저장하지 않는다.

### 8.3 `content_devices`

- `id`, `user_id`
- `kind`: `shim`, `browser`
- `label`, `platform`
- `public_key`, `algorithm_version`
- `created_at`, `last_used_at`, `revoked_at`

### 8.4 `webauthn_credentials`

로그인 인증 자격증명과 콘텐츠 키 wrapper를 분리한다.

- credential id, public key, counter, transports, backup eligibility/state
- 사용자 지정 라벨과 마지막 사용 시각
- PRF 지원 여부
- UCK wrapper는 `content_key_wrappers`에서 별도 관리

### 8.5 `content_device_approval_requests`

- 요청자 user/device id와 새 기기 공개키
- 확인 코드 해시
- 생성·만료·승인·사용 시각
- 승인 후 즉시 소비되는 encrypted envelope

만료된 요청은 주기적으로 삭제한다.

## 9. UI/UX 설계

### 9.1 컴퓨터 연결

기존 `프롬프트와 응답도 기록` 스위치를 다음 의미로 바꾼다.

> 프롬프트와 응답도 안전하게 기록
>
> 이 컴퓨터에서 암호화한 뒤 전송합니다. 서버에 저장된 본문은 서버 키로 복호화할 수 없습니다.

선택지는 유지한다.

- 사용량만 기록
- 사용량과 E2EE 히스토리 기록

### 9.2 최초 Recovery Kit

연결 완료 전 필수 단계다.

- `마지막 복구 수단을 보관하세요`
- 24단어 복구키
- `Recovery Kit 저장`
- 임의 단어 위치 확인
- `toard는 이 복구키를 보관하거나 다시 발급할 수 없습니다`

로컬 shim 화면이 키를 표시하며 서버 웹 화면은 완료 상태만 받는다.

### 9.3 선택적 패스키 등록

Recovery Kit 확인 뒤 다음 화면을 제공한다.

> 패스키를 등록하면 Face ID, Touch ID, Windows Hello, 기기 PIN 또는 보안 키로 더 빠르게 잠금 해제할 수 있습니다.

- `패스키 추가 — 권장`
- `나중에 하기`

등록 결과에 따라 상태를 구분한다.

- `로그인 및 히스토리 잠금 해제 가능`
- `로그인 가능 · 히스토리 잠금 해제 미지원`

### 9.4 잠긴 히스토리

새 브라우저에서는 로그인 성공 후 다음 순서로 표시한다.

1. `연결된 컴퓨터로 승인` — 기본 강조
2. `패스키로 잠금 해제` — 사용 가능한 wrapper가 있을 때만
3. `복구키 사용` — 덜 강조된 비상 경로

복구키를 첫 번째 선택지로 노출하지 않는다.

### 9.5 잠금 해제된 히스토리

상단 상태:

- `E2EE · 이 브라우저에서 잠금 해제됨`
- `본문은 이 브라우저에서 복호화됩니다`

서버에서 가능한 필터:

- 기간, provider, role, 세션, 토큰·비용 메타데이터

브라우저에서 수행할 기능:

- 첫 프롬프트 미리보기
- 상세 턴 렌더링
- 본문 검색 인덱스
- 선택 대화 내 검색

본문 검색 인덱스는 브라우저 로컬에만 저장하고 로그아웃·기기 폐기 시 삭제한다.

### 9.6 로그인 및 보안

패스키 목록에 다음을 표시한다.

- 사용자 라벨
- 동기화형 또는 기기 귀속형
- 로그인 가능 여부
- 히스토리 잠금 해제 가능 여부
- 마지막 사용 시각

삭제 전 다음 안전 조건을 검사한다.

- 다른 승인 기기, 다른 PRF 패스키 또는 복구키 wrapper가 하나 이상 존재
- 현재 UCK 버전을 풀 수 있는 다른 수단 존재

조건을 만족하지 않으면 삭제를 막고 대체 수단 등록을 안내한다.

### 9.7 히스토리 보안

설정에 별도 영역을 추가한다.

- E2EE 상태와 키 버전
- 승인된 shim·브라우저
- 복구키 확인일
- 패스키 상태
- 기기 폐기
- 콘텐츠 키 회전
- Recovery Kit 재발급
- 암호화된 히스토리 전체 삭제

Recovery Kit 재발급은 기존 recovery wrapper를 폐기하고 새 wrapper를 만든다. 본문 전체 재암호화는 하지 않는다.

### 9.8 관리자 화면

관리자는 집계 상태만 확인한다.

- E2EE 사용 사용자 수
- Recovery Kit 확인 완료 사용자 수
- 암호화 스키마와 키 버전 분포
- 레거시 `server_v1` 잔여 레코드 수
- 마이그레이션 실패 수

관리자 화면에는 사용자별 본문, 키, wrapper 다운로드, 강제 복구 기능을 제공하지 않는다.

### 9.9 `AUTH_MODE=open`

E2EE 히스토리는 정상 사용자 인증을 요구한다. `AUTH_MODE=open`에서는 사용량 대시보드를 유지할 수 있지만 `/history`의 본문 잠금 해제와 새 기기 승인을 제공하지 않는다.

## 10. 기존 데이터 전환

기존 `server_v1` 레코드는 서버 KEK로 복호화할 수 있었으므로 과거 시점까지 소급해 zero-access였다고 표시하지 않는다.

전환 정책:

1. 신규 수집은 사용자 활성화 시점부터 `e2ee_v1`로 저장한다.
2. 기존 기록은 UI에서 `기존 서버 암호화`로 구분한다.
3. 사용자가 `기존 기록 보호 전환`을 시작하면 인증된 클라이언트가 페이지 단위로 기존 본문을 받아 로컬에서 `e2ee_v1`로 재암호화한다.
4. 서버는 새 암호문 저장, 소유자·개수·해시 검증 후 기존 암호문을 삭제한다.
5. 중단해도 완료된 페이지와 미완료 페이지를 구분해 재개한다.
6. 전환 완료 후 서버는 해당 사용자의 레거시 복호화 경로를 비활성화한다.
7. 전체 설치의 레거시 레코드가 0건이 된 뒤 서버 KEK 경로 제거를 별도 릴리스로 진행한다.

전환 중 서버가 기존 본문을 복호화할 수 있다는 사실을 UI에 명시한다. 기존 로컬 로그에서 다시 수집할 수 있는 경우에는 서버 복호화 전환 대신 shim 재수집을 우선 제안한다.

## 11. 키 회전과 폐기

### 11.1 기기 폐기

- 해당 기기의 UCK wrapper와 기기 레코드를 폐기한다.
- 이후 서버는 그 기기에 새 암호문을 제공하지 않는다.
- 이미 기기에 복호화된 평문이나 UCK를 원격 회수할 수 없다는 점을 표시한다.

### 11.2 UCK 회전

기기 분실 또는 키 노출 의심 시 새 UCK 버전을 만든다.

1. 승인된 클라이언트가 새 UCK를 생성한다.
2. 모든 유지할 기기·패스키·복구키 wrapper를 새 버전으로 생성한다.
3. 신규 레코드는 새 UCK로 DEK를 래핑한다.
4. 기존 레코드의 DEK wrapper를 점진적으로 재래핑한다.
5. 완료 후 이전 UCK wrapper를 폐기한다.

본문 ciphertext 전체를 다시 암호화하지 않고 DEK wrapper만 재래핑한다.

### 11.3 패스키 삭제

- WebAuthn credential과 passkey UCK wrapper를 함께 폐기한다.
- 다른 복호화 수단이 없으면 삭제를 거부한다.
- 동기화형 패스키가 외부 패스키 제공자에서 먼저 삭제된 경우 사용자가 남은 수단으로 로그인한 뒤 toard의 고아 credential을 정리할 수 있다.

## 12. 오류 처리

- `E2EE_SETUP_INCOMPLETE`: Recovery Kit 확인 전 수집을 시작하지 않는다.
- `CONTENT_DEVICE_UNAPPROVED`: 로그인은 성공했지만 브라우저가 UCK를 풀 수 없다.
- `PASSKEY_PRF_UNSUPPORTED`: 로그인은 유지하고 기기 승인 경로를 표시한다.
- `CONTENT_KEY_UNWRAP_FAILED`: wrapper 손상·잘못된 수단을 구분하지 않는 일반 오류를 표시한다.
- `CONTENT_KEY_VERSION_MISSING`: 해당 버전을 가진 승인 기기 또는 복구키를 안내한다.
- `DEVICE_APPROVAL_EXPIRED`: 새 5분 승인 요청을 만든다.
- `LEGACY_MIGRATION_PARTIAL`: 완료 위치에서 재개한다.
- `CONTENT_UNAVAILABLE`: 개별 레코드 인증 태그 실패 시 전체 페이지를 중단하지 않고 해당 턴만 격리한다.

오류 응답과 로그에는 키, 복구 단어, PRF 출력, 평문, ciphertext 전체를 기록하지 않는다.

## 13. 보안 요구사항

- WebAuthn과 브라우저 키 기능은 유효한 HTTPS secure context에서만 활성화한다.
- 패스키 등록·삭제, 기기 승인, 복구키 재발급, UCK 회전은 최근 재인증을 요구한다.
- PRF 결과는 인증 검증 payload와 분리하고 서버로 직렬화하지 않는다.
- 서드파티 분석·광고 스크립트를 히스토리 화면에 로드하지 않는다.
- 엄격한 CSP, Trusted Types, 출력 인코딩으로 XSS 표면을 줄인다.
- 암호화 구현은 표준 라이브러리와 감사된 HPKE 구현만 사용하며 자체 암호 알고리즘을 만들지 않는다.
- 모든 암호문은 스키마·알고리즘·KDF·키 버전을 포함한다.
- 사용자별·레코드별 AAD 정규화 규칙을 버전 관리한다.
- 복구키와 UCK는 telemetry, crash report, 로그, clipboard history에 남지 않게 한다.
- Recovery Kit 로컬 화면은 loopback에만 바인딩하고 짧게 만료되는 일회용 capability로 접근을 제한한다.
- 위험 작업은 감사 이벤트에 사용자·기기·시각·결과만 기록하고 키 내용은 기록하지 않는다.

## 14. 테스트 전략

### 14.1 단위 테스트

- 레코드 암호화·복호화 golden vector
- 잘못된 AAD·nonce·auth tag·UCK에 대한 실패
- UCK wrapper 종류별 정상·오류·폐기 동작
- 키 버전 회전과 DEK 재래핑
- 복구 단어 checksum과 잘못된 단어 처리
- WebAuthn 응답에서 PRF 결과가 서버 payload에 포함되지 않음

### 14.2 통합 테스트

- shim 암호화 payload를 서버가 평문 처리 없이 저장
- 사용자 A의 wrapper로 사용자 B의 레코드를 복호화할 수 없음
- 새 브라우저 승인, 만료, 거부, 재시도
- PRF 지원·미지원 패스키 경로
- 기기·패스키 폐기 후 접근 차단
- 복구키로 새 기기 등록 후 복구키 회전
- `AUTH_MODE=open`에서 E2EE 본문 접근 차단
- 레거시 전환 중단·재개·검증·삭제

### 14.3 E2E 테스트

- macOS, Windows, Linux 최초 설정
- Chrome, Safari, Edge, Firefox의 기능 감지와 fallback
- Touch ID/Windows Hello가 없는 환경의 shim 승인
- 동기화형 패스키와 기기 귀속형 보안 키
- 모든 일반 경로에서 서버 로그·네트워크 payload에 평문이 없음
- 같은 브라우저 재접속, 로그아웃, 로컬 저장소 삭제, 기기 폐기

### 14.4 보안 검토

- 위협 모델 검토
- 암호 프로토콜과 라이브러리 검토
- XSS·CSP·브라우저 저장소 점검
- 패스키 등록·복구·폐기 abuse case 검토
- 키 유출·기기 분실 tabletop exercise
- 외부 보안 리뷰 완료 전 `zero-access` 문구를 정식 보안 보장으로 홍보하지 않음

## 15. 단계적 출시

### 단계 1: 기반

- E2EE 데이터 모델과 키 버전
- shim OS 보안 저장소
- Recovery Kit과 기기 등록
- 기존 서버 KEK 방식과 병행 가능한 스키마

### 단계 2: 신규 E2EE 수집과 조회

- shim 로컬 암호화
- 서버 ciphertext-only ingest
- 브라우저 복호화와 잠긴 히스토리
- 기존 컴퓨터 승인

### 단계 3: 패스키

- WebAuthn 로그인 등록·인증
- PRF 지원 감지
- passkey-wrapped UCK
- 로그인과 잠금 해제 결합

### 단계 4: 레거시 전환

- 기존 기록 보호 전환
- 관리자 집계 상태
- 레거시 복호화 경로 제거 조건 검증

### 단계 5: 강화

- UCK 회전과 DEK 재래핑
- 브라우저 로컬 검색
- 외부 보안 검토
- 필요 시 서명된 로컬 뷰어 고보증 모드 설계

## 16. 성공 기준

- 패스키가 없는 사용자가 shim 승인과 복구키만으로 E2EE를 설정하고 사용할 수 있다.
- DB와 서버 환경변수만 가진 테스트 운영자가 `e2ee_v1` 본문을 복호화할 수 없다.
- 승인되지 않은 브라우저는 로그인 후에도 본문을 볼 수 없다.
- PRF 지원 패스키는 로그인과 잠금 해제를 완료한다.
- PRF 미지원 패스키는 로그인 후 기기 승인 경로로 전환한다.
- 복구키로 모든 승인 기기를 잃은 사용자가 새 기기를 등록할 수 있다.
- 기기·패스키·복구키를 모두 잃은 경우 복구 불가 상태가 명확하게 안내된다.
- 조직·관리자 화면에는 본문과 키가 노출되지 않는다.
- 기존 `server_v1`과 `e2ee_v1`이 UI와 데이터에서 명확히 구분된다.
- 서버 요청·로그·telemetry에 평문 본문, UCK, 복구키, PRF 출력이 포함되지 않는다.

## 17. 공식 참고자료

- W3C Web Authentication Level 3, PRF extension: https://www.w3.org/TR/webauthn-3/#prf-extension
- FIDO Alliance passkey overview: https://fidoalliance.org/passkeys/
- FIDO synced/device-bound passkey deployment guidance: https://fidoalliance.org/white-paper-fido-deploying-passkeys-in-the-enterprise-introduction/
- Signal Secure Backups recovery key model: https://support.signal.org/hc/en-us/articles/9708267671322-Signal-Secure-Backups
- Proton E2EE recovery model: https://proton.me/blog/data-recovery-end-to-end-encryption
- OWASP browser storage testing: https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/12-Testing_Browser_Storage
- OWASP Cryptographic Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
