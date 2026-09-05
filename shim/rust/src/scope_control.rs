//! Local-only scope preview and configuration. Never called through remote CORS actions.
use std::collections::BTreeMap;
use std::io::Read;
use std::path::Path;

use crate::collection_scope::{CollectionScope, LocalProject, ProviderScope};
use crate::targets::{Target, TargetStore};
use serde_json::{json, Value};

pub fn preview(
    target: &Target,
    global_state: &Path,
    adapters: Vec<Box<dyn crate::collect::LogAdapter>>,
) -> Value {
    let mut effective = vec![target.clone()];
    crate::device_control::apply_overrides(&mut effective);
    let target = &effective[0];
    let mut pending = crate::usage_queue::project_counts(&target.state_dir);
    if target.state_dir != global_state
        && crate::usage_queue::stored_destination(global_state)
            .ok()
            .flatten()
            .as_deref()
            == Some(&target.id)
    {
        if let (Ok(rows), Ok(legacy)) = (
            &mut pending,
            crate::usage_queue::project_counts(global_state),
        ) {
            rows.extend(legacy);
        }
    }
    let mut providers = Vec::new();
    for adapter in adapters {
        let key = adapter.key();
        let rule = target.credentials.collection_scope.provider(key);
        let mut projects = BTreeMap::<String, Value>::new();
        let mut unknown = 0u64;
        let mut errors = 0u64;
        let mut read_failures = 0u64;
        let mut unsupported_files = 0u64;
        let discovery = adapter.discovery();
        read_failures += discovery.read_failures.unwrap_or(0);
        let files = discovery.files;
        for file in &files {
            // This preview never extracts prompt text or tool arguments.
            let parsed = adapter.parse_changed(file, false, false);
            for project in parsed.projects.values() {
                projects
                    .entry(project.id.clone())
                    .or_insert_with(|| project_row(project));
            }
            for usage in parsed.usage {
                if let Some(project) = usage.project {
                    let row = projects
                        .entry(project.id.clone())
                        .or_insert_with(|| project_row(&project));
                    row["usageRecords"] = json!(row["usageRecords"].as_u64().unwrap_or(0) + 1);
                    if row["sample"].is_null() {
                        row["sample"] = json!({ "model": usage.model, "ts": crate::iso::epoch_ms_to_iso(usage.ts_ms),
                            "inputTokens": usage.input_tokens, "outputTokens": usage.output_tokens,
                            "cacheReadTokens": usage.cache_read_tokens, "cacheCreationTokens": usage.cache_creation_tokens });
                    }
                } else {
                    unknown += 1;
                }
            }
            if let Some(diagnostic) = parsed.diagnostics {
                errors += diagnostic.parse_errors;
                read_failures += u64::from(diagnostic.read_failed);
                unsupported_files += u64::from(diagnostic.unsupported_schema);
            }
        }
        let mut unknown_pending = 0u64;
        for row in pending
            .as_ref()
            .into_iter()
            .flatten()
            .filter(|row| row.provider_key == key)
        {
            if let Some(id) = row
                .project_id
                .as_deref()
                .filter(|id| LocalProject::valid_id(id))
            {
                let project = projects
                    .entry(id.into())
                    .or_insert_with(|| cached_project_row(global_state, key, id));
                project["pendingRecords"] =
                    json!(project["pendingRecords"].as_u64().unwrap_or(0) + row.records);
            } else {
                unknown_pending += row.records;
            }
        }
        if let ProviderScope::Include { projects: selected }
        | ProviderScope::Exclude { projects: selected } = rule
        {
            for id in selected {
                projects
                    .entry(id.clone())
                    .or_insert_with(|| cached_project_row(global_state, key, id));
            }
        }
        providers.push(json!({ "key": key, "rule": rule, "projects": projects.into_values().collect::<Vec<_>>(),
            "filesChecked": files.len(), "unidentifiedRecords": unknown, "unidentifiedPending": unknown_pending,
            "parseErrors": errors, "readFailures": read_failures, "unsupportedFiles": unsupported_files }));
    }
    json!({ "schemaVersion": 1, "endpoint": target.endpoint, "revision": target.revision,
        "policy": target.credentials.collection_scope, "providers": providers, "queueReadable": pending.is_ok(),
        "sends": { "usage": true, "content": target.credentials.collect_content.is_enabled(), "tools": target.credentials.collect_tools,
            "inventoryRequiresUnrestrictedScope": true },
        "usageFields": ["providerKey", "model", "ts", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens", "sessionId", "host"] })
}

fn project_row(project: &LocalProject) -> Value {
    json!({ "id": project.id, "label": project.label, "kind": project.kind, "usageRecords": 0, "pendingRecords": 0, "sample": null })
}

fn cached_project_row(state: &Path, provider: &str, id: &str) -> Value {
    let project = LocalProject::recalled(state, provider, id).unwrap_or_else(|| LocalProject {
        id: id.into(),
        label: format!("{} · {}", provider, &id[..12]),
        kind: "opaque",
    });
    project_row(&project)
}

pub fn run(args: &[String]) -> i32 {
    let Some(action) = args.first().map(String::as_str) else {
        return usage();
    };
    let path = match (action, &args[1..]) {
        ("preview", [target]) if target == "--target-env" => None,
        ("set", [target, flag, path]) if target == "--target-env" && flag == "--file" => Some(path),
        _ => return usage(),
    };
    let result = (|| -> Result<(), String> {
        let endpoint = std::env::var("TOARD_INGEST_ENDPOINT")
            .map_err(|_| "TOARD_INGEST_ENDPOINT가 필요합니다")?;
        let endpoint =
            crate::targets::normalize_endpoint(&endpoint).map_err(|_| "잘못된 endpoint입니다")?;
        let store = TargetStore::from_home().map_err(|_| "로컬 설정을 읽을 수 없습니다")?;
        let targets = if path.is_some() {
            store.load_or_migrate()
        } else {
            store.load_readonly()
        }
        .map_err(|_| "로컬 설정을 읽을 수 없습니다")?;
        let target = targets
            .into_iter()
            .find(|target| target.endpoint == endpoint)
            .ok_or("등록된 서버가 아닙니다")?;
        if let Some(path) = path {
            let mut bytes = Vec::new();
            std::fs::File::open(path)
                .map_err(|_| "정책 파일을 열 수 없습니다")?
                .take(24 * 1024 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "정책 파일을 읽을 수 없습니다")?;
            let policy = CollectionScope::decode(
                std::str::from_utf8(&bytes).map_err(|_| "정책은 UTF-8 JSON이어야 합니다")?,
            )?;
            let updated = store
                .set_collection_scope(&target.endpoint, &target.revision, policy)
                .map_err(|error| error.to_string())?;
            println!(
                "{}",
                json!({ "ok": true, "endpoint": updated.endpoint, "revision": updated.revision, "policy": updated.credentials.collection_scope })
            );
        } else {
            println!(
                "{}",
                preview(
                    &target,
                    &store.root().join("state"),
                    crate::collect::adapters()
                )
            );
        }
        Ok(())
    })();
    match result {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("toard-shim: {error}");
            1
        }
    }
}

fn usage() -> i32 {
    eprintln!(
        "toard-shim scope preview --target-env | scope set --target-env --file <policy.json>"
    );
    2
}
