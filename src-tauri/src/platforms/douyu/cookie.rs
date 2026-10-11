use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};

const LABEL: &str = "douyu-login";
static LOGIN_GENERATION: AtomicU64 = AtomicU64::new(0);

pub async fn playback_cookie(app: AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut values = BTreeMap::new();
        for label in [LABEL, "main"] {
            if let Some(window) = app.get_webview_window(label) {
                // Include parent-domain and HttpOnly cookies. Wry cookies_for_url currently
                // compares domains literally and omits valid .douyu.com cookies.
                // Passport-only cookies must not be forwarded to www.douyu.com.
                for cookie in window.cookies().map_err(|e| e.to_string())? {
                    if !super::cookie_policy::is_playback_domain(cookie.domain().unwrap_or_default()) { continue; }
                    if cookie.value().is_empty() { continue; }
                    values.entry(cookie.name().to_string()).or_insert_with(|| cookie.value().to_string());
                }
            }
        }
        if !values.get("acf_auth").is_some_and(|v| !v.is_empty()) { return Ok(None); }
        Ok(Some(values.into_iter().map(|(k,v)| format!("{k}={v}")).collect::<Vec<_>>().join("; ")))
    }).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus { logged_in: bool, window_open: bool }

#[tauri::command]
pub async fn get_douyu_login_status(app: AppHandle) -> Result<LoginStatus, String> {
    let logged_in = playback_cookie(app.clone()).await?.is_some();
    Ok(LoginStatus { logged_in, window_open: app.get_webview_window(LABEL).is_some() })
}

#[tauri::command]
pub async fn open_douyu_login(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(LABEL) {
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
    // Open authentication itself, rather than an unrelated, horizontally overflowing live page.
    tauri::WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External("https://www.douyu.com/member/login".parse().unwrap()))
        .title("登录斗鱼，完成后自动返回 QTV").inner_size(1000.0, 700.0).min_inner_size(900.0, 640.0)
        .initialization_script(r#"
            if (location.hostname === 'passport.douyu.com' && location.pathname === '/member/login') {
                document.addEventListener('DOMContentLoaded', () => {
                    const style = document.createElement('style');
                    style.textContent = `
                        html, body, .mainbody, #footer { min-width: 0 !important; }
                        .wrapper { width: 100% !important; min-width: 0 !important; }
                        .sign-con { min-height: 560px !important; padding-top: 20px !important; }
                        .sign-con .loginbox-con { float: none !important; width: 840px; margin: 0 auto; }
                        .sign-header .wrapper { width: calc(100% - 40px) !important; }
                    `;
                    document.head.appendChild(style);
                }, { once: true });
            }
        "#)
        .center().build().map_err(|e| e.to_string())?;
    }
    let generation = LOGIN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn(async move {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
        while LOGIN_GENERATION.load(Ordering::SeqCst) == generation && app.get_webview_window(LABEL).is_some() {
            match playback_cookie(app.clone()).await {
                Ok(Some(_)) => {
                    // Cookies live in the app's shared persistent WebKit store. Completion
                    // runs in the backend, so hiding/unmounting player controls cannot stop it.
                    if let Some(window) = app.get_webview_window(LABEL) { let _ = window.close(); }
                    if let Some(main) = app.get_webview_window("main") { let _ = main.set_focus(); }
                    let _ = app.emit_to("main", "douyu-login-completed", ());
                    return;
                }
                Err(_) => {
                    let _ = app.emit_to("main", "douyu-login-error", "读取斗鱼登录状态失败，请关闭登录窗口后重试");
                    return;
                }
                Ok(None) => {}
            }
            if std::time::Instant::now() >= deadline {
                let _ = app.emit_to("main", "douyu-login-error", "尚未完成斗鱼登录，请关闭登录窗口后重试");
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
        }
        if LOGIN_GENERATION.load(Ordering::SeqCst) == generation {
            let _ = app.emit_to("main", "douyu-login-cancelled", ());
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn close_douyu_login(app: AppHandle) -> Result<(), String> {
    LOGIN_GENERATION.fetch_add(1, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window(LABEL) { window.close().map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
pub async fn clear_douyu_login(app: AppHandle) -> Result<(), String> {
    close_douyu_login(app.clone()).await?;
    tauri::async_runtime::spawn_blocking(move || {
        for window in app.webview_windows().values() {
            for cookie in window.cookies().map_err(|e| e.to_string())? {
                if cookie.domain().is_some_and(|d| crate::network_policy::domain_matches(d.trim_start_matches('.'), "douyu.com")) {
                    window.delete_cookie(cookie).map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }).await.map_err(|e| e.to_string())?
}
