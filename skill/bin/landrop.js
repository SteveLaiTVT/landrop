#!/usr/bin/env node
"use strict";

/**
 * LanDrop Skill 命令行工具。零依赖，Node >= 18。
 *
 *   node bin/landrop.js stats
 *   node bin/landrop.js search "季度"
 *   node bin/landrop.js plan --preset kind
 *   node bin/landrop.js apply --preset kind
 *
 * 地址与令牌按以下顺序解析：命令行参数 > 环境变量 > ~/.landrop/skill.json > 本机默认端口。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULTS = ["http://127.0.0.1:17800", "http://127.0.0.1:8080"];

function readConfigFile() {
  const file = path.join(os.homedir(), ".landrop", "skill.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

async function resolveBase(explicit) {
  if (explicit) return explicit.replace(/\/$/, "");
  const cfg = readConfigFile();
  if (process.env.LANDROP_URL) return process.env.LANDROP_URL.replace(/\/$/, "");
  if (cfg.url) return cfg.url.replace(/\/$/, "");
  for (const base of DEFAULTS) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(900) });
      if (res.ok) return base;
    } catch {
      /* 试下一个 */
    }
  }
  return DEFAULTS[0];
}

function resolveToken(explicit) {
  if (explicit) return explicit;
  if (process.env.LANDROP_TOKEN) return process.env.LANDROP_TOKEN;
  const cfg = readConfigFile();
  return cfg.token || "";
}

