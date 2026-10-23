// 一次性把版本号写进所有需要它的地方。
// package.json / package-lock.json / tauri.conf.json / Cargo.toml / server 里的 VERSION 常量
// 不一致会导致安装包版本、控制台显示、更新比较三处对不上。
//
// 用法：node scripts/set-version.mjs 1.0.1

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];

if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
  console.error("用法：node scripts/set-version.mjs 1.0.1");
  process.exit(1);
}

function writeJson(rel, mutate) {
  const file = path.join(ROOT, rel);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  mutate(data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

writeJson("package.json", (pkg) => {
  pkg.version = version;
});

writeJson("package-lock.json", (lock) => {
  lock.version = version;
  if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
});

writeJson("src-tauri/tauri.conf.json", (conf) => {
  conf.version = version;
});

const cargoFile = path.join(ROOT, "src-tauri", "Cargo.toml");
const cargo = fs.readFileSync(cargoFile, "utf8");
fs.writeFileSync(cargoFile, cargo.replace(/^version = "[^"]+"/m, `version = "${version}"`));

const serverFile = path.join(ROOT, "server", "index.js");
const server = fs.readFileSync(serverFile, "utf8");
fs.writeFileSync(
  serverFile,
  server.replace(/^const VERSION = "[^"]+";/m, `const VERSION = "${version}";`)
);

console.log(`版本号已统一为 ${version}`);
