(function () {
  "use strict";

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const token = (location.pathname.split("/")[2] || "").trim();
  const api = `/api/drive/${token}`;
  const state = {
    drive: null,
    host: null,
    files: [],
    query: "",
    maxUploadGB: 8
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
    if (Number.isNaN(d.getTime())) return "—";
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

  function renderError(status, message) {
    const map = {
      404: ["这个分享盘不存在", "链接可能已经失效，或者对方重置了分享盘。请向对方再要一次二维码。"],
      410: ["分享盘已关闭", "对方暂时关掉了这个盘。找他重新打开就能继续访问。"],
      403: ["这个盘不接收上传", "对方只允许查看和下载。"]
    };
    const chosen = map[status] || ["打不开这个分享盘", "请确认手机和电脑在同一个 Wi‑Fi，且电脑上的 LanDrop 还在运行。"];
    $("#app").innerHTML =
      '<header class="web-top"><div class="web-brand"><span class="app-logo" aria-hidden="true">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6"/></svg>' +
      '</span><strong>LanDrop</strong></div><span class="web-badge">分享盘</span></header>' +
      '<div class="error-card"><span class="error-icon" aria-hidden="true">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16.5v.2"/><circle cx="12" cy="12" r="9"/></svg>' +
      '</span><h1>' + chosen[0] + '</h1><p>' + escapeHtml(message || chosen[1]) + '</p></div>';
  }

  /* ---------------- 数据 ---------------- */

  async function load() {
    try {
      const res = await fetch(`${api}/info`, { headers: { Accept: "application/json" } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        renderError(res.status, data.message);
        return;
      }
      state.drive = data.drive;
      state.host = data.host;
      state.files = data.files || [];
      if (!data.drive.enabled) {
        renderError(410, data.message);
        return;
      }
      applyState();
    } catch {
      $("#live-pill").classList.add("is-off");
      $("#live-text").textContent = "连接中断";
      toast("连接中断，正在重试…", "error");
    }
  }

  function applyState() {
    const drive = state.drive;
    $("#drive-name").textContent = drive.name || "分享盘";
    $("#host-name").textContent = state.host ? state.host.name : "—";
    const note = $("#drive-note");
    if (drive.note) {
      note.textContent = drive.note;
      note.hidden = false;
    } else {
      note.hidden = true;
    }
    const mode = !drive.allowBrowse
      ? "只收文件"
      : drive.allowUpload
        ? "可取可传"
        : "只可取";
    $("#drive-mode").textContent = mode;
    $("#up-card").hidden = !drive.allowUpload;
    $("#upload-hint").textContent = `原图不压缩 · 单个最大 ${state.maxUploadGB} GB`;
    $("#foot").textContent = `LanDrop drive · /d/${token}`;
    renderFiles();
  }

  function visibleList() {
    const q = state.query.trim().toLowerCase();
    if (!q) return state.files;
    return state.files.filter((f) => f.name.toLowerCase().includes(q));
  }

  function renderFiles() {
    const list = visibleList();
    $("#file-count").textContent = state.files.length
      ? `共 ${state.files.length} 个文件`
      : state.drive && state.drive.allowBrowse ? "盘里还是空的" : "等待对方放入文件";
    $("#list-count").textContent = String(list.length);

    const host = $("#batches");
    if (!list.length) {
      host.innerHTML =
        '<div class="empty-state"><h3>' +
        (state.files.length ? "没有匹配的文件" : "盘里还没有文件") +
        "</h3><p>" +
        (state.files.length
          ? "换个关键词试试。"
          : state.drive && state.drive.allowUpload
            ? "你可以先传一个上去，对方会在「待拾取」里看到。"
            : "对面还没放入文件，等一下再刷新就好。") +
        "</p></div>";
      return;
    }

    const groups = new Map();
    for (const file of list) {
      const key = dayLabel(file.createdAt);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(file);
    }

    host.innerHTML = Array.from(groups.entries())
      .map(([label, items]) => {
        const rows = items
          .map(
            (f) =>
              '<li class="web-row"><button class="wr-open" type="button" data-preview="' +
              f.id +
              '" aria-label="预览 ' +
              escapeHtml(f.name) +
              '"><span class="ftype" data-kind="' +
              kindOf(f) +
              '">' +
              escapeHtml(f.ext || typeLabel(f)) +
              '</span><span class="wr-text"><span class="wr-name">' +
              escapeHtml(f.name) +
              '</span><span class="wr-meta">' +
              escapeHtml(formatSize(f.size) + " · " + timeLabel(f.createdAt)) +
              "</span></span></button>" +
              '<button class="dl-btn" type="button" data-download="' +
              f.id +
              '" aria-label="下载 ' +
              escapeHtml(f.name) +
              '"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v9"/><path d="m8.4 10.6 3.6 3.6 3.6-3.6"/><path d="M5 17v1.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V17"/></svg><span>下载</span></button></li>'
          )
          .join("");
        return (
          '<div class="web-batch-label"><span>' +
          escapeHtml(label) +
          '</span><span>' +
          items.length +
          ' 个</span></div><ul class="web-rows">' +
          rows +
          "</ul>"
        );
      })
      .join("");
  }

  function kindOf(file) {
    const map = {
      image: "img",
      video: "video",
      audio: "audio",
      pdf: "pdf",
      archive: "zip",
      "office-sheet": "sheet",
      csv: "sheet",
      "office-doc": "doc",
      markdown: "doc",
      text: "doc",
      code: "doc",
      "office-slide": "doc"
    };
    return map[file.kind] || "doc";
  }

  function typeLabel(file) {
    const names = {
      image: "图片",
      video: "视频",
      audio: "音频",
      pdf: "PDF",
      archive: "压缩包",
      "office-sheet": "表格",
      "office-doc": "文档",
      "office-slide": "演示",
      markdown: "MD",
      csv: "CSV",
      text: "文本",
      code: "代码",
      unknown: "文件"
    };
    return names[file.kind] || "文件";
  }

  function fileById(id) {
    return state.files.find((f) => f.id === id) || null;
  }

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
      const file = fileById(open.dataset.preview);
      if (file) openSheet(file);
      return;
    }
    const button = event.target.closest("[data-download]");
    if (!button) return;
    const file = fileById(button.dataset.download);
    if (file) downloadFile(file, button);
  });

  $("#d-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderFiles();
  });

  /* ---------------- 预览 ---------------- */

  function sheetNote(title, body) {
    return '<div class="sheet-note"><strong>' + escapeHtml(title) + "</strong><p>" + escapeHtml(body) + "</p></div>";
  }

  async function openSheet(file) {
    $("#sheet-name").textContent = file.name;
    $("#sheet-sub").textContent = `${formatSize(file.size)} · ${typeLabel(file)}`;
    $("#sheet").hidden = false;
    $("#sheet-scrim").hidden = false;
    $("#sheet-current").value = file.id;
    const body = $("#sheet-body");
    body.innerHTML = '<div class="empty-state"><h3>正在渲染</h3><p>稍等。</p></div>';
    try {
      const res = await fetch(file.previewUrl, { headers: { Accept: "application/json" } });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.message || "预览失败");
      renderSheet(payload, file);
    } catch (err) {
      body.innerHTML = sheetNote("这个文件没法直接预览", err.message || "换个设备或下载后再看。");
    }
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
          .map((row, index) =>
            "<tr>" +
            row
              .map((cell) => (index === 0 ? "<th>" : "<td>") + escapeHtml(String(cell)) + (index === 0 ? "</th>" : "</td>"))
              .join("") +
            "</tr>"
          )
          .join("") +
        "</table></div>";
      return;
    }
    if (payload.type === "doc") {
      const parts = (payload.paragraphs || [])
        .map((p) => {
          if (/^#{1,3}\s/.test(p)) return "<h4>" + escapeHtml(p.replace(/^#{1,3}\s/, "")) + "</h4>";
          if (/^[-*]\s/.test(p)) return "<li>" + escapeHtml(p.replace(/^[-*]\s/, "")) + "</li>";
          return "<p>" + escapeHtml(p) + "</p>";
        })
        .join("");
      body.innerHTML = '<div class="sheet-doc">' + (parts || "<p>这个文件里没有可提取的文字。</p>") + "</div>";
      return;
    }
    if (payload.type === "slides") {
      body.innerHTML =
        '<div class="sheet-doc">' +
        (payload.slides || [])
          .map((slide, i) => "<h4>第 " + (i + 1) + " 页</h4>" + slide.map((p) => "<p>" + escapeHtml(p) + "</p>").join(""))
          .join("") +
        "</div>";
      return;
    }
    if (payload.type === "archive") {
      const items = payload.entries || [];
      body.innerHTML =
        '<ul class="sheet-list">' +
        items
          .slice(0, 200)
          .map((e) => "<li>" + escapeHtml(e.name) + ' <span class="sheet-meta">' + escapeHtml(formatSize(e.size)) + "</span></li>")
          .join("") +
        "</ul>";
      return;
    }
    body.innerHTML = sheetNote(payload.reason === "legacy-office" ? "老格式不支持内嵌预览" : "这个文件没有可预览的内容", payload.message || "可以下载到手机后再打开。");
  }

  function closeSheet() {
    $("#sheet").hidden = true;
    $("#sheet-scrim").hidden = true;
    $("#sheet-body").innerHTML = "";
  }

  $("#sheet-close").addEventListener("click", closeSheet);
  $("#sheet-scrim").addEventListener("click", closeSheet);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("#sheet").hidden) closeSheet();
  });
  $("#sheet-download").addEventListener("click", () => {
    const file = fileById($("#sheet-current").value);
    if (file) downloadFile(file);
  });

  /* ---------------- 上传 ---------------- */

  function addItem(file) {
    const row = document.createElement("div");
    row.className = "up-item";
    row.innerHTML =
      '<span class="up-name">' +
      escapeHtml(file.name) +
      '</span><span class="up-meta">' +
      escapeHtml(formatSize(file.size)) +
      '</span><span class="up-bar"><span></span></span><span class="up-pct">0%</span>';
    $("#progress").appendChild(row);
    return row;
  }

  function uploadOne(file) {
    return new Promise((resolve) => {
      const row = addItem(file);
      const bar = row.querySelector(".up-bar span");
      const pct = row.querySelector(".up-pct");
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `${api}/upload?name=${encodeURIComponent(file.name)}`);
      xhr.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) return;
        const ratio = event.loaded / event.total;
        bar.style.width = Math.round(ratio * 100) + "%";
        pct.textContent = Math.round(ratio * 100) + "%";
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          bar.style.width = "100%";
          pct.textContent = "已交付";
          pct.classList.add("up-done");
          resolve(true);
        } else {
          pct.textContent = "失败";
          pct.classList.add("up-fail");
          let msg = "上传失败";
          try {
            msg = JSON.parse(xhr.responseText).message || msg;
          } catch {}
          toast(msg, "error");
          resolve(false);
        }
      });
      xhr.addEventListener("error", () => {
        pct.textContent = "断开";
        pct.classList.add("up-fail");
        toast("网络断了，" + file.name + " 没传上去", "error");
        resolve(false);
      });
      xhr.send(file);
    });
  }

  $("#upload-btn").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    let ok = 0;
    for (const file of files) {
      if (await uploadOne(file)) ok += 1;
    }
    if (ok) {
      $("#sent-note").hidden = false;
      toast(ok === 1 ? "已交给对方" : `${ok} 个文件已交给对方`);
    }
    load();
  });

  load();
  window.setInterval(load, 12000);
})();
