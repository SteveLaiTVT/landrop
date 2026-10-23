//! 升级通道。
//!
//! 页面是本地 HTTP 服务渲染的，不经过 Tauri IPC，所以更新状态不能只活在 WebView 里。
//! 这里的做法是：Rust 负责检查/下载/安装，把结论落成 `data/update-state.json`，
//! 由后端在 `/api/state` 里读给控制台展示。入口在托盘菜单，避免在页面里开 IPC 通道。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

/// 首次检查的延迟：别和窗口首屏、后端启动抢资源。
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
/// 之后每 6 小时查一次。
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    /// 当前安装的版本
    pub current: String,
    /// idle | checking | uptodate | available | downloading | installing | error
    pub status: String,
    /// 可更新的版本号（status=available 时有效）
    pub available: Option<String>,
    /// 新版本说明
    pub notes: Option<String>,
    /// 上次检查完成的时间（Unix 秒）
    pub checked_at: Option<u64>,
    /// 出错时的说明
    pub message: Option<String>,
}

/// 内存里的当前状态，供托盘菜单判断点击该做什么。
pub struct UpdateCell(pub Mutex<UpdateState>);

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn data_dir(app: &AppHandle) -> PathBuf {
    if let Some(srv) = app.try_state::<crate::server::Server>() {
        return srv.data_dir.clone();
    }
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// 状态一变就落盘：后端只读这个文件，不需要两边握手。
fn persist(app: &AppHandle, state: &UpdateState) {
    let dir = data_dir(app);
    let _ = fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_string_pretty(state) {
        let _ = fs::write(dir.join("update-state.json"), text);
    }
    if let Some(cell) = app.try_state::<UpdateCell>() {
        if let Ok(mut guard) = cell.0.lock() {
            *guard = state.clone();
        }
    }
}

fn snapshot(app: &AppHandle) -> UpdateState {
    let mut state = app
        .try_state::<UpdateCell>()
        .and_then(|cell| cell.0.lock().ok().map(|g| g.clone()))
        .unwrap_or_default();
    if state.current.is_empty() {
        state.current = app.package_info().version.to_string();
    }
    state
}

pub fn init(app: &AppHandle) {
    let state = UpdateState {
        current: app.package_info().version.to_string(),
        status: "idle".into(),
        ..Default::default()
    };
    app.manage(UpdateCell(Mutex::new(state.clone())));
    persist(app, &state);
}

/// 检查是否有新版本。`interactive` 为 true 时，用户是在托盘里手点的，要把结果显式反馈出去。
pub async fn check(app: AppHandle, interactive: bool) {
    let mut state = snapshot(&app);
    state.status = "checking".into();
    state.message = None;
    persist(&app, &state);

    let updater = match app.updater() {
        Ok(u) => u,
        Err(err) => return fail(&app, &mut state, format!("更新组件不可用：{err}")),
    };

    match updater.check().await {
        Ok(Some(update)) => {
            state.status = "available".into();
            state.available = Some(update.version.clone());
            state.notes = update.body.clone();
            state.checked_at = Some(now_secs());
            persist(&app, &state);
            crate::tray::set_update_label(&app, Some(&update.version));

            if interactive {
                let _ = crate::tray::notify(
                    &app,
                    &format!("发现新版本 v{}，可在托盘菜单里安装", update.version),
                );
            }
        }
        Ok(None) => {
            state.status = "uptodate".into();
            state.available = None;
            state.checked_at = Some(now_secs());
            persist(&app, &state);
            crate::tray::set_update_label(&app, None);

            if interactive {
                let _ = crate::tray::notify(
                    &app,
                    &format!("已是最新版本 v{}", state.current),
                );
            }
        }
        Err(err) => fail(&app, &mut state, format!("检查更新失败：{err}")),
    }
}

fn fail(app: &AppHandle, state: &mut UpdateState, message: String) {
    eprintln!("[landrop] {message}");
    state.status = "error".into();
    state.checked_at = Some(now_secs());
    state.message = Some(message.clone());
    persist(app, state);
    let _ = crate::tray::set_update_label(app, None);
    let _ = crate::tray::notify(app, &message);
}

/// 下载并安装，成功后直接重启进新版本。
pub async fn install(app: AppHandle) {
    let mut state = snapshot(&app);
    if state.status != "available" {
        // 菜单被点到但内存里没有待装版本：先查一次再说
        return check(app, true).await;
    }

    state.status = "downloading".into();
    persist(&app, &state);
    let _ = crate::tray::notify(&app, "正在下载新版本，完成后会自动重启");

    let updater = match app.updater() {
        Ok(u) => u,
        Err(err) => return fail(&app, &mut state, format!("更新组件不可用：{err}")),
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => return fail(&app, &mut state, "线上版本已回退，本机无需更新".into()),
        Err(err) => return fail(&app, &mut state, format!("重新确认版本失败：{err}")),
    };

    match update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
    {
        Ok(()) => {
            state.status = "installing".into();
            persist(&app, &state);
            if let Some(srv) = app.try_state::<crate::server::Server>() {
                srv.stop();
            }
            app.restart();
        }
        Err(err) => fail(&app, &mut state, format!("下载或安装失败：{err}")),
    }
}

/// 后台轮询：启动后等一会儿，之后每 6 小时一次。
pub fn spawn_background_check(app: AppHandle) {
    // 开发构建默认不打扰，避免每次调试都去打 GitHub；LANDROP_FORCE_UPDATE_CHECK=1 可强制
    if cfg!(debug_assertions) && std::env::var("LANDROP_FORCE_UPDATE_CHECK").is_err() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            check(app.clone(), false).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/// 托盘菜单点击：有可装版本就装，否则查一次。
pub fn on_menu(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let ready = snapshot(&app).status == "available";
        if ready {
            install(app).await;
        } else {
            check(app, true).await;
        }
    });
}
