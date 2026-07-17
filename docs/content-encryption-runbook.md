# 서버 관리형 본문 암호화 운영 런북

이 문서는 `managed_v1` 본문 암호화의 연결, 상태 확인, `server_v1` 전환, KMS 공급자 교체와 복구 절차다.
현재 신규 E2EE setup/activation은 폐기되었고, 기존 `e2ee_v1` ciphertext와 blocked migration은 삭제하지
않은 채 recovery/migration API만 유지한다.

recovery wrapper/complete와 managed migration status/page/state/commit은 로그인 사용자별 legacy capability를
본문 파싱이나 하위 서비스 호출보다 먼저 확인한다. 기존 `e2ee_v1` 행이 있으면 `migration`, blocked migration이면
`recovery`로 계속 처리한다. E2EE 계정이 없거나 계정만 있고 legacy 행이 없으면 `410 E2EE_SETUP_RETIRED`,
capability 조회 자체가 실패하면 `500 E2EE_LEGACY_GATE_FAILED`와 `Cache-Control: no-store`로 닫힌다. 이 gate는
기존 ciphertext, wrapper, migration state를 자동 삭제하거나 다시 암호화하지 않는다.

## 보안 경계

- 본문은 레코드별 DEK로 암호화되고, 사용자별 UCK가 DEK를 감싼다. DB에는 본문 ciphertext와 KMS/Transit/
  local KEK로 감싼 UCK wrapper만 저장한다.
- 일반 관리자 UI/session은 RLS를 통해 자기 사용자 범위 밖의 행과 평문을 읽지 못한다. DB superuser는 RLS를
  우회하여 ciphertext와 wrapper를 볼 수 있지만, DB dump만으로는 평문을 복구할 수 없다.
- KMS/Transit 사용 권한 또는 local KEK 파일과 DB를 함께 가진 서버 운영자는 앱 복호화 경로를 실행할 수 있다.
  따라서 이 구조는 DB 단독 유출과 일반 관리자/타 사용자를 막지만, 서버와 키 권한을 동시에 장악한 운영자에
  대한 E2EE는 아니다.
- credential, token, raw UCK/DEK/KEK는 DB, 관리자 UI, ConfigMap, 이미지 layer에 넣지 않는다. 관리 화면은
  provider, 비민감 key ref/fingerprint, credential source 종류, health, 집계와 참고 비용만 표시한다.

## 공급자 연결과 최소 권한

설치 전체에서 active provider 하나를 선택한다. 공급자 교체 중에만 migration provider 하나를 함께 둔다.
앱 health는 실제 wrap→unwrap canary이므로 두 암호 연산 권한이 반드시 필요하다. 아래 read/describe 권한은
키 ID 사전 점검에도 쓰는 제한된 진단 권한이다. 키 생성·삭제·회전·정책 변경, wildcard 관리자 role은 주지 않는다.

### AWS KMS

Active profile은 `TOARD_KEY_ACTIVE_PROVIDER=aws-kms`, `TOARD_KEY_ACTIVE_AWS_KEY_ARN`,
`TOARD_KEY_ACTIVE_AWS_REGION`을 사용한다. SDK default credential chain 또는 workload identity를 쓰고 장기
access key를 env에 직접 넣지 않는다.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey"],
    "Resource": "arn:aws:kms:REGION:ACCOUNT:key/KEY_ID"
  }]
}
```

AWS의 action/resource 지원 범위는 [AWS KMS Service Authorization Reference](https://docs.aws.amazon.com/service-authorization/latest/reference/list_awskeymanagementservice.html)를 기준으로 한다.

### Google Cloud KMS

`TOARD_KEY_ACTIVE_PROVIDER=gcp-kms`와
`TOARD_KEY_ACTIVE_GCP_KEY_NAME=projects/.../locations/.../keyRings/.../cryptoKeys/...`를 사용한다.
Workload Identity/ADC를 우선하고, 서비스 계정 JSON을 써야 하면 read-only secret file로만 투영한다.

최소 custom role에는 아래 권한만 넣고 대상 CryptoKey에 바인딩한다.

```yaml
includedPermissions:
  - cloudkms.cryptoKeyVersions.useToEncrypt
  - cloudkms.cryptoKeyVersions.useToDecrypt
  - cloudkms.cryptoKeys.get
