(function () {
  "use strict";

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  const MB = 1024 * 1024;
  const PREF_KEY = "landrop.prefs.v1";

  const state = {
    ready: false,
    host: null,
    session: null,
    device: null,
    files: [],
    shares: [],
    activity: [],
    inbox: [],
    settings: { allowWriteShares: true, notifyOnUpload: true },
    maxUploadGB: 8,
    view: "home",
    query: "",
    filter: "all",
    sheetFile: null,
    refreshTimer: null,
    loading: false,
    deferredInstall: null
  };

  const prefs = loadPrefs();

  /* ---------------- helpers ---------------- */

  function loadPrefs() {
    try {
      return Object.assign(
        { notify: true, wifiOnly: true, original: true },
        JSON.parse(localStorage.getItem(PREF_KEY) || "{}")
      );
    } catch {
      return { notify: true, wifiOnly: true, original: true };
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
    } catch {
      /* 隐私模式下忽略 */
    }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[ch]));
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return "0 KB";
    if (n >= 1024 * MB) return (n / (1024 * MB)).toFixed(1) + " GB";
    if (n >= MB) return (n / MB).toFixed(1) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
  }

  function pad(n) { return String(n).padStart(2, "0"); }

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  function dayLabel(iso) {
    const d = new Date(iso);
    const now = new Date();
    if (Number.isNaN(d.getTime())) return "更早";
    if (sameDay(d, now)) return "今天";
    if (sameDay(d, new Date(now.getTime() - 86400000))) return "昨天";
    if (sameDay(d, new Date(now.getTime() - 2 * 86400000))) return "前天";
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }

  function timeLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const today = sameDay(d, new Date());
    if (today) return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function shortPath(dir) {
    const base = String(dir || "").split(/[\\/]/).filter(Boolean).pop();
    return base ? `~/${base}` : "~/LanDrop";
  }

  function toast(message) {
    const el = document.createElement("div");
    el.className = "p-toast";
    el.textContent = message;
    $("#m-toasts").appendChild(el);
    window.setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity 180ms ease";
      window.setTimeout(() => el.remove(), 200);
    }, 2600);
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
      toast(okMessage || "已复制");
    } catch {
      toast("复制失败，请长按选择文本");
    }
  }

  function fileHref(file) {
    return file.downloadUrl || `/api/app/files/${file.id}/download`;
  }

  function triggerDownload(file) {
    const a = document.createElement("a");
    a.href = fileHref(file);
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---------------- boot / errors ---------------- */

  function renderFatal(title, message, actionLabel, href) {
    const app = $("#app");
    app.innerHTML =
      '<div class="app-scroll"><div class="app-error">' +
      '<span class="app-logo" style="width:44px;height:44px;margin:0 auto 14px;display:grid;place-items:center" aria-hidden="true">' +
      '<svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.4 10 3l7 4.4v5.2L10 17l-7-4.4V7.4Z"/><path d="m3 7.4 7 4.4 7-4.4M10 11.8V17"/></svg></span>' +
      "<h1>" + escapeHtml(title) + "</h1>" +
      "<p>" + escapeHtml(message) + "</p>" +
      '<a class="btn btn-primary m-btn" href="' + escapeHtml(href || "/pair") + '">' + escapeHtml(actionLabel || "输入配对码") + "</a>" +
      "</div></div>";
  }

  async function load({ silent = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    try {
      const res = await fetch("/api/app/state", { headers: { Accept: "application/json" }, cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          renderFatal("这台手机还没配对", "先用电脑上的 LanDrop 生成二维码，或用 6 位配对码连接。", "输入配对码", "/pair");
          return;
        }
        if (res.status === 410 || res.status === 403) {
          renderFatal("连接已失效", data.message || "请回到电脑上刷新配对码，然后重新扫码。", "输入配对码", "/pair");
          return;
        }
        throw new Error(data.message || "读取失败");
      }
      applyState(data);
      state.ready = true;
    } catch (err) {
      if (!silent) {
        setLive(false, "连接中断");
        toast("连不上电脑，正在重试…");
      } else {
        setLive(false, "连接中断");
      }
    } finally {
      state.loading = false;
    }
  }

  function setLive(online, text) {
    const pill = $("#live-pill");
    if (!pill) return;
    pill.classList.toggle("is-off", !online);
    $("#live-text").textContent = text || (online ? "已连接" : "已断开");
  }

  function applyState(data) {
    state.host = data.host;
    state.session = data.session;
    state.device = data.device;
    const previousInbox = new Set(state.inbox.map((i) => i.id));
    state.files = data.files || [];
    state.shares = data.shares || [];
    state.activity = data.activity || [];
    state.inbox = data.inbox || [];
    state.settings = data.settings || state.settings;
    state.maxUploadGB = data.maxUploadGB || 8;

    setLive(true, "已连接");
    $("#host-name").textContent = data.host.name;
    $("#host-addr").textContent = `${data.host.ip}:${data.host.port}`;
    $("#storage-path").textContent = shortPath(data.host.storage);
    $("#sheet-path").textContent = shortPath(data.host.storage);
    $("#conn-net").textContent = "同一 Wi‑Fi";
    $("#upload-hint").textContent = `原图不压缩 · 单个最大 ${state.maxUploadGB} GB`;

    const expires = new Date(data.session.expiresAt).getTime();
    const hours = Math.max(0, Math.round((expires - Date.now()) / 3600000));
    $("#conn-note").textContent = `文件直接落进电脑的 ${shortPath(data.host.storage)}`;
    $("#session-line").textContent = hours >= 1
      ? `连接有效期至 ${timeLabel(data.session.expiresAt)}（还剩 ${hours} 小时）`
      : `连接即将失效 · ${timeLabel(data.session.expiresAt)}`;

    $("#d-name").textContent = data.host.name;
    $("#d-meta").textContent = `${data.host.ip} · 已连接`;

    renderIncoming(previousInbox);
    renderActivity();
    renderRecent();
    renderFiles();
    renderShareOptions();
    renderShares();
    renderPrefs();
    $("#m-write").disabled = !state.settings.allowWriteShares;
    $("#m-write").closest(".switch-row").classList.toggle("is-disabled", !state.settings.allowWriteShares);
  }

  /* ---------------- navigation ---------------- */

  function setView(name) {
    if (!["home", "files", "share", "settings"].includes(name)) return;
    state.view = name;
    $$("[data-screen]").forEach((screen) => {
      screen.classList.toggle("is-on", screen.dataset.screen === name);
    });
    $$(".tab").forEach((tab) => {
      const active = tab.dataset.go === name;
      tab.classList.toggle("is-active", active);
      if (active) tab.setAttribute("aria-current", "page");
      else tab.removeAttribute("aria-current");
    });
    $("#scroll").scrollTop = 0;
  }

  document.addEventListener("click", (event) => {
    const go = event.target.closest("[data-go]");
    if (go) setView(go.dataset.go);
  });

  /* ---------------- home ---------------- */

  function renderIncoming(previousInbox) {
    const list = $("#incoming-list");
    const empty = $("#incoming-empty");
    if (!state.inbox.length) {
      list.innerHTML = "";
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.innerHTML = state.inbox.map((item) => {
      const isNew = previousInbox ? !previousInbox.has(item.id) : false;
      return '<li data-inbox="' + escapeHtml(item.id) + '" data-file="' + escapeHtml(item.fileId) + '" role="button" tabindex="0" aria-label="保存 ' + escapeHtml(item.fileName) + '">' +
        '<span class="ftype" data-kind="' + escapeHtml(item.kind || "doc") + '" aria-hidden="true">' + escapeHtml(item.ext || "FILE") + "</span>" +
        '<span class="f-body"><span class="f-name">' + escapeHtml(item.fileName) + '</span>' +
        '<span class="f-meta">来自 ' + escapeHtml(state.host ? state.host.name : "电脑") + " · " + escapeHtml(timeLabel(item.sentAt)) + "</span></span>" +
        '<span class="in-badge' + (isNew ? " is-new" : "") + '">' + (item.receivedAt ? "已收到" : "点按保存") + "</span></li>";
    }).join("");
  }

  $("#incoming-list").addEventListener("click", async (event) => {
    const row = event.target.closest("[data-inbox]");
    if (!row) return;
    const item = state.inbox.find((i) => i.id === row.dataset.inbox);
    if (!item) return;
    const file = state.files.find((f) => f.id === item.fileId) || { id: item.fileId, name: item.fileName, downloadUrl: item.downloadUrl };
    triggerDownload(file);
    try {
      await fetch(`/api/app/inbox/${encodeURIComponent(item.id)}/received`, { method: "POST" });
      item.receivedAt = new Date().toISOString();
      renderIncoming();
    } catch {
      /* 标记失败不影响下载 */
    }
    toast("已保存 " + item.fileName);
  });

  const ACT_VERB = {
    upload: "上传",
    download: "下载",
    share: "创建共享",
    outgoing: "电脑发出",
    revoke: "撤销共享",
    delete: "删除"
  };

  function renderActivity() {
    const groups = ["今天", "昨天", "更早"];
    const buckets = new Map(groups.map((g) => [g, []]));
    for (const item of state.activity) {
      const label = dayLabel(item.ts);
      const key = groups.includes(label) ? label : "更早";
      buckets.get(key).push(item);
    }
    const html = groups.map((label) => {
      const items = buckets.get(label);
      if (!items.length) return "";
      const rows = items.map((item) =>
        '<li class="m-act-item" data-type="' + escapeHtml(item.type) + '">' +
        '<span class="m-act-dot" aria-hidden="true"></span>' +
        '<div class="m-act-text"><span class="m-act-verb">' + escapeHtml(ACT_VERB[item.type] || item.type) + "</span> " +
        "<strong>" + escapeHtml(item.fileName || "—") + "</strong>" +
        '<span class="m-act-meta">' + escapeHtml(item.device || "") + " · " + escapeHtml(timeLabel(item.ts)) + "</span></div></li>"
      ).join("");
      return '<section class="m-act-group"><p class="m-act-label">' + label + '</p><ul class="m-act-list">' + rows + "</ul></section>";
    }).join("");
    $("#m-activity").innerHTML = html || '<p class="list-note">还没有传输记录。</p>';
  }

  function fileRow(file, extra) {
    return '<li class="f-row" data-file="' + escapeHtml(file.id) + '" role="button" tabindex="0" aria-label="查看 ' + escapeHtml(file.name) + '">' +
      '<span class="ftype" data-kind="' + escapeHtml(file.kind || "doc") + '" aria-hidden="true">' + escapeHtml(file.ext || "FILE") + "</span>" +
      '<span class="f-body"><span class="f-name">' + escapeHtml(file.name) + "</span>" +
      '<span class="f-meta">' + escapeHtml(file.source || "未知") + " · " + escapeHtml(timeLabel(file.createdAt)) + " · " + formatSize(file.size) + "</span></span>" +
      (extra || '<span class="f-arrow" aria-hidden="true"><svg class="od-icon" style="--od-icon-size:14px" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg></span>') +
      "</li>";
  }

  function renderRecent() {
    const list = state.files.slice(0, 4);
    $("#m-recent").innerHTML = list.length
      ? list.map((f) => fileRow(f)).join("")
      : '<li class="list-note" style="padding:10px 4px">电脑上还没有文件。</li>';
  }

  /* ---------------- files ---------------- */

  function filteredFiles() {
    const query = state.query.trim().toLowerCase();
    return state.files.filter((file) => {
      if (state.filter !== "all" && file.kind !== state.filter) return false;
      if (!query) return true;
      return [file.name, file.source, file.via, file.ext].some((v) => String(v || "").toLowerCase().includes(query));
    });
  }

  function renderFiles() {
    const list = filteredFiles().slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const total = state.files.length;
    $("#m-files-count").textContent = total ? `${total} 项` : "0 项";

    if (!total) {
      $("#m-files").innerHTML = "";
      $("#m-empty").hidden = false;
      $("#m-empty").innerHTML = "<h3>电脑上还没有文件</h3><p>先用上面的上传按钮传一份，或在电脑上拖进 LanDrop。</p>";
      return;
    }

    if (!list.length) {
      $("#m-files").innerHTML = "";
      $("#m-empty").hidden = false;
      $("#m-empty").innerHTML = "<h3>没有匹配的文件</h3><p>换个关键词，或切换到「全部」。</p>";
      return;
    }

    $("#m-empty").hidden = true;
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
    $("#m-files").innerHTML = groups.map((group) =>
      '<section class="m-batch"><p class="m-batch-label">' + escapeHtml(group.label) +
      '<span class="mono"> ' + group.files.length + " / " + list.length + "</span></p>" +
      group.files.map((f) => fileRow(f)).join("") + "</section>"
    ).join("");
  }

  $("#m-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderFiles();
  });

  $("#m-filters").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-filter]");
    if (!chip) return;
    state.filter = chip.dataset.filter;
    $$("#m-filters .chip").forEach((item) => {
      const active = item === chip;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-pressed", String(active));
    });
    renderFiles();
  });

  /* ---------------- sheet ---------------- */

  function openSheet(file) {
    state.sheetFile = file;
    $("#sheet-badge").textContent = file.ext || "FILE";
    $("#sheet-badge").dataset.kind = file.kind || "doc";
    $("#sheet-name").textContent = file.name;
    $("#sheet-meta").textContent = (file.via || "传输") + " · " + timeLabel(file.createdAt);
    $("#sheet-size").textContent = formatSize(file.size);
    $("#sheet-source").textContent = file.source || "未知";
    $("#file-sheet").hidden = false;
    $("#sheet-scrim").hidden = false;
    $("#sheet-close").focus();
  }

  function closeSheet() {
    $("#file-sheet").hidden = true;
    $("#sheet-scrim").hidden = true;
    state.sheetFile = null;
  }

  function bindFileRows(selector) {
    const root = $(selector);
    if (!root) return;
    const handler = (event) => {
      const row = event.target.closest("[data-file]");
      if (!row || row.hasAttribute("data-inbox")) return;
      const file = state.files.find((f) => f.id === row.dataset.file);
      if (file) openSheet(file);
    };
    root.addEventListener("click", handler);
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const row = event.target.closest("[data-file]");
      if (!row) return;
      event.preventDefault();
      handler({ target: row });
    });
  }

  bindFileRows("#m-recent");
  bindFileRows("#m-files");

  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-scrim").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#file-sheet").hidden) closeSheet();
  });

  $("#sheet-download").addEventListener("click", () => {
    if (!state.sheetFile) return;
    triggerDownload(state.sheetFile);
    toast("已开始下载");
  });

  $("#sheet-share").addEventListener("click", () => {
    if (!state.sheetFile) return;
    const id = state.sheetFile.id;
    closeSheet();
    setView("share");
    $("#m-share-file").value = id;
    toast("选择有效期后即可生成链接");
  });

  /* ---------------- upload ---------------- */

  function addUploadRow(file) {
    const ext = (file.name.split(".").pop() || "FILE").toUpperCase().slice(0, 4);
    const row = document.createElement("div");
    row.className = "up-item";
    row.innerHTML =
      '<span class="ftype" aria-hidden="true">' + escapeHtml(ext) + "</span>" +
      '<div style="min-width:0"><span class="up-name">' + escapeHtml(file.name) + "</span>" +
      '<span class="up-meta"><span class="up-bar"><span></span></span><span class="up-pct">0%</span></span></div>' +
      '<span class="mono" style="font-size:10px;color:var(--ink-3);white-space:nowrap">' + formatSize(file.size) + "</span>";
    $("#progress").prepend(row);
    return row;
  }

  function uploadOne(file) {
    const row = addUploadRow(file);
    const bar = $(".up-bar span", row);
    const pct = $(".up-pct", row);
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", "/api/app/upload?name=" + encodeURIComponent(file.name));
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
          window.setTimeout(() => row.remove(), 3200);
        } else {
          let message = "上传失败";
          try { message = JSON.parse(xhr.responseText).message || message; } catch { /* ignore */ }
          pct.textContent = "失败";
          pct.className = "up-pct up-fail";
          toast(message);
          window.setTimeout(() => row.remove(), 4000);
        }
        resolve();
      };
      xhr.onerror = () => {
        pct.textContent = "失败";
        toast("上传中断，请检查 Wi‑Fi 连接");
        resolve();
      };
      xhr.send(file);
    });
  }

  $("#upload-btn").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", async () => {
    const files = Array.from($("#file-input").files || []);
    $("#file-input").value = "";
    if (!files.length) return;
    if (prefs.wifiOnly && navigator.connection && navigator.connection.type === "cellular") {
      toast("当前是蜂窝网络，已在设置里关闭「仅 Wi‑Fi 上传」后再试");
      return;
    }
    for (const file of files) {
      await uploadOne(file);
    }
  });

  /* ---------------- share ---------------- */

  function renderShareOptions() {
    const select = $("#m-share-file");
    const current = select.value;
    select.innerHTML = state.files.length
      ? state.files.map((f) => '<option value="' + escapeHtml(f.id) + '">' + escapeHtml(f.name) + " · " + formatSize(f.size) + "</option>").join("")
      : '<option value="">电脑上还没有文件</option>';
    if (current && state.files.some((f) => f.id === current)) select.value = current;
  }

  function shareCard(share) {
    return '<article class="share-item" data-share="' + escapeHtml(share.id) + '">' +
      '<div class="si-top"><span class="ftype" data-kind="' + escapeHtml(share.kind || "doc") + '" aria-hidden="true">' + escapeHtml(share.ext || "FILE") + "</span>" +
      '<div style="min-width:0"><p class="si-name">' + escapeHtml(share.name) + "</p>" +
      '<p class="si-meta">' + (share.perm === "write" ? "可写入" : "只读") + " · " +
      (share.expiry === "forever" ? "永久有效" : "到期 " + timeLabel(share.expiresAt)) + " · 已下载 " + (share.downloads || 0) + " 次</p></div></div>" +
      '<span class="si-link">' + escapeHtml(share.link) + "</span>" +
      '<div class="si-actions"><button class="si-btn" type="button" data-copy="' + escapeHtml(share.id) + '">复制链接</button></div>' +
      "</article>";
  }

  function renderShares() {
    $("#m-share-count").textContent = state.shares.length ? state.shares.length + " 个链接" : "0 个链接";
    $("#m-shares").innerHTML = state.shares.length
      ? state.shares.map(shareCard).join("")
      : '<p class="list-note">还没有共享链接。选一个文件，生成第一条。</p>';
  }

  $("#m-shares").addEventListener("click", (event) => {
    const btn = event.target.closest("[data-copy]");
    if (!btn) return;
    const share = state.shares.find((s) => s.id === btn.dataset.copy);
    if (share) copyText(share.link, "共享链接已复制");
  });

  $("#m-copy").addEventListener("click", () => copyText($("#m-link").value, "共享链接已复制"));

  $("#m-share-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const fileId = $("#m-share-file").value;
    if (!fileId) {
      toast("电脑上还没有可以共享的文件");
      return;
    }
    const expiry = (document.querySelector('input[name="m-expiry"]:checked') || {}).value || "24h";
    const perm = $("#m-write").checked && state.settings.allowWriteShares ? "write" : "read";
    const submit = $("#m-share-submit");
    submit.disabled = true;
    try {
      const res = await fetch("/api/app/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileId, perm, expiry })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "生成失败");
      $("#m-link").value = data.share.link;
      $("#m-link-meta").textContent =
        (expiry === "1h" ? "1 小时后失效" : expiry === "7d" ? "7 天后失效" : "24 小时后失效") +
        " · " + (perm === "write" ? "可写入" : "只读");
      $("#m-result").hidden = false;
      toast("共享链接已生成");
      load({ silent: true });
    } catch (err) {
      toast(err.message || "生成失败，请重试");
    } finally {
      submit.disabled = false;
    }
  });

  /* ---------------- settings ---------------- */

  function renderPrefs() {
    $("#pref-notify").checked = Boolean(prefs.notify);
    $("#pref-wifi").checked = Boolean(prefs.wifiOnly);
    $("#pref-original").checked = Boolean(prefs.original);
  }

  ["notify", "wifiOnly", "original"].forEach((key) => {
    const input = { notify: "#pref-notify", wifiOnly: "#pref-wifi", original: "#pref-original" }[key];
    $(input).addEventListener("change", (event) => {
      prefs[key] = event.target.checked;
      savePrefs();
      if (key === "notify" && prefs.notify && "Notification" in window && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
      toast("已保存");
    });
  });

  $("#reconnect-btn").addEventListener("click", () => {
    location.href = "/pair";
  });

  /* ---------------- realtime ---------------- */

  function connectEvents() {
    if (!("EventSource" in window)) return;
    const source = new EventSource("/api/app/events");
    source.onmessage = (event) => {
      let payload = null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!payload) return;
      if (payload.type === "inbox" && payload.item) {
        notifyIncoming(payload.item);
      }
      window.clearTimeout(state.refreshTimer);
      state.refreshTimer = window.setTimeout(() => load({ silent: true }), 360);
    };
    source.onerror = () => setLive(false, "重连中…");
  }

  function notifyIncoming(item) {
    if (!state.ready) return;
    toast("电脑发来 · " + item.fileName);
    if (!prefs.notify) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      new Notification("LanDrop · 电脑发来", { body: item.fileName, tag: item.id });
    } catch {
      /* 部分浏览器在非安全上下文禁用 */
    }
  }

  /* ---------------- install ---------------- */

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.deferredInstall = event;
    $("#install-card").hidden = false;
  });

  $("#install-btn").addEventListener("click", async () => {
    if (!state.deferredInstall) {
      toast("在浏览器菜单里选「添加到主屏幕」");
      return;
    }
    state.deferredInstall.prompt();
    const choice = await state.deferredInstall.userChoice.catch(() => null);
    if (choice && choice.outcome === "accepted") {
      toast("已添加到主屏幕");
      $("#install-card").hidden = true;
    }
    state.deferredInstall = null;
  });

  if (window.matchMedia("(display-mode: standalone)").matches || navigator.standalone) {
    $("#brand-sub").textContent = "已安装 · 局域网直传";
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  /* ---------------- init ---------------- */

  load();
  connectEvents();
  window.setInterval(() => load({ silent: true }), 20000);
})();
