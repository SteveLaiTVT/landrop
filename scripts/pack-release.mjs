/**
 * 把待分发的东西打成一个 zip：安装包 + 安装说明 + 哈希。
 * 微信/邮件里直接传 exe 常被拦，zip 更稳。
 *
 *   npm run release:pack
 */
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { writeZip } = require(path.join(ROOT, "server", "zip.js"));

const RELEASE = path.join(ROOT, "dist", "release");
const OUT = path.join(ROOT, "dist", "LanDrop-1.0.0-发布包.zip");

const entries = [
  "LanDrop-Setup-1.0.0-x64.exe",
  "给同事看的说明.txt",
  "SHA256.txt"
];

const files = [];
for (const name of entries) {
  const full = path.join(RELEASE, name);
  const info = await stat(full).catch(() => null);
  if (!info) {
    console.error(`缺少文件：${full}\n先跑 npm run app:build，再把产物拷到 dist/release/`);
    process.exit(1);
  }
  files.push({ name, data: await readFile(full) });
}

await mkdir(path.dirname(OUT), { recursive: true });
const buf = writeZip(files);
await writeFile(OUT, buf);

const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MB";
console.log(`已打包 ${files.length} 个文件 -> ${path.relative(ROOT, OUT)}（${mb(buf.length)}）`);
for (const f of files) console.log(`  ${f.name}  ${mb(f.data.length)}`);
