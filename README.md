# LanDrop · 把电脑变成局域网网盘

同一 Wi‑Fi 下，手机扫码就能往电脑传文件、从电脑取文件、把文件共享给隔壁同事。文件只落在本机磁盘，不经过任何云服务。

基于设计交付包（`index.html` / `web.html` / `mobile.html` / `android.html`）实现的生产版本：**桌面 App**、手机网页版、App 版（可安装 PWA）、共享页、配对页。

---

## 两种形态

桌面端有两种跑法，用的是同一套后端与前端资源。

### 一、桌面 App（Tauri，推荐）

双击图标就启动，窗口是原生窗口，托盘常驻。**App 自己就是服务器**——它在本机拉起 HTTP 服务，手机连同一个路由器就能访问，不需要另开终端、不需要浏览器标签页。

```
双击 LanDrop.exe
  → 挑一个空闲端口（17800 起）
  → 拉起内置后端（landrop-server.exe，自带 Node 运行时）
  → 等服务真正能响应后再开窗口
  → 托盘常驻，右下角显示"正在为局域网提供文件服务"
```

窗口行为：

- **关闭窗口 ≠ 退出**。服务继续跑，手机照常能传。托盘图标单击即可唤回窗口，悬停提示会变成"仍在后台运行"。
- **真正退出**在托盘右键菜单里，退出时连同后端一起收掉。
- 托盘菜单还能：复制手机访问地址、打开接收文件夹。
- **单实例**：重复双击只会把已有窗口唤到前面，不会起第二个服务。
- **App 被强杀**时，后端通过 stdin 管道感知父进程消失并自行退出，不留占端口孤儿进程。

### 二、命令行（开发/自托管）

```bash
cd landrop
npm start                 # 默认 http://0.0.0.0:8080
npm start -- --port=8090  # 换端口
```

要求 Node.js ≥ 18.15，零运行时依赖。

---

## 三个入口

| 入口 | 地址 | 用途 |
|------|------|------|
| 电脑控制台 | `/` | 仅本机可访问。接收文件、文件管理（文件夹/标签/预览/搜索）、分享盘、共享、设备、设置、Skill |
| 手机网页版 | `/w/<token>` | 免安装。可上传、下载、预览、搜索、接收电脑推送 |
| App 版 | `/app/<token>` | 扫码直达（也支持 `/app`）。四标签页，可接收电脑推送，可添加到主屏幕 |
| 分享盘 | `/d/<token>` | 一个二维码长期有效：扫码看盘里的文件、往盘里传文件 |
| 共享页 | `/s/<code>` | 发给同事的局域网链接，可只读或可写入 |
| 配对页 | `/pair` | 手输 6 位配对码 |

桌面 App 里"打开手机网页版 / App 版 / 配对入口"这类 `target="_blank"` 入口，会交系统默认浏览器打开——WebView 不处理新标签页，所以走了一个受限的本机转发接口（只放行本机与私有网段地址）。

### 把 App 版装到手机桌面

手机先在 `/w/<token>` 打开（自动写入 24 小时会话 cookie），再进 `/app`：

- iOS Safari：分享 → 添加到主屏幕
- Android Chrome：菜单 → 安装应用 / 添加到主屏幕

装好后 `/app` 以独立窗口运行，电脑在文件详情里点「发送到手机」，手机 App 页会实时出现「电脑发来」。

---

## 功能

**电脑控制台**
- 概览：拖拽上传（进度条 + 自动落盘）、最近文件、在线设备、**「让别人连进来」三合一入口（手机会话 / 分享盘 / App 版，同一块二维码卡切换）**；指标常驻底部状态栏
- 文件：左侧文件夹树（可建夹、改名、删夹不删文件、多级路径自动创建）、按天分组、搜索（文件名/标签/文件夹名）、按时间/名称/大小排序、**点击任意文件行直接预览（图片/视频行内直接显示缩略图）**、行内操作（移动/详情）、批量移动与打标签、详情抽屉（传输记录、下载、共享、发送到手机、删除）
- 分享盘（共享页顶部）：开关、盘名与给访客的一句话、二维码与链接复制、允许查看/允许上传、盘内文件管理（放入/移出/预览）、**待拾取队列（访客传上来的先排队，点「收下」才进库，可单收可全收可丢弃）、换新链接**
- 共享：选择文件、只读/可写入、1 小时/24 小时/7 天/永久、备注、复制链接、撤销、访问次数
- 设备：已配对设备列表、在线状态、移除（移除后需重新扫码）
- 设置：存储目录（可选目录、可一键迁移已有文件）、端口、仅局域网、允许同事写入、上传通知、Wake Lock、重置配对密钥、**自动化（Skill）端点与令牌、下载 Skill 包、预览整理方案**