```

권한 및 predefined role 범위는 [Cloud KMS permissions and roles](https://cloud.google.com/kms/docs/reference/permissions-and-roles)를 확인한다.

### Azure Key Vault

`TOARD_KEY_ACTIVE_PROVIDER=azure-key-vault`, version까지 포함한 HTTPS `TOARD_KEY_ACTIVE_AZURE_KEY_ID`,
`TOARD_KEY_ACTIVE_AZURE_CREDENTIAL_MODE=managed-identity|workload-identity`를 사용한다. production에서는
`default` mode가 거부된다. 대상 key에 `wrapKey`, `unwrapKey`, key read만 부여한다. Key Vault 전체 관리자
role은 쓰지 않는다. Azure RBAC/access policy 대응표는 [Microsoft의 RBAC migration guide](https://learn.microsoft.com/en-us/azure/key-vault/general/rbac-migration)와 [Key Vault 인증 가이드](https://learn.microsoft.com/en-us/azure/key-vault/general/authentication)를 따른다.

### Vault Transit / OpenBao Transit

둘 다 HTTPS address, mount, key name과 `token-file|kubernetes|approle|static-token` 중 하나를 설정한다. token,
JWT, AppRole ID는 값이 아니라 절대 파일 경로로 주입한다. namespace와 endpoint에 query/credential을 넣지 않는다.

```hcl
path "MOUNT/encrypt/KEY" { capabilities = ["update"] }
path "MOUNT/decrypt/KEY" { capabilities = ["update"] }
path "MOUNT/keys/KEY"    { capabilities = ["read"] }
```

`create`를 주지 않으면 오타 난 key를 자동 생성하지 않는다. Transit 경로와 HTTP verb/capability 매핑은
[Vault Transit API](https://developer.hashicorp.com/vault/api-docs/secret/transit),
[Vault policy 문법](https://developer.hashicorp.com/vault/docs/concepts/policies),
[OpenBao Transit API](https://openbao.org/api-docs/secret/transit/)를 기준으로 한다.

### Local

`TOARD_KEY_ACTIVE_PROVIDER=local`과 컨테이너 내부 절대 경로
`TOARD_KEY_ACTIVE_LOCAL_KEK_FILE=/run/toard-secrets/local-kek`를 쓴다. 파일은 정확히 32 raw bytes다.

```bash
install -d -m 0700 ./secrets
umask 077
openssl rand 32 > ./secrets/local-kek
chmod 0600 ./secrets/local-kek
# Linux Compose host에서는 runner/content-admin UID가 읽을 수 있게 소유자를 맞춘다.
sudo chown 1001:1001 ./secrets/local-kek
```

KEK는 DB 백업과 분리한 암호화 백업에 보관한다. 파일을 잃으면 wrapper를 복호화할 수 없으며, 교체가 끝나기
전에 이전 파일을 덮어쓰거나 삭제하면 복구할 수 없다. Compose의 `TOARD_KEY_SECRET_DIR`은 앱과
content-admin에 `/run/toard-secrets:ro`로만 mount된다.

## Compose 운영

credential 값 대신 workload identity 변수 또는 `TOARD_KEY_SECRET_DIR` 아래 파일 경로를 `.env`에 설정한다.
`migrate`와 `seed`에는 encryption env/secret volume이 전달되지 않고, `content-admin`은 profile을 지정해
실행할 때만 생기는 one-shot container다.

관리형 본문을 활성화할 때는 `MIGRATION_DATABASE_URL`에 owner 연결을, `APP_DATABASE_URL`에 `toard_app` 연결을 둔다. 먼저 `docker compose up -d postgres migrate`로 owner migration을 끝내고, owner 연결로 `scripts/bootstrap-app-role.sql`을 실행한 뒤 앱을 시작하거나 재시작한다. 비밀번호는 shell env나 argv가 아닌 **owner-only (0600) psql input file**에 PSQL-quoted 변수와 bootstrap script의 absolute `\i` 경로로만 넣는다. `migrate`와 `seed`는 owner URL만 사용하며 KMS env/secret mount를 받지 않는다. 앱 또는 content-admin이 superuser/BYPASSRLS 연결이면 managed content readiness가 503으로 fail-closed한다. URL·비밀번호와 `docker compose config` 출력을 공유하지 않는다.

```bash
# 전체 scheme/key 집계와 provider 전환 readiness
docker compose --profile content-admin run --rm content-admin encryption status

