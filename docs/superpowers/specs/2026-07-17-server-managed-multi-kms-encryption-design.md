# 서버 관리형 다중 KMS 암호화 설계

- 상태: 작성 명세 승인 완료
- 작성일: 2026-07-17
- 대상: 프롬프트 본문 수집·열람, 암호화 공급자, 관리자 보안 상태, 기존 E2EE·legacy 데이터 전환
- 대체 설계: `2026-07-17-e2ee-multi-device-connection-design.md`

## 구현 계획

1. [Managed Encryption Foundation](../plans/2026-07-17-managed-encryption-foundation.md)
2. [Managed KMS Providers](../plans/2026-07-17-managed-kms-providers.md)
3. [Managed Content Cutover](../plans/2026-07-17-managed-content-cutover.md)
4. [Managed Content Migrations](../plans/2026-07-17-managed-content-migrations.md)
5. [Managed Encryption Operations](../plans/2026-07-17-managed-encryption-operations.md)

## 1. 결정 요약

toard의 신규 프롬프트 히스토리는 서버 관리형 envelope encryption만 지원한다. 설치 관리자는 배포 단위로 키 관리 공급자 하나를 선택한다.

- local KEK
- AWS KMS
- Google Cloud KMS
- Azure Key Vault
- HashiCorp Vault Transit
- OpenBao Transit

사용자는 새 기기 승인이나 Recovery Kit 없이 로그인만으로 어느 기기에서든 자신의 전체 히스토리를 열람한다. 기존 E2EE의 사용자 기기 키 보관, 브라우저 승인, Recovery Kit는 신규 설정에서 제거한다.

보안 경계는 다음과 같다.

- 다른 사용자는 본문을 열람할 수 없다.
- toard 관리자 계정은 본문 조회 기능과 복호화 권한을 갖지 않는다.
- DB 관리자 또는 DB 백업만으로는 본문을 복호화할 수 없다.
- 앱 런타임과 선택된 키 공급자의 복호화 권한을 함께 장악한 최고 인프라 운영자는 이론적으로 복호화할 수 있다.

제품은 이 구조를 E2EE 또는 zero-access라고 표현하지 않는다. `애플리케이션 계층에서 암호화되어 DB와 백업만으로는 복호화할 수 없음`을 보장 범위로 안내한다.

## 2. 배경

현재 `e2ee_v1`은 shim에서 사용자 콘텐츠 키로 본문을 암호화하고 승인된 브라우저에서만 복호화한다. 서버 운영자까지 차단할 수 있지만 새 컴퓨터마다 키 승인과 복구가 필요하다. 실제 다중 컴퓨터 사용에서는 계정 E2EE가 활성화됐지만 두 번째 컴퓨터에 키가 없어 본문 수집이 `409 E2EE_REQUIRED`로 차단되고, `toard-shim e2ee approve`도 로컬 UCK가 없어 실패한다.

현재 `server_v1`은 앱 환경변수 `TOARD_CONTENT_KEK_B64`로 레코드별 DEK를 감싸는 서버 관리형 envelope encryption이다. `apps/web/lib/content-crypto.ts`도 KMS 도입 시 DEK wrapping 계층을 교체할 수 있게 작성되어 있다. 그러나 설치 공통 KEK 하나가 직접 모든 레코드 DEK를 감싸고, 공급자 adapter, 사용자별 키 격리, 외부 KMS 인증, 전환 상태가 없다.

새 설계는 서버 관리형 사용성을 택하되 사용자별 콘텐츠 키 계층과 외부 KMS를 도입해 DB·백업 유출과 사용자 간 격리를 강화한다.

## 3. 목표

### 3.1 제품 목표

- 사용자는 로그인만으로 맥북, 맥미니, 다른 브라우저에서 같은 사용자 히스토리를 본다.
- 각 컴퓨터의 shim은 별도 E2EE 설정 없이 같은 사용자 히스토리에 본문을 수집한다.
- 관리자는 설치 전체에서 키 공급자 하나를 선택한다.
- local, AWS, GCP, Azure, Vault, OpenBao를 동일한 애플리케이션 계약으로 지원한다.
- 관리형 KMS의 호출 비용과 지연을 레코드 수가 아니라 활성 사용자 키 해제 횟수에 가깝게 제한한다.
- 공급자 전환 시 본문 전체를 재암호화하지 않고 사용자 키 wrapper만 교체한다.

