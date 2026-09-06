use crate::local_bridge::{random_hex, Request, Response};
use crate::targets::{Target, TargetStore};
use serde_json::json;

#[derive(Clone)]
struct Session {
    token: String,
    target_id: String,
    revision: String,
    expires: u64,
}
#[derive(Default)]
pub(crate) struct Sessions(Vec<Session>);

fn local_origin() -> String {
    format!("http://127.0.0.1:{}", crate::local_bridge::port())
}
fn local_host(request: &Request) -> bool {
    request
        .headers
        .get("host")
        .is_some_and(|host| *host == format!("127.0.0.1:{}", crate::local_bridge::port()))
}

pub(crate) fn page(
    request: &Request,
    target: &Target,
    opener_origin: &str,
    nonce: &str,
    sessions: &mut Sessions,
) -> Response {
    if !local_host(request) {
        return Response::json(403, json!({ "error": "local_host_required" }));
    }
    let now = crate::bg::now_unix();
    sessions.0.retain(|session| session.expires >= now);
    if sessions.0.len() >= 8 {
        sessions.0.remove(0);
    }
    let capability = random_hex::<32>();
    sessions.0.push(Session {
        token: capability.clone(),
        target_id: target.id.clone(),
        revision: target.revision.clone(),
        expires: now + 10 * 60,
    });
    let data = json!({ "capability": capability, "openerOrigin": opener_origin, "nonce": nonce, "endpoint": target.endpoint });
    let script_nonce = random_hex::<16>();
    let html = include_str!("scope_ui.html")
        .replace("__SCOPE_SCRIPT__", include_str!("scope_ui.js"))
        .replace("__SCRIPT_NONCE__", &script_nonce)
        .replace(
            "__BOOTSTRAP__",
            &data
                .to_string()
                .replace('<', "\\u003c")
                .replace('\u{2028}', "\\u2028")
                .replace('\u{2029}', "\\u2029"),
        );
    Response::html(html, &script_nonce)
}

pub(crate) fn route(request: &Request, store: &TargetStore, sessions: &mut Sessions) -> Response {
    if !local_host(request)
        || request
            .headers
            .get("origin")
            .is_some_and(|origin| *origin != local_origin())
    {
        return Response::json(403, json!({ "error": "local_origin_required" }));
    }
    let action = match (request.method.as_str(), request.path.as_str()) {
        ("GET", "/v1/scope/preview") => "preview",
        ("POST", "/v1/scope/apply")
            if request
                .headers
                .get("origin")
                .is_some_and(|origin| *origin == local_origin()) =>
        {
            "apply"
        }
        _ => return Response::json(405, json!({ "error": "method_not_allowed" })),
    };
    let now = crate::bg::now_unix();
    sessions.0.retain(|session| session.expires >= now);
    let bearer = request
        .headers
        .get("authorization")
        .and_then(|header| header.strip_prefix("Bearer "));
    let Some(session) = sessions
        .0
        .iter()
        .find(|session| Some(session.token.as_str()) == bearer)
        .cloned()
    else {
        return Response::json(401, json!({ "error": "scope_session_expired" }));
    };
    let targets = match store.load_readonly() {
        Ok(targets) => targets,
        Err(_) => return Response::json(503, json!({ "error": "targets_unavailable" })),
    };
    let Some(target) = targets
        .iter()
        .find(|target| target.id == session.target_id && target.revision == session.revision)
    else {
        return Response::json(409, json!({ "error": "target_changed" }));
    };
    if action == "preview" {
        return Response::json(
            200,
            crate::scope_control::preview(
                target,
                &store.root().join("state"),
                crate::collect::adapters(),
            ),
        );
    }
    if request
        .headers
        .get("content-type")
        .and_then(|header| header.split(';').next())
        != Some("application/json")
    {
        return Response::json(400, json!({ "error": "json_required" }));
    }
    let policy = match std::str::from_utf8(&request.body)
        .ok()
        .and_then(|body| crate::collection_scope::CollectionScope::decode(body).ok())
    {
        Some(policy) => policy,
        None => return Response::json(400, json!({ "error": "invalid_scope" })),
    };
    match store.set_collection_scope(&target.endpoint, &session.revision, policy) {
        Ok(updated) => {
            sessions.0.retain(|entry| entry.token != session.token);
            let status: serde_json::Value = serde_json::from_str(
                &crate::local_bridge::status_response(&updated, random_hex::<32>()).body,
            )
            .expect("status JSON");
            Response::json(200, json!({ "ok": true, "status": status }))
        }
        Err(crate::targets::TargetError::InvalidCredentials(
            code @ ("experimental_otlp_active" | "legacy_settings_unreadable"),
        )) => Response::json(409, json!({ "error": code })),
        Err(_) => Response::json(409, json!({ "error": "scope_not_saved" })),
    }
}
