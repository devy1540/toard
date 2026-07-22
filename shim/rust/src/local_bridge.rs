//! Browser-to-shim loopback control bridge.
//!
//! The bridge is deliberately small: loopback-only TCP, exact registered-origin CORS,
//! short-lived in-memory sessions, and an allow-list of shim actions. It never returns
//! ingest tokens, credentials, raw logs, or other targets' endpoints to the browser.

use serde_json::json;
use socket2::{Domain, Socket, Type};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use url::Url;

use crate::credentials::ContentCollectionMode;
use crate::targets::{Target, TargetStore};

const DEFAULT_PORT: u16 = 38_473;
const BIND_RETRY_ATTEMPTS: usize = 40;
const BIND_RETRY_DELAY: Duration = Duration::from_millis(50);
const MAX_REQUEST_BYTES: usize = 32 * 1024;
const SESSION_TTL_SECS: u64 = 10 * 60;
const HELPER_SESSION_TTL_SECS: u64 = 30;
const INTERNAL_SECRET_FILE: &str = "local-bridge-secret";
const BRIDGE_LOG_FILE: &str = "local-bridge.log";
const BRIDGE_ERR_FILE: &str = "local-bridge.err.log";
pub(crate) const BRIDGE_ACTION_ENV: &str = "TOARD_SHIM_LOCAL_ACTION";

#[derive(Debug)]
struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
}

#[derive(Debug)]
struct Response {
    status: u16,
    content_type: &'static str,
    body: String,
    headers: Vec<(String, String)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnectionFlow {
    Continue,
    Shutdown,
    Restart,
}

impl Response {
    fn json(status: u16, value: serde_json::Value) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            body: value.to_string(),
            headers: Vec::new(),
        }
    }

    fn empty(status: u16) -> Self {
        Self {
            status,
            content_type: "text/plain; charset=utf-8",
            body: String::new(),
            headers: Vec::new(),
        }
    }

    fn html(body: String, script_nonce: &str) -> Self {
        Self {
            status: 200,
            content_type: "text/html; charset=utf-8",
            body,
            headers: vec![(
                "Content-Security-Policy".into(),
                format!(
                    "default-src 'none'; script-src 'nonce-{script_nonce}'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
                ),
            )],
        }
    }

    fn with_cors(mut self, origin: &str) -> Self {
        self.headers.extend([
            ("Access-Control-Allow-Origin".into(), origin.into()),
            (
                "Access-Control-Allow-Methods".into(),
                "GET, POST, OPTIONS".into(),
            ),
            (
                "Access-Control-Allow-Headers".into(),
                "Authorization, Content-Type, X-Toard-Target".into(),
            ),
            ("Access-Control-Allow-Private-Network".into(), "true".into()),
            ("Vary".into(), "Origin".into()),
        ]);
        self
    }
}

#[derive(Debug)]
struct Session {
    token: String,
    origin: String,
    target_id: String,
    expires_at: u64,
}

#[derive(Default)]
struct Sessions(Vec<Session>);

impl Sessions {
    fn issue(&mut self, origin: &str, target_id: &str, now: u64) -> String {
        self.0.retain(|session| session.expires_at >= now);
        if self.0.len() >= 16 {
            self.0.remove(0);
        }
        let token = random_hex::<32>();
        self.0.push(Session {
            token: token.clone(),
            origin: origin.into(),
            target_id: target_id.into(),
            expires_at: now.saturating_add(SESSION_TTL_SECS),
        });
        token
    }

    fn allows(
        &mut self,
        origin: &str,
        target_id: &str,
        authorization: Option<&str>,
        now: u64,
    ) -> bool {
        self.0.retain(|session| session.expires_at >= now);
        let Some(token) = authorization.and_then(|value| value.strip_prefix("Bearer ")) else {
            return false;
        };
        self.0.iter().any(|session| {
            session.origin == origin && session.target_id == target_id && session.token == token
        })
    }
}

#[derive(Debug)]
struct HelperSession {
    capability: String,
    target_id: String,
    expires_at: u64,
}

#[derive(Default)]
struct HelperSessions(Vec<HelperSession>);

impl HelperSessions {
    fn issue(&mut self, target_id: &str, now: u64) -> String {
        self.0.retain(|session| session.expires_at >= now);
        if self.0.len() >= 16 {
            self.0.remove(0);
        }
        let capability = random_hex::<32>();
        self.0.push(HelperSession {
            capability: capability.clone(),
            target_id: target_id.into(),
            expires_at: now.saturating_add(HELPER_SESSION_TTL_SECS),
        });
        capability
    }