**多格式预览**（电脑控制台与手机网页版同一套）

| 类型 | 能力 |
|------|------|
| 图片 / 音频 / 视频 | 原生 `<img>` / `<audio>` / `<video>`，原生缩放、拖动进度 |
| PDF | 内嵌阅读器，可翻页 |
| Markdown | 渲染标题、**多级标题**、有序/无序列表、**任务列表（可勾选样式）**、**表格（含对齐）**、**围栏代码块（带语言标签）**、引用、分隔线、加粗/斜体/行内码/删除线/链接；HTML 自动转义防注入 |
| CSV / TSV | 解析成表格（最多 300 行 × 30 列），带表头与序号 |
| 文本 / 代码 | 等宽显示，512 KB 截断保护 |
| Word / Excel / PPT | 自研 zip 解包读 OOXML：docx 抽段落、xlsx 取共享字符串拼表、pptx 按页抽标题与正文 |
| 压缩包 | 列出条目、原始大小、压缩后大小、修改时间（最多 500 项） |
| 老版 doc/xls/ppt、未知二进制 | 明确提示「暂不支持内嵌预览」，给出下载与用系统程序打开 |

**手机网页版**：上传（多选、进度）、浏览电脑文件、按天分组下载、**预览弹层**、搜索、文件夹胶囊筛选、**「电脑发来」卡片（实时接收电脑推送，带震动与高亮）**、查看剩余会话时长

**分享盘（`/d/<token>`，扫码即用）**
- 访客打开即见盘名、主人留的一句话、盘内文件（可搜索、点行预览、逐个下载）
- 允许上传时有大上传按钮（多选、进度条），传完提示「已交给对方，等待拾取」
- 关闭分享盘后旧链接显示「分享盘已关闭」；换新链接后旧链接显示「不存在」
- 文件不落云端：访客传的东西先存在电脑 `data/drive-inbox`，管理员收下后才进入存储目录

**App 版（PWA）**
- 首页：连接状态、上传、电脑发来（推送收件箱）、传输动态、最近文件
- 文件：搜索、类型筛选（图片/文档/压缩包/音频）、按天分组、详情面板、下载
- 共享：生成链接、有效期、允许回传、复制、正在共享列表
- 设置：电脑信息、通知/Wi‑Fi/原图偏好、存储位置、会话有效期、重新连接

---

## 归档与检索

文件夹是**逻辑分组**，不是磁盘目录搬家。文件始终平铺在存储目录里，移动文件夹只改 `folderId`，不动字节——所以移动是瞬时的，也不会因为跨盘符失败。

- 建夹支持路径写法：新建「归档/2026-10」会逐级补齐父级。
- 删夹不删文件：夹内文件回到上一级（或根）。
- 文件可打多个标签，标签与文件夹名都进搜索索引。
- 换存储目录时会先把索引与文件一起搬过去：`migrate: true`，返回 `{moved, skipped, failed}`，文件夹归属与标签保留。

## Skill：让外部 WorkBuddy 定期整理

控制台「设置 → 自动化（Skill）」给出**端点地址**与**访问令牌**，以及一份可下载的 Skill 包（`dist/landrop-skill.zip`，也可由运行中的服务 `/api/skill/package` 现取）。

```bash
# 拿到包后解压，把 config.example.json 改成 ~/.landrop/skill.json
npm i -g ./landrop-skill         # 或 node bin/landrop.js 直接跑

landrop stats                   # 库统计：文件数、总大小、各类型、文件夹、未归档数
landrop search "周报" --json     # 跨文件名/标签/文件夹名搜索
landrop folders                 # 文件夹树
landrop mkdir "客户资料/2026"    # 多级建夹
landrop move --ids a,b --folder 客户资料
landrop tag --query 发票 --add 待报销,2026
landrop rename --id a --name 新名字.pdf
landrop plan --preset kind       # 预览整理方案（按类型/按月份/按后缀）
landrop apply --preset kind      # 执行整理
landrop preview --id a --json    # 取结构化预览数据
```

鉴权：本机直连免令牌；跨机访问带 `Authorization: Bearer <skillToken>`（或 `x-landrop-token`）。令牌可在设置里一键轮换。

`/api/skill/*` 与 `skill/bin/landrop.js` 是同一套能力的两个入口——一个给 HTTP 调用方，一个给命令行与 WorkBuddy 这类能跑脚本的宿主。

