// ~/.toard/credentials (key=value) 로딩. env(TOARD_INGEST_TOKEN/TOARD_INGEST_ENDPOINT)가 파일보다 우선.

use std::env;

pub const DEFAULT_ENDPOINT: &str = "http://localhost:3000/api";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ContentCollectionMode {
    Off,
    ServerV1,
    E2eeV1,
}

impl ContentCollectionMode {
    pub fn parse(value: &str) -> Self {
        match value.trim().to_ascii_lowercase().as_str() {
            "e2ee_v1" => Self::E2eeV1,
            "1" | "true" | "on" | "yes" | "server_v1" => Self::ServerV1,
            _ => Self::Off,
        }
    }

    pub fn is_enabled(self) -> bool {
        self != Self::Off
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Credentials {
    pub token: Option<String>,
    pub endpoint: Option<String>,
    /// 본문 수집 opt-in 지속 플래그 (install.sh 가 기록). env 미설정 시 이 값을 따른다.
    pub collect_content: ContentCollectionMode,
    /// 본문 백필 컷오프. 이 시점 이후 턴만 수집(§collect_content_since).
    /// ISO 날짜/`all`/미설정. 미설정 = "지금부터"(최초 활성화 시각을 state 에 기록).
    pub collect_content_since: Option<String>,
    /// MCP·스킬·플러그인 메타데이터 수집. 기본 on, 로컬에서 명시적으로 끌 수 있다.
    pub collect_tools: bool,
    pub content_owner_id: Option<String>,
    pub content_key_version: Option<u16>,
    pub content_device_id: Option<String>,
}

pub struct InstallerCredentialsInput {
    pub token: String,
    pub endpoint: String,
    pub collect_content: Option<String>,
    pub collect_tools: Option<String>,
    pub collect_content_since: Option<String>,
}

impl Default for Credentials {
    fn default() -> Self {
        Self {
            token: None,
            endpoint: None,
            collect_content: ContentCollectionMode::Off,
            collect_content_since: None,
            collect_tools: true,
            content_owner_id: None,
            content_key_version: None,
            content_device_id: None,
        }
    }
}

pub fn read_credentials() -> Credentials {
    let file = crate::fsx::home_dir()
        .map(|h| h.join(".toard").join("credentials"))
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|c| parse(&c))
        .unwrap_or_default();
    let non_empty = |v: String| if v.trim().is_empty() { None } else { Some(v) };
    Credentials {
        token: env::var("TOARD_INGEST_TOKEN")
            .ok()
            .and_then(non_empty)
            .or(file.token),
        endpoint: env::var("TOARD_INGEST_ENDPOINT")
            .ok()
            .and_then(non_empty)
            .or(file.endpoint),
        collect_content: file.collect_content,
        collect_content_since: env::var("TOARD_SHIM_COLLECT_CONTENT_SINCE")
            .ok()
            .and_then(non_empty)
            .or(file.collect_content_since),
        collect_tools: match env::var("TOARD_SHIM_COLLECT_TOOLS").ok().as_deref() {
            Some("0" | "false" | "off" | "no") => false,
            Some("1" | "true" | "on" | "yes") => true,
            _ => file.collect_tools,
        },
        content_owner_id: file.content_owner_id,
        content_key_version: file.content_key_version,
        content_device_id: file.content_device_id,
    }
}

pub fn parse(content: &str) -> Credentials {
    let mut creds = Credentials::default();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let v = v.trim();
            if v.is_empty() {
                continue;
            }
            match k.trim() {
                "agent_key" if creds.token.is_none() => creds.token = Some(v.to_string()),
                "endpoint" if creds.endpoint.is_none() => creds.endpoint = Some(v.to_string()),
                "collect_content" => creds.collect_content = ContentCollectionMode::parse(v),
                "collect_content_since" if creds.collect_content_since.is_none() => {
                    creds.collect_content_since = Some(v.to_string())
                }
                "collect_tools" => creds.collect_tools = !matches!(v, "0" | "false" | "off" | "no"),
                "content_owner_id" if creds.content_owner_id.is_none() => {
                    creds.content_owner_id = Some(v.to_string())
                }
                "content_key_version" if creds.content_key_version.is_none() => {
                    creds.content_key_version = v.parse::<u16>().ok().filter(|version| *version > 0)
                }
                "content_device_id" if creds.content_device_id.is_none() => {
                    creds.content_device_id = Some(v.to_string())
                }
                _ => {}
            }
        }
    }
    creds
}

