# 部署说明 — Cloudflare 版

> 目标：从零部署一个可运行的道藏考据 MCP 服务。
> **部署链路与 GitHub 无关** —— Worker 由 `wrangler deploy` 直接从本地上传，本仓库仅作源码归档。

---

## 一、前置条件

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20（wrangler 4 需要） |
| Python | ≥ 3.10（导入脚本需要 `pyarrow`） |
| Cloudflare 账号 | 免费层即可 |
| API Token | 需 **Workers / KV / Durable Objects** 写权限 |
| 语料 | `data/*.parquet`（含 `source`/`title`/`text`/`chunk_index`）+ `markdowns/*.md` |

语料来自 HF 数据集 `Godners/DaoZang`：3,152 篇经文、285,117 块。

```bash
git clone https://github.com/Godners-Code/daozang-mcp-cloudflare.git
cd daozang-mcp-cloudflare
npm install
```

> 若 `npm install` 报 peer 依赖冲突，确认 `@cloudflare/workers-types` 与 wrangler 大版本匹配
> （本项目锁 `^5.20261013.0` 配 wrangler `^4`）。
> 若报 `workerd` 二进制缺失，手动 `npm install @cloudflare/workerd-windows-64@<匹配版本>`。

---

## 二、Cloudflare 资源准备

### 2.1 设置凭据

```bash
export CLOUDFLARE_API_TOKEN=cfut_xxxxxxxxxxxxxxxxxxxx
export CLOUDFLARE_ACCOUNT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

如需走代理（wrangler 的默认出网在某些网络下不通）：

```bash
export CF_PROXY=http://host:port
```

> 注意：wrangler 读的是 `HTTP_PROXY`/`HTTPS_PROXY`。某些 shell 会预置小写变量并覆盖大写写法，
> 导致 `fetch failed`。`deploy.sh` 里大小写两套都设了。

### 2.2 创建 KV 命名空间

```bash
npx wrangler kv namespace create daozang-kv
```

把返回的 `id` 填进 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "DAOZANG_KV"
id = "<你的 namespace id>"
```

### 2.3 设置 admin token

管理端点（`/admin/*`）用它鉴权。**绝不要写进仓库**：

```bash
npx wrangler secret put ADMIN_TOKEN
```

设置后，把 `wrangler.toml` 里 `[vars] ADMIN_TOKEN` 留空（secret 覆盖 var）：
未设置时 `/admin/*` 一律返回 401，而 `/mcp` 照常可用。

### 2.4 准备原文语料（Assets）

```bash
mkdir -p public/markdowns
cp -r /path/to/markdowns/*.md public/markdowns/
# 或建立软链：ln -s /path/to/markdowns public/markdowns
```

`wrangler.toml` 中已配置：

```toml
[assets]
directory = "./public"
binding = "ASSETS"
```

Assets 免费层上限 20,000 文件 × 25 MiB；本语料 3,152 文件 / 190 MB，够用。

> 这些文件**不入库**（`.gitignore` 已排除 `public/markdowns/`），但部署时需要真实存在。

---

## 三、部署 Worker

```bash
./deploy.sh
# 等价：npx wrangler deploy
```

首次部署会创建 DO class `DaozangIndex`（migration tag `v1`，`new_sqlite_classes`）。

### 3.1 自定义域名（可选）

在 `wrangler.toml` 加：

```toml
routes = [
  { pattern = "daozang.godners.top", custom_domain = true }
]
workers_dev = true        # 必须显式保留！
```

**⚠️ 坑**：加了 `routes` 之后，如果不写 `workers_dev = true`，wrangler 会
**静默禁用 workers.dev**（警告语：`Because 'workers_dev' is not in your Wrangler file, it will be disabled`）。
在自定义域名证书 pending 期间，服务会**完全不可用**。两个入口都留着最稳。

### 3.2 ⚠️ 自定义域名必须关闭 Bot Fight Mode

配好 custom domain 后，程序化请求可能被 Cloudflare 挑战页 `Just a moment...` 拦截，
**这会阻断所有 MCP 客户端**。

排查结果：

```
security_level : essentially_off   （不是它）
waf            : off               （不是它）
bot_fight_mode : 不在 zone settings API 里（56 个设置中没有），无法通过 API 关闭
```

**必须在 Dashboard 手动关闭**：

> Cloudflare Dashboard → 选择域名 → **Security → Bots** → **Bot Fight Mode** → **Off**

验证（应直接返回 JSON，而不是挑战页）：

```bash
curl -X POST https://daozang.godners.top/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

---

## 四、数据导入

### 4.1 导入经文目录（KV）

```bash
export CF_WORKER=https://daozang-mcp.<sub>.workers.dev
export CF_ADMIN_TOKEN=<你的 ADMIN_TOKEN>
python tools/put_sources.py
```

结果：3,152 条 `{source, chunks}` 写入 KV 单 key `sources`（288 KB）。
**全生命周期只需 1 次写入**，这是绕开 KV 1,000 次/天配额的关键设计。

### 4.2 导入索引（Durable Objects）— ⚠️ 需多日

**DO 免费层限制 100,000 行写入/天**（UTC 00:00 重置）。全量 285,117 行，必须分批。

分片行数实测：

| 分片 | 行数 |
|---|---|
| 0 | 42,639 |
| 1 | 42,229 |
| 2 | 50,768 |
| 3 | 39,994 |
| 4 | 58,598 |
| 5 | 50,889 |
| **合计** | **285,117** |

**推荐 4 天计划**（每日 ≤ 95,000，留 5% 重试余量）：

```bash
# Day 1 — 84,868 行
python tools/ingest_cf.py --shards 0,1

# Day 2 — 90,762 行
python tools/ingest_cf.py --shards 2,3