### 3.2 보안 목표

- DB, DB 백업, DBA 조회만으로 본문을 복호화할 수 없다.
- 다른 사용자와 toard 관리자 계정은 본문 API를 사용할 수 없다.
- 평문 사용자 콘텐츠 키와 KMS 자격증명을 DB, 로그, telemetry에 저장하지 않는다.
- 앱 런타임만 필요한 최소 KMS wrap/unwrap 권한을 가진다.
- 마이그레이션, seed, 관리자 개인 계정에는 기본적으로 KMS decrypt 권한을 주지 않는다.
- KMS 장애 시 평문 저장으로 fallback하지 않는다.

## 4. 비목표와 제한

- 앱 서버와 KMS 복호화 권한을 함께 장악한 공격자까지 암호학적으로 차단
- 사용자 기기 기반 E2EE 신규 활성화
- 사용자별로 서로 다른 KMS 공급자 선택
- 조직별로 서로 다른 KMS 공급자 선택
- 공급자 자격증명을 toard DB나 관리자 화면에 저장
- 관리자 화면에서 실제 KMS 키 생성·삭제 또는 IAM 정책 변경
- HSM 수준의 보장을 local KEK 또는 software KMS에 대해 주장

DB 관리자는 본문 기밀성을 깨지 못해도 데이터를 삭제하거나 암호문을 변조할 수 있다. AES-GCM 인증은 변조를 감지하지만 삭제를 막지 않으므로 가용성과 복구에는 별도 백업이 필요하다.

## 5. 검토한 키 구조

### 5.1 레코드마다 KMS 직접 호출

- 단순하지만 본문 레코드 수만큼 비용, 지연, quota 사용이 증가한다.
- KMS 장애가 모든 레코드 처리에 직접 전파된다.
- 채택하지 않는다.

### 5.2 설치 공통 데이터 키

- KMS 호출은 적지만 하나의 키가 모든 사용자의 레코드 키를 감싼다.
- 사용자별 암호 경계와 blast radius가 약하다.
- 채택하지 않는다.

### 5.3 설치 KMS 키 → 사용자 콘텐츠 키 → 레코드 DEK

- KMS는 사용자 콘텐츠 키 생성·해제·회전·재래핑에만 사용한다.
- 본문 레코드는 앱 내부 AES-256-GCM으로 처리한다.
- 사용자별 키 격리와 비용 절감을 동시에 달성한다.
- 공급자 변경 시 사용자 wrapper만 교체한다.
- 채택한다.

## 6. 키 계층과 암호 계약

### 6.1 설치 키

설치 관리자가 선택한 공급자의 대칭 키 하나가 설치의 최상위 KEK다.

- AWS KMS symmetric KMS key
- GCP Cloud KMS symmetric encryption key version
- Azure Key Vault RSA wrapping key 또는 Managed HSM key
- Vault/OpenBao Transit named key
- local 256-bit KEK

공급자별 primitive가 완전히 같지 않으므로 애플리케이션 계약은 `wrapKey`와 `unwrapKey`의 결과를 opaque bytes로 다룬다. Azure의 RSA wrap/unwrap처럼 대칭 encrypt/decrypt와 다른 primitive도 adapter 내부에서 흡수한다.

### 6.2 사용자 콘텐츠 키

`User Content Key(UCK)`는 사용자별 256-bit 무작위 키다.

- 첫 서버 관리형 본문 수집 또는 기존 데이터 전환 시 생성한다.
- 선택된 공급자로 암호화한 wrapper만 DB에 저장한다.
- 평문은 요청 중 앱 메모리에만 존재한다.
- 사용자와 키 버전별로 구분한다.
- 공급자 전환 시 동일한 평문 UCK를 새 공급자로 다시 감싼다.
- Azure Key Vault key reference는 `/keys/{name}/{version}`으로 version을 고정한다.
  공급자 key rotation은 latest version 자동 추종이 아니라 active/migration
  profile 변경과 명시적 UCK rewrap으로 수행한다.

