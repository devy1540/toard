#![cfg(unix)]

use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

struct TempTree(PathBuf);

static TEMP_TREE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl TempTree {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let sequence = TEMP_TREE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "toard-doctor-cli-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).expect("temp tree must be created");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn doctor_allows_desktop_collection_without_real_cli_binaries() {
    let temp = TempTree::new();
    let home = temp.path().join("home");
    let bin = temp.path().join("bin");
    fs::create_dir_all(home.join(".toard")).expect("credential directory must be created");
    fs::create_dir_all(&bin).expect("bin directory must be created");
    fs::write(
        home.join(".toard/credentials"),
        "agent_key=tk_test\nendpoint=https://toard.example/api\n",
    )
    .expect("credentials must be written");
    fs::set_permissions(
        home.join(".toard/credentials"),
        fs::Permissions::from_mode(0o600),
    )
    .expect("credential permissions must be restricted");

    let manager = bin.join("toard-shim");
    fs::copy(env!("CARGO_BIN_EXE_shim"), &manager).expect("shim test binary must be copied");
    fs::set_permissions(&manager, fs::Permissions::from_mode(0o755))
        .expect("shim must be executable");
    symlink(&manager, bin.join("claude")).expect("claude alias must be created");
    symlink(&manager, bin.join("codex")).expect("codex alias must be created");

    let curl = bin.join("curl");
    fs::write(&curl, "#!/bin/sh\nprintf 200\n").expect("fake curl must be written");
    fs::set_permissions(&curl, fs::Permissions::from_mode(0o755))
        .expect("fake curl must be executable");

    let output = Command::new(&manager)
        .arg("doctor")
        .env("HOME", &home)
        .env_remove("USERPROFILE")
        .env("PATH", &bin)
        .output()
        .expect("doctor must run");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        output.status.success(),
        "doctor should allow Desktop/IDE-only collection\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(stdout.contains("진짜 claude 없음 (Desktop/IDE 수집만 쓰면 무시)"));
    assert!(stdout.contains("진짜 codex 없음 (Desktop/IDE 수집만 쓰면 무시)"));
}

#[test]
fn doctor_from_local_bridge_does_not_treat_service_path_as_user_path() {
    let temp = TempTree::new();
    let home = temp.path().join("home");
    let service_bin = temp.path().join("service-bin");
    fs::create_dir_all(home.join(".toard")).expect("credential directory must be created");
    fs::create_dir_all(&service_bin).expect("service bin directory must be created");
    fs::write(
        home.join(".toard/credentials"),
        "agent_key=tk_test\nendpoint=https://toard.example/api\n",
    )
    .expect("credentials must be written");
    fs::set_permissions(
        home.join(".toard/credentials"),
        fs::Permissions::from_mode(0o600),
    )
    .expect("credential permissions must be restricted");

    let manager = temp.path().join("toard-shim");
    fs::copy(env!("CARGO_BIN_EXE_shim"), &manager).expect("shim test binary must be copied");
    fs::set_permissions(&manager, fs::Permissions::from_mode(0o755))
        .expect("shim must be executable");

    let curl = service_bin.join("curl");
    fs::write(&curl, "#!/bin/sh\nprintf 200\n").expect("fake curl must be written");
    fs::set_permissions(&curl, fs::Permissions::from_mode(0o755))
        .expect("fake curl must be executable");

    let output = Command::new(&manager)
        .arg("doctor")
        .env("HOME", &home)
        .env_remove("USERPROFILE")
        .env("PATH", &service_bin)
        .env("TOARD_SHIM_LOCAL_ACTION", "1")
        .output()
        .expect("bridge doctor must run");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    assert!(
        output.status.success(),
        "bridge doctor must ignore the service-only PATH\nstdout:\n{stdout}\nstderr:\n{stderr}"
    );
    assert!(stdout.contains("PATH 점검 생략"));
    assert!(!stdout.contains("PATH 에 claude 가 없습니다"));
    assert!(stdout.contains("endpoint 연결 + 토큰 유효"));
    assert!(stdout.contains("UI 로컬 bridge 실행 중"));
}