pub fn from_installer_input(input: InstallerCredentialsInput) -> Result<Credentials, &'static str> {
    fn required(value: String) -> Result<String, &'static str> {
        if value.trim().is_empty() || value.contains(['\r', '\n']) {
            return Err("missing or invalid installer credential");
        }
        Ok(value.trim().to_string())
    }

    fn optional(value: Option<String>) -> Result<Option<String>, &'static str> {
        match value {
            Some(value) if value.contains(['\r', '\n']) => {
                Err("invalid multiline installer policy")
            }
            Some(value) if value.trim().is_empty() => Ok(None),
            Some(value) => Ok(Some(value.trim().to_string())),
            None => Ok(None),
        }
    }

    let collect_content = optional(input.collect_content)?
        .map(|value| ContentCollectionMode::parse(&value))
        .unwrap_or(ContentCollectionMode::Off);
    let collect_tools = optional(input.collect_tools)?
        .map(|value| !matches!(value.as_str(), "0" | "false" | "off" | "no"))
        .unwrap_or(true);

    Ok(Credentials {
        token: Some(required(input.token)?),
        endpoint: Some(required(input.endpoint)?),
        collect_content,
        collect_content_since: optional(input.collect_content_since)?,
        collect_tools,
        ..Credentials::default()
    })
}

pub fn serialize(credentials: &Credentials) -> String {
    let mut output = String::new();
    if let Some(token) = credentials.token.as_deref() {
        output.push_str("agent_key=");
        output.push_str(token);
        output.push('\n');
    }
    if let Some(endpoint) = credentials.endpoint.as_deref() {
        output.push_str("endpoint=");
        output.push_str(endpoint);
        output.push('\n');
    }
    output.push_str("collect_content=");
    output.push_str(match credentials.collect_content {
        ContentCollectionMode::Off => "off",
        ContentCollectionMode::ServerV1 => "server_v1",
        ContentCollectionMode::E2eeV1 => "e2ee_v1",
    });
    output.push('\n');
    if let Some(since) = credentials.collect_content_since.as_deref() {
        output.push_str("collect_content_since=");
        output.push_str(since);
        output.push('\n');
    }
    output.push_str(if credentials.collect_tools {
        "collect_tools=true\n"
    } else {
        "collect_tools=false\n"
    });
    if let Some(owner_id) = credentials.content_owner_id.as_deref() {
        output.push_str("content_owner_id=");
        output.push_str(owner_id);
        output.push('\n');
    }
    if let Some(version) = credentials.content_key_version {
        output.push_str("content_key_version=");
        output.push_str(&version.to_string());
        output.push('\n');
    }
    if let Some(device_id) = credentials.content_device_id.as_deref() {
        output.push_str("content_device_id=");
        output.push_str(device_id);
        output.push('\n');
    }
    output
}

