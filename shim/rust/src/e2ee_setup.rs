use crate::content_crypto::{generate_device_keypair, wrap_for_device};
use crate::content_keys::{ContentKeyStore, SystemContentKeyStore};
use crate::credentials::{read_credentials, with_e2ee_activation, ContentCollectionMode};
use crate::recovery::RecoveryMaterial;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::Command;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

const SETUP_TIMEOUT_SECS: u64 = 600;
const MAX_HTTP_REQUEST_BYTES: usize = 16 * 1024;
const PAGE_TEMPLATE: &str = include_str!("e2ee_setup_page.html");
const PAGE_SCRIPT: &str = "document.getElementById('save-kit').addEventListener('click',()=>{const words=Array.from(document.querySelectorAll('[data-recovery-word]')).map((node,index)=>String(index+1).padStart(2,'0')+'. '+node.dataset.recoveryWord).join('\\n');const body='TOARD RECOVERY KIT\\n\\n'+words+'\\n';const link=document.createElement('a');link.href=URL.createObjectURL(new Blob([body],{type:'text/plain'}));link.download='toard-recovery-kit.txt';link.click();URL.revokeObjectURL(link.href);document.getElementById('saved').value='yes';document.getElementById('confirm').hidden=false;});";

#[derive(Debug, Clone, PartialEq, Eq)]
enum ConfirmationResult {
    Confirmed,
    Rejected { attempts_left: u8 },
    Locked,
    Expired,
    NotFound,
}

struct ConfirmationGate {
    capability: Zeroizing<String>,
    words: Vec<Zeroizing<String>>,
    positions: [usize; 3],
    expires_at: u64,
    attempts_left: u8,
    consumed: bool,
}

impl ConfirmationGate {
    fn new(capability: String, words: Vec<String>, positions: [usize; 3], expires_at: u64) -> Self {
        Self {
            capability: Zeroizing::new(capability),
            words: words.into_iter().map(Zeroizing::new).collect(),
            positions,
            expires_at,
            attempts_left: 3,
            consumed: false,
        }
    }