function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function printTable(rows, columns) {
  const widths = columns.map((col) => Math.max(col.label.length, ...rows.map((r) => String(col.get(r) ?? "").length)));
  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join("  ");
  console.log(line(columns.map((c) => c.label)));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const row of rows) console.log(line(columns.map((c) => c.get(row) ?? "")));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const base = await resolveBase(args.url || args.base);
  const token = resolveToken(args.token);
  const json = Boolean(args.json);

  async function call(method, pathname, body) {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + pathname, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = payload.message || payload.error || `HTTP ${res.status}`;
      throw new Error(message);
    }
    return payload;
  }

  const qs = (params) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "" && value !== false) search.set(key, value);
    }
    const str = search.toString();
    return str ? `?${str}` : "";
  };

  if (!command || command === "help" || command === "-h" || command === "--help") {
    console.log(`LanDrop Skill CLI

用法：node bin/landrop.js <命令> [选项]

  stats                       库的概况：文件数、占用、按类型分布
  search <关键词>             搜索文件（--kind sheet --folder 表格 --tag 待报销）
  folders                     列出文件夹
  mkdir <名字或路径>          新建文件夹，可用 "归档/2026-10" 建多级
  move                        移动文件：--query 关键词 或 --id a,b + --folder 目标
  tag                         打标签：--query 关键词 或 --id a,b + --add 标签1,标签2
  rename --id <id> --name <新名字>
  plan [--preset kind|month|ext] [--older-than 天数]
  apply [--preset kind|month|ext] [--older-than 天数]
  preview --id <id>           抽取文本内容（Office 也能抽）

全局选项：--url http://127.0.0.1:17800  --token <skillToken>  --json`);
    return;
  }

  if (command === "stats") {
    const data = await call("GET", "/api/skill/stats");
    if (json) return console.log(JSON.stringify(data, null, 2));
    console.log(`存储目录：${data.storage.dir}`);
    console.log(`文件 ${data.storage.count} 个 · 占用 ${humanSize(data.storage.totalSize)} · 文件夹 ${data.storage.folders} 个`);
    console.log(`磁盘：已用 ${humanSize(data.storage.disk.used)} / 共 ${humanSize(data.storage.disk.total)}`);
    const kinds = Object.entries(data.byKind || {});
    if (kinds.length) console.log("按类型：" + kinds.map(([k, v]) => `${k} ${v}`).join(" · "));
    return;
  }

  if (command === "search") {
    const q = args._.slice(1).join(" ");
    const data = await call("GET", `/api/skill/files${qs({ q, kind: args.kind, folder: args.folder, tag: args.tag, limit: args.limit })}`);
    if (json) return console.log(JSON.stringify(data, null, 2));
    if (!data.files.length) return console.log("没有匹配的文件");
    printTable(data.files, [
      { label: "名称", get: (f) => f.name },
      { label: "大小", get: (f) => humanSize(f.size) },
      { label: "来源", get: (f) => f.source || "-" },
      { label: "标签", get: (f) => (f.tags || []).join(",") || "-" },
      { label: "id", get: (f) => f.id.slice(0, 8) }
    ]);
    console.log(`\n共 ${data.total} 个`);
    return;
  }

  if (command === "folders") {
    const data = await call("GET", "/api/skill/folders");
    if (json) return console.log(JSON.stringify(data, null, 2));
    if (!data.folders.length) return console.log("还没有文件夹");
    for (const folder of data.folders) console.log(`${folder.name}  ${folder.count} 个  ${folder.id.slice(0, 8)}`);
    return;
  }

  if (command === "mkdir") {
    const name = args._.slice(1).join(" ");
    if (!name) throw new Error("需要文件夹名字");
    const data = await call("POST", "/api/skill/folders", { path: name });
    console.log(`已创建：${data.folder.name}`);
    return;
  }

  if (command === "move") {
    const folder = args.folder;
    if (!folder) throw new Error("需要 --folder 目标文件夹");
    const ids = args.id ? String(args.id).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const query = args.query || (args._.slice(1).join(" ") || undefined);
    if (!ids && !query) throw new Error("需要 --id 或 --query 指定要移动的文件");
    const data = await call("POST", "/api/skill/move", { ids, query, folder });
    console.log(`已移动 ${data.moved} 个文件到「${data.folder.name}」`);
    return;
  }

  if (command === "tag") {
    const ids = args.id ? String(args.id).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const query = args.query || (args._.slice(1).join(" ") || undefined);
    if (!ids && !query) throw new Error("需要 --id 或 --query");
    const add = args.add ? String(args.add).split(",") : [];
    const remove = args.remove ? String(args.remove).split(",") : [];
    if (!add.length && !remove.length) throw new Error("需要 --add 或 --remove");
    let targets = ids;
    if (!targets) {
      const found = await call("GET", `/api/skill/files${qs({ q: query, limit: 500 })}`);
      targets = found.files.map((f) => f.id);
    }
    const data = await call("POST", "/api/skill/tags", { ids: targets, add, remove });
    console.log(`已更新 ${data.changed} 个文件的标签`);
    return;
  }

  if (command === "rename") {
    if (!args.id || !args.name) throw new Error("需要 --id 和 --name");
    const data = await call("POST", "/api/skill/rename", { id: args.id, name: args.name });
    console.log(`已重命名为：${data.file.name}`);
    return;
  }

  if (command === "plan") {
    const data = await call("GET", `/api/skill/plan${qs({ preset: args.preset || "kind", olderThanDays: args["older-than"] })}`);
    if (json) return console.log(JSON.stringify(data, null, 2));
    if (!data.steps.length) return console.log("没有需要整理的文件");
    for (const step of data.steps) {
      console.log(`${step.folder}  ${step.count} 个` + (step.sample.length ? `  例：${step.sample.join("、")}` : ""));
    }
    console.log(`\n共 ${data.total} 个文件会被移动（这只是方案，还没动文件）`);
    return;
  }

  if (command === "apply") {
    const body = { preset: args.preset || "kind" };
    if (args["older-than"]) body.olderThanDays = Number(args["older-than"]);
    const data = await call("POST", "/api/skill/apply", body);
    console.log(`已整理 ${data.moved} 个文件`);
    for (const step of data.applied) console.log(`  ${step.folder}: ${step.moved}`);
    return;
  }

  if (command === "preview") {
    if (!args.id) throw new Error("需要 --id");
    const data = await call("GET", `/api/skill/preview${qs({ id: args.id })}`);
    if (json) return console.log(JSON.stringify(data, null, 2));
    if (data.type === "text") return console.log(data.text);
    if (data.type === "table") return console.log(data.rows.map((r) => r.join("\t")).join("\n"));
    if (data.type === "doc") return console.log(data.paragraphs.join("\n"));
    if (data.type === "slides") return console.log(data.slides.map((s) => `[第 ${s.index} 页]\n${s.lines.join("\n")}`).join("\n\n"));
    if (data.type === "archive") return console.log(data.entries.map((e) => `${e.name}\t${humanSize(e.size)}`).join("\n"));
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  throw new Error(`未知命令：${command}（node bin/landrop.js help 看用法）`);
}

main().catch((err) => {
  console.error(`失败：${err.message}`);
  process.exit(1);
});
