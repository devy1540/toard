// ~/.toard/credentials (key=value) 로딩. env(TOARD_INGEST_TOKEN/TOARD_INGEST_ENDPOINT)가 파일보다 우선.

use std::env;
use std::path::PathBuf;

pub const DEFAULT_ENDPOINT: &str = "http://localhost:3000/api";

#[derive(Debug, Default, PartialEq)]
pub struct Credentials {
    pub token: Option<String>,
    pub endpoint: Option<String>,
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
}
