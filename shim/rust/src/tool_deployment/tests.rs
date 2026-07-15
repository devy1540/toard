use std::collections::{BTreeMap, BTreeSet};

use serde_json::json;

use super::adapters::merge_managed_json_entry;
use super::plan::{plan, plan_after_fetch_error, PlanAction};
use super::protocol::DeviceManifestV1;
use super::source::{canonical_tree_digest, validate_archive_entry, EntryKind, SourceFile, MAX_FILE_BYTES};
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
