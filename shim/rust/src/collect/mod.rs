// 범용 로컬 로그 pull 수집 (설계 §5.6, ADR-002/006 — 2차).
// 비-OTEL 도구의 로컬 로그를 어댑터로 파싱해 UsageEvent[] 로 정규화하고
// POST /api/v1/events 로 보낸다. 토큰 카운트까지만 — user/cost 는 서버 권위.

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod fanout;
pub mod gemini;
pub mod gemini_family;
pub mod inventory;
pub mod post;
pub mod qwen;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::bg;
use crate::credentials::{read_credentials, DEFAULT_ENDPOINT};
use crate::fsx;
use crate::iso;
use crate::targets::{Target, TargetStore};
use crate::tool_event::{to_tool_events_body, ToolActivityKind, ToolDetection, ToolOutcome};
use crate::usage_event::{to_events_body, UsageEvent};

/// 내부 argv — wrap 실행에 편승하는 백그라운드 수집 (자동 업데이트와 동일 패턴)
pub const SPAWN_ARG: &str = "___toard-spawn-collector";
pub const RUN_ARG: &str = "___toard-collect";
const DEFAULT_INTERVAL_SECS: u64 = 600;
const CODEX_REPLAY_RECONCILIATION_VERSION: u32 = 1;

/// wrap 경로에서 호출 — 토큰 있는 머신만, 기본 10분 스로틀로 백그라운드 수집.
/// 도구를 쓸 때마다 수집이 따라오므로 데몬 관리가 필요 없다. 동시 실행 레이스로
/// 수집이 겹쳐도 dedup_key 멱등 저장이 흡수한다.
pub fn maybe_spawn_background() {
    if matches!(
        std::env::var("TOARD_SHIM_COLLECT").ok().as_deref(),
        Some("0" | "false" | "off")
    ) {
        return;
    }
    if read_credentials().token.is_none() {
        return;
    }
    let interval = std::env::var("TOARD_SHIM_COLLECT_INTERVAL")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_INTERVAL_SECS);
    if bg::throttle("last-collect", interval) {
        bg::kick(SPAWN_ARG);
    }
}

/// SPAWN_ARG 로 실행된 중간 프로세스 — 수집기를 분리하고 즉시 종료.
pub fn spawn_detached_collector() -> ! {
    bg::detach(RUN_ARG)
}

/// 어댑터가 로그에서 뽑아내는 원시 사용 레코드 (도구 중립).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RawUsage {
    pub ts_ms: i64,
    pub session_id: Option<String>,
    pub model: Option<String>,
    /// 로그 상의 요청/메시지 고유 id — dedup 1차 키 (§4.4)
    pub message_id: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_creation_tokens: u64,
    /// cache_creation_tokens 중 1시간 TTL 분량(subset). 서버가 1h=input×2, 5m=input×1.25 로
    /// 차등 가격하기 위한 pricing 힌트(§design-usage-pull 리스크 B). Claude 만 채우고 나머지는 0.
    pub cache_creation_1h_tokens: u64,
}

/// 어댑터가 로그에서 뽑는 원시 본문 레코드 (프롬프트/응답 텍스트).
/// opt-in(TOARD_SHIM_COLLECT_CONTENT)일 때만 수집된다. e2ee_v1에서는 전송 전 로컬 암호화한다.
#[derive(Debug, Clone, PartialEq)]
pub struct RawContent {
    pub ts_ms: i64,
    pub session_id: Option<String>,
    /// 로그 상 메시지 고유 id — dedup 1차 키 (있으면)
    pub message_id: Option<String>,
    /// "user" | "assistant"
    pub role: &'static str,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct RawToolActivity {
    pub ts_ms: i64,
    pub session_id: Option<Arc<str>>,
    pub call_id: String,
    pub kind: ToolActivityKind,
    pub item_key: String,
    pub plugin_key: Option<String>,
    pub outcome: ToolOutcome,
    pub detection: ToolDetection,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedLog {
    pub usage: Vec<RawUsage>,
    /// fork/subagent rollout에 복사되어 과거 parser가 이미 전송한 부모 사용량.
    /// 기존 dedup key를 그대로 재현해 서버 reconciliation에만 사용한다.
    pub replayed_usage: Vec<RawUsage>,
    pub content: Vec<RawContent>,
    pub tools: Vec<RawToolActivity>,
}

pub trait LogAdapter {
    /// provider_key 이자 log_adapter 식별자
    fn key(&self) -> &'static str;
    /// 이 어댑터가 사용량(usage)도 수집하는가. 본문 전용 어댑터(claude/codex — 사용량은 OTLP)는
    /// false 를 반환해 usage 루프에서 건너뛴다(불필요한 파일 순회·이중집계 방지).
    fn collects_usage(&self) -> bool {
        true
    }
    fn discover_files(&self) -> Vec<PathBuf>;
    /// 파일 하나 → 사용 레코드들. 손상 파일은 빈 벡터(수집 전체를 중단시키지 않음).
    fn parse_file(&self, path: &Path) -> Vec<RawUsage>;
    /// 파일 하나 → 본문 레코드들. 기본은 없음(본문 미지원 어댑터). 손상 파일은 빈 벡터.
    fn parse_content(&self, _path: &Path) -> Vec<RawContent> {
        Vec::new()
    }
    fn parse_changed(&self, path: &Path, include_content: bool, _include_tools: bool) -> ParsedLog {
        ParsedLog {
            usage: self.parse_file(path),
            replayed_usage: Vec::new(),
            content: if include_content {
                self.parse_content(path)
            } else {
                Vec::new()
            },
            tools: Vec::new(),
        }
    }
}

pub fn adapters() -> Vec<Box<dyn LogAdapter>> {
    vec![
        Box::new(gemini::Gemini),
        Box::new(qwen::Qwen),
        Box::new(claude::Claude),
        Box::new(codex::Codex),
    ]
}

struct CachedAdapter {
    key: &'static str,
    files: Vec<PathBuf>,
    parsed: HashMap<String, ParsedLog>,
}

impl LogAdapter for CachedAdapter {
    fn key(&self) -> &'static str {
        self.key
    }

    fn discover_files(&self) -> Vec<PathBuf> {
        self.files.clone()
    }

    fn parse_file(&self, path: &Path) -> Vec<RawUsage> {
        self.parsed
            .get(&path.display().to_string())
            .map(|batch| batch.usage.clone())
            .unwrap_or_default()
    }

    fn parse_content(&self, path: &Path) -> Vec<RawContent> {
        self.parsed
            .get(&path.display().to_string())
            .map(|batch| batch.content.clone())
            .unwrap_or_default()
    }

    fn parse_changed(
        &self,
        path: &Path,
        _include_content: bool,
        _include_tools: bool,
    ) -> ParsedLog {
        self.parsed
            .get(&path.display().to_string())
            .cloned()
            .unwrap_or_default()
    }
}

fn env_is_false(name: &str) -> bool {
    matches!(
        std::env::var(name).ok().as_deref(),
        Some("0" | "false" | "off" | "no")
    )
}

fn target_collect_tools(credentials: &crate::credentials::Credentials) -> bool {
    credentials.collect_tools && !env_is_false("TOARD_SHIM_COLLECT_TOOLS")
}

fn target_content_mode(
    credentials: &crate::credentials::Credentials,
) -> crate::credentials::ContentCollectionMode {
    if env_is_false("TOARD_SHIM_COLLECT_CONTENT") {
        crate::credentials::ContentCollectionMode::Off
    } else {
        credentials.collect_content
    }
}

