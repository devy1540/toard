// 파일시스템 헬퍼 — 원자적 쓰기와 toard 상태 디렉토리.

use std::env;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

/// temp 파일에 쓴 뒤 rename — 부분 쓰기/동시 실행에도 대상 파일이 항상 온전하다.
pub fn write_atomic(path: &Path, content: &str, mode: u32) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let tmp: PathBuf = dir.join(format!(".{name}.toard-tmp-{}", std::process::id()));
    std::fs::write(&tmp, content)?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode))?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

pub fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME").map(PathBuf::from)
}

/// ~/.toard/state — shim 자체 북키핑(claude-env 상태, 업데이트 체크 시각 등).
pub fn state_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".toard").join("state"))
}
