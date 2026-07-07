// 어댑터별 수집 커서 (~/.toard/state/cursors/{adapter}.json).
// 로컬 로그는 append 가 아니라 세션 파일이 제자리 갱신되는 형태라 오프셋 대신
// 파일 stamp(mtime+size) 를 기록하고, 변한 파일만 재파싱한다.
// 재파싱 후에도 전부 재전송하지 않도록 파일별 전송 진행(sent + prefix 해시)을 함께 기록 —
// 이전에 보낸 prefix 가 그대로면 그 뒤(신규분)만 전송한다(§전송 필터). 판정이 어긋나는
// 경우(파일 재작성 등)엔 전체 재전송으로 폴백하고 서버 dedup_key 멱등 저장이 흡수한다(§4.4).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fsx;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Cursor {
    #[serde(default)]
    pub files: HashMap<String, FileState>,
}

/// 파일 변경 판정용 stat 스냅샷 (mtime+size).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileStamp {
    pub mtime_ms: i64,
    pub size: u64,
}

/// 커서에 저장되는 파일별 상태 — 변경 판정(stamp) + 전송 진행(sent/sent_hash).
/// 구버전 커서({mtime_ms,size}만)는 sent=0·hash 빈 값으로 역직렬화돼 1회 전체 전송 후 승격.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileState {
    pub mtime_ms: i64,
    pub size: u64,
    /// 이 파일에서 지금까지 전송한 레코드 수 (파싱 순서 기준 prefix 길이)
    #[serde(default)]
    pub sent: u64,
    /// 전송한 prefix 의 dedup_key 연쇄 해시 — 파일 재작성 감지용
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sent_hash: String,
}

impl FileState {
    pub fn stamp(&self) -> FileStamp {
        FileStamp {
            mtime_ms: self.mtime_ms,
            size: self.size,
        }
    }
}

pub fn stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some(FileStamp {
        mtime_ms,
        size: meta.len(),
    })
}

fn cursor_path(adapter: &str) -> Option<PathBuf> {
    fsx::state_dir().map(|d| d.join("cursors").join(format!("{adapter}.json")))
}

pub fn load(adapter: &str) -> Cursor {
    cursor_path(adapter)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save(adapter: &str, cursor: &Cursor) {
    let Some(path) = cursor_path(adapter) else {
        return;
    };
    if let Ok(body) = serde_json::to_string_pretty(cursor) {
        let _ = fsx::write_atomic(&path, &body, 0o600);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_roundtrip_json() {
        let mut c = Cursor::default();
        c.files.insert(
            "/tmp/a.jsonl".into(),
            FileState {
                mtime_ms: 1_700_000_000_000,
                size: 42,
                sent: 7,
                sent_hash: "abc".into(),
            },
        );
        let text = serde_json::to_string(&c).unwrap();
        let back: Cursor = serde_json::from_str(&text).unwrap();
        assert_eq!(back.files.len(), 1);
        let s = &back.files["/tmp/a.jsonl"];
        assert_eq!((s.mtime_ms, s.size, s.sent), (1_700_000_000_000, 42, 7));
        assert_eq!(s.sent_hash, "abc");
    }

    #[test]
    fn legacy_cursor_without_progress_fields_still_loads() {
        // 구버전 커서(전송 진행 필드 없음) → sent=0·hash 빈 값으로 역직렬화 (1회 전체 전송 폴백)
        let text = r#"{"files":{"/tmp/a.jsonl":{"mtime_ms":1,"size":2}}}"#;
        let back: Cursor = serde_json::from_str(text).unwrap();
        let s = &back.files["/tmp/a.jsonl"];
        assert_eq!((s.sent, s.sent_hash.as_str()), (0, ""));
        assert_eq!(
            s.stamp(),
            FileStamp {
                mtime_ms: 1,
                size: 2
            }
        );
    }

    #[test]
    fn corrupt_state_falls_back_to_default() {
        let c: Cursor = serde_json::from_str("not json").unwrap_or_default();
        assert!(c.files.is_empty());
    }
}