fn prepare_cached_adapters(
    targets: &[Target],
    source_adapters: Vec<Box<dyn LogAdapter>>,
    only: Option<&str>,
    dry_run: bool,
) -> Vec<Box<dyn LogAdapter>> {
    let include_content = targets
        .iter()
        .any(|target| target_content_mode(&target.credentials).is_enabled());
    let include_tools = targets
        .iter()
        .any(|target| target_collect_tools(&target.credentials));
    let mut prepared: Vec<Box<dyn LogAdapter>> = Vec::new();

    for adapter in source_adapters {
        if only.is_some_and(|selected| selected != adapter.key()) {
            continue;
        }
        let files = adapter.discover_files();
        let mut changed_paths = HashSet::new();
        for target in targets {
            let usage_cursor = cursor::load(&target.state_dir, adapter.key());
            let tool_cursor_key = format!("{}-tools", adapter.key());
            let tool_cursor = cursor::load(&target.state_dir, &tool_cursor_key);
            let content_cursor_key = format!("{}-content", adapter.key());
            let content_cursor = cursor::load(&target.state_dir, &content_cursor_key);
            let reconciliation_scan = reconciliation_active(
                adapter.key(),
                usage_cursor.reconciliation_version,
                post::unsupported_probe_due(&target.state_dir, "usage-reconciliation"),
                dry_run,
            );
            let tools_active = target_collect_tools(&target.credentials)
                && !tool_cursor.files.is_empty()
                && post::unsupported_probe_due(&target.state_dir, "tool-events");
            let content_active = target_content_mode(&target.credentials).is_enabled();
            for file in &files {
                let Some(stamp) = cursor::stamp(file) else {
                    continue;
                };
                let path = file.display().to_string();
                let usage_changed = adapter.collects_usage()
                    && usage_cursor.files.get(&path).map(|state| state.stamp()) != Some(stamp);
                let tools_changed = tools_active
                    && tool_cursor.files.get(&path).map(|state| state.stamp()) != Some(stamp);
                let content_changed = content_active
                    && content_cursor.files.get(&path).map(|state| state.stamp()) != Some(stamp);
                if usage_changed || tools_changed || content_changed || reconciliation_scan {
                    changed_paths.insert(path);
                }
            }
        }
        let batches = fanout::parse_discovered_once(
            adapter.as_ref(),
            &files,
            &changed_paths,
            include_content,
            include_tools,
        );
        let parsed = batches
            .into_iter()
            .map(|batch| (batch.path, batch.parsed))
            .collect();
        prepared.push(Box::new(CachedAdapter {
            key: adapter.key(),
            files,
            parsed,
        }));
    }
    prepared
}

fn seed_tool_baseline(files: &[(String, cursor::FileStamp)]) -> cursor::Cursor {
    let mut cursor = cursor::Cursor::default();
    for (path, stamp) in files {
        cursor.files.insert(
            path.clone(),
            cursor::FileState {
                mtime_ms: stamp.mtime_ms,
                size: stamp.size,
                sent: 0,
                sent_hash: String::new(),
            },
        );
    }
    cursor
}

fn tool_since_ms(state_dir: &Path, dry_run: bool) -> i64 {
    let now = (bg::now_unix() * 1000) as i64;
    let path = state_dir.join("tool-since");
    if let Ok(value) = std::fs::read_to_string(&path) {
        if let Ok(parsed) = value.trim().parse::<i64>() {
            return parsed;
        }
    }
    if !dry_run {
        let _ = fsx::write_atomic(&path, &format!("{now}\n"), 0o644);
    }
    now
}

fn should_parse_tool_file(
    collect_tools: bool,
    probe_due: bool,
    first_tool_run: bool,
    usage_same: bool,
    tools_same: bool,
    reconciliation_scan: bool,
) -> bool {
    reconciliation_scan
        || !usage_same
        || (collect_tools && probe_due && !first_tool_run && !tools_same)
}

fn reconciliation_active(
    adapter: &str,
    cursor_version: u32,
    probe_due: bool,
    dry_run: bool,
) -> bool {
    adapter == "codex"
        && (dry_run || (cursor_version < CODEX_REPLAY_RECONCILIATION_VERSION && probe_due))
}

/// 디렉토리를 재귀 순회하며 확장자가 일치하는 파일 수집 (심링크 루프 방지 깊이 캡).
pub fn walk_files(dir: &Path, exts: &[&str], out: &mut Vec<PathBuf>, depth: u32) {
    if depth > 12 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, exts, out, depth + 1);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| exts.contains(&e))
        {
            out.push(path);
        }
    }
}

/// 어댑터 파서의 타임스탬프 폴백용 (ccusage file_modified_timestamp 대체)
pub fn file_mtime_ms(path: &Path) -> i64 {
    cursor::stamp(path).map(|s| s.mtime_ms).unwrap_or(0)
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// dedup_key 생성 (§4.4 규칙의 logfile 미러):
/// message_id 가 있으면 hash(adapter, id, model, tokens),
/// 없으면 hash(adapter, session, ts, model, in+out).
fn dedup_key(adapter: &str, r: &RawUsage) -> String {
    let model = r.model.as_deref().unwrap_or("");
    match &r.message_id {
        Some(id) => sha256_hex(&format!(
            "{adapter}:{id}:{model}:{}:{}:{}:{}",
            r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_creation_tokens
        )),
        None => sha256_hex(&format!(
            "{adapter}:{}:{}:{model}:{}:{}",
            r.session_id.as_deref().unwrap_or(""),
            r.ts_ms,
            r.input_tokens,
            r.output_tokens
        )),
    }
}

fn to_usage_event(adapter: &str, r: &RawUsage, host: Option<&str>) -> UsageEvent {
    UsageEvent {
        dedup_key: dedup_key(adapter, r),
        provider_key: adapter.to_string(),
        user_id: None,
        session_id: r.session_id.clone(),
        model: r.model.clone(),
        ts: iso::epoch_ms_to_iso(r.ts_ms),
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        cache_read_tokens: r.cache_read_tokens,
        cache_creation_tokens: r.cache_creation_tokens,
        cache_creation_1h_tokens: r.cache_creation_1h_tokens,
        cost_usd: 0.0,
        log_adapter: Some(adapter.to_string()),
        host: host.map(String::from),
    }
}

fn to_reconciliation_body(dedup_keys: &[String]) -> String {
    serde_json::json!({ "dedupKeys": dedup_keys }).to_string()
}

fn reconciliation_keys(
    replay_keys: Vec<String>,
    legitimate_keys: &std::collections::HashSet<String>,
) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    replay_keys
        .into_iter()
        .filter(|key| !legitimate_keys.contains(key) && seen.insert(key.clone()))
        .collect()
}

/// 본문 수집 opt-in — 기본 off. 이게 켜져야 shim 이 프롬프트/응답 본문을 담는다.
/// env(TOARD_SHIM_COLLECT_CONTENT)가 명시되면 그 값이 우선하고, 미설정이면
/// `~/.toard/credentials` 의 `collect_content` 플래그(install.sh 가 기록)를 따른다.
/// (§신뢰경계: shim 의 "본문 안 읽음"을 여는 스위치라 명시적 opt-in)
pub fn content_enabled() -> bool {
    content_collection_mode().is_enabled()
}

pub fn content_collection_mode() -> crate::credentials::ContentCollectionMode {
    use crate::credentials::ContentCollectionMode;
    let stored = read_credentials().collect_content;
    match std::env::var("TOARD_SHIM_COLLECT_CONTENT").ok().as_deref() {
        Some("1" | "true" | "on" | "yes") if stored == ContentCollectionMode::E2eeV1 => stored,
        Some(value) => ContentCollectionMode::parse(value),
        _ => stored,
    }
}

fn now_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// "YYYY-MM-DD"(날짜만) 또는 ISO 8601 → epoch ms. 날짜만이면 그날 00:00 UTC.
fn parse_since(s: &str) -> Option<i64> {
    iso::iso_to_epoch_ms(s).or_else(|| iso::iso_to_epoch_ms(&format!("{s}T00:00:00Z")))
}

/// 본문 백필 컷오프(epoch ms). 이 시점 이후 턴만 수집한다.
///   `all`/`0`      → 0 (전량 백필)
///   ISO/날짜       → 그 시점부터
///   미설정         → "지금부터" = 최초 활성화 시각을 state(`content-since`)에 기록해 안정적으로 사용
///                    (dry_run 이면 기록하지 않고 현재 시각으로 미리보기)
#[cfg(test)]
fn content_since_ms(since_cfg: Option<&str>, dry_run: bool) -> i64 {
    let state_dir = fsx::state_dir().unwrap_or_else(|| PathBuf::from(".toard-state-unavailable"));
    content_since_ms_for_state(&state_dir, since_cfg, dry_run)
}

fn content_since_ms_for_state(state_dir: &Path, since_cfg: Option<&str>, dry_run: bool) -> i64 {
    match since_cfg.map(str::trim) {
        Some("all") | Some("0") => 0,
        Some(s) if !s.is_empty() => {
            parse_since(s).unwrap_or_else(|| default_since_ms(state_dir, dry_run))
        }
        _ => default_since_ms(state_dir, dry_run),
    }
}

/// 미설정 기본 = 최초 활성화 시각(state 파일에 지속). 없으면 now 를 기록하고 반환.
fn default_since_ms(state_dir: &Path, dry_run: bool) -> i64 {
    let now = now_epoch_ms();
    let path = state_dir.join("content-since");
    if let Ok(s) = std::fs::read_to_string(&path) {
        if let Ok(ms) = s.trim().parse::<i64>() {
            return ms;
        }
    }
    if !dry_run {
        let _ = fsx::write_atomic(&path, &now.to_string(), 0o600);
    }
    now
}

