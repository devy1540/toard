//! Real process/curl/parser test. Only synthetic HOME and loopback HTTP are used.
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Output};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Default)]
struct ServerState {
    mode: u8, // 0 = offline; 1 = persist then lose ACK; 2 = normal receipts
    requests: usize,
    health: Vec<serde_json::Value>,
    events: HashMap<String, serde_json::Value>,
}

struct Fixture {
    root: PathBuf,
    shim: PathBuf,
    endpoint: String,
    state: Arc<Mutex<ServerState>>,
    server: Option<JoinHandle<()>>,
    address: std::net::SocketAddr,
}

impl Fixture {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("toard-queue-cli-{}-{nonce}", std::process::id()));
        fs::create_dir_all(root.join("home/.codex/sessions")).unwrap();
        let shim = root.join(if cfg!(windows) {
            "toard-shim.exe"
        } else {
            "toard-shim"
        });
        #[cfg(unix)]
        std::os::unix::fs::symlink(env!("CARGO_BIN_EXE_shim"), &shim).unwrap();
        #[cfg(windows)]
        fs::copy(env!("CARGO_BIN_EXE_shim"), &shim).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(ServerState::default()));
        let shared = state.clone();
        let server = thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let Some((path, body)) = request(&mut stream) else {
                    break;
                };
                let mut state = shared.lock().unwrap();
                if path.ends_with("/v1/collection-status") {
                    state.health.push(serde_json::from_slice(&body).unwrap());
                    response(
                        &mut stream,
                        200,
                        r#"{"reported":0,"userId":"00000000-0000-4000-8000-000000000001","eventsReceiptVersion":1}"#,
                    );
                } else if path.ends_with("/v1/events") {
                    state.requests += 1;
                    if state.mode == 0 {
                        response(&mut stream, 503, "{}");
                        continue;
                    }
                    let rows: Vec<serde_json::Value> = serde_json::from_slice(&body).unwrap();
                    let mut inserted = 0;
                    for row in &rows {
                        let key = row["dedupKey"].as_str().unwrap().to_owned();
                        if let std::collections::hash_map::Entry::Vacant(entry) =
                            state.events.entry(key)
                        {
                            entry.insert(row.clone());
                            inserted += 1;
                        }
                    }
                    // The caller must keep its journal even though storage succeeded.
                    if state.mode == 1 {
                        continue;
                    }
                    response(
                        &mut stream,
                        200,
                        &serde_json::json!({
                            "inserted": inserted, "deduped": rows.len() - inserted,
                            "confirmed": rows.len(), "expired": 0, "ignored": 0,
                        })
                        .to_string(),
                    );
                } else {
                    response(&mut stream, 404, "{}");
                }
            }
        });
        Self {
            root,
            shim,
            endpoint: format!("http://{address}/api"),
            state,
            server: Some(server),
            address,
        }
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.shim);
        command.env_clear();
        // Keep platform executables/runtime only. Never inherit user collector roots,
        // proxy credentials, real tokens, or startup configuration.
        for key in [
            "PATH",
            "SystemRoot",
            "WINDIR",
            "COMSPEC",
            "PATHEXT",
            "TMP",
            "TEMP",
            "TMPDIR",
        ] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        command
            .current_dir(&self.root)
            .env("HOME", self.root.join("home"))
            .env("USERPROFILE", self.root.join("home"))
            .env("CODEX_HOME", self.root.join("home/.codex"))
            .env("TOARD_SHIM_LOCAL_ACTION", "1")
            .env("TOARD_SHIM_AUTO_UPDATE", "off")
            .env("TOARD_INGEST_ENDPOINT", &self.endpoint)
            .env("TOARD_INGEST_TOKEN", "tk_synthetic_usage_queue_test")
            .env("TOARD_SHIM_COLLECT_CONTENT", "off")
            .env("TOARD_SHIM_COLLECT_TOOLS", "off");
        command
    }

    fn collect(&self) -> Output {
        self.command()
            .args(["collect", "--adapter", "codex", "--target-env"])
            .output()
            .unwrap()
    }

    fn write_source(&self) -> PathBuf {
        let source = self.root.join("home/.codex/sessions/synthetic.jsonl");
        fs::write(&source, concat!(
        "{\"type\":\"session_meta\",\"payload\":{\"id\":\"synthetic-session\",\"cwd\":\"/synthetic-project\"}}\n",
        "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.5\"}}\n",
        "{\"timestamp\":\"2026-09-06T00:00:00Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":0,\"output_tokens\":20},\"total_token_usage\":{\"input_tokens\":100,\"output_tokens\":20}}}}\n",
    )).unwrap();
        source
    }

    fn pending(&self) -> u64 {
        let target = fs::read_dir(self.root.join("home/.toard/targets"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.is_dir())
            .unwrap();
        let connection = rusqlite::Connection::open_with_flags(
            target.join("state/usage-queue.sqlite3"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .unwrap();
        connection
            .query_row("SELECT COUNT(*) FROM pending_usage", [], |row| row.get(0))
            .unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Wake accept with EOF; no background process or socket survives the fixture.
        drop(TcpStream::connect(self.address));
        if let Some(server) = self.server.take() {
            let _ = server.join();
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn request(stream: &mut TcpStream) -> Option<(String, Vec<u8>)> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    let split = loop {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).ok()?;
        if read == 0 {
            return None;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if let Some(position) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            break position + 4;
        }
        assert!(bytes.len() < 16384);
    };
    let headers = String::from_utf8(bytes[..split].to_vec()).unwrap();
    let path = headers
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)?
        .to_string();
    let size = headers
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    assert!(size <= 4 * 1024 * 1024);
    if headers
        .to_ascii_lowercase()
        .contains("expect: 100-continue")
    {
        stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").unwrap();
    }
    while bytes.len() - split < size {
        let mut chunk = [0u8; 4096];
        let read = stream.read(&mut chunk).unwrap();
        assert!(read > 0);
        bytes.extend_from_slice(&chunk[..read]);
    }
    Some((path, bytes[split..split + size].to_vec()))
}

fn response(stream: &mut TcpStream, status: u16, body: &str) {
    write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
}

#[test]
fn journal_survives_process_restart_source_deletion_and_lost_receipt() {
    let fixture = Fixture::new();
    let registered = fixture
        .command()
        .args(["target", "upsert"])
        .output()
        .unwrap();
    assert!(
        registered.status.success(),
        "{}",
        String::from_utf8_lossy(&registered.stderr)
    );
    let source = fixture.write_source();

    assert_eq!(
        fixture.collect().status.code(),
        Some(1),
        "outage must be observable"
    );
    assert_eq!(fixture.pending(), 1);
    assert!(fixture.state.lock().unwrap().events.is_empty());
    fs::remove_file(source).unwrap();

    fixture.state.lock().unwrap().mode = 1;
    assert_eq!(
        fixture.collect().status.code(),
        Some(1),
        "missing ACK must be observable"
    );
    assert_eq!(fixture.pending(), 1, "do not clear after a lost receipt");
    assert_eq!(fixture.state.lock().unwrap().events.len(), 1);

    fixture.state.lock().unwrap().mode = 2;
    let recovered = fixture.collect();
    assert!(
        recovered.status.success(),
        "{}",
        String::from_utf8_lossy(&recovered.stderr)
    );
    assert_eq!(fixture.pending(), 0);
    let requests = {
        let state = fixture.state.lock().unwrap();
        assert_eq!(
            state.events.len(),
            1,
            "retry must not create a second event"
        );
        let event = state.events.values().next().unwrap();
        assert_eq!(event["inputTokens"], 100);
        assert_eq!(event["outputTokens"], 20);
        assert!(!event.to_string().contains("synthetic-project"));
        state.requests
    };
    assert!(fixture.collect().status.success());
    assert_eq!(
        fixture.state.lock().unwrap().requests,
        requests,
        "idle restart has no usage to send"
    );
}

#[test]
fn malformed_tail_is_reported_and_retried_after_repair() {
    let fixture = Fixture::new();
    assert!(fixture
        .command()
        .args(["target", "upsert"])
        .output()
        .unwrap()
        .status
        .success());
    fixture.state.lock().unwrap().mode = 2;
    let source = fixture.write_source();
    fs::OpenOptions::new()
        .append(true)
        .open(&source)
        .unwrap()
        .write_all(b"{\"private-unfinished-field\":")
        .unwrap();
    assert_eq!(fixture.collect().status.code(), Some(1));
    assert_eq!(fixture.pending(), 0, "valid usage can still be delivered");
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.events.len(), 1);
        let report = state.health.last().unwrap();
        assert_eq!(report["collectors"][0]["state"], "error");
        assert_eq!(report["collectors"][0]["parseErrors"], 1);
        assert_eq!(report["collectors"][0]["errorCode"], "parse_failed");
        assert!(!report.to_string().contains("private-unfinished-field"));
    }
    // No edit: the error must remain visible on the next process, not disappear
    // merely because the source mtime is unchanged.
    assert_eq!(fixture.collect().status.code(), Some(1));
    assert_eq!(
        fixture.state.lock().unwrap().health.last().unwrap()["collectors"][0]["parseErrors"],
        1
    );
    fixture.write_source();
    assert!(fixture.collect().status.success());
    let state = fixture.state.lock().unwrap();
    assert_eq!(
        state.health.last().unwrap()["collectors"][0]["parseErrors"],
        0
    );
    assert_eq!(state.events.len(), 1);
}
