"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const { loadConfig, writeConfig, DATA_DIR, PUBLIC_DIR, ensureDir, randomToken } = require("./config");
const { Store, deviceNameFromUA, sanitizeName } = require("./store");
const net = require("./net");
const { qrSvg } = require("./qr");
const { receiveUpload, filenameFromRequest, httpError } = require("./upload");
const { buildPreview, previewKind } = require("./preview");
const { writeZip } = require("./zip");

const VERSION = "1.0.0";
const config = loadConfig();
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
if (portArg) {
  const parsed = Number(portArg.split("=")[1]);
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) config.port = parsed;
}
if (config.pendingPort) {
  config.port = config.pendingPort;
  delete config.pendingPort;
  writeConfig(config);
}
const store = new Store({ dataDir: DATA_DIR, storageDir: config.storageDir, config });
const MAX_BYTES = config.maxUploadGB * 1024 * 1024 * 1024;

const MIME = new Map(Object.entries({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".zip": "application/zip"
}));

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/* 交给系统默认浏览器打开本机页面。不经过 cmd，避免 URL 里的 & 被当成命令分隔符。 */
function openInBrowser(href) {
  const opts = { detached: true, stdio: "ignore" };
  try {
    let child;
    if (process.platform === "win32") {
      child = spawn("rundll32", ["url.dll,FileProtocolHandler", href], opts);
    } else if (process.platform === "darwin") {
      child = spawn("open", [href], opts);
    } else {
      child = spawn("xdg-open", [href], opts);
    }
    child.unref();
  } catch {
    /* 打不开浏览器不该影响主流程 */
  }
}

/** 用系统默认程序打开一个本地文件（仅本机控制台可调用）。 */
function openPathInSystem(full) {
  const opts = { detached: true, stdio: "ignore" };
  try {
    let child;
    if (process.platform === "win32") {
      child = spawn("explorer.exe", [full], opts);
    } else if (process.platform === "darwin") {
      child = spawn("open", [full], opts);
    } else {
      child = spawn("xdg-open", [full], opts);
    }
    child.unref();
  } catch {
    /* 打不开不该影响主流程 */
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store"
  });
  res.end(html);
}

async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, "请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "JSON 解析失败");
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function setCookie(res, name, value, maxAge = 30 * 24 * 3600) {
  const cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
  const existing = res.getHeader("Set-Cookie");
  if (!existing) res.setHeader("Set-Cookie", cookie);
  else if (Array.isArray(existing)) res.setHeader("Set-Cookie", [...existing, cookie]);
  else res.setHeader("Set-Cookie", [String(existing), cookie]);
}

function clientIp(req) {
  return net.normalizeAddress(req.socket.remoteAddress);
}

function lanOrigin() {
  const ip = net.localIPv4().address;
  return `http://${ip}:${config.port}`;
}

function shareLink(token) {
  return `${lanOrigin()}/s/${token}`;
}

function pairingInfo() {
  const session = store.sessionPayload();
  return {
    ...session,
    url: `${lanOrigin()}/w/${session.token}`,
    codeUrl: `${lanOrigin()}/p/${session.code}`,
    appUrl: `${lanOrigin()}/app/${session.token}`,
    qrUrl: `/qr.svg?data=${encodeURIComponent(`${lanOrigin()}/w/${session.token}`)}`,
    appQrUrl: `/qr.svg?data=${encodeURIComponent(`${lanOrigin()}/app/${session.token}`)}`
  };
}

function publicFile(file, base = "/api/files") {
  return {
    ...file,
    tags: file.tags || [],
    folderId: file.folderId || null,
    previewKind: previewKind(file.name),
    previewUrl: `${base}/${file.id}/preview`,
    rawUrl: `${base}/${file.id}/raw`,
    downloadUrl: `${base}/${file.id}/download`
  };
}

/** 列出某个目录下的子目录，供「选择存储位置」使用。 */
async function listDirectories(rawPath) {
  const requested = rawPath && String(rawPath).trim() ? path.resolve(String(rawPath).trim()) : config.storageDir;
  const roots = [];
  if (process.platform === "win32") {
    for (let i = 67; i <= 90; i += 1) {
      const drive = `${String.fromCharCode(i)}:\\`;
      if (fs.existsSync(drive)) roots.push(drive);
    }
  } else {
    roots.push("/");
  }

  let stat = null;
  try {
    stat = await fsp.stat(requested);
  } catch {
    return { ok: false, error: "not_found", message: "目录不存在", path: requested, roots };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: "not_a_dir", message: "这不是一个目录", path: requested, roots };
  }

  const entries = await fsp.readdir(requested, { withFileTypes: true }).catch(() => []);
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("$") || entry.name === "System Volume Information") continue;
    dirs.push({ name: entry.name, path: path.join(requested, entry.name) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  const parent = path.dirname(requested);
  return {
    ok: true,
    path: requested,
    parent: parent === requested ? null : parent,
    home: os.homedir(),
    storageDir: config.storageDir,
    dirs: dirs.slice(0, 500),
    roots
  };
}

/** 把旧存储目录里的文件搬到新目录（跨盘用复制 + 删除兜底）。 */
async function migrateStorage(from, to) {
  if (path.resolve(from) === path.resolve(to)) return { moved: 0, skipped: 0, failed: 0 };
  const entries = await fsp.readdir(from, { withFileTypes: true }).catch(() => []);
  let moved = 0;
  let skipped = 0;
  let failed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith(".") || entry.name.endsWith(".part")) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (fs.existsSync(dest)) {
      skipped += 1;
      continue;
    }
    try {
      await fsp.rename(src, dest);
      moved += 1;
    } catch (err) {
      if (err.code !== "EXDEV") {
        failed += 1;
        continue;
      }
      try {
        await fsp.copyFile(src, dest);
        await fsp.unlink(src);
        moved += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { moved, skipped, failed };
}

/* ------------------------------------------------------------------ */
/* Skill 包打包                                                        */
/* ------------------------------------------------------------------ */

const SKILL_DIR = process.env.LANDROP_SKILL_DIR
  ? path.resolve(process.env.LANDROP_SKILL_DIR)
  : path.resolve(PUBLIC_DIR, "..", "skill");

async function collectSkillFiles(dir, prefix = "") {
  const out = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectSkillFiles(full, rel)));
    } else if (entry.isFile()) {
      out.push({ name: rel, data: await fsp.readFile(full) });
    }
  }
  return out;
}

/** 现打一个 zip：带上当前机器的地址与令牌，拷到别的 WorkBuddy 上就能直接跑。 */
async function buildSkillZip() {
  const files = await collectSkillFiles(SKILL_DIR);
  if (!files.length) return null;
  files.push({
    name: "config.json",
    data: Buffer.from(
      JSON.stringify({ url: `http://127.0.0.1:${config.port}`, token: config.skillToken }, null, 2),
      "utf8"
    )
  });
  return writeZip(files);
}

async function diskStats(dir) {
  try {
    const st = await fsp.statfs(dir);
    const blockSize = Number(st.bsize) || 0;
    const total = Number(st.blocks) * blockSize;
    const free = Number(st.bavail ?? st.bfree) * blockSize;
    return { total, free, used: Math.max(0, total - free) };
  } catch {
    return { total: 0, free: 0, used: 0 };
  }
}

function fileMime(name) {
  return MIME.get(path.extname(name).toLowerCase()) || "application/octet-stream";
}

