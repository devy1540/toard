# toard 신뢰성 및 제품 개선 실행 계획

기준: 2026-09-06, `03deba8` / 0.0.2. 사용자가 분석에서 제안한 개발 순서 전체의 구현을 요청했다.
작업 브랜치: `codex/toard-trust-roadmap`. 운영 DB나 사용자 원본 로그를 사용하지 않고 합성 데이터로 검증한다.

## 1. 가입, 비용, 첫 진입

- [x] 가입 기본값을 초대 전용으로 변경. 이메일 문자열만으로 자체 가입 불가. 기존 계정 로그인과 최초 관리자 설치 보존.
- [x] 공개 가입은 검증된 OAuth identity로 제한. OAuth 초대 수락을 원자 처리하고 팀·권한은 관리자 초대에서 결정.
- [x] 임의 팀 셀프 가입을 제거하고 승인된 소속만 적용.
- [x] 요청 컨텍스트 기준 모델별 과금 규칙, 캐시, 출력 단가를 공식 사례로 검증.
- [x] API 요율 환산액, 모델 추정, 미확정 비용을 구분. 계산 규칙 버전과 가격 근거 보존 및 기존 데이터 전환 검증.
- [x] 랜딩 설명 및 데모 진입 코드 복구. 합성 데이터만 사용하는 실제 제품 미리보기와 문서 정리.

## 2. 수집 신뢰성과 통제

- [x] 연결 성공과 첫 이벤트 영속 저장 완료를 분리해 표시.
- [ ] 공급자별 마지막 성공·파싱 실패·미지원·미사용 상태를 표시.
- [ ] 서버별 공급자·프로젝트 포함/제외 설정과 전송 항목 미리보기. 원본 경로는 로컬에 유지.
- [x] 사용량 이벤트의 크기 제한 영속 전송 큐와 ACK 이후 정리. 장애·재시도·중복·원본 삭제 시나리오 검증.
- [x] 실제 브라우저에서 가입 경계, 로그인, 권한, 수집 완료, 부분 비용 표시를 검증하는 회귀 테스트와 CI.

## 3. 판단에 도움이 되는 분석과 보고

- [ ] 비용 변화의 사용량·모델 구성·가격·캐시 원인을 합계와 일치하게 분해하고 불확실성을 표시.
- [ ] 주간 보고서와 CSV: 변화·원인·수집 문제·계산 근거를 권한 범위 안에서 제공.
- [ ] 파일·운영 문서·업그레이드 문서와 관련 테스트 갱신.
- [ ] 외부 팀 3~5곳 파일럿에 사용할 설치·피드백 안내와 성공 지표 준비.
- [ ] 실제 외부 팀의 반복 사용 검증. 외부 사용자와 배포 접근이 필요하며 임의 연락·결과 생성 금지.

## 완료 증거

각 항목은 구현 파일, 직접 실행 결과, 필요한 통합/브라우저 검증을 확인한 뒤에만 완료 표시한다.
테스트 통과만으로 실제 외부 파일럿이나 공개 배포 완료를 주장하지 않는다.

## 진행 기록

- 초기 상태 재확인: 작업 트리 깨끗함. 분석 단계의 TS 단위/계약 테스트 1,247 통과, 3 skip; 이번 변경 후 재검증 필요.

- 가입 경계 구현: `registration.ts`, signup/초대/OAuth/팀 온보딩 경로, Compose·K8s·Helm 설정 및 문서.
- 검증: PostgreSQL 격리 integration 6/6 통과(동시 password/OAuth 수락, 만료, identity mismatch, 초대 권한 적용); 설치된 Auth.js callback의 검증 metadata 보존 및 bootstrap linking 테스트 통과; typecheck 통과.
- 전체 TS 단위/계약 검사에서 폐기된 팀 self-selection을 요구하던 source contract 1건 실패. 해당 계약을 admin-only 배정으로 갱신 후 관련 13건 통과. 브라우저 검증은 2단계에 남아 있음.

