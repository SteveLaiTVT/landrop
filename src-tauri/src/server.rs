//! 服务进程生命周期管理。
//!
//! 桌面端不是把页面塞进 WebView 就完事——它要在本机起一个真正的 HTTP 服务，
//! 手机连同一个 Wi-Fi 就能访问。这里负责挑端口、拉起后端、等它就绪、退出时收尸。

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// 优先使用的端口区间。避开 8080 这类常被别的开发服务器占用的端口。
const PORT_START: u16 = 17800;
const PORT_END: u16 = 17860;

pub struct Server {
    pub port: u16,
    pub data_dir: PathBuf,
    pub storage_dir: PathBuf,
    pub log_file: PathBuf,
    child: Mutex<Option<Child>>,
}

impl Server {
    /// 主窗口要加载的地址。
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// 手机该访问的地址（局域网 IP）。
    pub fn lan_url(&self) -> String {
        format!("{}/w/{}", self.origin().replace("127.0.0.1", &lan_ip()), self.session_token())
    }

    pub fn session_token(&self) -> String {
        let file = self.data_dir.join("config.json");
        let raw = std::fs::read_to_string(file).unwrap_or_default();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
        value
            .get("sessionToken")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }

    pub fn stop(&self) {
        let mut guard = match self.child.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn is_alive(&self) -> bool {
        let mut guard = match self.child.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }
}

/// 找一个真正能绑定上的端口，绑定成功立刻释放，交给 Node 去监听。
fn pick_port() -> Option<u16> {
    for port in PORT_START..=PORT_END {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

/// 探测本机在局域网里的地址。连一个外网地址只为了拿到出口网卡，不真的发包。
pub fn lan_ip() -> String {
    UdpSocket::bind("0.0.0.0:0")
        .and_then(|sock| {
            sock.connect("8.8.8.8:80")?;
            sock.local_addr()
        })
        .map(|addr| addr.ip().to_string())
        .unwrap_or_else(|_| "127.0.0.1".to_string())
}

/// 直接读一次 HTTP 响应头，够判断服务起没起来，不必为此引入 reqwest。
fn health_ok(port: u16) -> bool {
    let addr = match format!("127.0.0.1:{}", port).parse() {
        Ok(a) => a,
        Err(_) => return false,
    };
    let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(400)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let req = format!(
        "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        port
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 256];
    match stream.read(&mut buf) {
        Ok(n) if n > 0 => {
            let head = String::from_utf8_lossy(&buf[..n]);
            head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")
        }
        _ => false,
    }
}

/// 项目根目录（开发模式下用来找 server/index.js 和 public/）。
fn dev_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 打包后的 sidecar 可能落在几个不同位置，挨个试。
fn find_sidecar(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("landrop-server.exe"));
        candidates.push(dir.join("binaries").join("landrop-server.exe"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("landrop-server.exe"));
        }
    }
    candidates.into_iter().find(|p| p.exists())
}

fn public_dir(app: &AppHandle) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let packaged = dir.join("public");
        if packaged.join("index.html").exists() {
            return packaged;
        }
    }
    dev_root().join("public")
}

/// 把 stdout/stderr 接到日志文件，App 无控制台时也能查问题。
fn open_log(path: &PathBuf) -> (Stdio, Stdio) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::OpenOptions::new().create(true).append(true).open(path) {
        Ok(f) => {
            let f2 = match f.try_clone() {
                Ok(c) => c,
                Err(_) => return (Stdio::null(), Stdio::null()),
            };
            (Stdio::from(f), Stdio::from(f2))
        }
        Err(_) => (Stdio::null(), Stdio::null()),
    }
}

#[cfg(windows)]
fn hide_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console(_cmd: &mut Command) {}

pub fn start(app: &AppHandle) -> Result<Server, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| dev_root().join("data"));
    let _ = std::fs::create_dir_all(&data_dir);

    let storage_dir = std::env::var("USERPROFILE")
        .map(|p| PathBuf::from(p).join("LanDrop"))
        .unwrap_or_else(|_| dev_root().join("storage"));
    let _ = std::fs::create_dir_all(&storage_dir);

    let log_file = data_dir.join("server.log");
    let public = public_dir(app);

    let port = pick_port().ok_or_else(|| {
        format!(
            "端口 {}–{} 全部被占用，无法启动本机服务。",
            PORT_START, PORT_END
        )
    })?;

    // 开发构建优先跑源码，改了后端立刻生效；设 LANDROP_USE_SIDECAR=1 可强制验证打包产物
    let prefer_source =
        cfg!(debug_assertions) && std::env::var("LANDROP_USE_SIDECAR").is_err();

    let mut cmd = if !prefer_source {
        match find_sidecar(app) {
            Some(bin) => Command::new(bin),
            None => {
                return Err(format!(
                    "找不到内置服务程序 landrop-server.exe。\n\
                     请先执行：npm run build:sidecar"
                ))
            }
        }
    } else {
        let entry = dev_root().join("server").join("index.js");
        if !entry.exists() {
            return Err(format!("找不到服务端入口：{}", entry.display()));
        }
        let mut c = Command::new("node");
        c.arg(entry);
        c
    };

    let (out, err) = open_log(&log_file);
    cmd.env("LANDROP_DATA_DIR", &data_dir)
        .env("LANDROP_STORAGE_DIR", &storage_dir)
        .env("LANDROP_PUBLIC_DIR", &public)
        .env("LANDROP_PORT", port.to_string())
        .env("LANDROP_DESKTOP", "1")
        // 让控制台显示的版本号与安装包一致，而不是后端自己的
        .env("LANDROP_APP_VERSION", app.package_info().version.to_string())
        .arg(format!("--port={}", port))
        // stdin 保持开启：App 被强杀时管道随之关闭，后端据此自杀，不留下占端口的孤儿进程
        .stdin(Stdio::piped())
        .stdout(out)
        .stderr(err);
    hide_console(&mut cmd);

    let child = cmd
        .spawn()
        .map_err(|e| format!("服务进程启动失败：{}", e))?;

    let server = Server {
        port,
        data_dir,
        storage_dir,
        log_file,
        child: Mutex::new(Some(child)),
    };

    // 等它真的能响应请求，而不是干等固定时长
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if health_ok(port) {
            return Ok(server);
        }
        if !server.is_alive() {
            let tail = std::fs::read_to_string(&server.log_file).unwrap_or_default();
            let tail: String = tail.lines().rev().take(6).collect::<Vec<_>>().join("\n");
            server.stop();
            return Err(format!("服务进程提前退出。\n{}", tail));
        }
        if Instant::now() > deadline {
            server.stop();
            return Err(format!(
                "服务在 15 秒内没有就绪，日志见 {}",
                server.log_file.display()
            ));
        }
        std::thread::sleep(Duration::from_millis(180));
    }
}