# legacy server_v1 → managed_v1, transaction당 최대 25개
docker compose --profile content-admin run --rm content-admin \
  encryption migrate-server --batch-size 25

# active=aws-kms, migration=openbao-transit로 설정한 뒤 UCK wrapper 전환
docker compose --profile content-admin run --rm content-admin \
  encryption rewrap-provider --from aws-kms --to openbao-transit \
  --actor-user-id "$ADMIN_USER_ID"

# 같은 AWS KMS provider 안에서 migration profile을 새 key ref로 둔 key rotation
docker compose --profile content-admin run --rm content-admin \
  encryption rewrap-provider --from aws-kms --to aws-kms \
  --actor-user-id "$ADMIN_USER_ID"
```

`ADMIN_USER_ID`는 CLI operator가 인프라 접근통제 아래 지정하는 **approval subject**(DB에서 admin role을
검증할 사용자 UUID)다. 이는 CLI를 실행한 operator의 인증 identity가 아니며, 명령은 DB에서 지정된 사용자의
admin role만 검증한다. 실제 operator attribution은 content-admin workload와 외부 orchestration/audit log에서
추적한다. 누락·잘못된 UUID·member·삭제된 사용자는 시작 전에 실패한다. `encryption status`는 JSON으로
`serverRecords`, `e2eeRecords`, `managedRecords`, active/pending/retiring key 수와
`wrapperDistribution`, `providerMigration`을 출력한다. 이 CLI status는 DB 집계/readiness 조회이며 KMS canary를
호출하지 않는다. 실제 provider health/canary는 관리 → 시스템의 암호화 panel에서 확인한다. 이 health 경로의
canary는 실제 공급자 wrap/unwrap 호출이므로 호출 비용/쿼터에 포함될 수 있다.

주의:

- `TOARD_KEY_COST_PER_10000_USD`와 `TOARD_KEY_MONTHLY_KEY_COST_USD`는 반드시 둘을 함께 설정한다. override는
  active provider의 최근 30일 실제 KMS 호출(`cache_result=none`)만 계산하고 migration/다른 fingerprint 호출은
  제외한다. free tier, 세금, 약정, 네트워크 비용을 차감하지 않는 참고치다.
- 내장 참고값은 기준일과 함께 표시되는 AWS/GCP 값뿐이다. Azure/Vault/OpenBao/local은 override 없이는 호출량만
  표시하고 금액을 만들지 않는다. 현재 코드 snapshot(2026-07-17)은 AWS `$0.03/10,000 calls + $1.00/key-month`,
  GCP `$0.03/10,000 calls + $0.06/key-month`이며 실제 invoice가 아니라 명시된 기준일의 gross reference다.
- static credential은 workload identity보다 회전·유출 부담이 크다. 꼭 필요하면 raw env가 아닌 read-only
  file을 쓰고 최소 TTL/권한으로 운영한다.
- `docker compose config` 출력에는 치환된 환경값과 secret 경로가 나타날 수 있다. 결과 파일을 이슈, 채팅,
  CI artifact에 공유하지 않는다.

## 안전한 공급자 전환

1. DB 전체 백업을 만들고 복원 테스트를 한다. local이면 이전/신규 KEK를 DB와 분리해 각각 백업한다.
2. old provider를 active로 유지한 채 target을 migration profile에 추가한다. 두 공급자의 decrypt 권한을 모두
   유지하고 앱과 content-admin을 재시작한다. 같은 공급자 안의 key-ref 회전도 지원하며 이때 active와 migration
   profile의 provider 이름은 같고 fingerprint는 달라야 한다. 두 fingerprint가 같으면 명령은 시작하지 않는다.
3. 관리 panel health와 `encryption status`를 확인한다. target 설정 오류가 있으면 rewrap을 시작하지 않는다.
4. `rewrap-provider --from OLD --to TARGET --actor-user-id ADMIN_UUID`를 실행한다. `ADMIN_UUID`는 operator가
   지정하고 DB admin role로 확인되는 approval subject이며, 실제 operator attribution은 content-admin workload와
   외부 orchestration audit에 남긴다. 명령은 target provider/fingerprint, 동일 app instance로
   `provider_migration_started`를 먼저 기록한다. 그 뒤
   사용자별로 검증된 pending wrapper를 만든 뒤
   canary를 복호화하고 한 transaction에서 target을 active, old를 retiring으로 바꾼다. 실패 사용자는 old
   wrapper를 유지하며 명령은 exit 1과 안전한 오류 코드만 출력한다. 수정 후 같은 명령을 재실행할 수 있다.
5. `encryption status` 또는 관리 panel의 비민감 분포를 확인한다. 둘 다 RLS가 적용된 사용자 wrapper 행을
   직접 열거하지 않고 `provider/fingerprint/state/count` 집계만 읽는다.

```bash
docker compose --profile content-admin run --rm content-admin encryption status | jq \
  '{wrapperDistribution, providerMigration}'