function contentDisposition(name, mode) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendFileStream(req, res, file, { inline = false, cache = "no-store" } = {}) {
  const full = path.join(config.storageDir, file.name);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return sendJson(res, 404, { error: "file_not_found", message: "文件已不存在" });
  }
  const size = stat.size;
  const type = fileMime(file.name);
  const baseHeaders = {
    "Content-Type": type,
    "Content-Disposition": contentDisposition(file.name, inline ? "inline" : "attachment"),
    "Accept-Ranges": "bytes",
    "Cache-Control": cache,
    "X-Content-Type-Options": "nosniff"
  };
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return res.end();
    }
    let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    let end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (!match[1] && match[2]) {
      start = Math.max(0, size - Number(match[2]));
      end = size - 1;
    }
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": end - start + 1
    });
    if (req.method === "HEAD") return res.end();
    return fs.createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...baseHeaders, "Content-Length": size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(full).pipe(res);
}

function servePage(res, filename, { cookies = [] } = {}) {
  const full = path.join(PUBLIC_DIR, filename);
  return fsp.readFile(full).then((buf) => {
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    };
    if (cookies.length) {
      headers["Set-Cookie"] = cookies;
    }
    res.writeHead(200, headers);
    res.end(buf);
  });
}

/** 把会话写进 cookie，供 /app 与 /api/app/* 使用（不出现在 URL 里）。 */
function sessionCookie() {
  const maxAge = Math.max(60, Math.floor((new Date(config.sessionExpiresAt).getTime() - Date.now()) / 1000));
  return `ld_session=${encodeURIComponent(config.sessionToken)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;
}

function appGuard(req, res) {
  const session = store.sessionPayload();
  if (!session.valid) {
    sendJson(res, 410, { error: "session_expired", message: "连接已过期，请在电脑上刷新配对码后重新扫码。" });
    return null;
  }
  const cookies = parseCookies(req);
  if (cookies.ld_session !== config.sessionToken) {
    sendJson(res, 401, { error: "not_paired", message: "这台手机还没有配对，请先扫码。" });
    return null;
  }
  const device = store.touchDevice({
    id: cookies.ld_did,
    ip: clientIp(req),
    ua: req.headers["user-agent"],
    kind: "app"
  });
  if (!device) {
    sendJson(res, 403, { error: "device_revoked", message: "这台设备已被移除，请重新扫码。" });
    return null;
  }
  if (cookies.ld_did !== device.id) setCookie(res, "ld_did", device.id);
  return device;
}

function localOnly(req, res) {
  if (net.isLocalRequest(req)) return true;
  sendJson(res, 403, {
    error: "console_local_only",
    message: "控制台仅限这台电脑访问；手机请扫描配对二维码。"
  });
  return false;
}

function sessionGuard(req, res, token) {
  const session = store.sessionPayload();
  if (!session.valid) {
    sendJson(res, 410, { error: "session_expired", message: "会话已过期，请在电脑端重新扫码。" });
    return null;
  }
  if (token !== config.sessionToken) {
    sendJson(res, 404, { error: "session_not_found", message: "这个连接地址已失效。" });
    return null;
  }
  const cookies = parseCookies(req);
  const device = store.touchDevice({
    id: cookies.ld_did,
    ip: clientIp(req),
    ua: req.headers["user-agent"]
  });
  if (!device) {
    sendJson(res, 403, { error: "device_revoked", message: "这台设备已被移除，请重新扫码。" });
    return null;
  }
  if (cookies.ld_did !== device.id) setCookie(res, "ld_did", device.id);
  return device;
}

async function buildState(req) {
  await store.refresh();
  const stats = store.stats();
  const disk = await diskStats(config.storageDir);
  const lan = net.localIPv4();
  const origin = lanOrigin();
  const devices = store.listDevices()
    .filter((d) => d.id !== "self")
    .map((d) => ({ ...d, self: false }));
  const self = {
    id: "self",
    name: config.deviceName,
    ip: lan.address,
    platform: `${os.type()} ${os.release()}`.trim(),
    createdAt: config.sessionCreatedAt,
    lastSeen: new Date().toISOString(),
    online: true,
    self: true,
    filesReceived: stats.count
  };
  return {
    ok: true,
    version: VERSION,
    device: {
      name: config.deviceName,
      hostname: os.hostname(),
      platform: os.platform()
    },
    network: {
      ip: lan.address,
      iface: lan.name,
      port: config.port,
      origin,
      lanOnly: config.lanOnly
    },
    // 桌面壳会注入 LANDROP_DESKTOP=1，前端据此切换掉浏览器专属的交互
    runtime: {
      desktop: process.env.LANDROP_DESKTOP === "1",
      platform: process.platform
    },
    storage: {
      dir: config.storageDir,
      displayDir: config.storageDir,
      count: stats.count,
      totalSize: stats.totalSize,
      folders: stats.folders,
      unfiled: stats.unfiled,
      disk
    },
    folders: store.listFolders(),
    files: store.files.map((f) => publicFile(f)),
    drive: {
      ...store.driveInfo(),
      url: `${lanOrigin()}/d/${store.drive.token}`,
      qrUrl: `/qr.svg?data=${encodeURIComponent(`${lanOrigin()}/d/${store.drive.token}`)}`,
      // 控制台要显示盘内文件与待拾取，这里直接带上，省一次往返
      files: store.drive.fileIds
        .map((id) => store.findFile(id))
        .filter(Boolean)
        .map((f) => publicFile(f))
    },
    shares: store.listShares().map((s) => ({ ...s, link: shareLink(s.id) })),
    activity: store.listActivity(80),
    devices: [self, ...devices],
    pairing: pairingInfo(),
    settings: {
      storageDir: config.storageDir,
      port: config.pendingPort || config.port,
      pendingPort: config.pendingPort || null,
      lanOnly: config.lanOnly,
      allowWriteShares: config.allowWriteShares,
      notifyOnUpload: config.notifyOnUpload,
      keepAwake: config.keepAwake,
      autoStart: config.autoStart,
      maxUploadGB: config.maxUploadGB
    },
    skill: {
      token: config.skillToken,
      endpoint: `${origin}/api/skill`,
      packed: false
    },
    limits: { maxUploadGB: config.maxUploadGB }
  };
}

/* ------------------------------------------------------------------ */
/* SSE                                                                */
/* ------------------------------------------------------------------ */

const sseClients = new Set();

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    // 定向事件（如推送到某台手机）只发给对应设备
    if (event.deviceId && res.ldDeviceId !== event.deviceId) continue;
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function openSse(req, res, { deviceId = null } = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 2000\n\n");
  res.ldDeviceId = deviceId;
  sseClients.add(res);
  const timer = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 25000);
  const close = () => {
    clearInterval(timer);
    sseClients.delete(res);
  };
  req.on("close", close);
  req.on("error", close);
}

store.on("change", (event) => {
  broadcast({ type: "refresh", kind: event.kind });
});

/* ------------------------------------------------------------------ */
/* request handler                                                    */
/* ------------------------------------------------------------------ */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (config.lanOnly && !net.isPrivateAddress(clientIp(req))) {
    return sendJson(res, 403, { error: "lan_only", message: "仅允许局域网访问" });
  }

  if (pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, version: VERSION, uptime: process.uptime() });
  }

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  if (pathname === "/qr.svg") {
    const data = url.searchParams.get("data") || "";
    if (!data || data.length > 512) return sendText(res, 400, "invalid data");
    const svg = qrSvg(data);
    res.writeHead(200, {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Content-Length": Buffer.byteLength(svg),
      "Cache-Control": "public, max-age=300"
    });
    return res.end(svg);
  }

  if (pathname === "/manifest.webmanifest") {
    return fsp.readFile(path.join(PUBLIC_DIR, "manifest.webmanifest"))
      .then((buf) => {
        res.writeHead(200, {
          "Content-Type": "application/manifest+json; charset=utf-8",
          "Content-Length": buf.length
        });
        res.end(buf);
      })
      .catch(() => sendText(res, 404, "not found"));
  }

  /* ----- static assets ----- */
  if (pathname.startsWith("/assets/") || pathname.startsWith("/js/")) {
    const rel = pathname.replace(/^\/+/, "");
    const full = path.resolve(PUBLIC_DIR, rel);
    if (!full.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, "forbidden");
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile()) return sendText(res, 404, "not found");
      res.writeHead(200, {
        "Content-Type": fileMime(full),
        "Content-Length": stat.size,
        "Cache-Control": "no-cache"
      });
      return fs.createReadStream(full).pipe(res);
    } catch {
      return sendText(res, 404, "not found");
    }
  }

  /* ----- pages ----- */
  if (pathname === "/" || pathname === "/index.html") {
    if (!localOnly(req, res)) return;
    return servePage(res, "index.html");
  }
  if (/^\/w\/[A-Za-z0-9]+$/.test(pathname)) {
    const token = pathname.slice(3);
    const cookies = token === config.sessionToken ? [sessionCookie()] : [];
    return servePage(res, "w.html", { cookies });
  }
  if (pathname === "/app" || pathname === "/app/") {
    return servePage(res, "app.html");
  }
  // /app/<token>：扫码直达 App 版，顺带把会话写进 cookie（等价于先扫 /w/<token>）
  if (/^\/app\/[A-Za-z0-9]+$/.test(pathname)) {
    const token = pathname.slice(5);
    const cookies = token === config.sessionToken ? [sessionCookie()] : [];
    return servePage(res, "app.html", { cookies });
  }
  if (/^\/s\/[A-Za-z0-9]+$/.test(pathname)) {
    return servePage(res, "s.html");
  }
  if (/^\/d\/[A-Za-z0-9]+$/.test(pathname)) {
    // 分享盘页：token 本身就是凭证，页面再凭 token 调 /api/drive/<token>/info
    return servePage(res, "d.html");
  }
  if (pathname === "/pair") {
    return servePage(res, "pair.html");
  }
  if (pathname === "/sw.js") {
    return fsp.readFile(path.join(PUBLIC_DIR, "sw.js"))
      .then((buf) => {
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Content-Length": buf.length,
          "Cache-Control": "no-store",
          "Service-Worker-Allowed": "/"
        });
        res.end(buf);
      })
      .catch(() => sendText(res, 404, "not found"));
  }

  /* ----- pair code ----- */
  const pairMatch = /^\/p\/(\d{6})$/.exec(pathname);
  if (pairMatch) {
    if (pairMatch[1] !== config.pairCode) {
      return sendHtml(res, 410, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>配对码已失效</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f1f3ef;color:#0f1512;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:24px}.card{max-width:360px;background:#fff;border:1px solid #dce2db;border-radius:16px;padding:24px;box-shadow:0 18px 40px -32px rgba(15,21,18,.42)}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#45514b;font-size:14px;line-height:1.6}</style></head><body><div class="card"><h1>配对码已失效</h1><p>配对码在电脑端刷新后会变化。请回到电脑的 LanDrop 控制台，重新扫码或复制最新的网页版地址。</p></div></body></html>`);
    }
    if (!store.sessionPayload().valid) {
      return sendHtml(res, 410, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>会话已过期</title><style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f1f3ef;color:#0f1512;font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:24px}.card{max-width:360px;background:#fff;border:1px solid #dce2db;border-radius:16px;padding:24px}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#45514b;font-size:14px;line-height:1.6}</style></head><body><div class="card"><h1>会话已过期</h1><p>二维码在 24 小时后失效。请在电脑端刷新配对码后重新扫码。</p></div></body></html>`);
    }
    res.writeHead(302, { Location: `/w/${config.sessionToken}`, "Cache-Control": "no-store" });
    return res.end();
  }

  /* ----- session API ----- */
  const sessionMatch = /^\/api\/session\/([A-Za-z0-9]+)(\/.*)?$/.exec(pathname);
  if (sessionMatch) {
    const token = sessionMatch[1];
    const rest = sessionMatch[2] || "";
    const device = sessionGuard(req, res, token);
    if (!device) return;

    if (rest === "" || rest === "/") {
      await store.refresh();
      return sendJson(res, 200, {
        ok: true,
        session: {
          expiresAt: config.sessionExpiresAt,
          createdAt: config.sessionCreatedAt,
          url: `${lanOrigin()}/w/${token}`,
          ttlHours: 24
        },
        host: {
          name: config.deviceName,
          ip: net.localIPv4().address,
          port: config.port,
          storage: config.storageDir
        },
        device: { id: device.id, name: device.name },
        folders: store.listFolders(),
        files: store.files.map((f) => publicFile(f, `/api/session/${token}/files`)),
        maxUploadGB: config.maxUploadGB
      });
    }

    if (rest === "/events") {
      return openSse(req, res, { deviceId: device.id });
    }

    if (rest === "/upload" && (method === "PUT" || method === "POST")) {
      const received = await receiveUpload(req, { tmpDir: store.tmpDir, maxBytes: MAX_BYTES });
      const file = await store.commitUpload({
        tempPath: received.tempPath,
        name: filenameFromRequest(req, url),
        size: received.size,
        mtimeMs: received.mtimeMs,
        source: device.name,
        via: "网页上传"
      });
      broadcast({ type: "upload", file: publicFile(file) });
      return sendJson(res, 201, { ok: true, file: publicFile(file, `/api/session/${token}/files`) });
    }

    const fileDownload = new RegExp(`^/files/([^/]+)/download$`).exec(rest);
    if (fileDownload && method === "GET") {
      const file = store.findFile(fileDownload[1]);
      if (!file) return sendJson(res, 404, { error: "file_not_found" });
      await store.log({
        type: "download",
        fileId: file.id,
        fileName: file.name,
        device: `${device.name} · 网页版`,
        detail: "下载到手机"
      });
      return sendFileStream(req, res, file);
    }

    const filePreview = new RegExp(`^/files/([^/]+)/preview$`).exec(rest);
    if (filePreview && method === "GET") {
      const file = store.findFile(filePreview[1]);
      if (!file) return sendJson(res, 404, { error: "file_not_found" });
      try {
        return sendJson(res, 200, await buildPreview(path.join(config.storageDir, file.name), file.name));
      } catch (err) {
        return sendJson(res, 500, { error: "preview_failed", message: err.message });
      }
    }

    const fileRaw = new RegExp(`^/files/([^/]+)/raw$`).exec(rest);
    if (fileRaw && method === "GET") {
      const file = store.findFile(fileRaw[1]);
      if (!file) return sendJson(res, 404, { error: "file_not_found" });
      return sendFileStream(req, res, file, { inline: true, cache: "private, max-age=60" });
    }

    if (rest === "/folders" && method === "GET") {
      await store.refresh();
      return sendJson(res, 200, { ok: true, folders: store.listFolders() });
    }

    if (rest === "/search" && method === "GET") {
      await store.refresh();
      const list = store.search(url.searchParams.get("q") || "", {
        folderId: url.searchParams.has("folder") ? url.searchParams.get("folder") : undefined,
        kind: url.searchParams.get("kind") || undefined,
        tag: url.searchParams.get("tag") || undefined,
        limit: Number(url.searchParams.get("limit")) || 200
      });
      return sendJson(res, 200, {
        ok: true,
        total: list.length,
        files: list.map((f) => publicFile(f, `/api/session/${token}/files`))
      });
    }

    if (rest === "/inbox" && method === "GET") {
      return sendJson(res, 200, { ok: true, items: store.inboxFor(device.id) });
    }

    const inboxReceived = new RegExp(`^/inbox/([^/]+)/received$`).exec(rest);
    if (inboxReceived && method === "POST") {
      const item = await store.markInboxReceived(device.id, inboxReceived[1]);
      if (!item) return sendJson(res, 404, { error: "inbox_not_found" });
      return sendJson(res, 200, { ok: true, item });
    }

    if (rest === "/shares" && method === "POST") {
      const body = await readJsonBody(req);
      await store.refresh();
      const target = store.findFile(body.fileId);
      if (!target) return sendJson(res, 404, { error: "file_not_found" });
      if (body.perm === "write" && !config.allowWriteShares) {
        return sendJson(res, 403, { error: "write_disabled", message: "电脑端已关闭「允许同事写入」" });
      }
      const share = await store.createShare({
        fileId: target.id,
        perm: body.perm,
        expiry: body.expiry,
        note: body.note
      });
      return sendJson(res, 201, { ok: true, share: { ...store.enrichShare(share), link: shareLink(share.id) } });
    }

    return sendJson(res, 404, { error: "not_found" });
  }

  /* ----- public share API ----- */
  const shareApi = /^\/api\/share\/([A-Za-z0-9]+)$/.exec(pathname);
  if (shareApi && method === "GET") {
    const share = store.shareByToken(shareApi[1]);
    if (!share) return sendJson(res, 404, { error: "share_not_found", message: "这个共享链接不存在" });
    return sendJson(res, 200, {
      ok: true,
      share: {
        id: share.id,
        name: share.name,
        size: share.size,
        kind: share.kind,
        ext: share.ext,
        perm: share.perm,
        note: share.note,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        expiry: share.expiry,
        downloads: share.downloads,
        revoked: share.revoked,
        expired: share.expired,
        fileExists: share.fileExists
      },
      host: { name: config.deviceName, origin: lanOrigin() },
      canWrite: share.perm === "write" && config.allowWriteShares
    });
  }

  const shareDownload = /^\/s\/([A-Za-z0-9]+)\/download$/.exec(pathname);
  if (shareDownload && (method === "GET" || method === "HEAD")) {
    const share = store.shareByToken(shareDownload[1]);
    if (!share) return sendText(res, 404, "共享链接不存在");
    if (share.revoked) return sendText(res, 410, "共享链接已被撤销");
    if (share.expired) return sendText(res, 410, "共享链接已过期");
    if (!share.fileExists) return sendText(res, 404, "文件已被删除");
    const file = store.findFile(share.fileId);
    if (!file) return sendText(res, 404, "文件已被删除");
    if (method === "GET") {
      store.registerShareDownload(share.id, deviceNameFromUA(req.headers["user-agent"])).catch(() => {});
    }
    return sendFileStream(req, res, file);
  }

  const shareUpload = /^\/api\/share\/([A-Za-z0-9]+)\/upload$/.exec(pathname);
  if (shareUpload && (method === "PUT" || method === "POST")) {
    const share = store.shareByToken(shareUpload[1]);
    if (!share) return sendJson(res, 404, { error: "share_not_found" });
    if (share.revoked) return sendJson(res, 410, { error: "revoked" });
    if (share.expired) return sendJson(res, 410, { error: "expired" });
    if (share.perm !== "write" || !config.allowWriteShares) {
      return sendJson(res, 403, { error: "read_only", message: "这条链接是只读的" });
    }
    const received = await receiveUpload(req, { tmpDir: store.tmpDir, maxBytes: MAX_BYTES });
    const uaName = require("./store").deviceNameFromUA(req.headers["user-agent"]);
    const file = await store.commitUpload({
      tempPath: received.tempPath,
      name: filenameFromRequest(req, url),
      size: received.size,
      mtimeMs: received.mtimeMs,
      source: `${uaName} · 共享链接`,
      via: "共享接收"
    });
    broadcast({ type: "upload", file: publicFile(file) });
    return sendJson(res, 201, { ok: true, file: publicFile(file) });
  }

  /* ----- app API（已配对的手机，凭 cookie 会话） ----- */
  if (pathname.startsWith("/api/app/")) {
    const device = appGuard(req, res);
    if (!device) return;
    const rest = pathname.slice("/api/app".length);

    if (rest === "/state" && method === "GET") {
      await store.refresh();
      const session = store.sessionPayload();
      return sendJson(res, 200, {
        ok: true,
        session: {
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          ttlHours: session.ttlHours,
          url: `${lanOrigin()}/w/${session.token}`
        },
        host: {
          name: config.deviceName,
          ip: net.localIPv4().address,
          port: config.port,
          storage: config.storageDir
        },
        device: { id: device.id, name: device.name },
        files: store.files.map((f) => publicFile(f, "/api/app/files")),
        shares: store.listShares().filter((s) => s.active).map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          ext: s.ext,
          size: s.size,
          perm: s.perm,
          expiry: s.expiry,
          expiresAt: s.expiresAt,
          downloads: s.downloads,
          link: shareLink(s.id)
        })),
        activity: store.listActivity(40),
        inbox: store.inboxFor(device.id),
        maxUploadGB: config.maxUploadGB,
        settings: {
          allowWriteShares: config.allowWriteShares,
          notifyOnUpload: config.notifyOnUpload
        }
      });
    }

    if (rest === "/events" && method === "GET") {
      return openSse(req, res, { deviceId: device.id });
    }

    if (rest === "/upload" && (method === "PUT" || method === "POST")) {
      const received = await receiveUpload(req, { tmpDir: store.tmpDir, maxBytes: MAX_BYTES });
      const file = await store.commitUpload({
        tempPath: received.tempPath,
        name: filenameFromRequest(req, url),
        size: received.size,
        mtimeMs: received.mtimeMs,
        source: device.name,
        via: "手机上传"
      });
      broadcast({ type: "upload", file: publicFile(file) });
      return sendJson(res, 201, { ok: true, file: publicFile(file, "/api/app/files") });
    }

    const appDownload = /^\/files\/([^/]+)\/download$/.exec(rest);
    if (appDownload && method === "GET") {
      const file = store.findFile(appDownload[1]);
      if (!file) return sendJson(res, 404, { error: "file_not_found" });
      await store.log({
        type: "download",
        fileId: file.id,
        fileName: file.name,
        device: `${device.name} · App`,
        detail: "下载到手机"
      });
      return sendFileStream(req, res, file);
    }

    if (rest === "/shares" && method === "POST") {
      const body = await readJsonBody(req);
      await store.refresh();
      if (body.perm === "write" && !config.allowWriteShares) {
        return sendJson(res, 403, { error: "write_disabled", message: "电脑端已关闭「允许同事写入」" });
      }
      const share = await store.createShare({
        fileId: body.fileId,
        perm: body.perm,
        expiry: body.expiry,
        note: body.note
      });
      if (!share) return sendJson(res, 404, { error: "file_not_found" });
      return sendJson(res, 201, {
        ok: true,
        share: { ...store.enrichShare(share), link: shareLink(share.id) }
      });
    }

    const inboxReceived = /^\/inbox\/([^/]+)\/received$/.exec(rest);
    if (inboxReceived && method === "POST") {
      const item = await store.markInboxReceived(device.id, inboxReceived[1]);
      if (!item) return sendJson(res, 404, { error: "inbox_not_found" });
      return sendJson(res, 200, { ok: true, item });
    }

    return sendJson(res, 404, { error: "not_found" });
  }

  /* ----- Skill API（给外部 WorkBuddy 定期整理用） ----- */
  if (pathname.startsWith("/api/skill")) {
    const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const given = bearer || String(req.headers["x-landrop-token"] || "").trim();
    // 本机调用免令牌（Skill 就跑在这台电脑上）；局域网其它机器必须带令牌
    const authorized = given ? given === config.skillToken : net.isLocalRequest(req);
    if (!authorized) {
      return sendJson(res, 401, {
        error: "skill_unauthorized",
        message: "Skill 调用需要令牌：Authorization: Bearer <token>，可在控制台「设置 - 自动化」里查看。"
      });
    }

    const rest = pathname.slice("/api/skill".length) || "/";
    await store.refresh();

    if (rest === "/package" && method === "GET") {
      const buf = await buildSkillZip();
      if (!buf) {
        return sendJson(res, 404, {
          error: "skill_missing",
          message: "找不到 skill 目录。源码运行时它在项目根目录；安装版会随 resources 一起分发。"
        });
      }
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Length": buf.length,
        "Content-Disposition": contentDisposition("landrop-skill.zip", "attachment"),
        "Cache-Control": "no-store"
      });
      return res.end(buf);
    }

    if (rest === "/manifest" || rest === "/") {
      return sendJson(res, 200, {
        ok: true,
        name: "landrop-librarian",
        version: VERSION,
        origin: lanOrigin(),
        auth: "本机免令牌；远程请带 Authorization: Bearer <token>",
        capabilities: [
          { name: "search", method: "GET", path: "/api/skill/files", params: "q / folder / kind / tag / limit" },
          { name: "list-folders", method: "GET", path: "/api/skill/folders" },
          { name: "create-folder", method: "POST", path: "/api/skill/folders", body: "{ name, path? }" },
          { name: "move", method: "POST", path: "/api/skill/move", body: "{ ids?, query?, folder }" },
          { name: "tag", method: "POST", path: "/api/skill/tags", body: "{ ids, add?, remove? }" },
          { name: "rename", method: "POST", path: "/api/skill/rename", body: "{ id, name }" },
          { name: "plan", method: "GET", path: "/api/skill/plan", params: "preset=kind|month|ext / olderThanDays" },
          { name: "apply", method: "POST", path: "/api/skill/apply", body: "{ steps }" },
          { name: "stats", method: "GET", path: "/api/skill/stats" },
          { name: "preview-text", method: "GET", path: "/api/skill/preview", params: "id" }
        ],
        presets: ["kind", "month", "ext"],
        stats: store.stats()
      });
    }

    if (rest === "/files" && method === "GET") {
      const list = store.search(url.searchParams.get("q") || "", {
        folderId: url.searchParams.has("folder") ? url.searchParams.get("folder") : undefined,
        kind: url.searchParams.get("kind") || undefined,
        tag: url.searchParams.get("tag") || undefined,
        limit: Number(url.searchParams.get("limit")) || 200
      });
      return sendJson(res, 200, { ok: true, total: list.length, files: list.map((f) => publicFile(f)) });
    }

    if (rest === "/folders" && method === "GET") {
      return sendJson(res, 200, { ok: true, folders: store.listFolders() });
    }

    if (rest === "/folders" && method === "POST") {
      const body = await readJsonBody(req);
      const target = String(body.path || body.name || "").trim();
      if (!target) return sendJson(res, 400, { error: "bad_name", message: "需要 name 或 path" });
      const folder = await store.ensureFolderPath(target, { createdBy: "WorkBuddy Skill" });
      if (folder) {
        await store.log({
          type: "organize",
          fileId: null,
          fileName: folder.name,
          device: "WorkBuddy · Skill",
          detail: "新建整理文件夹"
        });
      }
      return sendJson(res, 201, { ok: true, folder });
    }

    if (rest === "/move" && method === "POST") {
      const body = await readJsonBody(req);
      let ids = Array.isArray(body.ids) ? body.ids : [];
      if (!ids.length && body.query) {
        ids = store.search(body.query, { limit: 500 }).map((f) => f.id);
      }
      if (!ids.length) return sendJson(res, 400, { error: "no_targets", message: "没有匹配到要移动的文件" });
      if (!body.folder) return sendJson(res, 400, { error: "no_folder", message: "需要 folder（可写 归档/2026-10）" });
      const folder = await store.ensureFolderPath(body.folder, { createdBy: "WorkBuddy Skill" });
      const result = await store.moveFiles(ids, folder ? folder.id : null);
      await store.log({
        type: "organize",
        fileId: null,
        fileName: `${result.moved} 个文件`,
        device: "WorkBuddy · Skill",
        detail: `移动到「${body.folder}」`
      });
      return sendJson(res, 200, { ok: true, moved: result.moved, folder });
    }

    if (rest === "/tags" && method === "POST") {
      const body = await readJsonBody(req);
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (!ids.length) return sendJson(res, 400, { error: "no_ids" });
      const result = await store.setTags(ids, { add: body.add, remove: body.remove });
      return sendJson(res, 200, { ok: true, changed: result.changed });
    }

    if (rest === "/rename" && method === "POST") {
      const body = await readJsonBody(req);
      const file = await store.renameFile(body.id, body.name);
      if (!file) return sendJson(res, 400, { error: "rename_failed", message: "重命名失败：文件不存在或同名文件已存在" });
      return sendJson(res, 200, { ok: true, file: publicFile(file) });
    }

    if (rest === "/plan" && method === "GET") {
      const preset = ["kind", "month", "ext"].includes(url.searchParams.get("preset"))
        ? url.searchParams.get("preset")
        : "kind";
      const plan = store.planOrganize(preset, { olderThanDays: Number(url.searchParams.get("olderThanDays")) || 0 });
      return sendJson(res, 200, {
        ok: true,
        ...plan,
        steps: plan.steps.map((s) => ({
          folder: s.folder,
          count: s.count,
          sample: s.ids
            .slice(0, 5)
            .map((id) => store.findFile(id)?.name)
            .filter(Boolean)
        }))
      });
    }

    if (rest === "/apply" && method === "POST") {
      const body = await readJsonBody(req);
      let steps = Array.isArray(body.steps) ? body.steps : null;
      if (!steps) {
        const plan = store.planOrganize(body.preset || "kind", { olderThanDays: Number(body.olderThanDays) || 0 });
        steps = plan.steps;
      }
      const applied = await store.applyPlan(steps, { createdBy: "WorkBuddy Skill" });
      const moved = applied.reduce((sum, a) => sum + a.moved, 0);
      if (moved) {
        await store.log({
          type: "organize",
          fileId: null,
          fileName: `${moved} 个文件`,
          device: "WorkBuddy · Skill",
          detail: `按方案整理（${body.preset || "自定义"}）`
        });
      }
      return sendJson(res, 200, { ok: true, moved, applied });
    }

    if (rest === "/stats" && method === "GET") {
      const disk = await diskStats(config.storageDir);
      const byKind = new Map();
      for (const file of store.files) byKind.set(file.kind, (byKind.get(file.kind) || 0) + 1);
      return sendJson(res, 200, {
        ok: true,
        storage: { dir: config.storageDir, disk, ...store.stats() },
        byKind: Object.fromEntries(byKind),
        folders: store.listFolders()
      });
    }

    if (rest === "/preview" && method === "GET") {
      const file = store.findFile(url.searchParams.get("id") || "");
      if (!file) return sendJson(res, 404, { error: "file_not_found" });
      const payload = await buildPreview(path.join(config.storageDir, file.name), file.name);
      // Agent 只需要文本，媒体类不回二进制
      const trimmed = { ...payload };
      if (payload.type === "text" && typeof payload.text === "string" && payload.text.length > 20000) {
        trimmed.text = payload.text.slice(0, 20000);
        trimmed.truncated = true;
      }
      return sendJson(res, 200, trimmed);
    }

    return sendJson(res, 404, { error: "unknown_capability", path: rest });
  }

  /* ----- admin / desktop API (local only) ----- */
  if (pathname === "/api/state" && method === "GET") {
    if (!localOnly(req, res)) return;
    return sendJson(res, 200, await buildState(req));
  }

  if (pathname === "/api/events" && method === "GET") {
    if (!localOnly(req, res)) return;
    return openSse(req, res);
  }

  /* ----- 预览 ----- */
  const previewMatch = /^\/api\/files\/([^/]+)\/preview$/.exec(pathname);
  if (previewMatch && method === "GET") {
    if (!localOnly(req, res)) return;
    const file = store.findFile(previewMatch[1]);
    if (!file) return sendJson(res, 404, { error: "file_not_found", message: "文件不存在" });
    try {
      return sendJson(res, 200, await buildPreview(path.join(config.storageDir, file.name), file.name));
    } catch (err) {
      return sendJson(res, 500, { error: "preview_failed", message: err.message || "预览失败" });
    }
  }

  const rawMatch = /^\/api\/files\/([^/]+)\/raw$/.exec(pathname);
  if (rawMatch && (method === "GET" || method === "HEAD")) {
    if (!localOnly(req, res)) return;
    const file = store.findFile(rawMatch[1]);
    if (!file) return sendJson(res, 404, { error: "file_not_found" });
    return sendFileStream(req, res, file, { inline: true, cache: "private, max-age=60" });
  }

  const openFileMatch = /^\/api\/open-file\/([^/]+)$/.exec(pathname);
  if (openFileMatch && method === "POST") {
    if (!localOnly(req, res)) return;
    const file = store.findFile(openFileMatch[1]);
    if (!file) return sendJson(res, 404, { error: "file_not_found" });
    const full = path.join(config.storageDir, file.name);
    if (!fs.existsSync(full)) return sendJson(res, 404, { error: "file_missing", message: "文件已不在磁盘上" });
    openPathInSystem(full);
    return sendJson(res, 200, { ok: true });
  }

  /* ----- 文件夹 ----- */
  if (pathname === "/api/folders" && method === "GET") {
    if (!localOnly(req, res)) return;
    await store.refresh();
    return sendJson(res, 200, { ok: true, folders: store.listFolders() });
  }

  if (pathname === "/api/folders" && method === "POST") {
    if (!localOnly(req, res)) return;
    const body = await readJsonBody(req);
    const name = sanitizeName(String(body.name || "")).slice(0, 60);
    if (!name) return sendJson(res, 400, { error: "bad_name", message: "文件夹名不能为空" });
    const parentId = body.parentId || null;
    if (parentId && !store.findFolder(parentId)) {
      return sendJson(res, 404, { error: "parent_not_found", message: "上一级文件夹不存在" });
    }
    const dup = store.folders.find((f) => f.parentId === (parentId || null) && f.name === name);
    if (dup) return sendJson(res, 409, { error: "folder_exists", message: "同一级已经有同名文件夹" });
    const folder = await store.ensureFolderPath(parentId ? `${store.findFolder(parentId).name}/${name}` : name);
    return sendJson(res, 201, { ok: true, folder });
  }

  const folderMatch = /^\/api\/folders\/([^/]+)$/.exec(pathname);
  if (folderMatch && method === "PATCH") {
    if (!localOnly(req, res)) return;
    const body = await readJsonBody(req);
    const folder = await store.renameFolder(folderMatch[1], String(body.name || ""));
    if (!folder) return sendJson(res, 400, { error: "bad_name", message: "文件夹不存在或名字为空" });
    return sendJson(res, 200, { ok: true, folder });
  }

  if (folderMatch && method === "DELETE") {
    if (!localOnly(req, res)) return;
    const result = await store.deleteFolder(folderMatch[1]);
    if (!result) return sendJson(res, 404, { error: "folder_not_found" });
    return sendJson(res, 200, { ok: true, moved: result.moved });
  }

  /* ----- 批量移动 / 打标签 ----- */
  if (pathname === "/api/files/move" && method === "POST") {
    if (!localOnly(req, res)) return;
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) return sendJson(res, 400, { error: "no_ids", message: "没有选择文件" });
    const folderId = body.folderId || null;
    const result = await store.moveFiles(ids, folderId);
    if (result.missing) return sendJson(res, 404, { error: "folder_not_found" });
    return sendJson(res, 200, { ok: true, moved: result.moved });
  }

  if (pathname === "/api/files/tags" && method === "POST") {
    if (!localOnly(req, res)) return;
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    if (!ids.length) return sendJson(res, 400, { error: "no_ids" });
    const result = await store.setTags(ids, { add: body.add, remove: body.remove });
    return sendJson(res, 200, { ok: true, changed: result.changed });
  }

  /* ----- 搜索 ----- */
  if (pathname === "/api/search" && method === "GET") {
    if (!localOnly(req, res)) return;
    await store.refresh();
    const list = store.search(url.searchParams.get("q") || "", {
      folderId: url.searchParams.has("folder") ? url.searchParams.get("folder") : undefined,
      kind: url.searchParams.get("kind") || undefined,
      tag: url.searchParams.get("tag") || undefined,
      limit: Number(url.searchParams.get("limit")) || 200
    });
    return sendJson(res, 200, { ok: true, total: list.length, files: list.map((f) => publicFile(f)) });
  }

  /* ----- 目录浏览（换存储位置用） ----- */
  if (pathname === "/api/fs/list" && method === "GET") {
    if (!localOnly(req, res)) return;
    return sendJson(res, 200, await listDirectories(url.searchParams.get("path")));
  }

  if (pathname === "/api/fs/mkdir" && method === "POST") {
    if (!localOnly(req, res)) return;
    const body = await readJsonBody(req);
    const base = path.resolve(String(body.path || config.storageDir));
    const name = sanitizeName(String(body.name || "")).slice(0, 60);
    if (!name) return sendJson(res, 400, { error: "bad_name", message: "文件夹名不能为空" });
    const target = path.join(base, name);
    try {
      ensureDir(target);
    } catch {
      return sendJson(res, 400, { error: "mkdir_failed", message: "创建失败，可能是权限不足" });
    }
    return sendJson(res, 201, { ok: true, path: target });
  }

  if (pathname === "/api/upload" && (method === "PUT" || method === "POST")) {
    if (!localOnly(req, res)) return;
    const received = await receiveUpload(req, { tmpDir: store.tmpDir, maxBytes: MAX_BYTES });
    const file = await store.commitUpload({
      tempPath: received.tempPath,
      name: filenameFromRequest(req, url),
      size: received.size,
      mtimeMs: received.mtimeMs,
      source: "本机",
      via: "电脑上传"
    });
    broadcast({ type: "upload", file: publicFile(file) });
    return sendJson(res, 201, { ok: true, file: publicFile(file) });
  }

  const fileDownload = /^\/api\/files\/([^/]+)\/download$/.exec(pathname);
  if (fileDownload && (method === "GET" || method === "HEAD")) {
    if (!localOnly(req, res)) return;
    const file = store.findFile(fileDownload[1]);
    if (!file) return sendJson(res, 404, { error: "file_not_found" });
    return sendFileStream(req, res, file);
  }

  const fileDelete = /^\/api\/files\/([^/]+)$/.exec(pathname);
  if (fileDelete && method === "DELETE") {
    if (!localOnly(req, res)) return;
    const removed = await store.deleteFile(fileDelete[1]);
    if (!removed) return sendJson(res, 404, { error: "file_not_found" });
    return sendJson(res, 200, { ok: true, file: removed });
  }

  if (pathname === "/api/shares" && method === "POST") {
    if (!localOnly(req, res)) return;
    const body = await readJsonBody(req);
    if (body.perm === "write" && !config.allowWriteShares) {
      return sendJson(res, 403, { error: "write_disabled", message: "已关闭「允许同事写入」" });
    }
    const share = await store.createShare({
      fileId: body.fileId,
      perm: body.perm,
      expiry: body.expiry,
      note: body.note
    });
    if (!share) return sendJson(res, 404, { error: "file_not_found" });
    return sendJson(res, 201, { ok: true, share: { ...store.enrichShare(share), link: shareLink(share.id) } });
  }

  const shareDelete = /^\/api\/shares\/([A-Za-z0-9]+)$/.exec(pathname);
  if (shareDelete && method === "DELETE") {
    if (!localOnly(req, res)) return;
    const share = await store.revokeShare(shareDelete[1]);
    if (!share) return sendJson(res, 404, { error: "share_not_found" });
    return sendJson(res, 200, { ok: true, share });
  }

  /* ----- 分享盘：管理员（本机控制台） ----- */

  function driveAdminState() {
    const drive = store.driveInfo();
    return {
      ...drive,
      url: `${lanOrigin()}/d/${drive.token}`,
      qrUrl: `/qr.svg?data=${encodeURIComponent(`${lanOrigin()}/d/${drive.token}`)}`,
      files: drive.fileIds
        .map((id) => store.findFile(id))
        .filter(Boolean)
        .map((f) => publicFile(f))
    };
  }

  if (pathname === "/api/drive" && method === "GET") {
    if (!localOnly(req, res)) return;
    return sendJson(res, 200, { ok: true, drive: driveAdminState() });
  }

  if (pathname === "/api/drive" && method === "POST") {
    if (!localOnly(req, res)) return;
    const body = await readJsonBody(req);
    let drive = await store.updateDrive(body);
    if (body.rotate) drive = await store.rotateDriveToken();
    return sendJson(res, 200, { ok: true, drive: driveAdminState() });
  }

  if (pathname === "/api/drive/files" && method === "POST") {
    if (!localOnly(req, res)) return;
    const body = await readJsonBody(req);
    const result = await store.driveAddFiles(body.ids || []);
    return sendJson(res, 200, { ok: true, added: result.added, drive: driveAdminState() });
  }

  const driveFileDelete = /^\/api\/drive\/files\/([A-Za-z0-9-]+)$/.exec(pathname);
  if (driveFileDelete && method === "DELETE") {
    if (!localOnly(req, res)) return;
    await store.driveRemoveFile(driveFileDelete[1]);
    return sendJson(res, 200, { ok: true, drive: driveAdminState() });
  }

  if (pathname === "/api/drive/pickup" && method === "POST") {
    if (!localOnly(req, res)) return;
    const body = await readJsonBody(req).catch(() => ({}));
    const result = await store.drivePickup(body.ids || null);
    return sendJson(res, 200, { ok: true, ...result, drive: driveAdminState() });
  }

  const drivePendingDelete = /^\/api\/pending\/([A-Za-z0-9-]+)$/.exec(pathname);
  if (drivePendingDelete && method === "DELETE") {
    if (!localOnly(req, res)) return;
    const removed = await store.driveDiscardPending(drivePendingDelete[1]);
    if (!removed) return sendJson(res, 404, { error: "pending_not_found" });
    return sendJson(res, 200, { ok: true, drive: driveAdminState() });
  }

  /* ----- 分享盘：访客（凭 token） ----- */

  const driveTokenMatch = /^\/api\/drive\/([A-Za-z0-9]+)(\/.*)?$/.exec(pathname);
  if (driveTokenMatch) {
    const token = driveTokenMatch[1];
    if (token !== store.drive.token) {
      return sendJson(res, 404, { error: "drive_not_found", message: "分享盘不存在，可能已被重置。" });
    }
    const rest = driveTokenMatch[2] || "";

    if (rest === "/info" && method === "GET") {
      const drive = store.drive;
      const files = drive.enabled && drive.allowBrowse
        ? drive.fileIds
            .map((id) => store.findFile(id))
            .filter(Boolean)
            .map((f) => ({
              id: f.id,
              name: f.name,
              size: f.size,
              kind: f.kind,
              ext: f.ext,
              createdAt: f.createdAt,
              downloadUrl: `/api/drive/${token}/files/${f.id}/download`,
              rawUrl: `/api/drive/${token}/files/${f.id}/download?inline=1`,
              previewUrl: `/api/drive/${token}/files/${f.id}/preview`
            }))
        : [];
      return sendJson(res, 200, {
        ok: true,
        drive: {
          enabled: drive.enabled,
          name: drive.enabled ? drive.name : "",
          note: drive.enabled ? drive.note : "",
          allowUpload: drive.enabled && drive.allowUpload,
          allowBrowse: drive.enabled && drive.allowBrowse
        },
        host: { name: config.deviceName },
        files
      });
    }

    if (!store.drive.enabled) {
      return sendJson(res, 410, { error: "drive_disabled", message: "分享盘已关闭。" });
    }

    if (rest === "/upload" && (method === "PUT" || method === "POST")) {
      if (!store.drive.allowUpload) {
        return sendJson(res, 403, { error: "upload_disabled", message: "这个分享盘不接收上传。" });
      }
      const received = await receiveUpload(req, { tmpDir: store.tmpDir, maxBytes: MAX_BYTES });
      const item = await store.driveSubmitUpload({
        tempPath: received.tempPath,
        name: filenameFromRequest(req, url),
        size: received.size,
        from: `访客 ${clientIp(req)}`
      });
      return sendJson(res, 201, { ok: true, item: { id: item.id, name: item.name, size: item.size } });
    }

    const driveDownload = /^\/files\/([A-Za-z0-9-]+)\/download$/.exec(rest || "");
    if (driveDownload && (method === "GET" || method === "HEAD")) {
      const file = store.findFile(driveDownload[1]);
      if (!file || !store.driveHasFile(file.id)) {
        return sendJson(res, 404, { error: "file_not_found", message: "文件不在分享盘里" });
      }
      return sendFileStream(req, res, file, { inline: url.searchParams.get("inline") === "1" });
    }

    const drivePreview = /^\/files\/([A-Za-z0-9-]+)\/preview$/.exec(rest || "");
    if (drivePreview && method === "GET") {
      if (!store.drive.allowBrowse) {
        return sendJson(res, 403, { error: "browse_disabled", message: "这个分享盘不允许查看内容。" });
      }
      const file = store.findFile(drivePreview[1]);
      if (!file || !store.driveHasFile(file.id)) {
        return sendJson(res, 404, { error: "file_not_found", message: "文件不在分享盘里" });
      }
      try {
        return sendJson(res, 200, await buildPreview(path.join(config.storageDir, file.name), file.name));
      } catch (err) {
        return sendJson(res, 500, { error: "preview_failed", message: err.message || "预览失败" });
      }
    }
  }

  if (pathname === "/api/pair/rotate" && method === "POST") {
    if (!localOnly(req, res)) return;
    await store.rotatePairing();
    writeConfig(config);
    return sendJson(res, 200, { ok: true, pairing: pairingInfo() });
  }

  if (pathname === "/api/send" && method === "POST") {
    if (!localOnly(req, res)) return;
    const body = await readJsonBody(req);
    await store.refresh();
    const file = store.findFile(body.fileId);
    if (!file) return sendJson(res, 404, { error: "file_not_found", message: "文件不存在" });
    const target = store.listDevices().find((d) => d.id === body.deviceId);
    if (!target) return sendJson(res, 404, { error: "device_not_found", message: "设备不存在或已被移除" });
    // 网页版（/w/<token>）与 App 版（/app）都通过 SSE 实时收推送，只要页面开着就能收到
    const item = await store.pushFile({ deviceId: target.id, fileId: file.id, senderName: target.name });
    broadcast({ type: "inbox", kind: "inbox", deviceId: target.id, item });
    return sendJson(res, 200, { ok: true, item, channel: target.kind === "app" ? "app" : "web" });
  }

  const deviceDelete = /^\/api\/devices\/([^/]+)$/.exec(pathname);
  if (deviceDelete && method === "DELETE") {
    if (!localOnly(req, res)) return;
    const device = await store.removeDevice(deviceDelete[1]);
    if (!device) return sendJson(res, 404, { error: "device_not_found" });
    return sendJson(res, 200, { ok: true });
  }

  // 桌面 App 的 WebView 不会处理 target="_blank"，页面上"打开手机网页版"这类入口
  // 改由这里转交系统默认浏览器。只放行本机地址，避免变成任意 URL 的启动器。
  if (pathname === "/api/open-external" && method === "POST") {
    if (!localOnly(req, res)) return;
    const body = await readJsonBody(req);
    let target;
    try {
      target = new URL(String(body.url || ""));
    } catch {
      return sendJson(res, 400, { error: "bad_url", message: "地址无效" });
    }
    // 只放行"本机或局域网内的 http(s) 页面"：这个接口只给桌面壳用，
    // 不能让它变成打开任意公网地址、file:// 或 javascript: 的缺口。
    const host = target.hostname;
    const allowed =
      (target.protocol === "http:" || target.protocol === "https:") &&
      (host === "localhost" || net.isPrivateIPv4(host) || net.localAddresses().has(host));
    if (!allowed) {
      return sendJson(res, 403, { error: "forbidden", message: "只允许打开本机或局域网页面" });
    }
    openInBrowser(target.href);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === "/api/settings" && method === "POST") {
    if (!localOnly(req, res)) return;
    const body = await readJsonBody(req);
    let restartRequired = false;
    let migration = null;
    if (typeof body.storageDir === "string") {
      const dir = path.resolve(body.storageDir.trim());
      if (!path.isAbsolute(dir)) return sendJson(res, 400, { error: "bad_path", message: "请填写绝对路径" });
      try {
        ensureDir(dir);
        await fsp.access(dir, fs.constants.W_OK);
      } catch {
        return sendJson(res, 400, { error: "bad_path", message: "目录不可写，请换一个位置" });
      }
      if (dir !== config.storageDir) {
        if (body.migrate === true) {
          migration = await migrateStorage(config.storageDir, dir);
        }
        config.storageDir = dir;
        store.storageDir = dir;
        await store.refresh({ force: true });
      }
    }
    if (body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        return sendJson(res, 400, { error: "bad_port", message: "端口需在 1024–65535 之间" });
      }
      if (port !== config.port) {
        config.pendingPort = port;
        restartRequired = true;
      }
    }
    for (const key of ["lanOnly", "allowWriteShares", "notifyOnUpload", "keepAwake", "autoStart"]) {
      if (typeof body[key] === "boolean") config[key] = body[key];
    }
    if (body.rotateSkillToken === true) config.skillToken = randomToken(20);
    writeConfig(config);
    return sendJson(res, 200, {
      ok: true,
      restartRequired,
      migration,
      pendingPort: config.pendingPort || null,
      skillToken: config.skillToken,
      settings: {
        storageDir: config.storageDir,
        port: config.pendingPort || config.port,
        lanOnly: config.lanOnly,
        allowWriteShares: config.allowWriteShares,
        notifyOnUpload: config.notifyOnUpload,
        keepAwake: config.keepAwake,
        autoStart: config.autoStart,
        maxUploadGB: config.maxUploadGB
      }
    });
  }

  return sendJson(res, 404, { error: "not_found", path: pathname });
}

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  await store.init();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.destroyed || res.writableEnded) return;
      const status = err.status || 500;
      if (status >= 500) console.error("[LanDrop]", err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, status, {
        error: status === 500 ? "internal_error" : "request_failed",
        message: err.message || "请求失败"
      });
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60 * 1000;

  const port = config.port;
  server.listen(port, "0.0.0.0", () => {
    const lan = net.localIPv4();
    const session = store.sessionPayload();
    console.log("");
    console.log("  LanDrop 已启动");
    console.log("  ─────────────────────────────────────────");
    console.log(`  控制台      http://localhost:${port}`);
    console.log(`  手机网页版  http://${lan.address}:${port}/w/${session.token}`);
    console.log(`  配对码      ${session.code.slice(0, 3)} ${session.code.slice(3)}`);
    console.log(`  存储目录    ${config.storageDir}`);
    console.log("  ─────────────────────────────────────────");
    console.log("  按 Ctrl+C 停止服务");
    console.log("");
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`端口 ${port} 已被占用。用 --port 指定其它端口，或修改 data/config.json。`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });

  const shutdown = () => {
    console.log("\n正在关闭 LanDrop…");
    for (const client of sseClients) {
      try { client.end(); } catch { /* ignore */ }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // 桌面端用管道连着 App：App 正常退出或被强杀，管道都会关闭，
  // 后端据此自行收尾，不会留下占着端口的孤儿进程。
  if (process.env.LANDROP_DESKTOP === "1") {
    process.stdin.resume();
    process.stdin.on("end", shutdown);
    process.stdin.on("close", shutdown);
    process.stdin.on("error", shutdown);
  }
}

main().catch((err) => {
  console.error("LanDrop 启动失败：", err);
  process.exit(1);
});
