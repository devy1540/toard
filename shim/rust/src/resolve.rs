// PATH 해석 — argv[0] 도구명 판별과 진짜 바이너리 탐색.

use std::env;
use std::ffi::OsString;
use std::path::PathBuf;

pub fn tool_name_from(arg0: Option<OsString>) -> String {
    arg0.map(PathBuf::from)
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "claude".to_string())
}

/// PATH 에서 이름이 일치하는 첫 후보 (자기 자신 포함 — PATH 순서 진단용).
pub fn first_in_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|cand| cand.is_file())
}

/// PATH 에서 진짜 바이너리 탐색 (자기 자신 제외).
pub fn find_real_binary(name: &str) -> Option<PathBuf> {
    let self_canon = env::current_exe().ok().and_then(|p| p.canonicalize().ok());
    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let cand = dir.join(name);
        if !cand.is_file() {
            continue;
        }
        // canonicalize 실패 후보는 자기 자신 오인(재귀 exec)을 막기 위해 건너뛴다
        let Ok(cc) = cand.canonicalize() else {
            continue;
        };
        if self_canon.as_ref() == Some(&cc) {
            continue;
        }
        return Some(cand);
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
    fn tool_name_cli_binary() {
        assert_eq!(
            tool_name_from(Some("/Users/x/.toard/bin/toard-shim".into())),
            "toard-shim"
        );
    }
}
