"use strict";

/**
 * 文件预览：把不同格式统一翻译成前端能渲染的结构。
 *
 * 图片 / 音视频 / PDF 交给浏览器原生能力（走 inline 流），这里只负责判定类型。
 * 文本、代码、Markdown、CSV 直接读文本；Office（docx/xlsx/pptx）用自带的 zip 读写把
 * XML 解出来抽文字；压缩包列目录。全部不引第三方依赖。
 */

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");

const { listZipEntries, readZipFile, readZipByPrefix } = require("./zip");

const TEXT_MAX = 512 * 1024; // 单文件最多读 512KB 文本
const TABLE_MAX_ROWS = 300;
const TABLE_MAX_COLS = 30;

const KIND_BY_EXT = new Map();
function reg(kind, exts) {
  for (const ext of exts) KIND_BY_EXT.set(ext, kind);
}

reg("image", ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "avif", "ico", "heic", "heif"]);
reg("video", ["mp4", "webm", "mov", "m4v", "mkv", "avi", "ogv"]);
reg("audio", ["mp3", "wav", "m4a", "aac", "ogg", "flac", "opus", "aiff"]);
reg("pdf", ["pdf"]);
reg("markdown", ["md", "markdown", "mdx"]);
reg("csv", ["csv", "tsv"]);
reg("text", ["txt", "log", "text"]);
reg("code", [
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "json", "jsonc", "html", "htm", "css", "scss", "less",
  "xml", "yml", "yaml", "toml", "ini", "conf", "sh", "bash", "ps1", "bat", "py", "rb", "go", "rs",
  "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sql", "lua", "dart", "vue", "svelte",
  "gitignore", "env", "lock", "gradle", "properties"
]);
reg("office-doc", ["docx", "odt", "pages"]);
reg("office-sheet", ["xlsx", "ods", "numbers"]);
reg("office-slide", ["pptx", "odp", "key"]);
reg("archive", ["zip", "jar", "apk", "epub", "docx~"]);

const LEGACY_OFFICE = new Set(["doc", "xls", "ppt"]);
const ARCHIVE_EXT = new Set(["zip", "jar", "apk", "epub"]);

/** 文件在预览器里应该用哪种方式呈现。 */
function previewKind(name) {
  const ext = (String(name).split(".").pop() || "").toLowerCase();
  if (LEGACY_OFFICE.has(ext)) return "legacy-office";
  const kind = KIND_BY_EXT.get(ext);
  if (kind === "archive" && !ARCHIVE_EXT.has(ext)) return "unknown";
  return kind || "unknown";
}

function extOf(name) {
  const idx = String(name).lastIndexOf(".");
  return idx > 0 ? String(name).slice(idx + 1).toLowerCase() : "";
}

function decodeText(buf) {
  if (buf.includes(0)) return null; // 含 NUL 视作二进制
  let text = buf.toString("utf8");
  // UTF-8 解码失败会带大量替换字符，退回 GBK-ish 的 latin 表达没有意义，直接标记乱码
  const bad = (text.match(/\uFFFD/g) || []).length;
  return { text, garble: bad > Math.max(8, text.length * 0.02) };
}

async function readTextFile(full, limit = TEXT_MAX) {
  const stat = await fsp.stat(full);
  const len = Math.min(stat.size, limit);
  const handle = await fsp.open(full, "r");
  try {
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, 0);
    const decoded = decodeText(buf);
    if (!decoded) return { kind: "binary", truncated: stat.size > len, size: stat.size };
    return {
      kind: "text",
      text: decoded.text,
      garble: decoded.garble,
      truncated: stat.size > len,
      size: stat.size
    };
  } finally {
    await handle.close();
  }
}

/* ---------------- Office ---------------- */

function xmlText(xml) {
  return String(xml)
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<w:br\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<a:br\/>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<[^>]+>/g, "");
}

