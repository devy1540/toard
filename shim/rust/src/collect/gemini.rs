// Gemini CLI 로컬 로그 어댑터 — 파서는 ccusage(MIT) 이식 예정 (2차-2).
// upstream: ccusage rust/crates/ccusage/src/adapter/gemini @ cdda1821

use std::path::{Path, PathBuf};

use super::{walk_files, LogAdapter, RawUsage};

pub struct Gemini;

impl LogAdapter for Gemini {
    fn key(&self) -> &'static str {
        "gemini"
    }

    /// GEMINI_DATA_DIR(csv) 우선, 기본 ~/.gemini/tmp — json/jsonl 재귀 수집
    fn discover_files(&self) -> Vec<PathBuf> {
        let mut files = Vec::new();
        for root in data_dirs() {
            walk_files(&root, &["json", "jsonl"], &mut files, 0);
        }
        files.sort();
        files.dedup();
        files
    }

    fn parse_file(&self, _path: &Path) -> Vec<RawUsage> {
        Vec::new() // TODO(2차-2): ccusage gemini parser 이식
    }
}

fn data_dirs() -> Vec<PathBuf> {
    if let Ok(env_paths) = std::env::var("GEMINI_DATA_DIR") {
        return env_paths
            .split(',')
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .collect();
    }
    crate::fsx::home_dir()
        .map(|h| h.join(".gemini").join("tmp"))
        .filter(|p| p.is_dir())
        .into_iter()
        .collect()
}
