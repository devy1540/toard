// 주기 수집 데몬 등록 — OS 스케줄러에 `toard-shim collect` 를 N초 주기로 등록한다 (#65).
// 상주 프로세스가 아니라 스케줄러(macOS launchd / Linux systemd user timer, 폴백 cron)가
// 단발 collect 를 깨우는 구조 — Desktop/IDE 처럼 shim(PATH) 을 거치지 않는 사용까지
// 주기 간격 안에 수집을 보장한다. wrap 편승(collect/mod.rs)과 last-collect 스탬프를 공유해
// 서로 중복 실행하지 않는다.

use std::path::PathBuf;
use std::process::{Command, Stdio};

use crate::fsx;

pub const DEFAULT_INTERVAL_SECS: u64 = 300;
pub const MIN_INTERVAL_SECS: u64 = 60;

const LAUNCHD_LABEL: &str = "dev.toard.collect";
const SYSTEMD_UNIT: &str = "toard-collect";
const CRON_MARKER: &str = "# toard-collect";

pub fn run(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("install") => match parse_interval(&args[1..]) {
            Ok(interval) => install(interval),
            Err(e) => {
                eprintln!("toard-shim: {e}");
                2
            }
        },
        Some("uninstall") => uninstall(),
        Some("status") | None => status(),
        Some(other) => {
            eprintln!("toard-shim: daemon 사용법: install [--interval <초>] | uninstall | status (받은 값: {other})");
            2
        }
    }
}

/// `--interval <초>` 파싱 — 기본 300, 하한 60(명시 거부: 조용한 보정보다 명확한 실패).
fn parse_interval(args: &[String]) -> Result<u64, String> {
    let mut interval = DEFAULT_INTERVAL_SECS;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--interval" => {
                let raw = it.next().ok_or("--interval 뒤에 초 단위 값이 필요합니다")?;
                interval = raw
                    .parse::<u64>()
                    .map_err(|_| format!("--interval 값이 숫자가 아닙니다: {raw}"))?;
            }
            other => return Err(format!("daemon install 이 모르는 인자: {other}")),
        }
    }
    if interval < MIN_INTERVAL_SECS {
        return Err(format!(
            "--interval 은 {MIN_INTERVAL_SECS}초 이상이어야 합니다 (받은 값: {interval})"
        ));
    }
    Ok(interval)
}

/// 데몬이 실행할 shim 진입점 — 같은 디렉토리의 `toard-shim` 심볼릭 링크를 우선한다.
/// (자동 업데이트는 실파일 `claude` 를 교체하고 링크는 유지되므로 링크가 안정적 경로다.)
fn shim_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let named = exe.parent().map(|d| d.join("toard-shim"))?;
    Some(if named.exists() { named } else { exe })
}

// ── 상태 (doctor 공유) ──

pub enum State {
    NotInstalled,
    Installed {
        backend: &'static str,
        interval: Option<u64>,
        active: bool,
    },
}

pub fn state() -> State {
    match std::env::consts::OS {
        "macos" => launchd_state(),
        "linux" => {
            let s = systemd_state();
            if matches!(s, State::NotInstalled) {
                cron_state()
            } else {
                s
            }
        }
        _ => State::NotInstalled,
    }
}

fn status() -> i32 {
    match state() {
        State::NotInstalled => {
            println!("  - 주기 수집 미등록 — 등록: toard-shim daemon install");
            0
        }
        State::Installed {
            backend,
            interval,
            active,
        } => {
            let interval = interval
                .map(|i| format!("{i}초 간격"))
                .unwrap_or_else(|| "간격 미상".into());
            if active {
                println!("  ✓ 주기 수집 등록됨 — {backend}, {interval}");
                0
            } else {
                println!(
                    "  ✗ 주기 수집 파일은 있으나 비활성 — toard-shim daemon install 로 재등록"
                );
                1
            }
        }
    }
}