/// 본문 dedup_key — usage 키와 네임스페이스 분리("content"). 텍스트를 포함해
/// 같은 메시지는 같은 키(멱등), 내용이 바뀌면 다른 키. id 있으면 함께 섞는다.
fn content_dedup_key(adapter: &str, r: &RawContent) -> String {
    sha256_hex(&format!(
        "{adapter}:content:{}:{}:{}:{}:{}",
        r.message_id.as_deref().unwrap_or(""),
        r.session_id.as_deref().unwrap_or(""),
        r.ts_ms,
        r.role,
        r.text,
    ))
}

/// RawContent[] → POST /api/v1/prompts 본문(PromptRecord[] JSON).
fn to_prompts_body(adapter: &str, records: &[RawContent]) -> String {
    let arr: Vec<serde_json::Value> = records
        .iter()
        .map(|r| {
            serde_json::json!({
                "dedupKey": content_dedup_key(adapter, r),
                "providerKey": adapter,
                "sessionId": r.session_id,
                "turnRole": r.role,
                "ts": iso::epoch_ms_to_iso(r.ts_ms),
                "text": r.text,
            })
        })
        .collect();
    serde_json::Value::Array(arr).to_string()
}

fn to_e2ee_prompts_body(
    adapter: &str,
    owner_id: &str,
    key_version: u16,
    uck: &[u8; 32],
    records: &[RawContent],
) -> Result<String, crate::content_crypto::ContentCryptoError> {
    use crate::content_crypto::{encrypt_record, ContentMetadata};
    let rows = records
        .iter()
        .map(|record| {
            let metadata = ContentMetadata {
                schema: "e2ee_v1".into(),
                content_owner_id: owner_id.into(),
                dedup_key: content_dedup_key(adapter, record),
                provider_key: adapter.into(),
                turn_role: record.role.into(),
                ts: iso::epoch_ms_to_iso(record.ts_ms),
            };
            let encrypted = encrypt_record(uck, &metadata, record.text.as_bytes())?;
            Ok(serde_json::json!({
                "schema": "e2ee_v1",
                "algorithm": "AES-256-GCM",
                "aadVersion": 1,
                "contentOwnerId": metadata.content_owner_id,
                "contentKeyVersion": key_version,
                "dedupKey": metadata.dedup_key,
                "sessionId": record.session_id,
                "providerKey": metadata.provider_key,
                "turnRole": metadata.turn_role,
                "ts": metadata.ts,
                "wrappedDek": b64url(&encrypted.wrapped_dek),
                "dekWrapIv": b64url(&encrypted.dek_wrap_iv),
                "dekWrapAuthTag": b64url(&encrypted.dek_wrap_auth_tag),
                "iv": b64url(&encrypted.iv),
                "ciphertext": b64url(&encrypted.ciphertext),
                "authTag": b64url(&encrypted.auth_tag),
            }))
        })
        .collect::<Result<Vec<serde_json::Value>, crate::content_crypto::ContentCryptoError>>()?;
    Ok(serde_json::Value::Array(rows).to_string())
}

