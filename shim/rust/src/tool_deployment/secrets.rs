use std::collections::BTreeMap;
use std::io::{self, Write};
use std::process::Command;

use zeroize::Zeroizing;

use super::launcher::{build_mcp_launch, McpLaunchDefinition};
use super::state::tools_dir;

const SERVICE: &str = "toard";

fn definition_path(slug: &str) -> Option<std::path::PathBuf> {
    tools_dir().map(|directory| directory.join("deployments").join(format!("{slug}.json")))
}

fn fallback_path(slug: &str) -> Option<std::path::PathBuf> {
    tools_dir().map(|directory| directory.join("secrets").join(format!("{slug}.json")))
}

fn account(slug: &str, name: &str) -> String {
    format!("tool:{slug}:{name}")
}

pub(crate) fn load_definition(slug: &str) -> Result<McpLaunchDefinition, String> {
    let path = definition_path(slug).ok_or_else(|| "HOME 이 없습니다".to_string())?;
    let body = std::fs::read_to_string(path).map_err(|_| "설치된 MCP 정의를 찾지 못했습니다".to_string())?;
    serde_json::from_str(&body).map_err(|_| "설치된 MCP 정의가 손상됐습니다".to_string())
}

fn fallback_secrets(slug: &str) -> BTreeMap<String, String> {
    fallback_path(slug)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

pub(crate) fn load_secrets(slug: &str, names: &[String]) -> BTreeMap<String, String> {
    let fallback = fallback_secrets(slug);
    names
        .iter()
        .filter_map(|name| {
            let from_keyring = keyring::Entry::new(SERVICE, &account(slug, name))
                .ok()
                .and_then(|entry| entry.get_secret().ok())
                .and_then(|bytes| String::from_utf8(bytes).ok());
            from_keyring
                .or_else(|| fallback.get(name).cloned())
                .map(|value| (name.clone(), value))
        })
        .collect()
}

fn save_secret(slug: &str, name: &str, value: &str) -> Result<(), String> {
    if let Ok(entry) = keyring::Entry::new(SERVICE, &account(slug, name)) {
        if entry.set_secret(value.as_bytes()).is_ok() {
            return Ok(());
        }
    }
    let path = fallback_path(slug).ok_or_else(|| "HOME 이 없습니다".to_string())?;
    let mut values = fallback_secrets(slug);
    values.insert(name.to_owned(), value.to_owned());
    let body = serde_json::to_string(&values).map_err(|error| error.to_string())?;
    crate::fsx::write_atomic(&path, &body, 0o600).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn prompt_secret(name: &str) -> Result<Zeroizing<String>, String> {
    print!("{name}: ");
    io::stdout().flush().map_err(|error| error.to_string())?;
    let _ = Command::new("stty").arg("-echo").status();
    let mut value = String::new();
    let read = io::stdin().read_line(&mut value);
    let _ = Command::new("stty").arg("echo").status();
    println!();
    read.map_err(|error| error.to_string())?;
    let value = value.trim_end_matches(['\r', '\n']).to_owned();
    if value.is_empty() {
        return Err(format!("{name} 값이 비어 있습니다"));
    }
    Ok(Zeroizing::new(value))
}

#[cfg(not(unix))]
fn prompt_secret(_name: &str) -> Result<Zeroizing<String>, String> {
    Err("이 버전의 로컬 비밀값 입력은 macOS와 Linux만 지원합니다".into())
}

pub(crate) fn configure(slug: &str) -> i32 {
    let definition = match load_definition(slug) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("toard-shim: {error}");
            return 1;
        }
    };
    for name in &definition.required_env_names {
        let value = match prompt_secret(name) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("toard-shim: {error}");
                return 1;
            }
        };
        if let Err(error) = save_secret(slug, name, &value) {
            eprintln!("toard-shim: {name} 저장 실패: {error}");
            return 1;
        }
    }
    println!("  ✓ {slug} 로컬 설정 완료 — 값은 toard 서버로 전송되지 않습니다");
    0
}

pub(crate) fn run_mcp(slug: &str) -> i32 {
    let definition = match load_definition(slug) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("toard-shim: {error}");
            return 1;
        }
    };
    let secrets = load_secrets(slug, &definition.required_env_names);
    let launch = match build_mcp_launch(&definition, &secrets) {
        Ok(value) => value,
        Err(_) => {
            eprintln!("toard-shim: 로컬 설정이 필요합니다 — toard-shim tool configure {slug}");
            return 1;
        }
    };
    let mut command = Command::new(&launch.command);
    command.args(&launch.args).envs(&launch.env);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        eprintln!("toard-shim: MCP 실행 실패: {error}");
        1
    }
    #[cfg(windows)]
    {
        match command.status() {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => {
                eprintln!("toard-shim: MCP 실행 실패: {error}");
                1
            }
        }
    }
}