KMS encryption context 또는 공급자가 지원하는 AAD/context에는 다음을 정규화해 포함한다.

- 설치 ID
- 사용자 ID
- 사용자 키 버전
- 목적 문자열 `toard:prompt-history:user-key:v1`

공급자 차이에 관계없이 adapter가 감싸는 평문은 raw UCK가 아니라 versioned payload `format version | context digest | UCK`다. unwrap 후 payload의 context digest를 요청 context에서 다시 계산한 값과 constant-time 비교한 뒤 UCK만 반환한다. 공급자가 native encryption context 또는 AAD를 지원하면 같은 정규화 context를 추가로 전달한다. 따라서 DB의 wrapper 메타데이터만 바꾸는 것으로 사용자·설치·버전 경계를 우회할 수 없어야 한다.

### 6.3 레코드 DEK

각 프롬프트·응답 레코드는 별도의 256-bit DEK로 AES-256-GCM 암호화한다.

1. 레코드마다 CSPRNG로 DEK와 96-bit nonce를 생성한다.
2. DEK로 UTF-8 본문을 암호화한다.
3. 현재 UCK와 별도의 96-bit nonce로 DEK를 AES-256-GCM wrapping한다.
4. 평문 DEK는 즉시 zeroize 가능한 범위에서 폐기한다.

레코드 AAD에는 다음을 정규화해 포함한다.

- 암호 스키마 버전
- 설치 ID
- 사용자 ID
- dedup key
- provider
- role
- timestamp
- UCK 버전

DB 행을 다른 사용자나 메타데이터로 바꿔 끼우면 인증 태그 검증이 실패해야 한다.

### 6.4 저장 포맷

신규 암호화 스키마 이름은 `managed_v1`로 한다.

사용자 키 테이블은 다음 정보를 보관한다.

- `user_id`
- `key_version`
- `provider`
- `provider_key_ref`
- `wrapped_user_key`
- `context_version`
- `state`: `active`, `pending`, `retiring`
- 생성·검증·폐기 시각

`prompt_records`는 기존 ciphertext 필드를 재사용하되 다음 의미를 명확히 한다.

- `encryption_scheme='managed_v1'`
- `content_key_version`: UCK 버전
- `wrapped_dek`
- `dek_wrap_iv`
- `dek_wrap_auth_tag`
- `iv`
- `ciphertext`
- `auth_tag`
- `aad_version`

## 7. 공급자 공통 인터페이스

```ts
type KeyContext = {
  installationId: string;
  userId: string;
  keyVersion: number;
  purpose: "prompt-history";
};

type WrappedUserKey = {
  provider: KeyProviderName;
  keyRef: string;
  ciphertext: Uint8Array;
  metadata: Record<string, string>;
};

interface KeyManagementProvider {
  readonly name: KeyProviderName;
  readonly fingerprint: string;
  wrapKey(plaintext: Uint8Array, context: KeyContext): Promise<WrappedUserKey>;
  unwrapKey(wrapped: WrappedUserKey, context: KeyContext): Promise<Uint8Array>;
  healthCheck(): Promise<KeyProviderHealth>;
  describeCredentialSource(): Promise<CredentialSourceSummary>;
}
```

공통 규칙:

- adapter는 평문 본문을 받지 않고 32-byte UCK만 처리한다.
- fingerprint는 provider 종류, key ref, endpoint의 비밀이 아닌 정규화 값으로 계산하며 credential 자체를 포함하지 않는다.
- adapter 오류에는 secret, token, plaintext key, 전체 provider response를 포함하지 않는다.
- unwrap 결과는 정확히 32 bytes인지 검증한다.
- 공급자별 retry는 throttling과 일시 오류에만 제한적으로 적용한다.
- 인증 실패, key disabled, key not found는 자동 fallback하지 않는다.
- 테스트 double을 제외하고 레코드별 KMS 호출을 허용하지 않는다.