- 1단계 구현: `cost-v2` 계산, 128/200/256/272/512k 입력 컨텍스트 단가, 추정 상태, pricing_details 영속화, 원본/outbox 계산 버전 및 힌트 보존, `/costs` 개인 근거 조회, 임시 seed 가격 제거. 이전 금액은 cost-v1로 보존하며 자동으로 전부 재계산했다고 주장하지 않는다.
- 마이그레이션: 1700000054. `LATEST_SCHEMA_VERSION`도 54로 갱신. 향후 새로운 마이그레이션마다 함께 갱신할 것.
- 1단계 전체 회귀: `pnpm test` 1,332 pass / 3 skip / 0 fail, 로그 `/tmp/toard-phase-one-suite.60Fvwm` (후속 fast-rate 방어 전). 그 뒤 가격 22건, 관련 app 서비스 69건과 typecheck 통과.
- 실제 PostgreSQL/ClickHouse에서 비용·추정 상태·계산 버전·1h/fast 힌트·사용자 범위·cursor·조직 snapshot 검증 통과. 각 테스트는 자체 loopback tmpfs 컨테이너를 생성/종료한다.
- standalone production build 및 브라우저 6개 시나리오 통과. 실제 수집 HTTP, $0.90 ledger, 위조 userId, 초대 재사용, admin 접근, 모바일 overflow, 정적 미리보기 image load를 확인했다. 새 disclosure/surface UI로 캡처한 공개 샘플 이미지 3개를 시각 확인했다.
- Rust `cargo fmt --check` 및 `usage_event::tests` 5건 통과. 전체 Rust 테스트는 아직 실행하지 않았다.
- Next standalone와 외부 pnpm global virtual store가 비호환이라 프로젝트 기본을 local virtual store로 통일했다. 잘못 생성된 이전 빌드 산출물은 `/var/folders/yz/1vt_3thn5jg4g8vnnqdjpd0w0000gn/T/toard-build-layout-qtda2yk4`로 보존했다.
- `/site/demo/index.html`은 실제 앱의 합성 데이터 스크린샷을 보여주는 정적 미리보기이다. 공개 서버에는 아직 배포하지 않았으며 기존 공개 URL의 수정 완료를 주장하지 않는다.

## 남은 배포 및 외부 검증

- [ ] 전체 코드 변경을 검증한 후 배포할 구체적 결과를 제시하고 공개 사이트 반영 범위를 확정한다. 반영 후 demo HTTP 200을 실제 확인한다.
- [ ] 2단계 수집 완료/건강도/범위/영속 큐 구현 및 실제 브라우저·Rust·DB 회귀 확장.
- [ ] 3단계 원인 분해/주간 보고서/CSV/파일럿 준비 및 실제 외부 팀 검증. 연락은 명시적 승인 없이 하지 않는다.

### 2단계 진행 중 (아직 미완료)

