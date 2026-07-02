// 어댑터별 수집 커서 (~/.toard/state/cursors/{adapter}.json).
// 로컬 로그는 append 가 아니라 세션 파일이 제자리 갱신되는 형태라 오프셋 대신
// 파일 stamp(mtime+size) 를 기록하고, 변한 파일만 재파싱한다.
// 재파싱 중복은 dedup_key 멱등 저장이 흡수한다(§4.4).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::fsx;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Cursor {
    #[serde(default)]
    pub files: HashMap<String, FileStamp>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileStamp {
    pub mtime_ms: i64,
    pub size: u64,
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
            FileStamp {
                mtime_ms: 1_700_000_000_000,
                size: 42,
            },
        );
        let text = serde_json::to_string(&c).unwrap();
        let back: Cursor = serde_json::from_str(&text).unwrap();
        assert_eq!(back.files.len(), 1);
        assert_eq!(
            back.files["/tmp/a.jsonl"],
            FileStamp {
                mtime_ms: 1_700_000_000_000,
                size: 42
            }
        );
    }

    #[test]
    fn corrupt_state_falls_back_to_default() {
        let c: Cursor = serde_json::from_str("not json").unwrap_or_default();
        assert!(c.files.is_empty());
    }
}