    fn consume(&mut self, authorization: Option<&str>, now: u64) -> Option<String> {
        self.0.retain(|session| session.expires_at >= now);
        let capability = authorization?.strip_prefix("Bearer ")?.trim();
        let index = self
            .0
            .iter()
            .position(|session| session.capability == capability)?;
        Some(self.0.remove(index).target_id)
    }
}

pub fn run(args: &[String]) -> i32 {
    match args.first().map(String::as_str) {
        Some("start") if args.len() == 1 => {
            if ensure_background() {
                println!("  ✓ UI 로컬 bridge 실행 중 — http://127.0.0.1:{}", port());
                0
            } else {
                eprintln!("toard-shim: UI 로컬 bridge 시작 실패");
                1
            }
        }
        Some("stop") if args.len() == 1 => {
            if stop_background() {
                println!("  ✓ UI 로컬 bridge 종료됨");
                0
            } else {
                eprintln!("toard-shim: UI 로컬 bridge 종료 실패");
                1
            }
        }
        Some("status") if args.len() == 1 => {
            if is_running() {
                println!("  ✓ UI 로컬 bridge 실행 중 — http://127.0.0.1:{}", port());
                0
            } else {
                println!("  - UI 로컬 bridge 미실행");
                1
            }
        }
        Some("serve") if args.len() == 1 => serve(),
        Some("restart-after-update") if args.len() == 1 => {
            std::thread::sleep(Duration::from_millis(300));
            if ensure_background() {
                0
            } else {
                1
            }
        }
        _ => {
            eprintln!("toard-shim: local 사용법: start|stop|status");
            2
        }
    }
}

pub fn ensure_background_quiet() {
    let _ = ensure_background();
}

pub fn ensure_background() -> bool {
    crate::daemon::cleanup_legacy_local_bridge_service_quiet();
    if is_running() {
        return true;
    }
    if crate::daemon::start_local_bridge_service_quiet() && wait_until_running() {
        return true;
    }
    let Some(state) = crate::fsx::state_dir() else {
        return false;
    };
    if std::fs::create_dir_all(&state).is_err() || load_or_create_secret().is_none() {
        return false;
    }
    let Some(exe) = control_exe() else {
        return false;
    };
    let stdout = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(state.join(BRIDGE_LOG_FILE))
    {
        Ok(file) => file,
        Err(_) => return false,
    };
    let stderr = match OpenOptions::new()
        .create(true)
        .append(true)
        .open(state.join(BRIDGE_ERR_FILE))
    {
        Ok(file) => file,
        Err(_) => return false,
    };
    let mut command = Command::new(exe);
    command
        .args(["local", "serve"])
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    configure_detached(&mut command);
    if command.spawn().is_err() {
        return false;
    }
    wait_until_running()
}

fn wait_until_running() -> bool {
    for _ in 0..40 {
        if is_running() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

pub fn stop_background_quiet() {
    let _ = stop_background();
}

fn stop_background() -> bool {
    if !is_running() {
        return true;
    }
    internal_request("/internal/shutdown")
}

pub(crate) fn is_running() -> bool {
    internal_request("/internal/ping")
}

fn internal_request(path: &str) -> bool {
    let Some(secret) = load_secret() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port())) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(1)));
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Toard-Local-Secret: {secret}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = [0u8; 64];
    stream
        .read(&mut response)
        .ok()
        .is_some_and(|read| String::from_utf8_lossy(&response[..read]).starts_with("HTTP/1.1 200"))
}

fn serve() -> i32 {
    let Some(secret) = load_or_create_secret() else {
        eprintln!("toard-shim: UI 로컬 bridge secret을 준비하지 못했습니다");
        return 1;
    };
    let listener = match bind_listener() {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("toard-shim: UI 로컬 bridge port를 열 수 없습니다: {error}");
            return 1;
        }
    };
    let store = match TargetStore::from_home() {
        Ok(store) => store,
        Err(error) => {
            eprintln!("toard-shim: UI 로컬 bridge target 저장소를 열 수 없습니다: {error}");
            return 1;
        }
    };
    let mut sessions = Sessions::default();
    let mut helper_sessions = HelperSessions::default();
    for incoming in listener.incoming() {
        let Ok(mut stream) = incoming else { continue };
        let peer_is_loopback = stream.peer_addr().is_ok_and(|peer| peer.ip().is_loopback());
        if !peer_is_loopback {
            continue;
        }
        match handle_connection(
            &mut stream,
            &store,
            &secret,
            &mut sessions,
            &mut helper_sessions,
        ) {
            ConnectionFlow::Continue => {}
            ConnectionFlow::Shutdown => return 0,
            ConnectionFlow::Restart => return restart_process(),
        }
    }
    0
}

fn bind_listener() -> std::io::Result<TcpListener> {
    bind_listener_at_with_retry(port(), BIND_RETRY_ATTEMPTS)
}

