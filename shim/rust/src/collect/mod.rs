// 범용 로컬 로그 pull 수집 (설계 §5.6, ADR-002/006 — 2차).
// 비-OTEL 도구의 로컬 로그를 어댑터로 파싱해 UsageEvent[] 로 정규화하고
// POST /api/v1/events 로 보낸다. 토큰 카운트까지만 — user/cost 는 서버 권위.

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod gemini;
pub mod gemini_family;
pub mod post;
pub mod qwen;

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::bg;
use crate::credentials::{read_credentials, DEFAULT_ENDPOINT};
use crate::fsx;
use crate::iso;
use crate::usage_event::{to_events_body, UsageEvent};

/// 내부 argv — wrap 실행에 편승하는 백그라운드 수집 (자동 업데이트와 동일 패턴)
pub const SPAWN_ARG: &str = "___toard-spawn-collector";
pub const RUN_ARG: &str = "___toard-collect";
const DEFAULT_INTERVAL_SECS: u64 = 600;

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
}

/// 어댑터가 로그에서 뽑는 원시 본문 레코드 (프롬프트/응답 텍스트).
/// opt-in(TOARD_SHIM_COLLECT_CONTENT)일 때만 수집되며, 암호화는 서버 몫(shim 은 평문 전송).
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
}

pub fn adapters() -> Vec<Box<dyn LogAdapter>> {
    vec![
        Box::new(gemini::Gemini),
        Box::new(qwen::Qwen),
        Box::new(claude::Claude),
        Box::new(codex::Codex),
    ]
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
        cost_usd: 0.0,
        log_adapter: Some(adapter.to_string()),
        host: host.map(String::from),
    }
}