- 신규 마이그레이션 1700000055: 토큰별 첫/최근 사용량 저장 확인과 provider별 collection_provider_health. LATEST_SCHEMA_VERSION=55.
- PostgreSQL 사용량 및 ClickHouse outbox 저장 트랜잭션 안에서 `record_ingest_usage_receipt`를 호출한다. 인증/빈 요청/클라이언트 상태 주장/다른 사용자 dedup 충돌은 저장 완료 신호를 만들지 않는다. 관련 DB 통합 7건 통과.
- 온보딩은 연결과 첫 저장을 분리하고, 연결됐지만 데이터 없는 경우 중립 대기 상태를 보여준다. 해당 실제 브라우저 시나리오 통과.
- 메타데이터만 받는 `/api/v1/collection-status`, 개인 설정의 수집 상태 표를 추가했다. counts의 null과 0을 구분하고, raw/path/error-text 필드를 거부한다.
- `/events`는 confirmed(인증 사용자 소유의 실제 저장 키), expired, ignored를 구분한다. collection-status handshake는 인증 userId와 eventsReceiptVersion=1을 반환한다. 이 마지막 ACK 확장 후 Node 전체 회귀는 아직 재실행 전이다.
- Rust rusqlite 0.40.2 bundled/fallible_uint로 per-target usage-queue.sqlite3를 구현 중이다. FULL WAL, 64MiB payload 한도, destination/owner/token fingerprint binding, DB incarnation, sequence 기반 ACK, Windows 제거 호환을 위한 operation별 connection, identity+read snapshot을 사용한다. Queue 단위 6건 통과.
- 수집 경로에 큐를 연결했다. 소스 커서는 전체 관측분이 영속 큐에 들어간 뒤에만 전진하고, 서버 확인 뒤 큐에서 제거한다. provider별 drain 및 적응형 enqueue chunk로 큰 backfill과 특정 provider 실패를 처리한다. 삭제 보정은 관련 usage 전달이 끝나기 전에 실행하지 않는다.
- 현재 Rust collector 통합 검증을 진행 중. 원본 삭제 후 outage 재전송, partial ACK 보존, 크기 제한, target 교체/제거 회귀를 실제 fixture로 증명해야 한다.
- 아직 필요한 작업: project/provider scope 선택 및 모든 outgoing streams에 적용, 로컬 scope preview/confirmation UI, 실제 parser 오류 수집(현재 parseErrors는 null), queue/health doctor 표출, CLI/cross-platform 검증, 3단계 전체.
- 현재 QueueInput.project_id는 준비된 필드이고 None으로만 들어간다. 프로젝트 필터가 구현됐다고 주장하지 않는다.

### 수집 저장 확인·보관함 검증 완료 (2026-09-06)

- `/events` ACK 확장 후 전체 `pnpm test`: **1,343 pass / 3 skip / 0 fail**, `/tmp/toard-phase-two-suite.log`. 마지막 UI 추가 후 관련 Node 28건과 typecheck도 통과했다.
- 새 앱 production build + 실제 브라우저 **7개 시나리오 통과**, `/tmp/toard-phase-two-browser.log`. 가입·초대·권한·부분 비용·미리보기와 연결/첫 저장 분리를 검증했다.
- 실제 CLI/curl/loopback HTTP **2건 통과**: 장애 → 프로세스 종료 → 원본 삭제 → 서버 저장 후 ACK 유실 → 중복 없는 재전송; 손상된 줄 오류 유지 → 수정 후 정상화. `shim/rust/tests/usage_queue_cli.rs`.
- 5개 JSON 어댑터의 실제 parse/read 오류를 수집한다. Gemini/Qwen도 usage/content를 같은 파일 snapshot에서 처리한다. 오류 파일의 cursor는 전진시키지 않으며 정상 레코드 전송은 가능하다. Cursor legacy text의 파싱 오류 수는 아직 null이다.
- 파싱 snapshot과 이후 변경된 file stamp를 혼합하던 경계를 수정했다. 읽기 직후 추가된 suffix를 다음 회차에서 읽는 회귀 테스트가 통과했다.
- doctor와 로컬 연결 UI에 보관함 대기 건수·bytes·읽기 실패를 추가했다. `docs/collection-reliability.md`에 ACK, 계정 교체, 한도, 본문·도구 활동의 원본 의존 및 업그레이드 순서를 명시했다.
- Rust 전체 검사 중 doctor의 이전 설명을 요구하는 테스트 1건이 실패했고 새 계약으로 수정했다. 라이브러리 단위 260건·background helper 2건·doctor CLI 2건은 통과했으며 multi-target CLI 6건과 usage queue CLI 2건도 수정 후 모두 통과했다. Clippy(-D warnings) 통과. Windows/Linux 실행은 CI에서 아직 확인하지 않았다.
- 남은 수집 범위: provider/project 정책, 로컬 미리보기와 승인 UI, 제한 정책을 usage/content/tools/inventory/대기열/health에 일관되게 적용. 원본 경로와 프로젝트 목록은 원격 서버에 보내지 않는다. 프로젝트를 식별하지 못한 기록은 제한 모드에서 전송하지 않는다.
- 남은 상태 관측: 디렉터리 열기 실패와 형식 미지원/의도적 일시정지 표시를 실제 수집 동작에 연결. 위 health 항목 전체는 아직 완료 표시하지 않는다.
