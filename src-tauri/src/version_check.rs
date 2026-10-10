use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteVersionInfo {
    pub version: String,
    pub title: Option<String>,
    pub notes: Option<Vec<String>>,
    pub url: Option<String>,
    pub published_at: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
pub struct VersionCheckResponse {
    pub local_version: String,
    pub remote: Option<RemoteVersionInfo>,
    pub has_update: bool,
}

// Informational only: QTV never installs updates from the former DTV endpoint.
#[tauri::command]
pub async fn check_version_cmd(app_handle: tauri::AppHandle, client: State<'_, reqwest::Client>) -> Result<VersionCheckResponse, String> {
    let local_version = app_handle.package_info().version.to_string();
    let remote = async {
        let response = client.get("https://api.github.com/repos/qinxianhahaha/QTV/releases/latest")
            .header("Accept", "application/vnd.github+json").header("User-Agent", "QTV")
            .timeout(std::time::Duration::from_secs(8)).send().await.ok()?.error_for_status().ok()?;
        let data: serde_json::Value = response.json().await.ok()?;
        Some(RemoteVersionInfo {
            version: data["tag_name"].as_str()?.trim_start_matches('v').to_owned(),
            title: data["name"].as_str().map(str::to_owned), notes: None,
            url: Some("https://github.com/qinxianhahaha/QTV/releases/latest".into()),
            published_at: data["published_at"].as_str().map(str::to_owned),
        })
    }.await;
    let parse = |v: &str| -> Option<Vec<u64>> {
        let parts: Vec<u64> = v.split('.').map(str::parse).collect::<Result<_, _>>().ok()?;
        (parts.len() == 3).then_some(parts)
    };
    let has_update = remote.as_ref().and_then(|r| Some(parse(&r.version)? > parse(&local_version)?)).unwrap_or(false);
    Ok(VersionCheckResponse { local_version, remote, has_update })
}
