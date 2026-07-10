// 자동 업데이트 (ADR-006 "투명 wrapping + 자동 업데이트").
//
// wrap 실행 경로에는 네트워크를 절대 넣지 않는다(cold start 우위가 Rust 채택
// 근거) — 6h 스로틀 파일만 읽고, 주기가 지났으면 업데이터를 백그라운드로
// 분리(double-spawn: 중간 프로세스가 즉시 종료해 좀비 없음)한 뒤 바로 exec 한다.
// 다운로드는 install.sh 와 동일하게 curl + SHA256SUMS 검증, 교체는 rename(원자적).

use std::env;
use std::process::Command;

use crate::bg;
use crate::cli::version;

const CHECK_INTERVAL_SECS: u64 = 6 * 60 * 60;

/// 내부 argv — 사용자 커맨드와 충돌하지 않도록 언더스코어 프리픽스
pub const SPAWN_ARG: &str = "___toard-spawn-updater";
pub const RUN_ARG: &str = "___toard-self-update";

fn repo() -> String {
    env::var("TOARD_REPO").unwrap_or_else(|_| "devy1540/toard".into())
}

/// 릴리스 호스트 — 사내 미러/에어갭 환경과 테스트에서 override 가능.
fn release_host() -> String {
    env::var("TOARD_SHIM_RELEASE_BASE").unwrap_or_else(|_| "https://github.com".into())
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const TARGET: &str = "aarch64-apple-darwin";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const TARGET: &str = "x86_64-apple-darwin";
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const TARGET: &str = "aarch64-unknown-linux-gnu";
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const TARGET: &str = "x86_64-unknown-linux-gnu";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const TARGET: &str = "x86_64-pc-windows-msvc";

/// 릴리스 자산명 — Windows 만 `.exe` 접미(릴리스 워크플로 명명과 계약).
fn asset_name() -> String {
    let ext = if cfg!(windows) { ".exe" } else { "" };
    format!("toard-shim-{TARGET}{ext}")
}

/// wrap 경로에서 호출 — exec 직전, 논블로킹.
pub fn maybe_spawn_background_check() {
    // 개발 빌드(0.0.0)는 자동 업데이트 대상이 아니다
    if version() == "0.0.0" {
        return;
    }
    if matches!(
        env::var("TOARD_SHIM_AUTO_UPDATE").ok().as_deref(),
        Some("0" | "false" | "off")
    ) {
        return;
    }
    if bg::throttle("last-update-check", CHECK_INTERVAL_SECS) {
        bg::kick(SPAWN_ARG);
    }
}

/// SPAWN_ARG 로 실행된 중간 프로세스 — 업데이터를 새 프로세스 그룹으로 분리하고 종료.
pub fn spawn_detached_updater() -> ! {
    bg::detach(RUN_ARG)
}

/// 실제 업데이트 — `toard-shim update`(수동, 출력 있음)와 RUN_ARG(백그라운드, 무음) 공용.
pub fn run_self_update(quiet: bool) -> i32 {
    macro_rules! say {
        ($($t:tt)*) => { if !quiet { println!($($t)*); } };
    }
    let current = version();
    let latest = match fetch_latest_version() {
        Ok(v) => v,
        Err(e) => {
            if !quiet {
                eprintln!("toard-shim: 최신 버전 확인 실패 — {e}");
            }
            return if quiet { 0 } else { 1 };
        }
    };
    if latest == current {
        say!("이미 최신 버전입니다 (v{current})");
        return 0;
    }
    say!("업데이트: v{current} → v{latest}");
    match download_and_replace(&latest) {
        Ok(path) => {
            say!("교체 완료: {path} — 다음 실행부터 v{latest} 가 적용됩니다");
            0
        }
        Err(e) => {
            if !quiet {
                eprintln!("toard-shim: 업데이트 실패 — {e}");
            }
            if quiet {
                0
            } else {
                1
            }
        }
    }
}

/// GitHub releases/latest 의 302 Location 헤더에서 태그를 읽는다 (API rate limit 밖).
fn fetch_latest_version() -> Result<String, String> {
    let url = format!("{}/{}/releases/latest", release_host(), repo());
    let out = Command::new("curl")
        .args(["-sI", "--max-time", "10", &url])
        .output()
        .map_err(|e| format!("curl 실행 불가: {e}"))?;
    parse_latest_from_headers(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| "릴리스 태그를 찾지 못했습니다".into())
}

fn parse_latest_from_headers(headers: &str) -> Option<String> {
    for line in headers.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("location") {
            continue;
        }
        if let Some(tag) = value.split("/tag/").nth(1) {
            let tag = tag.trim().trim_end_matches('\r');
            if !tag.is_empty() {
                return Some(tag.trim_start_matches('v').to_string());
            }
        }
    }
    None
}

fn parse_sha_entry(sums: &str, asset: &str) -> Option<String> {
    sums.lines()
        .find(|l| l.trim_end().ends_with(asset))
        .and_then(|l| l.split_whitespace().next())
        .map(str::to_string)
}