    fn confirm(&mut self, capability: &str, now: u64, answers: [&str; 3]) -> ConfirmationResult {
        if capability != self.capability.as_str() {
            return ConfirmationResult::NotFound;
        }
        if now > self.expires_at {
            return ConfirmationResult::Expired;
        }
        if self.consumed || self.attempts_left == 0 {
            return ConfirmationResult::Locked;
        }
        let matches = self
            .positions
            .iter()
            .zip(answers)
            .all(|(position, answer)| self.words[*position].as_str() == answer.trim());
        if matches {
            self.consumed = true;
            return ConfirmationResult::Confirmed;
        }
        self.attempts_left -= 1;
        if self.attempts_left == 0 {
            ConfirmationResult::Locked
        } else {
            ConfirmationResult::Rejected {
                attempts_left: self.attempts_left,
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetupError {
    MissingCredentials,
    InvalidEndpoint,
    RemoteSetup,
    AlreadyActive,
    LocalListener,
    BrowserLaunch,
    ConfirmationExpired,
    ConfirmationLocked,
    RemoteActivation,
    SecureStore,
    CredentialWrite,
    Crypto,
}

impl std::fmt::Display for SetupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::MissingCredentials => "수집 자격 증명이 없습니다",
            Self::InvalidEndpoint => "E2EE 설정 endpoint는 HTTPS 또는 localhost여야 합니다",
            Self::RemoteSetup => "E2EE 계정 준비에 실패했습니다",
            Self::AlreadyActive => "E2EE가 이미 활성화되어 있습니다",
            Self::LocalListener => "Recovery Kit 로컬 확인 서버를 열 수 없습니다",
            Self::BrowserLaunch => "Recovery Kit 브라우저 화면을 열 수 없습니다",
            Self::ConfirmationExpired => "Recovery Kit 확인 시간이 만료되었습니다",
            Self::ConfirmationLocked => "Recovery Kit 단어 확인 횟수를 초과했습니다",
            Self::RemoteActivation => "E2EE 활성화 요청에 실패했습니다",
            Self::SecureStore => "운영체제 보안 저장소에 키를 저장할 수 없습니다",
            Self::CredentialWrite => "E2EE 수집 설정을 저장할 수 없습니다",
            Self::Crypto => "E2EE 키 생성에 실패했습니다",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for SetupError {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreparedAccount {
    content_owner_id: String,
    recovery_salt: String,
    active_key_version: u16,
    state: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationBody {
    recovery_confirmed: bool,
    device: DeviceBody,
    wrappers: Vec<WrapperBody>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceBody {
    kind: &'static str,
    label: String,
    platform: &'static str,
    public_key: String,
    algorithm_version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WrapperBody {
    wrapper_type: &'static str,
    wrapper_ref: String,
    content_key_version: u16,
    kdf_version: &'static str,
    public_salt_or_input: Option<String>,
    nonce: Option<String>,
    auth_tag: Option<String>,
    encapsulated_key: Option<String>,
    wrapped_content_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingApprovalList {
    requests: Vec<PendingApproval>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingApproval {
    id: String,
    label: String,
    platform: String,
    public_key: String,
    created_at: String,
    expires_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApproveBody {
    confirmation_code: String,
    envelope: ApproveEnvelope,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApproveEnvelope {
    algorithm: &'static str,
    encapsulated_key: String,
    ciphertext: String,
}

pub fn run() -> i32 {
    match setup() {
        Ok(()) => {
            println!("toard-shim: E2EE 본문 수집이 활성화되었습니다");
            0
        }
        Err(error) => {
            eprintln!("toard-shim: {error}");
            1
        }
    }
}

pub fn approve(request_id: Option<&str>) -> i32 {
    match approve_inner(request_id) {
        Ok(()) => {
            println!("toard-shim: 새 브라우저를 승인했습니다");
            0
        }
        Err(error) => {
            eprintln!("toard-shim: {error}");
            1
        }
    }
}

pub fn status() -> i32 {
    let credentials = read_credentials();
    if credentials.collect_content != ContentCollectionMode::E2eeV1 {
        println!("toard-shim: E2EE 비활성 (본문 수집 off)");
        return 1;
    }
    let (Some(owner_id), Some(key_version), Some(device_id)) = (
        credentials.content_owner_id.as_deref(),
        credentials.content_key_version,
        credentials.content_device_id.as_deref(),
    ) else {
        eprintln!("toard-shim: E2EE 설정 메타데이터가 불완전합니다");
        return 1;
    };
    if SystemContentKeyStore
        .get_uck(owner_id, key_version)
        .is_err()
    {
        eprintln!("toard-shim: E2EE 키를 운영체제 보안 저장소에서 찾을 수 없습니다");
        return 1;
    }
    println!(
        "toard-shim: E2EE 활성 · 키 버전 {} · 기기 {}",
        key_version, device_id
    );
    0
}

fn approve_inner(request_id: Option<&str>) -> Result<(), SetupError> {
    let credentials = read_credentials();
    let token = credentials
        .token
        .as_deref()
        .ok_or(SetupError::MissingCredentials)?;
    let endpoint = credentials
        .endpoint
        .as_deref()
        .unwrap_or(crate::credentials::DEFAULT_ENDPOINT);
    if !endpoint_is_secure(endpoint) {
        return Err(SetupError::InvalidEndpoint);
    }
    let owner_id = credentials
        .content_owner_id
        .as_deref()
        .ok_or(SetupError::MissingCredentials)?;
    let key_version = credentials
        .content_key_version
        .ok_or(SetupError::MissingCredentials)?;
    let pending: PendingApprovalList = remote_json(
        endpoint,
        token,
        "/v1/content/approval-requests",
        None,
        SetupError::RemoteSetup,
    )?;
    let request = select_approval_request(&pending.requests, request_id)?;
    println!(
        "승인 요청: {} ({})\n요청 시각: {}\n만료 시각: {}\n요청 ID: {}",
        request.label, request.platform, request.created_at, request.expires_at, request.id
    );
    print!("브라우저에 표시된 6자리 코드를 입력하세요: ");
    std::io::stdout()
        .flush()
        .map_err(|_| SetupError::LocalListener)?;
    let mut code = String::new();
    std::io::stdin()
        .read_line(&mut code)
        .map_err(|_| SetupError::LocalListener)?;
    let code = code.trim();
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(SetupError::RemoteActivation);
    }
    let public_key = decode_b64url(&request.public_key).ok_or(SetupError::Crypto)?;
    let uck = SystemContentKeyStore
        .get_uck(owner_id, key_version)
        .map_err(|_| SetupError::SecureStore)?;
    let envelope = wrap_for_device(&public_key, &uck[..]).map_err(|_| SetupError::Crypto)?;
    let body = ApproveBody {
        confirmation_code: code.to_string(),
        envelope: ApproveEnvelope {
            algorithm: "hpke-p256-hkdf-sha256-aes256gcm-v1",
            encapsulated_key: b64url(&envelope.encapsulated_key),
            ciphertext: b64url(&envelope.ciphertext),
        },
    };
    let body = serde_json::to_vec(&body).map_err(|_| SetupError::Crypto)?;
    remote_json::<serde_json::Value>(
        endpoint,
        token,
        &format!("/v1/content/approval-requests/{}/approve", request.id),
        Some(&body),
        SetupError::RemoteActivation,
    )?;
    Ok(())
}

fn select_approval_request<'a>(
    requests: &'a [PendingApproval],
    request_id: Option<&str>,
) -> Result<&'a PendingApproval, SetupError> {
    if let Some(request_id) = request_id {
        return requests
            .iter()
            .find(|request| request.id == request_id)
            .ok_or(SetupError::RemoteSetup);
    }
    if requests.len() == 1 {
        Ok(&requests[0])
    } else {
        Err(SetupError::RemoteSetup)
    }
}

fn setup() -> Result<(), SetupError> {
    let credentials = read_credentials();
    if credentials.collect_content == ContentCollectionMode::E2eeV1 {
        return Ok(());
    }
    let token = credentials
        .token
        .as_deref()
        .ok_or(SetupError::MissingCredentials)?;
    let endpoint = credentials
        .endpoint
        .as_deref()
        .unwrap_or(crate::credentials::DEFAULT_ENDPOINT);
    if !endpoint_is_secure(endpoint) {
        return Err(SetupError::InvalidEndpoint);
    }

    let prepared: PreparedAccount = remote_json(
        endpoint,
        token,
        "/v1/content/setup",
        None,
        SetupError::RemoteSetup,
    )?;
    if prepared.state == "active" {
        return Err(SetupError::AlreadyActive);
    }

    let uck = Zeroizing::new(rand::random::<[u8; 32]>());
    let device_pair = generate_device_keypair().map_err(|_| SetupError::Crypto)?;
    let recovery = RecoveryMaterial::generate().map_err(|_| SetupError::Crypto)?;
    run_recovery_confirmation(recovery.mnemonic())?;

    let salt = decode_b64url(&prepared.recovery_salt).ok_or(SetupError::RemoteSetup)?;
    if salt.len() != 32 {
        return Err(SetupError::RemoteSetup);
    }
    let recovery_wrapper = recovery
        .wrap_uck(
            &salt,
            &uck[..],
            &prepared.content_owner_id,
            u32::from(prepared.active_key_version),
        )
        .map_err(|_| SetupError::Crypto)?;
    let device_envelope =
        wrap_for_device(&device_pair.public_key, &uck[..]).map_err(|_| SetupError::Crypto)?;
    let device_id = random_uuid_v4();
    let body = ActivationBody {
        recovery_confirmed: true,
        device: DeviceBody {
            kind: "shim",
            label: format!("toard shim ({})", std::env::consts::OS),
            platform: std::env::consts::OS,
            public_key: b64url(&device_pair.public_key),
            algorithm_version: "hpke-p256-v1",
        },
        wrappers: vec![
            WrapperBody {
                wrapper_type: "recovery",
                wrapper_ref: "account".into(),
                content_key_version: prepared.active_key_version,
                kdf_version: "hkdf-sha256-v1",
                public_salt_or_input: Some(prepared.recovery_salt.clone()),
                nonce: Some(b64url(&recovery_wrapper.nonce)),
                auth_tag: Some(b64url(&recovery_wrapper.auth_tag)),
                encapsulated_key: None,
                wrapped_content_key: b64url(&recovery_wrapper.wrapped_content_key),
            },
            WrapperBody {
                wrapper_type: "device",
                wrapper_ref: device_id.clone(),
                content_key_version: prepared.active_key_version,
                kdf_version: "hpke-p256-v1",
                public_salt_or_input: None,
                nonce: None,
                auth_tag: None,
                encapsulated_key: Some(b64url(&device_envelope.encapsulated_key)),
                wrapped_content_key: b64url(&device_envelope.ciphertext),
            },
        ],
    };
    let body = serde_json::to_vec(&body).map_err(|_| SetupError::Crypto)?;
    let activation = remote_json::<serde_json::Value>(
        endpoint,
        token,
        "/v1/content/activate",
        Some(&body),
        SetupError::RemoteActivation,
    );

    let credentials_path = crate::fsx::home_dir()
        .ok_or(SetupError::CredentialWrite)?
        .join(".toard")
        .join("credentials");
    let original_credentials = std::fs::read_to_string(&credentials_path).unwrap_or_default();
    let updated_credentials = with_e2ee_activation(
        &original_credentials,
        &prepared.content_owner_id,
        prepared.active_key_version,
        &device_id,
    )
    .map_err(|_| SetupError::CredentialWrite)?;
    let key_store = SystemContentKeyStore;

    commit_after_activation(
        activation.map(|_| ()),
        || {
            key_store
                .put_uck(
                    &prepared.content_owner_id,
                    prepared.active_key_version,
                    &uck,
                )
                .map_err(|_| SetupError::SecureStore)?;
            key_store
                .put_device_private_key(&device_id, &device_pair.private_key)
                .map_err(|_| SetupError::SecureStore)
        },
        || {
            crate::fsx::write_atomic(&credentials_path, &updated_credentials, 0o600)
                .map_err(|_| SetupError::CredentialWrite)
        },
    )
}

fn commit_after_activation<T>(
    activation: Result<T, SetupError>,
    store_keys: impl FnOnce() -> Result<(), SetupError>,
    store_credentials: impl FnOnce() -> Result<(), SetupError>,
) -> Result<T, SetupError> {
    let result = activation?;
    store_keys()?;
    store_credentials()?;
    Ok(result)
}

fn run_recovery_confirmation(mnemonic: &str) -> Result<(), SetupError> {
    let words = mnemonic
        .split_whitespace()
        .map(str::to_string)
        .collect::<Vec<_>>();
    if words.len() != 24 {
        return Err(SetupError::Crypto);
    }
    let capability = random_hex::<32>();
    let positions = random_positions();
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| SetupError::LocalListener)?;
    listener
        .set_nonblocking(true)
        .map_err(|_| SetupError::LocalListener)?;
    let address = listener
        .local_addr()
        .map_err(|_| SetupError::LocalListener)?;
    let expires_at = now_secs().saturating_add(SETUP_TIMEOUT_SECS);
    let mut gate = ConfirmationGate::new(capability.clone(), words, positions, expires_at);
    let url = format!("http://{address}/recovery/{capability}");
    open_browser(&url)?;

    serve_recovery_confirmation(&listener, address, &mut gate)
}

fn serve_recovery_confirmation(
    listener: &TcpListener,
    address: SocketAddr,
    gate: &mut ConfirmationGate,
) -> Result<(), SetupError> {
    loop {
        if now_secs() > gate.expires_at {
            return Err(SetupError::ConfirmationExpired);
        }
        match listener.accept() {
            Ok((mut stream, peer)) => {
                if !peer.ip().is_loopback() {
                    continue;
                }
                match handle_loopback_request(&mut stream, address, gate) {
                    Ok(Some(ConfirmationResult::Confirmed)) => return Ok(()),
                    Ok(Some(ConfirmationResult::Locked)) => {
                        return Err(SetupError::ConfirmationLocked)
                    }
                    Ok(Some(ConfirmationResult::Expired)) => {
                        return Err(SetupError::ConfirmationExpired)
                    }
                    Ok(_) | Err(_) => {}
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return Err(SetupError::LocalListener),
        }
    }
}

fn handle_loopback_request(
    stream: &mut TcpStream,
    address: SocketAddr,
    gate: &mut ConfirmationGate,
) -> Result<Option<ConfirmationResult>, SetupError> {
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| SetupError::LocalListener)?;
    let request = read_http_request(stream)?;
    let request_text = String::from_utf8(request).map_err(|_| SetupError::LocalListener)?;
    let (headers, body) = request_text
        .split_once("\r\n\r\n")
        .unwrap_or((&request_text, ""));
    let mut request_line = headers
        .lines()
        .next()
        .unwrap_or_default()
        .split_whitespace();
    let method = request_line.next().unwrap_or_default();
    let path = request_line.next().unwrap_or_default();
    let page_path = format!("/recovery/{}", gate.capability.as_str());
    let confirm_path = format!("{page_path}/confirm");

    if method == "GET" && path == page_path {
        let page = render_page(address, gate);
        write_response(stream, 200, "text/html; charset=utf-8", &page)?;
        return Ok(None);
    }
    if method == "POST" && path == confirm_path {
        let form = parse_form(body);
        if form.get("saved").map(String::as_str) != Some("yes") {
            write_response(
                stream,
                400,
                "text/plain; charset=utf-8",
                "먼저 Recovery Kit를 저장하세요.",
            )?;
            return Ok(None);
        }
        let empty = String::new();
        let answers = [
            form.get("word0").unwrap_or(&empty).as_str(),
            form.get("word1").unwrap_or(&empty).as_str(),
            form.get("word2").unwrap_or(&empty).as_str(),
        ];
        let submitted_capability = path
            .strip_prefix("/recovery/")
            .and_then(|value| value.strip_suffix("/confirm"))
            .unwrap_or_default();
        let result = gate.confirm(submitted_capability, now_secs(), answers);
        let (status, message) = match result {
            ConfirmationResult::Confirmed => (200, "확인되었습니다. 이 창을 닫아도 됩니다.".into()),
            ConfirmationResult::Rejected { attempts_left } => (
                400,
                format!("단어가 일치하지 않습니다. 남은 횟수: {attempts_left}"),
            ),
            ConfirmationResult::Locked => (429, "확인 횟수를 초과했습니다.".into()),
            ConfirmationResult::Expired => (410, "확인 시간이 만료되었습니다.".into()),
            ConfirmationResult::NotFound => (404, "찾을 수 없습니다.".into()),
        };
        write_response(stream, status, "text/plain; charset=utf-8", &message)?;
        return Ok(Some(result));
    }
    write_response(stream, 404, "text/plain; charset=utf-8", "not found")?;
    Ok(Some(ConfirmationResult::NotFound))
}

fn render_page(address: SocketAddr, gate: &ConfirmationGate) -> String {
    let word_items = gate
        .words
        .iter()
        .enumerate()
        .map(|(index, word)| {
            let word = escape_html(word);
            format!(
                "<li class=\"word\"><span class=\"word-index\">{:02}</span><span class=\"word-value\" data-recovery-word=\"{word}\">{word}</span></li>",
                index + 1
            )
        })
        .collect::<Vec<_>>()
        .join("");
    let inputs = gate
        .positions
        .iter()
        .enumerate()
        .map(|(index, position)| {
            format!(
                "<label>{:02}번 단어<input name=\"word{index}\" autocomplete=\"off\" required></label>",
                position + 1
            )
        })
        .collect::<Vec<_>>()
        .join("");
    PAGE_TEMPLATE
        .replace("{{WORD_ITEMS}}", &word_items)
        .replace("{{INPUTS}}", &inputs)
        .replace(
            "{{ACTION}}",
            &format!(
                "http://{address}/recovery/{}/confirm",
                gate.capability.as_str()
            ),
        )
        .replace("{{SCRIPT}}", PAGE_SCRIPT)
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    content_type: &str,
    body: &str,
) -> Result<(), SetupError> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        410 => "Gone",
        429 => "Too Many Requests",
        _ => "Error",
    };
    let csp = format!(
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-{}'; form-action 'self'",
        b64standard(&Sha256::digest(PAGE_SCRIPT.as_bytes()))
    );
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nContent-Security-Policy: {csp}\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream
        .write_all(response.as_bytes())
        .map_err(|_| SetupError::LocalListener)
}

fn read_http_request(stream: &mut TcpStream) -> Result<Vec<u8>, SetupError> {
    let mut request = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    loop {
        let read = stream
            .read(&mut chunk)
            .map_err(|_| SetupError::LocalListener)?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.len() > MAX_HTTP_REQUEST_BYTES {
            return Err(SetupError::LocalListener);
        }
        if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
            let body_start = header_end + 4;
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if body_start.saturating_add(content_length) > MAX_HTTP_REQUEST_BYTES {
                return Err(SetupError::LocalListener);
            }
            if request.len() >= body_start + content_length {
                request.truncate(body_start + content_length);
                break;
            }
        }
    }
    Ok(request)
}

fn remote_json<T: for<'de> Deserialize<'de>>(
    endpoint: &str,
    token: &str,
    path: &str,
    body: Option<&[u8]>,
    error: SetupError,
) -> Result<T, SetupError> {
    let url = format!("{}{path}", endpoint.trim_end_matches('/'));
    let mut command = Command::new("curl");
    command
        .arg("-fsS")
        .arg("--max-time")
        .arg("30")
        .arg("-X")
        .arg("POST")
        .arg("-H")
        .arg(format!("Authorization: Bearer {token}"))
        .arg("-H")
        .arg("Content-Type: application/json")
        .arg(&url);
    if let Some(body) = body {
        let path = crate::fsx::state_dir()
            .ok_or(error)?
            .join(format!("e2ee-activate-{}.json", random_hex::<8>()));
        crate::fsx::write_atomic(&path, std::str::from_utf8(body).map_err(|_| error)?, 0o600)
            .map_err(|_| error)?;
        command
            .arg("--data-binary")
            .arg(format!("@{}", path.display()));
        let output = command.output().map_err(|_| error);
        let _ = std::fs::remove_file(path);
        let output = output?;
        if !output.status.success() {
            return Err(error);
        }
        return serde_json::from_slice(&output.stdout).map_err(|_| error);
    }
    let output = command.output().map_err(|_| error)?;
    if !output.status.success() {
        return Err(error);
    }
    serde_json::from_slice(&output.stdout).map_err(|_| error)
}

fn open_browser(url: &str) -> Result<(), SetupError> {
    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(url).status();
    #[cfg(target_os = "windows")]
    let status = Command::new("cmd").args(["/C", "start", "", url]).status();
    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open").arg(url).status();
    status
        .ok()
        .filter(|status| status.success())
        .map(|_| ())
        .ok_or(SetupError::BrowserLaunch)
}

fn endpoint_is_secure(endpoint: &str) -> bool {
    endpoint.starts_with("https://")
        || endpoint.starts_with("http://localhost")
        || endpoint.starts_with("http://127.0.0.1")
        || endpoint.starts_with("http://[::1]")
}

fn random_positions() -> [usize; 3] {
    let mut positions = [0usize; 3];
    for index in 0..3 {
        loop {
            let candidate = (rand::random::<u64>() % 24) as usize;
            if !positions[..index].contains(&candidate) {
                positions[index] = candidate;
                break;
            }
        }
    }
    positions.sort_unstable();
    positions
}

fn random_uuid_v4() -> String {
    let mut bytes = rand::random::<[u8; 16]>();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn random_hex<const N: usize>() -> String {
    rand::random::<[u8; N]>()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn parse_form(body: &str) -> std::collections::HashMap<String, String> {
    body.split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, value)| (percent_decode(key), percent_decode(value)))
        .collect()
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => output.push(b' '),
            b'%' if index + 2 < bytes.len() => {
                if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                    output.push(byte);
                    index += 2;
                }
            }
            byte => output.push(byte),
        }
        index += 1;
    }
    String::from_utf8(output).unwrap_or_default()
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

fn b64url(bytes: &[u8]) -> String {
    b64_with_alphabet(
        bytes,
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
    )
}

fn b64standard(bytes: &[u8]) -> String {
    let mut output = b64_with_alphabet(
        bytes,
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",
    );
    while !output.len().is_multiple_of(4) {
        output.push('=');
    }
    output
}

fn b64_with_alphabet(bytes: &[u8], alphabet: &[u8; 64]) -> String {
    let mut output = String::with_capacity((bytes.len() * 4).div_ceil(3));
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        output.push(alphabet[(first >> 2) as usize] as char);
        output.push(alphabet[(((first & 3) << 4) | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(alphabet[(((second & 15) << 2) | (third >> 6)) as usize] as char);
        }
        if chunk.len() > 2 {
            output.push(alphabet[(third & 63) as usize] as char);
        }
    }
    output
}

fn decode_b64url(value: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(value.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0u8;
    for byte in value.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' => 62,
            b'_' => 63,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    if bits > 0 && buffer != 0 {
        return None;
    }
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::net::Shutdown;
    use std::thread;

    fn gate() -> ConfirmationGate {
        ConfirmationGate::new(
            "capability".into(),
            (1..=24).map(|index| format!("word{index}")).collect(),
            [2, 10, 21],
            1_000,
        )
    }

    #[test]
    fn capability_and_expiry_are_fail_closed() {
        let mut gate = gate();
        assert_eq!(
            gate.confirm("wrong", 100, ["word3", "word11", "word22"]),
            ConfirmationResult::NotFound
        );
        assert_eq!(
            gate.confirm("capability", 1_001, ["word3", "word11", "word22"]),
            ConfirmationResult::Expired
        );
    }

    #[test]
    fn three_mismatches_lock_confirmation_and_correct_words_succeed() {
        let mut locked_gate = gate();
        for expected_attempts in [2, 1] {
            assert_eq!(
                locked_gate.confirm("capability", 100, ["wrong", "wrong", "wrong"]),
                ConfirmationResult::Rejected {
                    attempts_left: expected_attempts
                }
            );
        }
        assert_eq!(
            locked_gate.confirm("capability", 100, ["wrong", "wrong", "wrong"]),
            ConfirmationResult::Locked
        );
        assert_eq!(
            locked_gate.confirm("capability", 100, ["word3", "word11", "word22"]),
            ConfirmationResult::Locked
        );

        let mut fresh = gate();
        assert_eq!(
            fresh.confirm("capability", 100, ["word3", "word11", "word22"]),
            ConfirmationResult::Confirmed
        );
    }

    #[test]
    fn activation_failure_does_not_commit_local_state_or_log_mnemonic() {
        let writes = RefCell::new(Vec::new());
        let result = commit_after_activation(
            Err::<(), _>(SetupError::RemoteActivation),
            || {
                writes.borrow_mut().push("keyring");
                Ok(())
            },
            || {
                writes.borrow_mut().push("credentials");
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(writes.borrow().is_empty());
        assert!(!result.unwrap_err().to_string().contains("word1"));
    }

    #[test]
    fn local_page_has_no_store_csp_and_does_not_put_words_in_action() {
        let gate = gate();
        let page = render_page("127.0.0.1:1234".parse().unwrap(), &gate);
        assert_eq!(page.matches("data-recovery-word=\"").count(), 24);
        assert!(page.contains("<span class=\"word-index\">01</span>"));
        assert!(page.contains("<span class=\"word-index\">24</span>"));
        assert!(page.contains("03번 단어"));
        assert!(page.contains("11번 단어"));
        assert!(page.contains("22번 단어"));
        assert!(!page.contains("/confirm?"));
        assert!(page.contains("grid-template-columns:repeat(4,minmax(0,1fr))"));
        assert!(page.contains("grid-template-columns:repeat(2,minmax(0,1fr))"));
        assert!(PAGE_SCRIPT.contains("toard-recovery-kit.txt"));
        assert!(PAGE_SCRIPT.contains("padStart(2,'0')"));
        assert!(PAGE_SCRIPT.contains("+'. '+node.dataset.recoveryWord"));
        assert!(PAGE_SCRIPT.contains("join('\\n')"));
        assert_eq!(decode_b64url(&b64url(&[7u8; 32])).unwrap(), [7u8; 32]);
    }

    #[test]
    fn malformed_browser_connection_does_not_stop_recovery_confirmation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let mut gate = ConfirmationGate::new(
                "capability".into(),
                (1..=24).map(|index| format!("word{index}")).collect(),
                [2, 10, 21],
                now_secs() + 60,
            );
            serve_recovery_confirmation(&listener, address, &mut gate)
        });

        let mut malformed = TcpStream::connect(address).unwrap();
        malformed.write_all(&[0xff]).unwrap();
        malformed.shutdown(Shutdown::Write).unwrap();
        thread::sleep(Duration::from_millis(20));

        let body = "saved=yes&word0=word3&word1=word11&word2=word22";
        let request = format!(
            "POST /recovery/capability/confirm HTTP/1.1\r\nHost: {address}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len(),
        );
        let mut valid = TcpStream::connect(address).unwrap();
        valid.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        valid.read_to_string(&mut response).unwrap();

        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert_eq!(server.join().unwrap(), Ok(()));
    }
}