fn install(interval: u64) -> i32 {
    // 로그 디렉토리(launchd StandardOutPath 등)가 스케줄러 실행 전에 존재해야 한다
    if let Some(state) = fsx::state_dir() {
        let _ = std::fs::create_dir_all(&state);
    }
    let Some(exe) = shim_exe() else {
        eprintln!("toard-shim: 실행 파일 경로를 알 수 없습니다");
        return 1;
    };
    let exe = exe.display().to_string();
    match std::env::consts::OS {
        "macos" => launchd_install(&exe, interval),
        "linux" => {
            if systemd_available() {
                systemd_install(&exe, interval)
            } else {
                cron_install(&exe, interval)
            }
        }
        other => {
            eprintln!("toard-shim: 지원하지 않는 OS: {other} (macos/linux)");
            1
        }
    }
}

fn uninstall() -> i32 {
    match std::env::consts::OS {
        "macos" => launchd_uninstall(),
        "linux" => {
            // 과거에 어느 백엔드로 등록했는지 모르므로 둘 다 정리한다(각각 멱등)
            let a = systemd_uninstall();
            let b = cron_uninstall();
            if a == 0 && b == 0 {
                0
            } else {
                1
            }
        }
        other => {
            eprintln!("toard-shim: 지원하지 않는 OS: {other} (macos/linux)");
            1
        }
    }
}

// ── macOS: launchd LaunchAgent ──

fn launchd_plist_path() -> Option<PathBuf> {
    fsx::home_dir().map(|h| {
        h.join("Library")
            .join("LaunchAgents")
            .join(format!("{LAUNCHD_LABEL}.plist"))
    })
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// plist 생성 — 순수 함수 (유닛테스트 대상).
fn launchd_plist(exe: &str, interval: u64, log_out: &str, log_err: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{exe}</string>
    <string>collect</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>{interval}</integer>
  <key>StandardOutPath</key>
  <string>{log_out}</string>
  <key>StandardErrorPath</key>
  <string>{log_err}</string>
</dict>
</plist>
"#,
        label = LAUNCHD_LABEL,
        exe = xml_escape(exe),
        log_out = xml_escape(log_out),
        log_err = xml_escape(log_err),
    )
}

/// plist 에서 StartInterval 을 읽는다 (status/doctor 표시용 — 정식 파서 불필요).
fn plist_interval(text: &str) -> Option<u64> {
    let after = text.split("<key>StartInterval</key>").nth(1)?;
    let start = after.find("<integer>")? + "<integer>".len();
    let end = after.find("</integer>")?;
    after.get(start..end)?.trim().parse().ok()
}

fn current_uid() -> Option<String> {
    let out = Command::new("id").arg("-u").output().ok()?;
    let uid = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!uid.is_empty()).then_some(uid)
}

fn launchd_install(exe: &str, interval: u64) -> i32 {
    let Some(plist_path) = launchd_plist_path() else {
        eprintln!("toard-shim: HOME 이 없어 LaunchAgents 위치를 알 수 없습니다");
        return 1;
    };
    let logs = fsx::state_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let content = launchd_plist(
        exe,
        interval,
        &logs.join("daemon.log").display().to_string(),
        &logs.join("daemon.err.log").display().to_string(),
    );
    if let Err(e) = fsx::write_atomic(&plist_path, &content, 0o644) {
        eprintln!("toard-shim: plist 쓰기 실패: {e}");
        return 1;
    }
    let Some(uid) = current_uid() else {
        eprintln!("toard-shim: uid 를 알 수 없습니다 (id -u 실패)");
        return 1;
    };
    let domain = format!("gui/{uid}");
    // 재설치 멱등: 기존 로드를 내리고 다시 올린다 (미로드 상태의 bootout 실패는 정상)
    let _ = quiet(
        Command::new("launchctl")
            .args(["bootout", &domain])
            .arg(&plist_path),
    );
    let ok = quiet(
        Command::new("launchctl")
            .args(["bootstrap", &domain])
            .arg(&plist_path),
    );
    if !ok {
        eprintln!(
            "toard-shim: launchctl bootstrap 실패 — 'launchctl bootstrap {domain} {}' 를 직접 실행해 오류를 확인하세요",
            plist_path.display()
        );
        return 1;
    }
    println!("  ✓ 주기 수집 등록됨 — launchd, {interval}초 간격");
    println!("    파일: {}", plist_path.display());
    println!("    로그: {}", logs.join("daemon.err.log").display());
    println!("    제거: toard-shim daemon uninstall");
    0
}

