# OrbStack Kubernetes 개인 서버 배포 설계

## 배경

회사용 toard는 Docker Compose로 이미 운영 중이다. 이번 작업은 같은 Mac 사용자 계정의 `toard-shim`이 회사 서버와 개인 서버에 동시에 전송하는 멀티 target 동작을 실제 장기 환경에서 검증하기 위해, Mac mini의 OrbStack Kubernetes에 개인용 toard를 별도로 설치하는 것이다.

개인 서버의 공개 주소는 `https://toard.devy1540.com`이며 Cloudflare Tunnel을 통해 노출한다. 회사 환경과 다른 설치 경로를 검증하기 위해 Helm 대신 저장소가 이미 제공하는 raw Kubernetes 리소스와 Kustomize를 사용한다.

현재 확인한 로컬 상태는 다음과 같다.

- OrbStack 2.2.1과 Docker는 실행 중이다.
- `kubectl`은 설치되어 있고 내장 Kustomize를 사용할 수 있다.
- kubectl context는 `orbstack`이지만 Kubernetes API `127.0.0.1:26443` 연결은 거부된다. 실제 배포 전에 OrbStack Kubernetes를 활성화해야 한다.
- Helm CLI는 설치되어 있지 않다.
- 저장소는 `k8s/`의 Kustomize 리소스와 `helm/toard/` 차트를 모두 제공한다.
- 현재 최신 공개 릴리스는 `v0.15.35`다. 이번 환경은 멀티 target shim과 개인용 Kustomize overlay를 포함한 `v0.15.36`을 사용한다.
- 호스트용 Cloudflare Tunnel `macmini`는 존재하지만, `toard.devy1540.com` DNS 레코드는 아직 없다.

## 목표

- OrbStack Kubernetes에 장기 운영 가능한 개인용 toard를 배포한다.
- Kustomize를 공식 지원 경로로 실제 검증한다.
- toard 앱은 2개 replica로 롤링 배포하고 PostgreSQL 데이터는 PVC에 보존한다.
- `toard.devy1540.com`을 Cloudflare Tunnel로 공개하되 Kubernetes Service 자체는 ClusterIP로 유지한다.
- Kubernetes용 공유 tunnel `macmini-k8s`를 만들고 향후 다른 Kubernetes 앱도 같은 tunnel을 사용할 수 있게 한다.
- 관리자 생성 전에는 공개 URL을 열지 않는다.
- `v0.15.36` release artifact와 GHCR 이미지를 검증한 뒤 배포한다.
- 기존 회사 target을 유지한 채 개인 서버 UI의 `install.sh`로 개인 target을 추가한다.
- 회사와 개인 서버의 전송, cursor, 장애가 서로 독립적으로 동작하는지 검증한다.
- Mac과 OrbStack을 재시작한 뒤 자동 복구와 데이터 보존을 장기 검증한다.

## 범위 제외

- 회사 서버의 이번 배포 작업. 회사 서버는 개인 환경 검증 후 별도로 업데이트한다.
- E2EE 설계 또는 구현. 서버 저장 암호화는 별도 KMS 작업의 결과를 따른다.
- ClickHouse 배포와 고용량 분석 경로.
- 첫 배포에서 Helm 검증.
- Kubernetes용 자동 updater 구현.
- Cloudflare Access 적용. 초기 구성에서 Access는 shim의 Bearer API 호출도 막을 수 있으므로 경로 예외나 service token 설계 없이 활성화하지 않는다.
- 호스트용 기존 `macmini` tunnel의 수정 또는 제거.

## 접근 방법 비교

### 선택: raw Kubernetes + Kustomize

저장소의 `k8s/` 리소스를 재사용하고 `k8s/overlays/orbstack-personal/`에 실제 장기 테스트 환경용 overlay를 둔다. 이 방식은 Helm CLI가 필요 없고, 기반 리소스와 OrbStack 전용 차이를 코드 리뷰에서 명확히 확인할 수 있다.

개인용 overlay는 공개 URL과 이미지 버전처럼 비밀이 아닌 환경 설정만 Git에 저장한다. 비밀번호, `AUTH_SECRET`, `CRON_SECRET`, Cloudflare Tunnel token은 저장소에 넣지 않고 클러스터 Secret으로만 생성한다.

### 대안: Helm

