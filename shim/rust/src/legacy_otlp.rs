//! Compatibility boundary: project selection applies to pull collection, so
//! persistent direct exporters for the same destination must be disabled first.
use std::path::Path;

fn read_optional(path: &Path) -> Result<Option<String>, &'static str> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("legacy_settings_unreadable"),
    }
}

fn destination(value: &str) -> Option<String> {
    crate::targets::normalize_endpoint(value.strip_suffix("/v1/logs").unwrap_or(value)).ok()
}

pub fn ensure_disabled(root: &Path, endpoint: &str) -> Result<(), &'static str> {
    let endpoint = crate::targets::normalize_endpoint(endpoint).map_err(|_| "invalid_endpoint")?;
    let home = root.parent().ok_or("legacy_settings_unreadable")?;
    if let Some(text) = read_optional(&home.join(".codex/config.toml"))? {
        // Inspect only the exporter destination; never return headers or tokens.
        let doc = text
            .parse::<toml_edit::DocumentMut>()
            .map_err(|_| "legacy_settings_unreadable")?;
        if doc
            .get("otel")
            .and_then(|otel| otel.get("exporter"))
            .and_then(|exporter| exporter.get("otlp-http"))
            .and_then(|http| http.get("endpoint"))
            .and_then(toml_edit::Item::as_str)
            .and_then(destination)
            .as_deref()
            == Some(endpoint.as_str())
        {
            return Err("experimental_otlp_active");
        }
    }
    if let Some(text) = read_optional(&home.join(".claude/settings.json"))? {
        if text.trim().is_empty() {
            return Ok(());
        }
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|_| "legacy_settings_unreadable")?;
        if let Some(env) = value.get("env") {
            let enabled = env
                .get("CLAUDE_CODE_ENABLE_TELEMETRY")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| matches!(value, "1" | "true" | "on"));
            for key in [
                "OTEL_EXPORTER_OTLP_ENDPOINT",
                "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
            ] {
                if enabled
                    && env
                        .get(key)
                        .and_then(serde_json::Value::as_str)
                        .and_then(destination)
                        .as_deref()
                        == Some(endpoint.as_str())
                {
                    return Err("experimental_otlp_active");
                }
            }
        }
    }
    Ok(())
}

/// Explicit CLI action. Remove only toard-owned persisted settings; user edits
/// survive and remain visible as a conflict if they still export to this server.
pub fn disable_owned(root: &Path) -> Result<(), &'static str> {
    let home = root.parent().ok_or("legacy_settings_unreadable")?;
    let codex = home.join(".codex/config.toml");
    if let Some(text) = read_optional(&codex)? {
        let cleaned = crate::codex::strip_toard_block(&text);
        if cleaned == text && text.contains("# >>> toard otel >>>") {
            return Err("legacy_settings_unreadable");
        }
        if cleaned != text {
            crate::fsx::write_atomic(&codex, &cleaned, 0o600)
                .map_err(|_| "legacy_settings_write_failed")?;
        }
    }
    let state = root.join("state/claude-env.json");
    if let Some(text) = read_optional(&state)? {
        let settings = home.join(".claude/settings.json");
        let current = read_optional(&settings)?.unwrap_or_default();
        let plan =
            crate::claude_env::plan_off(&current, &crate::claude_env::state_from_json(&text))
                .map_err(|_| "legacy_settings_unreadable")?;
        if let Some(text) = plan.settings {
            crate::fsx::write_atomic(&settings, &text, 0o600)
                .map_err(|_| "legacy_settings_write_failed")?;
        }
        std::fs::remove_file(state).map_err(|_| "legacy_settings_write_failed")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::collect::gemini_family::testutil::TempDir;

    #[test]
    fn owned_exporters_block_scope_until_disabled_without_deleting_user_configuration() {
        let temp = TempDir::new("scope-legacy-exporters");
        let root = temp.path().join(".toard");
        let endpoint = "https://fixture.example/api";
        let crate::codex::Plan::Write(config) =
            crate::codex::plan("model = \"user-model\"\n", endpoint, "fixture-secret")
        else {
            panic!("fixture config");
        };
        temp.write(".codex/config.toml", &config);
        assert_eq!(
            ensure_disabled(&root, endpoint),
            Err("experimental_otlp_active")
        );
        assert!(ensure_disabled(&root, "https://different.example/api").is_ok());
        disable_owned(&root).unwrap();
        assert!(
            std::fs::read_to_string(temp.path().join(".codex/config.toml"))
                .unwrap()
                .contains("user-model")
        );
        assert!(ensure_disabled(&root, endpoint).is_ok());
        let plan =
            crate::claude_env::plan_on("{\"theme\":\"dark\"}", &[], endpoint, "fixture-secret")
                .unwrap();
        temp.write(".claude/settings.json", plan.settings.as_deref().unwrap());
        temp.write(
            ".toard/state/claude-env.json",
            &crate::claude_env::state_to_json(&plan.state),
        );
        assert_eq!(
            ensure_disabled(&root, endpoint),
            Err("experimental_otlp_active")
        );
        disable_owned(&root).unwrap();
        assert!(
            std::fs::read_to_string(temp.path().join(".claude/settings.json"))
                .unwrap()
                .contains("dark")
        );
        assert!(ensure_disabled(&root, endpoint).is_ok());
    }
}
