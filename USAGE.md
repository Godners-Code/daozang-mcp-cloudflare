# 使用说明 — 道藏考据 MCP（Cloudflare 版）

> 服务端版本 `daozang-reasoner` v1.2.0　协议版本 `2024-11-05`
> 语料：《中华道藏》+《正统道藏》共 **3,152 篇 / 285,117 块**
> 引擎：Durable Object SQLite **FTS5**（中文分字 + BM25）

---

## 一、端点

| 用途 | URL | 状态 |
|---|---|---|
| **主端点** | `https://daozang.godners.top/mcp` | ✅ 可用 |
| **备用端点** | `https://daozang-mcp.godners.workers.dev/mcp` | ✅ 可用 |

- 传输：HTTP / JSON-RPC 2.0（POST）
- 支持方法：`initialize` / `tools/list` / `tools/call` / `ping` / `notifications/*`
- **公开只读，无需认证**；管理端点 `/admin/*` 需 `x-admin-token`，不对外暴露

自检：

```bash
curl -X POST https://daozang.godners.top/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## 二、七个工具

| 工具 | 作用 | 参数 |
|---|---|---|
| `daozang_protocol` | 取考据方法论 | 无 |
| `daozang_status` | 馆藏状态 | 无 |
| `search_semantic` | 语义检索（bge-m3 + 混合） | `query`(必填), `top_k`(1–20, 默认 5) |
| `list_sources` | 按经名关键词列经目 | `keyword`, `limit`(1–500, 默认 50) |
| `search_daozang` | 全文检索 | `query`(必填), `top_k`(1–50, 默认 5), `source_filter`, `context` |
| `get_original` | 带行号原文 + `⟦命中⟧` | `source`(必填), `chunk_index`(必填), `context` |
| `read_source` | 整篇 Markdown | `source`(必填), `max_chars`(默认 20000) |

### 2.1 推荐工作流

```
1. daozang_protocol   读方法论
2. list_sources       用「清静」「悟真」缩小到某几部经
3. search_semantic    概念性/自然语言提问，先找是哪部经（语义）
4. search_daozang     检索命中块（用原句短语，不要用问句）
5. get_original       还原带行号原文，⟦…⟧ 标出命中范围 ← 引用前必用
6. read_source        需要通读时取全文
```

### 2.2 检索要点

#### FTS5（search_daozang）
- ✅ 好用：专名 / 原句短语 —— 「周天火候」「天地悉皆归」「黄庭」「无为」
- ❌ 不好用：自然语言长问句 —— 「什么是内丹修炼中的周天火候？」（自行切出术语）
- 支持 **2 字**短词（分字索引方案），实测「无为」「黄庭」精准命中
- 检索返回的是**清洗过的正文**，引用前一律用 `get_original` 回原文取证

#### 语义检索（search_semantic）
- ✅ 好用：概念/自然语言 —— 「怎样炼内丹」「斋醮科仪」「山中辟谷服气」
- ❌ 不好用：精确原句比对（BM25 更适合）
- 范围：3,152 篇经文的**标题与开篇摘要**，不含全文
- ⚠️ **免费层每月仅 1,000 次语义查询额度**，命中后仍需回到 `search_daozang` + `get_original` 取证

### 2.3 调用示例

**检索**

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "search_daozang",
    "arguments": { "query": "致虚极守静笃", "top_k": 3 }
  }
}
```

返回：

```json
{
  "query": "致虚极守静笃",
  "engine": "fts5-bm25",
  "count": 3,
  "hits": [
    { "score": -9.4156, "source": "中华道藏-四辅真经-道德真经-道德真经三解(邓锜).md",
      "title": "…", "chunk_index": 41, "text": "…" },
    { "score": -8.9826, "source": "正统道藏-None-正统道藏洞神部-道德真经直解.md",
      "chunk_index": 12, "text": "致虚极，守静笃。万物并作，吾以观其复…" }
  ]
}
```

> `score` 是 BM25 分值，**越小越相关**（负值）。

