(function () {
  "use strict";

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  const state = {
    data: null,
    files: [],
    folders: [],
    shares: [],
    activity: [],
    devices: [],
    settings: {},
    pairing: null,
    network: { ip: "", port: 0, origin: "" },
    storage: { dir: "", count: 0, totalSize: 0, disk: { total: 0, used: 0, free: 0 } },
    limits: { maxUploadGB: 8 },
    query: "",
    sort: "date",
    folder: "all",
    drawerId: null,
    previewId: null,
    previewZoom: false,
    moveIds: [],
    pickerPath: "",
    drive: null,
    app: null,
    entry: "phone",
    loading: true,
    refreshing: false,
    queuedRefresh: false,
    refreshTimer: null,
    wakeLock: null,
    activeUploads: 0
  };

  const VIEW_META = {
    overview: ["概览", "这台电脑的接收状态与最近动态"],
    files: ["文件", "按传输时间分批整理"],
    share: ["共享", "生成局域网链接，发给身边的同事"],
    devices: ["设备", "已连接过这台电脑的手机与浏览器"],
    settings: ["设置", "存储位置、网络与安全"]
  };

  const ACT_VERB = {
    upload: "上传",
    download: "下载",
    share: "创建共享",
    revoke: "撤销共享",
    delete: "删除",
    outgoing: "电脑发出"
  };

  const EXPIRY_TEXT = { "1h": "1 小时后失效", "24h": "24 小时后失效", "7d": "7 天后失效", forever: "永久有效" };

  /* ---------------- helpers ---------------- */

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[ch]));
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return "0 KB";
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function shortPath(dir) {
    const base = String(dir || "").split(/[\\/]/).filter(Boolean).pop();
    return base ? `~/${base}` : "~/LanDrop";
  }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    if (sameDay(d, now)) return { key: "today", label: "今天", date: `${pad(d.getMonth() + 1)} / ${pad(d.getDate())}` };
    if (sameDay(d, yesterday)) return { key: "yesterday", label: "昨天", date: `${pad(d.getMonth() + 1)} / ${pad(d.getDate())}` };
    const sameYear = d.getFullYear() === now.getFullYear();
    return {
      key: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      label: sameYear ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`,
      date: `${pad(d.getMonth() + 1)} / ${pad(d.getDate())}`
    };
  }

  function timeLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const meta = dayLabel(iso);
    return `${meta.label} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function shortTime(iso) {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function relativeTime(iso) {
    const ts = new Date(iso).getTime();
    if (!ts) return "—";
    const diff = Date.now() - ts;
    if (diff < 60 * 1000) return "刚刚";
    if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return timeLabel(iso);
  }

  function toast(message, kind) {
    const el = document.createElement("div");
    el.className = "toast" + (kind === "error" ? " is-error" : "");
    el.innerHTML =
      '<svg class="od-icon toast-icon-ok" style="--od-icon-size:15px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      (kind === "error"
        ? '<path d="M8 5v4.2M8 11.6v.2"/><circle cx="8" cy="8" r="6"/>'
        : '<path d="m3 8.4 2.8 2.8L13 3.8"/>') +
      "</svg><span>" + escapeHtml(message) + "</span>";
    $("#toasts").appendChild(el);
    window.setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateY(6px)";
      el.style.transition = "opacity 180ms ease, transform 180ms ease";
      window.setTimeout(() => el.remove(), 200);
    }, 2800);
  }

  async function copyText(text, okMessage) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      toast(okMessage || "已复制到剪贴板");
    } catch {
      toast("复制失败，请手动选择文本", "error");
    }
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      ...options
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const message = (payload && payload.message) || `请求失败（${res.status}）`;
      const error = new Error(message);
      error.status = res.status;
      throw error;
    }
    return payload;
  }

  /* ---------------- confirm ---------------- */

  let pendingConfirm = null;
  function askConfirm(title, body, okLabel, onOk) {
    $("#confirm-title").textContent = title;
    $("#confirm-body").textContent = body;
    $("#confirm-ok").textContent = okLabel || "确认";
    pendingConfirm = onOk;
    $("#confirm").showModal();
  }
  $("#confirm").addEventListener("close", () => {
    if ($("#confirm").returnValue === "ok" && typeof pendingConfirm === "function") {
      const fn = pendingConfirm;
      pendingConfirm = null;
      fn();
    } else {
      pendingConfirm = null;
    }
  });

  /* ---------------- navigation ---------------- */

  function setView(name, opts = {}) {
    if (!VIEW_META[name]) return;
    $$("[data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== name;
    });
    $$(".nav-item").forEach((item) => {
      const active = item.dataset.view === name;
      item.classList.toggle("is-active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    $("#page-title").textContent = VIEW_META[name][0];
    $("#page-sub").textContent = VIEW_META[name][1];
    if (opts.focusSearch) $("#global-search").focus();
    if (name === "overview" && opts.scrollPair) {
      $("#pair-panel").scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  $$(".nav-item").forEach((item) => item.addEventListener("click", () => setView(item.dataset.view)));
  $$("[data-goto]").forEach((btn) => btn.addEventListener("click", () => setView(btn.dataset.goto)));

  /* ---------------- data load ---------------- */

  async function load({ silent = false } = {}) {
    if (state.refreshing) {
      state.queuedRefresh = true;
      return;
    }
    state.refreshing = true;
    try {
      const data = await api("/api/state");
      const first = !state.data;
      state.data = data;
      state.files = data.files || [];
      state.folders = data.folders || [];
      state.shares = data.shares || [];
      state.activity = data.activity || [];
      state.devices = data.devices || [];
      state.network = data.network;
      state.storage = data.storage;
      state.pairing = data.pairing;
      state.limits = data.limits || state.limits;
      state.settings = data.settings;
      state.app = data.app || null;
      state.drive = data.drive || null;
      state.loading = false;
      renderAll();
      if (first) {
        renderSettings();
        bindSettingsDefaults();
      }
      if (!silent && first) hideSkeletons();
    } catch (err) {
      state.loading = false;
      if (!silent) toast(err.message, "error");
      renderLoadError();
    } finally {
      state.refreshing = false;
      if (state.queuedRefresh) {
        state.queuedRefresh = false;
        load({ silent: true });
      }
    }
  }

  function scheduleRefresh() {
    window.clearTimeout(state.refreshTimer);
    state.refreshTimer = window.setTimeout(() => load({ silent: true }), 350);
  }

  function renderLoadError() {
    $("#receive-list").innerHTML = '<li class="mini-empty">读取失败，请确认 LanDrop 服务仍在运行。</li>';
    $("#activity-list").innerHTML = '<div class="activity-empty">暂时读不到传输动态。</div>';
  }

  function hideSkeletons() {
    $$(".skeleton-row").forEach((el) => el.remove());
  }

  function renderSkeletons() {
    const rows = Array.from({ length: 3 }, () =>
      '<li class="skeleton-row"><span class="skeleton-block is-badge"></span><span><span class="skeleton-block"></span><span class="skeleton-block is-short"></span></span><span class="skeleton-block"></span></li>'
    ).join("");
    $("#receive-list").innerHTML = rows;
    $("#activity-list").innerHTML = '<div class="skeleton-row"><span class="skeleton-block is-badge"></span><span><span class="skeleton-block"></span><span class="skeleton-block is-short"></span></span><span class="skeleton-block"></span></div>';
  }

  /* ---------------- renderers ---------------- */

  function typeBadge(file) {
    return '<span class="ftype" data-kind="' + escapeHtml(file.kind || "doc") + '" aria-hidden="true">' + escapeHtml(file.ext || "FILE") + "</span>";
  }

  /** 图片/视频直接显示内容缩略图，其余类型沿用类型徽标。 */
  function thumbCell(file) {
    const kind = file.previewKind || file.kind;
    if (kind === "image" && file.rawUrl) {
      return (
        '<span class="row-thumb" aria-hidden="true"><img src="' +
        escapeHtml(file.rawUrl) +
        '" alt="" loading="lazy" decoding="async" /></span>'
      );
    }
    if (kind === "video" && file.rawUrl) {
      return (
        '<span class="row-thumb" aria-hidden="true"><video src="' +
        escapeHtml(file.rawUrl) +
        '" muted playsinline preload="metadata"></video><span class="row-thumb-play">' +
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.5l5 3.5-5 3.5z"/></svg>' +
        "</span></span>"
      );
    }
    return typeBadge(file);
  }

  function renderStats() {
    const count = state.storage.count || state.files.length;
    const total = state.storage.totalSize || 0;
    const gb = total / (1024 * 1024 * 1024);
    const mb = total / (1024 * 1024);
    $("#stat-files").innerHTML = count + "<small>个</small>";
    $("#stat-size").innerHTML = total <= 0
      ? "0<small>KB</small>"
      : gb >= 1
        ? gb.toFixed(1) + "<small>GB</small>"
        : mb >= 1
          ? mb.toFixed(1) + "<small>MB</small>"
          : Math.max(1, Math.round(total / 1024)) + "<small>KB</small>";
    const online = state.devices.filter((d) => d.online).length;
    $("#stat-devices").innerHTML = Math.max(online, 1) + "<small>台</small>";
  }

  function renderStorage() {
    const disk = state.storage.disk || { total: 0, used: 0 };
    const percent = disk.total ? Math.min(100, (disk.used / disk.total) * 100) : 0;
    $("#storage-bar-fill").style.width = percent.toFixed(1) + "%";
    $("#storage-text").textContent = disk.total
      ? `${formatSize(disk.used)} / ${formatSize(disk.total)}`
      : "—";
    const short = shortPath(state.storage.dir);
    $("#storage-chip").textContent = short;
    $("#hero-path").textContent = short;
    $("#drawer-path").textContent = short;
  }

  function renderPairing() {
    if (!state.pairing) return;
    const code = String(state.pairing.code || "");
    const codeEl = $("#pair-code");
    codeEl.textContent = code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : "— — —";
    const host = `${state.network.ip}:${state.network.port}`;
    $("#pair-url").textContent = `${host}/w/${state.pairing.token}`;
    $("#hero-addr").textContent = host;
    $("#rail-addr").textContent = host;
    $("#qr").src = state.pairing.qrUrl;
    const webUrl = state.pairing.url;
    $("#open-web").href = webUrl;
    $("#open-web-2").href = webUrl;
    $("#qr-caption").textContent = `24 小时内有效`;
    $("#dz-hint").textContent = `支持任意格式，单个文件最大 ${state.limits.maxUploadGB || 8} GB`;
  }

  function rxRow(file, opts = {}) {
    const progress = opts.progress;
    return (
      '<li class="rx-row" data-file="' + escapeHtml(file.id || "") + '">' +
      typeBadge(file) +
      '<div class="rx-main"><span class="rx-name">' + escapeHtml(file.name) + "</span>" +
      '<span class="rx-meta">来自 ' + escapeHtml(file.source || "未知") + " · " + escapeHtml(file.dateLabel || timeLabel(file.createdAt)) + "</span></div>" +
      '<div class="rx-side"><span class="rx-size mono">' + formatSize(file.size) + "</span>" +
      (typeof progress === "number"
        ? '<div class="rx-bar"><span style="width:' + progress + '%"></span></div><span class="rx-status">' + progress + "%</span>"
        : '<span class="rx-status is-done">已保存</span>') +
      "</div></li>"
    );
  }

  function renderReceive() {
    const list = state.files.slice(0, 8);
    if (!list.length) {
      $("#receive-list").innerHTML =
        '<li class="mini-empty">' +
        '<svg class="od-icon" style="--od-icon-size:24px" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6a1.8 1.8 0 0 1 1.8-1.8h2.9L9.4 6h5.8A1.8 1.8 0 0 1 17 7.8v6.4A1.8 1.8 0 0 1 15.2 16H4.8A1.8 1.8 0 0 1 3 14.2V6Z"/></svg>' +
        "<strong>还没有收到文件</strong>" +
        "<span>把文件拖到上方的接收区，或让手机扫码上传。</span>" +
        "</li>";
      $("#receive-count").textContent = "0 个文件";
      return;
    }
    $("#receive-list").innerHTML = list.map((f) => rxRow(f)).join("");
    $("#receive-count").textContent = `${state.files.length} 个文件`;
  }


  function folderName(id) {
    const folder = (state.folders || []).find((f) => f.id === id);
    return folder ? folder.name : "";
  }

  function folderPath(id) {
    const names = [];
    let cursor = (state.folders || []).find((f) => f.id === id);
    let guard = 0;
    while (cursor && guard < 12) {
      names.unshift(cursor.name);
      cursor = (state.folders || []).find((f) => f.id === cursor.parentId);
      guard += 1;
    }
    return names.join(" / ");
  }

  function visibleFiles() {
    let list = state.files.slice();
    if (state.folder !== "all") {
      const target = state.folder === "root" ? null : state.folder;
      list = list.filter((f) => (f.folderId || null) === target);
    }
    const q = state.query.trim().toLowerCase();
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      list = list.filter((f) => {
        const haystack = [
          f.name,
          f.source,
          f.via,
          f.ext,
          (f.tags || []).join(" "),
          folderPath(f.folderId)
        ]
          .join(" ")
          .toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
    }
    if (state.sort === "name") list.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-Hans-CN"));
    else if (state.sort === "size") list.sort((a, b) => (b.size || 0) - (a.size || 0));
    else list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return list;
  }

  const ICON_FOLDER = '<svg class="od-icon" style="--od-icon-size:14px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.6A1.4 1.4 0 0 1 3.4 3.2h2l1.2 1.3h5A1.4 1.4 0 0 1 13 5.9v5.1a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11V4.6Z"/></svg>';

  const ICON_INFO = '<svg class="od-icon" style="--od-icon-size:14px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 7.4v3.2M8 5.4v.2"/></svg>';

  function rowActions(file) {
    return (
      '<span class="row-actions">' +
      '<button class="row-act" type="button" data-act="move" data-id="' + escapeHtml(file.id) + '" title="移动到文件夹" aria-label="移动 ' + escapeHtml(file.name) + '">' + ICON_FOLDER + "</button>" +
      '<button class="row-act" type="button" data-act="detail" data-id="' + escapeHtml(file.id) + '" title="详情与更多操作" aria-label="' + escapeHtml(file.name) + ' 详情">' + ICON_INFO + "</button>" +
      "</span>"
    );
  }

  function renderFiles() {
    const list = visibleFiles();
    const groups = [];
    for (const file of list) {
      const meta = dayLabel(file.createdAt);
      let group = groups.find((g) => g.key === meta.key);
      if (!group) {
        group = { key: meta.key, label: meta.label, date: meta.date, files: [] };
        groups.push(group);
      }
      group.files.push(file);
    }

    $("#batch-list").innerHTML = groups.map((g) => {
      const total = g.files.reduce((sum, f) => sum + (f.size || 0), 0);
      const rows = g.files.map((file) =>
        '<li><div class="batch-row" role="button" tabindex="0" data-file="' + escapeHtml(file.id) + '" aria-label="预览 ' + escapeHtml(file.name) + '">' +
        thumbCell(file) +
        '<span class="batch-main"><span class="batch-name">' + escapeHtml(file.name) + "</span>" +
        '<span class="batch-meta">' + escapeHtml(file.source || "未知") + " · " + escapeHtml(shortTime(file.createdAt)) + " · " + escapeHtml(file.via || "传输") +
        (folderName(file.folderId) ? " · " + escapeHtml(folderPath(file.folderId)) : "") + "</span></span>" +
        '<span class="batch-size">' + formatSize(file.size) + "</span>" +
        rowActions(file) +
        "</div></li>"
      ).join("");
      return '<section class="batch">' +
        '<div class="batch-head"><div class="batch-title"><h2>' + escapeHtml(g.label) + '</h2><span class="batch-date">' + escapeHtml(g.date) + "</span></div>" +
        '<span class="batch-sum">' + g.files.length + " 个文件 · " + formatSize(total) + "</span></div>" +
        '<ul class="batch-rows">' + rows + "</ul></section>";
    }).join("");

    const totalCount = state.files.length;
    $("#files-count").textContent = list.length + " 个文件";
    $("#files-foot-count").textContent = list.length + " 个文件";

    const inFolder = state.folder !== "all";
    const folderLabel = state.folder === "root" ? "收件箱" : folderPath(state.folder);
    $("#crumb-root").textContent = state.folder === "all" ? "全部文件" : "全部文件";
    $("#crumb-sep").hidden = !inFolder;
    $("#crumb-folder").hidden = !inFolder;
    $("#crumb-folder").textContent = inFolder ? folderLabel : "";

    const empty = $("#files-empty");
    empty.hidden = list.length !== 0;
    $("#batch-list").hidden = list.length === 0;
    if (!list.length) {
      const title = empty.querySelector("h3");
      const sub = empty.querySelector("p");
      if (totalCount === 0) {
        title.textContent = "还没有文件";
        sub.textContent = "把文件拖到概览页的上传区，或让手机扫码传一份过来。";
      } else if (state.query.trim()) {
        title.textContent = "没有找到匹配的文件";
        sub.textContent = "换个关键词试试；搜索会匹配文件名、来源、标签和所在文件夹。";
      } else {
        title.textContent = inFolder ? "这个文件夹还是空的" : "没有文件";
        sub.textContent = "在上传区拖进文件，或把已有文件移动到这里。";
      }
    }
  }

  function renderFolders() {
    const folders = state.folders || [];
    const total = state.files.length;
    const rootCount = state.files.filter((f) => !f.folderId).length;
    const childrenOf = (parentId) =>
      folders
        .filter((f) => (f.parentId || null) === parentId)
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

    const FOLDER_ICON = '<svg class="od-icon" style="--od-icon-size:14px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.6A1.4 1.4 0 0 1 3.4 3.2h2l1.2 1.3h5A1.4 1.4 0 0 1 13 5.9v5.1a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11V4.6Z"/></svg>';
    const item = (id, label, count, depth, removable) =>
      '<li class="folder-row">' +
      '<button class="folder-item' + (state.folder === id ? " is-active" : "") + '" type="button" data-folder="' + escapeHtml(id) + '">' +
      '<span style="padding-left:' + depth * 12 + 'px;display:flex;align-items:center;gap:7px;flex:1;min-width:0">' +
      FOLDER_ICON +
      '<span class="folder-name" data-rename="' + escapeHtml(id) + '" title="双击重命名">' + escapeHtml(label) + "</span>" +
      "</span>" +
      '<span class="folder-count">' + count + "</span></button>" +
      (removable
        ? '<button class="folder-del" type="button" data-del="' + escapeHtml(id) + '" title="删除文件夹（文件移回收件箱）" aria-label="删除文件夹">' +
          '<svg class="od-icon" style="--od-icon-size:12px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>'
        : "") +
      "</li>";

    const walk = (parentId, depth) => {
      let html = "";
      for (const folder of childrenOf(parentId)) {
        html += item(folder.id, folder.name, folder.count || 0, depth, true);
        html += walk(folder.id, depth + 1);
      }
      return html;
    };

    $("#folder-tree").innerHTML =
      item("all", "全部文件", total, 0, false) +
      item("root", "收件箱", rootCount, 0, false) +
      walk(null, 0);
  }

  function renderActivity() {
    if (!state.activity.length) {
      $("#activity-list").innerHTML = '<div class="activity-empty">还没有传输记录。手机上传或分享文件后，这里会按时间列出。</div>';
      return;
    }
    const groups = [];
    for (const item of state.activity) {
      const meta = dayLabel(item.ts);
      let group = groups.find((g) => g.key === meta.key);
      if (!group) {
        group = { key: meta.key, label: meta.label, items: [] };
        groups.push(group);
      }
      group.items.push(item);
    }
    $("#activity-list").innerHTML = groups.slice(0, 4).map((g) =>
      '<section class="activity-group"><p class="ag-label">' + escapeHtml(g.label) + '</p><ul class="act-list">' +
      g.items.map((a) =>
        '<li class="act-item" data-type="' + escapeHtml(a.type) + '"><span class="act-dot" aria-hidden="true"></span>' +
        '<div class="act-text"><span class="act-verb">' + escapeHtml(ACT_VERB[a.type] || a.type) + "</span> " +
        "<strong>" + escapeHtml(a.fileName || "—") + "</strong>" +
        '<span class="act-meta">' + escapeHtml(a.device || "") + " · " + escapeHtml(shortTime(a.ts)) + "</span></div></li>"
      ).join("") + "</ul></section>"
    ).join("");
  }

  function renderShares() {
    const active = state.shares.filter((s) => s.active);
    $("#active-share-count").textContent = active.length + " 个链接";
    $("#share-list").innerHTML = active.length
      ? active.map((share) =>
        '<article class="share-card" data-share-id="' + escapeHtml(share.id) + '">' +
        '<div class="sc-top">' + typeBadge(share) +
        '<div style="min-width:0"><p class="sc-name">' + escapeHtml(share.name) + "</p>" +
        '<p class="sc-meta">' + (share.perm === "write" ? "可写入" : "只读") + " · " + escapeHtml(EXPIRY_TEXT[share.expiry] || "限时") + " · 已下载 " + (share.downloads || 0) + " 次</p></div></div>" +
        '<span class="sc-link">' + escapeHtml(share.link) + "</span>" +
        '<div class="sc-actions">' +
        '<button class="btn btn-ghost btn-sm" type="button" data-copy-share="' + escapeHtml(share.id) + '">复制链接</button>' +
        '<button class="btn btn-quiet btn-sm" type="button" data-revoke-share="' + escapeHtml(share.id) + '">撤销</button>' +
        "</div></article>"
      ).join("")
      : '<div class="share-empty">还没有共享链接。选一个文件，生成第一条吧。</div>';
  }

  function renderShareOptions() {
    const select = $("#share-file");
    if (!state.files.length) {
      select.innerHTML = '<option value="">还没有可共享的文件</option>';
      select.disabled = true;
      $(".form-submit").disabled = true;
      return;
    }
    const current = select.value;
    select.disabled = false;
    $(".form-submit").disabled = false;
    select.innerHTML = state.files.map((f) =>
      '<option value="' + escapeHtml(f.id) + '">' + escapeHtml(f.name) + " · " + formatSize(f.size) + "</option>"
    ).join("");
    if (state.files.some((f) => f.id === current)) select.value = current;
    setWritePermissionState();
  }

  function setWritePermissionState() {
    const allowed = state.settings.allowWriteShares !== false;
    const writeRadio = $('input[name="perm"][value="write"]');
    if (!writeRadio) return;
    writeRadio.disabled = !allowed;
    const label = writeRadio.closest("label");
    if (label) {
      label.style.opacity = allowed ? "" : "0.55";
      label.title = allowed ? "" : "电脑端已关闭「允许同事写入」";
    }
    if (!allowed && writeRadio.checked) $('input[name="perm"][value="read"]').checked = true;
  }

  function renderDeviceMini() {
    const list = state.devices.slice(0, 3);
    $("#device-mini").innerHTML = list.length
      ? list.map((d) =>
        '<li><span class="device-avatar" aria-hidden="true">' +
        (d.self
          ? '<svg class="od-icon" style="--od-icon-size:15px" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="4" width="10" height="8" rx="1.5"/><path d="M6 15h4M8 12v3"/><rect x="14" y="8.6" width="3.4" height="7.4" rx="1.1"/></svg>'
          : '<svg class="od-icon" style="--od-icon-size:15px" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.6" width="8" height="14.8" rx="2"/><path d="M9 14.6h2"/></svg>') +
        '</span><span><span class="d-name">' + escapeHtml(d.name) + '</span><span class="d-meta">' +
        (d.self ? "本机 · " : "") + escapeHtml(d.ip || "—") + " · " + escapeHtml(relativeTime(d.lastSeen)) + "</span></span>" +
        '<span class="state ' + (d.online ? "on" : "off") + '"><span class="dot' + (d.online ? " dot-live" : "") + '" aria-hidden="true"></span>' + (d.online ? "在线" : "离线") + "</span></li>"
      ).join("")
      : '<li class="mini-empty">还没有其它设备连接。手机扫码后会出现在这里。</li>';
  }

  function deviceType(device) {
    if (device.self) return "这台电脑";
    const ua = String(device.ua || "");
    const mode = device.kind === "app" ? "App" : "网页版";
    if (/iPhone/i.test(ua)) return `iPhone · ${mode}`;
    if (/iPad/i.test(ua)) return `iPad · ${mode}`;
    if (/Android/i.test(ua)) return `Android · ${mode}`;
    if (/Macintosh/i.test(ua)) return `Mac · ${mode}`;
    if (/Windows/i.test(ua)) return `Windows · ${mode}`;
    return `浏览器 · ${mode}`;
  }

  function renderDevices() {
    $("#device-grid").innerHTML = state.devices.map((d) => {
      const rows = d.self
        ? '<div class="dc-row"><span>地址</span><b>' + escapeHtml(d.ip || "—") + "</b></div>" +
          '<div class="dc-row"><span>配对时间</span><b>' + escapeHtml(new Date(d.createdAt).toLocaleDateString("zh-CN")) + "</b></div>" +
          '<div class="dc-row"><span>已接收</span><b>' + (state.storage.count || 0) + " 个文件</b></div>"
        : '<div class="dc-row"><span>地址</span><b>' + escapeHtml(d.ip || "—") + "</b></div>" +
          '<div class="dc-row"><span>最近活动</span><b>' + escapeHtml(relativeTime(d.lastSeen)) + "</b></div>" +
          '<div class="dc-row"><span>权限</span><b>上传 / 下载</b></div>';
      const foot = d.self
        ? ""
        : '<span class="pill"><span class="dot' + (d.online ? " dot-live" : "") + '" aria-hidden="true"></span>' + (d.online ? "在线" : "离线") + "</span>" +
          '<button class="btn btn-quiet btn-sm" type="button" data-remove-device="' + escapeHtml(d.id) + '" data-device-name="' + escapeHtml(d.name) + '">移除</button>';
      return '<article class="device-card' + (d.self ? " is-self" : "") + '">' +
        '<div class="dc-top"><span class="dc-avatar" aria-hidden="true">' +
        (d.self
          ? '<svg class="od-icon" style="--od-icon-size:19px" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.6" y="4" width="10" height="8" rx="1.5"/><path d="M6 15h4M8 12v3"/><rect x="14" y="8.6" width="3.4" height="7.4" rx="1.1"/></svg>'
          : '<svg class="od-icon" style="--od-icon-size:19px" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.6" width="8" height="14.8" rx="2"/><path d="M9 14.6h2"/></svg>') +
        '</span><div><h3>' + escapeHtml(d.name) + "</h3><p class=\"dc-type\">" + escapeHtml(deviceType(d)) + "</p></div></div>" +
        '<div class="dc-rows">' + rows + "</div>" +
        '<div class="dc-foot">' + foot + "</div>" +
        (d.self ? '<p class="dc-note">这台电脑就是文件的落点。存储目录、端口与访问开关都在设置里。</p>' : "") +
        "</article>";
    }).join("");
  }

  /* ---------------- 预览 ---------------- */

  const PREVIEW_LABEL = {
    image: "图片",
    video: "视频",
    audio: "音频",
    pdf: "PDF 文档",
    markdown: "Markdown",
    text: "文本",
    code: "代码",
    csv: "表格",
    "office-doc": "Word 文档",
    "office-sheet": "Excel 表格",
    "office-slide": "演示文稿",
    archive: "压缩包",
    "legacy-office": "旧版 Office",
    unknown: "文件"
  };

  function previewNote(title, body) {
    return '<div class="preview-note"><strong>' + escapeHtml(title) + "</strong>" + escapeHtml(body) + "</div>";
  }

  function inlineMd(text) {
    return text
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/~~(.+?)~~/g, "<del>$1</del>")
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
  }

  /** markdown → html。够用的子集：标题、表格、任务列表、有序/无序列表、
   *  围栏代码块（带语言标签）、引用、分隔线、加粗/斜体/行内码/删除线/链接。 */
  function markdownHtml(src) {
    const lines = escapeHtml(src).split(/\r?\n/);
    const html = [];
    let i = 0;
    let listTag = null;

    const closeList = () => {
      if (listTag) {
        html.push(`</${listTag}>`);
        listTag = null;
      }
    };

    while (i < lines.length) {
      const line = lines[i];

      /* 围栏代码块 */
      const fence = /^```\s*([\w+#-]*)\s*$/.exec(line.trim());
      if (fence) {
        closeList();
        const lang = fence[1];
        const buf = [];
        i += 1;
        while (i < lines.length && !/^```/.test(lines[i].trim())) {
          buf.push(lines[i]);
          i += 1;
        }
        i += 1; // 吃掉收尾的 ```
        html.push(
          '<div class="md-code">' +
            (lang ? '<span class="md-code-lang">' + escapeHtml(lang) + "</span>" : "") +
            "<pre><code>" + buf.join("\n") + "</code></pre></div>"
        );
        continue;
      }

      /* 空行 */
      if (!line.trim()) {
        closeList();
        i += 1;
        continue;
      }

      /* 分隔线 */
      if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
        closeList();
        html.push("<hr />");
        i += 1;
        continue;
      }

      /* 表格：表头行 + 分隔行 */
      if (line.includes("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        closeList();
        const cells = (row) =>
          row
            .replace(/^\s*\|/, "")
            .replace(/\|\s*$/, "")
            .split("|")
            .map((c) => c.trim());
        const head = cells(line);
        const aligns = cells(lines[i + 1]).map((spec) => {
          if (/^:-+:$/.test(spec)) return ' style="text-align:center"';
          if (/-+:$/.test(spec)) return ' style="text-align:right"';
          return "";
        });
        i += 2;
        const body = [];
        while (i < lines.length && lines[i].includes("|")) {
          body.push(cells(lines[i]));
          i += 1;
        }
        html.push(
          '<div class="md-table-wrap"><table class="md-table"><thead><tr>' +
            head.map((c, n) => "<th" + (aligns[n] || "") + ">" + inlineMd(c) + "</th>").join("") +
            "</tr></thead><tbody>" +
            body
              .map((row) =>
                "<tr>" +
                head
                  .map((_, n) => "<td" + (aligns[n] || "") + ">" + inlineMd(row[n] === undefined ? "" : row[n]) + "</td>")
                  .join("") +
                "</tr>"
              )
              .join("") +
            "</tbody></table></div>"
        );
        continue;
      }

      /* 标题 */
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        closeList();
        const level = Math.min(heading[1].length, 4);
        html.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }

      /* 引用（注意：源码已整体转义，> 在这里是 &gt;） */
      const quote = /^\s*(?:&gt;|>)\s?(.*)$/.exec(line);
      if (quote) {
        closeList();
        const buf = [quote[1]];
        i += 1;
        while (i < lines.length && /^\s*(?:&gt;|>)\s?/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*(?:&gt;|>)\s?/, ""));
          i += 1;
        }
        html.push("<blockquote>" + inlineMd(buf.join(" ")) + "</blockquote>");
        continue;
      }

      /* 任务列表 */
      const task = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/.exec(line);
      if (task) {
        if (listTag !== "ul") {
          closeList();
          html.push('<ul class="md-tasks">');
          listTag = "ul";
        }
        const checked = task[1].toLowerCase() === "x";
        html.push(
          '<li class="md-task' +
            (checked ? " is-done" : "") +
            '"><span class="md-box" aria-hidden="true">' +
            (checked ? "✓" : "") +
            "</span><span>" +
            inlineMd(task[2]) +
            "</span></li>"
        );
        i += 1;
        continue;
      }

      /* 无序列表 */
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      if (bullet) {
        if (listTag !== "ul") {
          closeList();
          html.push("<ul>");
          listTag = "ul";
        }
        html.push("<li>" + inlineMd(bullet[1]) + "</li>");
        i += 1;
        continue;
      }

      /* 有序列表 */
      const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      if (ordered) {
        if (listTag !== "ol") {
          closeList();
          html.push("<ol>");
          listTag = "ol";
        }
        html.push("<li>" + inlineMd(ordered[1]) + "</li>");
        i += 1;
        continue;
      }

      closeList();
      html.push("<p>" + inlineMd(line) + "</p>");
      i += 1;
    }

    closeList();
    return html.join("\n");
  }

  function renderPreview(payload, file) {
    const body = $("#preview-body");
    body.className = "preview-body";
    body.innerHTML = "";

    if (payload.type === "media") {
      const url = file.rawUrl;
      if (payload.kind === "image") {
        const img = document.createElement("img");
        img.className = "preview-media preview-media--img";
        img.src = url;
        img.alt = file.name;
        img.addEventListener("click", () => {
          state.previewZoom = !state.previewZoom;
          img.classList.toggle("is-actual", state.previewZoom);
          body.classList.toggle("is-zoom", state.previewZoom);
        });
        img.addEventListener("error", () => {
          body.innerHTML = previewNote(
            "图片没能显示出来",
            "可能是文件还没传完或已经损坏。可以试试重新上传，或下载后用看图软件打开。"
          );
        });
        body.appendChild(img);
        return;
      }
      if (payload.kind === "video") {
        const video = document.createElement("video");
        video.className = "preview-media";
        video.src = url;
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        video.addEventListener("error", () => {
          body.innerHTML = previewNote(
            "这个视频没法在浏览器里播",
            "编码可能不被支持（比如某些 HEVC/AV1 编码）。可以下载后用本地播放器打开。"
          );
        });
        body.appendChild(video);
        return;
      }
      if (payload.kind === "audio") {
        const wrap = document.createElement("div");
        wrap.className = "preview-note";
        wrap.innerHTML = '<strong>' + escapeHtml(file.name) + "</strong>音频文件，" + formatSize(file.size);
        const audio = document.createElement("audio");
        audio.className = "preview-audio";
        audio.src = url;
        audio.controls = true;
        audio.autoplay = true;
        wrap.appendChild(audio);
        body.appendChild(wrap);
        return;
      }
      if (payload.kind === "pdf") {
        const frame = document.createElement("iframe");
        frame.className = "preview-frame";
        frame.src = url;
        frame.title = file.name;
        body.appendChild(frame);
        return;
      }
    }

    if (payload.kind === "markdown" && payload.type === "text") {
      body.innerHTML = '<article class="preview-article preview-doc">' + markdownHtml(payload.text) + "</article>";
      if (payload.truncated) {
        body.insertAdjacentHTML("beforeend", '<p class="preview-foot-note">文件较大，只渲染前 512 KB</p>');
      }
      return;
    }

    if (payload.type === "text") {
      const pre = document.createElement("pre");
      pre.className = "preview-text";
      pre.textContent = payload.text;
      body.appendChild(pre);
      if (payload.truncated) {
        body.insertAdjacentHTML("beforeend", '<p class="preview-foot-note">文件较大，只显示前 512 KB</p>');
      } else if (payload.garble) {
        body.insertAdjacentHTML("beforeend", '<p class="preview-foot-note">编码不是 UTF-8，部分字符可能显示异常</p>');
      }
      return;
    }

    if (payload.type === "table") {
      const rows = payload.rows || [];
      if (!rows.length) {
        body.innerHTML = previewNote("表格是空的", "这个文件里没有可显示的行。");
        return;
      }
      const head = rows[0].map((cell) => "<th>" + escapeHtml(String(cell)) + "</th>").join("");
      const rest = rows
        .slice(1)
        .map((row) => "<tr>" + row.map((cell) => "<td>" + escapeHtml(String(cell)) + "</td>").join("") + "</tr>")
        .join("");
      body.innerHTML =
        '<div class="preview-table-wrap"><table class="preview-table"><thead><tr>' + head + "</tr></thead><tbody>" + rest + "</tbody></table></div>" +
        (payload.truncated ? '<p class="preview-foot-note">只显示前 300 行 / 30 列</p>' : "");
      return;
    }

    if (payload.type === "doc") {
      const paragraphs = payload.paragraphs || [];
      body.innerHTML =
        '<div class="preview-doc">' + paragraphs.map((p) => "<p>" + escapeHtml(p) + "</p>").join("") + "</div>" +
        (payload.truncated ? '<p class="preview-foot-note">只显示前 2000 段</p>' : "");
      return;
    }

    if (payload.type === "slides") {
      const slides = payload.slides || [];
      body.innerHTML =
        '<div class="preview-slides">' +
        slides
          .map(
            (slide) =>
              '<section class="slide-card"><h3>第 ' + slide.index + " 页</h3>" +
              (slide.lines.length ? slide.lines.map((line) => "<p>" + escapeHtml(line) + "</p>").join("") : "<p>（这一页没有文字）</p>") +
              "</section>"
          )
          .join("") +
        "</div>";
      return;
    }

    if (payload.type === "archive") {
      const entries = payload.entries || [];
      body.innerHTML =
        '<ul class="preview-list">' +
        entries
          .map((e) => '<li><span class="mono">' + escapeHtml(e.name) + "</span><span>" + formatSize(e.size) + "</span></li>")
          .join("") +
        "</ul>" +
        '<p class="preview-foot-note">共 ' + payload.count + " 项 · " + formatSize(payload.totalSize) + (payload.truncated ? " · 只列前 500 项" : "") + "</p>";
      return;
    }

    body.innerHTML = previewNote(
      payload.reason ? "没法内嵌预览" : "没有可预览的内容",
      payload.reason || "这个文件类型暂时不支持预览，可以下载或交给系统应用打开。"
    );
  }

  async function openPreview(id) {
    const file = state.files.find((f) => f.id === id);
    if (!file) return;
    state.previewId = id;
    state.previewZoom = false;
    $("#preview").hidden = false;
    $("#preview-scrim").hidden = false;
    $("#preview-badge").textContent = file.ext || "FILE";
    $("#preview-badge").dataset.kind = file.kind || "doc";
    $("#preview-name").textContent = file.name;
    $("#preview-sub").textContent =
      (PREVIEW_LABEL[file.previewKind] || "文件") + " · " + formatSize(file.size) + " · " + timeLabel(file.createdAt);
    $("#preview-download").href = file.downloadUrl;
    $("#preview-download").setAttribute("download", file.name);
    $("#preview-open").hidden = !(state.data && state.data.runtime && state.data.runtime.desktop);
    const body = $("#preview-body");
    body.className = "preview-body";
    body.innerHTML = previewNote("正在解析", "稍等一下，正在读这个文件。");
    document.body.style.overflow = "hidden";
    $("#preview-close").focus();
    try {
      const payload = await api(file.previewUrl);
      if (state.previewId !== id) return;
      renderPreview(payload, file);
    } catch (err) {
      if (state.previewId === id) body.innerHTML = previewNote("预览失败", err.message);
    }
  }

  function closePreview() {
    if ($("#preview").hidden) return;
    $("#preview").hidden = true;
    $("#preview-scrim").hidden = true;
    $("#preview-body").innerHTML = "";
    state.previewId = null;
    if ($("#file-drawer").hidden) document.body.style.overflow = "";
  }

  $("#preview-close").addEventListener("click", closePreview);
  $("#preview-scrim").addEventListener("click", closePreview);
  $("#preview-open").addEventListener("click", async () => {
    if (!state.previewId) return;
    try {
      await api("/api/open-file/" + encodeURIComponent(state.previewId), { method: "POST" });
      toast("已交给系统默认应用打开");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  /* ---------------- 文件夹操作 ---------------- */

  async function createFolder(name) {
    const parentId = state.folder !== "all" && state.folder !== "root" ? state.folder : null;
    const result = await api("/api/folders", {
      method: "POST",
      body: JSON.stringify({ name, parentId })
    });
    await load({ silent: true });
    state.folder = result.folder.id;
    renderFolders();
    renderFiles();
    return result.folder;
  }

  async function deleteFolder(id) {
    const folder = (state.folders || []).find((f) => f.id === id);
    if (!folder) return;
    askConfirm("删除文件夹", `「${folder.name}」会被删掉，里面的 ${folder.count || 0} 个文件移回收件箱，不会从磁盘删除。`, "删除", async () => {
      try {
        await api("/api/folders/" + encodeURIComponent(id), { method: "DELETE" });
        if (state.folder === id) state.folder = "all";
        await load({ silent: true });
        toast("文件夹已删除，文件已移回收件箱");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }

  async function renameFolder(id, name) {
    const folder = (state.folders || []).find((f) => f.id === id);
    if (!folder || !name.trim() || name.trim() === folder.name) return;
    try {
      await api("/api/folders/" + encodeURIComponent(id), {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim() })
      });
      await load({ silent: true });
      toast("已重命名");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  $("#folder-tree").addEventListener("click", (event) => {
    const del = event.target.closest("[data-del]");
    if (del) {
      event.stopPropagation();
      deleteFolder(del.dataset.del);
      return;
    }
    const btn = event.target.closest("[data-folder]");
    if (!btn) return;
    state.folder = btn.dataset.folder;
    renderFolders();
    renderFiles();
  });

  $("#folder-tree").addEventListener("dblclick", (event) => {
    const label = event.target.closest("[data-rename]");
    if (!label) return;
    const id = label.dataset.rename;
    if (id === "all" || id === "root") return;
    event.preventDefault();
    const input = document.createElement("input");
    input.className = "folder-rename";
    input.value = label.textContent;
    label.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      input.replaceWith(label);
      if (save && value) renameFolder(id, value);
      else renderFolders();
    };
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    });
  });

  $("#new-folder").addEventListener("click", async () => {
    const host = $("#folder-tree");
    if (!host || host.querySelector(".folder-new")) return;
    const li = document.createElement("li");
    li.className = "folder-row folder-new";
    const input = document.createElement("input");
    input.className = "folder-rename";
    input.placeholder = "新文件夹名称";
    li.appendChild(input);
    host.insertBefore(li, host.children[2] || null);
    input.focus();
    let done = false;
    const commit = async (save) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      li.remove();
      if (!save || !name) return;
      try {
        await createFolder(name);
        toast(`已新建「${name}」`);
      } catch (err) {
        toast(err.message, "error");
      }
    };
    input.addEventListener("blur", () => commit(true));
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit(true);
      if (e.key === "Escape") commit(false);
    });
  });

  /* ---------------- 移动文件 ---------------- */

  function folderOptions(selected) {
    const list = state.folders || [];
    const rows = ['<option value="">收件箱（不归档）</option>'];
    const walk = (parentId, depth) => {
      for (const folder of list.filter((f) => (f.parentId || null) === parentId)) {
        rows.push(
          '<option value="' + escapeHtml(folder.id) + '"' + (folder.id === selected ? " selected" : "") + ">" +
            "　".repeat(depth) + escapeHtml(folder.name) + "</option>"
        );
        walk(folder.id, depth + 1);
      }
    };
    walk(null, 0);
    return rows.join("");
  }

  function openMoveDialog(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    if (!list.length) return;
    state.moveIds = list;
    $("#move-sub").textContent = list.length === 1
      ? (state.files.find((f) => f.id === list[0]) || {}).name || "1 个文件"
      : `${list.length} 个文件`;
    $("#move-select").innerHTML = folderOptions(null);
    $("#move-new-name").value = "";
    const dialog = $("#move-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  $("#move-ok").addEventListener("click", async (event) => {
    event.preventDefault();
    const dialog = $("#move-dialog");
    const newName = $("#move-new-name").value.trim();
    try {
      let folderId = $("#move-select").value || null;
      if (newName) {
        const folder = await createFolder(newName);
        folderId = folder.id;
      }
      const result = await api("/api/files/move", {
        method: "POST",
        body: JSON.stringify({ ids: state.moveIds, folderId })
      });
      dialog.close();
      await load({ silent: true });
      toast(`已移动 ${result.moved} 个文件`);
    } catch (err) {
      toast(err.message, "error");
    }
  });

  /* ---------------- 预览 / 移动的点击委托 ---------------- */

  function bindFileActions(container) {
    container.addEventListener("click", (event) => {
      const act = event.target.closest("[data-act]");
      if (act) {
        event.stopPropagation();
        // 行主体点一下就是预览，这里只放「移动」和需要更多操作的「详情」
        if (act.dataset.act === "preview") openPreview(act.dataset.id);
        if (act.dataset.act === "move") openMoveDialog([act.dataset.id]);
        if (act.dataset.act === "detail") openDrawer(act.dataset.id, act.closest("[data-file]"));
        return;
      }
      const row = event.target.closest("[data-file]");
      if (row) openPreview(row.dataset.file);
    });
    container.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest("[data-file]");
      if (!row || event.target.closest("[data-act]")) return;
      event.preventDefault();
      openPreview(row.dataset.file);
    });
  }

  /* ---------------- 存储目录选择器 ---------------- */

  async function loadPicker(target) {
    const payload = await api("/api/fs/list?path=" + encodeURIComponent(target || ""));
    state.pickerPath = payload.path;
    $("#picker-path").textContent = payload.path;
    $("#picker-list").innerHTML = payload.ok
      ? payload.dirs.length
        ? payload.dirs
            .map(
              (dir) =>
                '<li><button class="picker-item" type="button" data-dir="' + escapeHtml(dir.path) + '">' +
                '<svg class="od-icon" style="--od-icon-size:14px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4.6A1.4 1.4 0 0 1 3.4 3.2h2l1.2 1.3h5A1.4 1.4 0 0 1 13 5.9v5.1a1.4 1.4 0 0 1-1.4 1.4H3.4A1.4 1.4 0 0 1 2 11V4.6Z"/></svg>' +
                escapeHtml(dir.name) + "</button></li>"
            )
            .join("")
        : '<li class="picker-empty">这个目录下没有子文件夹</li>'
      : '<li class="picker-empty">' + escapeHtml(payload.message || "读不到这个目录") + "</li>";
    $("#picker-up").disabled = !payload.parent;
    $("#picker-up").dataset.parent = payload.parent || "";
    $("#picker-home").dataset.home = payload.home || "";
    if (!payload.ok && payload.roots && payload.roots.length) {
      $("#picker-list").innerHTML = payload.roots
        .map((root) => '<li><button class="picker-item" type="button" data-dir="' + escapeHtml(root) + '">' + escapeHtml(root) + "</button></li>")
        .join("");
    }
  }

  async function openPicker(start) {
    const dialog = $("#folder-picker");
    $("#picker-list").innerHTML = '<li class="picker-empty">读取中…</li>';
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    try {
      await loadPicker(start || $("#storage-path").value.trim() || "");
    } catch (err) {
      $("#picker-list").innerHTML = '<li class="picker-empty">' + escapeHtml(err.message) + "</li>";
    }
  }

  $("#picker-list").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-dir]");
    if (btn) loadPicker(btn.dataset.dir);
  });
  $("#picker-up").addEventListener("click", () => loadPicker($("#picker-up").dataset.parent || ""));
  $("#picker-home").addEventListener("click", () => loadPicker($("#picker-home").dataset.home || ""));
  $("#picker-close").addEventListener("click", () => $("#folder-picker").close());
  $("#picker-cancel").addEventListener("click", () => $("#folder-picker").close());
  $("#picker-choose").addEventListener("click", () => {
    if (state.pickerPath) $("#storage-path").value = state.pickerPath;
    $("#folder-picker").close();
  });
  $("#picker-mkdir").addEventListener("click", async () => {
    const name = $("#picker-new-name").value.trim();
    if (!name) return;
    try {
      const result = await api("/api/fs/mkdir", {
        method: "POST",
        body: JSON.stringify({ path: state.pickerPath, name })
      });
      $("#picker-new-name").value = "";
      await loadPicker(result.path);
      toast("文件夹已创建");
    } catch (err) {
      toast(err.message, "error");
    }
  });
  $("#browse-path").addEventListener("click", () => openPicker($("#storage-path").value.trim()));

  /* ---------------- Skill 面板 ---------------- */

  function renderSkill() {
    const skill = (state.data && state.data.skill) || {};
    $("#skill-endpoint").textContent = skill.endpoint || "—";
    const token = skill.token || "";
    $("#skill-token").textContent = token ? token.slice(0, 6) + "••••••••••••" + token.slice(-4) : "—";
    $("#skill-token").dataset.token = token;
    $("#skill-state").textContent = token ? "已就绪" : "未生成";
    $("#skill-cmd").textContent =
      "landrop search \"季度\"\nlandrop plan --preset kind\nlandrop apply --preset kind";
  }

  $("#copy-skill-token").addEventListener("click", async () => {
    const token = $("#skill-token").dataset.token || "";
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      toast("令牌已复制");
    } catch {
      toast("复制失败，请手动选择", "error");
    }
  });

  $("#copy-skill-endpoint").addEventListener("click", async () => {
    const value = $("#skill-endpoint").textContent || "";
    try {
      await navigator.clipboard.writeText(value);
      toast("接口地址已复制");
    } catch {
      toast("复制失败，请手动选择", "error");
    }
  });

  $("#rotate-skill-token").addEventListener("click", () => {
    askConfirm("重置 Skill 令牌", "重置后，已经配置旧令牌的 WorkBuddy 需要重新填写。", "重置", async () => {
      try {
        const result = await api("/api/settings", { method: "POST", body: JSON.stringify({ rotateSkillToken: true }) });
        if (state.data && state.data.skill) state.data.skill.token = result.skillToken;
        renderSkill();
        toast("令牌已重置");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });

  $("#download-skill").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = "/api/skill/package";
    a.download = "landrop-skill.zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  $("#preview-plan").addEventListener("click", async () => {
    try {
      const plan = await api("/api/skill/plan?preset=kind");
      if (!plan.steps.length) {
        toast("没有需要整理的文件");
        return;
      }
      const lines = plan.steps.map((s) => `${s.folder}：${s.count} 个（如 ${(s.sample || []).slice(0, 2).join("、")}）`).join("\n");
      askConfirm("按类型整理", `会移动 ${plan.total} 个文件：\n\n${lines}\n\n确认后立即执行。`, "执行整理", async () => {
        try {
          const result = await api("/api/skill/apply", {
            method: "POST",
            body: JSON.stringify({ preset: "kind" })
          });
          await load({ silent: true });
          toast(`已整理 ${result.moved} 个文件`);
        } catch (err) {
          toast(err.message, "error");
        }
      });
    } catch (err) {
      toast(err.message, "error");
    }
  });

  function renderAll() {
    renderStats();
    renderStorage();
    renderPairing();
    renderReceive();
    renderFolders();
    renderFiles();
    renderActivity();
    renderShares();
    renderShareOptions();
    renderDeviceMini();
    renderDevices();
    renderSkill();
    renderDrive();
    renderAbout();
  }

  /* ---------------- 连接入口（手机 / 分享盘 / App） ---------------- */

  function entryPayload(name) {
    const pairing = state.pairing || {};
    if (name === "drive") {
      const drive = state.drive || {};
      return {
        qr: drive.qrUrl || "/qr.svg?data=landrop",
        label: "分享盘",
        code: drive.enabled ? "扫码即进" : "未开启",
        empty: !drive.enabled,
        url: drive.enabled ? String(drive.url || "").replace(/^https?:\/\//, "") : "开启后生成",
        href: drive.enabled ? drive.url : "#",
        checkable: false,
        hint: drive.enabled
          ? "链接长期有效，随时可以在共享页换新链接。"
          : "在「共享」页打开开关，别人就能扫码进这个盘。"
      };
    }
    if (name === "app") {
      return {
        qr: pairing.appQrUrl || "/qr.svg?data=landrop",
        label: "App 版",
        code: pairing.code ? `${String(pairing.code).slice(0, 3)} ${String(pairing.code).slice(3)}` : "— — —",
        empty: !pairing.code,
        url: pairing.appUrl ? String(pairing.appUrl).replace(/^https?:\/\//, "") : "—",
        href: pairing.appUrl || "#",
        checkable: true,
        hint: "可添加到手机主屏，还能接收电脑推送。同一个配对码。"
      };
    }
    return {
      qr: pairing.qrUrl || "/qr.svg?data=landrop",
      label: "配对码",
      code: pairing.code ? `${String(pairing.code).slice(0, 3)} ${String(pairing.code).slice(3)}` : "— — —",
      empty: !pairing.code,
      url: pairing.url ? String(pairing.url).replace(/^https?:\/\//, "") : "—",
      href: pairing.url || "#",
      checkable: true,
      hint: "二维码与配对码 24 小时后失效。手机关掉页面后文件仍留在这台电脑。"
    };
  }

  function renderEntry() {
    const payload = entryPayload(state.entry);
    $("#qr").src = payload.qr;
    $("#pair-label").textContent = payload.label;
    const code = $("#pair-code");
    code.textContent = payload.code;
    code.classList.toggle("is-empty", payload.empty);
    $("#qr-caption").textContent = state.entry === "drive"
      ? (state.drive && state.drive.enabled ? "让别人扫这里" : "先在共享页开启")
      : "扫码连接";
    $("#pair-url").textContent = payload.url;
    $("#open-web-2").href = payload.href;
    $("#open-web-2").textContent = state.entry === "drive" ? "打开分享盘" : "打开网页版";
    $("#copy-code").hidden = state.entry === "drive";
    $("#refresh-code").hidden = state.entry === "drive";
    $("#pair-hint").textContent = payload.hint;
    $$("[data-entry]").forEach((btn) => {
      const active = btn.dataset.entry === state.entry;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", String(active));
    });
  }

  $("#pair-panel").addEventListener("click", (event) => {
    const tab = event.target.closest("[data-entry]");
    if (!tab) return;
    state.entry = tab.dataset.entry;
    renderEntry();
  });

  /* ---------------- 分享盘 ---------------- */

  function driveRow(file) {
    return (
      '<li class="drive-row"><span class="drive-row-main">' +
      '<span class="drive-row-name">' + escapeHtml(file.name) + "</span>" +
      '<span class="drive-row-meta">' + escapeHtml(formatSize(file.size)) + " · " + escapeHtml(shortTime(file.createdAt)) + "</span>" +
      '</span><span class="drive-row-actions">' +
      '<button class="btn btn-ghost btn-sm" type="button" data-drive-open="' + escapeHtml(file.id) + '">预览</button>' +
      '<button class="btn btn-quiet btn-sm" type="button" data-drive-remove="' + escapeHtml(file.id) + '">移出</button>' +
      "</span></li>"
    );
  }

  function pendingRow(item) {
    return (
      '<li class="pending-row"><span class="pending-row-main">' +
      '<span class="pending-row-name">' + escapeHtml(item.name) + "</span>" +
      '<span class="pending-row-meta">来自 ' + escapeHtml(item.from || "访客") + " · " + escapeHtml(formatSize(item.size)) + " · " + escapeHtml(relativeTime(item.at)) + "</span>" +
      '</span><span class="pending-row-actions">' +
      '<button class="btn btn-primary btn-sm" type="button" data-pickup="' + escapeHtml(item.id) + '">收下</button>' +
      '<button class="btn btn-quiet btn-sm" type="button" data-discard="' + escapeHtml(item.id) + '">丢弃</button>' +
      "</span></li>"
    );
  }

  function renderDrive() {
    const drive = state.drive;
    if (!drive) return;
    $("#drive-panel").hidden = false;
    $("#drive-enabled").checked = drive.enabled;
    $("#drive-switch-text").textContent = drive.enabled ? "已开启" : "已关闭";
    $("#drive-body").classList.toggle("is-off", !drive.enabled);
    $("#drive-qr").src = drive.qrUrl || "/qr.svg?data=landrop";
    if (document.activeElement !== $("#drive-name")) $("#drive-name").value = drive.name || "";
    if (document.activeElement !== $("#drive-note")) $("#drive-note").value = drive.note || "";
    $("#drive-url").textContent = drive.url ? String(drive.url).replace(/^https?:\/\//, "") : "—";
    $("#drive-browse").checked = drive.allowBrowse;
    $("#drive-upload").checked = drive.allowUpload;

    const files = drive.files || [];
    $("#drive-files-count").textContent = files.length + " 个";
    $("#drive-files").innerHTML = files.length
      ? files.map(driveRow).join("")
      : '<li class="drive-empty">盘里还没有文件。下面选一个放进去，扫码的人就能下载了。</li>';

    const select = $("#drive-add-select");
    const options = state.files.filter((f) => !files.some((d) => d.id === f.id));
    select.innerHTML = options.length
      ? options.map((f) => '<option value="' + escapeHtml(f.id) + '">' + escapeHtml(f.name) + " · " + escapeHtml(formatSize(f.size)) + "</option>").join("")
      : '<option value="">没有可以再放进去的文件</option>';
    select.disabled = !options.length;
    $("#drive-add").disabled = !options.length;

    const pending = drive.pending || [];
    $("#drive-pending-count").textContent = pending.length + " 个";
    $("#pickup-all").hidden = pending.length === 0;
    $("#drive-pending").innerHTML = pending.length
      ? pending.map(pendingRow).join("")
      : '<li class="drive-empty">暂时没有人往盘里传东西。</li>';

    const tab = $('[data-entry="drive"] #drive-tab-sub') || document.getElementById("drive-tab-sub");
    if (tab) tab.textContent = drive.enabled ? "已开启" : "未开启";
    renderEntry();
  }

  async function patchDrive(patch) {
    try {
      const result = await api("/api/drive", { method: "POST", body: JSON.stringify(patch) });
      state.drive = result.drive;
      renderDrive();
      return result.drive;
    } catch (err) {
      toast(err.message, "error");
      return null;
    }
  }

  $("#drive-enabled").addEventListener("change", async (event) => {
    const drive = await patchDrive({ enabled: event.target.checked });
    if (drive) toast(drive.enabled ? "分享盘已开启，可以让别人扫码了" : "分享盘已关闭");
  });

  $("#drive-save").addEventListener("click", async () => {
    const drive = await patchDrive({
      name: $("#drive-name").value.trim(),
      note: $("#drive-note").value.trim(),
      allowBrowse: $("#drive-browse").checked,
      allowUpload: $("#drive-upload").checked
    });
    if (drive) toast("分享盘设置已保存");
  });

  $("#drive-browse").addEventListener("change", (e) => {
    if (!e.target.checked && $("#drive-upload").checked) {
      $("#drive-upload").checked = false;
    }
  });

  $("#copy-drive").addEventListener("click", async () => {
    const url = state.drive && state.drive.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast("分享盘链接已复制");
    } catch {
      toast("复制失败，请手动选择", "error");
    }
  });

  $("#rotate-drive").addEventListener("click", () => {
    askConfirm("换一个新链接", "旧链接会立刻失效，已经保存过旧链接的人需要重新扫码。盘里的文件不受影响。", "换新链接", async () => {
      await patchDrive({ rotate: true });
      toast("已生成新链接");
    });
  });

  $("#drive-add").addEventListener("click", async () => {
    const id = $("#drive-add-select").value;
    if (!id) return;
    try {
      const result = await api("/api/drive/files", { method: "POST", body: JSON.stringify({ ids: [id] }) });
      state.drive = result.drive;
      renderDrive();
      toast("已放进分享盘");
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("#drive-body").addEventListener("click", async (event) => {
    const open = event.target.closest("[data-drive-open]");
    if (open) {
      openPreview(open.dataset.driveOpen);
      return;
    }
    const remove = event.target.closest("[data-drive-remove]");
    if (remove) {
      try {
        const result = await api("/api/drive/files/" + encodeURIComponent(remove.dataset.driveRemove), { method: "DELETE" });
        state.drive = result.drive;
        renderDrive();
      } catch (err) {
        toast(err.message, "error");
      }
      return;
    }
    const pickup = event.target.closest("[data-pickup]");
    if (pickup) {
      await pickupPending([pickup.dataset.pickup]);
      return;
    }
    const discard = event.target.closest("[data-discard]");
    if (discard) {
      try {
        const result = await api("/api/pending/" + encodeURIComponent(discard.dataset.discard), { method: "DELETE" });
        state.drive = result.drive;
        renderDrive();
        toast("已丢弃");
      } catch (err) {
        toast(err.message, "error");
      }
    }
  });

  async function pickupPending(ids) {
    try {
      const result = await api("/api/drive/pickup", { method: "POST", body: JSON.stringify({ ids: ids || null }) });
      state.drive = result.drive;
      await load({ silent: true });
      if (result.picked && result.picked.length) {
        toast(result.picked.length === 1 ? `已收下 ${result.picked[0].name}` : `已收下 ${result.picked.length} 个文件`);
      }
      if (result.failed && result.failed.length) toast(`${result.failed.length} 个文件没能收下`, "error");
    } catch (err) {
      toast(err.message, "error");
    }
  }

  $("#pickup-all").addEventListener("click", () => pickupPending(null));

  /* ---------------- 关于与更新 ---------------- */

  const UPDATE_LABEL = {
    idle: "未检查",
    checking: "检查中",
    uptodate: "已是最新",
    available: "可更新",
    downloading: "下载中",
    installing: "正在安装",
    error: "检查失败"
  };

  function renderAbout() {
    const info = state.app || {};
    const update = info.update || {};
    $("#app-version").textContent = info.version ? "v" + info.version : "—";

    const chip = $("#update-chip");
    const label = UPDATE_LABEL[update.status] || "未检查";
    chip.textContent = update.available ? `${label} v${update.available}` : label;
    chip.dataset.state = update.status || "idle";

    $("#update-channel").textContent = info.desktop
      ? "GitHub Releases · 安装版自动更新"
      : "浏览器模式 · 不支持自动更新";
    $("#update-when").textContent = update.checkedAt
      ? relativeTime(new Date(update.checkedAt * 1000).toISOString())
      : "未检查";

    const hint = $("#update-hint");
    if (update.status === "available") {
      hint.textContent =
        `发现新版本 v${update.available}：右键任务栏托盘图标，点「安装更新 v${update.available}」即可下载并重启。` +
        (update.notes ? ` 更新说明：${update.notes}` : "");
    } else if (update.status === "error") {
      hint.textContent = `检查更新失败：${update.message || "网络不可达"}。可以先到发布页下载新版本覆盖安装。`;
    } else if (!info.desktop) {
      hint.textContent = "当前是通过浏览器访问的后端服务，没有桌面壳，所以不会自动更新。安装桌面版后才有更新通道。";
    } else {
      hint.textContent =
        "自动更新只对安装版生效。右键任务栏托盘图标可以看到「检查更新」；发现新版本后同一位置会变成「安装更新 vX.Y.Z」，点击即下载并重启。";
    }
  }

  $("#copy-releases").addEventListener("click", async () => {
    const url = (state.app && state.app.repo) || "https://github.com/SteveLaiTVT/landrop/releases";
    try {
      await navigator.clipboard.writeText(url + "/releases");
      toast("发布页地址已复制");
    } catch {
      toast("复制失败，请手动选择", "error");
    }
  });

  /* ---------------- settings ---------------- */

  const settingInputs = {
    storageDir: () => $("#storage-path"),
    port: () => $("#port"),
    lanOnly: () => $("#set-lan"),
    allowWriteShares: () => $("#set-write"),
    notifyOnUpload: () => $("#set-notify"),
    keepAwake: () => $("#set-awake"),
    autoStart: () => $("#set-autostart")
  };

  function renderSettings() {
    const s = state.settings || {};
    for (const [key, get] of Object.entries(settingInputs)) {
      const el = get();
      if (!el) continue;
      if (el.type === "checkbox") el.checked = Boolean(s[key]);
      else el.value = s[key] == null ? "" : s[key];
    }
    const portHint = $("#port-hint");
    if (s.pendingPort) {
      portHint.textContent = `端口已改为 ${s.pendingPort}，重启 LanDrop 后生效。`;
    } else {
      portHint.textContent = "手机端通过当前局域网地址访问。修改端口后需要重启 LanDrop 才生效。";
    }
    setWritePermissionState();
  }

  function collectSettings() {
    return {
      storageDir: $("#storage-path").value.trim(),
      port: Number($("#port").value.trim()),
      lanOnly: $("#set-lan").checked,
      allowWriteShares: $("#set-write").checked,
      notifyOnUpload: $("#set-notify").checked,
      keepAwake: $("#set-awake").checked,
      autoStart: $("#set-autostart").checked
    };
  }

  function bindSettingsDefaults() {
    const notify = $("#set-notify");
    notify.addEventListener("change", async () => {
      if (notify.checked && "Notification" in window && Notification.permission === "default") {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          notify.checked = false;
          toast("系统通知未授权，可在浏览器地址栏左侧重新开启", "error");
        }
      }
    });
  }

  async function saveSettings(payload, { silent = false } = {}) {
    try {
      const result = await api("/api/settings", { method: "POST", body: JSON.stringify(payload) });
      state.settings = { ...state.settings, ...result.settings };
      renderSettings();
      setWritePermissionState();
      await load({ silent: true });
      if (result.restartRequired) {
        toast(`设置已保存。端口改为 ${result.settings.port}，重启后生效`, "error");
      } else if (!silent) {
        toast("设置已保存");
      }
      return result;
    } catch (err) {
      toast(err.message, "error");
      throw err;
    }
  }

  /* ---------------- uploads ---------------- */

  function addReceivingRow(file) {
    const ext = (file.name.split(".").pop() || "").toUpperCase();
    const meta = {
      name: file.name,
      id: "",
      kind: /^(JPG|JPEG|PNG|GIF|WEBP|HEIC|HEIF)$/.test(ext) ? "img"
        : ext === "PDF" ? "pdf"
        : /^(ZIP|RAR|7Z|GZ|TAR)$/.test(ext) ? "zip"
        : /^(XLS|XLSX|CSV)$/.test(ext) ? "sheet"
        : /^(MP3|WAV|M4A|FLAC)$/.test(ext) ? "audio"
        : /^(MP4|MOV|MKV|WEBM)$/.test(ext) ? "video" : "doc",
      ext: ext.slice(0, 4) || "FILE",
      size: file.size,
      source: "本机",
      dateLabel: "今天 刚刚"
    };
    const li = document.createElement("li");
    li.className = "rx-row";
    li.innerHTML =
      '<span class="ftype" data-kind="' + meta.kind + '" aria-hidden="true">' + escapeHtml(meta.ext) + "</span>" +
      '<div class="rx-main"><span class="rx-name">' + escapeHtml(file.name) + "</span>" +
      '<span class="rx-meta">来自本机 · 正在写入存储目录</span></div>' +
      '<div class="rx-side"><span class="rx-size mono">' + formatSize(file.size) + "</span>" +
      '<div class="rx-bar"><span></span></div><span class="rx-status">0%</span></div>';
    const list = $("#receive-list");
    const empty = list.querySelector(".mini-empty");
    if (empty) empty.remove();
    list.prepend(li);
    $("#receive-count").textContent = list.querySelectorAll(".rx-row").length + " 个文件";
    return li;
  }

  function updateRow(row, percent) {
    const bar = row.querySelector(".rx-bar span");
    const status = row.querySelector(".rx-status");
    if (bar) bar.style.width = percent + "%";
    if (status) status.textContent = percent >= 100 ? "已保存" : percent + "%";
    if (percent >= 100 && status) status.classList.add("is-done");
  }

  async function acquireWakeLock() {
    if (!state.settings.keepAwake || !("wakeLock" in navigator) || state.wakeLock) return;
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      state.wakeLock = null;
    }
  }

  function releaseWakeLock() {
    if (state.wakeLock) {
      state.wakeLock.release().catch(() => {});
      state.wakeLock = null;
    }
  }

  function uploadOne(file, row) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", "/api/upload?name=" + encodeURIComponent(file.name));
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) updateRow(row, Math.round((event.loaded / event.total) * 100));
      };
      xhr.onload = () => {
        state.activeUploads = Math.max(0, state.activeUploads - 1);
        if (xhr.status >= 200 && xhr.status < 300) {
          updateRow(row, 100);
          const meta = row.querySelector(".rx-meta");
          if (meta) meta.textContent = "来自本机 · 已保存";
          toast("已接收「" + file.name + "」");
          load({ silent: true });
        } else {
          let message = "上传失败";
          try { message = JSON.parse(xhr.responseText).message || message; } catch { /* ignore */ }
          row.querySelector(".rx-status").textContent = "失败";
          row.querySelector(".rx-status").style.color = "var(--danger)";
          toast(message, "error");
        }
        if (!state.activeUploads) releaseWakeLock();
        resolve();
      };
      xhr.onerror = () => {
        state.activeUploads = Math.max(0, state.activeUploads - 1);
        row.querySelector(".rx-status").textContent = "失败";
        toast("上传中断，请检查网络", "error");
        if (!state.activeUploads) releaseWakeLock();
        resolve();
      };
      state.activeUploads += 1;
      acquireWakeLock();
      xhr.send(file);
    });
  }

  async function handleFiles(list) {
    const files = Array.from(list || []);
    if (!files.length) return;
    for (const file of files) {
      if (!file.size) {
        toast(`「${file.name}」是空文件，已跳过`, "error");
        continue;
      }
      const row = addReceivingRow(file);
      uploadOne(file, row);
    }
  }

  const fileInput = $("#file-input");
  const dropzone = $("#dropzone");
  $$("[data-pick]").forEach((btn) => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    fileInput.click();
  }));
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("is-over");
    });
  });
  ["dragleave", "dragend", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt !== "drop") dropzone.classList.remove("is-over");
    });
  });
  dropzone.addEventListener("drop", (e) => {
    dropzone.classList.remove("is-over");
    handleFiles(e.dataTransfer.files);
  });
  fileInput.addEventListener("change", () => {
    handleFiles(fileInput.files);
    fileInput.value = "";
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  /* ---------------- drawer ---------------- */

  let drawerTrigger = null;

  function currentDrawerFile() {
    return state.files.find((f) => f.id === state.drawerId) || null;
  }

  function renderDrawerHistory(file) {
    const records = state.activity.filter((a) => a.fileId === file.id);
    const rows = records.map((a) =>
      "<li><time>" + escapeHtml(shortTime(a.ts)) + "</time><span><strong>" + escapeHtml(ACT_VERB[a.type] || a.type) +
      "</strong> · " + escapeHtml(a.device || "—") + "</span></li>"
    ).join("");
    $("#drawer-history").innerHTML = rows + '<li><time>—</time><span>保存在 <strong>' + escapeHtml(shortPath(state.storage.dir)) + "</strong></span></li>";
  }

  function openDrawer(id, trigger) {
    const file = state.files.find((f) => f.id === id);
    if (!file) return;
    state.drawerId = id;
    drawerTrigger = trigger || null;
    $("#drawer-badge").textContent = file.ext || "FILE";
    $("#drawer-badge").dataset.kind = file.kind || "doc";
    $("#drawer-name").textContent = file.name;
    $("#drawer-sub").textContent = "保存在存储目录 · 局域网内可共享";
    $("#drawer-size").textContent = formatSize(file.size);
    $("#drawer-time").textContent = timeLabel(file.createdAt);
    $("#drawer-source").textContent = file.source || "未知";
    $("#drawer-via").textContent = file.via || "传输";
    $("#drawer-download").onclick = () => {
      const a = document.createElement("a");
      a.href = file.downloadUrl;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    $("#drawer-preview").onclick = () => {
      closeDrawer();
      openPreview(id);
    };
    $("#drawer-path").textContent =
      (folderName(file.folderId) ? folderPath(file.folderId) + " · " : "") + shortPath(state.storage.dir);
    renderDrawerHistory(file);
    $("#file-drawer").hidden = false;
    $("#drawer-scrim").hidden = false;
    document.body.style.overflow = "hidden";
    $("#drawer-close").focus();
  }

  function closeDrawer() {
    if ($("#file-drawer").hidden) return;
    $("#file-drawer").hidden = true;
    $("#drawer-scrim").hidden = true;
    document.body.style.overflow = "";
    state.drawerId = null;
    if (drawerTrigger) drawerTrigger.focus();
    drawerTrigger = null;
  }

  bindFileActions($("#batch-list"));
  $("#receive-list").addEventListener("click", (e) => {
    const row = e.target.closest("[data-file]");
    if (row) openPreview(row.dataset.file);
  });
  $("#drawer-scrim").addEventListener("click", closeDrawer);
  $("#drawer-close").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#preview").hidden) {
      closePreview();
      return;
    }
    if (!$("#file-drawer").hidden) closeDrawer();
  });
  function openSendBox() {
    const file = currentDrawerFile();
    if (!file) return;
    // 网页版与 App 版都能收推送：只要对方页面开着，SSE 会立刻把文件推过去
    const targets = state.devices.filter((d) => !d.self);
    const select = $("#send-target");
    if (!targets.length) {
      $("#send-note").textContent = "现在没有在线的设备。让手机扫码打开网页版，这里就会出现可推送的设备。";
      select.innerHTML = '<option value="">暂无可推送设备</option>';
      select.disabled = true;
      $("#send-confirm").disabled = true;
    } else {
      $("#send-note").textContent = "对方手机上会立刻出现这条文件，点一下就存到手机。推送只在对方页面打开时可达。";
      select.innerHTML = targets
        .map((d) => '<option value="' + escapeHtml(d.id) + '">' + escapeHtml(d.name) + (d.online ? " · 在线" : " · 离线") + "</option>")
        .join("");
      select.disabled = false;
      $("#send-confirm").disabled = false;
    }
    $("#send-box").hidden = false;
    $("#send-target").focus();
  }

  $("#drawer-send").addEventListener("click", openSendBox);
  $("#send-cancel").addEventListener("click", () => { $("#send-box").hidden = true; });

  $("#send-confirm").addEventListener("click", async () => {
    const file = currentDrawerFile();
    const deviceId = $("#send-target").value;
    if (!file || !deviceId) return;
    const target = state.devices.find((d) => d.id === deviceId);
    try {
      await api("/api/send", { method: "POST", body: JSON.stringify({ fileId: file.id, deviceId }) });
      $("#send-box").hidden = true;
      toast("已发送到 " + (target ? target.name : "手机") + "，对方手机上会收到");
      load({ silent: true });
    } catch (err) {
      toast(err.message, "error");
    }
  });

  $("#drawer-share").addEventListener("click", () => {
    const file = currentDrawerFile();
    if (!file) return;
    closeDrawer();
    setView("share");
    $("#share-file").value = file.id;
    $("#share-file").focus();
    toast("选择有效期后即可生成链接");
  });
  $("#drawer-delete").addEventListener("click", () => {
    const file = currentDrawerFile();
    if (!file) return;
    askConfirm("删除这个文件？", "「" + file.name + "」将从存储目录中删除，此操作不可撤销。", "删除文件", async () => {
      try {
        await api("/api/files/" + encodeURIComponent(file.id), { method: "DELETE" });
        closeDrawer();
        await load({ silent: true });
        toast("已删除「" + file.name + "」");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });

  /* ---------------- search & sort ---------------- */

  $("#global-search").addEventListener("input", (e) => {
    state.query = e.target.value;
    if (state.query && $('[data-panel="files"]').hidden) setView("files");
    renderFiles();
  });
  $("#global-search").addEventListener("focus", () => {
    if ($('[data-panel="files"]').hidden && !state.query) setView("files");
  });
  $("#sort-select").addEventListener("change", (e) => {
    state.sort = e.target.value;
    renderFiles();
  });

  /* ---------------- pairing ---------------- */

  $("#pair-btn").addEventListener("click", () => setView("overview", { scrollPair: true }));
  $("#copy-addr").addEventListener("click", () => copyText(`http://${state.network.ip}:${state.network.port}`, "局域网地址已复制"));
  $("#copy-web").addEventListener("click", () => copyText(state.pairing.url, "网页版地址已复制"));
  $("#copy-code").addEventListener("click", () => copyText(String(state.pairing.code), "配对码已复制"));
  $("#refresh-code").addEventListener("click", () => {
    askConfirm("刷新配对码？", "刷新后旧的二维码和配对码会立即失效，已经连上的手机会断开。", "刷新", async () => {
      try {
        const result = await api("/api/pair/rotate", { method: "POST" });
        await load({ silent: true });
        toast("配对码已刷新");
        return result;
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });

  /* ---------------- shares ---------------- */

  $("#share-list").addEventListener("click", (e) => {
    const copyBtn = e.target.closest("[data-copy-share]");
    const revokeBtn = e.target.closest("[data-revoke-share]");
    if (copyBtn) {
      const share = state.shares.find((s) => s.id === copyBtn.dataset.copyShare);
      if (share) copyText(share.link, "共享链接已复制");
    }
    if (revokeBtn) {
      const share = state.shares.find((s) => s.id === revokeBtn.dataset.revokeShare);
      if (!share) return;
      askConfirm("撤销这条共享？", "「" + share.name + "」的链接会立即失效，已经下载的文件不受影响。", "撤销链接", async () => {
        try {
          await api("/api/shares/" + encodeURIComponent(share.id), { method: "DELETE" });
          await load({ silent: true });
          toast("共享链接已撤销");
        } catch (err) {
          toast(err.message, "error");
        }
      });
    }
  });

  $("#share-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fileId = $("#share-file").value;
    if (!fileId) return;
    const perm = ($('input[name="perm"]:checked') || {}).value || "read";
    const expiry = $("#share-expiry").value;
    const note = $("#share-note").value.trim();
    try {
      const result = await api("/api/shares", {
        method: "POST",
        body: JSON.stringify({ fileId, perm, expiry, note })
      });
      $("#share-link-input").value = result.share.link;
      $("#share-result").classList.add("is-on");
      $("#share-note").value = "";
      await load({ silent: true });
      toast("共享链接已生成");
    } catch (err) {
      toast(err.message, "error");
    }
  });
  $("#copy-new-link").addEventListener("click", () => copyText($("#share-link-input").value, "共享链接已复制"));

  /* ---------------- devices ---------------- */

  $("#device-grid").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-remove-device]");
    if (!btn) return;
    const id = btn.dataset.removeDevice;
    const name = btn.dataset.deviceName;
    askConfirm("移除这台设备？", "「" + name + "」之后需要重新扫码才能访问这台电脑。", "移除设备", async () => {
      try {
        await api("/api/devices/" + encodeURIComponent(id), { method: "DELETE" });
        await load({ silent: true });
        toast("已移除设备");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });

  /* ---------------- settings actions ---------------- */

  $("#apply-path").addEventListener("click", async () => {
    const dir = $("#storage-path").value.trim();
    if (!dir) return toast("请填写存储目录", "error");
    const migrate = $("#migrate-on-change").checked;
    const result = await saveSettings({ storageDir: dir, migrate });
    if (result.migration) {
      const m = result.migration;
      toast(`存储位置已更新：搬过去 ${m.moved} 个文件` + (m.skipped ? `，跳过 ${m.skipped} 个同名文件` : "") + (m.failed ? `，${m.failed} 个失败` : ""));
    } else {
      toast("存储位置已更新");
    }
    $("#migrate-on-change").checked = false;
  });

  $("#save-settings").addEventListener("click", async () => {
    const payload = collectSettings();
    if (!payload.storageDir) return toast("请填写存储目录", "error");
    if (!Number.isInteger(payload.port)) return toast("端口必须是数字", "error");
    payload.migrate = $("#migrate-on-change").checked;
    await saveSettings(payload);
  });

  $("#discard-settings").addEventListener("click", async () => {
    await load({ silent: true });
    renderSettings();
    toast("已放弃本次更改");
  });

  $("#reset-key").addEventListener("click", () => {
    askConfirm("重置配对密钥？", "所有已连接的设备都会断开，需要重新扫码才能继续上传。", "重置密钥", async () => {
      try {
        await api("/api/pair/rotate", { method: "POST" });
        await load({ silent: true });
        toast("配对密钥已重置");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  });

  /* ---------------- realtime ---------------- */

  function notifyUpload(file) {
    if (!state.settings.notifyOnUpload) return;
    if (file.source === "本机") return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (!document.hidden && document.hasFocus()) return;
    try {
      const note = new Notification("LanDrop · 收到文件", {
        body: `${file.name} · ${formatSize(file.size)}`,
        icon: "/assets/icon.svg",
        tag: file.id
      });
      note.onclick = () => window.focus();
    } catch {
      /* 某些浏览器不允许页面外通知 */
    }
  }

  function connectEvents() {
    if (!("EventSource" in window)) return;
    const source = new EventSource("/api/events");
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "upload" && payload.file) notifyUpload(payload.file);
        if (payload.type === "refresh") scheduleRefresh();
      } catch {
        /* ignore */
      }
    };
    source.onerror = () => {
      /* EventSource 会自动重连 */
    };
  }

  /* ---------------- App 壳适配 ---------------- */

  // Tauri 的 WebView 不处理 target="_blank"，这些入口改交系统默认浏览器
  document.addEventListener("click", (event) => {
    const link = event.target.closest ? event.target.closest('a[target="_blank"]') : null;
    if (!link) return;
    if (!state.data || !state.data.runtime || !state.data.runtime.desktop) return;

    const href = link.getAttribute("href");
    if (!href || href === "#" || href.startsWith("javascript:")) return;

    event.preventDefault();
    let url;
    try {
      url = new URL(href, location.href).href;
    } catch {
      return;
    }
    fetch("/api/open-external", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    })
      .then((res) => {
        if (res.ok) toast("已在浏览器中打开");
        else toast("这个地址打不开", "error");
      })
      .catch(() => toast("这个地址打不开", "error"));
  });

  /* ---------------- boot ---------------- */

  renderSkeletons();
  renderSettings();
  load();
  connectEvents();
  const initialView = new URLSearchParams(location.search).get("view");
  if (initialView && VIEW_META[initialView] && initialView !== "overview") setView(initialView);
  window.addEventListener("focus", () => scheduleRefresh());
})();
