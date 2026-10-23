// 发布版不弹控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;
mod tray;
mod updater;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// data: URL 里只允许保留极少数 ASCII 字符，其余全部转义。
fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 3);
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b' ' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn error_page(message: &str) -> tauri::Url {
    let escaped = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let html = format!(
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>LanDrop 启动失败</title>\
<style>body{{margin:0;height:100vh;display:grid;place-items:center;background:#0f1211;color:#e8eeea;\
font:15px/1.7 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif}}\
main{{max-width:600px;padding:36px}}h1{{font-size:19px;margin:0 0 14px;color:#ffb4a2;font-weight:600}}\
pre{{white-space:pre-wrap;word-break:break-word;background:#161b18;border:1px solid #28322c;border-radius:10px;\
padding:14px 16px;font:13px/1.6 ui-monospace,Consolas,monospace;color:#b9c6be;margin:0 0 14px}}\
p{{color:#7d8c84;font-size:13px;margin:0}}</style>\
<main><h1>LanDrop 没能启动本机服务</h1><pre>{}</pre>\
<p>本机服务是桌面端的核心，它没起来就无法为手机提供访问。修正后重新打开 LanDrop 即可。</p></main></html>",
        escaped
    );
    format!("data:text/html;charset=utf-8,{}", percent_encode(&html))
        .parse()
        .expect("data URL 必然合法")
}

fn main() {
    tauri::Builder::default()
        // 单实例必须最先注册：第二次启动应该唤起已有窗口，而不是再起一个服务
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();

            match server::start(&handle) {
                Ok(srv) => {
                    let url: tauri::Url = srv.origin().parse().expect("本机地址必然合法");
                    app.manage(srv);

                    // 小屏笔记本上别让窗口大过桌面
                    let (mut width, mut height) = (1440.0_f64, 900.0_f64);
                    if let Ok(Some(monitor)) = app.primary_monitor() {
                        let scale = monitor.scale_factor();
                        let sw = monitor.size().width as f64 / scale;
                        let sh = monitor.size().height as f64 / scale;
                        width = width.min(sw * 0.92);
                        height = height.min(sh * 0.88);
                    }

                    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                        .title("LanDrop")
                        .inner_size(width, height)
                        .min_inner_size(960.0, 620.0)
                        // 必须关掉：否则 Tauri 会接管文件拖放，页面里的拖拽上传就收不到事件了
                        .disable_drag_drop_handler()
                        .zoom_hotkeys_enabled(false)
                        .center()
                        .build()?;
                }
                Err(message) => {
                    eprintln!("[landrop] 服务启动失败：{}", message);
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(error_page(&message)))
                        .title("LanDrop · 启动失败")
                        .inner_size(820.0, 520.0)
                        .center()
                        .build()?;
                }
            }

            tray::build(&handle)?;
            updater::init(&handle);
            updater::spawn_background_check(handle);
            Ok(())
        })
        // 关窗不停服务：托盘是唯一的退出通道
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                if let Some(tray) = window.app_handle().tray_by_id("landrop-tray") {
                    let _ = tray.set_tooltip(Some(tray::TRAY_TIP_HIDDEN));
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用构建失败")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(srv) = app.try_state::<server::Server>() {
                    srv.stop();
                }
            }
        });
}
