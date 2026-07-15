use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::json;
use tar::{Builder, Header};

use super::adapters::merge_managed_json_entry;
use super::client::{next_backoff_seconds, parse_curl_response, parse_etag_headers, CurlResponse};
use super::launcher::{build_mcp_launch, McpLaunchDefinition};
use super::plan::{plan, plan_after_fetch_error, PlanAction};
use super::protocol::{DeploymentReport, DeploymentStatus, DeviceManifestV1};
use super::reconcile::{apply_file_transaction, TransactionOutcome};
use super::source::{canonical_tree_digest, read_tar_gz_files, validate_archive_entry, EntryKind, SourceFile, MAX_FILE_BYTES};
use super::state::{ManagedItem, ManagedState};

fn state_with(slug: &str, version_id: &str) -> ManagedState {
    ManagedState {
        schema_version: 1,
        items: BTreeMap::from([(
            slug.to_owned(),
            ManagedItem {
                catalog_item_id: "catalog-1".into(),
                version_id: version_id.into(),
                last_known_good_version_id: version_id.into(),
                managed_keys: BTreeSet::from([slug.to_owned()]),
                managed_paths: BTreeSet::new(),
            },
        )]),
    }
}

fn manifest_json(version_id: &str) -> String {
    json!({
        "schemaVersion": 1,
        "generatedAt": "2026-07-15T00:00:00.000Z",
        "reconcileAfterSeconds": 60,
        "items": [{
            "catalogItemId": "catalog-1",
            "versionId": version_id,
            "origin": "personal",
            "rolloutId": null,
            "manifest": {
                "schemaVersion": 1,
                "catalogItemId": "catalog-1",
                "versionId": version_id,
                "slug": "review",
                "kind": "skill",
                "source": {
                    "provider": "github",
                    "repository": "acme/review",
                    "exactRef": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    "path": "",
                    "treeDigest": format!("sha256:{}", "b".repeat(64)),
                    "downloadUrl": "https://github.com/acme/review/archive/a.tar.gz"
                },
                "clients": ["codex"],
                "minProtocolVersion": 1,
                "permissions": { "env": [], "networkHosts": [], "executables": [] },
                "payload": { "type": "skill", "files": ["SKILL.md"], "targetKey": "review" }
            }
        }]
    }).to_string()
}

#[test]
fn protocol_deserializes_server_camel_case_contract() {
    let manifest: DeviceManifestV1 = serde_json::from_str(&manifest_json("version-1")).unwrap();
    assert_eq!(manifest.schema_version, 1);
    assert_eq!(manifest.reconcile_after_seconds, 60);
    assert_eq!(manifest.items[0].manifest.slug, "review");
    assert_eq!(manifest.items[0].manifest.payload.payload_type(), "skill");
}

#[test]
fn planner_produces_install_update_remove_and_noop() {
    let desired: DeviceManifestV1 = serde_json::from_str(&manifest_json("version-2")).unwrap();
    assert_eq!(
        plan(&ManagedState::default(), &desired.items),
        vec![PlanAction::Install { slug: "review".into(), version_id: "version-2".into() }]
    );
    assert_eq!(
        plan(&state_with("review", "version-1"), &desired.items),
        vec![PlanAction::Update { slug: "review".into(), from: "version-1".into(), to: "version-2".into() }]
    );
    let current = state_with("other", "version-1");
    assert!(plan(&current, &desired.items).contains(&PlanAction::Remove { slug: "other".into(), version_id: "version-1".into() }));
    let desired_same: DeviceManifestV1 = serde_json::from_str(&manifest_json("version-1")).unwrap();
    assert_eq!(plan(&state_with("review", "version-1"), &desired_same.items), vec![PlanAction::Noop { slug: "review".into() }]);
}

#[test]
fn fetch_error_keeps_last_known_good_without_remove() {
    assert_eq!(
        plan_after_fetch_error(&state_with("review", "version-1")),
        vec![PlanAction::Noop { slug: "review".into() }]
    );
}

#[test]
fn archive_entry_rejects_traversal_links_and_oversized_files() {
    assert!(validate_archive_entry("../secret", EntryKind::File, 1).is_err());
    assert!(validate_archive_entry("skill/link", EntryKind::Symlink, 1).is_err());
    assert!(validate_archive_entry("skill/big", EntryKind::File, MAX_FILE_BYTES + 1).is_err());
    assert_eq!(validate_archive_entry("skill/SKILL.md", EntryKind::File, 10).unwrap().to_string_lossy(), "skill/SKILL.md");
}

