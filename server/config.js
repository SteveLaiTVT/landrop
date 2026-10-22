"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const APP_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.LANDROP_DATA_DIR
  ? path.resolve(process.env.LANDROP_DATA_DIR)
  : path.join(APP_ROOT, "data");
// 打包成单文件可执行后 __dirname 不再指向项目根，改由宿主（Tauri）注入资源目录
const PUBLIC_DIR = process.env.LANDROP_PUBLIC_DIR
  ? path.resolve(process.env.LANDROP_PUBLIC_DIR)
  : path.join(APP_ROOT, "public");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

function platformLabel() {
  switch (process.platform) {
    case "darwin": return "Mac";
    case "win32": return "Windows";
    default: return "Linux";
  }
}

function defaultDeviceName() {
  let user = "我";
  try {
    user = os.userInfo().username || user;
  } catch {
    /* 某些容器环境拿不到 userInfo */
  }
  return `${user} 的 ${platformLabel()}`;
}

function randomCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function randomToken(size = 12) {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(size);
  let out = "";
  for (let i = 0; i < size; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function defaultConfig() {
  return {
    version: 1,
    port: Number(process.env.LANDROP_PORT) || 8080,
    storageDir: process.env.LANDROP_STORAGE_DIR
      ? path.resolve(process.env.LANDROP_STORAGE_DIR)
      : path.join(os.homedir(), "LanDrop"),
    deviceName: defaultDeviceName(),
    lanOnly: true,
    allowWriteShares: true,
    notifyOnUpload: true,
    keepAwake: false,
    autoStart: false,
    maxUploadGB: 8,
    pairCode: randomCode(),
    sessionToken: randomToken(10),
    // 给外部 WorkBuddy（Skill）用的长期令牌，和配对用的会话令牌分开，刷新配对码不会影响它
    skillToken: randomToken(20),
    sessionCreatedAt: new Date().toISOString(),
    sessionExpiresAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString()
  };
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadConfig() {
  ensureDir(DATA_DIR);
  const base = defaultConfig();
  if (!fs.existsSync(CONFIG_FILE)) {
    writeConfig(base);
    return base;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    const merged = { ...base, ...raw };
    merged.storageDir = path.resolve(merged.storageDir || base.storageDir);
    if (process.env.LANDROP_STORAGE_DIR) merged.storageDir = path.resolve(process.env.LANDROP_STORAGE_DIR);
    if (process.env.LANDROP_PORT) merged.port = Number(process.env.LANDROP_PORT);
    merged.maxUploadGB = Math.min(64, Math.max(1, Number(merged.maxUploadGB) || 8));
    merged.port = Math.min(65535, Math.max(1024, Number(merged.port) || 8080));
    if (!merged.sessionToken || !merged.pairCode) Object.assign(merged, base);
    // 老配置文件没有 skillToken，补一个并落盘，避免每次重启都变
    if (!merged.skillToken) {
      merged.skillToken = randomToken(20);
      writeConfig(merged);
    }
    return merged;
  } catch {
    writeConfig(base);
    return base;
  }
}

function writeConfig(config) {
  ensureDir(DATA_DIR);
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_FILE);
}

module.exports = {
  APP_ROOT,
  DATA_DIR,
  PUBLIC_DIR,
  CONFIG_FILE,
  ensureDir,
  loadConfig,
  writeConfig,
  randomCode,
  randomToken,
  defaultDeviceName
};
