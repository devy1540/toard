// 파일시스템 헬퍼 — 원자적 쓰기와 toard 상태 디렉토리.

use std::env;
use std::ffi::OsString;
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
    select_home_dir(
        env::var_os("HOME"),
        env::var_os("USERPROFILE"),
        cfg!(windows),
    )
}

fn select_home_dir(
    home: Option<OsString>,
    user_profile: Option<OsString>,
    windows: bool,
) -> Option<PathBuf> {
    let home = home.filter(|v| !v.is_empty());
    let user_profile = user_profile.filter(|v| !v.is_empty());
    if windows {
        user_profile.or(home).map(PathBuf::from)
    } else {
        home.or(user_profile).map(PathBuf::from)
    }
}

/// ~/.toard/state — shim 자체 북키핑(claude-env 상태, 업데이트 체크 시각 등).
pub fn state_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".toard").join("state"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_home_prefers_userprofile() {
        let selected =
            select_home_dir(Some("C:/git-home".into()), Some("C:/Users/GA".into()), true);

        assert_eq!(selected, Some(PathBuf::from("C:/Users/GA")));
    }

    #[test]
    fn unix_home_prefers_home() {
        let selected = select_home_dir(
            Some("/Users/ga".into()),
            Some("/ignored-profile".into()),
            false,
        );

        assert_eq!(selected, Some(PathBuf::from("/Users/ga")));
    }
}