fn launchd_state() -> State {
    let Some(plist_path) = launchd_plist_path() else {
        return State::NotInstalled;
    };
    let Ok(text) = std::fs::read_to_string(&plist_path) else {
        return State::NotInstalled;
    };
    let active = quiet(Command::new("launchctl").args(["list", LAUNCHD_LABEL]));
    State::Installed {
        backend: "launchd",
        interval: plist_interval(&text),
        active,
    }
}

fn launchd_uninstall() -> i32 {
    let Some(plist_path) = launchd_plist_path() else {
        return 1;
    };
    if let Some(uid) = current_uid() {
        let _ = quiet(
            Command::new("launchctl")
                .args(["bootout", &format!("gui/{uid}")])
                .arg(&plist_path),
        );
    }
    match std::fs::remove_file(&plist_path) {
        Ok(()) => {
            println!("  ✓ 주기 수집 제거됨 — {}", plist_path.display());
            0
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            println!("  - 주기 수집이 등록돼 있지 않습니다");
            0
        }
        Err(e) => {
            eprintln!("toard-shim: plist 제거 실패: {e}");
            1
        }
    }
}

// ── Linux: systemd user timer ──

fn systemd_dir() -> Option<PathBuf> {
    fsx::home_dir().map(|h| h.join(".config").join("systemd").join("user"))
}

fn systemd_available() -> bool {
    quiet(Command::new("systemctl").args(["--user", "show-environment"]))
}

/// service 유닛 생성 — 순수 함수 (유닛테스트 대상).
fn systemd_service(exe: &str) -> String {
    format!(
        "[Unit]\nDescription=toard usage collect\n\n[Service]\nType=oneshot\nExecStart=\"{exe}\" collect\n"
    )
}

/// timer 유닛 생성 — 순수 함수 (유닛테스트 대상).
fn systemd_timer(interval: u64) -> String {
    format!(
        "[Unit]\nDescription=toard usage collect timer\n\n[Timer]\nOnBootSec={interval}s\nOnUnitActiveSec={interval}s\n\n[Install]\nWantedBy=timers.target\n"
    )
}

/// timer 유닛에서 간격을 읽는다 (status/doctor 표시용).
fn timer_interval(text: &str) -> Option<u64> {
    text.lines()
        .find_map(|l| l.trim().strip_prefix("OnUnitActiveSec="))
        .and_then(|v| v.trim().trim_end_matches('s').parse().ok())
}

fn systemd_install(exe: &str, interval: u64) -> i32 {
    let Some(dir) = systemd_dir() else {
        eprintln!("toard-shim: HOME 이 없어 systemd user 디렉토리를 알 수 없습니다");
        return 1;
    };
    let service_path = dir.join(format!("{SYSTEMD_UNIT}.service"));
    let timer_path = dir.join(format!("{SYSTEMD_UNIT}.timer"));
    if let Err(e) = fsx::write_atomic(&service_path, &systemd_service(exe), 0o644)
        .and_then(|()| fsx::write_atomic(&timer_path, &systemd_timer(interval), 0o644))
    {
        eprintln!("toard-shim: 유닛 파일 쓰기 실패: {e}");
        return 1;
    }
    let reloaded = quiet(Command::new("systemctl").args(["--user", "daemon-reload"]));
    let enabled = reloaded
        && quiet(Command::new("systemctl").args([
            "--user",
            "enable",
            "--now",
            &format!("{SYSTEMD_UNIT}.timer"),
        ]));
    if !enabled {
        eprintln!("toard-shim: systemd timer 활성화 실패 — 'systemctl --user enable --now {SYSTEMD_UNIT}.timer' 를 직접 실행해 확인하세요");
        return 1;
    }
    println!("  ✓ 주기 수집 등록됨 — systemd user timer, {interval}초 간격");
    println!("    파일: {}", timer_path.display());
    println!("    제거: toard-shim daemon uninstall");
    0
}

