"use strict";

/**
 * 把 skill/ 目录打包成 dist/landrop-skill.zip，方便拷给别的 WorkBuddy。
 *
 *   npm run skill:pack
 *
 * 与服务端「设置 - 下载 Skill 包」走的是同一套 zip 实现，零依赖。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { writeZip } = require("../server/zip");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "skill");
const OUT_DIR = path.join(ROOT, "dist");
const OUT = path.join(OUT_DIR, "landrop-skill.zip");

async function collect(dir, prefix = "") {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(full, rel)));
    else if (entry.isFile()) files.push({ name: rel, data: await fsp.readFile(full) });
  }
  return files;
}

(async () => {
  if (!fs.existsSync(SRC)) {
    console.error("找不到 skill 目录");
    process.exit(1);
  }
  const files = await collect(SRC);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const buf = writeZip(files);
  await fsp.writeFile(OUT, buf);
  console.log(`已打包 ${files.length} 个文件 -> ${path.relative(ROOT, OUT)}（${(buf.length / 1024).toFixed(1)} KB）`);
  for (const file of files) console.log(`  ${file.name}`);
})();
