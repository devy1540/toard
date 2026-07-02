// Qwen Code 로컬 로그 어댑터 — 파서는 ccusage(MIT) 이식 예정 (2차-2).
// upstream: ccusage rust/crates/ccusage/src/adapter/qwen @ cdda1821

use std::path::{Path, PathBuf};

use super::{LogAdapter, RawUsage};

pub struct Qwen;

impl LogAdapter for Qwen {
    fn key(&self) -> &'static str {
        "qwen"
    }

    fn discover_files(&self) -> Vec<PathBuf> {
        Vec::new() // TODO(2차-2): ccusage qwen paths 이식 (QWEN_DATA_DIR / ~/.qwen)
    }

    fn parse_file(&self, _path: &Path) -> Vec<RawUsage> {
        Vec::new() // TODO(2차-2): ccusage qwen parser 이식
    }
}
