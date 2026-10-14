# 道藏语义检索 MCP — AI Search 独立服务

> **Cloudflare AI Search 公共端点 MCP**
> 基于 bge-m3 向量嵌入 + 关键词混合检索，覆盖 3,152 篇道藏经文的标题与开篇摘要。
> 与主服务（`daozang.godners.top/mcp`）平行，可作为独立 MCP 接入客户端。

---

## 一、功能说明

### 这是什么

Cloudflare AI Search 实例 `daozang-aisearch` 的**公共 MCP 端点**。它提供一个 `search` 工具，用自然语言在 3,152 篇道藏经文中做语义相似度检索。

与主 Worker MCP（`daozang.godners.top/mcp`，7 个工具）相比：

| | AI Search MCP（本端点） | Worker MCP（主服务） |
|---|---|---|
| **端点** | `daozang-search.godners.top/mcp` | `daozang.godners.top/mcp` |
| **传输格式** | SSE (Server-Sent Events) | 纯 JSON |
| **工具数** | 1 个 (`search`) | 7 个 |
| **检索范围** | 标题 + 开篇摘要（每篇 2 块） | 全文 285,117 块 |
| **引擎** | bge-m3 向量 + 关键词混合 | SQLite FTS5 + BM25 |
| **适合场景** | "不知经名、只有概念"的发现 | 精确原句、带行号原文取证 |
| **额度** | 1,000 语义 + 1,000 全文/月 | 只读，无查询额度限制 |

### 技术特点

- **bge-m3 嵌入模型**：专为中文优化，支持跨语言语义匹配
- **混合检索**：向量语义 + 关键词 BM25，默认 `hybrid`，`fusion_method: rrf`
- **SSE 流式返回**：结果逐条推送，大结果集无需等待全部加载
- **公共端点、无需认证**：直接接入，无需 API Token

---

## 二、端点信息

| 项 | 值 |
|---|---|
| **URL** | `https://daozang-search.godners.top/mcp` |
| **协议** | MCP 2024-11-05 over HTTP (SSE) |
| **认证** | 无需（公共端点） |
| **必需请求头** | `Accept: application/json, text/event-stream` |

快速自检：

```bash
curl -X POST https://daozang-search.godners.top/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

期望返回（SSE 格式）：

```
event: message
data: {"result":{"tools":[{"name":"search",...}],"jsonrpc":"2.0","id":1}}
```

---

## 三、`search` 工具

### 3.1 参数

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `query` | string | ✅ | — | 自然语言查询，如「如何修炼内丹」「斋醮科仪」 |
| `ai_search_options` | object | — | — | 高级选项 |
| `ai_search_options.retrieval.retrieval_type` | string | — | `"hybrid"` | `"vector"` 纯语义 / `"keyword"` 纯关键词 / `"hybrid"` 混合 |
| `ai_search_options.retrieval.fusion_method` | string | — | `"rrf"` | `"rrf"` 倒数排序融合 / `"max"` 取最大 |
| `ai_search_options.retrieval.match_threshold` | number | — | — | 分数阈值（0–1），低于此值的结果被过滤 |
| `ai_search_options.retrieval.max_num_results` | integer | — | — | 返回条数上限（1–50） |
| `ai_search_options.retrieval.context_expansion` | integer | — | — | 上下文扩展级别（0–3） |

### 3.2 基础调用示例

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": {
      "query": "内丹修炼的方法"
    }
  }
}
```

### 3.3 高级调用示例

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search",
    "arguments": {
      "query": "在山中辟谷服气养生",
      "ai_search_options": {
        "retrieval": {
          "retrieval_type": "hybrid",
          "max_num_results": 5,
          "match_threshold": 0.3
        }
      }
    }
  }
}
```

### 3.4 返回格式

SSE 流，每条 `data:` 包含一个 JSON 对象：

```
event: message
data: {"result":{"content":[{"type":"text","text":"{JSON字符串}"}]}}
```

解析 `text` 字段内的 JSON：

```json
{
  "success": true,
  "result": {
    "query_kind": "text",
    "search_query": "内丹修炼的方法",
    "chunks": [
      {
        "id": "...",
        "type": "text",
        "score": 0.9917,
        "text": "# 中华道藏-四辅真经-太清金丹经-修真太极混元指玄图\n\n源文件：...\n\n修真太极混元指玄图 > 经名：..."
      }
    ]
  }
}
```

**字段说明**：

| 字段 | 说明 |
|---|---|
| `query_kind` | `"text"` 文本查询 / `"image"` 图像查询 |
| `search_query` | 实际执行的查询（可能经过 rewrite） |
| `chunks[].score` | 相似度分数（**越大越相关**，范围 0–1） |
| `chunks[].text` | 命中文档内容（含标题、源文件名、正文片段） |

**注意**：返回的是每篇经文的**标题+开篇摘要**，不是全文。如需全文和行号，请用源文件名回到主服务调用 `search_daozang` + `get_original`。

---

## 四、使用说明

### 4.1 推荐工作流

```
1. search（本端点）      用自然语言概念提问，找到相关经文
2. search_daozang        用命中经文的文件名限定范围，做全文精确检索
3. get_original          还原带行号原文，⟦⟧ 标出命中范围 ← 引用前必用
```

### 4.2 检索策略对照

| 你的提问方式 | 推荐端点 | 原因 |
|---|---|---|
| 「怎样炼内丹？」「山中辟谷的方法」 | **本端点**（语义） | 概念性、自然语言，语义匹配更强 |
| 「致虚极守静笃」「天地悉皆归」 | 主服务 `search_daozang` | 精确原句，BM25 更准 |
| 「清静经里怎么讲」+ 自然语言 | 主服务 `list_sources` → `search_daozang` | 已知经名，全文检索 |
| 需要引用原文、给行号 | 主服务 `get_original` | 本端点不提供行号 |

### 4.3 实测样例

**查询**：`内丹修炼的方法`

```
score=0.9917 | 中华道藏-四辅真经-太清金丹经-修真太极混元指玄图.md
  修真太极混元指玄图 > 经名：修真太极混元指玄图，收录于《中华道藏》太清金丹经。
  秘传胎息诀有五门 自然胎息诀第一...