`helm/toard/`가 이미 존재하므로 패키지 설치와 values 기반 운영에는 적합하다. 다만 이번 목표는 Compose 외에 Kustomize 지원 경로를 실제로 검증하는 것이고 로컬에 Helm CLI도 없으므로 첫 테스트에서는 사용하지 않는다. Kustomize 장기 운영이 안정화된 뒤 별도 Helm 설치 테스트를 추가할 수 있다.

### 대안: 기존 `macmini` tunnel 재사용

기술적으로 가능하지만 호스트 원격 접근과 Kubernetes 서비스 라우팅의 변경 주기와 장애 범위가 섞인다. 또한 ClusterIP 서비스에 직접 연결하려면 tunnel 프로세스가 클러스터 내부에 있는 편이 단순하다. 따라서 호스트 tunnel은 유지하고 Kubernetes 클러스터 전체가 공유하는 `macmini-k8s` tunnel을 별도로 사용한다.

## 배포 구조

```text
Internet
   |
   v
toard.devy1540.com
   |
   v
Cloudflare Tunnel: macmini-k8s
   |
   v
cloudflared Deployment (namespace: cloudflare-tunnel, replicas: 2)
   |
   v
http://toard-app.toard-personal.svc.cluster.local:80
   |
   v
toard app Deployment (namespace: toard-personal, replicas: 2)
   |
   v
PostgreSQL StatefulSet + 10Gi PVC
```

### namespace와 책임 분리

- `toard-personal`: toard 앱과 migrate initContainer, PostgreSQL, ConfigMap, Secret, Service, PVC
- `cloudflare-tunnel`: 클러스터 공유 `cloudflared` Deployment와 Tunnel token Secret

toard를 제거하거나 재배포해도 `macmini-k8s` tunnel 자체는 유지한다. toard를 더 이상 공개하지 않을 때는 `toard.devy1540.com` published route만 제거한다.

### 애플리케이션

- app Deployment replica: 2
- rollout: `maxUnavailable: 0`, `maxSurge: 1`
- Service: `ClusterIP`, port 80
- Ingress, NodePort, LoadBalancer: 생성하지 않음
- PostgreSQL: 저장소의 bundled StatefulSet 사용
- PostgreSQL PVC: 10Gi
- ClickHouse: 비활성
- `TOARD_PUBLIC_URL`: `https://toard.devy1540.com`
- app image: `ghcr.io/devy1540/toard:0.15.36`
- migrate initContainer image: `ghcr.io/devy1540/toard-migrate:0.15.36`

### Kustomize overlay

현재 최상위 `k8s/kustomization.yaml`은 로컬 `secret.yaml`과 예시 Ingress까지 직접 묶고 있어 Secret과 Ingress가 필요 없는 overlay가 그대로 재사용하기 어렵다. 구현 시 비밀이 아닌 공통 리소스를 `k8s/base/` Kustomization으로 분리한다. 기존 최상위 `k8s/kustomization.yaml`은 이 base와 기존 Namespace·로컬 Secret·Ingress를 조합해 현재 raw Kubernetes 사용법을 유지한다.

`k8s/overlays/orbstack-personal/`을 실제 장기 테스트 환경의 선언으로 커밋한다. overlay는 base의 앱, migrate initContainer, PostgreSQL, ConfigMap, Service 리소스를 재사용하되 다음 차이를 적용한다.

- namespace를 `toard-personal`로 고정한다.
- base의 예시 Ingress는 포함하지 않는다.
- base의 예시 Secret 파일은 포함하지 않는다.
- `TOARD_PUBLIC_URL`을 개인 도메인으로 덮어쓴다.
- 앱 replica와 rolling update 정책을 고정한다.
- app과 migrate initContainer 이미지 태그를 동일한 릴리스 버전으로 고정한다.

Secret은 배포 직전에 비대화형 생성 명령으로 클러스터에 직접 넣되 값을 stdout이나 채팅에 출력하지 않는다. overlay가 참조하는 Secret 이름과 key 계약만 Git에 기록한다. Kustomize apply는 이 out-of-band Secret을 생성하거나 제거하지 않는다.

Cloudflare의 클러스터 공유 workload는 toard overlay와 별도 Kustomization으로 관리한다. `k8s/overlays/orbstack-cloudflare/`에는 `cloudflare-tunnel` Namespace와 `cloudflared` Deployment의 비밀이 아닌 선언을 저장하고 Tunnel token Secret은 out-of-band로 생성한다. `cloudflared` image도 `latest` 대신 구현 시 검증한 immutable version 또는 digest로 고정한다.