---

## 实现要点

```
server/                     后端：一个不依赖任何 npm 包的 HTTP 服务
  index.js   HTTP 路由（页面 / 会话 API / App API / 管理 API / Skill API / SSE / 二维码）
  store.js   文件索引、文件夹、标签、搜索、整理方案、共享、设备、收件箱、活动日志（JSON 持久化）
  preview.js 预览数据生成（文本/表格/Office OOXML/压缩包清单/媒体判定）
  zip.js     极简 zip 读写（node:zlib 实现），预览 Office 与导出 Skill 包共用
  upload.js  流式写入临时文件，避免大文件占内存
  qr.js      二维码 SVG 生成（内置编码器，无外部依赖）
  net.js     局域网地址探测、私网判定、本机请求判定
  config.js  配置读写（data/config.json，含 skillToken）

skill/                      可分发 Skill（打包进安装包，也可单独导出）
  SKILL.md / README.md      给 WorkBuddy 等宿主读的说明与能力清单
  bin/landrop.js            零依赖 CLI：stats/search/folders/mkdir/move/tag/rename/plan/apply/preview
  config.example.json       端点 + 令牌模板

src-tauri/                  桌面壳（Rust）
  src/main.rs   启动流程、窗口、错误页、退出清理
  src/server.rs 端口选择、拉起后端、健康探测、日志重定向
  src/tray.rs   托盘菜单与窗口唤回
  binaries/     打包后的后端 landrop-server-<triple>.exe

public/                     前端资源，由后端直接提供
  index.html + js/desktop.js   电脑控制台
  w.html     + js/w.js          手机网页版
  app.html   + js/app.js        App 版（PWA）
  s.html     + js/s.js          共享页
  pair.html  + js/pair.js       配对页
  assets/    tokens.css（设计 Token）/ desktop.css / app.css / phone.css / app-shell.css

scripts/build-sidecar.mjs   把后端压成单文件可执行（esbuild + Node SEA + postject）
scripts/pack-skill.mjs      打包 skill/ → dist/landrop-skill.zip
scripts/pack-release.mjs    把安装包 + 说明 + 哈希压成 dist/LanDrop-1.0.0-发布包.zip
test/e2e.mjs     端到端 HTTP 测试（59 项）
test/visual.mjs  多视口截图 + 溢出/报错检查（需要本机 Chrome）
test/check-ui.mjs 新功能交互验收：入口切换、分享盘管理、点行预览（需要本机 Chrome）
```

- **桌面壳与后端解耦**：Rust 只负责进程与窗口，业务全在 Node 里。改后端逻辑不用动 Rust；改窗口行为不用碰业务。
- **后端单文件化**：`esbuild` 打成单个 CJS，用 Node 官方 SEA（Single Executable Application）注入到 node.exe 副本里，再交给 `postject` 写入 blob。用户机器不需要装 Node。
- **启动时序**：窗口在 `/api/health` 真正返回 200 之后才创建，所以不会出现白屏或"页面加载失败"。
- **实时更新**：SSE。电脑端收到上传立刻刷新；App 端与手机网页版按设备定向接收 `inbox` 事件（网页版会高亮并震动）。
- **预览不落地**：`/api/files/:id/preview` 返回结构化 JSON，前端按 `kind` 选渲染器；`/api/files/:id/raw` 走 `inline` 流给图片/音视频/PDF 用。Office 与压缩包在服务端解包，浏览器不下载原件。
- **零依赖 zip**：`server/zip.js` 只用 `node:zlib` 的 `inflateRawSync`/`deflateRawSync`，读 OOXML 与写 Skill 包都靠它，没有引入 `adm-zip`/`jszip`。
- **设备识别**：cookie `ld_did` + `ip+UA` 合并，同一部手机不会重复登记；在线判定窗口 90 秒。
- **安全边界**：控制台与管理 API 仅接受本机请求；手机只能用带会话的 `/w`、`/app`、`/s`；静态目录防穿越；写入文件走临时文件 + 原子 rename；共享可随时撤销，撤销/过期返回 410。
- **大文件**：上传流式落盘，支持 Range 下载；单文件上限 8 GB（`config.maxUploadGB`）。

---

## 构建桌面 App

环境要求：Rust（stable-x86_64-pc-windows-msvc）、MSVC 生成工具、Windows SDK、WebView2 Runtime（Win10/11 一般自带）。

```bash
npm install
npm run build:sidecar   # 后端 → src-tauri/binaries/landrop-server-<triple>.exe（约 83 MB）
npm run app:build       # 上面一步 + tauri build，产出安装包
```

