// ~/.toard/credentials (key=value) 로딩. env(TOARD_INGEST_TOKEN/TOARD_INGEST_ENDPOINT)가 파일보다 우선.

use std::env;
use std::path::PathBuf;

pub const DEFAULT_ENDPOINT: &str = "http://localhost:3000/api";

#[derive(Debug, PartialEq)]
pub struct Credentials {
    pub token: Option<String>,
    pub endpoint: Option<String>,
    /// 본문 수집 opt-in 지속 플래그 (install.sh 가 기록). env 미설정 시 이 값을 따른다.
    pub collect_content: bool,
    /// 본문 백필 컷오프. 이 시점 이후 턴만 수집(§collect_content_since).
    /// ISO 날짜/`all`/미설정. 미설정 = "지금부터"(최초 활성화 시각을 state 에 기록).
    pub collect_content_since: Option<String>,
    /// MCP·스킬·플러그인 메타데이터 수집. 기본 on, 로컬에서 명시적으로 끌 수 있다.
    pub collect_tools: bool,
}

impl Default for Credentials {
    fn default() -> Self {
        Self {
            token: None,
            endpoint: None,
            collect_content: false,
            collect_content_since: None,
            collect_tools: true,
        }
    }
}

pub fn read_credentials() -> Credentials {
    let file = env::var_os("HOME")
        .map(|h| PathBuf::from(h).join(".toard").join("credentials"))
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
                "collect_content" => {
                    creds.collect_content = matches!(v, "1" | "true" | "on" | "yes")
                }
                "collect_content_since" if creds.collect_content_since.is_none() => {
                    creds.collect_content_since = Some(v.to_string())
                }
                "collect_tools" => creds.collect_tools = !matches!(v, "0" | "false" | "off" | "no"),
                _ => {}
            }
        }
    }
    creds
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
        assert!(parse("agent_key=t\ncollect_content=true\n").collect_content);
        assert!(parse("collect_content=1\n").collect_content);
        assert!(parse("collect_content=on\n").collect_content);
        // 기본은 false, falsy 값도 false
        assert!(!parse("agent_key=t\n").collect_content);
        assert!(!parse("collect_content=false\n").collect_content);
        assert!(!parse("collect_content=0\n").collect_content);
    }

    #[test]
    fn collect_tools_defaults_on_and_supports_opt_out() {
        assert!(parse("agent_key=t\n").collect_tools);
        assert!(!parse("collect_tools=false\n").collect_tools);
        assert!(!parse("collect_tools=0\n").collect_tools);
        assert!(parse("collect_tools=true\n").collect_tools);
    }
}