/// 본문 수집 opt-in — 기본 off. 이게 켜져야 shim 이 프롬프트/응답 본문을 담는다.
/// env(TOARD_SHIM_COLLECT_CONTENT)가 명시되면 그 값이 우선하고, 미설정이면
/// `~/.toard/credentials` 의 `collect_content` 플래그(install.sh 가 기록)를 따른다.
/// (§신뢰경계: shim 의 "본문 안 읽음"을 여는 스위치라 명시적 opt-in)
pub fn content_enabled() -> bool {
    match std::env::var("TOARD_SHIM_COLLECT_CONTENT").ok().as_deref() {
        Some("1" | "true" | "on") => true,
        Some("0" | "false" | "off") => false,
        _ => read_credentials().collect_content,
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
fn content_since_ms(since_cfg: Option<&str>, dry_run: bool) -> i64 {
    match since_cfg.map(str::trim) {
        Some("all") | Some("0") => 0,
        Some(s) if !s.is_empty() => parse_since(s).unwrap_or_else(|| default_since_ms(dry_run)),
        _ => default_since_ms(dry_run),
    }
}

/// 미설정 기본 = 최초 활성화 시각(state 파일에 지속). 없으면 now 를 기록하고 반환.
fn default_since_ms(dry_run: bool) -> i64 {
    let now = now_epoch_ms();
    let Some(path) = fsx::state_dir().map(|d| d.join("content-since")) else {
        return now;
    };
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

const CHUNK: usize = 1000;

/// `toard-shim collect` 본체. only=특정 어댑터만, dry_run=파싱 결과만 출력.
pub fn run(only: Option<&str>, dry_run: bool) -> i32 {
    let creds = read_credentials();
    let endpoint = creds
        .endpoint
        .as_deref()
        .unwrap_or(DEFAULT_ENDPOINT)
        .to_string();
    let token = match (&creds.token, dry_run) {
        (Some(t), _) => Some(t.clone()),
        (None, true) => None,
        (None, false) => {
            eprintln!("toard-shim: 자격 증명이 없습니다 — ~/.toard/credentials 또는 TOARD_INGEST_TOKEN 설정");
            return 1;
        }
    };

    // host 라벨은 수집 실행당 1회만 계산(hostname 명령 fork 최소화 — 컴퓨터별 구분, §design-host-breakdown)
    let host = crate::host::host_label();

    let mut failed = false;
    let mut matched = false;
    for adapter in adapters() {
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
        let mut cur = cursor::load(key);
        let mut changed: Vec<(PathBuf, cursor::FileStamp)> = Vec::new();
        for file in &files {
            let Some(stamp) = cursor::stamp(file) else {
                continue;
            };
            if cur.files.get(&file.display().to_string()) != Some(&stamp) {
                changed.push((file.clone(), stamp));
            }
        }

        let mut events: Vec<UsageEvent> = Vec::new();
        for (file, _) in &changed {
            for raw in adapter.parse_file(file) {
                events.push(to_usage_event(key, &raw, host.as_deref()));
            }
        }

        if dry_run {
            println!(
                "{key}: 파일 {}개 (변경 {}개) → 이벤트 {}건 [dry-run]",
                files.len(),
                changed.len(),
                events.len()
            );
            continue;
        }
        if events.is_empty() {
            println!(
                "{key}: 새 이벤트 없음 (파일 {}개, 변경 {}개)",
                files.len(),
                changed.len()
            );
            // 이벤트 0건이어도 stamp 는 갱신해 다음 실행의 재파싱을 줄인다
        } else {
            let token = token.as_deref().expect("dry_run 아니면 토큰 존재");
            let (mut inserted, mut deduped) = (0u64, 0u64);
            let mut post_failed = false;
            for chunk in events.chunks(CHUNK) {
                match post::post_events(&endpoint, token, &to_events_body(chunk)) {
                    Ok(r) => {
                        inserted += r.inserted;
                        deduped += r.deduped;
                    }
                    Err(e) => {
                        eprintln!("toard-shim: {key} 전송 실패 — {e}");
                        post_failed = true;
                        break;
                    }
                }
            }
            if post_failed {
                // 커서를 갱신하지 않음 → 다음 실행에서 재시도 (dedup 이 중복 흡수)
                failed = true;
                continue;
            }
            println!(
                "{key}: 이벤트 {}건 전송 (신규 {inserted} · 중복 {deduped})",
                events.len()
            );
        }

        for (file, stamp) in changed {
            cur.files.insert(file.display().to_string(), stamp);
        }
        // 사라진 파일의 커서 정리
        let alive: std::collections::HashSet<String> =
            files.iter().map(|f| f.display().to_string()).collect();
        cur.files.retain(|k, _| alive.contains(k));
        cursor::save(key, &cur);
    }

    // 본문 수집(opt-in) — usage 경로와 완전 분리된 커서·엔드포인트. usage 루프는 무영향.
    if content_enabled() {
        // 백필 컷오프: 미설정=지금부터(최초 활성화 시각 기록), 날짜/all 지정 시 과거 포함.
        let since_ms = content_since_ms(creds.collect_content_since.as_deref(), dry_run);
        for adapter in adapters() {
            let key = adapter.key();
            if only.is_some_and(|o| o != key) {
                continue;
            }
            if collect_content_for(
                adapter.as_ref(),
                &endpoint,
                token.as_deref(),
                dry_run,
                since_ms,
            ) {
                failed = true;
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
fn collect_content_for(
    adapter: &dyn LogAdapter,
    endpoint: &str,
    token: Option<&str>,
    dry_run: bool,
    since_ms: i64,
) -> bool {
    let key = adapter.key();
    // 본문은 https(또는 로컬) endpoint 로만 — 평문 http 로 원격 전송 차단
    let secure = endpoint_is_secure(endpoint);
    if !dry_run && !secure {
        eprintln!(
            "toard-shim: {key} 본문 수집 건너뜀 — 안전하지 않은 endpoint({endpoint}). 평문 HTTP 로는 본문을 전송하지 않습니다(https 또는 localhost 필요)."
        );
        return false;
    }
    let cursor_key = format!("{key}-content");
    let files = adapter.discover_files();
    let mut cur = cursor::load(&cursor_key);

    let mut changed: Vec<(PathBuf, cursor::FileStamp)> = Vec::new();
    for file in &files {
        let Some(stamp) = cursor::stamp(file) else {
            continue;
        };
        if cur.files.get(&file.display().to_string()) != Some(&stamp) {
            changed.push((file.clone(), stamp));
        }
    }

    let mut records: Vec<RawContent> = Vec::new();
    for (file, _) in &changed {
        records.extend(adapter.parse_content(file));
    }
    // 백필 컷오프 — since 이전 턴은 제외(파일이 append 돼도 옛 턴은 안 보냄).
    records.retain(|r| r.ts_ms >= since_ms);

    if dry_run {
        println!(
            "{key} 본문: 파일 {}개 (변경 {}개) → 레코드 {}건 (since {}) [dry-run]",
            files.len(),
            changed.len(),
            records.len(),
            if since_ms <= 0 {
                "전체".to_string()
            } else {
                iso::epoch_ms_to_iso(since_ms)
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
        println!("{key} 본문: 새 레코드 없음 (변경 {}개)", changed.len());
    } else {
        let token = token.expect("dry_run 아니면 토큰 존재");
        let (mut inserted, mut deduped) = (0u64, 0u64);
        for chunk in records.chunks(CHUNK) {
            match post::post_prompts(endpoint, token, &to_prompts_body(key, chunk)) {
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

    for (file, stamp) in changed {
        cur.files.insert(file.display().to_string(), stamp);
    }
    let alive: std::collections::HashSet<String> =
        files.iter().map(|f| f.display().to_string()).collect();
    cur.files.retain(|k, _| alive.contains(k));
    cursor::save(&cursor_key, &cur);
    false
}

#[cfg(test)]
mod tests {
    use super::*;

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
            ..Default::default()
        };
        let e = to_usage_event("gemini", &r, Some("box-7"));
        assert_eq!(e.user_id, None);
        assert_eq!(e.cost_usd, 0.0);
        assert_eq!(e.ts, "2026-07-01T12:00:00.000Z");
        assert_eq!(e.log_adapter.as_deref(), Some("gemini"));
        assert_eq!(e.provider_key, "gemini");
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