```

`providerMigration.removalReady=true`는 runtime migration target fingerprint의 `active` 수가 전체 active 수와
같고, old fingerprint의 active가 0이며, pending과 예상 밖 active fingerprint가 모두 0일 때만 나온다.
target 설정 누락, malformed/overflow 집계, 작업 후 새 old active wrapper가 생긴 경우에는 fail-closed한다.
모든 사용자 처리와 이 판정이 성공한 뒤에만 같은 actor/target/app instance의
`provider_migration_completed`가 기록된다. 완료 판정은 migration 39의 wrapper-distribution advisory lock을
잡은 단일 DB transaction에서 분포 재조회와 감사 INSERT를 함께 수행한다. 경쟁 old/pending writer는 그
transaction 뒤로 직렬화된다. 실패·중단·not-ready에는 completed가 남지 않는다. old wrapper는 즉시 삭제하지
않고 `retiring` 상태로 남긴다.
6. 실제 history 읽기/수집을 관찰하는 유예 기간을 둔다. 문제가 생기면 두 provider 설정과 old decrypt 권한을
   그대로 둔 채 원인을 고치고 재실행한다. target 장애 중 old 설정/권한을 먼저 제거하지 않는다.
7. 유예가 끝난 뒤 active를 target으로 바꾸고 migration profile을 제거한다. 최종 health/fingerprint/status와
   백업을 확인한 다음에만 old provider 권한을 회수한다. wrapper/key의 자동 삭제 기능은 제공하지 않는다.

`provider_migration_started|completed`와 사용자별 `user_key_rewrapped` 감사 INSERT가 실패하면 전환 명령도
실패한다. CLI는 actor UUID, provider 오류 원문, credential·key material을 stdout/stderr에 출력하지 않는다.

## Helm / GitOps

provider values 파일을 secret 없는 비민감 설정과 기존 Secret mount 참조로 작성한 뒤 먼저 검증한다.

```bash
pnpm validate:helm-encryption -- -f values-encryption.yaml --set secrets.authSecret=dummy

