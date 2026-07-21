// 자동 업데이트 (ADR-006 "투명 wrapping + 자동 업데이트").
//
// wrap 실행 경로에는 네트워크를 절대 넣지 않는다(cold start 우위가 Rust 채택
// 근거) — 2h 스로틀 파일만 읽고, 주기가 지났으면 업데이터를 백그라운드로
// 분리(double-spawn: 중간 프로세스가 즉시 종료해 좀비 없음)한 뒤 바로 exec 한다.
// 다운로드는 install.sh 와 동일하게 curl + SHA256SUMS 검증, 교체는 rename(원자적).

use std::env;
use std::process::Command;

use crate::bg;
use crate::cli::version;

const CHECK_INTERVAL_SECS: u64 = 2 * 60 * 60;

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

/// 릴리스 자산명 — Windows 는 main shim 과 background helper 를 함께 갱신한다.
fn release_asset_names(target: &str, windows: bool) -> Vec<String> {
    let ext = if windows { ".exe" } else { "" };
    let mut assets = vec![format!("toard-shim-{target}{ext}")];
    if windows {
        assets.push(format!("toard-shim-background-{target}.exe"));
    }
    assets
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
    sums.lines().find_map(|line| {
        let (checksum, filename) = line.split_once(char::is_whitespace)?;
        let filename = filename.trim_start();
        let filename = filename.strip_prefix('*').unwrap_or(filename);
        (filename == asset).then(|| checksum.to_string())
    })
}