## 8. 공급자와 인증

### 8.1 공통 설정

```env
TOARD_KEY_ACTIVE_PROVIDER=aws-kms
TOARD_USER_KEY_CACHE_TTL_SECONDS=1800
```

설치 ID는 비밀값이 아니다. 최초 DB 초기화 때 UUID를 생성해 설치 singleton 테이블에 저장하고 DB 백업·복구에 포함한다. 환경변수로 매번 생성하거나 인스턴스별로 다르게 설정하지 않는다. 값이 변경되면 기존 encryption context와 맞지 않아 unwrap이 실패하므로 복원 시 원래 DB 식별자를 유지한다.

평상시 앱은 `active` 공급자 프로필 하나만 요구한다. 공급자 전환 또는 같은 공급자의 key ref 회전 기간에는 신규 공급자를 위한 선택적 `migration` 프로필을 함께 로드한다.

```env
TOARD_KEY_ACTIVE_PROVIDER=aws-kms
TOARD_KEY_MIGRATION_PROVIDER=openbao-transit
```

공급자별 비민감 설정과 credential source는 같은 프로필 접두사를 사용한다. 예를 들어 active AWS key ref와 migration OpenBao address·mount·key를 각각 `TOARD_KEY_ACTIVE_*`, `TOARD_KEY_MIGRATION_*`로 전달한다. 같은 공급자의 key ref만 바꾸는 회전에서도 두 프로필을 사용한다. wrapper의 provider, key ref, fingerprint가 어느 프로필과 일치하는지 확인해 adapter 인스턴스를 선택한다. migration 프로필이 없으면 앱은 active fingerprint 외의 새 wrapper를 생성하거나 승격하지 않는다.

### 8.2 local

- 초기 호환 전환에서는 기존 `TOARD_CONTENT_KEK_B64`를 읽을 수 있지만 `managed_v1`의 정상 설정은 `TOARD_KEY_ACTIVE_LOCAL_KEK_FILE`을 사용한다.
- local key 회전 중 신규 키는 `TOARD_KEY_MIGRATION_LOCAL_KEK_FILE`로 전달한다.
- raw KEK는 환경변수보다 Docker/Kubernetes secret file을 우선 지원한다.
- 별도 API 비용은 없지만 백업, 회전, 접근 제어를 운영자가 책임진다.

### 8.3 AWS KMS

비민감 설정:

- KMS key ARN 또는 alias
- region
- 선택적 custom endpoint

인증은 AWS SDK for JavaScript의 default credential provider chain을 사용한다.

- EC2/ECS/EKS IAM role
- Web Identity/OIDC
- AssumeRole
- shared credentials
- environment access key fallback

프로덕션에서는 workload role을 권장하고 static access key가 감지되면 관리자 상태에 경고한다.

### 8.4 GCP Cloud KMS

비민감 설정:

- project
- location
- key ring
- crypto key
- 선택적 key version

인증은 Application Default Credentials를 사용한다.

- attached service account
- Workload Identity Federation
- local ADC
- `GOOGLE_APPLICATION_CREDENTIALS` fallback

장기 service account JSON key는 경고 대상으로 분류한다.

### 8.5 Azure Key Vault

비민감 설정:

- vault URL
- key name
- 선택적 key version

인증은 Azure Identity SDK를 사용한다.

- Managed Identity
- Workload Identity
- service principal environment credential
- 개발 환경 Azure CLI

프로덕션에서는 명시적 Managed/Workload Identity를 권장하고 credential chain이 개발자 interactive identity를 선택한 경우 경고하거나 프로덕션에서 차단한다.

### 8.6 Vault/OpenBao Transit

비민감 설정:

- address
- transit mount
- key name
- namespace 선택값
- auth method

지원 인증:

- Kubernetes Auth
- AppRole
- token file
- 정적 token fallback

