"use strict";

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const { ensureDir, randomToken, randomCode } = require("./config");

const MAX_ACTIVITY = 200;
const MAX_INBOX = 60;
const ONLINE_WINDOW_MS = 90 * 1000;
const SESSION_TTL_MS = 24 * 3600 * 1000;

const KIND_BY_EXT = new Map();
function register(kind, exts) {
  for (const ext of exts) KIND_BY_EXT.set(ext, kind);
}
register("img", ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tiff", "bmp", "svg", "avif"]);
register("pdf", ["pdf"]);
register("zip", ["zip", "rar", "7z", "gz", "tar", "bz2", "xz"]);
register("sheet", ["xls", "xlsx", "csv", "numbers", "ods"]);
register("doc", ["doc", "docx", "ppt", "pptx", "txt", "md", "key", "pages", "dwg", "ai", "psd", "sketch", "fig"]);
register("audio", ["mp3", "wav", "m4a", "flac", "aac", "ogg", "aiff"]);
register("video", ["mp4", "mov", "mkv", "avi", "webm", "m4v"]);

function metaOfName(name) {
  const raw = String(name || "");
  const ext = (raw.split(".").pop() || "").toLowerCase();
  if (!ext || ext === raw.toLowerCase()) return { kind: "doc", ext: "FILE" };
  const label = ext.length > 4 ? ext.slice(0, 4) : ext;
  return { kind: KIND_BY_EXT.get(ext) || "doc", ext: label.toUpperCase() };
}

function sanitizeName(name) {
  let base = path.basename(String(name || "").replace(/\\/g, "/"));
  base = base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "").replace(/^\.+/, "").trim();
  if (!base) base = "未命名文件";
  if (base.length > 160) {
    const ext = path.extname(base).slice(0, 12);
    base = base.slice(0, 160 - ext.length) + ext;
  }
  return base;
}

function splitExt(name) {
  const ext = path.extname(name);
  return { stem: ext ? name.slice(0, -ext.length) : name, ext };
}

function deviceNameFromUA(ua) {
  const s = String(ua || "");
  if (/iPhone/i.test(s)) return "iPhone";
  if (/iPad/i.test(s)) return "iPad";
  if (/Android/i.test(s)) {
    const m = s.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build|\))/i);
    return m ? m[1].trim() : "Android 手机";
  }
  if (/Macintosh|Mac OS X/i.test(s)) return "Mac";
  if (/Windows/i.test(s)) return "Windows 电脑";
  return "浏览器设备";
}

function nowIso() {
  return new Date().toISOString();
}

class Store extends EventEmitter {
  constructor({ dataDir, storageDir, config }) {
    super();
    this.dataDir = dataDir;
    this.storageDir = storageDir;
    this.config = config;
    this.tmpDir = path.join(dataDir, "tmp");
    this.files = [];
    this.folders = [];
    this.shares = [];
    this.activity = [];
    this.devices = [];
    this.inbox = [];
    this.drive = null;
    this._lastScan = 0;
    this._scanPromise = null;
    this._writes = new Map();
  }

  get libraryFile() { return path.join(this.dataDir, "library.json"); }
  get foldersFile() { return path.join(this.dataDir, "folders.json"); }
  get sharesFile() { return path.join(this.dataDir, "shares.json"); }
  get activityFile() { return path.join(this.dataDir, "activity.json"); }
  get devicesFile() { return path.join(this.dataDir, "devices.json"); }
  get inboxFile() { return path.join(this.dataDir, "inbox.json"); }
  get driveFile() { return path.join(this.dataDir, "drive.json"); }
  get driveInboxDir() { return path.join(this.dataDir, "drive-inbox"); }

