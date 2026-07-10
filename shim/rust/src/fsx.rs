// 파일시스템 헬퍼 — 원자적 쓰기와 toard 상태 디렉토리.

use std::env;
use std::path::{Path, PathBuf};

/// temp 파일에 쓴 뒤 rename — 부분 쓰기/동시 실행에도 대상 파일이 항상 온전하다.
/// mode 는 Unix 퍼미션 — Windows 에는 대응 개념이 없어 무시된다.
pub fn write_atomic(path: &Path, content: &str, mode: u32) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let tmp: PathBuf = dir.join(format!(".{name}.toard-tmp-{}", std::process::id()));
    std::fs::write(&tmp, content)?;
    set_mode(&tmp, mode)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

#[cfg(unix)]
pub fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
pub fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

pub fn home_dir() -> Option<PathBuf> {
    // Windows 는 HOME 이 없는 환경(순정 cmd/PowerShell)이 흔해 USERPROFILE 로 폴백한다
    env::var_os("HOME")
        .filter(|v| !v.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|v| !v.is_empty()))
        .map(PathBuf::from)
}

/// ~/.toard/state — shim 자체 북키핑(claude-env 상태, 업데이트 체크 시각 등).
pub fn state_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".toard").join("state"))
}