플랫폼 auth가 가능하면 AppRole보다 우선한다. 발급 token은 메모리에만 보관하고 만료·갱신을 처리한다. Vault와 OpenBao는 Transit 호환 adapter core를 공유하되 제품명과 호환성 테스트를 분리한다.

TLS 검증은 기본 강제한다. custom CA bundle은 secret file 경로로만 받으며 `skip TLS verify`는 개발 환경 외에는 허용하지 않는다.

## 9. 사용자 키 캐시와 비용 통제

관리형 KMS 호출은 레코드 수가 아닌 사용자 키 cache miss 수에 가깝게 제한한다.

- 기본 TTL: 30분
- 캐시 key: installation ID, user ID, key version, provider fingerprint
- 같은 사용자·버전의 동시 unwrap은 single-flight로 합친다.
- 평문 UCK는 프로세스 메모리에만 저장한다.
- Redis, DB, 파일, 브라우저 저장소에 평문 UCK를 캐시하지 않는다.
- TTL 만료, provider 변경, key retirement 때 캐시를 제거한다.
- replica 간 캐시는 공유하지 않는다.

보안과 비용의 균형을 위해 TTL은 운영자가 변경할 수 있지만 상한을 둔다. 기본 권장 범위는 5분~60분이며 상한 초과 설정은 거부하거나 강한 경고와 명시적 override를 요구한다.

관찰 항목:

- 공급자별 wrap/unwrap 호출 수
- 캐시 hit/miss와 single-flight 합쳐진 수
- latency와 오류 코드 분류
- 사용자 키 생성·회전·전환 호출 수
- provider별 추정 비용

예상 비용은 관리자가 입력한 선택적 단가 override 또는 내장 참고 단가로 계산한다. 내장 단가는 시점에 따라 달라질 수 있음을 표시하고 청구서와 동일하다고 보장하지 않는다.

## 10. 접근 제어

### 10.1 애플리케이션

- 모든 본문 쿼리는 `withUserContext(userId)` 안에서 실행한다.
- 앱 DB role은 non-superuser, non-`BYPASSRLS`여야 한다.
- `prompt_records`에 RLS를 활성화하고 가능한 경우 `FORCE ROW LEVEL SECURITY`를 적용한다.
- 본문 API는 세션 user ID와 레코드·사용자 키 user ID가 일치하는지 애플리케이션에서도 검증한다.
- toard 관리자 역할을 이유로 본문 소유권 검사를 우회하지 않는다.
- 관리자 API와 UI에는 평문 본문 조회 기능을 만들지 않는다.

### 10.2 KMS 권한

- 앱 런타임 role: 선택한 설치 키의 wrap/unwrap만 허용
- schema migration/seed role: KMS 권한 없음
- content-admin one-shot role: 기존 본문 또는 provider 전환 때만 앱과 같은 최소 wrap/unwrap 권한 사용
- 운영자 개인 role: 기본 decrypt 권한 없음
- key admin role: 키 정책·회전 가능, 평상시 decrypt 불가
- break-glass decrypt가 필요하면 별도 시간 제한 역할과 외부 감사 절차로 운영하며 toard 기능으로 제공하지 않는다.

### 10.3 감사

toard 감사 이벤트에는 다음만 기록한다.

- user ID
- 요청 목적: ingest, history, migration, provider migration
- provider와 key version
- cache hit/miss
- 성공/실패 분류와 latency
- 시각과 app instance ID

본문, UCK, DEK, wrapped key 전체, KMS token과 credential은 기록하지 않는다. 클라우드 공급자의 native audit log도 활성화하도록 배포 문서에서 안내한다.

## 11. 수집과 열람

### 11.1 신규 수집

shim은 로그인 사용자 ingest token으로 평문 본문을 HTTPS 전송한다. 이는 E2EE가 아니므로 제품·설치 화면에 서버가 정상 요청 처리 중 본문을 복호화할 수 있음을 명시한다.

서버는:

1. ingest token으로 user ID를 확정한다.
2. 현재 활성 UCK를 캐시 또는 KMS에서 얻는다.
3. 레코드별 DEK로 본문을 암호화한다.
4. DEK를 UCK로 감싼다.
5. `managed_v1`로 저장한다.
6. 저장 성공 후에만 shim content cursor가 진행될 수 있는 응답을 반환한다.

KMS 또는 암호화 실패 시 평문이나 `server_v1`로 fallback하지 않는다.

### 11.2 열람

서버는 로그인 사용자 소유의 `managed_v1` 행만 조회한다.

1. RLS와 애플리케이션 소유권 검사를 통과한다.
2. UCK를 캐시 또는 KMS에서 얻는다.
3. 레코드 DEK와 본문을 복호화한다.
4. 사용자 응답에만 평문을 포함한다.

toard 관리자 계정도 다른 사용자 ID의 본문 API를 호출할 수 없다.

## 12. KMS 장애와 fail-closed

KMS 장애 시:

- 사용량·비용 이벤트 수집과 일반 대시보드는 계속 동작한다.
- 캐시에 유효한 UCK가 있는 사용자는 TTL 동안 본문 기능을 사용할 수 있다.
- cache miss 사용자의 본문 수집과 열람은 일시 중단한다.
- 평문 저장, local provider 자동 fallback, 다른 공급자 자동 fallback을 하지 않는다.
- shim content cursor는 본문 저장 성공 후에만 갱신한다.
- 복구 후 같은 로컬 레코드를 다시 수집하고 dedup key가 중복을 흡수한다.

`/api/ready` 정책:

- 본문 기능이 명시적으로 비활성화된 설치는 일반 readiness를 유지한다.
- 본문 기능이 활성인데 provider 설정이 불완전하면 startup/readiness를 실패시킨다.
- 런타임 일시 장애는 전체 앱 readiness를 즉시 내리기보다 본문 subsystem degraded 상태로 노출한다.
- 설정 오류와 일시 네트워크 오류를 구분한다.

## 13. 공급자와 키 변경

### 13.1 같은 공급자 키 회전

현재 key ref는 `active`, 새 key ref는 `migration` 프로필로 설정한 뒤 사용자 UCK wrapper만 재래핑한다.

1. 기존 active wrapper로 UCK 해제
2. 새 key ref로 동일 UCK wrap
3. 새 wrapper를 pending 행에 저장
4. 새 wrapper unwrap 결과가 원본 UCK와 일치하는지 constant-time 비교
5. 실제 레코드 canary 복호화
6. 새 wrapper를 active로 승격
7. 기존 wrapper를 retiring으로 보존

### 13.2 공급자 전환

환경설정과 전용 관리 CLI를 사용한다. V1 관리자 UI는 전환 실행 기능을 제공하지 않는다.

예시:

```bash
toard-admin encryption rewrap-provider \
  --from aws-kms \
  --to openbao-transit
```

전환 시작 시 기존 공급자는 `active`, 신규 공급자는 `migration` 프로필로 실행한다. 사용자별 승격이 진행되는 동안 앱 런타임과 CLI는 두 프로필을 모두 사용할 수 있어야 한다. 모든 사용자 wrapper가 신규 공급자로 승격되고 유예 기간·백업 검증이 끝나면 운영자는 신규 프로필을 `active`로 옮겨 재시작하고 기존 프로필을 제거한다.

전환 규칙:

- old와 new provider 설정을 `active`·`migration` 프로필로 동시에 읽을 수 있어야 한다.
- 사용자별 transaction으로 pending wrapper를 저장하고 검증한다.
- 실패한 사용자는 기존 active wrapper를 유지한다.
- 재시작 후 미완료 사용자부터 재개한다.
- 본문 ciphertext와 레코드 DEK wrapper는 변경하지 않는다.
- 모든 사용자 완료 뒤에도 기존 wrapper를 유예 기간 보존한다.
- 신규 공급자 승격 완료 전에는 migration 프로필을 제거하거나 active 설정을 단독 전환하지 않는다.
- DB 백업과 표본 복호화 검증 뒤에만 운영자가 기존 KMS 권한과 키를 제거한다.

