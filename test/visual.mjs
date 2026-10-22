/**
 * 视觉回归检查：三个端 × 9 个视口，检查横向溢出与控制台报错，并输出截图。
 *
 *   TOKEN=<sessionToken> npm run test:visual
 *
 * 依赖本机 Chrome（可用 CHROME 环境变量覆盖路径）。
 */
import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";

const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ORIGIN = process.env.ORIGIN || "http://127.0.0.1:8080";
const TOKEN = process.env.TOKEN || "";

const VIEWPORTS = [
  { name: "mobile-compact", width: 360, height: 800 },
  { name: "mobile-standard", width: 390, height: 844 },
  { name: "mobile-large", width: 430, height: 932 },
  { name: "foldable", width: 600, height: 960 },
  { name: "tablet-portrait", width: 820, height: 1180 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "laptop", width: 1366, height: 768 },
  { name: "desktop", width: 1440, height: 900 },
  { name: "wide", width: 1920, height: 1080 }
];

await mkdir("qa", { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
const failures = [];

for (const vp of VIEWPORTS) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  if (TOKEN) {
    await context.addCookies([{ name: "ld_session", value: TOKEN, domain: new URL(ORIGIN).hostname, path: "/" }]);
  }
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message.slice(0, 160)));
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text().slice(0, 160)); });

  const surfaces = [["console", `${ORIGIN}/`], ["app", `${ORIGIN}/app`]];
  if (TOKEN) surfaces.push(["web", `${ORIGIN}/w/${TOKEN}`]);
  // 分享盘页：开着才检查
  try {
    const driveRes = await fetch(`${ORIGIN}/api/drive`);
    if (driveRes.ok) {
      const drive = (await driveRes.json()).drive;
      if (drive.enabled && drive.url) surfaces.push(["drive", drive.url]);
    }
  } catch {}

  for (const [label, url] of surfaces) {
    errors.length = 0;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForTimeout(400);
    const metrics = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }));
    const problems = [];
    if (metrics.overflow > 1) problems.push(`横向溢出 ${metrics.overflow}px`);
    if (errors.length) problems.push(`JS 报错 ${errors[0]}`);
    if (problems.length) failures.push(`${label} ${vp.width}x${vp.height}: ${problems.join(" / ")}`);
    await page.screenshot({ path: `qa/${label}-${vp.name}.png` });
    console.log(`${problems.length ? "FAIL" : "OK  "} ${label.padEnd(7)} ${vp.width}x${vp.height}${problems.length ? " — " + problems.join(" / ") : ""}`);
  }
  await context.close();
}

await browser.close();

if (failures.length) {
  console.log(`\n${failures.length} 个问题`);
  failures.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("\n全部视口通过：无横向溢出、无控制台报错");
