/**
 * 新功能交互验收：分享盘、入口切换、点击预览、缩略图。
 *
 *   ORIGIN=http://127.0.0.1:18093 node test/check-ui.mjs
 */
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ORIGIN = process.env.ORIGIN || "http://127.0.0.1:18093";

let pass = 0;
let fail = 0;
function check(name, ok, extra = "") {
  if (ok) {
    pass += 1;
    console.log("  PASS  " + name + (extra ? "  " + extra : ""));
  } else {
    fail += 1;
    console.log("  FAIL  " + name + (extra ? "  " + extra : ""));
  }
}

await mkdir("qa", { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });

/* ---------- 1. 桌面控制台 ---------- */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });

  await page.goto(ORIGIN + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(700);

  console.log("\n[概览 · 三种入口]");
  const tabs = await page.$$eval("[data-entry]", (els) => els.map((e) => e.dataset.entry));
  check("概览有三个入口页签", tabs.length === 3, tabs.join("/"));
  const codePhone = await page.textContent("#pair-code");
  await page.click('[data-entry="drive"]');
  await page.waitForTimeout(250);
  const driveCode = await page.textContent("#pair-code");
  const driveUrl = await page.textContent("#pair-url");
  check("切到分享盘后文案变化", driveCode !== codePhone, `${codePhone} -> ${driveCode}`);
  check("分享盘地址带 /d/", driveUrl.includes("/d/"), driveUrl);
  await page.click('[data-entry="app"]');
  await page.waitForTimeout(250);
  const appUrl = await page.textContent("#pair-url");
  check("App 页扫码直达带 /app/", appUrl.includes("/app/"), appUrl);
  await page.click('[data-entry="phone"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: "qa/check-overview.png" });

  console.log("\n[共享页 · 分享盘]");
  await page.click('[data-view="share"]');
  await page.waitForTimeout(500);
  const switchText = await page.textContent("#drive-switch-text");
  check("开关显示已开启", switchText.trim() === "已开启", switchText);
  const driveFiles = await page.$$eval("#drive-files .drive-row", (e) => e.length);
  check("盘内文件已列出", driveFiles > 0, driveFiles + " 个");
  const pending = await page.$$eval("#drive-pending .pending-row", (e) => e.length);
  check("待拾取队列已列出", pending > 0, pending + " 个");
  await page.screenshot({ path: "qa/check-drive.png" });

  console.log("\n[拾取]");
  await page.click("#pickup-all");
  await page.waitForTimeout(900);
  const pendingAfter = await page.$$eval("#drive-pending .pending-row", (e) => e.length);
  check("全部收下后队列清空", pendingAfter === 0, pendingAfter + " 个剩余");
  const pendingCount = await page.textContent("#drive-pending-count");
  check("计数归零", pendingCount.trim() === "0 个", pendingCount);

  console.log("\n[文件页 · 点一下就预览]");
  await page.click('[data-view="files"]');
  await page.waitForTimeout(500);
  const rows = await page.$$("#batch-list .batch-row");
  check("文件行已渲染", rows.length > 0, rows.length + " 行");
  const thumbs = await page.$$eval("#batch-list .row-thumb", (e) => e.length);
  console.log("     （图片/视频缩略图数量 " + thumbs + "，取决于是否有图片视频文件）");
  await rows[0].click();
  await page.waitForTimeout(900);
  const previewOpen = await page.isVisible("#preview");
  check("点文件行直接打开预览（不用先进抽屉）", previewOpen);
  const previewName = await page.textContent("#preview-name");
  console.log("     预览标题：" + previewName);
  await page.screenshot({ path: "qa/check-preview.png" });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  const detailBtn = await page.$$("#batch-list [data-act='detail']");
  if (detailBtn.length) {
    await detailBtn[0].click();
    await page.waitForTimeout(400);
    check("详情按钮仍能打开详情抽屉", await page.isVisible("#file-drawer"));
    await page.click("#drawer-close");
    await page.waitForTimeout(300);
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("控制台无横向溢出", overflow <= 1, overflow + "px");
  check("无 JS 报错", errors.length === 0, errors[0] || "");
  await page.close();
}

/* ---------- 2. 分享盘手机页 ---------- */
{
  const info = await (await fetch(ORIGIN + "/api/drive")).json();
  const drive = info.drive;
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });

  console.log("\n[分享盘手机页]");
  await page.goto(drive.url, { waitUntil: "networkidle" });
  await page.waitForTimeout(700);
  const name = await page.textContent("#drive-name");
  check("显示盘名", name.trim() === drive.name, name);
  const mode = await page.textContent("#drive-mode");
  check("显示权限模式", mode.trim().length > 0, mode);
  const listCount = await page.$$eval("#batches .web-row", (e) => e.length);
  check("列出盘内文件", listCount === (drive.files || []).length, listCount + " 个");
  const upVisible = await page.isVisible("#up-card");
  check("允许上传时显示上传区", upVisible === (drive.allowUpload === true));
  await page.screenshot({ path: "qa/check-drive-mobile.png", fullPage: true });

  if (listCount) {
    await page.click("#batches .wr-open");
    await page.waitForTimeout(800);
    check("手机端点文件行能预览", await page.isVisible("#sheet"));
    await page.screenshot({ path: "qa/check-drive-sheet.png" });
    await page.click("#sheet-close");
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("盘页无横向溢出", overflow <= 1, overflow + "px");
  check("盘页无 JS 报错", errors.length === 0, errors[0] || "");
  await page.close();
}

await browser.close();
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