  async init() {
    ensureDir(this.dataDir);
    ensureDir(this.tmpDir);
    ensureDir(this.storageDir);
    const [library, shares, activity, devices, inbox, folders, drive] = await Promise.all([
      this._readJson(this.libraryFile, { files: [] }),
      this._readJson(this.sharesFile, { shares: [] }),
      this._readJson(this.activityFile, { items: [] }),
      this._readJson(this.devicesFile, { devices: [] }),
      this._readJson(this.inboxFile, { items: [] }),
      this._readJson(this.foldersFile, { folders: [] }),
      this._readJson(this.driveFile, { drive: null })
    ]);
    this.files = Array.isArray(library.data.files) ? library.data.files : [];
    this.folders = Array.isArray(folders.data.folders) ? folders.data.folders : [];
    for (const file of this.files) {
      if (file.folderId === undefined) file.folderId = null;
      if (!Array.isArray(file.tags)) file.tags = [];
    }
    this.shares = Array.isArray(shares.data.shares) ? shares.data.shares : [];
    this.activity = Array.isArray(activity.data.items) ? activity.data.items.slice(0, MAX_ACTIVITY) : [];
    this.devices = Array.isArray(devices.data.devices) ? devices.data.devices : [];
    this.inbox = Array.isArray(inbox.data.items) ? inbox.data.items.slice(0, MAX_INBOX) : [];
    this.drive = this._normalizeDrive(drive.data.drive);
    // 首次运行就把盘 token 落盘，别等第一次配置才写
    if (!drive.existed && !fs.existsSync(this.driveFile)) await this.saveDrive();
    for (const share of this.shares) {
      if (typeof share.downloads !== "number") share.downloads = 0;
    }
    await this.refresh({ force: true });
  }

  async _readJson(file, fallback) {
    try {
      const data = JSON.parse(await fsp.readFile(file, "utf8"));
      return { existed: true, data };
    } catch {
      return { existed: false, data: fallback };
    }
  }