#[test]
fn canonical_digest_is_stable_across_input_order() {
    let left = SourceFile { path: "SKILL.md".into(), bytes: b"a".to_vec() };
    let right = SourceFile { path: "refs/x.md".into(), bytes: b"b".to_vec() };
    assert_eq!(canonical_tree_digest(&[left.clone(), right.clone()]).unwrap(), canonical_tree_digest(&[right, left]).unwrap());
}

#[test]
fn unmanaged_same_key_is_conflict_and_other_user_keys_survive() {
    let config = json!({ "mcpServers": { "github": { "command": "user-owned" } }, "theme": "dark" });
    let state = ManagedState::default();
    let error = merge_managed_json_entry(&config, &state, "github", json!({ "command": "toard-shim" })).unwrap_err();
    assert_eq!(error.code(), "unmanaged_conflict");

    let managed = state_with("github", "version-1");
    let merged = merge_managed_json_entry(&config, &managed, "github", json!({ "command": "toard-shim" })).unwrap();
    assert_eq!(merged["theme"], "dark");
    assert_eq!(merged["mcpServers"]["github"]["command"], "toard-shim");
}

fn tar_gz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let encoder = GzEncoder::new(Vec::new(), Compression::default());
    let mut builder = Builder::new(encoder);
    for (path, body) in entries {
        let mut header = Header::new_gnu();
        header.set_size(body.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder.append_data(&mut header, path, *body).unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

#[test]
fn tar_reader_strips_github_root_and_selects_manifest_files() {
    let archive = tar_gz(&[
        ("repo-commit/server/SKILL.md", b"skill"),
        ("repo-commit/server/references/api.md", b"api"),
        ("repo-commit/README.md", b"ignore"),
    ]);
    let files = read_tar_gz_files(
        &archive,
        "server",
        &["SKILL.md".into(), "references/api.md".into()],
    )
    .unwrap();
    assert_eq!(files.iter().map(|file| file.path.as_str()).collect::<Vec<_>>(), vec!["SKILL.md", "references/api.md"]);
}

#[test]
fn failed_health_check_restores_previous_file() {
    let root = std::env::temp_dir().join(format!(
        "toard-tool-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let target = root.join("SKILL.md");
    std::fs::write(&target, "v1").unwrap();
    let outcome = apply_file_transaction(&target, b"v2", || false).unwrap();
    assert_eq!(outcome, TransactionOutcome::RolledBack);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "v1");
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn report_serialization_has_closed_fields_and_no_secret() {
    let report = DeploymentReport {
        device_fingerprint: "a".repeat(64),
        catalog_item_id: "catalog-1".into(),
        desired_version_id: Some("version-1".into()),
        applied_version_id: None,
        status: DeploymentStatus::SettingsRequired,
        error_code: Some("local_secret_missing".into()),
        attempt: 1,
        rollout_id: None,
    };
    let serialized = serde_json::to_string(&report).unwrap();
    assert!(serialized.contains("settings_required"));
    assert!(!serialized.contains("never-send-me"));
    assert!(!serialized.contains("errorMessage"));
}

#[test]
fn mcp_launcher_injects_only_declared_local_secrets() {
    let definition = McpLaunchDefinition {
        deployment_id: "deployment-1".into(),
        command: "node".into(),
        args: vec!["server.js".into()],
        required_env_names: vec!["TOKEN".into()],
    };
    let secrets = BTreeMap::from([("TOKEN".into(), "local-value".into()), ("OTHER".into(), "ignored".into())]);
    let launch = build_mcp_launch(&definition, &secrets).unwrap();
    assert_eq!(launch.command, "node");
    assert_eq!(launch.env.get("TOKEN").map(String::as_str), Some("local-value"));
    assert!(!launch.env.contains_key("OTHER"));
    assert_eq!(launch.managed_client_entry["command"], "toard-shim");
    assert!(!launch.managed_client_entry.to_string().contains("local-value"));
}

#[test]
fn client_parses_200_and_304_and_caps_backoff() {
    assert!(matches!(parse_curl_response("{\"schemaVersion\":1}\n200").unwrap(), CurlResponse::Body(_)));
    assert_eq!(parse_curl_response("\n304").unwrap(), CurlResponse::NotModified);
    assert_eq!([0, 1, 2, 3, 4, 5].map(next_backoff_seconds), [60, 120, 240, 480, 900, 900]);
    assert_eq!(
        parse_etag_headers("HTTP/1.1 302 Found\r\nETag: \"old\"\r\n\r\nHTTP/2 200\r\netag: \"new\"\r\n\r\n"),
        Some("\"new\"".into())
    );
}
