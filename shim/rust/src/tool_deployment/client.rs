use std::fs;
use std::process::Command;

use super::protocol::{DeploymentReport, DeviceManifestV1};
use super::DeployError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CurlResponse {
    Body(String),
    NotModified,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManifestFetch {
    pub response: CurlResponse,
    pub etag: Option<String>,
}

pub(crate) fn parse_etag_headers(headers: &str) -> Option<String> {
    headers
        .lines()
        .filter_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("etag")
                .then(|| value.trim().to_owned())
                .filter(|value| !value.is_empty())
        })
        .next_back()
}

pub(crate) fn parse_curl_response(output: &str) -> Result<CurlResponse, DeployError> {
    let (body, code) = output
        .rsplit_once('\n')
        .ok_or_else(|| DeployError::new("invalid_http_response"))?;
    match code.trim() {
        "200" => Ok(CurlResponse::Body(body.to_owned())),
        "304" => Ok(CurlResponse::NotModified),
        "401" => Err(DeployError::new("unauthorized")),
        "403" => Err(DeployError::new("device_not_owned")),
        "426" => Err(DeployError::new("protocol_unsupported")),
        _ => Err(DeployError::new("server_unavailable")),
    }
}

pub(crate) fn next_backoff_seconds(failure_count: usize) -> u64 {
    match failure_count {
        0 => 60,
        1 => 120,
        2 => 240,
        3 => 480,
        _ => 900,
    }
}

fn endpoint_url(endpoint: &str, suffix: &str) -> String {
    format!("{}{}", endpoint.trim_end_matches('/'), suffix)
}

pub(crate) fn fetch_manifest(
    endpoint: &str,
    token: &str,
    fingerprint: &str,
    etag: Option<&str>,
) -> Result<ManifestFetch, DeployError> {
    let url = format!(
        "{}?fingerprint={fingerprint}",
        endpoint_url(endpoint, "/v1/tool-deployment/manifest")
    );
    let mut command = Command::new("curl");
    let header_path = crate::fsx::state_dir()
        .map(|path| {
            path.join("tmp")
                .join(format!("tool-manifest-headers-{}.txt", std::process::id()))
        })
        .ok_or_else(|| DeployError::new("home_unavailable"))?;
    if let Some(parent) = header_path.parent() {
        fs::create_dir_all(parent).map_err(|_| DeployError::new("state_write_failed"))?;
    }
    command.args([
        "-sS",
        "--max-time",
        "20",
        "-H",
        &format!("Authorization: Bearer {token}"),
        "-H",
        "X-Toard-Tool-Protocol: 1",
        "-D",
        &header_path.to_string_lossy(),
    ]);
    if let Some(value) = etag {
        command.args(["-H", &format!("If-None-Match: {value}")]);
    }
    let output = command
        .args(["-w", "\n%{http_code}", &url])
        .output()
        .map_err(|_| DeployError::new("curl_unavailable"))?;
    let headers = fs::read_to_string(&header_path).unwrap_or_default();
    let _ = fs::remove_file(&header_path);
    if !output.status.success() && output.stdout.is_empty() {
        return Err(DeployError::new("server_unavailable"));
    }
    Ok(ManifestFetch {
        response: parse_curl_response(&String::from_utf8_lossy(&output.stdout))?,
        etag: parse_etag_headers(&headers),
    })
}

pub(crate) fn parse_manifest(body: &str) -> Result<DeviceManifestV1, DeployError> {
    let manifest: DeviceManifestV1 =
        serde_json::from_str(body).map_err(|_| DeployError::new("invalid_manifest"))?;
    if manifest.schema_version != 1 || manifest.reconcile_after_seconds < 60 {
        return Err(DeployError::new("protocol_unsupported"));
    }
    Ok(manifest)
}

pub(crate) fn download_archive(url: &str) -> Result<Vec<u8>, DeployError> {
    let output = Command::new("curl")
        .args([
            "-sS",
            "-L",
            "--max-time",
            "60",
            "--max-filesize",
            "52428800",
            url,
        ])
        .output()
        .map_err(|_| DeployError::new("curl_unavailable"))?;
    if !output.status.success() {
        return Err(DeployError::new("source_download_failed"));
    }
    Ok(output.stdout)
}

pub(crate) fn post_report(
    endpoint: &str,
    token: &str,
    report: &DeploymentReport,
) -> Result<(), DeployError> {
    let directory = crate::fsx::state_dir()
        .map(|path| path.join("tmp"))
        .ok_or_else(|| DeployError::new("home_unavailable"))?;
    let path = directory.join(format!("tool-report-{}.json", std::process::id()));
    let body =
        serde_json::to_string(report).map_err(|_| DeployError::new("report_encode_failed"))?;
    crate::fsx::write_atomic(&path, &body, 0o600)
        .map_err(|_| DeployError::new("report_write_failed"))?;
    let output = Command::new("curl")
        .args([
            "-sS",
            "--max-time",
            "20",
            "-X",
            "POST",
            "-H",
            "Content-Type: application/json",
            "-H",
            &format!("Authorization: Bearer {token}"),
            "--data-binary",
            &format!("@{}", path.display()),
            "-o",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
            "-w",
            "%{http_code}",
            &endpoint_url(endpoint, "/v1/tool-deployment/reports"),
        ])
        .output();
    let _ = std::fs::remove_file(path);
    let output = output.map_err(|_| DeployError::new("curl_unavailable"))?;
    match String::from_utf8_lossy(&output.stdout).trim() {
        "202" => Ok(()),
        "401" => Err(DeployError::new("unauthorized")),
        "409" => Err(DeployError::new("report_rejected")),
        _ => Err(DeployError::new("report_failed")),
    }
}
