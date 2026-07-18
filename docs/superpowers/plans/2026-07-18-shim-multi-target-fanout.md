# Shim Multi-Target Fan-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 한 사용자 계정의 shim·daemon 하나가 기존 단일 설치를 안전하게 이전하고 임의 개수의 toard 서버로 usage·tool metadata·prompt/response를 target별 cursor와 실패 격리로 fan-out하게 만든다.

**Architecture:** ~/.toard/targets/<sha256(normalized-endpoint)>/를 유일한 target registry로 만들고 레거시 credentials/state를 최초 1회 원자적으로 import한다. collector는 adapter별 로컬 파일을 한 번 파싱한 뒤 target별 cursor로 pending suffix를 계산하고 성공한 target state만 commit한다. UI가 제공하는 install/uninstall script는 endpoint와 token을 환경변수로 새 CLI에 전달하며 마지막 target 제거만 전체 shim 정리로 승격한다.

**Tech Stack:** Rust 2021 shim, serde/serde_json/sha2, url endpoint parser, fs2 cross-platform file lock, TypeScript/Next.js dynamic script routes, POSIX shell, PowerShell, Node test runner, GitHub Actions Linux/macOS/Windows.

## Global Constraints

- shim 바이너리와 주기 수집 daemon은 사용자 계정당 하나만 유지한다.
- target 수는 회사·개인 두 개로 고정하지 않고 임의 개수를 허용한다.
- targets/가 유일한 정식 저장소이며 레거시 경로를 계속 mirror하지 않는다.
- 기존 endpoint, token, usage/tool/content cursor와 지원 probe 상태를 전진 마이그레이션한다.
- 한 target의 연결·인증·서버 오류는 다른 target의 전송과 cursor commit을 막지 않는다.
- usage는 새 target에 전체 백필하고 tool events와 content는 현재 정책대로 target 추가 시점부터 시작한다.
- 원본 세션 로그가 삭제된 뒤까지 보장하는 durable outbox는 만들지 않는다.
- KMS/E2EE 암호화 모델은 변경하지 않고 target registry와 delivery 경계만 제공한다.
- 기존 ingest endpoint와 payload wire 계약을 변경하지 않는다.
- token은 CLI 인자, 프로세스 목록, 목록·doctor 출력, 오류 상태에 노출하지 않는다.
- POSIX와 Windows installer/uninstaller는 같은 target upsert/remove 계약을 구현한다.
- 존재하지 않는 target 제거는 전체 shim 제거를 유발하지 않는다.
- 마지막 실제 target 제거만 daemon·shim·PATH·registry·migration backup 전체 정리로 승격한다.
- 프로덕션 DB를 직접 수정하지 않는다.

---

## File Structure

### 새 파일

- shim/rust/src/targets.rs: endpoint 정규화, target ID, registry lock, CRUD, 레거시 migration/import, target별 경로.
- shim/rust/src/delivery.rs: target별 최근 시도·성공·오류 상태와 redaction된 persistent status.
- shim/rust/src/collect/fanout.rs: 한 번 파싱한 file batch에서 target별 pending plan과 cursor update 계산.
- shim/rust/tests/multi_target_cli.rs: 실제 shim binary, fixture HOME, fake curl을 사용하는 CLI 통합 테스트.
- apps/web/lib/shell-installer.test.ts: POSIX installer의 capability/upsert/daemon/target doctor 순서 계약.
- apps/web/lib/shell-uninstaller.ts: endpoint-aware POSIX uninstaller 생성.
- apps/web/lib/shell-uninstaller.test.ts: target 제거와 last-target 전체 정리 조건.

### 주요 수정 파일

- shim/rust/Cargo.toml, Cargo.lock: url과 fs2 의존성.
- shim/rust/src/main.rs, fsx.rs, credentials.rs: registry 진입점과 file/env credentials 분리.
- shim/rust/src/collect/cursor.rs, inventory.rs, post.rs, mod.rs: target state와 parse-once delivery.
- shim/rust/src/cli.rs, e2ee_setup.rs: target management, doctor, single-target legacy command guard.
- apps/web/lib/shell-installer.ts, powershell-installer.ts: target-aware scripts.
- apps/web/app/uninstall.sh/route.ts, uninstall.ps1/route.ts: dynamic endpoint-aware routes.
- .github/scripts/shim-e2e-server.mjs, test-shim-installer-unix.sh, test-shim-installer-windows.ps1: 실제 lifecycle E2E.
- .github/workflows/shim-ci.yml: new paths, PowerShell signatures, cross-platform gates.
- README.md, shim/README.md: UI-first multi-target 운영 문서.

---

### Task 1: Target Registry와 레거시 마이그레이션

**Files:**
- Create: shim/rust/src/targets.rs
- Modify: shim/rust/src/main.rs
- Modify: shim/rust/src/fsx.rs
- Modify: shim/rust/src/credentials.rs
- Modify: shim/rust/Cargo.toml
- Modify: shim/rust/Cargo.lock