产物：

- 安装包 `src-tauri/target/release/bundle/nsis/LanDrop_1.0.0_x64-setup.exe`（约 23 MB，含后端与 `public/`、`skill/`）
- 免安装目录 `src-tauri/target/release/`（`landrop.exe` + `landrop-server.exe` 需同目录）

### 发给同事

```bash
npm run app:build     # 出安装包
npm run release:pack  # 安装包 + 说明 + 哈希 → dist/LanDrop-1.0.0-发布包.zip
```

`dist/release/` 里放三样：改名后的安装包（`LanDrop-Setup-1.0.0-x64.exe`）、`给同事看的说明.txt`、`SHA256.txt`；`release:pack` 把它们压成一个 zip（微信/邮件直接传 exe 容易被拦，zip 更稳）。

安装包是 **per-user 安装**：装到 `%LOCALAPPDATA%\LanDrop`，不需要管理员权限，也不写 `Program Files`。卸载走「设置 → 应用」，会删掉程序目录，但**不会删** `~/LanDrop` 里收到的文件。

三个会被同事问到的点，说明文件里都写了：SmartScreen 未知发布者提示（没有代码签名证书）、首次运行要放行防火墙「专用网络」、关闭窗口不退出（托盘常驻）。

实测过的完整链路（不是只看文件清单）：静默安装 → 装上后启动、`/api/health` 与 `/api/skill/manifest` 正常 → 卸载后目录清空、无残留进程。

开发模式：

```bash
npm run app:dev         # 改 server/ 立即生效，无需重新打包 sidecar
```

调试时若想用打包后的后端验证，设 `LANDROP_USE_SIDECAR=1`。

---

## 测试

```bash
npm test              # 59 项端到端检查：上传/改名/共享/回传/撤销/推送/配对/预览/文件夹/搜索/Skill/迁移/分享盘/安全边界
npm run test:visual   # 需先启动服务；用本机 Chrome 截 9 个视口（控制台/App/网页/分享盘）
npm run skill:pack    # 只打 Skill 包 → dist/landrop-skill.zip
```

视觉校验覆盖 360/390/430/600/820/1024/1366/1440/1920 共 9 个视口，三个端均无横向溢出、无控制台报错。截图在 `qa/`。

桌面控制台的排版层单独重做过：固定外壳（侧栏 / 顶栏 / 主区滚动 / 状态栏）、表格式文件行、圆角收紧到 9/7/5、去掉落地页式大标题。改动原因与逐项做法见 `docs/DESIGN-MAPPING.md` 的「桌面排版」。

---

## 已知边界（与设计稿的差异，均有原因）

1. **手机端不做原生 App，也不做 Flutter 版**：手机一律走网页（`/w/<token>`），要做「像个 App」就把它添加到主屏幕。原生/Flutter 需要单独打包与签名，而网页版已经能上传、下载、预览、搜索、接收推送，功能不缺。
2. **推送依赖页面在线**：浏览器限制，页面完全关闭时收不到局域网推送（没有云端推送通道，这正是「不经过云」的代价）。页面打开或后台驻留时实时送达；电脑端不受此限。
3. **开机自启未接管系统启动项**：设置里的开关只写配置。App 化之后真正注册启动项需要安装器改注册表，留待明确产品决策后再做，避免安装器擅自动系统。
4. **「保留原图质量」是常量**：上传链路不做任何转码或压缩，该偏好只影响未来可能加入的压缩策略。
5. **端口不是 8080**：App 从 17800 起挑空闲端口，避开开发机常被占用的 8080；控制台设置里改的是下次启动的端口。命令行模式仍默认 8080。
6. **老版 Office 不内嵌预览**：`.doc`/`.xls`/`.ppt`（OLE 复合文档）不是 zip，自研解包读不了。要么用系统程序打开，要么另存为 `docx/xlsx/pptx`。
7. **文件夹不是磁盘目录**：见「归档与检索」。想让磁盘上也分层，得等后续做「真目录」模式；现在的取舍是移动零成本、不跨盘失败。

## 默认数据位置

| 形态 | 配置与索引 | 文件 |
|------|-----------|------|
| 桌面 App | `%APPDATA%\app.landrop.desktop\`（含 `server.log`） | `C:\Users\<你>\LanDrop` |
| 命令行 | `landrop/data/` | `~/LanDrop` |

控制台与 App 都读同一个文件目录，直接往目录里拖文件也会被索引。存储目录可在控制台设置里改。