## 버전과 업데이트 정책

Kubernetes 서버 이미지 태그는 `0.15.36`으로 고정한다. GitHub 릴리스 tag `v0.15.36`과 달리 GHCR의 현재 semver tag에는 `v`가 붙지 않는다. Compose updater는 Docker Compose 설치만 대상으로 하며 Kubernetes Deployment의 image를 갱신하지 않는다. 로컬 `toard-shim` updater는 GitHub 최신 shim을 갱신하는 별도 기능이고 Kubernetes 서버 버전에는 영향을 주지 않는다.

따라서 서버 업데이트는 다음 절차로 수행한다.

1. 새 릴리스의 GitHub Actions와 GHCR image 게시 성공을 확인한다.
2. overlay의 app과 migrate initContainer 태그를 같은 버전으로 변경한다.
3. Kustomize를 적용한다.
4. 각 app pod의 migrate initContainer 성공과 app rollout 완료를 확인한다.
5. 외부 health와 ready endpoint를 검증한다.

버전 고정은 재현성과 rollback 기준을 제공한다. `latest`나 mutable tag는 사용하지 않는다.

## 릴리스 흐름

`v0.15.36`은 이 overlay와 관련 문서가 main에 병합된 commit을 가리켜야 한다. 현재 main commit에 먼저 tag를 붙이지 않는다.

1. 설계 승인 후 구현 계획을 작성한다.
2. overlay와 배포 문서를 구현하고 테스트한다.
3. 변경을 main에 병합한다.
4. main의 정확한 commit에 annotated tag `v0.15.36`을 생성해 push한다.
5. shim release workflow와 Docker publish workflow가 모두 성공할 때까지 기다린다.
6. GitHub Release의 shim 설치 스크립트, checksum, 각 플랫폼 artifact를 확인한다.
7. GHCR의 app과 migrator `0.15.36` 이미지를 확인한다. Git tag는 `v0.15.36`이지만 현재 Docker workflow의 semver image tag에는 `v`가 붙지 않는다.
8. 모든 산출물이 준비된 뒤에만 OrbStack 배포를 시작한다.

실패한 workflow가 하나라도 있으면 개인 서버 설치나 기존 Mac의 shim installer 실행으로 진행하지 않는다. tag는 수정하거나 재사용하지 않고 원인을 고친 다음 새 patch version을 사용한다.

## 보안과 초기 관리자 생성

다음 값은 무작위로 생성해 Kubernetes Secret에만 저장한다.

- `AUTH_SECRET`
- `POSTGRES_PASSWORD`
- `CRON_SECRET`
- Cloudflare remotely-managed Tunnel token

Secret 값과 관리자 비밀번호는 Git, shell history, command output, 채팅에 남기지 않는다.

초기 관리자 생성 순서는 다음과 같다.

1. toard와 PostgreSQL을 먼저 배포하되 Cloudflare published route는 만들지 않는다.
2. 로컬에서 app Service로 `kubectl port-forward`를 연다.
3. 사용자가 브라우저의 `/setup`에서 관리자 이메일과 비밀번호를 직접 입력한다.
4. setup이 잠겼고 로그인이 되는지 확인한다.
5. 그 뒤에만 Cloudflare published route를 만든다.

이 방식은 bootstrap 관리자 자격 증명을 manifest나 채팅으로 전달하지 않으면서 공개 setup 노출도 방지한다.

## Cloudflare Tunnel

Cloudflare에 remotely-managed tunnel `macmini-k8s`를 생성한다. `cloudflare-tunnel` namespace의 Deployment가 Tunnel token Secret을 참조하며 replica는 2개로 둔다.

published application route는 다음 계약을 사용한다.

```text
hostname: toard.devy1540.com
service:  http://toard-app.toard-personal.svc.cluster.local:80
```

같은 `macmini-k8s` tunnel에 향후 다른 Kubernetes 앱의 hostname과 service route를 추가할 수 있다. tunnel 삭제는 클러스터의 모든 route에 영향을 주므로 toard 제거 절차에는 포함하지 않는다.

## 실행 순서

