# LanDrop Skill 包

给 WorkBuddy 用的「文件管家」技能：检索、归档、批量整理 LanDrop 里的文件。

## 内容

```
SKILL.md           技能说明（WorkBuddy 读取这个文件决定怎么用）
bin/landrop.js     零依赖命令行工具，Node >= 18
config.example.json 连接配置样例
```

## 装到别处

1. 把整个目录拷到目标机器的 `~/.workbuddy/skills/landrop-librarian/`（用户级）或项目里的 `.workbuddy/skills/landrop-librarian/`。
2. 复制 `config.example.json` 到 `~/.landrop/skill.json`，填上 LanDrop 地址与令牌。
3. 自检：

```bash
node ~/.workbuddy/skills/landrop-librarian/bin/landrop.js stats
```

能打印出文件数就通了。

## 不用配置文件也行

```bash
LANDROP_URL=http://192.168.1.20:17800 LANDROP_TOKEN=xxxx node bin/landrop.js stats
```

或者每次命令带 `--url` / `--token`。

## 令牌从哪来

LanDrop 控制台 →「设置」→「自动化（Skill）」→ 复制访问令牌。
也可以在电脑上的 `data/config.json` 里看 `skillToken`。

本机调用（127.0.0.1）不需要令牌；跨机器访问才必须带。
