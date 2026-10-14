# 道藏考据 MCP — Cloudflare 版

> **DaoZang Reasoner on Cloudflare Workers**
> 在《中华道藏》《正统道藏》全文中做**可溯源**的检索与原文取证，以 MCP（Model Context Protocol）提供服务。

[![Deploy](https://img.shields.io/badge/platform-Cloudflare%20Workers-F6821F)](https://daozang.godners.top/mcp)
[![Protocol](https://img.shields.io/badge/MCP-2024--11--05-blue)](https://modelcontextprotocol.io)

---

## 一、这是什么

一个跑在 **Cloudflare 免费层**上的 MCP 服务器，把 3,152 篇道藏经文（285,117 个文本块，约 1 GB 索引）做成可检索、可回原文取证的工具集。

与单纯的全文检索不同，它解决了考据场景的核心问题：**检索到的片段能不能引用**。
`search_daozang` 返回的是建库时清洗过的正文（已去 Markdown 记号、压缩空白），只适合判断相关性；
`get_original` 会重放同一套清洗规则，把命中块**精确映射回原始 Markdown**，给出行号并用 `⟦…⟧` 标出命中范围 —— 引用前必用这一步。

### 线上实例

| 用途 | URL |
|---|---|
| **主端点** | `https://daozang.godners.top/mcp` |
| **备用端点** | `https://daozang-mcp.godners.workers.dev/mcp` |

传输：HTTP + JSON-RPC 2.0（POST），MCP 协议版本 `2024-11-05`，**公开只读、无需认证**。

快速自检：

```bash
curl -X POST https://daozang.godners.top/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## 二、架构

```
┌──────────────┐   POST /mcp (JSON-RPC)   ┌──────────────────────────────┐
│ MCP 客户端    │ ───────────────────────► │  Cloudflare Worker           │
│ (Claude/Cursor│ ◄─────────────────────── │  src/index.ts                │
│  /VS Code…)   │                          └──────┬───────────┬───────────┘
└──────────────┘                                 │           │
                                                 │           │
              ┌──────────────────────────────────┘           └──────────────┐
              ▼                                                             ▼
  ┌───────────────────────────────┐                        ┌────────────────────────┐
  │ Durable Objects × 6 (SQLite)  │                        │ Workers Assets          │
  │  class DaozangIndex           │                        │  public/markdowns/      │
  │  shard-0 … shard-5            │                        │  3,152 篇原文 (190 MB)  │
  │  FTS5 全文索引 + BM25         │                        └────────────────────────┘
  │  ~285k 行 / 1,024 MB          │
  └───────────────────────────────┘                        ┌────────────────────────┐
                                                           │ Workers KV (1 key)      │
                                                           │  "sources" 经文目录索引  │
                                                           └────────────────────────┘
```

**为什么是这套组合**

| 组件 | 承担的职责 | 选型理由 |
|---|---|---|
| **Durable Objects** | 全文索引与查询 | SQLite 后端支持 FTS5；查询不计 CPU（免费层只有 10ms/请求，若用纯 Worker 内存/CPU 都不够）；1 GB/Object 存储 |
| **Workers Assets** | 原文 Markdown | 190 MB 语料静态托管；免费层 20,000 文件 × 25 MiB 足够；不走 KV 以避开写入配额 |
| **Workers KV** | 经文目录索引 | 只存 1 个 key（288 KB），全生命周期仅 1 次写入，绕开 1,000 次/天配额 |

### 为什么分 6 个分片

全量索引约 1,065 MB，超过 DO **1 GB/Object** 上限。按 `source` 哈希（`h*31 + charCode mod 6`）分片，
**同一篇经文的所有块落在同一分片**，这样 `get_original` 的按篇定位只需访问一个 DO。

| 分片 | 实例名 | 行数 | 大小 |
|---|---|---|---|
| 0 | `shard-0` | 42,639 | 153.09 MB |
| 1 | `shard-1` | 42,229 | 152.93 MB |
| 2 | `shard-2` | 50,768 | 181.73 MB |
| 3 | `shard-3` | 39,994 | 144.40 MB |
| 4 | `shard-4` | 58,598 | 210.36 MB |
| 5 | `shard-5` | 50,889 | 181.33 MB |
| **合计** | | **285,117** | **1,023.84 MB** |

---

## 三、六个工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `daozang_protocol` | 取考据方法论（**先用这个**） | — |
| `daozang_status` | 馆藏状态：块数 / 篇数 / 分片规模 | — |
| `list_sources` | 按经名关键词列经目 | `keyword`, `limit` |
| `search_daozang` | 全文检索（FTS5 + BM25） | `query`, `top_k`, `source_filter` |
| `get_original` | 取带行号原文 + `⟦命中⟧` 标记 | `source`, `chunk_index`, `context` |
| `read_source` | 读整篇 Markdown 全文 | `source`, `max_chars` |

### 推荐工作流

```
1. daozang_protocol   读方法论
2. list_sources       用「清静」「悟真」等关键词缩小到某几部经
3. search_daozang     检索命中块（用原句短语，不要用问句）
4. get_original       还原带行号原文，⟦…⟧ 标出命中范围 ← 引用前必用
5. read_source        需要通读时取全文
```

### 检索要点

- ✅ 好用：专名 / 原句短语 —— 「周天火候」「天地悉皆归」「黄庭」「无为」
- ❌ 不好用：自然语言长问句 —— 「什么是内丹修炼中的周天火候？」（请自行切出术语）
- 支持 **2 字**短词。中文采用**分字索引**（每个 CJK 字符两侧加空格后交给 `unicode61`），
  这是刻意选择 —— SQLite 的 `trigram` tokenizer 对 2 字查询失效，对中文术语是致命的。

实测样例：

```
查询「致虚极守静笃」
  -9.4156 | 道德真经三解(邓锜).md
  -9.4156 | 老子道德经憨山注.md
  -8.9826 | 道德真经直解.md   ← 原文「致虚极，守静笃。万物并作，吾以观其复。」

get_original → located=True, lines 43–47
  …终为上升而列仙⟦。宜乎哉。

  人能常清静，天地悉皆归。

  天地者，乃大道之子孙也；人物者，大道之苗裔也。太上言人能…⟧
```

---

## 四、快速开始（使用现成实例）

不想自己部署？直接把端点接到你的 MCP 客户端即可。

**Claude Desktop**（新版原生 HTTP）：

```json
{
  "mcpServers": {
    "daozang": {
      "type": "http",
      "url": "https://daozang.godners.top/mcp"
    }
  }
}
```

**Claude Code**：`claude mcp add --transport http daozang https://daozang.godners.top/mcp`

**VS Code**（注意顶层键是 `servers`）：`.vscode/mcp.json`

```json
{
  "servers": {
    "daozang": {
      "type": "http",
      "url": "https://daozang.godners.top/mcp"
    }
  }
}
```

更多客户端（Cursor / Windsurf / Zed / Codex CLI / stdio 桥接）见 **[USAGE.md](USAGE.md)**。

---

## 五、自己部署

完整步骤见 **[DEPLOY.md](DEPLOY.md)**。概要：

```bash
git clone https://github.com/Godners-Code/daozang-mcp-cloudflare.git
cd daozang-mcp-cloudflare
npm install

export CLOUDFLARE_API_TOKEN=...   # 需 Workers / KV / DO 写权限
export CLOUDFLARE_ACCOUNT_ID=...

npx wrangler kv namespace create daozang-kv   # 把返回的 id 填进 wrangler.toml
npx wrangler secret put ADMIN_TOKEN

# 放入语料：public/markdowns/*.md（3,152 篇）
./deploy.sh

# 导入索引（注意 DO 免费层 10 万行/天，需多日）
CF_WORKER=https://<your-worker>.workers.dev CF_ADMIN_TOKEN=<token> \
  python tools/ingest_cf.py --shards 0,1
```

> ⚠️ **部署与 GitHub 无关**：Worker 通过 `wrangler deploy` 直接从本地上传，
> 本仓库只作为源码归档，不含 CI/CD 流水线。

---

## 六、免费层配额与硬限制

| 资源 | 限额 | 当前用量 | 状态 |
|---|---|---|---|
| DO 写入行数 | **100,000 行/天**（UTC 00:00 重置） | 285,117 行（一次性历史导入） | 日常只读，基本不消耗 |
| DO 存储 | 1 GB/实例 · 5 GB/账号 | 1,023.84 MB（6 分片） | ⚠️ 贴近上限，勿再加数据 |
| KV 写入 | 1,000 次/天 | `sources` 仅 **1 次** | ✅ |
| KV 存储 | 1 GB | 288 KB | ✅ |
| Workers 请求 | 100,000/天 | — | ✅ |
| Assets | 20,000 文件 × 25 MiB | 3,152 文件 / 190 MB | ✅ |

**三个必须知道的坑**

1. **DO 写入配额耗尽后，读仍正常。**
   `ensure()`（`CREATE TABLE IF NOT EXISTS`）用 try/catch 包裹，配额打满时不会让查询一起挂掉。
   但这意味着**不能靠"能否建表"判断配额** —— 只能靠实际写入是否报错。

2. **Cloudflare API 不暴露剩余写入配额。**
   GraphQL 的 DO 类型只有 `storedBytes`/`requests`/`errors`，没有 `rowsWritten`；
   `/scripts/{name}/limits` 端点不存在。配额只能通过实测判断。

3. **DO 实例无法真正删除。**
   `DELETE .../objects/{id}` 返回 `405`。只能 `storage.deleteAll()` 清空数据，实例 ID 会残留（靠系统 GC）。

---

## 七、⚠️ 禁止重命名

**不要改 DO class 名，也不要改 `shard-0..5` 实例名。**

实例名由 `idFromName()` 决定，`renamed_classes` 迁移只改 class、不改实例名。
一旦改名，代码会去找全新的空实例，现有 285,117 行数据被孤立 ——
而免费层 10 万行/天的写入配额意味着**重导需要 3–4 天**。

代码内已在 `wrangler.toml` 与 `src/index.ts` 两处加了防呆注释。

---

## 八、目录结构

```
.
├── README.md              本文件
├── DEPLOY.md              部署与数据导入
├── USAGE.md               使用与客户端配置
├── wrangler.toml          Worker 配置（DO / KV / Assets / 路由）
├── src/index.ts           Worker + DO + MCP 实现（单文件）
├── tools/ingest_cf.py     分片索引导入（支持 --shards 多日分批）
├── tools/put_sources.py   经文目录索引写入 KV
├── deploy.sh              部署脚本（走 wrangler deploy，不经 GitHub）
└── public/markdowns/      原文语料（不入库，作为 Assets 上传）
```

---

## 九、相关项目

| 平台 | 仓库 / 地址 | 形态 |
|---|---|---|
| Cloudflare | 本仓库 | Workers + DO，HTTP MCP |
| HuggingFace | `Godners/daozang-reasoner-mcp` | Static Space（源码托管） |
| Smithery | `godners/daozang-mcp` | MCPB 本地包（stdio） |
| Prefect Horizon | `daozang-mcp-horizon` | HTTP MCP |

语料来源：`Godners/DaoZang`（HF dataset）。

---

## 十、许可

代码部分可自由使用。语料为《中华道藏》《正统道藏》文本，属公共领域典籍，
但其整理本的版权请遵循上游数据集 `Godners/DaoZang` 的说明。