/// 다운로드 파일 SHA256 — 외부 sha256sum/shasum 없이 내장(sha2) 계산이라 OS 무관.
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).map_err(|e| format!("다운로드 파일 읽기 실패: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

/// 다운로드 → SHA256 검증 → chmod 755 → rename 으로 자기 자신 교체(원자적).
fn download_and_replace(latest: &str) -> Result<String, String> {
    let exe = env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| format!("설치 경로 확인 실패: {e}"))?;
    let dir = exe.parent().ok_or("설치 디렉토리를 알 수 없습니다")?;
    let base = format!("{}/{}/releases/download/v{latest}", release_host(), repo());
    let asset = asset_name();
    let tmp = dir.join(format!(".{asset}.update-{}", std::process::id()));

    let dl = Command::new("curl")
        .args(["-fsSL", "--max-time", "120", "-o"])
        .arg(&tmp)
        .arg(format!("{base}/{asset}"))
        .status()
        .map_err(|e| format!("curl 실행 불가: {e}"))?;
    if !dl.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("바이너리 다운로드 실패: {base}/{asset}"));
    }

    let sums_out = Command::new("curl")
        .args(["-fsSL", "--max-time", "30", &format!("{base}/SHA256SUMS")])
        .output()
        .map_err(|e| format!("curl 실행 불가: {e}"))?;
    let cleanup_err = |msg: String| {
        let _ = std::fs::remove_file(&tmp);
        msg
    };
    if !sums_out.status.success() {
        return Err(cleanup_err("SHA256SUMS 다운로드 실패".into()));
    }
    let expected = parse_sha_entry(&String::from_utf8_lossy(&sums_out.stdout), &asset)
        .ok_or_else(|| cleanup_err(format!("SHA256SUMS 에 {asset} 항목 없음")))?;
    let actual = sha256_file(&tmp).map_err(&cleanup_err)?;
    if expected != actual {
        return Err(cleanup_err(format!(
            "체크섬 불일치 — 교체 중단 (expected={expected} got={actual})"
        )));
    }

    crate::fsx::set_mode(&tmp, 0o755).map_err(|e| cleanup_err(format!("권한 설정 실패: {e}")))?;
    replace_exe(&tmp, &exe).map_err(&cleanup_err)?;
    #[cfg(windows)]
    sync_sibling_copies(&exe);
    Ok(exe.display().to_string())
}

#[cfg(unix)]
fn replace_exe(tmp: &std::path::Path, exe: &std::path::Path) -> Result<(), String> {
    std::fs::rename(tmp, exe).map_err(|e| format!("교체 실패: {e}"))
}

/// Windows 는 실행 중인 exe 를 덮어쓸 수 없다(삭제·overwrite 잠금) — 대신
/// 실행 중에도 rename(이동)은 허용되므로 현재 exe 를 .old 로 비켜두고 새 파일을 앉힌다.
/// .old 는 이번 프로세스가 살아 있는 동안 못 지우므로 다음 업데이트 때 정리한다.
#[cfg(windows)]
fn replace_exe(tmp: &std::path::Path, exe: &std::path::Path) -> Result<(), String> {
    let old = exe.with_extension("exe.old");
    let _ = std::fs::remove_file(&old); // 이전 업데이트 잔여물 — 실행 중이 아니면 지워진다
    std::fs::rename(exe, &old).map_err(|e| format!("기존 exe 비켜두기 실패: {e}"))?;
    std::fs::rename(tmp, exe).map_err(|e| {
        // 새 파일 안착 실패 — 기존 exe 를 되돌려 실행 불능 상태를 막는다
        let _ = std::fs::rename(&old, exe);
        format!("교체 실패: {e}")
    })
}

/// Windows 는 설치기(npm/install)가 symlink 대신 사본 3개(claude/codex/toard-shim.exe)를
/// 두므로, 자기 자신만 교체하면 이름 간 버전이 갈라진다 — 같은 디렉토리의 다른 shim
/// 사본도 새 바이너리로 갱신한다. 실행 중(잠김)인 사본은 조용히 건너뛴다(그 사본이
/// 다음 자기 업데이트 때 따라잡는다).
#[cfg(windows)]
fn sync_sibling_copies(exe: &std::path::Path) {
    let Some(dir) = exe.parent() else { return };
    let self_name = exe.file_name().map(|n| n.to_ascii_lowercase());
    for name in ["claude.exe", "codex.exe", "toard-shim.exe"] {
        if self_name.as_deref() == Some(std::ffi::OsStr::new(name)) {
            continue;
        }
        let sib = dir.join(name);
        if !sib.is_file() {
            continue;
        }
        let old = sib.with_extension("exe.old");
        let _ = std::fs::remove_file(&old);
        if std::fs::rename(&sib, &old).is_ok() && std::fs::copy(exe, &sib).is_err() {
            // 새 사본 안착 실패 — 원본을 되돌린다
            let _ = std::fs::rename(&old, &sib);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_location_header() {
        let headers = "HTTP/2 302\r\nserver: GitHub.com\r\nLocation: https://github.com/devy1540/toard/releases/tag/v0.3.1\r\n\r\n";
        assert_eq!(parse_latest_from_headers(headers).as_deref(), Some("0.3.1"));
        assert_eq!(parse_latest_from_headers("HTTP/2 200\r\n"), None);
    }

    #[test]
    fn parses_sha_entry() {
        let sums = "abc123  toard-shim-aarch64-apple-darwin\ndef456  toard-shim-x86_64-unknown-linux-gnu\n";
        assert_eq!(
            parse_sha_entry(sums, "toard-shim-aarch64-apple-darwin").as_deref(),
            Some("abc123")
        );
        assert_eq!(parse_sha_entry(sums, "toard-shim-missing"), None);
    }
}