1. Kustomize overlay와 운영 문서를 구현하고 main에 병합한다.
2. `v0.15.36`을 릴리스하고 shim과 Docker image workflow 성공을 확인한다.
3. OrbStack Kubernetes를 활성화한다.
4. `orbstack` context, node Ready, 기본 StorageClass를 확인한다.
5. `toard-personal` namespace와 Secret을 생성한다.
6. Kustomize overlay를 적용한다.
7. app pod의 migrate initContainer, app, PostgreSQL, PVC, Service 상태를 확인한다.
8. port-forward로 `/setup`과 로그인을 완료한다.
9. `macmini-k8s` tunnel과 token Secret, `cloudflared` Deployment를 만든다.
10. `toard.devy1540.com` published route를 생성한다.
11. 외부 health, ready, login을 검증한다.
12. 개인 서버 UI에서 제공하는 `install.sh`를 기존 회사 shim이 설치된 Mac에서 실행한다.
13. shim 버전, capability, target 목록, doctor, 수동 collect를 확인한다.
14. 회사와 개인 서버에 모두 데이터가 들어오는지 확인한다.
15. 이후 Mac과 OrbStack 재시작 후 자동 복구와 데이터 보존을 재검증한다.

## 검증 기준

### Kubernetes

```sh
kubectl -n toard-personal get pods,pvc,svc
kubectl -n toard-personal rollout status deployment/toard-app
```

- PostgreSQL과 app pod의 migrate initContainer, app container가 기대 상태에 도달한다.
- app replica 2개가 Ready다.
- PostgreSQL PVC가 Bound다.
- Service가 ClusterIP이며 외부 포트를 직접 열지 않는다.

### 외부 서비스

```sh
curl -fsS https://toard.devy1540.com/api/health
curl -fsS https://toard.devy1540.com/api/ready
```

- 두 endpoint 모두 HTTP 200을 반환한다.
- 로그인 화면과 관리자 로그인이 정상 동작한다.
- tunnel replica 하나가 재시작돼도 외부 접근이 회복된다.

### shim 멀티 target

```sh
toard-shim version
toard-shim capabilities
toard-shim targets list
toard-shim doctor
toard-shim collect
```

- `toard-shim version` 출력은 `toard-shim 0.15.36`이다.
- capability에 `multi-target-v1`이 포함된다.
- 회사 endpoint와 개인 endpoint가 모두 표시된다.
- 회사 target의 기존 cursor가 보존된다.
- 한 번의 collect로 두 서버가 독립적으로 성공 또는 실패를 기록한다.
- 한 서버를 일시적으로 사용할 수 없어도 다른 서버의 cursor와 전송은 진행된다.
- 실패한 서버가 복구되면 해당 서버의 미전송분만 이어서 전송한다.

### 장기 운영

- Mac 재부팅 뒤 OrbStack Kubernetes workload가 복구된다.
- PostgreSQL pod 재생성 뒤 기존 데이터가 남아 있다.
- 다음 patch release로 image tag를 올렸을 때 migrate initContainer와 rolling update가 성공한다.
- toard route 제거가 `macmini-k8s`의 다른 route나 기존 호스트 `macmini` tunnel에 영향을 주지 않는다.

## 실패 처리와 정리 경계

- 장애 시 namespace나 PVC를 자동 삭제하지 않는다. 먼저 pod 상태, events, migrate initContainer와 app 로그를 보존한다.
- 개인 서버의 health와 ready가 통과하기 전에는 개인 서버의 shim installer를 실행하지 않는다.
- 회사 서버가 신버전으로 업데이트되기 전에는 회사 서버의 구버전 installer나 uninstaller를 다시 실행하지 않는다.
- 개인 target을 제거할 때 회사 target이 남아 있으면 공용 shim과 daemon은 유지한다.
- 개인 toard 배포를 제거할 때 PostgreSQL PVC 삭제는 별도 파괴 작업으로 취급하고 사용자 확인 없이 수행하지 않는다.
- `toard.devy1540.com`을 내릴 때는 published route만 제거하고 공유 tunnel `macmini-k8s`는 유지한다.

## 근거가 되는 저장소와 공식 문서

- Kubernetes/Kustomize 리소스: `k8s/`
- Helm chart: `helm/toard/`
- 배포 문서와 Compose updater 범위: `docs/DEPLOY.md`
- shim updater 설명: `shim/README.md`
- shim 릴리스 workflow: `.github/workflows/shim-release.yml`
- Docker image workflow: `.github/workflows/docker-publish.yml`
- Cloudflare Kubernetes 배포: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/deployment-guides/kubernetes/>
- Cloudflare Tunnel 개요: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/>
- DNS route: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/dns/>
- Tunnel replica: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/deploy-replicas/>