fn systemd_state() -> State {
    let Some(dir) = systemd_dir() else {
        return State::NotInstalled;
    };
    let Ok(text) = std::fs::read_to_string(dir.join(format!("{SYSTEMD_UNIT}.timer"))) else {
        return State::NotInstalled;
    };
    let active = quiet(Command::new("systemctl").args([
        "--user",
        "is-active",
        "--quiet",
        &format!("{SYSTEMD_UNIT}.timer"),
    ]));
    State::Installed {
        backend: "systemd",
        interval: timer_interval(&text),
        active,
    }
}

fn systemd_uninstall() -> i32 {
    let Some(dir) = systemd_dir() else {
        return 1;
    };
    let timer = dir.join(format!("{SYSTEMD_UNIT}.timer"));
    let service = dir.join(format!("{SYSTEMD_UNIT}.service"));
    let existed = timer.exists() || service.exists();
    if existed {
        let _ = quiet(Command::new("systemctl").args([
            "--user",
            "disable",
            "--now",
            &format!("{SYSTEMD_UNIT}.timer"),
        ]));
        let _ = std::fs::remove_file(&timer);
        let _ = std::fs::remove_file(&service);
        let _ = quiet(Command::new("systemctl").args(["--user", "daemon-reload"]));
        println!("  ✓ 주기 수집 제거됨 — systemd ({})", timer.display());
    }
    0
}

// ── Linux 폴백: crontab ──

/// cron 항목 생성 — 순수 함수 (유닛테스트 대상). cron 은 분 단위가 최소 해상도.
fn cron_line(exe: &str, interval: u64) -> String {
    let mins = interval.div_ceil(60).clamp(1, 59);
    format!("*/{mins} * * * * \"{exe}\" collect >/dev/null 2>&1 {CRON_MARKER}")
}