**语义检索**

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "search_semantic",
    "arguments": { "query": "斋醮科仪 设坛 上章", "top_k": 3 }
  }
}
```

返回：

```json
{
  "query": "斋醮科仪 设坛 上章",
  "engine": "ai-search-bge-m3",
  "available": true,
  "count": 3,
  "hits": [
    { "score": 0.5284, "source": "中华道藏-三洞真经-洞玄灵宝经-洞玄灵宝斋说光烛戒罚灯祝愿仪.md",
      "title": "…", "text": "洞玄灵宝斋说光烛戒罚灯祝愿仪 > 经名：…" },
    { "score": 0.5188, "source": "中华道藏-三洞真经-洞玄灵宝经-太上洞玄灵宝二部传授仪.md",
      "text": "太上洞玄灵宝二部传授仪 > 经名：…" }
  ],
  "monthly_quota": "1,000 语义查询/月（免费层）"
}
```

> `score` 是混合分数，**越大越相关**（正值）。命中后请用 `source` 字段继续用 `search_daozang` + `get_original` 取证。

**原文取证**

```json
{
  "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": {
    "name": "get_original",
    "arguments": {
      "source": "中华道藏-三洞真经-三洞经教-太上老君说常清静经注(无名氏).md",
      "chunk_index": 25,
      "context": 150
    }
  }
}
```

返回：

```json
{
  "located": true,
  "source": "中华道藏-三洞真经-三洞经教-太上老君说常清静经注(无名氏).md",
  "chunk_index": 25,
  "title": "…",
  "line_start": 43, "line_end": 47,
  "window_line_start": 41, "window_line_end": 49,
  "text": "…终为上升而列仙⟦。宜乎哉。\n\n人能常清静，天地悉皆归。\n\n天地者，乃大道之子孙也…⟧"
}
```

`⟦…⟧` 之间的部分就是命中的块；行号对应**原始 Markdown 文件**，可直接用于引用。

---

## 三、客户端配置

> 把下面 URL 中的主机名换成你选用的端点。两个端点功能完全一致。

### Claude Desktop

新版（原生 HTTP）：

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

旧版（需 Node，走 `mcp-remote` 桥接）：

```json
{
  "mcpServers": {
    "daozang": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://daozang.godners.top/mcp"]
    }
  }
}
```

### Claude Code（CLI）

```bash
claude mcp add --transport http daozang https://daozang.godners.top/mcp
```

或 `.mcp.json`：

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

### Cursor — `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "daozang": {
      "url": "https://daozang.godners.top/mcp"
    }
  }
}
```

### VS Code — `.vscode/mcp.json`

> ⚠️ VS Code 的顶层键是 **`servers`**，不是 `mcpServers`。

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

### Windsurf — `~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "daozang": {
      "serverUrl": "https://daozang.godners.top/mcp"
    }
  }
}
```

### Zed — `settings.json`

> ⚠️ 顶层键是 **`context_servers`**。

```json
{
  "context_servers": {
    "daozang": {
      "url": "https://daozang.godners.top/mcp"
    }
  }
}
```

### Codex CLI — `~/.codex/config.toml`

```toml
[mcp_servers.daozang]
url = "https://daozang.godners.top/mcp"
```

### 只支持 stdio 的客户端

统一用 `mcp-remote` 桥接：

```bash
npx -y mcp-remote https://daozang.godners.top/mcp
```

### 客户端配置速查

| 客户端 | 配置文件 | 顶层键 |
|---|---|---|
| Claude Desktop | `claude_desktop_config.json` | `mcpServers` |
| Claude Code | `.mcp.json` | `mcpServers` |
| Cursor | `.cursor/mcp.json` | `mcpServers` |
| VS Code | `.vscode/mcp.json` | **`servers`** |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers`（用 `serverUrl`） |
| Zed | `settings.json` | **`context_servers`** |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.<name>]` |

---

## 四、运维说明

### 4.1 配额（免费层）

| 资源 | 限额 | 当前用量 | 状态 |
|---|---|---|---|
| DO 写入行数 | 100,000 行/天（UTC 00:00 重置） | 285,117 行（历史一次性导入） | 日常只读，基本不消耗 |
| DO 存储 | 1 GB/实例 · 5 GB/账号 | 1,023.84 MB | ⚠️ 贴近上限，勿再加数据 |
| KV 写入 | 1,000 次/天 | `sources` 仅 **1 次** | ✅ |
| Workers 请求 | 100,000/天 | — | ✅ |
| AI Search 摄入 tokens | 5,000,000/月 | 2,573,289（标题+开篇 2 块/篇） | ⚠️ 51.5%，余量充裕 |
| AI Search 语义查询 | **1,000/月** | — | ⚠️ 使用时须节制 |

### 4.2 分片现状

| 分片 | 实例名 | 行数 | 大小 |
|---|---|---|---|
| 0 | `shard-0` | 42,639 | 153.09 MB |
| 1 | `shard-1` | 42,229 | 152.93 MB |
| 2 | `shard-2` | 50,768 | 181.73 MB |
| 3 | `shard-3` | 39,994 | 144.40 MB |
| 4 | `shard-4` | 58,598 | 210.36 MB |
| 5 | `shard-5` | 50,889 | 181.33 MB |

> ⚠️ **禁止重命名 class 或改实例名**。实例名由 `idFromName()` 决定，
> 改名会创建空实例、孤立现有 285,117 行数据，迫使全量重导（免费层需 3–4 天）。

### 4.3 管理端点（需 `x-admin-token`）

| 端点 | 用途 |
|---|---|
| `/admin/stats` | 各分片行数与大小 |
| `/admin/diag` | binding 与各分片健康 |
| `/admin/idof` | 实例名 → DO ID 映射（排查孤儿） |
| `/admin/inspect?id=` | 查任意实例 |
| `/admin/wipe?id=` | 清空任意实例 —— **危险，慎用** |
| `/admin/clear-probe` | 清测试探针行 |
| `/admin/put-sources` | 写入 KV 目录索引 |

---

## 五、常见问题

**Q：为什么 KV 里只有 1 个 key？**
A：原文走 Assets（190 MB），KV 只存目录索引 `sources`（288 KB）。
这样把 KV 写入次数从 3,152 次降到 1 次，避开 1,000 次/天配额。

**Q：检索结果能直接引用吗？**
A：不能。检索返回的是清洗过的正文（已去 Markdown 记号、压缩空白）。
引用前必须用 `get_original` 还原原文，它会给出行号并用 `⟦⟧` 标出命中范围。

**Q：BM25 分数为什么是负的？越大越好还是越小越好？**
A：SQLite FTS5 的 `bm25()` 返回负值，**绝对值越大越相关**（即数值越小越相关）。
排序已按 `ORDER BY score` 升序处理。

**Q：为什么必须保留 `shard-0..5` 这个名字？**
A：这 6 个实例里存着全部 285,117 行数据。改名会创建空实例、孤立数据，
且免费层 10 万行/天的写入配额意味着重导要 3–4 天。

**Q：DO 存储快满了怎么办？**
A：当前 1,023.84 MB 已贴 1 GB/Object 上限。若不扩容，请勿再导入新数据。
如需扩容，只能减少分片行数或升级到 Workers Paid（10 GB/Object）。

**Q：查询返回空怎么办？**
A：① 换更短的核心词（2 字词是支持的）；② 去掉 `source_filter` 再试；
③ 注意异体字（「无／無」「炁／气」）两种写法都试；
④ 本库仅《中华道藏》《正统道藏》文本，不含敦煌本、辑佚本等库外材料。

**Q：自定义域名被 Cloudflare 挑战页拦住？**
A：关闭 Bot Fight Mode：Dashboard → 域名 → Security → Bots → Off。详见 DEPLOY.md。
临时可改用备用端点 `daozang-mcp.godners.workers.dev`。

**Q：语义检索 `search_semantic` 为什么返回空？**
A：语义检索范围是每篇的**标题+开篇摘要**（不含全文），适合概念性提问，不适合精确原句。
如果零命中，先放宽问题，再用 `search_daozang` 做全文精确检索。

**Q：语义检索额度用完了怎么办？**
A：免费层 1,000 次/月，用尽后该工具会返回错误。
可以：① 等次月重置；② 直接只用 `search_daozang`（FTS5 不消耗 AI Search 额度）。

**Q：为什么不把全文也放进 AI Search？**
A：全量 190 MB 约 90M tokens，而免费层月额度仅 5M（18×），不可行。