# Day 3 — 58,598 行
python tools/ingest_cf.py --shards 4

# Day 4 — 50,889 行
python tools/ingest_cf.py --shards 5
```

也可以用 `--max-rows` 硬上限（脚本会先打印分片分布再打印本次计划量）：

```bash
python tools/ingest_cf.py --max-rows 95000
```

> **为何不是 3 天**：3 × 95,000 = 285,000 < 285,117，安全线内装不下。
> 激进的 3 天分组最大组达 98,592，余量仅 1.4%，失败重试就会超配额，不推荐。

**其他参数**

| 参数 | 默认 | 说明 |
|---|---|---|
| `--batch` | 1000 | 每批行数 |
| `--workers` | 3 | 并发上传数 |
| `--files` | 全部 6 个 parquet | 指定输入文件 |
| `--reset` | — | 导入前清空所有分片（**危险**） |
| `--limit` / `--offset` | 0 | 行数切片 |

**每日导入前后用 `/admin/stats` 核对行数**（见 §五）。

### 4.3 导入的技术细节（踩过的坑）

- **DO SQLite 绑定变量上限约 100 个**：50 行 × 4 参数 = 200 变量即报
  `too many SQL variables at offset 275`。改用**字符串拼接**（单引号转义）绕过。
- **DO SQLite 语句长度上限约 28,000 字符**：200 行（57k 字符）报 `SQLITE_TOOBIG`。
  代码里设 `MAX_STMT = 25,000` 字符分块 flush。
- **Python `requests` 经代理并发会持续 502**：导入脚本改用 `subprocess` 调 `curl`，
  单请求稳定，带 4 次重试。

---

## 五、验证

### 5.1 管理端点（需 `x-admin-token`）

```bash
T=<你的 ADMIN_TOKEN>
curl -H "x-admin-token: $T" https://<worker>/admin/stats
curl -H "x-admin-token: $T" https://<worker>/admin/diag
```

| 端点 | 用途 |
|---|---|
| `/admin/stats` | 各分片行数与大小 |
| `/admin/diag` | binding 与各分片健康 |
| `/admin/idof` | 实例名 → DO ID 映射（排查孤儿实例） |
| `/admin/inspect?id=` | 查任意实例 |
| `/admin/wipe?id=` | 清空任意实例 —— **危险** |
| `/admin/reset` | 清空所有分片 —— **危险** |
| `/admin/clear-probe` | 删除测试探针行 |
| `/admin/put-sources` | 写入 KV 目录索引 |

期望的 `/admin/stats`：

```
totalRows: 285117
totalMB:   1023.84
shards:    42639 / 42229 / 50768 / 39994 / 58598 / 50889
```

### 5.2 MCP 端点

```bash
# 握手
curl -X POST https://<worker>/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'

# 工具列表（应为 6 个）
curl -X POST https://<worker>/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 检索
curl -X POST https://<worker>/mcp -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_daozang","arguments":{"query":"天地悉皆归","top_k":3}}}'
```

### 5.3 验收清单

- [ ] `tools/list` 返回 6 个工具
- [ ] `daozang_status` 的 `n_chunks` = 285,117、`n_files` = 3,152
- [ ] `list_sources` 用「清静」能匹配到约 24 篇
- [ ] `search_daozang` 用 2 字词（「无为」「黄庭」）能命中
- [ ] `get_original` 返回 `located: true` 且带行号与 `⟦⟧` 标记
- [ ] `read_source` 能取到全文

---

## 六、排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `Exceeded allowed rows written in Durable Objects free tier` | 当日 10 万行配额耗尽 | 等 UTC 00:00 重置；**读功能不受影响** |
| 导入后所有写都失败，包括 `CREATE TABLE` | 同上 | 同上。`ensure()` 有 try/catch，查询照常工作 |
| wrangler `fetch failed` | 出网被拦 | 设 `HTTP_PROXY`/`HTTPS_PROXY`（大小写都设）或 `CF_PROXY` |
| 上传持续 502 | `requests` + 代理并发问题 | 脚本已用 `curl`；确认 `CF_PROXY` 正确 |
| custom domain 返回 `Just a moment...` | Bot Fight Mode | Dashboard → Security → Bots → Off |
| 加了 custom domain 后 workers.dev 404 | wrangler 静默禁用了 | `wrangler.toml` 显式写 `workers_dev = true` |
| 中文查询零命中 | tokenizer 问题 | 确认用了分字方案（`zhSplit`），不要用 `trigram` |
| `too many SQL variables` | DO SQLite 变量上限 ~100 | 已用字符串拼接规避，勿改回绑定变量 |
| `SQLITE_TOOBIG` | 语句超 ~28k 字符 | `MAX_STMT` 已设 25,000，勿调大 |
| DO 存储超限 | 单实例 > 1 GB | 已 6 分片；扩容需减行数或升 Paid（10 GB/Object） |
| 孤儿实例占配额 | 早期测试残留 | `/admin/idof` 映射 → `/admin/inspect?id=` 确认 → `/admin/wipe?id=` 清空 |

### 配额自助探测

由于 API 不暴露剩余写入量，用 1 行写入实测最可靠（会消耗 1 行配额）：

```bash
curl -X POST -H "Content-Type: application/json" -H "x-admin-token: $T" \
  -d '{"rows":[["test_quota_probe","测试","探针",99999]]}' \
  https://<worker>/admin/ingest?shard=0
# 返回 {"inserted":1} → 配额可用
# 返回 配额错误     → 当日已耗尽
curl -X POST -H "x-admin-token: $T" https://<worker>/admin/clear-probe   # 记得清理
```

---

## 七、更新部署

```bash
# 改代码后
./deploy.sh
```

**不要**通过改 class 名 / 实例名来"整理"命名 —— 见 README §七，会造成全量重导。