관리 CLI와 화면은 기존 공급자 제거 가능 여부를 계산하지만 실제 외부 KMS 키를 삭제하지 않는다.

## 14. 기존 데이터 전환

### 14.1 `server_v1`

현재 KEK로 기존 레코드를 복호화하고 `managed_v1`로 같은 행을 원자 교체한다.

- 사용자 UCK가 없으면 생성한다.
- batch, 중단·재개, digest 검증을 지원한다.
- 성공 전에는 원래 `server_v1` 행을 유지한다.
- 전체 전환과 백업 보존 검증 전까지 기존 KEK를 제거하지 않는다.

### 14.2 `e2ee_v1`

서버는 기존 UCK를 모르므로 승인된 브라우저가 전환한다.

1. 브라우저가 기존 E2EE 기록을 로컬 UCK로 복호화한다.
2. 서버의 migration session에 원본 record identity와 평문을 HTTPS로 제출한다.
3. 서버가 해당 사용자의 관리형 UCK로 즉시 재암호화한다.
4. source digest, user, key version, record metadata를 검증한다.
5. 같은 행을 `managed_v1`로 원자 교체한다.
6. 응답 후 브라우저 메모리의 평문 batch를 폐기한다.

전환 중에는 기존 E2EE 읽기 경로를 유지한다. 브라우저를 닫거나 네트워크가 끊기면 남은 `e2ee_v1` 행부터 재개한다.

승인 기기와 Recovery Kit를 모두 잃은 사용자의 E2EE 본문은 서버가 복구할 수 없다. 해당 행을 삭제하거나 빈 문자열로 바꾸지 않고 `migration_blocked_key_unavailable` 상태로 보존한다.

### 14.3 E2EE 기능 제거 조건

- 신규 installer와 shim에서 E2EE setup을 제거한다.
- 기존 shim E2EE 수집은 전환 기간 동안만 지원한다.
- 모든 복구 가능한 `e2ee_v1`이 0이고 blocked 사용자 정책이 결정된 뒤 브라우저 승인·Recovery Kit UI를 제거한다.
- blocked 기록은 관리자가 본문을 볼 수 없으며 사용자에게 보존·삭제 선택을 제공한다.
- 기존 E2EE 데이터가 남아 있는 동안 관련 키·wrapper 테이블과 읽기 경로를 제거하지 않는다.

## 15. 관리자 화면

V1은 상태 확인과 진단만 제공한다.

- 현재 provider와 비민감 key ref
- credential source 요약
- workload identity 또는 static credential 여부
- health check 결과와 최근 성공·실패 시각
- wrap/unwrap latency와 오류
- 캐시 hit rate
- 최근 30일 호출량과 예상 비용
- `server_v1`, `e2ee_v1`, `managed_v1` 건수
- 기존 데이터 전환 진행률과 blocked 사용자 수
- 공급자 전환 진행 상태가 존재하면 읽기 전용 표시

관리자 화면에서 다음을 제공하지 않는다.

- KMS secret 입력·저장
- provider 변경
- 외부 키 생성·삭제
- IAM 정책 수정
- 사용자 본문 조회
- 임의 사용자 키 unwrap

## 16. 배포 설정

Compose, Helm, 일반 환경변수에 공급자별 비민감 설정과 secret file 경로를 추가한다. Secret 자체는 values, DB, 로그에 출력하지 않는다.

배포 문서는 환경별 권장 인증을 우선한다.

- AWS: ECS task role, EC2 instance profile, EKS IRSA
- GCP: attached service account, Workload Identity
- Azure: Managed Identity, Workload Identity
- Kubernetes Vault/OpenBao: Kubernetes Auth
- 일반 VM Vault/OpenBao: AppRole 또는 agent token file
- local: Docker/Kubernetes secret file

설치 전 검증 명령은 provider와 key ref, wrap/unwrap canary 결과만 출력하고 secret은 출력하지 않는다.

## 17. 테스트 전략

### 17.1 공통 단위 테스트

