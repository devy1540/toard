// PATH 해석 — argv[0] 도구명 판별과 진짜 바이너리 탐색.

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

pub fn tool_name_from(arg0: Option<OsString>) -> String {
    arg0.map(PathBuf::from)
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
        .map(strip_exe_suffix)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "claude".to_string())
}

/// Windows 는 argv0 이 `claude.exe` 로 오므로 `.exe` 를 벗겨 도구명을 얻는다.
fn strip_exe_suffix(name: String) -> String {
    let lower = name.to_ascii_lowercase();
    match lower.strip_suffix(".exe") {
        Some(_) => name[..name.len() - 4].to_string(),
        None => name,
    }
}

/// 디렉토리 안에서 실행 가능한 파일명 후보.
/// Unix 는 이름 그대로 하나 — Windows 는 확장자가 필수라 exe/cmd/bat 순으로 찾는다
/// (npm 계열 도구는 `claude.cmd`, 네이티브 설치는 `claude.exe`).
fn candidates(dir: &std::path::Path, name: &str) -> Vec<PathBuf> {
    if cfg!(windows) {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|ext| dir.join(format!("{name}.{ext}")))
            .collect()
    } else {
        vec![dir.join(name)]
    }
}

/// PATH 에서 이름이 일치하는 첫 후보 (자기 자신 포함 — PATH 순서 진단용).
pub fn first_in_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .flat_map(|dir| candidates(&dir, name))
        .find(|cand| cand.is_file())
}

/// 현재 실행 파일과 같은 shim 설치물인지 판정한다.
/// Windows 설치기는 심볼릭 링크 대신 동일 바이너리를 이름별로 복사하므로,
/// 관리 CLI(`toard-shim.exe`)에서 본 같은 디렉터리의 별칭도 자기 자신이다.
pub fn is_shim_executable_path(candidate: &Path, current_exe: &Path, windows: bool) -> bool {
    if candidate == current_exe {
        return true;
    }
    if !windows || candidate.parent() != current_exe.parent() {
        return false;
    }
    let current_name = current_exe
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase());
    let candidate_name = candidate
        .file_stem()
        .map(|s| s.to_string_lossy().to_ascii_lowercase());
    current_name.as_deref() == Some("toard-shim")
        && matches!(candidate_name.as_deref(), Some("claude" | "codex"))
}

/// PATH 에서 진짜 바이너리 탐색 (자기 자신 제외).
pub fn find_real_binary(name: &str) -> Option<PathBuf> {
    let self_canon = env::current_exe().ok().and_then(|p| p.canonicalize().ok());
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        for cand in candidates(&dir, name) {
            if !cand.is_file() {
                continue;
            }
            // canonicalize 실패 후보는 자기 자신 오인(재귀 exec)을 막기 위해 건너뛴다
            let Ok(cc) = cand.canonicalize() else {
                continue;
            };
            if self_canon
                .as_deref()
                .is_some_and(|current| is_shim_executable_path(&cc, current, cfg!(windows)))
            {
                continue;
            }
            return Some(cand);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_name_from_path() {
        assert_eq!(
            tool_name_from(Some("/Users/x/.toard/bin/codex".into())),
            "codex"
        );
        assert_eq!(tool_name_from(Some("claude".into())), "claude");
    }

    #[test]
    fn tool_name_defaults_to_claude() {
        assert_eq!(tool_name_from(None), "claude");
    }

    #[test]
    fn tool_name_strips_windows_exe() {
        assert_eq!(tool_name_from(Some("claude.exe".into())), "claude");
        assert_eq!(tool_name_from(Some("/x/bin/codex.exe".into())), "codex");
        // 대소문자 무관하게 벗기되 스템의 원 표기는 보존
        assert_eq!(tool_name_from(Some("Claude.EXE".into())), "Claude");
        assert_eq!(tool_name_from(Some("toard-shim.exe".into())), "toard-shim");
    }

    #[test]
    fn tool_name_cli_binary() {
        assert_eq!(
            tool_name_from(Some("/Users/x/.toard/bin/toard-shim".into())),
            "toard-shim"
        );
    }

    #[test]
    fn windows_sibling_aliases_are_the_same_shim_installation() {
        let manager = std::path::Path::new("/Users/x/.toard/bin/toard-shim.exe");
        let claude = std::path::Path::new("/Users/x/.toard/bin/claude.exe");
        let real = std::path::Path::new("/Program Files/Claude/claude.exe");

        assert!(is_shim_executable_path(claude, manager, true));
        assert!(!is_shim_executable_path(real, manager, true));
        assert!(!is_shim_executable_path(claude, manager, false));
    }
}