score=0.9834 | 中华道藏-三洞真经-三洞经教-太上内丹守一真定经.md
  太上内丹守一真定经 > 经名：太上内丹守一真定经...
```

**查询**：`斋醮科仪 设坛 上章`

```
score=0.9912 | 中华道藏-三洞真经-洞玄灵宝经-洞玄灵宝斋说光烛戒罚灯祝愿仪.md
score=0.9876 | 中华道藏-三洞真经-洞玄灵宝经-太上洞玄灵宝二部传授仪.md
```

---

## 五、客户端配置

> ⚠️ **兼容性前置**：本端点使用 **SSE (Server-Sent Events)** 传输 MCP 消息，不是纯 JSON。
> Claude Desktop 新版 HTTP transport 默认支持 SSE，但 Cursor、VS Code 等部分客户端可能不支持。
> 如遇兼容问题，使用主服务 `daozang.godners.top/mcp`（纯 JSON，7 工具）作为替代。

### Claude Desktop（新版，原生 HTTP）

```json
{
  "mcpServers": {
    "daozang-semantic": {
      "type": "http",
      "url": "https://daozang-search.godners.top/mcp"
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport http daozang-semantic https://daozang-search.godners.top/mcp
```

或 `.mcp.json`：

```json
{
  "mcpServers": {
    "daozang-semantic": {
      "type": "http",
      "url": "https://daozang-search.godners.top/mcp"
    }
  }
}
```

### Cursor — `.cursor/mcp.json`

> Cursor 当前 HTTP transport 可能不支持 SSE 流。如失败，改用 `mcp-remote` 桥接或主服务。

```json
{
  "mcpServers": {
    "daozang-semantic": {
      "url": "https://daozang-search.godners.top/mcp"
    }
  }
}
```

### VS Code — `.vscode/mcp.json`

> 注意顶层键是 **`servers`**。

```json
{
  "servers": {
    "daozang-semantic": {
      "type": "http",
      "url": "https://daozang-search.godners.top/mcp"
    }
  }
}
```

### Windsurf

```json
{
  "mcpServers": {
    "daozang-semantic": {
      "serverUrl": "https://daozang-search.godners.top/mcp"
    }
  }
}
```

### Zed

```json
{
  "context_servers": {
    "daozang-semantic": {
      "url": "https://daozang-search.godners.top/mcp"
    }
  }
}
```

### 只支持 stdio 的客户端

用 `mcp-remote` 桥接：

```bash
npx -y mcp-remote https://daozang-search.godners.top/mcp
```

### 同时接入两个服务

建议在客户端里同时配置主服务和语义服务，按需调用：

```json
{
  "mcpServers": {
    "daozang": {
      "type": "http",
      "url": "https://daozang.godners.top/mcp"
    },
    "daozang-semantic": {
      "type": "http",
      "url": "https://daozang-search.godners.top/mcp"
    }
  }
}
```

---

## 六、配额与限制

| 资源 | 免费层限额 | 当前用量 | 状态 |
|---|---|---|---|
| 语义查询 | **1,000/月** | — | ⚠️ 使用时须节制 |
| 全文查询 | **1,000/月** | — | ⚠️ 使用时须节制 |
| 摄入 tokens | 5,000,000/月 | 2,573,289（标题+开篇 2 块/篇） | ✅ 51.5% |
| 存储 | 10 GB/月 | 3,152 个文档 | ✅ |
| 文件数 | 100,000/实例 | 3,152 | ✅ |

**两个必须知道的限制**：

1. **额度用尽后服务报错**：当月 1,000 次语义查询用完后，`search` 工具会返回错误，需等待次月重置或改用主服务。

2. **只含标题+开篇，不含全文**：受 5M tokens/月额度限制，全量 190 MB 约 90M tokens（18×预算），不可行。如需全文检索和原文取证，使用主服务 `daozang.godners.top/mcp`。

---

## 七、公共端点配置方法（管理员参考）

若需自行配置或修改 AI Search 公共端点：

```bash
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...

# 1. 更新实例，启用公共端点 + MCP + 自定义域名
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-search/instances/daozang-aisearch" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "enable": true,
    "public_endpoint_params": {
      "enabled": true,
      "default_domain_enabled": true,
      "authorized_hosts": ["*"],
      "mcp": { "disabled": false },
      "custom_domains": ["daozang-search.godners.top"]
    }
  }'

# 2. 在 DNS 中添加 CNAME 或让 Wrangler 自动创建
# 若域名托管在 Cloudflare，AI Search 会自动处理证书
```

如需关闭公共端点：

```bash
curl -X PUT ".../ai-search/instances/daozang-aisearch" \
  -H "..." \
  -d '{"public_endpoint_params": {"enabled": false}}'
```

---

## 八、相关端点速查

| 服务 | 端点 | 用途 |
|---|---|---|
| **AI Search MCP（语义）** | `https://daozang-search.godners.top/mcp` | 本端点，概念发现 |
| **Worker MCP（全文+取证）** | `https://daozang.godners.top/mcp` | 7 工具，精确检索+原文行号 |
| **Worker MCP 备用** | `https://daozang-mcp.godners.workers.dev/mcp` | 同上，备用入口 |