/// 다운로드 파일 SHA256 — 외부 sha256sum/shasum 없이 내장(sha2) 계산이라 OS 무관.
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let bytes = std::fs::read(path).map_err(|e| format!("다운로드 파일 읽기 실패: {e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn fetch_sums(base: &str) -> Result<String, String> {
    let output = Command::new("curl")
        .args(["-fsSL", "--max-time", "30", &format!("{base}/SHA256SUMS")])
        .output()
        .map_err(|error| format!("curl 실행 불가: {error}"))?;
    if !output.status.success() {
        return Err("SHA256SUMS 다운로드 실패".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn download_asset(
    base: &str,
    asset: &str,
    dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let path = dir.join(format!(".{asset}.update-{}", std::process::id()));
    let status = match Command::new("curl")
        .args(["-fsSL", "--max-time", "120", "-o"])
        .arg(&path)
        .arg(format!("{base}/{asset}"))
        .status()
    {
        Ok(status) => status,
        Err(error) => {
            let _ = std::fs::remove_file(&path);
            return Err(format!("curl 실행 불가: {error}"));
        }
    };
    if !status.success() {
        let _ = std::fs::remove_file(&path);
        return Err(format!("바이너리 다운로드 실패: {base}/{asset}"));
    }
    Ok(path)
}

fn verify_asset(path: &std::path::Path, asset: &str, sums: &str) -> Result<(), String> {
    let expected =
        parse_sha_entry(sums, asset).ok_or_else(|| format!("SHA256SUMS 에 {asset} 항목 없음"))?;
    let actual = sha256_file(path)?;
    if expected != actual {
        return Err(format!(
            "체크섬 불일치 — 교체 중단 (asset={asset} expected={expected} got={actual})"
        ));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn background_install_path(main: &std::path::Path) -> std::path::PathBuf {
    if let Some(raw) = main.to_str() {
        if let Some(separator) = raw.rfind(['/', '\\']) {
            return std::path::PathBuf::from(format!(
                "{}toard-shim-background.exe",
                &raw[..=separator]
            ));
        }
    }
    main.with_file_name("toard-shim-background.exe")
}

fn cleanup_downloads(downloads: &[(String, std::path::PathBuf)]) {
    for (_, path) in downloads {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(any(windows, test))]
#[derive(Debug)]
#[must_use = "helper replacement must be committed or rolled back"]
struct WindowsFileReplacement {
    destination: std::path::PathBuf,
    backup: std::path::PathBuf,
    had_previous: bool,
}

#[cfg(any(windows, test))]
impl WindowsFileReplacement {
    fn commit(self) {
        if self.had_previous {
            let _ = std::fs::remove_file(self.backup);
        }
    }

    fn rollback(self) -> Result<(), String> {
        match std::fs::remove_file(&self.destination) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("새 helper 제거 실패: {error}")),
        }
        if self.had_previous {
            std::fs::rename(&self.backup, &self.destination)
                .map_err(|error| format!("기존 helper 복원 실패: {error}"))?;
        }
        Ok(())
    }
}

#[cfg(any(windows, test))]
fn replace_windows_file(
    tmp: &std::path::Path,
    destination: &std::path::Path,
) -> Result<WindowsFileReplacement, String> {
    let old = destination.with_extension("exe.old");
    let _ = std::fs::remove_file(&old);
    let moved_old = destination.is_file();
    if moved_old {
        std::fs::rename(destination, &old)
            .map_err(|error| format!("기존 helper 비켜두기 실패: {error}"))?;
    }
    std::fs::rename(tmp, destination).map_err(|error| {
        if moved_old {
            let _ = std::fs::rename(&old, destination);
        }
        format!("helper 교체 실패: {error}")
    })?;
    Ok(WindowsFileReplacement {
        destination: destination.to_path_buf(),
        backup: old,
        had_previous: moved_old,
    })
}

#[cfg(any(windows, test))]
fn replace_windows_pair<F>(
    helper_tmp: &std::path::Path,
    helper: &std::path::Path,
    main_tmp: &std::path::Path,
    main: &std::path::Path,
    replace_main: F,
) -> Result<(), String>
where
    F: FnOnce(&std::path::Path, &std::path::Path) -> Result<(), String>,
{
    let helper_replacement = replace_windows_file(helper_tmp, helper)?;
    match replace_main(main_tmp, main) {
        Ok(()) => {
            helper_replacement.commit();
            Ok(())
        }
        Err(main_error) => match helper_replacement.rollback() {
            Ok(()) => Err(main_error),
            Err(rollback_error) => Err(format!("{main_error}; helper 롤백 실패: {rollback_error}")),
        },
    }
}

/// 다운로드 → SHA256 검증 → chmod 755 → rename 으로 자기 자신 교체(원자적).
fn download_and_replace(latest: &str) -> Result<String, String> {
    let exe = env::current_exe()
        .and_then(|p| p.canonicalize())
        .map_err(|e| format!("설치 경로 확인 실패: {e}"))?;
    let dir = exe.parent().ok_or("설치 디렉토리를 알 수 없습니다")?;
    let base = format!("{}/{}/releases/download/v{latest}", release_host(), repo());
    let assets = release_asset_names(TARGET, cfg!(windows));
    let sums = fetch_sums(&base)?;
    let mut downloads = Vec::with_capacity(assets.len());

    for asset in &assets {
        let path = match download_asset(&base, asset, dir) {
            Ok(path) => path,
            Err(error) => {
                cleanup_downloads(&downloads);
                return Err(error);
            }
        };
        if let Err(error) = verify_asset(&path, asset, &sums) {
            let _ = std::fs::remove_file(&path);
            cleanup_downloads(&downloads);
            return Err(error);
        }
        downloads.push((asset.clone(), path));
    }

    for (_, path) in &downloads {
        if let Err(error) = crate::fsx::set_mode(path, 0o755) {
            cleanup_downloads(&downloads);
            return Err(format!("권한 설정 실패: {error}"));
        }
    }

    #[cfg(windows)]
    let replace_result = match downloads.get(1) {
        Some((_, helper_tmp)) => replace_windows_pair(
            helper_tmp,
            &background_install_path(&exe),
            &downloads[0].1,
            &exe,
            replace_exe,
        ),
        None => Err("Windows helper 다운로드가 없습니다".into()),
    };
    #[cfg(not(windows))]
    let replace_result = replace_exe(&downloads[0].1, &exe);
    if let Err(error) = replace_result {
        cleanup_downloads(&downloads);
        return Err(error);
    }
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
    fn unix_update_keeps_the_single_asset_contract() {
        assert_eq!(
            release_asset_names("aarch64-apple-darwin", false),
            vec!["toard-shim-aarch64-apple-darwin".to_string()]
        );
    }

    #[test]
    fn windows_update_requires_main_and_background_assets() {
        assert_eq!(
            release_asset_names("x86_64-pc-windows-msvc", true),
            vec![
                "toard-shim-x86_64-pc-windows-msvc.exe".to_string(),
                "toard-shim-background-x86_64-pc-windows-msvc.exe".to_string(),
            ]
        );
    }

    #[test]
    fn background_install_path_is_a_sibling_of_the_main_shim() {
        assert_eq!(
            background_install_path(std::path::Path::new(
                r"C:\Users\GA\.toard\bin\toard-shim.exe"
            )),
            std::path::PathBuf::from(r"C:\Users\GA\.toard\bin\toard-shim-background.exe")
        );
    }

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

    #[test]
    fn parses_both_windows_sha_entries_exactly() {
        let sums = concat!(
            "aaa  toard-shim-x86_64-pc-windows-msvc.exe\n",
            "bbb  toard-shim-background-x86_64-pc-windows-msvc.exe\n",
        );
        assert_eq!(
            parse_sha_entry(sums, "toard-shim-x86_64-pc-windows-msvc.exe").as_deref(),
            Some("aaa")
        );
        assert_eq!(
            parse_sha_entry(sums, "toard-shim-background-x86_64-pc-windows-msvc.exe").as_deref(),
            Some("bbb")
        );
    }

    #[test]
    fn parse_sha_entry_rejects_a_prefixed_filename_and_accepts_a_binary_marker() {
        let asset = "toard-shim-x86_64-pc-windows-msvc.exe";
        let sums = concat!(
            "evil  evil-toard-shim-x86_64-pc-windows-msvc.exe\n",
            "good *toard-shim-x86_64-pc-windows-msvc.exe\n",
        );

        assert_eq!(parse_sha_entry(sums, asset).as_deref(), Some("good"));
    }

    #[test]
    fn cleanup_downloads_removes_every_temporary_asset() {
        let downloads: Vec<_> = ["main", "background"]
            .into_iter()
            .map(|name| {
                let path = std::env::temp_dir().join(format!(
                    "toard-shim-{name}-cleanup-test-{}",
                    std::process::id()
                ));
                std::fs::write(&path, name).unwrap();
                (name.to_string(), path)
            })
            .collect();

        cleanup_downloads(&downloads);

        assert!(downloads.iter().all(|(_, path)| !path.exists()));
    }

    #[test]
    fn helper_replace_failure_restores_the_installed_helper() {
        let destination = std::env::temp_dir().join(format!(
            "toard-shim-background-rollback-test-{}.exe",
            std::process::id()
        ));
        let missing_tmp = destination.with_extension("missing");
        let old = destination.with_extension("exe.old");
        let _ = std::fs::remove_file(&missing_tmp);
        let _ = std::fs::remove_file(&old);
        std::fs::write(&destination, b"installed helper").unwrap();

        let error = replace_windows_file(&missing_tmp, &destination).unwrap_err();

        assert!(error.starts_with("helper 교체 실패:"));
        assert_eq!(std::fs::read(&destination).unwrap(), b"installed helper");
        assert!(!old.exists());
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn helper_replace_installs_when_no_previous_helper_exists() {
        let destination = std::env::temp_dir().join(format!(
            "toard-shim-background-first-install-test-{}.exe",
            std::process::id()
        ));
        let tmp = destination.with_extension("download");
        let old = destination.with_extension("exe.old");
        let _ = std::fs::remove_file(&destination);
        let _ = std::fs::remove_file(&old);
        std::fs::write(&tmp, b"new helper").unwrap();

        replace_windows_file(&tmp, &destination).unwrap().commit();

        assert_eq!(std::fs::read(&destination).unwrap(), b"new helper");
        assert!(!tmp.exists());
        assert!(!old.exists());
        std::fs::remove_file(destination).unwrap();
    }

    #[test]
    fn main_replace_failure_restores_the_previous_helper() {
        let dir = std::env::temp_dir().join(format!(
            "toard-shim-pair-rollback-existing-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let helper_tmp = dir.join("helper.download");
        let helper = dir.join("toard-shim-background.exe");
        let helper_backup = helper.with_extension("exe.old");
        let main_tmp = dir.join("main.download");
        let main = dir.join("toard-shim.exe");
        std::fs::write(&helper_tmp, b"new helper").unwrap();
        std::fs::write(&helper, b"old helper").unwrap();
        std::fs::write(&main_tmp, b"new main").unwrap();
        std::fs::write(&main, b"old main").unwrap();

        let error = replace_windows_pair(
            &helper_tmp,
            &helper,
            &main_tmp,
            &main,
            |actual_tmp, actual_main| {
                assert_eq!(actual_tmp, main_tmp);
                assert_eq!(actual_main, main);
                Err("injected main replacement failure".into())
            },
        )
        .unwrap_err();

        assert_eq!(error, "injected main replacement failure");
        assert_eq!(std::fs::read(&helper).unwrap(), b"old helper");
        assert!(!helper_backup.exists());
        assert_eq!(std::fs::read(&main).unwrap(), b"old main");
        assert_eq!(std::fs::read(&main_tmp).unwrap(), b"new main");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn main_replace_failure_removes_a_newly_installed_helper() {
        let dir = std::env::temp_dir().join(format!(
            "toard-shim-pair-rollback-new-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir(&dir).unwrap();
        let helper_tmp = dir.join("helper.download");
        let helper = dir.join("toard-shim-background.exe");
        let helper_backup = helper.with_extension("exe.old");
        let main_tmp = dir.join("main.download");
        let main = dir.join("toard-shim.exe");
        std::fs::write(&helper_tmp, b"new helper").unwrap();
        std::fs::write(&main_tmp, b"new main").unwrap();
        std::fs::write(&main, b"old main").unwrap();

        let error = replace_windows_pair(&helper_tmp, &helper, &main_tmp, &main, |_, _| {
            Err("injected main replacement failure".into())
        })
        .unwrap_err();

        assert_eq!(error, "injected main replacement failure");
        assert!(!helper.exists());
        assert!(!helper_backup.exists());
        assert_eq!(std::fs::read(&main).unwrap(), b"old main");
        assert_eq!(std::fs::read(&main_tmp).unwrap(), b"new main");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn verify_asset_rejects_a_checksum_mismatch() {
        let asset = "toard-shim-background-x86_64-pc-windows-msvc.exe";
        let path =
            std::env::temp_dir().join(format!("toard-shim-checksum-test-{}", std::process::id()));
        std::fs::write(&path, b"downloaded helper").unwrap();
        let sums = format!("deadbeef  {asset}\n");

        let error = verify_asset(&path, asset, &sums).unwrap_err();

        assert!(error.contains(&format!("asset={asset}")));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn checks_for_updates_every_two_hours() {
        assert_eq!(CHECK_INTERVAL_SECS, 2 * 60 * 60);
    }
}