helm upgrade --install toard ./helm/toard -n toard \
  -f values-encryption.yaml \
  --set migrate.releaseId="$GIT_COMMIT_SHA" \
  --wait --wait-for-jobs
```

- `migrate.releaseId`는 같은 desired state에는 같은 값, 새 release에는 새 Git SHA/semver를 쓴다. 앱/migrator/
  content-admin 이미지도 digest 또는 immutable tag로 고정한다.
- 앱 DB role을 `toard_app`으로 제한하면 migration owner URL을 별도 Secret으로 만들고
  `migrate.databaseSecret.name/key`로 지정한다. migration Job은 별도 ServiceAccount, token automount false이고
  KMS ConfigMap/secret mount를 받지 않는다.
- workload identity annotation/label은 `serviceAccount.annotations`/`podLabels`에 둔다. 이 ServiceAccount는 app과
  opt-in content-admin이 공유한다. 즉 현재 격리는 app/content-admin 대 migration/seed 경계이며,
  app과 content-admin 사이의 별도 pod identity 분리는 아직 제공하지 않는다.
- `contentAdmin.enabled=false`가 기본이며 Helm hook이 아니다. 실행할 명령을 values에 명시해 Job을 만든다.

```bash
helm upgrade --install toard ./helm/toard -n toard -f values-encryption.yaml \
  --set contentAdmin.enabled=true \
  --set-json 'contentAdmin.command=["encryption","status"]' \
  --wait --wait-for-jobs

# Job 이름은 고정이고 Job spec은 immutable이다. 다시 실행/명령 변경 전 기존 Job을 삭제한다.
kubectl -n toard delete job toard-content-admin
```

실제 release fullname이 다르면 `kubectl -n toard get jobs -l app.kubernetes.io/component=content-admin`으로
이름을 확인한다. 작업 후 다시 `contentAdmin.enabled=false`로 reconcile한다.

## 장애 및 rollback

- provider auth/throttle/unavailable: old+target dual config와 old 권한을 유지하고 작업을 멈춘다. health가 회복된
  뒤 같은 batch/rewrap 명령을 다시 실행한다.
- `server_v1` migration 실패: legacy `TOARD_CONTENT_KEK_B64`를 제거하지 않는다. `serverRecords=0`과 백업 보존
  절차가 끝나기 전 legacy KEK를 폐기하지 않는다.
- Helm migration 실패: 새 app은 exact completion marker가 없어 ready가 되지 않는다. Job log를 확인해 원인을
  고치고 새 `migrate.releaseId`로 재실행한다. DB downgrade는 자동화하지 않는다.
- provider 전환 rollback: old decrypt 권한과 old wrapper가 남아 있을 때만 안전하다. 현재 target을 active로
  유지하고 old를 migration provider로 설정한 뒤 `rewrap-provider --from TARGET --to OLD`를 별도 변경 창에서
  수행한다(`--actor-user-id ADMIN_UUID` 필수). 모든 active wrapper가 old fingerprint로 돌아온 것을
  `providerMigration.removalReady=true`로 확인한 다음 active 설정을 old로 바꾼다.

## 보안 회귀 검증

실제 cloud credential와 production DB를 쓰지 않고 PG16/local 임시 KEK fixture로 실행한다.

```bash
pnpm test:content-security
```

이 검증은 실제 관리형 저장·열람 서비스와 승인된 browser HPKE envelope 흐름으로 E2EE/managed ciphertext와
wrapper가 존재하는지 확인한다. pg_dump와 실제 `toard-admin` 오류 출력에는 known plaintext/raw UCK/KEK/cloud
credential marker의 raw·hex·base64·base64url 변형이 없어야 한다. 또한 RLS가 타 사용자/admin session을
차단하는지, KEK mount가 없는 uid 65534 별도 process가 `LOCAL_KEK_FILE_UNAVAILABLE`로 실패하는지, 권한 있는
별도 process와 app runtime의 복호화만 성공하는지를 확인한다.
