use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::os::unix::fs::{symlink, PermissionsExt};

static NEXT_FIXTURE_ID: AtomicU64 = AtomicU64::new(0);

struct CliFixture {
    root: PathBuf,
    home: PathBuf,
    shim: PathBuf,
}

impl CliFixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must be after epoch")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "toard-multi-target-cli-{}-{nonce}-{}",
            std::process::id(),
            NEXT_FIXTURE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let home = root.join("home");
        let bin = root.join("bin");
        fs::create_dir_all(&home).expect("home must be created");
        fs::create_dir_all(&bin).expect("bin must be created");
        let shim = bin.join(if cfg!(windows) {
            "toard-shim.exe"
        } else {
            "toard-shim"
        });
        #[cfg(unix)]
        symlink(env!("CARGO_BIN_EXE_shim"), &shim).expect("shim link must be created");
        #[cfg(windows)]
        fs::copy(env!("CARGO_BIN_EXE_shim"), &shim).expect("shim must be copied");
        Self { root, home, shim }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.shim);
        command
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env_remove("TOARD_INGEST_TOKEN")
            .env_remove("TOARD_INGEST_ENDPOINT")
            .env_remove("TOARD_SHIM_COLLECT_CONTENT")
            .env_remove("TOARD_SHIM_COLLECT_CONTENT_SINCE")
            .env_remove("TOARD_SHIM_COLLECT_TOOLS");
        command
    }

    fn run(&self, args: &[&str]) -> Output {
        self.command()
            .args(args)
            .output()
            .expect("shim command must run")
    }

    fn upsert(&self, endpoint: &str, token: &str, content: &str, tools: &str) -> Output {
        self.command()
            .args(["target", "upsert"])
            .env("TOARD_INGEST_ENDPOINT", endpoint)
            .env("TOARD_INGEST_TOKEN", token)
            .env("TOARD_SHIM_COLLECT_CONTENT", content)
            .env("TOARD_SHIM_COLLECT_TOOLS", tools)
            .output()
            .expect("target upsert must run")
    }

    fn target_directories(&self) -> Vec<PathBuf> {
        let mut paths = fs::read_dir(self.home.join(".toard/targets"))
            .expect("target directory must exist")
            .map(|entry| entry.expect("target entry must be readable").path())
            .filter(|path| path.is_dir())
            .collect::<Vec<_>>();
        paths.sort();
        paths
    }

    #[cfg(unix)]
    fn install_doctor_tools(&self) {
        let bin = self.shim.parent().expect("shim must have a parent");
        symlink(&self.shim, bin.join("claude")).expect("claude alias must be created");
        symlink(&self.shim, bin.join("codex")).expect("codex alias must be created");
        let curl = bin.join("curl");
        fs::write(
            &curl,
            r#"#!/bin/sh
endpoint=unknown
token_ok=0
for arg in "$@"; do
  case "$arg" in
    *company.example*) endpoint=company ;;
    *personal.example*) endpoint=personal ;;
    *tk_personal*) token_ok=1 ;;
  esac
  if [ -f "$arg" ] && /usr/bin/grep -q 'tk_personal' "$arg" 2>/dev/null; then
    token_ok=1
  fi
done
if [ "$endpoint" = company ]; then
  printf 000
elif [ "$endpoint" = personal ] && [ "$token_ok" = 1 ]; then
  printf 200
else
  printf 401
fi
"#,
        )
        .expect("fake curl must be written");
        fs::set_permissions(&curl, fs::Permissions::from_mode(0o755))
            .expect("fake curl must be executable");
    }
}

impl Drop for CliFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "command failed\nstdout:\n{}\nstderr:\n{}",
        stdout(output),
        stderr(output)
    );
}

#[test]
fn capabilities_and_target_list_are_machine_safe() {
    let fixture = CliFixture::new();
    let capabilities = fixture.run(&["capabilities"]);
    assert_success(&capabilities);
    assert_eq!(stdout(&capabilities).trim(), "multi-target-v1");

    assert_success(&fixture.upsert("https://company.example/api/", "tk_company", "off", "true"));
    assert_success(&fixture.upsert(
        "https://personal.example/api",
        "tk_personal",
        "server_v1",
        "false",
    ));

    let list = fixture.run(&["targets", "list"]);
    assert_success(&list);
    let output = stdout(&list);
    assert!(output.contains("https://company.example/api"));
    assert!(output.contains("https://personal.example/api"));
    assert!(output.contains("content=off"));
    assert!(output.contains("content=server_v1"));
    assert!(output.contains("tools=on"));
    assert!(output.contains("tools=off"));
    assert!(!output.contains("tk_company"));
    assert!(!output.contains("tk_personal"));
}