  async _writeJson(file, value) {
    const previous = this._writes.get(file) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
      await fsp.rename(tmp, file);
    });
    this._writes.set(file, next);
    return next;
  }

  async saveLibrary() { await this._writeJson(this.libraryFile, { files: this.files }); }
  async saveFolders() { await this._writeJson(this.foldersFile, { folders: this.folders }); }
  async saveShares() { await this._writeJson(this.sharesFile, { shares: this.shares }); }
  async saveActivity() { await this._writeJson(this.activityFile, { items: this.activity.slice(0, MAX_ACTIVITY) }); }
  async saveDevices() { await this._writeJson(this.devicesFile, { devices: this.devices }); }
  async saveInbox() { await this._writeJson(this.inboxFile, { items: this.inbox.slice(0, MAX_INBOX) }); }
  async saveDrive() { await this._writeJson(this.driveFile, { drive: this.drive }); }

  /* ---------------- files ---------------- */

  async refresh({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - this._lastScan < 1200) return this.files;
    if (this._scanPromise) return this._scanPromise;
    this._scanPromise = (async () => {
      const entries = await fsp.readdir(this.storageDir, { withFileTypes: true }).catch(() => []);
      const byName = new Map(this.files.map((f) => [f.name, f]));
      const seen = new Set();
      const next = [];
      let changed = false;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith(".") || entry.name.endsWith(".part")) continue;
        const full = path.join(this.storageDir, entry.name);
        const stat = await fsp.stat(full).catch(() => null);
        if (!stat) continue;
        seen.add(entry.name);
        const known = byName.get(entry.name);
        if (known) {
          if (known.size !== stat.size || known.mtimeMs !== stat.mtimeMs) {
            known.size = stat.size;
            known.mtimeMs = stat.mtimeMs;
            changed = true;
          }
          next.push(known);
        } else {
          const meta = metaOfName(entry.name);
          next.push({
            id: crypto.randomUUID(),
            name: entry.name,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            createdAt: new Date(stat.mtimeMs).toISOString(),
            source: "本机",
            via: "放入目录",
            kind: meta.kind,
            ext: meta.ext,
            folderId: null,
            tags: []
          });
          changed = true;
        }
      }
      if (byName.size !== seen.size) changed = true;
      next.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      this.files = next;
      this._lastScan = Date.now();
      if (changed) {
        await this.saveLibrary();
        this.emit("change", { kind: "files" });
      }
      return this.files;
    })().finally(() => { this._scanPromise = null; });
    return this._scanPromise;
  }

  async uniqueName(name) {
    await this.refresh({ force: true });
    const taken = new Set(this.files.map((f) => f.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    const { stem, ext } = splitExt(name);
    for (let i = 1; i < 1000; i += 1) {
      const candidate = `${stem} (${i})${ext}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    return `${stem}-${Date.now()}${ext}`;
  }

  async commitUpload({ tempPath, name, size, source, via, mtimeMs }) {
    const safe = sanitizeName(name);
    const finalName = await this.uniqueName(safe);
    const dest = path.join(this.storageDir, finalName);
    try {
      await fsp.rename(tempPath, dest);
    } catch (err) {
      if (err.code === "EXDEV") {
        await fsp.copyFile(tempPath, dest);
        await fsp.unlink(tempPath).catch(() => {});
      } else {
        throw err;
      }
    }
    const meta = metaOfName(finalName);
    const file = {
      id: crypto.randomUUID(),
      name: finalName,
      size: Number(size) || (await fsp.stat(dest)).size,
      mtimeMs: Number(mtimeMs) || Date.now(),
      createdAt: nowIso(),
      source: source || "未知设备",
      via: via || "上传",
      kind: meta.kind,
      ext: meta.ext,
      folderId: null,
      tags: []
    };
    this.files.unshift(file);
    this._lastScan = 0;
    await this.saveLibrary();
    await this.log({
      type: "upload",
      fileId: file.id,
      fileName: file.name,
      device: `${file.source} · ${file.via}`,
      detail: "已保存到存储目录"
    });
    this.emit("change", { kind: "files", file });
    return file;
  }

  findFile(id) {
    return this.files.find((f) => f.id === id) || null;
  }

  /** 磁盘上真正的重命名（整理脚本会用到），成功返回更新后的文件。 */
  async renameFile(id, name) {
    await this.refresh({ force: true });
    const file = this.findFile(id);
    if (!file) return null;
    const safe = sanitizeName(name);
    if (!safe || safe === file.name) return file;
    const from = path.join(this.storageDir, file.name);
    const to = path.join(this.storageDir, safe);
    if (fs.existsSync(to)) return null;
    try {
      await fsp.rename(from, to);
    } catch {
      return null;
    }
    file.name = safe;
    const meta = metaOfName(safe);
    file.kind = meta.kind;
    file.ext = meta.ext;
    await this.saveLibrary();
    this.emit("change", { kind: "files" });
    return file;
  }

  async deleteFile(id) {
    await this.refresh({ force: true });
    const file = this.findFile(id);
    if (!file) return null;
    const full = path.join(this.storageDir, file.name);
    await fsp.unlink(full).catch(() => {});
    this.files = this.files.filter((f) => f.id !== id);
    const affected = this.shares.filter((s) => s.fileId === id && !s.revoked);
    for (const share of affected) share.revoked = true;
    await this.saveLibrary();
    await this.saveShares();
    await this.log({
      type: "delete",
      fileId: id,
      fileName: file.name,
      device: "本机 · 控制台",
      detail: "已从存储目录删除"
    });
    this.emit("change", { kind: "files" });
    this.emit("change", { kind: "shares" });
    return file;
  }

  /* ---------------- folders ---------------- */

  /** 文件夹是纯逻辑分组：磁盘上文件仍平铺在存储目录里，移动不碰字节。 */
  listFolders() {
    const counts = new Map();
    for (const file of this.files) {
      const key = file.folderId || null;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return this.folders.map((folder) => ({
      ...folder,
      count: counts.get(folder.id) || 0
    }));
  }

  findFolder(id) {
    return this.folders.find((f) => f.id === id) || null;
  }

  /** 允许 `归档/2026-10` 这种路径写法，逐级创建。 */
  async ensureFolderPath(rawPath, { createdBy = "本机" } = {}) {
    const parts = String(rawPath || "")
      .split("/")
      .map((p) => p.trim())
      .filter(Boolean);
    let parentId = null;
    let folder = null;
    for (const name of parts) {
      const safe = sanitizeName(name).slice(0, 60) || "未命名文件夹";
      folder = this.folders.find((f) => f.parentId === parentId && f.name === safe);
      if (!folder) {
        folder = {
          id: crypto.randomUUID(),
          name: safe,
          parentId,
          createdAt: nowIso(),
          createdBy
        };
        this.folders.push(folder);
      }
      parentId = folder.id;
    }
    await this.saveFolders();
    return folder;
  }

  async renameFolder(id, name) {
    const folder = this.findFolder(id);
    if (!folder) return null;
    const safe = sanitizeName(name).slice(0, 60);
    if (!safe) return null;
    folder.name = safe;
    await this.saveFolders();
    this.emit("change", { kind: "folders" });
    return folder;
  }

  /** 删文件夹不删文件：里面的文件回到上一级。 */
  async deleteFolder(id) {
    const folder = this.findFolder(id);
    if (!folder) return null;
    const parentId = folder.parentId || null;
    let moved = 0;
    for (const file of this.files) {
      if (file.folderId === id) {
        file.folderId = parentId;
        moved += 1;
      }
    }
    for (const child of this.folders) {
      if (child.parentId === id) child.parentId = parentId;
    }
    this.folders = this.folders.filter((f) => f.id !== id);
    await this.saveFolders();
    if (moved) await this.saveLibrary();
    this.emit("change", { kind: "folders" });
    if (moved) this.emit("change", { kind: "files" });
    return { folder, moved };
  }

  /** 批量移动；folderId 传 null 表示移回收件箱。 */
  async moveFiles(ids, folderId) {
    const target = folderId ? this.findFolder(folderId) : null;
    if (folderId && !target) return { moved: 0, missing: true };
    const wanted = new Set(ids);
    const movedFiles = [];
    for (const file of this.files) {
      if (!wanted.has(file.id)) continue;
      if ((file.folderId || null) === (folderId || null)) continue;
      file.folderId = folderId || null;
      movedFiles.push(file);
    }
    if (!movedFiles.length) return { moved: 0, files: [] };
    await this.saveLibrary();
    await this.log({
      type: "move",
      fileId: movedFiles[0].id,
      fileName: movedFiles.length === 1 ? movedFiles[0].name : `${movedFiles.length} 个文件`,
      device: "本机 · 控制台",
      detail: target ? `已移动到「${target.name}」` : "已移回收件箱"
    });
    this.emit("change", { kind: "files" });
    return { moved: movedFiles.length, files: movedFiles };
  }

  async setTags(ids, { add = [], remove = [] } = {}) {
    const wanted = new Set(ids);
    const addList = add.map((t) => String(t).trim()).filter(Boolean).slice(0, 12);
    const removeList = new Set(remove.map((t) => String(t).trim()).filter(Boolean));
    let changed = 0;
    for (const file of this.files) {
      if (!wanted.has(file.id)) continue;
      const tags = new Set(Array.isArray(file.tags) ? file.tags : []);
      for (const tag of addList) tags.add(tag);
      for (const tag of removeList) tags.delete(tag);
      const next = Array.from(tags).slice(0, 12);
      if (next.join("\u0000") !== (file.tags || []).join("\u0000")) {
        file.tags = next;
        changed += 1;
      }
    }
    if (!changed) return { changed: 0 };
    await this.saveLibrary();
    this.emit("change", { kind: "files" });
    return { changed };
  }

  /* ---------------- search / organize ---------------- */

  /** 搜索：文件名 / 来源 / 标签 / 所在文件夹名 / 扩展名。 */
  search(query, { folderId, kind, tag, limit = 200 } = {}) {
    const q = String(query || "").trim().toLowerCase();
    const terms = q ? q.split(/\s+/).filter(Boolean) : [];
    const folderNames = new Map(this.folders.map((f) => [f.id, f.name.toLowerCase()]));
    let list = this.files.slice();

    if (folderId !== undefined && folderId !== null) {
      list = list.filter((f) => (f.folderId || null) === (folderId === "root" ? null : folderId));
    }
    if (kind) list = list.filter((f) => f.kind === kind);
    if (tag) list = list.filter((f) => (f.tags || []).includes(tag));

    if (terms.length) {
      list = list.filter((file) => {
        const haystack = [
          file.name,
          file.source,
          file.via,
          file.ext,
          (file.tags || []).join(" "),
          folderNames.get(file.folderId) || ""
        ]
          .join(" ")
          .toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }
    return list.slice(0, limit);
  }

  /**
   * 生成整理方案（不落盘）：按类型 / 月份 / 扩展名分组的移动计划。
   * @param {"kind"|"month"|"ext"} preset
   */
  planOrganize(preset = "kind", { olderThanDays = 0 } = {}) {
    const groups = new Map();
    const cutoff = olderThanDays > 0 ? Date.now() - olderThanDays * 86400e3 : 0;
    const kindFolder = {
      img: "图片",
      video: "视频",
      audio: "音频",
      pdf: "PDF",
      doc: "文档",
      sheet: "表格",
      zip: "压缩包"
    };
    for (const file of this.files) {
      const created = new Date(file.createdAt).getTime();
      if (cutoff && created > cutoff) continue;
      let target;
      if (preset === "month") {
        const date = new Date(file.createdAt);
        target = `归档/${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      } else if (preset === "ext") {
        target = `按格式/${(file.ext || "其他").toUpperCase()}`;
      } else {
        target = kindFolder[file.kind] || "其他";
      }
      if (!groups.has(target)) groups.set(target, []);
      groups.get(target).push(file.id);
    }
    const steps = Array.from(groups.entries())
      .filter(([, ids]) => ids.length)
      .map(([folder, ids]) => ({ folder, count: ids.length, ids: ids.slice(0, 500) }));
    return { preset, olderThanDays, steps, total: steps.reduce((sum, s) => sum + s.count, 0) };
  }

  /** 执行整理方案：创建文件夹再批量移动。 */
  async applyPlan(steps, { createdBy = "本机" } = {}) {
    const applied = [];
    for (const step of steps || []) {
      if (!step || !Array.isArray(step.ids) || !step.ids.length) continue;
      const folder = await this.ensureFolderPath(step.folder, { createdBy });
      const result = await this.moveFiles(step.ids, folder ? folder.id : null);
      applied.push({ folder: step.folder, moved: result.moved });
    }
    return applied;
  }

  async log({ type, fileId, fileName, device, detail }) {
    const item = {
      id: crypto.randomUUID(),
      type,
      fileId: fileId || null,
      fileName: fileName || "",
      device: device || "",
      detail: detail || "",
      ts: nowIso()
    };
    this.activity.unshift(item);
    this.activity = this.activity.slice(0, MAX_ACTIVITY);
    await this.saveActivity();
    this.emit("change", { kind: "activity", item });
    return item;
  }

  /* ---------------- shares ---------------- */

  async createShare({ fileId, perm, expiry, note }) {
    await this.refresh({ force: true });
    const file = this.findFile(fileId);
    if (!file) return null;
    const allowedExpiry = new Set(["1h", "24h", "7d", "forever"]);
    const expiryKey = allowedExpiry.has(expiry) ? expiry : "24h";
    const ttl = { "1h": 3600e3, "24h": 24 * 3600e3, "7d": 7 * 24 * 3600e3 }[expiryKey] || 24 * 3600e3;
    const share = {
      id: randomToken(8),
      fileId: file.id,
      fileName: file.name,
      perm: perm === "write" ? "write" : "read",
      expiry: expiryKey,
      expiresAt: expiryKey === "forever" ? null : new Date(Date.now() + ttl).toISOString(),
      note: String(note || "").slice(0, 120),
      createdAt: nowIso(),
      downloads: 0,
      revoked: false
    };
    this.shares.unshift(share);
    await this.saveShares();
    await this.log({
      type: "share",
      fileId: file.id,
      fileName: file.name,
      device: share.perm === "write" ? "共享链接 · 可写入" : "共享链接 · 只读",
      detail: "共享链接已创建"
    });
    this.emit("change", { kind: "shares" });
    return share;
  }

  enrichShare(share) {
    const file = this.findFile(share.fileId);
    const expired = Boolean(share.expiresAt && new Date(share.expiresAt).getTime() <= Date.now());
    const meta = metaOfName(share.fileName);
    return {
      ...share,
      name: share.fileName,
      kind: file ? file.kind : meta.kind,
      ext: file ? file.ext : meta.ext,
      size: file ? file.size : 0,
      fileExists: Boolean(file),
      expired,
      active: !share.revoked && !expired && Boolean(file)
    };
  }

  listShares() {
    return this.shares.map((s) => this.enrichShare(s));
  }

  shareByToken(token) {
    const share = this.shares.find((s) => s.id === token);
    return share ? this.enrichShare(share) : null;
  }

  async registerShareDownload(token, device) {
    const share = this.shares.find((s) => s.id === token);
    if (!share) return;
    share.downloads += 1;
    await this.saveShares();
    await this.log({
      type: "download",
      fileId: share.fileId,
      fileName: share.fileName,
      device: `${device || "局域网访客"} · 共享链接`,
      detail: "共享链接下载"
    });
    this.emit("change", { kind: "shares" });
  }

  async revokeShare(token) {
    const share = this.shares.find((s) => s.id === token);
    if (!share) return null;
    share.revoked = true;
    await this.saveShares();
    await this.log({
      type: "revoke",
      fileId: share.fileId,
      fileName: share.fileName,
      device: "本机 · 控制台",
      detail: "共享链接已撤销"
    });
    this.emit("change", { kind: "shares" });
    return this.enrichShare(share);
  }

  /* ---------------- 分享盘（drive） ---------------- */

  /**
   * 分享盘 = 一个扫码即进的公共空间：
   *   盘内文件（fileIds）对访客可见可下载；访客上传先进「待拾取」队列，
   *   由管理员（本机控制台）决定收进库（pickup）还是丢弃（discard）。
   */
  _normalizeDrive(raw) {
    const drive = raw && typeof raw === "object" ? raw : {};
    const token = typeof drive.token === "string" && /^[A-Za-z0-9]{16,}$/.test(drive.token)
      ? drive.token
      : randomToken(20);
    const pending = Array.isArray(drive.pending) ? drive.pending.filter((p) => p && p.id) : [];
    const fileIds = Array.isArray(drive.fileIds) ? drive.fileIds.filter(Boolean) : [];
    return {
      token,
      enabled: drive.enabled === true,
      name: String(drive.name || "分享盘").slice(0, 40),
      note: String(drive.note || "").slice(0, 200),
      allowUpload: drive.allowUpload !== false,
      allowBrowse: drive.allowBrowse !== false,
      createdAt: drive.createdAt || nowIso(),
      fileIds,
      pending
    };
  }

  driveInfo() {
    return {
      ...this.drive,
      pending: this.drive.pending.slice()
    };
  }

  async updateDrive(patch = {}) {
    const drive = this.drive;
    if (typeof patch.name === "string" && patch.name.trim()) drive.name = sanitizeName(patch.name.trim()).slice(0, 40);
    if (typeof patch.note === "string") drive.note = patch.note.slice(0, 200);
    if (typeof patch.allowUpload === "boolean") drive.allowUpload = patch.allowUpload;
    if (typeof patch.allowBrowse === "boolean") drive.allowBrowse = patch.allowBrowse;
    if (typeof patch.enabled === "boolean" && patch.enabled !== drive.enabled) {
      drive.enabled = patch.enabled;
      await this.log({
        type: patch.enabled ? "share" : "revoke",
        fileName: drive.name,
        device: "本机 · 控制台",
        detail: patch.enabled ? "分享盘已开启" : "分享盘已关闭"
      });
    }
    await this.saveDrive();
    this.emit("change", { kind: "drive" });
    return this.driveInfo();
  }

  async rotateDriveToken() {
    this.drive.token = randomToken(20);
    await this.saveDrive();
    this.emit("change", { kind: "drive" });
    return this.driveInfo();
  }

  async driveAddFiles(ids) {
    const list = Array.isArray(ids) ? ids : String(ids || "").split(",").filter(Boolean);
    let added = 0;
    for (const id of list) {
      if (!this.files.some((f) => f.id === id)) continue;
      if (!this.drive.fileIds.includes(id)) {
        this.drive.fileIds.push(id);
        added += 1;
      }
    }
    if (added) {
      await this.saveDrive();
      this.emit("change", { kind: "drive" });
    }
    return { added, fileIds: this.drive.fileIds.slice() };
  }

  async driveRemoveFile(id) {
    const before = this.drive.fileIds.length;
    this.drive.fileIds = this.drive.fileIds.filter((x) => x !== id);
    if (this.drive.fileIds.length !== before) {
      await this.saveDrive();
      this.emit("change", { kind: "drive" });
      return true;
    }
    return false;
  }

  driveHasFile(id) {
    return this.drive.fileIds.includes(id);
  }

  /** 访客上传：先进待拾取队列（文件落在 data/drive-inbox，不进存储目录）。 */
  async driveSubmitUpload({ tempPath, name, size, from }) {
    ensureDir(this.driveInboxDir);
    const id = crypto.randomUUID();
    const safe = sanitizeName(name);
    const stored = path.join(this.driveInboxDir, `${id}__${safe}`);
    await fsp.rename(tempPath, stored).catch(async (err) => {
      if (err.code === "EXDEV") {
        await fsp.copyFile(tempPath, stored);
        await fsp.unlink(tempPath).catch(() => {});
      } else {
        throw err;
      }
    });
    const meta = metaOfName(safe);
    const item = {
      id,
      name: safe,
      size: Number(size) || 0,
      storedName: path.basename(stored),
      from: String(from || "访客").slice(0, 80),
      kind: meta.kind,
      ext: meta.ext,
      at: nowIso()
    };
    this.drive.pending.unshift(item);
    await this.saveDrive();
    await this.log({
      type: "upload",
      fileName: item.name,
      device: `${item.from} · 分享盘`,
      detail: "待拾取"
    });
    this.emit("change", { kind: "drive" });
    return item;
  }

  /** 管理员拾取：把待拾取文件收进正式库。不传 ids 表示全部拾取。 */
  async drivePickup(ids) {
    const wanted = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const picked = [];
    const failed = [];
    for (const item of this.drive.pending) {
      if (wanted && !wanted.has(item.id)) continue;
      const stored = path.join(this.driveInboxDir, item.storedName);
      try {
        const file = await this.commitUpload({
          tempPath: stored,
          name: item.name,
          size: item.size,
          source: item.from,
          via: "分享盘",
          mtimeMs: Date.parse(item.at) || Date.now()
        });
        file.via = "分享盘";
        picked.push(file);
      } catch {
        failed.push(item.id);
      }
    }
    this.drive.pending = this.drive.pending.filter((p) => {
      if (wanted && !wanted.has(p.id)) return true;
      return failed.includes(p.id);
    });
    await this.saveDrive();
    if (picked.length) {
      await this.log({
        type: "upload",
        fileName: picked.length === 1 ? picked[0].name : `${picked.length} 个文件`,
        device: "本机 · 控制台",
        detail: "已从分享盘拾取"
      });
    }
    this.emit("change", { kind: "drive" });
    this.emit("change", { kind: "files" });
    return { picked: picked.map((f) => ({ id: f.id, name: f.name })), failed };
  }

  async driveDiscardPending(id) {
    const item = this.drive.pending.find((p) => p.id === id);
    if (!item) return false;
    await fsp.unlink(path.join(this.driveInboxDir, item.storedName)).catch(() => {});
    this.drive.pending = this.drive.pending.filter((p) => p.id !== id);
    await this.saveDrive();
    this.emit("change", { kind: "drive" });
    return true;
  }

  pendingFilePath(id) {
    const item = this.drive.pending.find((p) => p.id === id);
    return item ? path.join(this.driveInboxDir, item.storedName) : null;
  }

  /* ---------------- devices ---------------- */

  /**
   * 登记/更新一台客户端设备。
   * 优先用 cookie 里的 id 认设备；没有 cookie 时按 ip+UA 合并，
   * 避免同一部手机并发发起多个请求时被登记成好几台。
   */
  touchDevice({ id, ip, ua, kind = "web" }) {
    const uaTag = String(ua || "").slice(0, 180);
    let device = id ? this.devices.find((d) => d.id === id) : null;

    if (!device) {
      device = this.devices.find(
        (d) => !d.revoked && d.ip === (ip || "") && d.ua === uaTag
      ) || null;
    }

    if (device) {
      if (device.revoked) return null;
      device.lastSeen = nowIso();
      if (ip) device.ip = ip;
      if (kind === "app" && device.kind !== "app") {
        device.kind = "app";
        this.saveDevices().catch(() => {});
        this.emit("change", { kind: "devices" });
      }
      return device;
    }

    device = {
      id: id || crypto.randomUUID(),
      name: deviceNameFromUA(ua),
      ip: ip || "",
      ua: uaTag,
      kind: kind === "app" ? "app" : "web",
      createdAt: nowIso(),
      lastSeen: nowIso(),
      revoked: false
    };
    this.devices.push(device);
    this.saveDevices().catch(() => {});
    this.emit("change", { kind: "devices" });
    return device;
  }

  /** 同一 ip+UA 的历史重复记录只保留最新一条。 */
  listDevices() {
    const seen = new Map();
    for (const device of this.devices) {
      if (device.revoked) continue;
      const key = `${device.ip}|${device.ua || ""}`;
      const current = seen.get(key);
      if (!current || new Date(device.lastSeen) > new Date(current.lastSeen)) {
        seen.set(key, device);
      }
    }
    return Array.from(seen.values())
      .map((d) => ({
        ...d,
        kind: d.kind === "app" ? "app" : "web",
        online: Date.now() - new Date(d.lastSeen).getTime() < ONLINE_WINDOW_MS
      }))
      .sort((a, b) => Number(b.online) - Number(a.online) || new Date(b.lastSeen) - new Date(a.lastSeen));
  }

  async removeDevice(id) {
    const device = this.devices.find((d) => d.id === id);
    if (!device) return null;
    device.revoked = true;
    await this.saveDevices();
    this.emit("change", { kind: "devices" });
    return device;
  }

  /* ---------------- inbox（电脑 → 手机 App 推送） ---------------- */

  enrichInboxItem(item) {
    const file = this.findFile(item.fileId);
    return {
      ...item,
      exists: Boolean(file),
      size: file ? file.size : item.size || 0,
      downloadUrl: file ? `/api/app/files/${file.id}/download` : null
    };
  }

  inboxFor(deviceId, limit = 20) {
    return this.inbox
      .filter((item) => item.deviceId === deviceId)
      .slice(0, limit)
      .map((item) => this.enrichInboxItem(item));
  }

  async pushFile({ deviceId, fileId, senderName }) {
    const file = this.findFile(fileId);
    if (!file) return null;
    const item = {
      id: crypto.randomUUID(),
      deviceId,
      fileId: file.id,
      fileName: file.name,
      kind: file.kind,
      ext: file.ext,
      size: file.size,
      sentAt: nowIso(),
      receivedAt: null
    };
    // 同一文件重复推送只保留最新一条，避免刷屏
    this.inbox = this.inbox.filter((i) => !(i.deviceId === deviceId && i.fileId === fileId));
    this.inbox.unshift(item);
    this.inbox = this.inbox.slice(0, MAX_INBOX);
    await this.saveInbox();
    await this.log({
      type: "outgoing",
      fileId: file.id,
      fileName: file.name,
      device: `发往 ${senderName || deviceId}`,
      detail: "电脑推送"
    });
    this.emit("change", { kind: "inbox", item });
    return this.enrichInboxItem(item);
  }

  async markInboxReceived(deviceId, itemId) {
    const item = this.inbox.find((i) => i.id === itemId && i.deviceId === deviceId);
    if (!item) return null;
    if (!item.receivedAt) {
      item.receivedAt = nowIso();
      await this.saveInbox();
    }
    return this.enrichInboxItem(item);
  }

  /* ---------------- pairing / session ---------------- */

  sessionPayload() {
    const expired = new Date(this.config.sessionExpiresAt).getTime() <= Date.now();
    return {
      valid: !expired,
      token: this.config.sessionToken,
      code: this.config.pairCode,
      createdAt: this.config.sessionCreatedAt,
      expiresAt: this.config.sessionExpiresAt,
      ttlHours: Math.round(SESSION_TTL_MS / 3600e3)
    };
  }

  async rotatePairing() {
    this.config.pairCode = randomCode();
    this.config.sessionToken = randomToken(10);
    this.config.sessionCreatedAt = nowIso();
    this.config.sessionExpiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    this.devices = [];
    this.inbox = [];
    await Promise.all([this.saveDevices(), this.saveInbox()]);
    this.emit("change", { kind: "devices" });
    this.emit("change", { kind: "pairing" });
    return this.sessionPayload();
  }

  /* ---------------- activity ---------------- */

  listActivity(limit = 60) {
    return this.activity.slice(0, limit);
  }

  /* ---------------- stats ---------------- */

  stats() {
    const total = this.files.reduce((sum, f) => sum + (f.size || 0), 0);
    const unfiled = this.files.filter((f) => !f.folderId).length;
    return { count: this.files.length, totalSize: total, folders: this.folders.length, unfiled };
  }
}

module.exports = { Store, metaOfName, sanitizeName, deviceNameFromUA, MAX_ACTIVITY };