fn bind_listener_at(port: u16) -> std::io::Result<TcpListener> {
    let socket = Socket::new(Domain::IPV4, Type::STREAM, None)?;
    #[cfg(unix)]
    socket.set_reuse_address(true)?;
    socket.bind(&SocketAddr::from((Ipv4Addr::LOCALHOST, port)).into())?;
    socket.listen(128)?;
    Ok(socket.into())
}

fn bind_listener_at_with_retry(port: u16, attempts: usize) -> std::io::Result<TcpListener> {
    let attempts = attempts.max(1);
    for attempt in 1..=attempts {
        match bind_listener_at(port) {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse && attempt < attempts => {
                std::thread::sleep(BIND_RETRY_DELAY);
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("at least one bind attempt always runs")
}

fn handle_connection(
    stream: &mut TcpStream,
    store: &TargetStore,
    secret: &str,
    sessions: &mut Sessions,
    helper_sessions: &mut HelperSessions,
) -> ConnectionFlow {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = match read_request(stream) {
        Ok(request) => request,
        Err(()) => {
            let _ = write_response(
                stream,
                Response::json(400, json!({ "error": "bad_request" })),
            );
            return ConnectionFlow::Continue;
        }
    };
    let (response, flow) = route_request(&request, store, secret, sessions, helper_sessions);
    let _ = write_response(stream, response);
    flow
}

fn route_request(
    request: &Request,
    store: &TargetStore,
    secret: &str,
    sessions: &mut Sessions,
    helper_sessions: &mut HelperSessions,
) -> (Response, ConnectionFlow) {
    if request.path == "/internal/ping" || request.path == "/internal/shutdown" {
        let allowed = request
            .headers
            .get("x-toard-local-secret")
            .is_some_and(|value| value == secret);
        let status = if allowed { 200 } else { 403 };
        return (
            Response::json(status, json!({ "ok": allowed })),
            if allowed && request.path == "/internal/shutdown" {
                ConnectionFlow::Shutdown
            } else {
                ConnectionFlow::Continue
            },
        );
    }

    if request.method == "GET" && request.path.starts_with("/v1/helper?") {
        return helper_page_response(request, store, helper_sessions);
    }

    if request.path == "/v1/helper/status" || request.path.starts_with("/v1/helper/actions/") {
        return helper_request_response(request, store, helper_sessions);
    }

    let Some(origin) = request.headers.get("origin") else {
        return (
            Response::json(403, json!({ "error": "origin_required" })),
            ConnectionFlow::Continue,
        );
    };
    let targets = match store.load_readonly() {
        Ok(targets) => targets,
        Err(_) => {
            return (
                Response::json(503, json!({ "error": "targets_unavailable" })),
                ConnectionFlow::Continue,
            )
        }
    };

    if request.method == "OPTIONS" {
        let allowed = targets
            .iter()
            .any(|target| target_ui_origin(target).as_deref() == Some(origin));
        return (
            if allowed {
                Response::empty(204).with_cors(origin)
            } else {
                Response::json(403, json!({ "error": "origin_denied" }))
            },
            ConnectionFlow::Continue,
        );
    }

    let Some(target_id) = request.headers.get("x-toard-target") else {
        return (
            Response::json(400, json!({ "error": "target_required" })),
            ConnectionFlow::Continue,
        );
    };
    let Some(target) = target_for_request(&targets, origin, target_id) else {
        return (
            Response::json(403, json!({ "error": "origin_denied" })),
            ConnectionFlow::Continue,
        );
    };

    if request.method == "GET" && request.path == "/v1/status" {
        let session = sessions.issue(origin, &target.id, crate::bg::now_unix());
        return (
            status_response(target, session).with_cors(origin),
            ConnectionFlow::Continue,
        );
    }

    if request.method != "POST"
        || !sessions.allows(
            origin,
            &target.id,
            request.headers.get("authorization").map(String::as_str),
            crate::bg::now_unix(),
        )
    {
        return (
            Response::json(401, json!({ "error": "session_required" })).with_cors(origin),
            ConnectionFlow::Continue,
        );
    }

    let action = match request.path.as_str() {
        "/v1/actions/collect" => Some("collect"),
        "/v1/actions/doctor" => Some("doctor"),
        "/v1/actions/update" => Some("update"),
        _ => None,
    };
    let Some(action) = action else {
        return (
            Response::json(404, json!({ "error": "not_found" })).with_cors(origin),
            ConnectionFlow::Continue,
        );
    };
    let (code, restart) = execute_action(action, target);
    let flow = if restart {
        ConnectionFlow::Restart
    } else {
        ConnectionFlow::Continue
    };
    (
        Response::json(
            if code == 0 { 200 } else { 500 },
            json!({ "ok": code == 0, "action": action, "exitCode": code }),
        )
        .with_cors(origin),
        flow,
    )
}

fn helper_page_response(
    request: &Request,
    store: &TargetStore,
    helper_sessions: &mut HelperSessions,
) -> (Response, ConnectionFlow) {
    let Some(url) = Url::parse(&format!("http://127.0.0.1{}", request.path)).ok() else {
        return (
            Response::json(400, json!({ "error": "invalid_helper_request" })),
            ConnectionFlow::Continue,
        );
    };
    let params: HashMap<String, String> = url.query_pairs().into_owned().collect();
    let Some(target_id) = params.get("target") else {
        return (
            Response::json(400, json!({ "error": "target_required" })),
            ConnectionFlow::Continue,
        );
    };
    let Some(nonce) = params.get("nonce") else {
        return (
            Response::json(400, json!({ "error": "nonce_required" })),
            ConnectionFlow::Continue,
        );
    };
    if target_id.len() != 64
        || !target_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !(16..=64).contains(&nonce.len())
        || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return (
            Response::json(400, json!({ "error": "invalid_helper_request" })),
            ConnectionFlow::Continue,
        );
    }

    let targets = match store.load_readonly() {
        Ok(targets) => targets,
        Err(_) => {
            return (
                Response::json(503, json!({ "error": "targets_unavailable" })),
                ConnectionFlow::Continue,
            )
        }
    };
    let Some(target) = targets.iter().find(|target| target.id == *target_id) else {
        return (
            Response::json(404, json!({ "error": "target_not_found" })),
            ConnectionFlow::Continue,
        );
    };
    let Some(ui_origin) = target_ui_origin(target) else {
        return (
            Response::json(403, json!({ "error": "origin_unavailable" })),
            ConnectionFlow::Continue,
        );
    };
    let capability = helper_sessions.issue(&target.id, crate::bg::now_unix());
    let script_nonce = random_hex::<16>();
    let expected_origin = serde_json::to_string(&ui_origin).unwrap_or_else(|_| "null".into());
    let message_nonce = serde_json::to_string(nonce).unwrap_or_else(|_| "null".into());
    let capability_json = serde_json::to_string(&capability).unwrap_or_else(|_| "null".into());
    let html = format!(
        "<!doctype html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>toard local shim</title><style>body{{margin:0;background:#111;color:#eee;font:14px system-ui;display:grid;min-height:100vh;place-items:center}}main{{max-width:320px;padding:24px;text-align:center}}p{{color:#aaa;line-height:1.5}}</style></head><body><main><strong>toard</strong><p id=\"message\">로컬 shim에 안전하게 연결하는 중입니다…</p></main><script nonce=\"{script_nonce}\">const expectedOrigin={expected_origin};const messageNonce={message_nonce};const capability={capability_json};const message=document.getElementById('message');const reply=(value)=>window.opener?.postMessage({{protocol:'toard-helper-v1',nonce:messageNonce,...value}},expectedOrigin);const receive=async(event)=>{{if(event.source!==window.opener||event.origin!==expectedOrigin||event.data?.protocol!=='toard-helper-v1'||event.data?.nonce!==messageNonce)return;const action=event.data.action;if(!['status','collect','doctor','update'].includes(action))return;removeEventListener('message',receive);try{{const path=action==='status'?'/v1/helper/status':`/v1/helper/actions/${{action}}`;const response=await fetch(path,{{method:action==='status'?'GET':'POST',credentials:'omit',cache:'no-store',headers:{{Authorization:`Bearer ${{capability}}`}}}});const value=await response.json();reply({{action,ok:response.ok&&value.ok===true,value}});message.textContent=response.ok?'연결이 완료되었습니다.':'로컬 shim 작업에 실패했습니다.';}}catch(error){{reply({{action,ok:false,error:'helper_request_failed'}});message.textContent='로컬 shim 작업에 실패했습니다.';}}setTimeout(()=>window.close(),100);}};addEventListener('message',receive);if(window.opener)reply({{ready:true}});else message.textContent='toard 설정 화면에서 다시 연결해 주세요.';</script></body></html>"
    );
    (
        Response::html(html, &script_nonce),
        ConnectionFlow::Continue,
    )
}

fn helper_request_response(
    request: &Request,
    store: &TargetStore,
    helper_sessions: &mut HelperSessions,
) -> (Response, ConnectionFlow) {
    let expected_method = if request.path == "/v1/helper/status" {
        "GET"
    } else {
        "POST"
    };
    if request.method != expected_method {
        return (
            Response::json(400, json!({ "error": "invalid_helper_method" })),
            ConnectionFlow::Continue,
        );
    }
    let Some(target_id) = helper_sessions.consume(
        request.headers.get("authorization").map(String::as_str),
        crate::bg::now_unix(),
    ) else {
        return (
            Response::json(401, json!({ "error": "helper_session_required" })),
            ConnectionFlow::Continue,
        );
    };
    let targets = match store.load_readonly() {
        Ok(targets) => targets,
        Err(_) => {
            return (
                Response::json(503, json!({ "error": "targets_unavailable" })),
                ConnectionFlow::Continue,
            )
        }
    };
    let Some(target) = targets.iter().find(|target| target.id == target_id) else {
        return (
            Response::json(404, json!({ "error": "target_not_found" })),
            ConnectionFlow::Continue,
        );
    };

    if request.path == "/v1/helper/status" {
        let value = serde_json::from_str::<serde_json::Value>(
            &status_response(target, random_hex::<32>()).body,
        )
        .unwrap_or_else(|_| json!({}));
        return (
            Response::json(200, json!({ "ok": true, "status": value })),
            ConnectionFlow::Continue,
        );
    }

    let action = request.path.trim_start_matches("/v1/helper/actions/");
    if !matches!(action, "collect" | "doctor" | "update") {
        return (
            Response::json(404, json!({ "error": "not_found" })),
            ConnectionFlow::Continue,
        );
    }
    let (code, restart) = execute_action(action, target);
    let value = serde_json::from_str::<serde_json::Value>(
        &status_response(target, random_hex::<32>()).body,
    )
    .unwrap_or_else(|_| json!({}));
    (
        Response::json(
            if code == 0 { 200 } else { 500 },
            json!({ "ok": code == 0, "action": action, "exitCode": code, "status": value }),
        ),
        if restart {
            ConnectionFlow::Restart
        } else {
            ConnectionFlow::Continue
        },
    )
}

#[cfg(windows)]
fn spawn_restart_after_update() -> bool {
    let Some(exe) = control_exe() else {
        return false;
    };
    let mut command = Command::new(exe);
    command
        .args(["local", "restart-after-update"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    configure_detached(&mut command);
    command.spawn().is_ok()
}

#[cfg(unix)]
fn restart_process() -> i32 {
    use std::os::unix::process::CommandExt;

    let Some(exe) = control_exe() else { return 1 };
    let error = Command::new(exe).args(["local", "serve"]).exec();
    eprintln!("toard-shim: 업데이트 후 UI 로컬 bridge 재시작 실패: {error}");
    1
}

#[cfg(windows)]
fn restart_process() -> i32 {
    if spawn_restart_after_update() {
        0
    } else {
        1
    }
}

fn status_response(target: &Target, session: String) -> Response {
    let content = match target.credentials.collect_content {
        ContentCollectionMode::Off => "off",
        ContentCollectionMode::ServerManaged => "server_v1",
        ContentCollectionMode::LegacyE2eeV1 => "e2ee_v1",
    };
    let delivery = crate::delivery::load(&target.state_dir).map(|status| {
        json!({
            "result": status.result,
            "lastAttemptAt": status.last_attempt_at,
            "lastSuccessAt": status.last_success_at,
        })
    });
    let daemon = match crate::daemon::state() {
        crate::daemon::State::Unsupported { os } => {
            json!({ "installed": false, "active": false, "backend": null, "intervalSecs": null, "unsupportedOs": os })
        }
        crate::daemon::State::NotInstalled => {
            json!({ "installed": false, "active": false, "backend": null, "intervalSecs": null })
        }
        crate::daemon::State::Installed {
            backend,
            interval,
            active,
        } => json!({
            "installed": true,
            "active": active,
            "backend": backend,
            "intervalSecs": interval,
        }),
    };
    Response::json(
        200,
        json!({
            "protocol": "toard-local-v1",
            "session": session,
            "version": crate::cli::version(),
            "platform": std::env::consts::OS,
            "host": crate::host::host_label(),
            "daemon": daemon,
            "target": {
                "id": target.id.get(..12).unwrap_or(&target.id),
                "content": content,
                "tools": target.credentials.collect_tools,
                "delivery": delivery,
            },
            "capabilities": ["collect", "doctor", "update"],
        }),
    )
}

fn execute_action(action: &str, target: &Target) -> (i32, bool) {
    let Some(exe) = control_exe() else {
        return (1, false);
    };
    let previous_version = crate::cli::version().to_string();
    let mut command = Command::new(exe);
    command.env(BRIDGE_ACTION_ENV, "1");
    match action {
        "collect" => {
            command
                .args(["collect", "--quiet", "--target-env"])
                .env("TOARD_INGEST_ENDPOINT", &target.endpoint);
        }
        "doctor" => {
            command
                .args(["doctor", "--target-env"])
                .env("TOARD_INGEST_ENDPOINT", &target.endpoint);
        }
        "update" => {
            command.arg("update");
        }
        _ => return (2, false),
    }
    let code = command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()
        .and_then(|status| status.code())
        .unwrap_or(1);
    let restart = action == "update"
        && code == 0
        && control_exe()
            .and_then(|exe| Command::new(exe).arg("version").output().ok())
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
            .is_some_and(|version| version != previous_version);
    (code, restart)
}

fn target_for_request<'a>(
    targets: &'a [Target],
    origin: &str,
    target_id: &str,
) -> Option<&'a Target> {
    if target_id.len() != 64 || !target_id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    targets.iter().find(|target| {
        target.id == target_id && target_ui_origin(target).as_deref() == Some(origin)
    })
}

fn target_ui_origin(target: &Target) -> Option<String> {
    target
        .credentials
        .ui_origin
        .clone()
        .or_else(|| endpoint_origin(&target.endpoint))
}

fn endpoint_origin(endpoint: &str) -> Option<String> {
    Some(Url::parse(endpoint).ok()?.origin().ascii_serialization())
}

fn control_exe() -> Option<PathBuf> {
    let current = std::env::current_exe().ok()?;
    let name = if cfg!(windows) {
        "toard-shim.exe"
    } else {
        "toard-shim"
    };
    let sibling = current.parent()?.join(name);
    Some(if sibling.is_file() { sibling } else { current })
}

fn configure_detached(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
}

fn port() -> u16 {
    std::env::var("TOARD_SHIM_LOCAL_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value >= 1024)
        .unwrap_or(DEFAULT_PORT)
}

fn secret_path() -> Option<PathBuf> {
    Some(crate::fsx::state_dir()?.join(INTERNAL_SECRET_FILE))
}

fn load_secret() -> Option<String> {
    let secret = std::fs::read_to_string(secret_path()?).ok()?;
    let secret = secret.trim();
    (secret.len() == 64 && secret.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| secret.to_string())
}

fn load_or_create_secret() -> Option<String> {
    if let Some(secret) = load_secret() {
        return Some(secret);
    }
    let secret = random_hex::<32>();
    crate::fsx::write_atomic(&secret_path()?, &format!("{secret}\n"), 0o600).ok()?;
    Some(secret)
}

fn random_hex<const N: usize>() -> String {
    rand::random::<[u8; N]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn read_request(stream: &mut TcpStream) -> Result<Request, ()> {
    let mut bytes = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    loop {
        let read = stream.read(&mut chunk).map_err(|_| ())?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
        if bytes.len() > MAX_REQUEST_BYTES {
            return Err(());
        }
        if bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let text = String::from_utf8(bytes).map_err(|_| ())?;
    let headers_text = text.split_once("\r\n\r\n").map_or(text.as_str(), |v| v.0);
    let mut lines = headers_text.lines();
    let mut request_line = lines.next().ok_or(())?.split_whitespace();
    let method = request_line.next().ok_or(())?.to_string();
    let path = request_line.next().ok_or(())?.to_string();
    let mut headers = HashMap::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or(())?;
        headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
    }
    Ok(Request {
        method,
        path,
        headers,
    })
}

fn write_response(stream: &mut TcpStream, response: Response) -> std::io::Result<()> {
    let reason = match response.status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Error",
    };
    let mut headers = String::new();
    for (name, value) in response.headers {
        headers.push_str(&format!("{name}: {value}\r\n"));
    }
    let wire = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n{}Connection: close\r\n\r\n{}",
        response.status,
        reason,
        response.content_type,
        response.body.len(),
        headers,
        response.body,
    );
    stream.write_all(wire.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(endpoint: &str) -> Target {
        Target {
            id: crate::targets::target_id(endpoint),
            revision: "revision".into(),
            endpoint: endpoint.into(),
            credentials_path: "credentials".into(),
            state_dir: "state".into(),
            credentials: crate::credentials::Credentials {
                endpoint: Some(endpoint.into()),
                token: Some("secret-token".into()),
                ..Default::default()
            },
        }
    }

    #[test]
    fn target_selection_requires_exact_id_and_registered_ui_origin() {
        let targets = vec![
            target("https://shared.example/company/api"),
            target("https://shared.example/personal/api"),
        ];
        let personal_id = targets[1].id.clone();
        assert_eq!(
            target_for_request(&targets, "https://shared.example", &personal_id)
                .map(|target| target.endpoint.as_str()),
            Some("https://shared.example/personal/api")
        );
        assert!(target_for_request(&targets, "https://evil.example", &personal_id).is_none());
        assert!(target_for_request(&targets, "https://shared.example", "bad-id").is_none());

        let mut split = target("https://ingest.example/api");
        split.credentials.ui_origin = Some("https://dashboard.example".into());
        assert!(target_for_request(
            std::slice::from_ref(&split),
            "https://dashboard.example",
            &split.id,
        )
        .is_some());
    }

    #[test]
    fn sessions_are_origin_bound_and_expire() {
        let mut sessions = Sessions::default();
        let target_id = "a".repeat(64);
        let token = sessions.issue("https://toard.example", &target_id, 1_000);
        let authorization = format!("Bearer {token}");
        assert!(sessions.allows(
            "https://toard.example",
            &target_id,
            Some(&authorization),
            1_001
        ));
        assert!(!sessions.allows(
            "https://other.example",
            &target_id,
            Some(&authorization),
            1_001
        ));
        assert!(!sessions.allows(
            "https://toard.example",
            &"b".repeat(64),
            Some(&authorization),
            1_001
        ));
        assert!(!sessions.allows(
            "https://toard.example",
            &target_id,
            Some(&authorization),
            1_000 + SESSION_TTL_SECS + 1
        ));
    }

    #[test]
    fn cors_is_exact_and_private_network_compatible() {
        let response = Response::empty(204).with_cors("https://toard.example");
        assert!(response.headers.contains(&(
            "Access-Control-Allow-Origin".into(),
            "https://toard.example".into()
        )));
        assert!(response
            .headers
            .contains(&("Access-Control-Allow-Private-Network".into(), "true".into())));
        assert!(response.headers.iter().any(|(name, value)| {
            name == "Access-Control-Allow-Headers" && value.contains("X-Toard-Target")
        }));
        assert!(!response.headers.iter().any(|(_, value)| value == "*"));
    }

    #[test]
    fn preflight_uses_registered_ui_origin_without_requiring_target_header() {
        let root = std::env::temp_dir().join(format!(
            "toard-local-preflight-{}-{}",
            std::process::id(),
            crate::bg::now_unix()
        ));
        let store = TargetStore::from_root(root.join(".toard"));
        store
            .upsert(crate::credentials::Credentials {
                endpoint: Some("https://ingest.example/api".into()),
                ui_origin: Some("https://dashboard.example".into()),
                token: Some("test-token".into()),
                ..Default::default()
            })
            .unwrap();
        let request = Request {
            method: "OPTIONS".into(),
            path: "/v1/status".into(),
            headers: HashMap::from([("origin".into(), "https://dashboard.example".into())]),
        };
        let mut sessions = Sessions::default();
        let mut helper_sessions = HelperSessions::default();

        let (response, flow) = route_request(
            &request,
            &store,
            "secret",
            &mut sessions,
            &mut helper_sessions,
        );

        assert_eq!(response.status, 204);
        assert!(response.headers.contains(&(
            "Access-Control-Allow-Origin".into(),
            "https://dashboard.example".into()
        )));
        assert_eq!(flow, ConnectionFlow::Continue);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn helper_page_uses_one_time_target_bound_capability_without_exposing_credentials() {
        let root = std::env::temp_dir().join(format!(
            "toard-local-helper-{}-{}",
            std::process::id(),
            crate::bg::now_unix()
        ));
        let store = TargetStore::from_root(root.join(".toard"));
        store
            .upsert(crate::credentials::Credentials {
                endpoint: Some("https://ingest.example/api".into()),
                ui_origin: Some("https://dashboard.example".into()),
                token: Some("test-token".into()),
                ..Default::default()
            })
            .unwrap();
        let target_id = crate::targets::target_id("https://ingest.example/api");
        let request = Request {
            method: "GET".into(),
            path: format!("/v1/helper?target={target_id}&nonce={}", "a".repeat(32)),
            headers: HashMap::new(),
        };
        let mut sessions = Sessions::default();
        let mut helper_sessions = HelperSessions::default();

        let (page, flow) = route_request(
            &request,
            &store,
            "secret",
            &mut sessions,
            &mut helper_sessions,
        );

        assert_eq!(page.status, 200);
        assert_eq!(page.content_type, "text/html; charset=utf-8");
        assert!(page.body.contains("toard-helper-v1"));
        assert!(page.body.contains("https://dashboard.example"));
        assert!(!page.body.contains("test-token"));
        assert!(!page.body.contains("ingest.example"));
        assert!(page.headers.iter().any(|(name, value)| {
            name == "Content-Security-Policy"
                && value.contains("connect-src 'self'")
                && value.contains("frame-ancestors 'none'")
        }));
        assert_eq!(helper_sessions.0.len(), 1);
        assert_eq!(flow, ConnectionFlow::Continue);

        let capability = helper_sessions.0[0].capability.clone();
        let status_request = Request {
            method: "GET".into(),
            path: "/v1/helper/status".into(),
            headers: HashMap::from([("authorization".into(), format!("Bearer {capability}"))]),
        };
        let (status, _) = route_request(
            &status_request,
            &store,
            "secret",
            &mut sessions,
            &mut helper_sessions,
        );
        assert_eq!(status.status, 200);
        assert!(helper_sessions.0.is_empty());
        assert!(!status.body.contains("test-token"));
        assert!(!status.body.contains("ingest.example"));

        let (replayed, _) = route_request(
            &status_request,
            &store,
            "secret",
            &mut sessions,
            &mut helper_sessions,
        );
        assert_eq!(replayed.status, 401);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn default_port_matches_the_fixed_ui_contract() {
        // Keep the public browser contract explicit so changing it requires changing the web
        // client too. The env override is only an operator/debug escape hatch.
        assert_eq!(DEFAULT_PORT, 38_473);
    }

    #[cfg(unix)]
    #[test]
    fn listener_can_rebind_immediately_after_a_served_connection() {
        let listener = bind_listener_at(0).unwrap();
        let address = listener.local_addr().unwrap();
        let client = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream.write_all(b"request").unwrap();
            let mut response = [0u8; 2];
            stream.read_exact(&mut response).unwrap();
        });
        let (mut stream, _) = listener.accept().unwrap();
        let mut request = [0u8; 7];
        stream.read_exact(&mut request).unwrap();
        stream.write_all(b"ok").unwrap();
        drop(stream);
        drop(listener);
        client.join().unwrap();

        let rebound = bind_listener_at_with_retry(address.port(), BIND_RETRY_ATTEMPTS).unwrap();
        assert_eq!(rebound.local_addr().unwrap().port(), address.port());
    }

    #[test]
    fn unregistered_origin_gets_no_session_or_cors_headers() {
        let root = std::env::temp_dir().join(format!(
            "toard-local-origin-{}-{}",
            std::process::id(),
            crate::bg::now_unix()
        ));
        let store = TargetStore::from_root(root.join(".toard"));
        store
            .upsert(crate::credentials::Credentials {
                endpoint: Some("https://toard.example/api".into()),
                token: Some("test-token".into()),
                ..Default::default()
            })
            .unwrap();
        let target_id = crate::targets::target_id("https://toard.example/api");
        let request = Request {
            method: "GET".into(),
            path: "/v1/status".into(),
            headers: HashMap::from([
                ("origin".into(), "https://evil.example".into()),
                ("x-toard-target".into(), target_id),
            ]),
        };
        let mut sessions = Sessions::default();
        let mut helper_sessions = HelperSessions::default();

        let (response, flow) = route_request(
            &request,
            &store,
            "secret",
            &mut sessions,
            &mut helper_sessions,
        );

        assert_eq!(response.status, 403);
        assert!(response.headers.is_empty());
        assert!(sessions.0.is_empty());
        assert_eq!(flow, ConnectionFlow::Continue);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn real_loopback_status_request_returns_cors_scoped_contract() {
        let root = std::env::temp_dir().join(format!(
            "toard-local-http-{}-{}",
            std::process::id(),
            crate::bg::now_unix()
        ));
        let store = TargetStore::from_root(root.join(".toard"));
        store
            .upsert(crate::credentials::Credentials {
                endpoint: Some("https://toard.example/api".into()),
                token: Some("test-token".into()),
                ..Default::default()
            })
            .unwrap();
        let target_id = crate::targets::target_id("https://toard.example/api");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, peer) = listener.accept().unwrap();
            assert!(peer.ip().is_loopback());
            let mut sessions = Sessions::default();
            let mut helper_sessions = HelperSessions::default();
            assert_eq!(
                handle_connection(
                    &mut stream,
                    &store,
                    "a".repeat(64).as_str(),
                    &mut sessions,
                    &mut helper_sessions,
                ),
                ConnectionFlow::Continue
            );
        });

        let mut client = TcpStream::connect(address).unwrap();
        client
            .write_all(
                format!("GET /v1/status HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: https://toard.example\r\nX-Toard-Target: {target_id}\r\nConnection: close\r\n\r\n").as_bytes(),
            )
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).unwrap();
        server.join().unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Access-Control-Allow-Origin: https://toard.example"));
        assert!(response.contains("Access-Control-Allow-Private-Network: true"));
        let body = response.split_once("\r\n\r\n").unwrap().1;
        let value: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(value["protocol"], "toard-local-v1");
        assert_eq!(value["target"]["id"].as_str().unwrap().len(), 12);
        assert!(value["session"].as_str().unwrap().len() >= 32);
        assert!(!body.contains("test-token"));
        assert!(!body.contains("credentials"));
        assert!(!body.contains("toard.example"));
        let _ = std::fs::remove_dir_all(root);
    }
}
