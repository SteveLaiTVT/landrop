/**
 * LanDrop 端到端测试（无需浏览器）
 * 启动一个临时实例，跑完真实 HTTP 流程后清理。
 *
 *   npm test
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 18000 + Math.floor(Math.random() * 900);
const ORIGIN = `http://127.0.0.1:${PORT}`;

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function parseCookies(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return raw.map((line) => line.split(";")[0]).join("; ");
}

const dataDir = await mkdtemp(path.join(tmpdir(), "landrop-data-"));
const storeDir = await mkdtemp(path.join(tmpdir(), "landrop-store-"));

const server = spawn(process.execPath, [path.join(ROOT, "server", "index.js"), `--port=${PORT}`], {
  cwd: ROOT,
  env: { ...process.env, LANDROP_DATA_DIR: dataDir, LANDROP_STORAGE_DIR: storeDir },
  stdio: ["ignore", "pipe", "pipe"]
});

server.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

async function waitForBoot() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${ORIGIN}/api/health`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("服务未能在 7 秒内启动");
}

function shutdown() {
  server.kill("SIGTERM");
}

try {
  await waitForBoot();
  const config = JSON.parse(await readFile(path.join(dataDir, "config.json"), "utf8"));
  const token = config.sessionToken;
  const pairCode = config.pairCode;

  console.log("\n[1] 服务与会话");
  const health = await (await fetch(`${ORIGIN}/api/health`)).json();
  check("健康检查返回 ok", health.ok === true);

  const webPage = await fetch(`${ORIGIN}/w/${token}`);
  const cookies = parseCookies(webPage);
  check("网页版页面可访问", webPage.status === 200);
  check("网页版下发会话 cookie", cookies.includes("ld_session=" + token));

  const session = await (await fetch(`${ORIGIN}/api/session/${token}`, { headers: { cookie: cookies } })).json();
  check("会话接口返回主机信息", Boolean(session.host && session.host.name), JSON.stringify(session.host || {}));

  console.log("\n[2] 手机上传");
  const uploadRes = await fetch(`${ORIGIN}/api/session/${token}/upload?name=${encodeURIComponent("测试文档.txt")}`, {
    method: "PUT",
    headers: { cookie: cookies },
    body: "hello landrop"
  });
  const uploadBody = await uploadRes.json();
  check("上传返回 201", uploadRes.status === 201, String(uploadRes.status));
  check("文件落盘并可读", (await readFile(path.join(storeDir, "测试文档.txt"), "utf8")) === "hello landrop");
  const fileId = uploadBody.file.id;

  const dupRes = await fetch(`${ORIGIN}/api/session/${token}/upload?name=${encodeURIComponent("测试文档.txt")}`, {
    method: "PUT",
    headers: { cookie: cookies },
    body: "second"
  });
  const dupBody = await dupRes.json();
  check("同名文件自动改名", dupBody.file && dupBody.file.name !== "测试文档.txt", dupBody.file && dupBody.file.name);

  console.log("\n[3] 共享链接");
  const shareRes = await fetch(`${ORIGIN}/api/shares`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, perm: "write", expiry: "1h", note: "评审稿" })
  });
  const share = (await shareRes.json()).share;
  check("创建共享返回链接", shareRes.status === 201 && /\/s\/[a-z0-9]+/.test(share.link), share.link);

  const shareApi = await (await fetch(`${ORIGIN}/api/share/${share.id}`)).json();
  check("共享信息可公开读取", shareApi.ok === true && shareApi.share.perm === "write");

  const download = await fetch(`${ORIGIN}/s/${share.id}/download`);
  check("共享下载返回 200", download.status === 200, String(download.status));
  check("下载内容正确", (await download.text()) === "hello landrop");

  const writeBack = await fetch(`${ORIGIN}/api/share/${share.id}/upload?name=${encodeURIComponent("同事回传.txt")}`, {
    method: "PUT",
    body: "from colleague"
  });
  check("可写链接允许回传", writeBack.status === 201, String(writeBack.status));

  await fetch(`${ORIGIN}/api/shares/${share.id}`, { method: "DELETE" });
  const revoked = await fetch(`${ORIGIN}/s/${share.id}/download`);
  check("撤销后下载返回 410", revoked.status === 410, String(revoked.status));

  console.log("\n[4] App 版与电脑推送");
  const appPage = await fetch(`${ORIGIN}/app`);
  check("App 页面可访问", appPage.status === 200);
  const appCookies = cookies;
  const appState = await (await fetch(`${ORIGIN}/api/app/state`, { headers: { cookie: appCookies } })).json();
  check("App 状态可读取", appState.ok === true, JSON.stringify(appState.device || {}));
  const deviceId = appState.device.id;

  const sendRes = await fetch(`${ORIGIN}/api/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId, deviceId })
  });
  const sent = await sendRes.json();
  check("电脑推送被接受", sendRes.ok && sent.ok, JSON.stringify(sent).slice(0, 100));

  const afterSend = await (await fetch(`${ORIGIN}/api/app/state`, { headers: { cookie: appCookies } })).json();
  check("App 收件箱出现文件", afterSend.inbox.length === 1 && afterSend.inbox[0].fileId === fileId);
  const received = await fetch(`${ORIGIN}/api/app/inbox/${afterSend.inbox[0].id}/received`, {
    method: "POST",
    headers: { cookie: appCookies }
  });
  check("标记已收到", received.ok);

  const appFiles = await (await fetch(`${ORIGIN}/api/app/files/${fileId}/download`, { headers: { cookie: appCookies } })).text();
  check("App 内下载文件", appFiles === "hello landrop");

  console.log("\n[5] 设备与配对");
  const state = await (await fetch(`${ORIGIN}/api/state`)).json();
  const clients = state.devices.filter((d) => !d.self);
  check("同一设备不会重复登记", clients.length === 1, `clients=${clients.length}`);
  check("设备被识别为 App", clients[0] && clients[0].kind === "app", clients[0] && clients[0].kind);

  const pair = await fetch(`${ORIGIN}/p/${pairCode}`, { redirect: "manual" });
  check("配对码跳转到会话地址", pair.status === 302 && pair.headers.get("location") === `/w/${token}`);

  const rotate = await fetch(`${ORIGIN}/api/pair/rotate`, { method: "POST" });
  const rotated = await rotate.json();
  check("刷新配对码会换 token", rotate.ok && rotated.pairing.token !== token);

  const oldToken = await fetch(`${ORIGIN}/api/session/${token}`, { headers: { cookie: cookies } });
  check("旧地址在刷新后失效", oldToken.status === 404 || oldToken.status === 410, String(oldToken.status));

  console.log("\n[6] 文件夹、预览与 Skill");

  const require = createRequire(import.meta.url);
  const { writeZip } = require(path.join(ROOT, "server", "zip.js"));

  const docxBuf = writeZip([
    {
      name: "word/document.xml",
      data: '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>本周进展</w:t></w:r></w:p><w:p><w:r><w:t>完成预览能力，覆盖 Office 与压缩包。</w:t></w:r></w:p></w:body></w:document>'
    }
  ]);
  const docxUp = await (await fetch(`${ORIGIN}/api/upload?name=${encodeURIComponent("周报.docx")}`, {
    method: "PUT",
    body: docxBuf
  })).json();
  await fetch(`${ORIGIN}/api/upload?name=${encodeURIComponent("清单.csv")}`, {
    method: "PUT",
    body: "姓名,部门\n张三,研发\n李四,设计\n"
  });

  const withNew = await (await fetch(`${ORIGIN}/api/state`)).json();
  const docxFile = withNew.files.find((f) => f.id === docxUp.file.id) || withNew.files.find((f) => f.name === "周报.docx");
  const csvFile = withNew.files.find((f) => f.name === "清单.csv");
  check("新文件自动识别预览类型", docxFile && docxFile.previewKind === "office-doc", docxFile && docxFile.previewKind);

  const docxPreview = await (await fetch(`${ORIGIN}${docxFile.previewUrl}`)).json();
  check("docx 能抽出正文", docxPreview.type === "doc" && docxPreview.paragraphs.join("").includes("本周进展"), JSON.stringify(docxPreview).slice(0, 80));

  const csvPreview = await (await fetch(`${ORIGIN}${csvFile.previewUrl}`)).json();
  check("csv 解析成表格", csvPreview.type === "table" && csvPreview.rows.length === 3 && csvPreview.rows[0][0] === "姓名", JSON.stringify(csvPreview.rows || []).slice(0, 60));

  const rawRes = await fetch(`${ORIGIN}${docxFile.rawUrl}`);
  check("inline 流可预览", rawRes.ok && rawRes.headers.get("content-disposition").startsWith("inline"));

  const folderRes = await (await fetch(`${ORIGIN}/api/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "资料" })
  })).json();
  check("可以新建文件夹", folderRes.ok && folderRes.folder.name === "资料");

  const moveRes = await (await fetch(`${ORIGIN}/api/files/move`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [docxFile.id], folderId: folderRes.folder.id })
  })).json();
  check("文件可以移动进文件夹", moveRes.moved === 1, JSON.stringify(moveRes));

  const tagRes = await (await fetch(`${ORIGIN}/api/files/tags`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: [docxFile.id], add: ["周报", "待阅"] })
  })).json();
  check("可以给文件打标签", tagRes.changed === 1);

  const byName = await (await fetch(`${ORIGIN}/api/search?q=${encodeURIComponent("周报")}`)).json();
  check("搜索命中文件名", byName.total >= 1, `total=${byName.total}`);

  const byFolder = await (await fetch(`${ORIGIN}/api/search?q=${encodeURIComponent("资料")}`)).json();
  check("搜索命中文件夹名", byFolder.total >= 1, `total=${byFolder.total}`);

  const byTag = await (await fetch(`${ORIGIN}/api/search?q=${encodeURIComponent("待阅")}`)).json();
  check("搜索命中标签", byTag.total >= 1, `total=${byTag.total}`);

  const manifest = await (await fetch(`${ORIGIN}/api/skill/manifest`)).json();
  check("Skill 能力清单可读", manifest.ok === true && manifest.capabilities.length >= 8, `caps=${(manifest.capabilities || []).length}`);

  const plan = await (await fetch(`${ORIGIN}/api/skill/plan?preset=kind`)).json();
  check("Skill 能给出整理方案", plan.ok && plan.steps.length > 0 && typeof plan.total === "number", JSON.stringify(plan.steps || []).slice(0, 80));

  const applyRes = await (await fetch(`${ORIGIN}/api/skill/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preset: "kind" })
  })).json();
  check("Skill 能执行整理", applyRes.ok && applyRes.moved > 0, JSON.stringify(applyRes).slice(0, 80));

  const pkg = await fetch(`${ORIGIN}/api/skill/package`);
  const pkgBuf = Buffer.from(await pkg.arrayBuffer());
  check("Skill 包可下载（zip）", pkg.ok && pkgBuf.slice(0, 2).toString("utf8") === "PK", `status=${pkg.status}`);

  const newStoreDir = await mkdtemp(path.join(tmpdir(), "landrop-store2-"));
  const migrated = await (await fetch(`${ORIGIN}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ storageDir: newStoreDir, migrate: true })
  })).json();
  check("切换存储目录并迁移文件", migrated.ok && migrated.migration && migrated.migration.moved > 0, JSON.stringify(migrated.migration || {}));
  const afterMigrate = await (await fetch(`${ORIGIN}/api/state`)).json();
  check("迁移后文件仍在库里", afterMigrate.files.length >= 2 && afterMigrate.storage.dir === newStoreDir, `files=${afterMigrate.files.length}`);

  const fsList = await (await fetch(`${ORIGIN}/api/fs/list?path=${encodeURIComponent(newStoreDir)}`)).json();
  check("目录浏览接口可用", fsList.ok === true && Array.isArray(fsList.dirs), JSON.stringify(fsList).slice(0, 60));

  console.log("\n[7] 分享盘");

  const driveAdmin = await (await fetch(`${ORIGIN}/api/drive`)).json();
  check("管理端能读到分享盘", driveAdmin.ok && /^[A-Za-z0-9]{16,}$/.test(driveAdmin.drive.token), `token 长度 ${driveAdmin.drive.token.length}`);
  const driveToken = driveAdmin.drive.token;

  const guestClosed = await fetch(`${ORIGIN}/api/drive/${driveToken}/info`);
  const guestClosedBody = await guestClosed.json();
  check("未开启时访客 info 显示关闭", guestClosed.ok && guestClosedBody.drive.enabled === false);

  const closedUpload = await fetch(`${ORIGIN}/api/drive/${driveToken}/upload?name=x.txt`, { method: "PUT", body: "nope" });
  check("未开启时访客上传被拒", closedUpload.status === 410, String(closedUpload.status));

  const drivePage = await fetch(`${ORIGIN}/d/${driveToken}`);
  check("盘页可以打开", drivePage.ok, String(drivePage.status));

  const enableRes = await (await fetch(`${ORIGIN}/api/drive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, name: "测试盘", allowUpload: true, allowBrowse: true })
  })).json();
  check("管理端能开启分享盘", enableRes.ok && enableRes.drive.enabled === true);

  const stateBeforeGuest = await (await fetch(`${ORIGIN}/api/state`)).json();
  const driveAdd = await (await fetch(`${ORIGIN}/api/drive/files`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: stateBeforeGuest.files.slice(0, 2).map((f) => f.id) })
  })).json();
  check("可以把库里的文件放进盘", driveAdd.ok && driveAdd.added === 2, `added=${driveAdd.added}`);

  const guestInfo = await (await fetch(`${ORIGIN}/api/drive/${driveToken}/info`)).json();
  check("访客能看到盘内文件", guestInfo.ok && guestInfo.drive.enabled && guestInfo.files.length > 0, `${guestInfo.files.length} 个`);
  check("盘内文件带预览与下载地址", guestInfo.files.every((f) => f.downloadUrl && f.rawUrl && f.previewUrl));

  const firstFile = guestInfo.files[0];
  const guestDownload = await fetch(`${ORIGIN}${firstFile.downloadUrl}`);
  check("访客能下载盘内文件", guestDownload.ok, String(guestDownload.status));
  const guestPreview = await fetch(`${ORIGIN}${firstFile.previewUrl}`);
  check("访客能预览盘内文件", guestPreview.ok, String(guestPreview.status));

  const guestUpload = await fetch(`${ORIGIN}/api/drive/${driveToken}/upload?name=${encodeURIComponent("访客文件.txt")}`, {
    method: "PUT",
    body: "来自访客的内容"
  });
  const guestUploadBody = await guestUpload.json();
  check("访客上传进入待拾取", guestUpload.status === 201 && guestUploadBody.item.name === "访客文件.txt", String(guestUpload.status));

  const adminAfter = await (await fetch(`${ORIGIN}/api/drive`)).json();
  check("待拾取队列有记录", adminAfter.drive.pending.length === 1, String(adminAfter.drive.pending.length));

  const wrongToken = await fetch(`${ORIGIN}/api/drive/thisisawrongtoken12345/info`);
  check("错误 token 返回 404", wrongToken.status === 404, String(wrongToken.status));

  const pickup = await (await fetch(`${ORIGIN}/api/drive/pickup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({})
  })).json();
  check("管理端拾取进库", pickup.ok && pickup.picked.length === 1 && pickup.failed.length === 0, JSON.stringify(pickup.picked || []));
  const afterPickup = await (await fetch(`${ORIGIN}/api/state`)).json();
  const pickedFile = afterPickup.files.find((f) => f.name === "访客文件.txt");
  check("拾取的文件进了库并标注来源", pickedFile && pickedFile.source.includes("访客"), pickedFile ? pickedFile.source : "未找到");

  const driveRotated = await (await fetch(`${ORIGIN}/api/drive`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rotate: true })
  })).json();
  check("可以换新链接", driveRotated.ok && driveRotated.drive.token !== driveToken);

  console.log("\n[8] 安全边界");
  const noCookie = await fetch(`${ORIGIN}/api/app/state`);
  check("未配对访问 App API 返回 401", noCookie.status === 401, String(noCookie.status));

  const traversal = await fetch(`${ORIGIN}/assets/..%2F..%2Fpackage.json`);
  check("静态资源禁止目录穿越", traversal.status === 403 || traversal.status === 404, String(traversal.status));
} catch (err) {
  failures.push("运行异常: " + err.message);
  console.error(err);
} finally {
  shutdown();
  await new Promise((r) => setTimeout(r, 250));
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(storeDir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${passed} 项通过，${failures.length} 项失败`);
if (failures.length) {
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("全部通过");