function unescapeXml(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function docxPreview(buf) {
  const doc = readZipFile(buf, "word/document.xml");
  if (!doc) return { error: "这个 docx 里没有正文（word/document.xml）" };
  const body = xmlText(doc.toString("utf8"));
  const paragraphs = unescapeXml(body)
    .split("\n")
    .map((line) => line.replace(/\u0000/g, "").trimEnd())
    .filter((line, i, arr) => line.trim() || (i > 0 && arr[i - 1].trim()));
  return {
    type: "doc",
    paragraphs: paragraphs.slice(0, 2000),
    truncated: paragraphs.length > 2000
  };
}

function pptxPreview(buf) {
  const slides = readZipByPrefix(buf, "ppt/slides/slide", ".xml");
  if (!slides.length) return { error: "这个 pptx 里没有幻灯片" };
  const pages = slides.map((slide, index) => {
    const text = unescapeXml(xmlText(slide.data.toString("utf8")))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return { index: index + 1, lines: text.slice(0, 60) };
  });
  return { type: "slides", slides: pages.slice(0, 120), truncated: pages.length > 120 };
}

function xlsxPreview(buf) {
  const sharedRaw = readZipFile(buf, "xl/sharedStrings.xml");
  const shared = [];
  if (sharedRaw) {
    const xml = sharedRaw.toString("utf8");
    for (const block of xml.split(/<si[ >]/).slice(1)) {
      const texts = [...block.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => unescapeXml(m[1]));
      shared.push(texts.join(""));
    }
  }
  const sheet = readZipFile(buf, "xl/worksheets/sheet1.xml");
  if (!sheet) return { error: "这个 xlsx 里没有工作表" };
  const xml = sheet.toString("utf8");
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    if (rows.length >= TABLE_MAX_ROWS) break;
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2];
      const t = /t="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
      const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1];
      let value = inline !== undefined ? unescapeXml(inline) : unescapeXml(v);
      if (t === "s") value = shared[Number(v)] ?? "";
      cells.push(value);
      if (cells.length >= TABLE_MAX_COLS) break;
    }
    if (cells.some((c) => String(c).trim())) rows.push(cells);
  }
  return { type: "table", rows, truncated: rows.length >= TABLE_MAX_ROWS, sheet: "sheet1" };
}

/* ---------------- CSV ---------------- */

function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { row.push(cell); cell = ""; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; if (rows.length >= TABLE_MAX_ROWS) break; continue; }
    if (ch === "\r") continue;
    cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.slice(0, TABLE_MAX_ROWS).map((r) => r.slice(0, TABLE_MAX_COLS));
}

/* ---------------- archive ---------------- */

function archivePreview(buf) {
  const entries = listZipEntries(buf)
    .filter((e) => !e.isDir)
    .map((e) => ({ name: e.name, size: e.size }));
  const total = entries.reduce((sum, e) => sum + e.size, 0);
  return { type: "archive", entries: entries.slice(0, 500), count: entries.length, totalSize: total, truncated: entries.length > 500 };
}

/* ---------------- 主入口 ---------------- */

/**
 * @param {string} full 绝对路径
 * @param {string} name 文件名
 * @returns {Promise<object>} 预览载荷
 */
async function buildPreview(full, name) {
  const kind = previewKind(name);
  const stat = await fsp.stat(full);
  const base = { kind, size: stat.size, mtimeMs: stat.mtimeMs };

  if (kind === "image" || kind === "video" || kind === "audio" || kind === "pdf") {
    return { ...base, type: "media" };
  }

  if (kind === "legacy-office") {
    return { ...base, type: "unsupported", reason: "旧版 .doc/.xls/.ppt 是二进制格式，需要装 Office 或转成新格式才能抽取内容。" };
  }

  if (kind === "text" || kind === "code" || kind === "markdown") {
    const text = await readTextFile(full);
    if (text.kind === "binary") {
      return { ...base, type: "unsupported", reason: "这个文件看起来是二进制内容，没法当文本预览。" };
    }
    return { ...base, type: "text", text: text.text, truncated: text.truncated, garble: text.garble, ext: extOf(name) };
  }

  if (kind === "csv") {
    const text = await readTextFile(full, 4 * 1024 * 1024);
    if (text.kind === "binary") return { ...base, type: "unsupported", reason: "CSV 内容无法解析。" };
    const delimiter = extOf(name) === "tsv" ? "\t" : ",";
    const rows = parseDelimited(text.text, delimiter);
    return { ...base, type: "table", rows, truncated: text.truncated, delimiter };
  }

  if (kind === "office-doc" || kind === "office-sheet" || kind === "office-slide" || kind === "archive") {
    const buf = await fsp.readFile(full);
    if (kind === "office-doc") return { ...base, ...docxPreview(buf) };
    if (kind === "office-slide") return { ...base, ...pptxPreview(buf) };
    if (kind === "office-sheet") return { ...base, ...xlsxPreview(buf) };
    try {
      return { ...base, ...archivePreview(buf) };
    } catch {
      return { ...base, type: "unsupported", reason: "压缩包结构无法解析。" };
    }
  }

  return { ...base, type: "unsupported", reason: "这个格式暂时没有内嵌预览。" };
}

module.exports = { buildPreview, previewKind, extOf, readTextFile, parseDelimited, TEXT_MAX };