fn cron_current() -> String {
    Command::new("crontab")
        .arg("-l")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

fn cron_write(content: &str) -> bool {
    use std::io::Write;
    let Ok(mut child) = Command::new("crontab")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    if let Some(stdin) = child.stdin.as_mut() {
        if stdin.write_all(content.as_bytes()).is_err() {
            return false;
        }
    }
    child.wait().map(|s| s.success()).unwrap_or(false)
}

/// 기존 crontab 에서 toard 항목만 갈아끼운다 — 순수 함수 (유닛테스트 대상).
fn cron_merged(existing: &str, new_line: Option<&str>) -> String {
    let mut lines: Vec<&str> = existing
        .lines()
        .filter(|l| !l.trim_end().ends_with(CRON_MARKER))
        .collect();
    if let Some(l) = new_line {
        lines.push(l);
    }
    let mut out = lines.join("\n");
    if !out.is_empty() {
        out.push('\n');
    }
    out
}

fn cron_install(exe: &str, interval: u64) -> i32 {
    let line = cron_line(exe, interval);
    let merged = cron_merged(&cron_current(), Some(&line));
    if !cron_write(&merged) {
        eprintln!("toard-shim: crontab 등록 실패 — systemd 도 없어 자동 등록이 불가합니다. 수동 등록: {line}");
        return 1;
    }
    println!("  ✓ 주기 수집 등록됨 — crontab (systemd 부재 폴백)");
    println!("    항목: {line}");
    println!("    제거: toard-shim daemon uninstall");
    0
}

fn cron_state() -> State {
    let current = cron_current();
    let Some(line) = current
        .lines()
        .find(|l| l.trim_end().ends_with(CRON_MARKER))
    else {
        return State::NotInstalled;
    };
    // "*/N * * * *" 에서 N 분 → 초
    let interval = line
        .strip_prefix("*/")
        .and_then(|r| r.split_whitespace().next())
        .and_then(|m| m.parse::<u64>().ok())
        .map(|m| m * 60);
    State::Installed {
        backend: "cron",
        interval,
        active: true, // crontab 은 등록 = 활성
    }
}

fn cron_uninstall() -> i32 {
    let current = cron_current();
    if !current.lines().any(|l| l.trim_end().ends_with(CRON_MARKER)) {
        return 0;
    }
    if cron_write(&cron_merged(&current, None)) {
        println!("  ✓ 주기 수집 제거됨 — crontab");
        0
    } else {
        eprintln!("toard-shim: crontab 갱신 실패");
        1
    }
}

/// 출력 없이 커맨드 실행 — 성공 여부만.
fn quiet(cmd: &mut Command) -> bool {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_parsing() {
        assert_eq!(parse_interval(&[]).unwrap(), 300, "기본 300초");
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_interval(&args(&["--interval", "600"])).unwrap(), 600);
        assert!(
            parse_interval(&args(&["--interval", "59"])).is_err(),
            "하한 60초"
        );
        assert!(parse_interval(&args(&["--interval", "abc"])).is_err());
        assert!(parse_interval(&args(&["--interval"])).is_err(), "값 누락");
        assert!(parse_interval(&args(&["--what"])).is_err(), "모르는 인자");
    }

    #[test]
    fn plist_roundtrip() {
        let p = launchd_plist(
            "/Users/x/.toard/bin/toard-shim",
            300,
            "/tmp/o.log",
            "/tmp/e.log",
        );
        assert!(p.contains("<string>dev.toard.collect</string>"));
        assert!(p.contains("<string>/Users/x/.toard/bin/toard-shim</string>"));
        assert!(p.contains("<string>collect</string>"));
        assert!(p.contains("<integer>300</integer>"));
        assert_eq!(plist_interval(&p), Some(300), "쓴 간격을 그대로 읽어야 함");
    }

    #[test]
    fn plist_escapes_xml() {
        let p = launchd_plist("/a&b/<x>", 60, "/o", "/e");
        assert!(p.contains("/a&amp;b/&lt;x&gt;"));
        assert!(!p.contains("/a&b/<x>"));
    }

    #[test]
    fn systemd_units() {
        let s = systemd_service("/home/x/.toard/bin/toard-shim");
        assert!(s.contains("ExecStart=\"/home/x/.toard/bin/toard-shim\" collect"));
        let t = systemd_timer(300);
        assert!(t.contains("OnUnitActiveSec=300s"));
        assert!(t.contains("OnBootSec=300s"));
        assert_eq!(timer_interval(&t), Some(300), "쓴 간격을 그대로 읽어야 함");
    }

    #[test]
    fn cron_entry() {
        assert!(cron_line("/x/toard-shim", 300).starts_with("*/5 * * * *"));
        assert!(cron_line("/x/toard-shim", 60).starts_with("*/1 "));
        assert!(
            cron_line("/x/toard-shim", 90).starts_with("*/2 "),
            "분 단위 올림"
        );
        assert!(
            cron_line("/x/toard-shim", 7200).starts_with("*/59 "),
            "cron 상한 59분"
        );
        assert!(cron_line("/x/toard-shim", 300).ends_with(CRON_MARKER));
    }

    #[test]
    fn cron_merge_is_idempotent() {
        let existing = "0 9 * * * echo hi\n*/5 * * * * old collect # toard-collect\n";
        let merged = cron_merged(existing, Some("*/5 * * * * new collect # toard-collect"));
        assert!(merged.contains("echo hi"), "사용자 항목 보존");
        assert!(!merged.contains("old collect"), "기존 toard 항목 교체");
        assert!(merged.contains("new collect"));
        let removed = cron_merged(&merged, None);
        assert!(
            !removed.contains("toard-collect"),
            "제거 시 toard 항목만 사라짐"
        );
        assert!(removed.contains("echo hi"));
    }
}