fn b64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(ALPHABET[(first >> 2) as usize] as char);
        output.push(ALPHABET[(((first & 3) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(ALPHABET[(((second & 15) << 2) | (third >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            output.push(ALPHABET[(third & 63) as usize] as char);
        }
    }
    output
}

const CHUNK: usize = 1000;

/// 전송 필터: 이전에 보낸 prefix(sent 개, 연쇄 해시)가 이번 파싱 결과의 앞부분과
/// 일치하면 그 뒤(신규분)부터 전송, 아니면(파일 재작성·순서 변경·컷오프 변경) 처음부터.
/// 폴백 중복은 서버 dedup 멱등 저장이 흡수하므로 판정이 보수적이어도 정확성엔 영향 없다.
fn resume_index(prev_sent: u64, prev_hash: &str, keys: &[&str]) -> usize {
    let n = prev_sent as usize;
    if n == 0 || prev_hash.is_empty() || n > keys.len() {
        return 0;
    }
    if keys_hash(&keys[..n]) == prev_hash {
        n
    } else {
        0
    }
}

/// dedup_key 연쇄 해시 — 전송한 prefix 의 지문 (커서 `sent_hash`).
fn keys_hash(keys: &[&str]) -> String {
    let mut h = Sha256::new();
    for k in keys {
        h.update(k.as_bytes());
        h.update(b"\n");
    }
    format!("{:x}", h.finalize())
}

/// 데몬 로그 보존 1년 — 넘으면 `.1` 로 한 세대 보관(디스크엔 최대 ~2년치).
/// launchd/systemd 엔 로테이션이 없어 shim 이 직접 한다. 이번 실행의 stdout fd 는
/// 이미 옛 inode 를 물고 있어 이번 회차 출력은 `.1` 쪽에 남는다(경계 아티팩트 — 수용).
const LOG_ROTATE_SECS: u64 = 365 * 24 * 3600;

fn rotate_daemon_logs() {
    if !bg::throttle("daemon-log-rotate", LOG_ROTATE_SECS) {
        return;
    }
    let Some(state) = fsx::state_dir() else {
        return;
    };
    for name in ["daemon.log", "daemon.err.log"] {
        let p = state.join(name);
        if p.exists() {
            let _ = std::fs::rename(&p, state.join(format!("{name}.1")));
        }
    }
}

/// `toard-shim collect` 본체. only=특정 어댑터만, dry_run=파싱 결과만 출력,
/// quiet=무변경 시 무출력(데몬 주기 실행용 — 전송·오류는 항상 출력).
pub fn run(only: Option<&str>, dry_run: bool, quiet: bool) -> i32 {
    let store = match TargetStore::from_home() {
        Ok(store) => store,
        Err(error) => {
            eprintln!("toard-shim: target 저장소를 열 수 없습니다 — {error}");
            return 1;
        }
    };
    run_with(
        &store,
        &post::CurlTransport,
        adapters(),
        only,
        dry_run,
        quiet,
    )
}

pub fn run_with(
    store: &TargetStore,
    transport: &dyn post::Transport,
    source_adapters: Vec<Box<dyn LogAdapter>>,
    only: Option<&str>,
    dry_run: bool,
    quiet: bool,
) -> i32 {
    let target_result = if dry_run {
        store.load_readonly()
    } else {
        store.load_or_migrate()
    };
    let mut targets = match target_result {
        Ok(targets) => targets,
        Err(error) => {
            eprintln!("toard-shim: target 설정을 읽을 수 없습니다 — {error}");
            return 1;
        }
    };
    let global_state = store.root().join("state");
    if !dry_run {
        if let Err(error) = std::fs::create_dir_all(&global_state) {
            eprintln!("toard-shim: 전역 상태 디렉터리를 만들 수 없습니다 — {error}");
            return 1;
        }
        let _ = crate::fsx::set_mode(&global_state, 0o700);
    }

    if targets.is_empty() {
        let mut credentials = read_credentials();
        let endpoint = credentials.endpoint.as_deref().unwrap_or(DEFAULT_ENDPOINT);
        let endpoint = match crate::targets::normalize_endpoint(endpoint) {
            Ok(endpoint) => endpoint,
            Err(error) => {
                eprintln!("toard-shim: endpoint 설정이 잘못되었습니다 — {error}");
                return 1;
            }
        };
        if credentials.token.is_none() && !dry_run {
            eprintln!("toard-shim: 자격 증명이 없습니다 — 설치 스크립트로 target을 추가하세요");
            return 1;
        }
        credentials.endpoint = Some(endpoint.clone());
        targets.push(Target {
            id: crate::targets::target_id(&endpoint),
            endpoint,
            credentials_path: store.root().join("credentials"),
            state_dir: global_state.clone(),
            credentials,
        });
    }

    let cached_adapters = prepare_cached_adapters(&targets, source_adapters, only, dry_run);
    if cached_adapters.is_empty() {
        eprintln!(
            "toard-shim: 어댑터를 찾을 수 없습니다: {}",
            only.unwrap_or("?")
        );
        return 2;
    }

    if only.is_none() && !dry_run {
        bg::touch("last-collect");
        rotate_daemon_logs();
    }
    let host = crate::host::host_label();
    let mut failed = false;
    for target in &targets {
        if !target_still_exists(target, &global_state) {
            continue;
        }
        if !dry_run {
            let _ = crate::delivery::record_attempt(&target.state_dir);
        }
        let code = run_target(
            target,
            &global_state,
            transport,
            &cached_adapters,
            only,
            dry_run,
            quiet,
            host.as_deref(),
        );
        if code == 2 {
            return 2;
        }
        if code == 0 {
            if !dry_run && target_still_exists(target, &global_state) {
                let _ = crate::delivery::record_success(&target.state_dir);
            }
        } else {
            failed = true;
            if !dry_run && target_still_exists(target, &global_state) {
                let _ = crate::delivery::record_failure(
                    &target.state_dir,
                    crate::delivery::DeliveryKind::ServerError,
                    "target delivery failed",
                );
            }
        }
    }
    i32::from(failed)
}

fn target_still_exists(target: &Target, global_state: &Path) -> bool {
    target.state_dir == global_state || target.credentials_path.is_file()
}

#[allow(clippy::too_many_arguments)]
fn run_target(
    target: &Target,
    global_state: &Path,
    transport: &dyn post::Transport,
    prepared_adapters: &[Box<dyn LogAdapter>],
    only: Option<&str>,
    dry_run: bool,
    quiet: bool,
    host: Option<&str>,
) -> i32 {
    let state_dir = &target.state_dir;
    let creds = &target.credentials;
    let endpoint = &target.endpoint;
    let token = match (&creds.token, dry_run) {
        (Some(t), _) => Some(t.clone()),
        (None, true) => None,
        (None, false) => {
            eprintln!(
                "toard-shim: {} target 자격 증명이 없습니다",
                target.endpoint
            );
            return 1;
        }
    };
    let collect_tools = target_collect_tools(creds);
    let tools_since = tool_since_ms(state_dir, dry_run);

    let mut failed = false;
    let mut matched = false;
    for adapter in prepared_adapters {
        let key = adapter.key();
        if only.is_some_and(|o| o != key) {
            continue;
        }
        matched = true;
        // 사용량 미수집 어댑터(있다면)는 usage 루프를 건너뛴다 — 본문은 아래 content 루프에서.
        // (현재 모든 어댑터가 사용량을 수집하지만, 향후 본문 전용 어댑터를 위한 일반 가드로 유지.)
        if !adapter.collects_usage() {
            continue;
        }

        let files = adapter.discover_files();
        let mut cur = cursor::load(state_dir, key);
        let reconciliation_scan = reconciliation_active(
            key,
            cur.reconciliation_version,
            post::unsupported_probe_due(state_dir, "usage-reconciliation"),
            dry_run,
        );
        let tool_cursor_key = format!("{key}-tools");
        let mut tool_cur = cursor::load(state_dir, &tool_cursor_key);
        let first_tool_run = collect_tools && tool_cur.files.is_empty();
        let tool_probe_due = collect_tools && post::unsupported_probe_due(state_dir, "tool-events");
        let tool_active = tool_probe_due && !first_tool_run;
        if first_tool_run {
            let stamps = files
                .iter()
                .filter_map(|file| {
                    cursor::stamp(file).map(|stamp| (file.display().to_string(), stamp))
                })
                .collect::<Vec<_>>();
            tool_cur = seed_tool_baseline(&stamps);
            if !dry_run && target_still_exists(target, global_state) {
                cursor::save(state_dir, &tool_cursor_key, &tool_cur);
            }
        }

        let mut changed = 0usize;
        let mut parsed_total = 0usize;
        let mut replayed_total = 0usize;
        let mut replayed_tokens = 0u64;
        let mut events: Vec<UsageEvent> = Vec::new();
        let mut replay_keys: Vec<String> = Vec::new();
        let mut legitimate_keys = std::collections::HashSet::new();
        let mut tool_events: Vec<RawToolActivity> = Vec::new();
        let mut updates: Vec<(String, cursor::FileState)> = Vec::new();
        let mut tool_updates: Vec<(String, cursor::FileState)> = Vec::new();
        for file in &files {
            let Some(stamp) = cursor::stamp(file) else {
                continue;
            };
            let path = file.display().to_string();
            let usage_same = cur.files.get(&path).map(|state| state.stamp()) == Some(stamp);
            let tools_same = tool_cur.files.get(&path).map(|state| state.stamp()) == Some(stamp);
            if !should_parse_tool_file(
                collect_tools,
                tool_probe_due,
                first_tool_run,
                usage_same,
                tools_same,
                reconciliation_scan,
            ) {
                continue;
            }
            changed += 1;
            let parsed = adapter.parse_changed(file, false, tool_active);
            let file_events: Vec<UsageEvent> = parsed
                .usage
                .iter()
                .map(|raw| to_usage_event(key, raw, host))
                .collect();
            legitimate_keys.extend(file_events.iter().map(|event| event.dedup_key.clone()));
            if reconciliation_scan {
                replayed_total += parsed.replayed_usage.len();
                replayed_tokens =
                    parsed
                        .replayed_usage
                        .iter()
                        .fold(replayed_tokens, |total, usage| {
                            total.saturating_add(
                                usage
                                    .input_tokens
                                    .saturating_add(usage.output_tokens)
                                    .saturating_add(usage.cache_read_tokens)
                                    .saturating_add(usage.cache_creation_tokens),
                            )
                        });
                replay_keys.extend(parsed.replayed_usage.iter().map(|raw| dedup_key(key, raw)));
            }
            parsed_total += file_events.len();
            let keyed_events = file_events
                .into_iter()
                .map(|event| (event.dedup_key.clone(), event))
                .collect::<Vec<_>>();
            let plan = fanout::plan_records(&path, stamp, &cur, &keyed_events);
            updates.extend(plan.updates);
            events.extend(plan.pending);

            if tool_active {
                let file_tools = parsed
                    .tools
                    .into_iter()
                    .filter(|event| event.ts_ms >= tools_since)
                    .collect::<Vec<_>>();
                let tool_keys = file_tools
                    .iter()
                    .map(|event| crate::tool_event::dedup_key(key, event))
                    .collect::<Vec<_>>();
                let tool_refs = tool_keys.iter().map(String::as_str).collect::<Vec<_>>();
                let previous = tool_cur.files.get(&path);
                let start = resume_index(
                    previous.map_or(0, |state| state.sent),
                    previous.map_or("", |state| state.sent_hash.as_str()),
                    &tool_refs,
                );
                tool_updates.push((
                    path,
                    cursor::FileState {
                        mtime_ms: stamp.mtime_ms,
                        size: stamp.size,
                        sent: tool_refs.len() as u64,
                        sent_hash: keys_hash(&tool_refs),
                    },
                ));
                tool_events.extend(file_tools.into_iter().skip(start));
            }
        }
        let replay_keys = reconciliation_keys(replay_keys, &legitimate_keys);

        if dry_run {
            println!(
                "{key}: 파일 {}개 (변경 {changed}개) → 정상 이벤트 {parsed_total}건, 전송 대상 {}건, 재생 감지 {replayed_total}건 · 재생 토큰 {replayed_tokens} · 철회 키 {}건 [dry-run]",
                files.len(), events.len(), replay_keys.len()
            );
            if collect_tools {
                println!("{key} 도구: 전송 대상 {}건 [dry-run]", tool_events.len());
            }
            continue;
        }

        let mut usage_ok = true;
        if events.is_empty() {
            if !quiet {
                println!(
                    "{key}: 새 이벤트 없음 (파일 {}개, 변경 {changed}개)",
                    files.len()
                );
            }
        } else {
            let token = token.as_deref().expect("dry_run 아니면 토큰 존재");
            let (mut inserted, mut deduped) = (0u64, 0u64);
            for chunk in events.chunks(CHUNK) {
                match transport.post_events(endpoint, token, &to_events_body(chunk)) {
                    Ok(result) => {
                        inserted += result.inserted;
                        deduped += result.deduped;
                    }
                    Err(error) => {
                        eprintln!("toard-shim: {key} 전송 실패 — {error}");
                        usage_ok = false;
                        failed = true;
                        break;
                    }
                }
            }
            if usage_ok {
                println!(
                    "{key}: 이벤트 {}건 전송 (신규 {inserted} · 중복 {deduped})",
                    events.len()
                );
            }
        }

        let mut reconciliation_complete = !reconciliation_scan;
        if reconciliation_scan {
            if replay_keys.is_empty() {
                reconciliation_complete = true;
            } else {
                let token = token.as_deref().expect("dry_run 아니면 토큰 존재");
                let mut reconciled = 0u64;
                let mut reconciliation_ok = true;
                for chunk in replay_keys.chunks(CHUNK) {
                    match transport.post_usage_reconciliation(
                        endpoint,
                        token,
                        &to_reconciliation_body(chunk),
                    ) {
                        post::EndpointResult::Ok(result) => reconciled += result.reconciled,
                        post::EndpointResult::Unsupported => {
                            if target_still_exists(target, global_state) {
                                post::mark_unsupported(state_dir, "usage-reconciliation");
                            }
                            reconciliation_ok = false;
                            break;
                        }
                        post::EndpointResult::Unauthorized => {
                            eprintln!(
                                "toard-shim: {key} 재생 보정 실패 — 토큰이 유효하지 않습니다"
                            );
                            reconciliation_ok = false;
                            failed = true;
                            break;
                        }
                        post::EndpointResult::Err(error) => {
                            eprintln!("toard-shim: {key} 재생 보정 실패 — {error}");
                            reconciliation_ok = false;
                            failed = true;
                            break;
                        }
                    }
                }
                if reconciliation_ok {
                    println!(
                        "{key}: 기존 재생 오염 키 {}건 확인 · {reconciled}건 철회",
                        replay_keys.len()
                    );
                    reconciliation_complete = true;
                }
            }
        }
        if usage_ok && target_still_exists(target, global_state) {
            for (path, state) in updates {
                cur.files.insert(path, state);
            }
            let alive = files
                .iter()
                .map(|file| file.display().to_string())
                .collect::<std::collections::HashSet<_>>();
            cur.files.retain(|path, _| alive.contains(path));
            if reconciliation_scan && reconciliation_complete {
                cur.reconciliation_version = CODEX_REPLAY_RECONCILIATION_VERSION;
            }
            cursor::save(state_dir, key, &cur);
        }

        if tool_active {
            let mut tools_ok = true;
            if !tool_events.is_empty() {
                let token = token.as_deref().expect("dry_run 아니면 토큰 존재");
                for chunk in tool_events.chunks(CHUNK) {
                    match transport.post_tool_events(
                        endpoint,
                        token,
                        &to_tool_events_body(key, host, chunk),
                    ) {
                        post::EndpointResult::Ok(result) => println!(
                            "{key} 도구: {}건 전송 (신규 {} · 중복 {})",
                            chunk.len(),
                            result.inserted,
                            result.deduped
                        ),
                        post::EndpointResult::Unsupported => {
                            if target_still_exists(target, global_state) {
                                post::mark_unsupported(state_dir, "tool-events");
                            }
                            tools_ok = false;
                            break;
                        }
                        post::EndpointResult::Unauthorized => {
                            eprintln!(
                                "toard-shim: {key} 도구 전송 실패 — 토큰이 유효하지 않습니다"
                            );
                            tools_ok = false;
                            failed = true;
                            break;
                        }
                        post::EndpointResult::Err(error) => {
                            eprintln!("toard-shim: {key} 도구 전송 실패 — {error}");
                            tools_ok = false;
                            failed = true;
                            break;
                        }
                    }
                }
            }
            if tools_ok && target_still_exists(target, global_state) {
                for (path, state) in tool_updates {
                    tool_cur.files.insert(path, state);
                }
                let alive = files
                    .iter()
                    .map(|file| file.display().to_string())
                    .collect::<std::collections::HashSet<_>>();
                tool_cur.files.retain(|path, _| alive.contains(path));
                cursor::save(state_dir, &tool_cursor_key, &tool_cur);
            }
        }
    }

    // 본문 수집(opt-in) — usage 경로와 완전 분리된 커서·엔드포인트. usage 루프는 무영향.
    if target_content_mode(creds).is_enabled() {
        // 백필 컷오프: 미설정=지금부터(최초 활성화 시각 기록), 날짜/all 지정 시 과거 포함.
        let since_ms =
            content_since_ms_for_state(state_dir, creds.collect_content_since.as_deref(), dry_run);
        let context = ContentRunContext {
            endpoint,
            token: token.as_deref(),
            credentials: creds,
            dry_run,
            quiet,
            since_ms,
            state_dir,
            transport,
            credentials_path: &target.credentials_path,
            global_state,
        };
        for adapter in prepared_adapters {
            let key = adapter.key();
            if only.is_some_and(|o| o != key) {
                continue;
            }
            if collect_content_for(adapter.as_ref(), &context) {
                failed = true;
            }
        }
    }

    if collect_tools && only.is_none() && post::unsupported_probe_due(state_dir, "tool-inventory") {
        if let Some(pending) = inventory::prepare_inventory(global_state, host, dry_run) {
            if inventory::needs_delivery(state_dir, &pending) && dry_run {
                println!("도구 인벤토리: 변경 감지 → 전송 대상 [dry-run]");
            } else if inventory::needs_delivery(state_dir, &pending) {
                let token = token.as_deref().expect("dry_run 아니면 토큰 존재");
                match transport.put_tool_inventory(endpoint, token, &pending.body) {
                    post::EndpointResult::Ok(_) => {
                        if target_still_exists(target, global_state) {
                            match inventory::commit_delivery(state_dir, &pending) {
                                Ok(()) => println!("도구 인벤토리: 최신 스냅샷 전송"),
                                Err(error) => {
                                    eprintln!("toard-shim: 도구 인벤토리 상태 저장 실패 — {error}");
                                    failed = true;
                                }
                            }
                        }
                    }
                    post::EndpointResult::Unsupported => {
                        if target_still_exists(target, global_state) {
                            post::mark_unsupported(state_dir, "tool-inventory")
                        }
                    }
                    post::EndpointResult::Unauthorized => {
                        eprintln!("toard-shim: 도구 인벤토리 전송 실패 — 토큰이 유효하지 않습니다");
                        failed = true;
                    }
                    post::EndpointResult::Err(error) => {
                        eprintln!("toard-shim: 도구 인벤토리 전송 실패 — {error}");
                        failed = true;
                    }
                }
            }
        }
    }

    if !matched {
        eprintln!(
            "toard-shim: 어댑터를 찾을 수 없습니다: {}",
            only.unwrap_or("?")
        );
        return 2;
    }
    i32::from(failed)
}

/// 본문 전송용 endpoint 안전성 — https 또는 로컬(localhost/127.0.0.1/[::1])만 허용.
/// 평문 http 로 원격에 프롬프트 본문을 보내지 않기 위한 가드(토큰 카운트 usage 경로는 무관).
fn endpoint_is_secure(endpoint: &str) -> bool {
    let e = endpoint.trim();
    if e.starts_with("https://") {
        return true;
    }
    match e.strip_prefix("http://") {
        Some(rest) => {
            let authority = rest.split('/').next().unwrap_or("");
            let authority = authority.rsplit('@').next().unwrap_or(authority);
            if authority.starts_with("[::1]") {
                return true;
            }
            let host = authority.split(':').next().unwrap_or(authority);
            host == "localhost" || host == "127.0.0.1"
        }
        None => false,
    }
}

/// 한 어댑터의 본문 수집: 별도 커서(`{key}-content`)로 변한 파일만 재파싱 →
/// 봉투 전 평문을 /v1/prompts 로 전송. 반환은 "실패 여부"(true 면 커서 미갱신·재시도).
struct ContentRunContext<'a> {
    endpoint: &'a str,
    token: Option<&'a str>,
    credentials: &'a crate::credentials::Credentials,
    dry_run: bool,
    quiet: bool,
    since_ms: i64,
    state_dir: &'a Path,
    transport: &'a dyn post::Transport,
    credentials_path: &'a Path,
    global_state: &'a Path,
}

fn collect_content_for(adapter: &dyn LogAdapter, context: &ContentRunContext<'_>) -> bool {
    let ContentRunContext {
        endpoint,
        token,
        credentials,
        dry_run,
        quiet,
        since_ms,
        state_dir,
        transport,
        credentials_path,
        global_state,
    } = context;
    let key = adapter.key();
    // 본문은 https(또는 로컬) endpoint 로만 — 평문 http 로 원격 전송 차단
    let secure = endpoint_is_secure(endpoint);
    if !*dry_run && !secure {
        eprintln!(
            "toard-shim: {key} 본문 수집 건너뜀 — 안전하지 않은 endpoint({endpoint}). 평문 HTTP 로는 본문을 전송하지 않습니다(https 또는 localhost 필요)."
        );
        return false;
    }
    let cursor_key = format!("{key}-content");
    let files = adapter.discover_files();
    let mut cur = cursor::load(state_dir, &cursor_key);

    // usage 루프와 동일한 파일별 전송 필터 — since 는 최초 opt-in 시각으로 고정되므로
    // 컷오프 필터 결과도 파일 내용에 대해 결정적이라 prefix 판정이 유효하다.
    let mut changed = 0usize;
    let mut parsed_total = 0usize;
    let mut records: Vec<RawContent> = Vec::new();
    let mut updates: Vec<(String, cursor::FileState)> = Vec::new();
    for file in &files {
        let Some(stamp) = cursor::stamp(file) else {
            continue;
        };
        let path = file.display().to_string();
        if cur.files.get(&path).map(|s| s.stamp()) == Some(stamp) {
            continue;
        }
        changed += 1;
        let mut file_records = adapter.parse_content(file);
        // 백필 컷오프 — since 이전 턴은 제외(파일이 append 돼도 옛 턴은 안 보냄).
        file_records.retain(|r| r.ts_ms >= *since_ms);
        parsed_total += file_records.len();
        let keys: Vec<String> = file_records
            .iter()
            .map(|r| content_dedup_key(key, r))
            .collect();
        let key_refs: Vec<&str> = keys.iter().map(String::as_str).collect();
        let prev = cur.files.get(&path);
        let start = resume_index(
            prev.map_or(0, |s| s.sent),
            prev.map_or("", |s| s.sent_hash.as_str()),
            &key_refs,
        );
        updates.push((
            path,
            cursor::FileState {
                mtime_ms: stamp.mtime_ms,
                size: stamp.size,
                sent: key_refs.len() as u64,
                sent_hash: keys_hash(&key_refs),
            },
        ));
        records.extend(file_records.into_iter().skip(start));
    }

    if *dry_run {
        let scheme = match credentials.collect_content {
            crate::credentials::ContentCollectionMode::E2eeV1 => "e2ee_v1",
            crate::credentials::ContentCollectionMode::ServerV1 => "server_v1",
            crate::credentials::ContentCollectionMode::Off => "off",
        };
        println!(
            "{key} 본문: 파일 {}개 (변경 {changed}개) → 레코드 {parsed_total}건, 전송 대상 {}건 · {scheme} (since {}) [dry-run]",
            files.len(),
            records.len(),
            if *since_ms <= 0 {
                "전체".to_string()
            } else {
                iso::epoch_ms_to_iso(*since_ms)
            }
        );
        if !secure {
            println!(
                "  (주의: endpoint 가 https/localhost 아님 — 실제 실행 시 본문 전송은 차단됩니다)"
            );
        }
        return false;
    }

    if records.is_empty() {
        if !*quiet {
            println!("{key} 본문: 새 레코드 없음 (변경 {changed}개)");
        }
    } else {
        use crate::content_keys::{ContentKeyStore, SystemContentKeyStore};
        let e2ee_material = match credentials.collect_content {
            crate::credentials::ContentCollectionMode::E2eeV1 => {
                let Some(owner_id) = credentials.content_owner_id.as_deref() else {
                    eprintln!("toard-shim: {key} E2EE 수집 실패 — 콘텐츠 소유자 설정이 없습니다");
                    return true;
                };
                let Some(key_version) = credentials.content_key_version else {
                    eprintln!("toard-shim: {key} E2EE 수집 실패 — 콘텐츠 키 버전 설정이 없습니다");
                    return true;
                };
                let uck = match SystemContentKeyStore.get_uck(owner_id, key_version) {
                    Ok(uck) => uck,
                    Err(_) => {
                        eprintln!("toard-shim: {key} E2EE 수집 실패 — 운영체제 보안 저장소에서 콘텐츠 키를 불러올 수 없습니다");
                        return true;
                    }
                };
                Some((owner_id, key_version, uck))
            }
            crate::credentials::ContentCollectionMode::ServerV1 => None,
            crate::credentials::ContentCollectionMode::Off => return false,
        };
        let token = token.expect("dry_run 아니면 토큰 존재");
        let (mut inserted, mut deduped) = (0u64, 0u64);
        for chunk in records.chunks(CHUNK) {
            let body = match &e2ee_material {
                Some((owner_id, key_version, uck)) => {
                    match to_e2ee_prompts_body(key, owner_id, *key_version, uck, chunk) {
                        Ok(body) => body,
                        Err(_) => {
                            eprintln!(
                                "toard-shim: {key} E2EE 수집 실패 — 로컬 암호화에 실패했습니다"
                            );
                            return true;
                        }
                    }
                }
                None => to_prompts_body(key, chunk),
            };
            match transport.post_prompts(endpoint, token, &body) {
                Ok(Some(r)) => {
                    inserted += r.inserted;
                    deduped += r.deduped;
                }
                Ok(None) => {
                    // 서버에서 본문 수집이 비활성(503) — 실패 아님. 커서 미갱신하고 종료(추후 활성 시 재전송)
                    println!("{key} 본문: 서버에서 비활성(503) — 건너뜀");
                    return false;
                }
                Err(e) => {
                    eprintln!("toard-shim: {key} 본문 전송 실패 — {e}");
                    // 커서를 갱신하지 않음 → 다음 실행에서 재시도 (dedup 이 중복 흡수)
                    return true;
                }
            }
        }
        println!(
            "{key} 본문: {}건 전송 (신규 {inserted} · 중복 {deduped})",
            records.len()
        );
    }

    if *state_dir != *global_state && !credentials_path.is_file() {
        return false;
    }
    for (path, state) in updates {
        cur.files.insert(path, state);
    }
    let alive: std::collections::HashSet<String> =
        files.iter().map(|f| f.display().to_string()).collect();
    cur.files.retain(|k, _| alive.contains(k));
    cursor::save(state_dir, &cursor_key, &cur);
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    struct FanoutTestAdapter {
        file: PathBuf,
        parse_calls: Rc<Cell<usize>>,
    }

    struct ContentFanoutTestAdapter {
        file: PathBuf,
        parse_calls: Rc<Cell<usize>>,
    }

    impl LogAdapter for ContentFanoutTestAdapter {
        fn key(&self) -> &'static str {
            "content_fanout_test"
        }

        fn collects_usage(&self) -> bool {
            false
        }

        fn discover_files(&self) -> Vec<PathBuf> {
            vec![self.file.clone()]
        }

        fn parse_file(&self, _path: &Path) -> Vec<RawUsage> {
            Vec::new()
        }

        fn parse_changed(
            &self,
            _path: &Path,
            include_content: bool,
            _include_tools: bool,
        ) -> ParsedLog {
            self.parse_calls.set(self.parse_calls.get() + 1);
            ParsedLog {
                content: include_content
                    .then(|| RawContent {
                        ts_ms: 1_700_000_000_000,
                        session_id: Some("session-1".into()),
                        message_id: Some("content-1".into()),
                        role: "user",
                        text: "prompt".into(),
                    })
                    .into_iter()
                    .collect(),
                ..ParsedLog::default()
            }
        }
    }

    impl LogAdapter for FanoutTestAdapter {
        fn key(&self) -> &'static str {
            "fanout_test"
        }

        fn discover_files(&self) -> Vec<PathBuf> {
            vec![self.file.clone()]
        }

        fn parse_file(&self, _path: &Path) -> Vec<RawUsage> {
            self.parse_calls.set(self.parse_calls.get() + 1);
            vec![RawUsage {
                ts_ms: 1_700_000_000_000,
                session_id: Some("session-1".into()),
                model: Some("test-model".into()),
                message_id: Some("message-1".into()),
                input_tokens: 10,
                output_tokens: 20,
                ..RawUsage::default()
            }]
        }
    }

    #[derive(Default)]
    struct FanoutTestTransport {
        calls: RefCell<Vec<String>>,
        fail_company: Cell<bool>,
        remove_target: RefCell<Option<PathBuf>>,
        prompt_calls: RefCell<Vec<String>>,
        fail_company_prompts: Cell<bool>,
    }

    impl post::Transport for FanoutTestTransport {
        fn post_events(
            &self,
            endpoint: &str,
            _token: &str,
            _body: &str,
        ) -> Result<post::PostResult, String> {
            self.calls.borrow_mut().push(endpoint.to_string());
            if let Some(path) = self.remove_target.borrow_mut().take() {
                std::fs::remove_dir_all(path).unwrap();
            }
            if endpoint.contains("company") && self.fail_company.get() {
                Err("unreachable".into())
            } else {
                Ok(post::PostResult {
                    inserted: 1,
                    ..post::PostResult::default()
                })
            }
        }

        fn post_prompts(
            &self,
            endpoint: &str,
            _token: &str,
            _body: &str,
        ) -> Result<Option<post::PostResult>, String> {
            self.prompt_calls.borrow_mut().push(endpoint.to_string());
            if endpoint.contains("company") && self.fail_company_prompts.get() {
                Err("unreachable".into())
            } else {
                Ok(Some(post::PostResult {
                    inserted: 1,
                    ..post::PostResult::default()
                }))
            }
        }

        fn post_tool_events(
            &self,
            _endpoint: &str,
            _token: &str,
            _body: &str,
        ) -> post::EndpointResult {
            post::EndpointResult::Unsupported
        }

        fn post_usage_reconciliation(
            &self,
            _endpoint: &str,
            _token: &str,
            _body: &str,
        ) -> post::EndpointResult {
            post::EndpointResult::Unsupported
        }

        fn put_tool_inventory(
            &self,
            _endpoint: &str,
            _token: &str,
            _body: &str,
        ) -> post::EndpointResult {
            post::EndpointResult::Unsupported
        }
    }

    #[test]
    fn parse_since_accepts_date_and_iso() {
        // 날짜만 → 그날 00:00 UTC
        assert_eq!(
            parse_since("2026-07-01"),
            iso::iso_to_epoch_ms("2026-07-01T00:00:00Z")
        );
        // 완전한 ISO
        assert_eq!(
            parse_since("2026-07-01T12:00:00Z"),
            iso::iso_to_epoch_ms("2026-07-01T12:00:00Z")
        );
        assert_eq!(parse_since("nonsense"), None);
    }

    #[test]
    fn failed_target_does_not_block_or_advance_successful_target() {
        let root = std::env::temp_dir().join(format!(
            "toard-fanout-run-{}-{}",
            std::process::id(),
            crate::bg::now_unix()
        ));
        let file = root.join("session.jsonl");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&file, "fixture").unwrap();
        let store = crate::targets::TargetStore::from_root(root.join(".toard"));
        let target_credentials = |token: &str, endpoint: &str| crate::credentials::Credentials {
            token: Some(token.into()),
            endpoint: Some(endpoint.into()),
            collect_tools: false,
            ..crate::credentials::Credentials::default()
        };
        let company = store
            .upsert(target_credentials(
                "company-token",
                "https://company.example/api",
            ))
            .unwrap();
        let personal = store
            .upsert(target_credentials(
                "personal-token",
                "https://personal.example/api",
            ))
            .unwrap();
        let parse_calls = Rc::new(Cell::new(0));
        let transport = FanoutTestTransport::default();
        transport.fail_company.set(true);

        let code = run_with(
            &store,
            &transport,
            vec![Box::new(FanoutTestAdapter {
                file,
                parse_calls: Rc::clone(&parse_calls),
            })],
            Some("fanout_test"),
            false,
            true,
        );

        assert_eq!(code, 1);
        assert_eq!(parse_calls.get(), 1);
        assert!(cursor::load(&company.state_dir, "fanout_test")
            .files
            .is_empty());
        assert_eq!(
            cursor::load(&personal.state_dir, "fanout_test").files.len(),
            1
        );
        assert_eq!(transport.calls.borrow().len(), 2);

        transport.fail_company.set(false);
        transport.calls.borrow_mut().clear();
        let recovery_code = run_with(
            &store,
            &transport,
            vec![Box::new(FanoutTestAdapter {
                file: root.join("session.jsonl"),
                parse_calls: Rc::clone(&parse_calls),
            })],
            Some("fanout_test"),
            false,
            true,
        );
        assert_eq!(recovery_code, 0);
        assert_eq!(
            parse_calls.get(),
            2,
            "각 collect 실행에서 파일을 한 번만 파싱"
        );
        assert_eq!(
            cursor::load(&company.state_dir, "fanout_test").files.len(),
            1
        );
        assert_eq!(
            cursor::load(&personal.state_dir, "fanout_test").files.len(),
            1
        );
        assert_eq!(
            transport.calls.borrow().as_slice(),
            ["https://company.example/api"],
            "복구 실행은 실패했던 company suffix만 전송"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn removed_target_is_not_recreated_when_delivery_finishes() {
        let root = std::env::temp_dir().join(format!(
            "toard-fanout-remove-race-{}-{}",
            std::process::id(),
            crate::bg::now_unix()
        ));
        let file = root.join("session.jsonl");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&file, "fixture").unwrap();
        let store = crate::targets::TargetStore::from_root(root.join(".toard"));
        let target = store
            .upsert(crate::credentials::Credentials {
                token: Some("personal-token".into()),
                endpoint: Some("https://personal.example/api".into()),
                collect_tools: false,
                ..crate::credentials::Credentials::default()
            })
            .unwrap();
        let target_dir = target.state_dir.parent().unwrap().to_path_buf();
        let transport = FanoutTestTransport::default();
        *transport.remove_target.borrow_mut() = Some(target_dir.clone());

        let code = run_with(
            &store,
            &transport,
            vec![Box::new(FanoutTestAdapter {
                file,
                parse_calls: Rc::new(Cell::new(0)),
            })],
            Some("fanout_test"),
            false,
            true,
        );

        assert_eq!(code, 0);
        assert!(!target_dir.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn content_failure_is_isolated_per_target_after_one_parse() {
        let root = std::env::temp_dir().join(format!(
            "toard-content-fanout-{}-{}",
            std::process::id(),
            crate::bg::now_unix()
        ));
        let file = root.join("session.jsonl");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(&file, "fixture").unwrap();
        let store = crate::targets::TargetStore::from_root(root.join(".toard"));
        let credentials = |token: &str, endpoint: &str| crate::credentials::Credentials {
            token: Some(token.into()),
            endpoint: Some(endpoint.into()),
            collect_content: crate::credentials::ContentCollectionMode::ServerV1,
            collect_content_since: Some("all".into()),
            collect_tools: false,
            ..crate::credentials::Credentials::default()
        };
        let company = store
            .upsert(credentials("company-token", "https://company.example/api"))
            .unwrap();
        let personal = store
            .upsert(credentials(
                "personal-token",
                "https://personal.example/api",
            ))
            .unwrap();
        let parse_calls = Rc::new(Cell::new(0));
        let transport = FanoutTestTransport::default();
        transport.fail_company_prompts.set(true);

        let code = run_with(
            &store,
            &transport,
            vec![Box::new(ContentFanoutTestAdapter {
                file,
                parse_calls: Rc::clone(&parse_calls),
            })],
            Some("content_fanout_test"),
            false,
            true,
        );

        assert_eq!(code, 1);
        assert_eq!(parse_calls.get(), 1);
        assert!(
            cursor::load(&company.state_dir, "content_fanout_test-content")
                .files
                .is_empty()
        );
        assert_eq!(
            cursor::load(&personal.state_dir, "content_fanout_test-content")
                .files
                .len(),
            1
        );
        assert_eq!(transport.prompt_calls.borrow().len(), 2);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn content_since_cutoff_resolution() {
        // all/0 → 전량 백필(컷오프 0)
        assert_eq!(content_since_ms(Some("all"), true), 0);
        assert_eq!(content_since_ms(Some(" 0 "), true), 0);
        // 날짜 지정 → 그 시점
        assert_eq!(
            content_since_ms(Some("2026-06-01"), true),
            parse_since("2026-06-01").unwrap()
        );
        // 미설정·잘못된 값 → 기본(지금부터). dry_run 이라 state 미기록, 양수 타임스탬프.
        assert!(content_since_ms(None, true) > 0);
        assert!(content_since_ms(Some("bad-date"), true) > 0);
    }

    #[test]
    fn resume_index_sends_only_appended_tail() {
        let keys = ["k1", "k2", "k3", "k4"];
        let h2 = keys_hash(&keys[..2]);
        // 이전 2건 전송 + prefix 불변(append) → 3번째부터
        assert_eq!(resume_index(2, &h2, &keys), 2);
        // 전량 이미 전송 → 신규 없음
        assert_eq!(resume_index(4, &keys_hash(&keys), &keys), 4);
        // 첫 수집(진행 기록 없음) → 처음부터
        assert_eq!(resume_index(0, "", &keys), 0);
        // 구버전 커서(카운트만 있고 해시 없음) → 처음부터 (폴백)
        assert_eq!(resume_index(2, "", &keys), 0);
        // 파일 재작성으로 prefix 가 달라짐 → 처음부터 (서버 dedup 이 흡수)
        assert_eq!(resume_index(2, &keys_hash(&["x1", "x2"]), &keys), 0);
        // 파일이 줄어듦(sent > len) → 처음부터
        assert_eq!(resume_index(9, &h2, &keys), 0);
    }

    #[test]
    fn codex_reconciliation_forces_legacy_cursor_scan_only_when_probe_is_due() {
        assert!(reconciliation_active("codex", 0, true, false));
        assert!(!reconciliation_active("codex", 0, false, false));
        assert!(!reconciliation_active("codex", 1, true, false));
        assert!(!reconciliation_active("claude", 0, true, false));
        assert!(reconciliation_active("codex", 1, false, true));
    }

    #[test]
    fn replay_reconciliation_body_contains_keys_only() {
        let body = to_reconciliation_body(&["a".repeat(64), "b".repeat(64)]);
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value.as_object().unwrap().len(), 1);
        assert_eq!(value["dedupKeys"].as_array().unwrap().len(), 2);
        assert!(body.find("session").is_none());
    }

    #[test]
    fn reconciliation_never_retracts_a_key_also_seen_as_legitimate() {
        let legitimate = std::collections::HashSet::from(["keep".to_string()]);
        assert_eq!(
            reconciliation_keys(
                vec!["keep".into(), "remove".into(), "remove".into()],
                &legitimate,
            ),
            vec!["remove".to_string()],
        );
    }

    #[test]
    fn dedup_key_prefers_message_id_and_is_stable() {
        let r = RawUsage {
            ts_ms: 1_700_000_000_000,
            session_id: Some("s1".into()),
            model: Some("gemini-2.5-pro".into()),
            message_id: Some("msg-1".into()),
            input_tokens: 10,
            output_tokens: 20,
            ..Default::default()
        };
        let a = dedup_key("gemini", &r);
        assert_eq!(a, dedup_key("gemini", &r), "동일 입력 → 동일 키");
        // ts 가 달라져도 message_id 기반 키는 불변 (세션 파일 재작성에 견딤)
        let mut r2 = r.clone();
        r2.ts_ms += 1000;
        assert_eq!(a, dedup_key("gemini", &r2));
        // id 없으면 ts 포함 폴백 키
        let mut r3 = r.clone();
        r3.message_id = None;
        assert_ne!(a, dedup_key("gemini", &r3));
        assert_ne!(
            dedup_key("gemini", &r3),
            dedup_key("qwen", &r3),
            "어댑터 격리"
        );
    }

    #[test]
    fn to_usage_event_enforces_trust_boundary() {
        let r = RawUsage {
            ts_ms: 1_782_907_200_000,
            session_id: Some("s".into()),
            model: Some("m".into()),
            input_tokens: 1,
            output_tokens: 2,
            cache_creation_tokens: 10,
            cache_creation_1h_tokens: 4,
            ..Default::default()
        };
        let e = to_usage_event("gemini", &r, Some("box-7"));
        assert_eq!(e.user_id, None);
        assert_eq!(e.cost_usd, 0.0);
        assert_eq!(e.ts, "2026-07-01T12:00:00.000Z");
        assert_eq!(e.log_adapter.as_deref(), Some("gemini"));
        assert_eq!(e.provider_key, "gemini");
        assert_eq!(
            e.cache_creation_1h_tokens, 4,
            "1h 힌트가 UsageEvent 로 전달"
        );
        assert_eq!(e.host.as_deref(), Some("box-7"), "host 부착");
        // host 미상(None)도 안전
        assert_eq!(to_usage_event("gemini", &r, None).host, None);
    }

    fn sample_content() -> RawContent {
        RawContent {
            ts_ms: 1_782_907_200_000,
            session_id: Some("s".into()),
            message_id: Some("m1".into()),
            role: "user",
            text: "hi".into(),
        }
    }

    #[test]
    fn content_dedup_key_stable_text_sensitive_and_namespaced() {
        let base = sample_content();
        let k = content_dedup_key("gemini", &base);
        assert_eq!(k, content_dedup_key("gemini", &base), "동일 입력 → 동일 키");

        let mut edited = base.clone();
        edited.text = "hello".into();
        assert_ne!(
            k,
            content_dedup_key("gemini", &edited),
            "텍스트 변경 → 다른 키"
        );

        let mut asst = base.clone();
        asst.role = "assistant";
        assert_ne!(k, content_dedup_key("gemini", &asst), "role 변경 → 다른 키");

        assert_ne!(k, content_dedup_key("qwen", &base), "어댑터 격리");

        // usage 키(dedup_key)와 네임스페이스 분리 — 같은 재료라도 충돌하지 않는다
        let usage = RawUsage {
            ts_ms: base.ts_ms,
            session_id: base.session_id.clone(),
            model: None,
            message_id: base.message_id.clone(),
            ..Default::default()
        };
        assert_ne!(k, dedup_key("gemini", &usage), "usage 와 content 키 분리");
    }

    #[test]
    fn to_prompts_body_wire_shape() {
        let r = RawContent {
            session_id: None,
            message_id: None,
            role: "assistant",
            text: "응답".into(),
            ..sample_content()
        };
        let body = to_prompts_body("gemini", std::slice::from_ref(&r));
        let v: crate::json::Value = crate::json::parse(&body).expect("유효한 JSON");
        let crate::json::Value::Array(arr) = v else {
            panic!("배열이어야 함")
        };
        assert_eq!(arr.len(), 1);
        let o = &arr[0];
        assert_eq!(
            o.get("providerKey").and_then(|v| v.as_str()),
            Some("gemini")
        );
        assert_eq!(
            o.get("turnRole").and_then(|v| v.as_str()),
            Some("assistant")
        );
        assert_eq!(
            o.get("ts").and_then(|v| v.as_str()),
            Some("2026-07-01T12:00:00.000Z")
        );
        assert_eq!(o.get("text").and_then(|v| v.as_str()), Some("응답"));
        assert!(matches!(o.get("sessionId"), Some(crate::json::Value::Null)));
        assert_eq!(
            o.get("dedupKey").and_then(|v| v.as_str()).map(str::len),
            Some(64),
            "sha256 hex"
        );
    }

    #[test]
    fn to_e2ee_prompts_body_contains_ciphertext_only() {
        let mut record = sample_content();
        record.text = "secret prompt".into();
        let body = to_e2ee_prompts_body(
            "codex",
            "018f47d0-4d47-7b04-950b-7d18a86e1b43",
            1,
            &[7u8; 32],
            &[record],
        )
        .unwrap();
        assert!(!body.contains("secret prompt"));
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value[0]["schema"], "e2ee_v1");
        assert_eq!(value[0]["algorithm"], "AES-256-GCM");
        assert!(value[0].get("text").is_none());
        assert!(value[0]["ciphertext"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
    }

    #[test]
    fn content_enabled_env_overrides_credentials() {
        use crate::collect::gemini_family::testutil::EnvGuard;
        use std::ffi::OsStr;
        {
            let _g = EnvGuard::set("TOARD_SHIM_COLLECT_CONTENT", OsStr::new("1"));
            assert!(content_enabled(), "env 1 → 켜짐");
        }
        {
            let _g = EnvGuard::set("TOARD_SHIM_COLLECT_CONTENT", OsStr::new("off"));
            assert!(!content_enabled(), "env off → 꺼짐(credentials 무시)");
        }
    }

    #[test]
    fn tool_baseline_seeds_stamps_without_events() {
        let files = vec![
            (
                "/tmp/a.jsonl".to_string(),
                cursor::FileStamp {
                    mtime_ms: 1,
                    size: 10,
                },
            ),
            (
                "/tmp/b.jsonl".to_string(),
                cursor::FileStamp {
                    mtime_ms: 2,
                    size: 20,
                },
            ),
        ];
        let cursor = seed_tool_baseline(&files);
        assert_eq!(cursor.files.len(), 2);
        assert_eq!(cursor.files["/tmp/a.jsonl"].sent, 0);
    }

    #[test]
    fn unsupported_backoff_skips_tool_parse_until_probe_is_due() {
        assert!(!should_parse_tool_file(
            true, false, false, true, false, false
        ));
        assert!(should_parse_tool_file(
            true, true, false, true, false, false
        ));
        assert!(!should_parse_tool_file(
            true, true, false, true, true, false
        ));
        assert!(should_parse_tool_file(
            false, false, false, true, true, true
        ));
    }

    #[test]
    fn endpoint_secure_allows_https_and_localhost_only() {
        // https 는 어떤 호스트든 허용
        assert!(endpoint_is_secure("https://toard.corp.com/api"));
        // http 는 로컬만 허용 (dev)
        assert!(endpoint_is_secure("http://localhost:3000/api"));
        assert!(endpoint_is_secure("http://127.0.0.1:3000/api"));
        assert!(endpoint_is_secure("http://[::1]:3000/api"));
        // http 원격은 차단 — 평문 본문 전송 방지
        assert!(!endpoint_is_secure("http://toard.corp.com/api"));
        // localhost 로 시작하는 위장 호스트도 차단
        assert!(!endpoint_is_secure("http://localhost.evil.com/api"));
        // 스킴 없음/빈 값 → 안전하지 않음
        assert!(!endpoint_is_secure("toard.corp.com/api"));
        assert!(!endpoint_is_secure(""));
    }
}
