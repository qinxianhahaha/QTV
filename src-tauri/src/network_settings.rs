use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSettings { pub direct_playback: bool }
impl Default for NetworkSettings {
    fn default() -> Self { Self { direct_playback: true } }
}
#[derive(Default)]
pub struct NetworkSettingsState(pub Mutex<NetworkSettings>);

pub fn load(app: &tauri::AppHandle) -> Result<NetworkSettings, String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("network.json");
    match std::fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|_| "网络设置文件损坏，无法安全应用设置".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(NetworkSettings::default()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn get_network_settings(state: tauri::State<'_, NetworkSettingsState>) -> Result<NetworkSettings, String> {
    state.0.lock().map(|guard| *guard).map_err(|_| "网络设置不可用".into())
}

#[tauri::command]
pub fn set_network_settings(app: tauri::AppHandle, state: tauri::State<'_, NetworkSettingsState>, direct_playback: bool) -> Result<NetworkSettings, String> {
    let mut guard = state.0.lock().map_err(|_| "网络设置不可用")?;
    let next = NetworkSettings { direct_playback };
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let temporary = dir.join("network.json.tmp");
    std::fs::write(&temporary, serde_json::to_vec(&next).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(temporary, dir.join("network.json")).map_err(|e| e.to_string())?;
    *guard = next;
    Ok(next)
}
