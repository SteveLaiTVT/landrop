// 把 Node 后端压成一个不依赖系统 Node 的单文件可执行，作为 Tauri 的 sidecar。
// 输出：src-tauri/binaries/landrop-server-<target-triple>.exe

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD = path.join(ROOT, "build");
const TARGET = "x86_64-pc-windows-msvc";
const OUT_EXE = path.join(ROOT, "src-tauri", "binaries", `landrop-server-${TARGET}.exe`);
const FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function step(label) {
  process.stdout.write(`\n▸ ${label}\n`);
}

function findSigntool() {
  const kits = "C:/Program Files (x86)/Windows Kits/10/bin";
  if (!fs.existsSync(kits)) return null;
  for (const version of fs.readdirSync(kits).sort().reverse()) {
    const exe = path.join(kits, version, "x64", "signtool.exe");
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

step("打包服务端源码为单文件");
fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });

await build({
  entryPoints: [path.join(ROOT, "server", "index.js")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: path.join(BUILD, "server.cjs"),
  legalComments: "none",
  logLevel: "warning"
});
const bundleSize = fs.statSync(path.join(BUILD, "server.cjs")).size;
console.log(`  server.cjs  ${(bundleSize / 1024).toFixed(0)} KB`);

step("生成 SEA blob");
const seaConfig = path.join(BUILD, "sea-config.json");
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: path.join(BUILD, "server.cjs"),
      output: path.join(BUILD, "sea-prep.blob"),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false
    },
    null,
    2
  )
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], {
  stdio: "inherit"
});

step("复制 Node 运行时并注入 blob");
fs.mkdirSync(path.dirname(OUT_EXE), { recursive: true });
fs.copyFileSync(process.execPath, OUT_EXE);

// 官方 node.exe 带数字签名，注入前必须先剥掉，否则 postject 会拒绝写入
const signtool = findSigntool();
if (signtool) {
  try {
    execFileSync(signtool, ["remove", "/s", OUT_EXE], { stdio: "pipe" });
    console.log("  已移除原有数字签名");
  } catch {
    console.log("  跳过签名移除（可能本来就没有签名）");
  }
} else {
  console.log("  未找到 signtool，直接尝试注入");
}

execFileSync(
  process.execPath,
  [
    path.join(ROOT, "node_modules", "postject", "dist", "cli.js"),
    OUT_EXE,
    "NODE_SEA_BLOB",
    path.join(BUILD, "sea-prep.blob"),
    "--sentinel-fuse",
    FUSE
  ],
  { stdio: "inherit" }
);

const finalSize = fs.statSync(OUT_EXE).size;
step("完成");
console.log(`  ${path.relative(ROOT, OUT_EXE)}  ${(finalSize / 1024 / 1024).toFixed(1)} MB`);