**Interfaces:**
- Consumes: credentials::Credentials, credentials::parse, fsx::write_atomic.
- Produces:
  - TargetStore::from_home() -> Result<TargetStore, TargetError>
  - TargetStore::load_or_migrate() -> Result<Vec<Target>, TargetError>
  - TargetStore::upsert(credentials: Credentials) -> Result<Target, TargetError>
  - TargetStore::remove(endpoint: &str) -> Result<RemoveResult, TargetError>
  - normalize_endpoint(&str) -> Result<String, TargetError>
  - target_id(&str) -> String
  - Target { id, endpoint, credentials_path, state_dir, credentials }
  - RemoveResult { removed, remaining }

- [ ] **Step 1: endpoint 정규화와 target ID 실패 테스트 작성**

targets.rs test module에 다음 계약을 작성한다.

~~~rust
#[test]
fn normalizes_equivalent_endpoints_to_one_target_id() {
    let a = normalize_endpoint("HTTPS://Toard.Example:443/api/").unwrap();
    let b = normalize_endpoint("https://toard.example/api").unwrap();
    assert_eq!(a, "https://toard.example/api");
    assert_eq!(a, b);
    assert_eq!(target_id(&a), target_id(&b));
}

#[test]
fn rejects_ambiguous_endpoint_components() {
    for value in [
        "https://user@toard.example/api",
        "https://toard.example/api?team=1",
        "https://toard.example/api#fragment",
        "not-a-url",
    ] {
        assert!(normalize_endpoint(value).is_err(), "accepted {value}");
    }
}
~~~

- [ ] **Step 2: 테스트가 예상대로 실패하는지 실행**

Run: cargo test --manifest-path shim/rust/Cargo.toml targets::tests::normalizes_equivalent_endpoints_to_one_target_id

Expected: FAIL because targets module and normalization functions do not exist.

- [ ] **Step 3: dependencies와 기본 target types 구현**

Cargo.toml에 url = "2", fs2 = "0.4"를 추가한다. targets.rs public boundary는 다음과 같다.

