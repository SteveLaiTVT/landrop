(function () {
  "use strict";

  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const token = (location.pathname.split("/")[2] || "").trim();
  const state = { share: null, canWrite: false, host: null };

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
    }[ch]));
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return "未知大小";
    if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(1) + " GB";
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    return Math.max(1, Math.round(n / 1024)) + " KB";
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

  function renderError(title, detail) {
    $("#app").innerHTML =
      '<header class="share-brand"><div class="web-brand"><span class="app-logo" aria-hidden="true">' +
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v9"/><path d="m8.6 9.8 3.4 3.4 3.4-3.4"/><path d="M5 16v2.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V16"/></svg>' +
      '</span><strong>LanDrop</strong></div><span class="web-badge">共享链接</span></header>' +
      '<div class="error-card"><span class="error-icon" aria-hidden="true">' +
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5M12 16.5v.2"/><circle cx="12" cy="12" r="9"/></svg>' +
      '</span><h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(detail) + '</p></div>';
  }

  function expiryText(share) {
    if (!share.expiresAt) return "永久有效";
    const diff = new Date(share.expiresAt).getTime() - Date.now();
    if (diff <= 0) return "已失效";
    const hours = Math.round(diff / 3600000);
    if (hours >= 24) return `${Math.round(hours / 24)} 天内有效`;
    if (hours >= 1) return `${hours} 小时后失效`;
    return "不到 1 小时后失效";
  }

  async function load() {
    try {
      const res = await fetch(`/api/share/${token}`, { headers: { Accept: "application/json" } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        renderError("链接不存在", data.message || "这条共享链接可能已经被删除。");
        return;
      }
      const share = data.share;
      state.share = share;
      state.canWrite = data.canWrite;
      state.host = data.host;

      if (share.revoked) {
        renderError("链接已被撤销", "文件的主人已经撤销了这条共享链接。需要的话，请让对方重新生成一条。");
        return;
      }
      if (share.expired) {
        renderError("链接已过期", "这条共享链接已超过有效期。请让对方在电脑上重新生成一条。");
        return;
      }
      if (!share.fileExists) {
        renderError("文件已被删除", "链接对应的文件已经从电脑上删除，无法再下载。");
        return;
      }

      document.title = `${share.name} · LanDrop`;
      $("#badge").textContent = share.ext || "FILE";
      $("#badge").dataset.kind = share.kind || "doc";
      $("#file-name").textContent = share.name;
      $("#file-size").textContent = formatSize(share.size);
      $("#file-perm").textContent = share.perm === "write" ? "可下载 · 可回传文件" : "只读 · 可下载";
      $("#note").hidden = !share.note;
      $("#note").textContent = share.note ? `“${share.note}”` : "";

      const dl = $("#download");
      dl.href = `/s/${token}/download`;
      dl.removeAttribute("aria-disabled");
      dl.textContent = "下载文件 · " + formatSize(share.size);

      $("#status-text").textContent = `${expiryText(share)} · 已下载 ${share.downloads || 0} 次 · 来自 ${data.host.name}`;
      $("#foot").textContent = `LanDrop · /s/${token} · ${expiryText(share)}`;

      if (state.canWrite) {
        $("#write-zone").hidden = false;
        $("#pick").addEventListener("click", (e) => {
          e.stopPropagation();
          $("#file-input").click();
        });
        $("#upload-area").addEventListener("click", () => $("#file-input").click());
        $("#upload-area").addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            $("#file-input").click();
          }
        });
        ["dragenter", "dragover"].forEach((evt) => {
          $("#upload-area").addEventListener(evt, (e) => {
            e.preventDefault();
            $("#upload-area").classList.add("is-over");
          });
        });
        ["dragleave", "dragend", "drop"].forEach((evt) => {
          $("#upload-area").addEventListener(evt, (e) => {
            e.preventDefault();
            if (evt !== "drop") $("#upload-area").classList.remove("is-over");
          });
        });
        $("#upload-area").addEventListener("drop", (e) => {
          $("#upload-area").classList.remove("is-over");
          handleFiles(e.dataTransfer.files);
        });
        $("#file-input").addEventListener("change", () => {
          handleFiles($("#file-input").files);
          $("#file-input").value = "";
        });
      }
    } catch {
      renderError("连接不上这台电脑", "请确认手机和电脑在同一 Wi‑Fi，且电脑上的 LanDrop 仍在运行。");
    }
  }

  function uploadOne(file) {
    const item = document.createElement("div");
    item.className = "sp-item";
    item.innerHTML = '<span class="sp-name">' + escapeHtml(file.name) + "</span>" +
      '<div><div class="sp-bar"><span></span></div><div class="sp-pct">0%</div></div>';
    $("#progress").prepend(item);
    const bar = item.querySelector(".sp-bar span");
    const pct = item.querySelector(".sp-pct");
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/share/${token}/upload?name=${encodeURIComponent(file.name)}`);
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const percent = Math.round((event.loaded / event.total) * 100);
        bar.style.width = percent + "%";
        pct.textContent = percent + "%";
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          pct.textContent = "已送到电脑";
          bar.style.width = "100%";
          toast("已送到电脑 · " + file.name);
          window.setTimeout(() => item.remove(), 3600);
        } else {
          let message = "上传失败";
          try { message = JSON.parse(xhr.responseText).message || message; } catch { /* ignore */ }
          pct.textContent = "失败";
          pct.style.color = "var(--danger)";
          toast(message, "error");
        }
        resolve();
      };
      xhr.onerror = () => {
        pct.textContent = "失败";
        pct.style.color = "var(--danger)";
        toast("上传中断，请检查 Wi‑Fi 连接", "error");
        resolve();
      };
      xhr.send(file);
    });
  }

  async function handleFiles(list) {
    for (const file of Array.from(list || [])) {
      if (!file.size) {
        toast(`「${file.name}」是空文件，已跳过`, "error");
        continue;
      }
      await uploadOne(file);
    }
  }

  load();
})();