#[test]
fn same_endpoint_updates_credentials_without_deleting_state() {
    let fixture = CliFixture::new();
    assert_success(&fixture.upsert("HTTPS://COMPANY.EXAMPLE:443/api/", "tk_old", "off", "true"));
    let target = fixture
        .target_directories()
        .pop()
        .expect("target must exist");
    let cursor = target.join("state/cursors.json");
    fs::write(&cursor, "keep-me").expect("cursor fixture must be written");
    let credentials_path = target.join("credentials");
    let mut activated = fs::read_to_string(&credentials_path).unwrap();
    activated.push_str(
        "collect_content_since=2026-01-02\ncontent_owner_id=owner-1\ncontent_key_version=7\ncontent_device_id=device-1\n",
    );
    fs::write(&credentials_path, activated).unwrap();

    assert_success(&fixture.upsert(
        "https://company.example/api",
        "tk_new",
        "server_v1",
        "false",
    ));

    assert_eq!(fixture.target_directories().len(), 1);
    assert_eq!(fs::read_to_string(cursor).unwrap(), "keep-me");
    let credentials = fs::read_to_string(&credentials_path).unwrap();
    assert!(credentials.contains("agent_key=tk_new"));
    assert!(!credentials.contains("tk_old"));
    assert!(credentials.contains("collect_content=server_v1"));
    assert!(credentials.contains("collect_tools=false"));
    assert!(credentials.contains("collect_content_since=2026-01-02"));
    assert!(credentials.contains("content_owner_id=owner-1"));
    assert!(credentials.contains("content_key_version=7"));
    assert!(credentials.contains("content_device_id=device-1"));

    let explicit_since = fixture
        .command()
        .args(["target", "upsert"])
        .env("TOARD_INGEST_ENDPOINT", "https://company.example/api")
        .env("TOARD_INGEST_TOKEN", "tk_latest")
        .env("TOARD_SHIM_COLLECT_CONTENT", "off")
        .env("TOARD_SHIM_COLLECT_TOOLS", "true")
        .env("TOARD_SHIM_COLLECT_CONTENT_SINCE", "2026-07-18")
        .output()
        .expect("explicit since upsert must run");
    assert_success(&explicit_since);
    let credentials = fs::read_to_string(credentials_path).unwrap();
    assert!(credentials.contains("collect_content_since=2026-07-18"));
    assert!(!credentials.contains("collect_content_since=2026-01-02"));
}

#[test]
fn machine_remove_is_idempotent_and_reports_remaining_targets() {
    let fixture = CliFixture::new();
    assert_success(&fixture.upsert("https://company.example/api", "tk_company", "off", "true"));
    assert_success(&fixture.upsert("https://personal.example/api", "tk_personal", "off", "true"));

    let remove = fixture
        .command()
        .args(["target", "remove", "--machine"])
        .env("TOARD_INGEST_ENDPOINT", "https://personal.example/api/")
        .output()
        .expect("target remove must run");
    assert_success(&remove);
    assert_eq!(stdout(&remove), "removed=1\nremaining=1\n");

    let missing = fixture
        .command()
        .args(["target", "remove", "--machine"])
        .env("TOARD_INGEST_ENDPOINT", "https://personal.example/api")
        .output()
        .expect("idempotent target remove must run");
    assert_success(&missing);
    assert_eq!(stdout(&missing), "removed=0\nremaining=1\n");
    assert_eq!(fixture.target_directories().len(), 1);
}

#[test]
fn machine_remove_rejects_missing_endpoint_as_cli_misuse() {
    let fixture = CliFixture::new();
    let output = fixture.run(&["target", "remove", "--machine"]);
    assert_eq!(output.status.code(), Some(2));
    assert!(stderr(&output).contains("TOARD_INGEST_ENDPOINT"));
}

#[test]
fn singleton_only_commands_refuse_multiple_targets_without_mutation() {
    let fixture = CliFixture::new();
    assert_success(&fixture.upsert("https://company.example/api", "tk_company", "off", "true"));
    assert_success(&fixture.upsert("https://personal.example/api", "tk_personal", "off", "true"));
    let before = fixture
        .target_directories()
        .into_iter()
        .map(|target| {
            let credentials = fs::read(target.join("credentials")).unwrap();
            (target, credentials)
        })
        .collect::<Vec<_>>();

    for args in [
        &["claude-env", "on"][..],
        &["e2ee", "status"][..],
        &["e2ee", "setup"][..],
    ] {
        let output = fixture.run(args);
        assert!(!output.status.success());
        assert!(
            stderr(&output).contains("target이 정확히 하나"),
            "args={args:?}\nstdout:\n{}\nstderr:\n{}",
            stdout(&output),
            stderr(&output)
        );
    }
    assert!(!fixture.home.join(".claude/settings.json").exists());
    for (target, credentials) in before {
        assert_eq!(
            fs::read(target.join("credentials")).unwrap(),
            credentials,
            "singleton-only command must not mutate target credentials"
        );
    }
}

#[cfg(unix)]
#[test]
fn doctor_checks_all_targets_and_target_env_uses_stored_token() {
    let fixture = CliFixture::new();
    assert_success(&fixture.upsert("https://company.example/api", "tk_company", "off", "true"));
    assert_success(&fixture.upsert("https://personal.example/api", "tk_personal", "off", "true"));
    fixture.install_doctor_tools();
    let bin = fixture.shim.parent().unwrap();

    let all = fixture
        .command()
        .arg("doctor")
        .env("PATH", bin)
        .output()
        .expect("doctor must run");
    let all_stdout = stdout(&all);
    assert!(!all.status.success(), "company probe must fail");
    assert!(
        all_stdout.contains("https://company.example/api"),
        "{all_stdout}"
    );
    assert!(
        all_stdout.contains("https://personal.example/api"),
        "{all_stdout}"
    );
    assert!(all_stdout.contains("endpoint 연결 실패"), "{all_stdout}");
    assert!(
        all_stdout.contains("endpoint 연결 + 토큰 유효"),
        "{all_stdout}"
    );

    let selected = fixture
        .command()
        .args(["doctor", "--target-env"])
        .env("PATH", bin)
        .env("TOARD_INGEST_ENDPOINT", "https://personal.example:443/api/")
        .env("TOARD_INGEST_TOKEN", "wrong_override_must_be_ignored")
        .output()
        .expect("selected doctor must run");
    assert_success(&selected);
    let selected_stdout = stdout(&selected);
    assert!(!selected_stdout.contains("https://company.example/api"));
    assert!(selected_stdout.contains("https://personal.example/api"));
}
