//! 系统托盘。
//!
//! 关掉窗口不等于关掉服务——托盘是这个 App 唯一的"我还活着"的出口，
//! 所以菜单里必须能直接拿到手机地址、打开存储目录，以及真正退出。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

use crate::server::Server;

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    if let Some(tray) = app.tray_by_id("landrop-tray") {
        let _ = tray.set_tooltip(Some(TRAY_TIP_ACTIVE));
    }
}

pub const TRAY_TIP_ACTIVE: &str = "LanDrop · 正在为局域网提供文件服务";
pub const TRAY_TIP_HIDDEN: &str = "LanDrop 仍在后台运行 · 单击图标重新打开";

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 LanDrop 控制台", true, None::<&str>)?;
    let copy = MenuItem::with_id(app, "copy", "复制手机访问地址", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", "打开接收文件夹", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出 LanDrop", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &copy, &folder, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("landrop-tray")
        .tooltip(TRAY_TIP_ACTIVE)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "copy" => {
                if let Some(srv) = app.try_state::<Server>() {
                    let url = srv.lan_url();
                    let _ = app.clipboard().write_text(url);
                }
            }
            "folder" => {
                if let Some(srv) = app.try_state::<Server>() {
                    let dir = srv.storage_dir.clone();
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = app.opener().open_path(dir.to_string_lossy(), None::<&str>);
                }
            }
            "quit" => {
                if let Some(srv) = app.try_state::<Server>() {
                    srv.stop();
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            // 左键单击就唤回窗口：用户关窗后最先会做的事就是点图标
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } => show_main(tray.app_handle()),
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    // 单击托盘也能唤起，Windows 用户习惯这个
    if let Some(tray) = app.tray_by_id("landrop-tray") {
        let _ = tray.set_show_menu_on_left_click(false);
    }
    Ok(())
}
