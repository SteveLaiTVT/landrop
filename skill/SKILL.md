---
name: landrop-librarian
description: 整理和检索 LanDrop 局域网网盘里的文件。当用户说「整理一下 LanDrop」「把文件归档」「在 LanDrop 里找某个文件」「上周手机传的东西在哪」时使用。可以搜索文件名/来源/标签/文件夹，创建归档文件夹，按类型或月份批量移动文件，抽取文本内容做摘要。文件始终留在这台电脑上，不会上传到云端。
---

# LanDrop 文件管家（landrop-librarian）

LanDrop 把一台电脑变成局域网网盘：手机扫码就能上传、下载，文件落在电脑的存储目录里。
这个 Skill 让你（WorkBuddy）通过一个本地 HTTP 接口去**检索**和**整理**这些文件。

## 什么时候用

- 用户问「昨天手机传的合同在哪」「有没有一个叫 XX 的表格」→ 用 `search`
- 用户说「把文件整理一下」「按类型归档」「上个月的东西收起来」→ 先 `plan` 再 `apply`
- 用户说「建个文件夹叫 客户资料，把 A 客户的文件放进去」→ `mkdir` + `move`
- 需要读文件内容做摘要 → `preview`

## 连接方式

LanDrop 默认监听 `http://127.0.0.1:17800`（桌面版）。网页版/源码运行时可能是 `http://127.0.0.1:8080`。

优先用随包提供的命令行工具，它已经处理了地址与令牌：

```bash
node bin/landrop.js stats
```

如果命令行工具不可用，也可以直接调 HTTP（本机调用不需要令牌；跨机需要 `Authorization: Bearer <token>`）：

```bash
curl -s http://127.0.0.1:17800/api/skill/stats
```

令牌在 LanDrop 控制台「设置 → 自动化（Skill）」里，也可以在 `data/config.json` 的 `skillToken` 字段找到。

## 常用命令

```bash
# 看一眼库里有什么
node bin/landrop.js stats

# 搜索（文件名 / 来源 / 标签 / 所在文件夹都能命中）
node bin/landrop.js search "季度 评审"
node bin/landrop.js search --kind sheet --folder 表格

# 文件夹
node bin/landrop.js folders
node bin/landrop.js mkdir "客户资料/2026"
node bin/landrop.js move --query "合同" --folder "客户资料/2026"

# 整理：先看方案，再执行
node bin/landrop.js plan --preset kind
node bin/landrop.js apply --preset kind

# 按月份归档 30 天前的文件
node bin/landrop.js plan --preset month --older-than 30
node bin/landrop.js apply --preset month --older-than 30

# 打标签、改名、看内容
node bin/landrop.js tag --query "发票" --add 待报销
node bin/landrop.js rename --id <fileId> --name "2026Q4-评审结论.docx"
node bin/landrop.js preview --id <fileId>
```

所有命令都支持 `--json`，方便你解析后转成自然语言回复。

## 整理的工作流（重要）

1. **先 `plan`，再 `apply`**。`plan` 不会动任何文件，只返回「哪个文件夹会收进多少文件、都有哪些」。
2. 把方案用中文讲给用户听，得到确认后再 `apply`。
3. 用户说的目标文件夹不存在没关系，`move` 会自动逐级创建（`客户资料/2026` 会建两层）。
4. 移动是**逻辑归档**：磁盘上文件仍在同一个存储目录，路径不变，所以不会因为整理而丢文件。
5. 删除文件夹不会删文件，里面的文件会回到上一级（或根目录的「未归档」）。

## 定时整理的推荐配置

在 WorkBuddy 里建一个每天/每周执行的自动化，prompt 写成：

> 调用 landrop-librarian：先 `plan --preset month --older-than 7`，
> 若待归档数量大于 0，则 `apply`，然后回报整理了哪些文件夹、各多少文件。

更激进一点的版本可以按类型 + 月份两级归档：
先 `apply --preset kind`，再对三个月前的文件 `apply --preset month --older-than 90`。

## 接口清单

| 能力 | 方法 | 路径 | 参数 |
|------|------|------|------|
| 能力清单 | GET | `/api/skill/manifest` | - |
| 搜索 | GET | `/api/skill/files` | `q` `folder` `kind` `tag` `limit` |
| 文件夹列表 | GET | `/api/skill/folders` | - |
| 新建文件夹 | POST | `/api/skill/folders` | `{ name }` 或 `{ path: "归档/2026-10" }` |
| 移动 | POST | `/api/skill/move` | `{ ids }` 或 `{ query }` + `{ folder }` |
| 打标签 | POST | `/api/skill/tags` | `{ ids, add, remove }` |
| 重命名 | POST | `/api/skill/rename` | `{ id, name }` |
| 整理方案 | GET | `/api/skill/plan` | `preset=kind\|month\|ext`、`olderThanDays` |
| 执行方案 | POST | `/api/skill/apply` | `{ preset }` 或 `{ steps }` |
| 统计 | GET | `/api/skill/stats` | - |
| 抽取文本 | GET | `/api/skill/preview` | `id` |

`kind` 取值：`img` `video` `audio` `pdf` `doc` `sheet` `zip`。

## 边界

- 只会操作 LanDrop 存储目录里的文件，不能读写系统其它位置。
- 单次 `move` 最多处理 500 个文件；文件多就分批。
- `preview` 对大文件只返回前 20 KB 文本，别指望它做全文检索。
- 不要在没有 `plan` 的情况下对用户的全部文件直接 `apply`——先让人看一眼。