~~~rust
#[derive(Debug, Clone)]
pub struct Target {
    pub id: String,
    pub endpoint: String,
    pub credentials_path: PathBuf,
    pub state_dir: PathBuf,
    pub credentials: Credentials,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoveResult {
    pub removed: bool,
    pub remaining: usize,
}

pub struct TargetStore {
    root: PathBuf,
}

impl TargetStore {
    pub fn from_root(root: PathBuf) -> Self { Self { root } }
    pub fn from_home() -> Result<Self, TargetError> {
        let home = crate::fsx::home_dir().ok_or(TargetError::MissingHome)?;
        Ok(Self::from_root(home.join(".toard")))
    }
    pub fn targets_dir(&self) -> PathBuf { self.root.join("targets") }
}
~~~

Url parser로 scheme/host lowercasing, default port와 trailing slash 제거, userinfo/query/fragment 거부를 구현한다. 정규화 문자열의 SHA-256 전체 hex를 ID로 사용한다.

- [ ] **Step 4: credentials file parse와 installer env 입력 분리 테스트 작성**

~~~rust
#[test]
fn installer_input_does_not_override_file_parse() {
    let file = parse("agent_key=company\nendpoint=https://company.example/api\n");
    let personal = from_installer_input(InstallerCredentialsInput {
        token: "personal".into(),
        endpoint: "https://personal.example/api".into(),
        collect_content: Some("true".into()),
        collect_tools: Some("false".into()),
        collect_content_since: None,
    }).unwrap();
    assert_eq!(file.endpoint.as_deref(), Some("https://company.example/api"));
    assert_eq!(personal.endpoint.as_deref(), Some("https://personal.example/api"));
}
~~~

- [ ] **Step 5: credentials serialize와 installer input 구현**

Credentials에 Clone을 추가하고 serialize(&Credentials) -> String, InstallerCredentialsInput, from_installer_input을 구현한다. token·endpoint가 없거나 newline을 포함하면 오류다. 기존 E2EE metadata는 round-trip한다. 레거시 file parse에는 env override를 적용하지 않는다.

- [ ] **Step 6: upsert 멱등성과 cursor 보존 실패 테스트 작성**

~~~rust
#[test]
fn upsert_updates_one_target_without_resetting_state() {
    let temp = TempRoot::new();
    let store = TargetStore::from_root(temp.path().join(".toard"));
    let first = store.upsert(credentials("company", "https://company.example/api")).unwrap();
    fs::create_dir_all(first.state_dir.join("cursors")).unwrap();
    fs::write(first.state_dir.join("cursors/codex.json"), "cursor-v1").unwrap();

    let updated = store
        .upsert(credentials("company-new", "https://company.example/api/"))
        .unwrap();
    let personal = store
        .upsert(credentials("personal", "https://personal.example/api"))
        .unwrap();

    assert_eq!(first.id, updated.id);
    assert_ne!(updated.id, personal.id);
    assert_eq!(
        fs::read_to_string(updated.state_dir.join("cursors/codex.json")).unwrap(),
        "cursor-v1"
    );
    assert_eq!(store.load_or_migrate().unwrap().len(), 2);
}
~~~

- [ ] **Step 7: atomic upsert/remove와 registry lock 구현**

fs2::FileExt::lock_exclusive을 사용하는 registry.lock을 추가한다. credentials는 temp + rename으로 저장하고 Unix 0600을 적용한다. remove는 exact target만 삭제하고 없는 target은 removed=false를 반환한다.

동일 단계의 테스트로 다음을 직접 증명한다.

- `~/.toard`, `targets`, 각 target과 `state` 디렉터리는 Unix `0700`, credentials와 JSON state는 `0600`이다.
- `load_or_migrate`는 중복 endpoint를 제거하고 target ID 순서로 안정적으로 반환한다.
- 없는 endpoint 제거는 `removed=false, remaining=N`, 마지막 실제 endpoint 제거는 `removed=true, remaining=0`이다.

- [ ] **Step 8: 레거시 migration 실패 테스트 작성**

레거시 credentials, state/cursors, content-since, tool-since, tool-inventory.json, unsupported-* fixture를 만든다. 모두 target state로 이동되는지, 기존 target cursor를 덮지 않는지, 잘못된 credentials에서는 새 target이 생기지 않는지 검증한다.

~~~rust
#[test]
fn migrates_legacy_target_state_before_loading_registry() {
    let temp = TempRoot::new();
    let root = temp.path().join(".toard");
    write_legacy_fixture(&root, "https://company.example/api");
    let store = TargetStore::from_root(root.clone());

    let targets = store.load_or_migrate().unwrap();
    assert_eq!(targets.len(), 1);
    assert!(targets[0].state_dir.join("cursors/codex.json").is_file());
    assert!(targets[0].state_dir.join("tool-inventory.json").is_file());
    assert!(root.join("legacy-backup").is_dir());
    assert!(!root.join("credentials").exists());
}
~~~

- [ ] **Step 9: migration과 fallback 구현**

잠금 안에서 .migrate-<pid> copy → reread validation → target rename → legacy-backup 이동을 수행한다. migration 실패 시 valid legacy credentials와 state를 in-memory fallback target으로 노출하지만 upsert는 실패해 개인 target 추가 전에 중단한다. 나중에 구버전 installer가 만든 새 레거시 credentials도 같은 단방향 importer로 처리한다.

- [ ] **Step 10: Task 1 검증과 커밋**

Run:

~~~bash
cargo fmt --manifest-path shim/rust/Cargo.toml -- --check
cargo test --manifest-path shim/rust/Cargo.toml targets::
cargo test --manifest-path shim/rust/Cargo.toml credentials::
cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings
git diff --check
~~~

Expected: all PASS. Collector와 installer behavior는 아직 바뀌지 않았는지 diff를 검토한다.

Commit:

~~~bash
git add shim/rust/Cargo.toml shim/rust/Cargo.lock shim/rust/src/main.rs shim/rust/src/fsx.rs shim/rust/src/credentials.rs shim/rust/src/targets.rs
git commit -m "feat(shim): add multi-target registry migration"
~~~

---

### Task 2: Target별 상태와 HTTP Transport 경계

**Files:**
- Create: shim/rust/src/delivery.rs
- Modify: shim/rust/src/main.rs
- Modify: shim/rust/src/collect/cursor.rs
- Modify: shim/rust/src/collect/inventory.rs
- Modify: shim/rust/src/collect/post.rs

**Interfaces:**
- Consumes: Target.state_dir와 global fsx::state_dir().
- Produces:
  - cursor::load(state_dir: &Path, adapter: &str) -> Cursor
  - cursor::save(state_dir: &Path, adapter: &str, cursor: &Cursor)
  - post::Transport trait와 post::CurlTransport
  - target state를 받는 unsupported probe API
  - global scan cache + target delivery fingerprint inventory API
  - delivery::record_attempt/success/failure

- [ ] **Step 1: cursor target 격리 실패 테스트 작성**

~~~rust
#[test]
fn cursor_paths_are_isolated_by_target_state_root() {
    let temp = TempRoot::new();
    let company = temp.path().join("company");
    let personal = temp.path().join("personal");
    let mut cursor = Cursor::default();
    cursor.reconciliation_version = 1;
    save(&company, "codex", &cursor);
    assert_eq!(load(&company, "codex").reconciliation_version, 1);
    assert_eq!(load(&personal, "codex").reconciliation_version, 0);
}
~~~

- [ ] **Step 2: cursor API를 explicit state root로 변경**

~~~rust
fn cursor_path(state_dir: &Path, adapter: &str) -> PathBuf {
    state_dir.join("cursors").join(format!("{adapter}.json"))
}
~~~

global fsx::state_dir() 사용을 제거한다.

- [ ] **Step 3: unsupported probe target 격리 테스트와 구현**

회사 state에 unsupported-tool-events를 기록해도 개인 target probe는 due여야 한다. unsupported_probe_due와 mark_unsupported가 target state root를 인자로 받게 바꾼다.

- [ ] **Step 4: inventory scan/delivery 분리 테스트 작성**

~~~rust
#[test]
fn inventory_delivery_commit_is_per_target() {
    let snapshot = InventorySnapshot::fixture("fingerprint-1");
    let company = TempRoot::new();
    let personal = TempRoot::new();
    assert!(needs_delivery(company.path(), &snapshot));
    assert!(needs_delivery(personal.path(), &snapshot));
    commit_delivery(company.path(), &snapshot).unwrap();
    assert!(!needs_delivery(company.path(), &snapshot));
    assert!(needs_delivery(personal.path(), &snapshot));
}
~~~

- [ ] **Step 5: inventory API 구현**

global tool-inventory-scan.json에는 watched stamps, current fingerprint, serialized body를 저장한다. target tool-inventory.json에는 마지막 성공 fingerprint만 저장한다. 새 target은 cache의 current snapshot을 즉시 받을 수 있어야 한다.

- [ ] **Step 6: injectable HTTP transport 실패 테스트 작성**

~~~rust
pub trait Transport {
    fn post_events(&self, endpoint: &str, token: &str, body: &str) -> Result<PostResult, String>;
    fn post_prompts(&self, endpoint: &str, token: &str, body: &str) -> Result<Option<PostResult>, String>;
    fn post_tool_events(&self, endpoint: &str, token: &str, body: &str) -> EndpointResult;
    fn post_usage_reconciliation(&self, endpoint: &str, token: &str, body: &str) -> EndpointResult;
    fn put_tool_inventory(&self, endpoint: &str, token: &str, body: &str) -> EndpointResult;
}

pub struct CurlTransport;
~~~

- [ ] **Step 7: CurlTransport와 timeout 구현**

기존 0600 body temp file을 유지하고 curl에 --connect-timeout 5와 --max-time 60을 함께 준다. Authorization, response body, prompt body는 persistent error에 전달하지 않는다.

- [ ] **Step 8: delivery status test와 구현**

~~~rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryKind {
    Success,
    Unreachable,
    Unauthorized,
    Unsupported,
    Disabled,
    ServerError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryStatus {
    pub last_attempt_at: String,
    pub last_success_at: Option<String>,
    pub result: DeliveryKind,
    pub error_fingerprint: Option<String>,
    pub last_logged_at: Option<String>,
}
~~~

동일 fingerprint의 daemon 오류는 target별 한 시간에 한 번만 출력하도록 순수 함수로 테스트한다.

- [ ] **Step 9: Task 2 검증과 커밋**

Run:

~~~bash
cargo fmt --manifest-path shim/rust/Cargo.toml -- --check
cargo test --manifest-path shim/rust/Cargo.toml cursor::
cargo test --manifest-path shim/rust/Cargo.toml inventory::
cargo test --manifest-path shim/rust/Cargo.toml post::
cargo test --manifest-path shim/rust/Cargo.toml delivery::
cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings
git diff --check
~~~

Expected: all PASS. cursor/inventory/unsupported delivery state에 global path가 남지 않았는지 rg로 확인한다.

Commit:

~~~bash
git add shim/rust/src/main.rs shim/rust/src/delivery.rs shim/rust/src/collect/cursor.rs shim/rust/src/collect/inventory.rs shim/rust/src/collect/post.rs
git commit -m "refactor(shim): isolate delivery state per target"
~~~

---

### Task 3: Parse-Once Fan-Out Planner와 Collector

**Files:**
- Create: shim/rust/src/collect/fanout.rs
- Modify: shim/rust/src/collect/mod.rs
- Modify: shim/rust/src/collect/post.rs

**Interfaces:**
- Consumes: Target, target-scoped Cursor, ParsedLog, RawUsage, RawContent, RawToolActivity, Transport.
- Produces:
  - ParsedFileBatch
  - TargetCursorPlan<T>
  - plan_usage, plan_tools, plan_content, commit_cursor_plan
  - collect::run_with(store, transport, adapters, only, dry_run, quiet)

- [ ] **Step 1: 독립 pending suffix 실패 테스트 작성**

~~~rust
#[test]
fn one_parsed_prefix_produces_independent_target_suffixes() {
    let records = vec![event("a"), event("b"), event("c")];
    let company = cursor_after(&records[..1]);
    let personal = Cursor::default();
    let company_plan = plan_usage("codex", &company, &records);
    let personal_plan = plan_usage("codex", &personal, &records);
    assert_eq!(keys(&company_plan.pending), vec!["b", "c"]);
    assert_eq!(keys(&personal_plan.pending), vec!["a", "b", "c"]);
}
~~~

- [ ] **Step 2: planner types와 usage plan 구현**

~~~rust
pub struct ParsedFileBatch {
    pub path: String,
    pub stamp: FileStamp,
    pub parsed: ParsedLog,
}

pub struct TargetCursorPlan<T> {
    pub pending: Vec<T>,
    pub updates: Vec<(String, FileState)>,
    pub alive_paths: HashSet<String>,
}
~~~

기존 resume_index, keys_hash, dedup helpers를 planner가 사용하게 이동한다. plan 단계는 disk write를 하지 않는다.

- [ ] **Step 3: content since와 tool baseline 실패 테스트 작성**

회사 content cursor는 일부 전송, 개인 target은 추가 시각 이후 한 건만 허용하는 fixture를 만든다. tool 첫 실행은 현재 stamp를 baseline으로 저장하고 pending이 비어야 한다.

- [ ] **Step 4: plan_tools와 plan_content 구현**

content는 target별 since filter 후 dedup prefix를 적용한다. tool은 collect_tools, tool-since, first-run baseline을 target별 적용한다.

- [ ] **Step 5: parse-once privacy 테스트 작성**

~~~rust
#[test]
fn parses_each_changed_file_once_for_all_targets() {
    let adapter = CountingAdapter::with_one_file();
    let targets = vec![usage_target("company"), content_target("personal")];
    let batches = parse_changed_once(&adapter, &targets, false);
    assert_eq!(adapter.parse_calls(), 1);
    assert_eq!(batches.len(), 1);
    assert!(!batches[0].parsed.content.is_empty());
}
~~~

content target이 없을 때 adapter가 include_content=false로 정확히 한 번 호출되는 test도 추가한다.

- [ ] **Step 6: parse_changed_once 구현**

모든 target cursor stamp를 먼저 읽어 하나라도 변경된 파일만 union에 넣는다. include_content는 활성 content target 존재, include_tools는 baseline 이후 tool target 존재로 계산한다. content opt-in target이 없으면 원문 parser를 열지 않는다.

- [ ] **Step 7: partial failure 실패 테스트 작성**

~~~rust
#[test]
fn failed_target_does_not_block_or_advance_successful_target() {
    let fixture = FanoutFixture::two_targets_one_event();
    let transport = FakeTransport::new()
        .success("https://personal.example/api")
        .fail("https://company.example/api", "unreachable");
    let code = run_with(
        &fixture.store,
        &transport,
        fixture.adapters(),
        None,
        false,
        true,
    );
    assert_eq!(code, 1);
    assert_eq!(fixture.sent_count("personal", "codex"), 1);
    assert_eq!(fixture.sent_count("company", "codex"), 0);
}
~~~

- [ ] **Step 8: registry-driven delivery 구현**

run은 TargetStore.load_or_migrate를 호출한다. registry가 비고 legacy env pair가 있을 때만 ephemeral target을 사용한다. registry가 있으면 env pair로 암묵적 추가/override를 하지 않는다. target은 ID 순서로 처리한다. `TOARD_SHIM_COLLECT_CONTENT=0`과 `TOARD_SHIM_COLLECT_TOOLS=0`은 모든 target에 대한 로컬 강제 중단으로 적용하고, 값 `1`은 target 저장 정책을 켜지 않는다. 각 stream의 모든 chunk가 성공한 target cursor만 commit하되 저장 직전에 target 디렉터리가 여전히 존재하는지 확인해 제거된 target을 되살리지 않고 다른 target으로 계속한다.

- [ ] **Step 9: 실패 후 복구, inventory, content 테스트와 구현**

첫 실행 회사 실패·개인 성공, 둘째 실행 양쪽 성공에서 회사만 suffix를 보내는지 검증한다. tool inventory unsupported와 content disabled도 target별 commit을 검증한다.

- [ ] **Step 10: dry-run, quiet, 종료 코드 구현**

dry-run은 network/state write 없이 target별 pending count를 표시한다. 일부 실패 1, CLI misuse 2, 전체 성공 0을 유지한다. background failure는 Claude/Codex 실행을 막지 않는다.

- [ ] **Step 11: Task 3 검증과 커밋**

Run:

~~~bash
cargo fmt --manifest-path shim/rust/Cargo.toml -- --check
cargo test --manifest-path shim/rust/Cargo.toml collect::
cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings
git diff --check
~~~

Expected: existing parser/dedup/content tests와 new fan-out tests all PASS. CountingAdapter가 parse-once를 직접 증명해야 한다.

Commit:

~~~bash
git add shim/rust/src/collect/fanout.rs shim/rust/src/collect/mod.rs shim/rust/src/collect/post.rs
git commit -m "feat(shim): fan out collection per target"
~~~

---

### Task 4: Target CLI, Doctor, Wrapper 호환

**Files:**
- Modify: shim/rust/src/cli.rs
- Modify: shim/rust/src/main.rs
- Modify: shim/rust/src/e2ee_setup.rs
- Modify: shim/rust/tests/doctor_cli.rs
- Create: shim/rust/tests/multi_target_cli.rs

**Interfaces:**
- Consumes: target registry CRUD와 collector.
- Produces:
  - toard-shim capabilities
  - toard-shim targets list
  - toard-shim target upsert
  - toard-shim target remove --machine
  - toard-shim doctor [--target-env]

- [ ] **Step 1: capabilities와 secret-free list 실패 테스트 작성**

~~~rust
#[test]
fn capabilities_and_target_list_are_machine_safe() {
    let fixture = CliFixture::with_two_targets();
    let capabilities = fixture.run(&["capabilities"]);
    assert_eq!(capabilities.stdout.trim(), "multi-target-v1");
    let list = fixture.run(&["targets", "list"]);
    assert!(list.stdout.contains("https://company.example/api"));
    assert!(list.stdout.contains("https://personal.example/api"));
    assert!(!list.stdout.contains("tk_company"));
    assert!(!list.stdout.contains("tk_personal"));
}
~~~

- [ ] **Step 2: target commands와 machine contract 구현**

target upsert는 installer env를 검증한다. target remove --machine은 정확히 아래를 출력한다.

~~~text
removed=0|1
remaining=<non-negative integer>
~~~

없는 target은 exit 0과 removed=0이다. filesystem 오류는 1, CLI misuse는 2다.

- [ ] **Step 3: target-aware doctor 실패 테스트 작성**

fake curl이 회사 000, 개인 200을 반환한다. doctor는 둘 다 표시하고 실패한다. TOARD_INGEST_ENDPOINT=personal doctor --target-env는 registry의 개인 credentials만 사용해 성공한다.

- [ ] **Step 4: doctor 구현**

공통 PATH/daemon 검사는 한 번, target credentials permission·endpoint probe·delivery status는 target별 반복한다. --target-env는 env token으로 override하지 않고 정규화 endpoint로 registry target을 선택한다.

- [ ] **Step 5: wrapper와 spawn 조건 구현**

valid target이 하나 이상이면 background collect를 spawn한다. 둘 이상이면 experimental OTLP injection과 claude-env on을 거부하고 pull을 안내한다. 정확히 하나면 기존 experimental 동작을 유지한다.

- [ ] **Step 6: 기존 E2EE CLI 단일 target guard 구현**

fixed ~/.toard/credentials 대신 선택된 target credentials path를 사용한다. target 0개/2개 이상이면 keyring이나 credentials를 변경하지 않고 오류를 반환한다.

- [ ] **Step 7: Task 4 검증과 커밋**

Run:

~~~bash
cargo fmt --manifest-path shim/rust/Cargo.toml -- --check
cargo test --manifest-path shim/rust/Cargo.toml --test doctor_cli
cargo test --manifest-path shim/rust/Cargo.toml --test multi_target_cli
cargo test --manifest-path shim/rust/Cargo.toml cli::
cargo test --manifest-path shim/rust/Cargo.toml e2ee_setup::
cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings
git diff --check
~~~

Expected: all PASS. read_credentials fixed-singleton call은 legacy/env helper 외 collector·doctor에 남지 않는다.

Commit:

~~~bash
git add shim/rust/src/cli.rs shim/rust/src/main.rs shim/rust/src/e2ee_setup.rs shim/rust/tests/doctor_cli.rs shim/rust/tests/multi_target_cli.rs
git commit -m "feat(shim): add target management CLI"
~~~

---

### Task 5: POSIX UI Installer와 Target-Aware Uninstaller

**Files:**
- Modify: apps/web/lib/shell-installer.ts
- Create: apps/web/lib/shell-installer.test.ts
- Modify: apps/web/lib/shell-installer-e2ee.test.ts
- Create: apps/web/lib/shell-uninstaller.ts
- Create: apps/web/lib/shell-uninstaller.test.ts
- Modify: apps/web/app/uninstall.sh/route.ts

**Interfaces:**
- Consumes: capabilities, target upsert/remove, doctor --target-env.
- Produces: installScript(endpoint, contentDefaultOn), uninstallScript(endpoint).

- [ ] **Step 1: installer overwrite/ordering 실패 테스트 작성**

~~~typescript
test("POSIX installer upserts target before daemon and selected doctor", () => {
  const script = installScript("https://personal.example/api", true);
  assert.doesNotMatch(script, />\s*"\$HOME\/\.toard\/credentials"/);
  assert.match(script, /toard-shim" capabilities/);
  assert.match(script, /toard-shim" target upsert/);
  assert.match(script, /toard-shim" daemon install/);
  assert.match(script, /toard-shim" doctor --target-env/);
  assert.ok(script.indexOf("target upsert") < script.indexOf("daemon install"));
});
~~~

capability 확인 문자열이 `target upsert`, PATH 변경, daemon 등록보다 모두 먼저 나타나는지와 token이 명령 인자·생성 스크립트 리터럴에 들어가지 않는지도 같은 테스트에서 검증한다.

- [ ] **Step 2: POSIX installer 구현**

release installer는 TOARD_INSTALL_DAEMON=0으로 실행한다. checksum binary 설치 후 capability를 확인하고 target upsert → daemon install → doctor --target-env 순서로 실행한다. installer는 credentials 파일을 직접 쓰지 않는다.

- [ ] **Step 3: endpoint-aware uninstaller 실패 테스트 작성**

~~~typescript
test("POSIX uninstaller removes only its endpoint unless it was last", () => {
  const script = uninstallScript("https://personal.example/api");
  assert.match(script, /target remove --machine/);
  assert.match(script, /removed=1/);
  assert.match(script, /remaining=0/);
  assert.ok(script.indexOf("target remove --machine") < script.indexOf("daemon uninstall"));
});
~~~

- [ ] **Step 4: uninstaller와 dynamic route 구현**

machine output을 exact parse한다. removed=0은 no-op, removed=1 + remaining>0은 target만 제거, removed=1 + remaining=0만 daemon·claude-env·binary·registry/global state/migration backup·marked PATH를 정리한다. route는 getIngestEndpoint를 사용하는 force-dynamic GET이다.

- [ ] **Step 5: POSIX tests와 syntax 검증**

Run:

~~~bash
pnpm --filter @toard/web exec tsx --test lib/shell-installer.test.ts lib/shell-installer-e2ee.test.ts lib/shell-uninstaller.test.ts
pnpm --filter @toard/web typecheck
pnpm --filter @toard/web exec tsx -e "import {writeFileSync} from 'node:fs'; import {installScript} from './lib/shell-installer.ts'; import {uninstallScript} from './lib/shell-uninstaller.ts'; writeFileSync('/tmp/toard-install.sh', installScript('https://toard.example/api', false)); writeFileSync('/tmp/toard-uninstall.sh', uninstallScript('https://toard.example/api'));"
sh -n /tmp/toard-install.sh
sh -n /tmp/toard-uninstall.sh
git diff --check
~~~

Expected: all PASS. Generated scripts에 agent_key assignment나 direct legacy credentials overwrite가 없어야 한다.

- [ ] **Step 6: Task 5 커밋**

~~~bash
git add apps/web/lib/shell-installer.ts apps/web/lib/shell-installer.test.ts apps/web/lib/shell-installer-e2ee.test.ts apps/web/lib/shell-uninstaller.ts apps/web/lib/shell-uninstaller.test.ts apps/web/app/uninstall.sh/route.ts
git commit -m "feat(web): make POSIX shim scripts target-aware"
~~~

---

### Task 6: PowerShell UI Installer와 Target-Aware Uninstaller

**Files:**
- Modify: apps/web/lib/powershell-installer.ts
- Modify: apps/web/lib/powershell-installer.test.ts
- Modify: apps/web/app/uninstall.ps1/route.ts
- Modify: .github/workflows/shim-ci.yml

**Interfaces:**
- Consumes: Task 4 machine CLI contract.
- Produces: buildPowerShellInstallScript(endpoint, contentDefaultOn), buildPowerShellUninstallScript(endpoint).

- [ ] **Step 1: PowerShell target contract 실패 테스트 수정**

~~~typescript
test("PowerShell installer upserts target before daemon and selected doctor", () => {
  const script = buildPowerShellInstallScript("https://personal.example/api", false);
  assert.doesNotMatch(script, /WriteAllLines[^\n]*credentials/);
  assert.match(script, /'capabilities'/);
  assert.match(script, /'target' 'upsert'/);
  assert.match(script, /'doctor' '--target-env'/);
  assert.ok(script.indexOf("'target' 'upsert'") < script.indexOf("'daemon' 'install'"));
});
~~~

- [ ] **Step 2: PowerShell installer 구현**

checksum과 binary copy는 유지한다. credentials line write를 제거하고 capability → target upsert → PATH → daemon → selected doctor 순서로 변경한다. capability 실패는 daemon/PATH/target state 변경 전에 throw한다.

- [ ] **Step 3: PowerShell uninstaller signature/test 변경**

~~~typescript
test("PowerShell uninstaller gates full cleanup on last removed target", () => {
  const script = buildPowerShellUninstallScript("https://personal.example/api");
  assert.match(script, /'target' 'remove' '--machine'/);
  assert.match(script, /removed=1/);
  assert.match(script, /remaining=0/);
  assert.ok(script.indexOf("'target' 'remove'") < script.indexOf("'daemon' 'uninstall'"));
});
~~~

- [ ] **Step 4: PowerShell uninstaller와 dynamic route 구현**

machine output을 exact parse한다. target이 남으면 binary·scheduled task·PATH를 유지한다. 마지막 실제 target이면 UAC daemon removal 뒤 전체 정리한다. route는 getIngestEndpoint를 사용한다.

installer/uninstaller 통합 fixture에서 `~/.toard`, `targets`, credentials와 state에 상응하는 Windows ACL이 현재 사용자에게만 허용되는지 `Get-Acl`로 검증한다. 이 검사는 `windows-latest` native shim E2E의 필수 assertion으로 둔다.

- [ ] **Step 5: CI generator와 local tests 갱신**

모든 buildPowerShellUninstallScript 호출에 endpoint를 전달하고 workflow path filter에 uninstall.sh와 shell-uninstaller files를 추가한다.

Run:

~~~bash
pnpm --filter @toard/web exec tsx --test lib/powershell-installer.test.ts
pnpm --filter @toard/web typecheck
git diff --check
~~~

Expected locally: Node tests/typecheck PASS. windows-latest에서 script parse, native shim, scheduled task E2E PASS.

- [ ] **Step 6: Task 6 커밋**

~~~bash
git add apps/web/lib/powershell-installer.ts apps/web/lib/powershell-installer.test.ts apps/web/app/uninstall.ps1/route.ts .github/workflows/shim-ci.yml
git commit -m "feat(web): make PowerShell shim scripts target-aware"
~~~

---

### Task 7: Upgrade·장애 복구·제거 E2E와 문서

**Files:**
- Modify: .github/scripts/shim-e2e-server.mjs
- Modify: .github/scripts/test-shim-installer-unix.sh
- Modify: .github/scripts/test-shim-installer-windows.ps1
- Modify: shim/README.md
- Modify: README.md

**Interfaces:**
- Consumes: completed registry, collector, CLI, generated scripts.
- Produces: 사용자 합의 lifecycle을 실제 binary/script로 증명하는 cross-platform E2E.

- [ ] **Step 1: multi-prefix E2E server 구현**

/v1/logs, events, prompts, tool-events, tool-inventory, events/reconcile로 끝나는 pathname을 prefix와 무관하게 받는다. capture JSONL에는 method/path/Authorization scheme/body hash만 기록하고 token/body 원문은 기록하지 않는다.

- [ ] **Step 2: Unix legacy company → personal upgrade E2E 작성**

installer 전 fixture HOME에 legacy company credentials와 진행된 codex cursor, content-since, tool-since를 만든다. personal installer 후 targets list 2개, company state 보존, personal state 분리를 확인한다. personal installer 재실행에도 2개와 cursor가 유지되어야 한다.

- [ ] **Step 3: Unix 장애·복구 fan-out E2E 작성**

두 prefix의 mock ingest를 구성하고 회사 prefix만 503으로 전환한다. 첫 collect에서 개인 요청과 cursor만 성공하고 회사 cursor는 정지하는지, 회사 prefix 복구 후 다음 collect에서 회사 누락 suffix만 전송되는지 capture와 target state로 확인한다. usage 전체 백필, tool/content 추가 시점 baseline, inventory와 reconciliation의 target별 상태도 fixture별 assertion으로 둔다.

- [ ] **Step 4: Unix target removal E2E 작성**

personal uninstaller 후 company target/binary/daemon이 남는지 확인한다. 없는 endpoint uninstaller가 full cleanup하지 않는지 확인한다. company last uninstaller는 daemon/binary/PATH/registry를 제거해야 한다.

- [ ] **Step 5: Windows E2E를 같은 lifecycle로 갱신**

legacy company fixture → personal install → 2 targets → personal remove keeps scheduled task/binary → company last remove cleans all을 검증한다.

- [ ] **Step 6: README 갱신**

UI installer가 target을 추가하고 same endpoint는 token/policy만 갱신함, server별 uninstaller, last cleanup, targets list/doctor, target failure retry와 원본 로그 보존 한계, 구버전 uninstaller 전환 주의를 문서화한다.

- [ ] **Step 7: E2E와 docs 검증**

Run:

~~~bash
cargo build --manifest-path shim/rust/Cargo.toml --release
TOARD_E2E_DAEMON=0 .github/scripts/test-shim-installer-unix.sh shim/rust/target/release/shim
pnpm --filter @toard/web test
pnpm typecheck
git diff --check
~~~

Expected: Unix lifecycle E2E, web tests, typecheck PASS. Windows lifecycle은 CI windows-latest에서 증명한다.

- [ ] **Step 8: Task 7 커밋**

~~~bash
git add .github/scripts/shim-e2e-server.mjs .github/scripts/test-shim-installer-unix.sh .github/scripts/test-shim-installer-windows.ps1 shim/README.md README.md
git commit -m "test(shim): cover multi-target upgrade lifecycle"
~~~

---

### Task 8: 최종 Verification과 요구사항 완료 감사

**Files:**
- Review: docs/superpowers/specs/2026-07-18-shim-multi-target-fanout-design.md
- Review: all files changed by Tasks 1-7.

**Interfaces:**
- Consumes: design completion criteria와 all test evidence.
- Produces: requirement-by-requirement evidence와 release readiness 결론.

- [ ] **Step 1: 전체 Rust gate 실행**

~~~bash
cargo fmt --manifest-path shim/rust/Cargo.toml -- --check
cargo test --manifest-path shim/rust/Cargo.toml
cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings
cargo build --manifest-path shim/rust/Cargo.toml --release
~~~

Expected: all PASS with zero warnings.

- [ ] **Step 2: 전체 web·script gate 실행**

~~~bash
pnpm --filter @toard/web test
pnpm typecheck
sh -n shim/install.sh
sh -n .github/scripts/test-shim-installer-unix.sh
TOARD_E2E_DAEMON=0 .github/scripts/test-shim-installer-unix.sh shim/rust/target/release/shim
git diff --check
~~~

Expected: all PASS.

- [ ] **Step 3: singleton·secret 잔존 감사**

Run:

~~~bash
rg -n "\.toard/credentials|join\(\"credentials\"\)|state_dir\(\).*cursors|WriteAllLines.*credentials|agent_key=.*TOKEN" shim/rust/src apps/web/lib apps/web/app .github/scripts
~~~

Expected: legacy importer와 explicitly tested compatibility code만 남는다. 모든 hit를 분류하고 collector/new installer fixed singleton write가 없음을 확인한다.

- [ ] **Step 4: 설계 완료 기준 추적표 작성**

각 완료 bullet을 implementation file, test name, command output에 대응한다. 임의 target은 registry+2 target E2E+loop, parse-once는 CountingAdapter, partial recovery는 two-run fake transport, migration은 actual installer E2E, remove는 generator+E2E, wire compatibility는 unchanged paths/payload tests, secret safety는 script scan+CLI output test로 증명한다.

- [ ] **Step 5: branch와 CI scope 검토**

~~~bash
git status --short
git log --oneline --decorate origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
~~~

Expected: intended files only, clean worktree, no generated artifacts. Linux/macOS/Windows shim jobs가 new paths로 trigger되는지 workflow diff를 확인한다.

- [ ] **Step 6: verification gap 수정 여부 판단**

gap이 있으면 해당 test/doc/code를 수정하고 관련 focused/full gate를 다시 실행해 commit한다. 변경이 없으면 empty commit을 만들지 않는다. 모든 설계 requirement가 direct evidence로 proven일 때만 완료를 선언한다.
