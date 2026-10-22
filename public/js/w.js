(function () {
  "use strict";

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const token = (location.pathname.split("/")[2] || "").trim();
  const state = {
    session: null,
    host: null,
    files: [],
    folders: [],
    inbox: [],
    query: "",
    folder: "all",
    previewId: null,
    maxUploadGB: 8,
    loading: true,
    refreshTimer: null,
    refreshing: false
  };

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

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    const now = new Date();
    const yesterday = new Date(now.getTime() - 86400000);
    if (sameDay(d, now)) return "今天";
    if (sameDay(d, yesterday)) return "昨天";
    if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
    return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }

  function timeLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return `${dayLabel(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function toast(message, kind) {
    const el = document.createElement("div");
    el.className = "toast" + (kind === "error" ? " is-error" : "");
    el.textContent = message;
    $("#toasts").appendChild(el);
    window.setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 180ms ease";
      window.setTimeout(() => el.remove(), 200);
    }, 2600);
  }

  function displayStorage(dir) {
    const base = String(dir || "").split(/[\\/]/).filter(Boolean).pop();
    return base ? `~/${base}` : "~/LanDrop";
  }

  function renderError(status, message) {
    const title = status === 403 ? "这台设备已被移除" : status === 410 ? "连接已失效" : "连接不上这台电脑";
    const hint = status === 410 || status === 403
      ? "请回到电脑上的 LanDrop 控制台，刷新配对码后重新扫码。"
      : "请确认手机和电脑在同一 Wi‑Fi，且电脑上的 LanDrop 仍在运行。";
    $("#app").innerHTML =
      '<header class="web-top"><div class="web-brand"><span class="app-logo" aria-hidden="true">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v9"/><path d="m8.6 9.8 3.4 3.4 3.4-3.4"/><path d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16"/></svg>' +
      '</span><strong>LanDrop</strong></div><span class="web-badge">免安装网页版</span></header>' +
      '<div class="error-card"><span class="error-icon" aria-hidden="true">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16.5v.2"/><circle cx="12" cy="12" r="9"/></svg>' +
      '</span><h1>' + title + '</h1><p>' + escapeHtml(message || hint) + '</p>' +
      '<p style="margin-top:6px">' + hint + '</p>' +
      '<a class="btn btn-ghost" href="/pair">输入配对码</a></div>';
  }

  async function load({ silent = false } = {}) {
    if (state.refreshing) return;
    state.refreshing = true;
    try {
      const res = await fetch(`/api/session/${token}`, { headers: { Accept: "application/json" } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        renderError(res.status, data.message);
        return;
      }
      applyState(data);
      if (!silent && state.loading) {
        state.loading = false;
      }
    } catch {
      if (!silent) {
        $("#live-pill").classList.add("is-off");
        $("#live-text").textContent = "连接中断";
        toast("连接中断，正在重试…", "error");
      }
    } finally {
      state.refreshing = false;
    }
  }

  function applyState(data) {
    state.host = data.host;
    state.session = data.session;
    state.files = data.files || [];
    state.folders = data.folders || [];
    state.maxUploadGB = data.maxUploadGB || 8;

    $("#host-name").textContent = data.host.name;
    $("#host-addr").textContent = `${data.host.ip}:${data.host.port}/w/${token}`;
    $("#host-storage").textContent = displayStorage(data.host.storage);
    $("#upload-hint").textContent = `原图不压缩 · 单个最大 ${state.maxUploadGB} GB`;

    const expires = new Date(data.session.expiresAt).getTime();
    const hours = Math.max(0, Math.round((expires - Date.now()) / 3600000));
    $("#session-note").textContent = hours >= 1 ? `会话还剩 ${hours} 小时` : "会话即将失效";
    $("#foot").textContent = `LanDrop web · /w/${token} · session ${hours}h`;

    $("#live-pill").classList.remove("is-off");
    $("#live-text").textContent = "已连接";
    $("#conn-net").textContent = "同一 Wi‑Fi";

    renderChips();
    renderFiles();
  }

  function folderLabel(file) {
    if (!file.folderId) return "";
    const folder = state.folders.find((f) => f.id === file.folderId);
    return folder ? folder.name : "";
  }

  function renderChips() {
    const chips = ['<button class="chip' + (state.folder === "all" ? " is-active" : "") + '" type="button" data-chip="all">全部 ' + state.files.length + "</button>"];
    const rootCount = state.files.filter((f) => !f.folderId).length;
    chips.push('<button class="chip' + (state.folder === "root" ? " is-active" : "") + '" type="button" data-chip="root">收件箱 ' + rootCount + "</button>");
    for (const folder of state.folders) {
      chips.push(
        '<button class="chip' + (state.folder === folder.id ? " is-active" : "") + '" type="button" data-chip="' + escapeHtml(folder.id) + '">' +
          escapeHtml(folder.name) + " " + (folder.count || 0) + "</button>"
      );
    }
    $("#folder-chips").innerHTML = chips.join("");
  }

  function visibleList() {
    let list = state.files.slice();
    if (state.folder !== "all") {
      const target = state.folder === "root" ? null : state.folder;
      list = list.filter((f) => (f.folderId || null) === target);
    }
    const q = state.query.trim().toLowerCase();
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      list = list.filter((f) =>
        terms.every((term) =>
          [f.name, f.source, f.via, f.ext, (f.tags || []).join(" "), folderLabel(f)].join(" ").toLowerCase().includes(term)
        )
      );
    }
    return list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  function renderFiles() {
    const list = visibleList();
    $("#file-count").textContent = list.length + " 项";

    if (!list.length) {
      $("#batches").innerHTML = state.query.trim()
        ? '<div class="empty-state"><h3>没有匹配的文件</h3><p>换个关键词试试，搜索会匹配文件名、来源、标签和文件夹。</p></div>'
        : '<div class="empty-state"><h3>这个位置还没有文件</h3><p>在电脑上拖入文件，或先用上面的按钮传一份过来。</p></div>';
      return;
    }

    const groups = [];
    for (const file of list) {
      const label = dayLabel(file.createdAt);
      let group = groups.find((g) => g.label === label);
      if (!group) {
        group = { label, files: [] };
        groups.push(group);
      }
      group.files.push(file);
    }

    $("#batches").innerHTML = groups.map((group) => {
      const rows = group.files.map((file) =>
        '<li class="web-row">' +
        '<button class="wr-open" type="button" data-preview="' + escapeHtml(file.id) + '">' +
        '<span class="ftype" data-kind="' + escapeHtml(file.kind || "doc") + '" aria-hidden="true">' + escapeHtml(file.ext || "FILE") + "</span>" +
        '<span class="wr-text"><span class="wr-name">' + escapeHtml(file.name) + "</span>" +
        '<span class="wr-meta">' + escapeHtml(file.source || "未知") + " · " + escapeHtml(timeLabel(file.createdAt)) + " · " + formatSize(file.size) +
        (folderLabel(file) ? " · " + escapeHtml(folderLabel(file)) : "") + "</span></span>" +
        "</button>" +
        '<button class="dl-btn" type="button" data-download="' + escapeHtml(file.id) + '">' +
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v9"/><path d="m8.5 10 3.5 3.5L15.5 10"/><path d="M5 16.5V19h14v-2.5"/></svg>' +
        "<span>下载</span></button></li>"
      ).join("");
      return '<section class="web-batch"><p class="web-batch-label">' + escapeHtml(group.label) +
        '<span class="mono">' + group.files.length + " / " + list.length + "</span></p>" +
        '<ul class="web-rows">' + rows + "</ul></section>";
    }).join("");
  }

  $("#folder-chips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-chip]");
    if (!chip) return;
    state.folder = chip.dataset.chip;
    renderChips();
    renderFiles();
  });

  $("#web-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderFiles();
  });

  function downloadFile(file, button) {
    const a = document.createElement("a");
    a.href = file.downloadUrl;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (button) {
      button.classList.add("is-done");
      const label = button.querySelector("span");
      if (label) label.textContent = "已下载";
      window.setTimeout(() => {
        button.classList.remove("is-done");
        if (label) label.textContent = "下载";
      }, 2400);
    }
    toast("已开始下载 · " + file.name);
  }

  $("#batches").addEventListener("click", (event) => {
    const open = event.target.closest("[data-preview]");
    if (open) {
      const file = state.files.find((f) => f.id === open.dataset.preview);
      if (file) openSheet(file);
      return;
    }
    const button = event.target.closest("[data-download]");
    if (!button) return;
    const file = state.files.find((f) => f.id === button.dataset.download);
    if (file) downloadFile(file, button);
  });

  /* ---------------- 预览 ---------------- */

  function sheetNote(title, body) {
    return '<div class="sheet-note"><strong>' + escapeHtml(title) + "</strong><p>" + escapeHtml(body) + "</p></div>";
  }

  function renderSheet(payload, file) {
    const body = $("#sheet-body");
    body.innerHTML = "";
    if (payload.type === "media") {
      if (payload.kind === "image") {
        const img = document.createElement("img");
        img.className = "sheet-media";
        img.src = file.rawUrl;
        img.alt = file.name;
        body.appendChild(img);
        return;
      }
      if (payload.kind === "video") {
        const video = document.createElement("video");
        video.className = "sheet-media";
        video.src = file.rawUrl;
        video.controls = true;
        video.playsInline = true;
        body.appendChild(video);
        return;
      }
      if (payload.kind === "audio") {
        const audio = document.createElement("audio");
        audio.className = "sheet-audio";
        audio.src = file.rawUrl;
        audio.controls = true;
        body.appendChild(audio);
        return;
      }
      if (payload.kind === "pdf") {
        const frame = document.createElement("iframe");
        frame.className = "sheet-frame";
        frame.src = file.rawUrl;
        frame.title = file.name;
        body.appendChild(frame);
        return;
      }
    }
    if (payload.type === "text") {
      const pre = document.createElement("pre");
      pre.className = "sheet-text";
      pre.textContent = payload.text;
      body.appendChild(pre);
      return;
    }
    if (payload.type === "table") {
      const rows = payload.rows || [];
      body.innerHTML =
        '<div class="sheet-table-wrap"><table class="sheet-table">' +
        rows
          .map((row, index) => "<tr>" + row.map((cell) => (index === 0 ? "<th>" : "<td>") + escapeHtml(String(cell)) + (index === 0 ? "</th>" : "</td>")).join("") + "</tr>")
          .join("") +
        "</table></div>";
      return;
    }
    if (payload.type === "doc") {
      body.innerHTML = '<div class="sheet-doc">' + (payload.paragraphs || []).map((p) => "<p>" + escapeHtml(p) + "</p>").join("") + "</div>";
      return;
    }
    if (payload.type === "slides") {
      body.innerHTML = '<div class="sheet-doc">' + (payload.slides || [])
        .map((slide) => "<h4>第 " + slide.index + " 页</h4>" + slide.lines.map((line) => "<p>" + escapeHtml(line) + "</p>").join(""))
        .join("") + "</div>";
      return;
    }
    if (payload.type === "archive") {
      body.innerHTML = '<ul class="sheet-list">' + (payload.entries || [])
        .map((e) => "<li><span>" + escapeHtml(e.name) + "</span><span class=\"mono\">" + formatSize(e.size) + "</span></li>")
        .join("") + "</ul>";
      return;
    }
    body.innerHTML = sheetNote("没法内嵌预览", payload.reason || "这个格式暂时不支持预览，可以直接下载。");
  }

  async function openSheet(file) {
    state.previewId = file.id;
    $("#sheet").hidden = false;
    $("#sheet-scrim").hidden = false;
    $("#sheet-name").textContent = file.name;
    $("#sheet-sub").textContent = formatSize(file.size) + " · " + timeLabel(file.createdAt);
    $("#sheet-body").innerHTML = sheetNote("正在解析", "稍等一下");
    $("#sheet-download").onclick = () => downloadFile(file);
    document.body.classList.add("sheet-open");
    try {
      const res = await fetch(file.previewUrl);
      const payload = await res.json();
      if (state.previewId === file.id) renderSheet(payload, file);
    } catch (err) {
      if (state.previewId === file.id) $("#sheet-body").innerHTML = sheetNote("预览失败", err.message);
    }
  }

  function closeSheet() {
    if ($("#sheet").hidden) return;
    $("#sheet").hidden = true;
    $("#sheet-scrim").hidden = true;
    $("#sheet-body").innerHTML = "";
    state.previewId = null;
    document.body.classList.remove("sheet-open");
  }

  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-scrim").addEventListener("click", closeSheet);

  /* ---------------- 电脑推送 ---------------- */

  function renderInbox() {
    const items = state.inbox || [];
    const card = $("#inbox-card");
    card.hidden = !items.length;
    if (!items.length) return;
    $("#inbox-count").textContent = items.length + " 个";
    $("#inbox-list").innerHTML = items
      .map(
        (item) =>
          '<li class="inbox-row">' +
          '<span class="ftype" data-kind="' + escapeHtml(item.kind || "doc") + '" aria-hidden="true">' + escapeHtml((item.ext || "FILE")) + "</span>" +
          '<span class="wr-text"><span class="wr-name">' + escapeHtml(item.fileName) + "</span>" +
          '<span class="wr-meta">电脑发来 · ' + escapeHtml(timeLabel(item.sentAt)) + " · " + formatSize(item.size) + "</span></span>" +
          '<button class="dl-btn" type="button" data-inbox="' + escapeHtml(item.id) + '"' + (item.receivedAt ? ' data-done="1"' : "") + ">" +
          (item.receivedAt ? "<span>已收到</span>" : "<span>保存</span>") +
          "</button></li>"
      )
      .join("");
  }

  async function loadInbox() {
    try {
      const res = await fetch(`/api/session/${token}/inbox`);
      const data = await res.json();
      if (data.ok) {
        state.inbox = data.items || [];
        renderInbox();
      }
    } catch {
      /* 网络抖动时忽略 */
    }
  }

  $("#inbox-list").addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-inbox]");
    if (!btn) return;
    const item = state.inbox.find((i) => i.id === btn.dataset.inbox);
    if (!item) return;
    const file = state.files.find((f) => f.id === item.fileId);
    if (file) downloadFile(file);
    try {
      await fetch(`/api/session/${token}/inbox/${encodeURIComponent(item.id)}/received`, { method: "POST" });
      item.receivedAt = new Date().toISOString();
      renderInbox();
    } catch {
      /* ignore */
    }
  });

  /* ---------------- upload ---------------- */

  function metaFromName(name) {
    const ext = (String(name).split(".").pop() || "").toUpperCase();
    if (["JPG", "JPEG", "PNG", "GIF", "WEBP", "HEIC", "HEIF"].includes(ext)) return { kind: "img", ext: ext === "JPEG" ? "JPG" : ext };
    if (ext === "PDF") return { kind: "pdf", ext: "PDF" };
    if (["ZIP", "RAR", "7Z", "GZ", "TAR"].includes(ext)) return { kind: "zip", ext };
    if (["XLS", "XLSX", "CSV", "NUMBERS"].includes(ext)) return { kind: "sheet", ext };
    if (["MP3", "M4A", "WAV", "FLAC"].includes(ext)) return { kind: "audio", ext };
    if (["MP4", "MOV", "MKV", "WEBM"].includes(ext)) return { kind: "video", ext };
    return { kind: "doc", ext: ext.slice(0, 4) || "FILE" };
  }

  function addItem(file) {
    const meta = metaFromName(file.name);
    const item = document.createElement("div");
    item.className = "up-item";
    item.innerHTML =
      '<span class="ftype" data-kind="' + meta.kind + '" style="width:30px;height:30px;font-size:8px" aria-hidden="true">' + escapeHtml(meta.ext) + "</span>" +
      '<div style="min-width:0"><span class="up-name">' + escapeHtml(file.name) + "</span>" +
      '<span class="up-meta"><span class="up-bar"><span></span></span><span class="up-pct">0%</span></span></div>' +
      '<span class="mono" style="font-size:10px;color:var(--ink-3);white-space:nowrap">' + formatSize(file.size) + "</span>";
    $("#progress").prepend(item);
    return item;
  }

  function uploadOne(file) {
    const item = addItem(file);
    const bar = item.querySelector(".up-bar span");
    const pct = item.querySelector(".up-pct");
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/session/${token}/upload?name=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100);
        bar.style.width = percent + "%";
        pct.textContent = percent + "%";
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          pct.textContent = "已接收";
          pct.className = "up-done";
          toast("已存到电脑 · " + file.name);
          load({ silent: true });
          window.setTimeout(() => item.remove(), 3200);
        } else {
          let message = "上传失败";
          try { message = JSON.parse(xhr.responseText).message || message; } catch { /* ignore */ }
          pct.textContent = "失败";
          pct.className = "up-fail";
          toast(message, "error");
        }
        resolve();
      };
      xhr.onerror = () => {
        pct.textContent = "失败";
        pct.className = "up-fail";
        toast("上传中断，请检查 Wi‑Fi 连接", "error");
        resolve();
      };
      xhr.send(file);
    });
  }

  $("#upload-btn").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", async () => {
    const files = Array.from($("#file-input").files || []);
    $("#file-input").value = "";
    for (const file of files) {
      if (!file.size) {
        toast(`「${file.name}」是空文件，已跳过`, "error");
        continue;
      }
      await uploadOne(file);
    }
  });

  /* ---------------- realtime ---------------- */

  function connectEvents() {
    if (!("EventSource" in window)) return;
    const source = new EventSource(`/api/session/${token}/events`);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "inbox" && payload.item) {
          state.inbox = [payload.item, ...state.inbox.filter((i) => i.id !== payload.item.id)];
          renderInbox();
          toast("电脑发来一个文件 · " + payload.item.fileName);
          if (navigator.vibrate) navigator.vibrate(40);
          return;
        }
        if (payload.type === "refresh") {
          window.clearTimeout(state.refreshTimer);
          state.refreshTimer = window.setTimeout(() => load({ silent: true }), 400);
        }
      } catch {
        /* ignore */
      }
    };
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSheet();
  });

  loadInbox();
  load();
  connectEvents();
})();
