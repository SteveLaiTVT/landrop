"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * 以原始请求体（PUT）方式接收文件，直接落盘，不经过内存缓冲。
 * 这样无需 multipart 解析依赖，也能承载 GB 级文件。
 */
async function receiveUpload(req, { tmpDir, maxBytes }) {
  const declared = Number(req.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw httpError(413, `文件超过上限 ${(maxBytes / 1024 / 1024 / 1024).toFixed(0)} GB`);
  }
  const tempPath = path.join(tmpDir, `${crypto.randomUUID()}.part`);
  const out = fs.createWriteStream(tempPath, { flags: "wx" });
  let received = 0;
  let settled = false;

  try {
    await new Promise((resolve, reject) => {
      const fail = (err) => {
        if (settled) return;
        settled = true;
        out.destroy();
        req.unpipe?.(out);
        reject(err);
      };
      out.on("error", fail);
      req.on("aborted", () => fail(httpError(400, "上传已中断")));
      req.on("error", fail);
      req.on("data", (chunk) => {
        received += chunk.length;
        if (received > maxBytes) {
          req.pause();
          fail(httpError(413, "文件超过大小上限"));
          return;
        }
        if (!out.write(chunk)) {
          req.pause();
          out.once("drain", () => req.resume());
        }
      });
      req.on("end", () => {
        if (settled) return;
        out.end(() => {
          settled = true;
          resolve();
        });
      });
    });
    if (received === 0 && declared === 0) {
      throw httpError(400, "空文件");
    }
    const stat = await fsp.stat(tempPath);
    return { tempPath, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (err) {
    await fsp.unlink(tempPath).catch(() => {});
    throw err;
  }
}

function filenameFromRequest(req, url) {
  const queryName = url.searchParams.get("name");
  if (queryName) return queryName;
  const header = req.headers["x-file-name"];
  if (header) {
    try {
      return decodeURIComponent(String(header));
    } catch {
      return String(header);
    }
  }
  return "未命名文件";
}

module.exports = { receiveUpload, filenameFromRequest, httpError };
