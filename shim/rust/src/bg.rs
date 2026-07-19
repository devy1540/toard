// 백그라운드 작업 공통 유틸 — 스로틀 스탬프 + double-spawn 분리.
// wrap 경로(claude/codex exec)에 레이턴시를 더하지 않기 위한 패턴:
//   1) 스탬프 파일로 주기 판정 (파일 읽기 1회)
//   2) 중간 프로세스(kick)가 실제 작업 프로세스(detach)를 새 프로세스 그룹으로
//      분리하고 즉시 종료 → 부모는 중간 프로세스만 reap, 좀비 없음.

use std::env;
use std::process::{Command, Stdio};

use crate::fsx;

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn now_unix_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

/// 스로틀 판정 — 기록이 없거나 손상됐거나 주기가 지났으면 true.
/// 미래 시각(시계 역행)은 skip 으로 처리해 폭주를 막는다.
pub fn is_due(stamp_content: Option<&str>, now: u64, interval_secs: u64) -> bool {
    match stamp_content.and_then(|s| s.trim().parse::<u64>().ok()) {
        Some(prev) if prev > now => false,
        Some(prev) => now - prev >= interval_secs,
        None => true,
    }
}

/// 주기가 지났으면 스탬프를 먼저 기록(동시 실행 stampede 방지)하고 true.
pub fn throttle(stamp_name: &str, interval_secs: u64) -> bool {
    let Some(state) = fsx::state_dir() else {
        return false;
    };
    let stamp = state.join(stamp_name);
    let now = now_unix();
    if !is_due(
        std::fs::read_to_string(&stamp).ok().as_deref(),
        now,
        interval_secs,
    ) {
        return false;
    }
    // 실패해도 주기 내 재시도하지 않도록 체크 시각을 먼저 기록
    let _ = fsx::write_atomic(&stamp, &format!("{now}\n"), 0o644);
    true
}

/// 스탬프를 현재 시각으로 갱신 — 주기 판정 없이 기록만.
/// 데몬/직접 collect 실행이 wrap 편승 스로틀과 스탬프를 공유해 중복 실행을 막는다.
pub fn touch(stamp_name: &str) {
    if let Some(state) = fsx::state_dir() {
        let _ = fsx::write_atomic(&state.join(stamp_name), &format!("{}\n", now_unix()), 0o644);
    }
}

/// 중간 프로세스 실행 + reap (double-spawn 1단계).
pub fn kick(intermediate_arg: &str) {
    let Ok(exe) = env::current_exe() else { return };
    if let Ok(mut child) = Command::new(&exe)
        .arg(intermediate_arg)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        let _ = child.wait();
    }
}

/// 중간 프로세스에서 호출 — 작업 프로세스를 분리하고 즉시 종료 (double-spawn 2단계).
/// Unix 는 새 프로세스 그룹, Windows 는 DETACHED_PROCESS(콘솔 없음) +
/// CREATE_NEW_PROCESS_GROUP 으로 부모 콘솔·Ctrl+C 에서 분리한다.
pub fn detach(run_arg: &str) -> ! {
    if let Ok(exe) = env::current_exe() {
        let mut cmd = Command::new(exe);
        cmd.arg(run_arg)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const DETACHED_PROCESS: u32 = 0x0000_0008;
            const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
            cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
        }
        let _ = cmd.spawn();
    }
    std::process::exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttle_logic() {
        let now = 2_000_000_000;
        assert!(is_due(None, now, 3600), "기록 없음 → 실행");
        assert!(is_due(Some("garbage"), now, 3600), "손상 → 실행");
        assert!(is_due(Some(&format!("{}", now - 3600)), now, 3600));
        assert!(
            !is_due(Some(&format!("{}", now - 100)), now, 3600),
            "주기 내 → skip"
        );
        assert!(
            !is_due(Some(&format!("{}", now + 100)), now, 3600),
            "미래 시각 → skip"
        );
    }
}