- provider contract의 32-byte wrap/unwrap
- 잘못된 user, installation ID, version, purpose context 거부
- UCK/DEK AES-GCM golden vector
- AAD 변경, nonce, tag, ciphertext 변조 실패
- 캐시 TTL, eviction, single-flight, provider fingerprint 분리
- provider 오류 redaction

### 17.2 provider adapter 테스트

- local provider 실암호 테스트
- AWS/GCP/Azure SDK command와 context 매핑 테스트
- Vault/OpenBao Transit 요청·응답과 token 갱신 테스트
- static credential 감지와 경고
- health check가 영구 설정 오류와 일시 장애를 구분

실제 클라우드 자격증명이 필요한 테스트는 opt-in CI 또는 수동 배포 검증으로 분리한다. 기본 CI는 SDK mock과 계약 테스트를 사용하되, release 전 각 provider의 실제 wrap/unwrap canary를 수행한다.

### 17.3 보안 테스트

- 사용자 A 세션으로 사용자 B 행과 UCK 조회 불가
- toard admin 역할의 본문 API 우회 불가
- app DB role이 superuser·BYPASSRLS가 아님
- DB dump에 평문 본문, UCK, KMS credential 없음
- migration/seed 프로세스에 KMS 권한 없음
- 로그와 metrics에 secret 및 plaintext 없음

### 17.4 장애·전환 테스트

- KMS timeout, throttling, auth failure, disabled key
- 캐시 hit 중 KMS 장애와 cache miss 중 장애
- 수집 저장 실패 시 cursor 미진행
- 공급자 변경 중 프로세스 종료 후 재개
- 새 wrapper 검증 실패 시 기존 active wrapper 유지
- 기존 provider 제거 전 readiness와 관리자 경고
- `server_v1` 및 `e2ee_v1` 전환 중단·재개·원자 교체

### 17.5 E2E

- AWS, GCP, Azure, Vault, OpenBao, local 설치별 신규 수집과 열람
- 맥북에서 수집한 기록을 맥미니 로그인 후 열람
- 다른 사용자와 관리자 계정에 본문 미노출
- DB superuser가 행을 읽어도 외부 KMS 권한 없이는 복호화 불가
- 기존 E2EE 브라우저 자동 전환 후 여러 기기에서 열람

## 18. 출시 순서

1. provider-independent UCK와 `managed_v1` 데이터 모델
2. local provider와 사용자 키 캐시
3. AWS, GCP, Azure adapter
4. Vault/OpenBao Transit adapter와 인증
5. 신규 managed 수집·열람 전환
6. `server_v1` 자동 전환
7. `e2ee_v1` 승인 브라우저 전환
8. 관리자 보안·비용 상태와 배포 문서
9. E2EE 신규 설정 제거와 최종 legacy retirement

각 단계는 expand→migrate→contract 순서를 지켜 구버전 앱·shim과 잠시 공존할 수 있어야 한다.

## 19. 완료 기준

- 설치 관리자가 local, AWS, GCP, Azure, Vault, OpenBao 중 하나를 선택할 수 있다.
- 공식 SDK 기본 인증 체인과 workload identity를 사용할 수 있다.
- 사용자별 UCK와 레코드별 DEK가 분리된다.
- 레코드 처리마다 관리형 KMS를 호출하지 않는다.
- 다른 사용자, toard 관리자, DB 관리자와 DB 백업만으로 본문을 볼 수 없다.
- 앱 런타임만 선택된 설치 키의 최소 wrap/unwrap 권한을 가진다.
- 사용자는 기기 승인 없이 로그인만으로 전체 히스토리를 열람한다.
- 공급자 전환에서 본문 ciphertext를 변경하지 않고 사용자 wrapper만 안전하게 교체한다.
- `server_v1`과 복구 가능한 `e2ee_v1` 기록을 데이터 손실 없이 `managed_v1`로 전환한다.
- KMS 장애 중 평문 fallback과 본문 cursor 유실이 없다.
- 관리자 화면과 로그에 본문, 평문 키, KMS credential이 노출되지 않는다.