pub fn with_e2ee_activation(
    content: &str,
    owner_id: &str,
    key_version: u16,
    device_id: &str,
) -> Result<String, &'static str> {
    if owner_id.is_empty()
        || device_id.is_empty()
        || key_version == 0
        || owner_id.contains(['\r', '\n'])
        || device_id.contains(['\r', '\n'])
    {
        return Err("invalid E2EE credential metadata");
    }
    const MANAGED: [&str; 5] = [
        "collect_content",
        "e2ee_setup_requested",
        "content_owner_id",
        "content_key_version",
        "content_device_id",
    ];
    let mut output = String::new();
    for line in content.lines() {
        let key = line.split_once('=').map(|(key, _)| key.trim());
        if key.is_some_and(|key| MANAGED.contains(&key)) {
            continue;
        }
        output.push_str(line);
        output.push('\n');
    }
    output.push_str("collect_content=e2ee_v1\n");
    output.push_str(&format!("content_owner_id={owner_id}\n"));
    output.push_str(&format!("content_key_version={key_version}\n"));
    output.push_str(&format!("content_device_id={device_id}\n"));
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_basic() {
        let c = parse("agent_key=tk_abc\nendpoint=https://toard.example.com/api\n");
        assert_eq!(c.token.as_deref(), Some("tk_abc"));
        assert_eq!(c.endpoint.as_deref(), Some("https://toard.example.com/api"));
    }

    #[test]
    fn parse_ignores_comments_blank_unknown() {
        let c = parse("# 주석\n\nfoo=bar\n  agent_key = tk_x  \n");
        assert_eq!(c.token.as_deref(), Some("tk_x"));
        assert_eq!(c.endpoint, None);
    }

    #[test]
    fn parse_first_value_wins() {
        let c = parse("agent_key=first\nagent_key=second\n");
        assert_eq!(c.token.as_deref(), Some("first"));
    }

    #[test]
    fn parse_empty_value_skipped() {
        let c = parse("agent_key=\nendpoint=https://x\n");
        assert_eq!(c.token, None);
        assert_eq!(c.endpoint.as_deref(), Some("https://x"));
    }

    #[test]
    fn parse_collect_content_flag() {
        assert_eq!(
            parse("agent_key=t\ncollect_content=true\n").collect_content,
            ContentCollectionMode::ServerV1
        );
        assert_eq!(
            parse("collect_content=1\n").collect_content,
            ContentCollectionMode::ServerV1
        );
        assert_eq!(
            parse("collect_content=on\n").collect_content,
            ContentCollectionMode::ServerV1
        );
        assert_eq!(
            parse("collect_content=e2ee_v1\n").collect_content,
            ContentCollectionMode::E2eeV1
        );
        assert_eq!(
            parse("agent_key=t\n").collect_content,
            ContentCollectionMode::Off
        );
        assert_eq!(
            parse("collect_content=false\n").collect_content,
            ContentCollectionMode::Off
        );
        assert_eq!(
            parse("collect_content=0\n").collect_content,
            ContentCollectionMode::Off
        );
    }

    #[test]
    fn e2ee_activation_updates_only_managed_credentials() {
        let updated = with_e2ee_activation(
            "# keep\nagent_key=tk_test\nendpoint=https://example.test/api\ncollect_content=off\ne2ee_setup_requested=true\ncustom=value\n",
            "owner-1",
            2,
            "device-1",
        )
        .unwrap();
        assert!(updated.contains("# keep\n"));
        assert!(updated.contains("custom=value\n"));
        assert!(updated.contains("collect_content=e2ee_v1\n"));
        assert!(updated.contains("content_owner_id=owner-1\n"));
        assert!(updated.contains("content_key_version=2\n"));
        assert!(updated.contains("content_device_id=device-1\n"));
        assert!(!updated.contains("e2ee_setup_requested"));
    }

    #[test]
    fn collect_tools_defaults_on_and_supports_opt_out() {
        assert!(parse("agent_key=t\n").collect_tools);
        assert!(!parse("collect_tools=false\n").collect_tools);
        assert!(!parse("collect_tools=0\n").collect_tools);
        assert!(parse("collect_tools=true\n").collect_tools);
    }

    #[test]
    fn installer_input_is_independent_from_file_parse() {
        let file = parse("agent_key=company\nendpoint=https://company.example/api\n");
        let personal = from_installer_input(InstallerCredentialsInput {
            token: "personal".into(),
            endpoint: "https://personal.example/api".into(),
            collect_content: Some("true".into()),
            collect_tools: Some("false".into()),
            collect_content_since: None,
        })
        .unwrap();

        assert_eq!(
            file.endpoint.as_deref(),
            Some("https://company.example/api")
        );
        assert_eq!(
            personal.endpoint.as_deref(),
            Some("https://personal.example/api")
        );
        assert_eq!(personal.collect_content, ContentCollectionMode::ServerV1);
        assert!(!personal.collect_tools);
    }

    #[test]
    fn serialized_credentials_round_trip_all_managed_metadata() {
        let original = Credentials {
            token: Some("secret".into()),
            endpoint: Some("https://toard.example/api".into()),
            collect_content: ContentCollectionMode::E2eeV1,
            collect_content_since: Some("all".into()),
            collect_tools: false,
            content_owner_id: Some("owner-1".into()),
            content_key_version: Some(2),
            content_device_id: Some("device-1".into()),
        };

        assert_eq!(parse(&serialize(&original)), original);
    }

    #[test]
    fn installer_input_rejects_missing_or_multiline_secrets() {
        for (token, endpoint) in [
            ("", "https://toard.example/api"),
            ("secret\nleak", "https://toard.example/api"),
            ("secret", ""),
            ("secret", "https://toard.example/api\nextra"),
        ] {
            assert!(from_installer_input(InstallerCredentialsInput {
                token: token.into(),
                endpoint: endpoint.into(),
                collect_content: None,
                collect_tools: None,
                collect_content_since: None,
            })
            .is_err());
        }
    }
}
