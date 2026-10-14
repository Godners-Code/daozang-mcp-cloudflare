import { DurableObject } from "cloudflare:workers";

export interface Env {
  DAOZANG_DO: DurableObjectNamespace;
  DAOZANG_KV: KVNamespace;
  ASSETS: Fetcher;
  AI?: Ai;
  ADMIN_TOKEN?: string;
  AI_SEARCH_INSTANCE?: string;
}

/** Full corpus is ~1.06 GB, above the 1 GB/Object free limit, so split across shards. */
const SHARDS = 6;
const SERVER_NAME = "daozang-reasoner";
const SERVER_VERSION = "1.2.0";
const TOTAL_CHUNKS = 285117;
const TOTAL_FILES = 3152;

/** AI Search holds ONE compact doc per scripture (title + opening), not the full corpus:
 *  the free tier allows 5M ingestion tokens/month and the full corpus needs ~90M. */
const AI_SEARCH_N_DOCS = 3152;

const CJK = /[㐀-䶿一-鿿豈-﫿]/g;

export function zhSplit(s: string): string {
  return s.replace(CJK, (c) => ` ${c} `).replace(/\s+/g, " ").trim();
}

export function buildMatch(q: string): string {
  const terms = q.trim().split(/\s+/).filter(Boolean).map((t) => `"${zhSplit(t)}"`);
  return terms.join(" AND ");
}

function esc(s: string): string {
  return String(s ?? "").replace(/'/g, "''");
}

/** Same shard for every chunk of a source, so per-source lookups hit one DO. */
export function shardFor(source: string): number {
  let h = 0;
  for (let i = 0; i < source.length; i++) h = (h * 31 + source.charCodeAt(i)) >>> 0;
  return h % SHARDS;
}

// ============================================================ text relocation
type Pair = { t: string; org: number[] };

function rx(re: RegExp): RegExp {
  const f = re.flags.replace(/[gd]/g, "");
  return new RegExp(re.source, f + (f.includes("g") ? "" : "g") + "d");
}

function applyDelete(re: RegExp, p: Pair): Pair {
  const r = rx(re);
  const t = p.t, org = p.org;
  let out = "", pos = 0;
  const oout: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = r.exec(t)) !== null) {
    out += t.slice(pos, m.index);
    for (let i = pos; i < m.index; i++) oout.push(org[i]);
    pos = m.index + m[0].length;
  }
  out += t.slice(pos);
  for (let i = pos; i < t.length; i++) oout.push(org[i]);
  return { t: out, org: oout };
}

function applyKeepGroup(re: RegExp, p: Pair, group = 1): Pair {
  const r = rx(re);
  const t = p.t, org = p.org;
  let out = "", pos = 0;
  const oout: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = r.exec(t)) !== null) {
    out += t.slice(pos, m.index);
    for (let i = pos; i < m.index; i++) oout.push(org[i]);
    const idx = (m as unknown as { indices?: [number, number][] }).indices?.[group];
    const gs = idx ? idx[0] : m.index;
    const ge = idx ? idx[1] : m.index + m[0].length;
    out += m[group] ?? "";
    for (let i = gs; i < ge; i++) oout.push(org[i]);
    pos = m.index + m[0].length;
  }
  out += t.slice(pos);
  for (let i = pos; i < t.length; i++) oout.push(org[i]);
  return { t: out, org: oout };
}

function applyReplace(re: RegExp, p: Pair, repl: string): Pair {
  const r = rx(re);
  const t = p.t, org = p.org;
  let out = "", pos = 0;
  const oout: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = r.exec(t)) !== null) {
    out += t.slice(pos, m.index);
    for (let i = pos; i < m.index; i++) oout.push(org[i]);
    for (let _k = 0; _k < repl.length; _k++) {
      out += repl[_k];
      oout.push(org[m.index]);
    }
    pos = m.index + m[0].length;
  }
  out += t.slice(pos);
  for (let i = pos; i < t.length; i++) oout.push(org[i]);
  return { t: out, org: oout };
}

/** Replay the same cleaning used when the corpus was built, tracking source offsets. */
export function replayClean(raw: string): Pair {
  const lines = raw.split("\n");
  let body = raw;
  let bodyOrigin: number[] | null = null;

  if (lines.length && lines[0].trim() === "---") {
    let cut = -1;
    for (let i = 1; i < Math.min(lines.length, 60); i++) {
      if (lines[i].trim() === "---") { cut = i; break; }
    }
    if (cut > 0) {
      const rawLines = raw.split(/(?<=\n)/);
      const offs: number[] = [];
      let p = 0;
      for (const ln of rawLines) { offs.push(p); p += ln.length; }
      const bodyLines = lines.slice(cut + 1);
      body = bodyLines.join("\n");
      bodyOrigin = [];
      for (let j = 0; j < bodyLines.length; j++) {
        const base = offs[cut + 1 + j] ?? 0;
        const ln = bodyLines[j];
        for (let k = 0; k < ln.length; k++) bodyOrigin.push(base + k);
        if (j < bodyLines.length - 1) bodyOrigin.push(base + ln.length);
      }
    }
  }
  if (!bodyOrigin) bodyOrigin = Array.from({ length: body.length }, (_, i) => i);

  let p: Pair = { t: body, org: bodyOrigin };
  p = applyDelete(/```[\s\S]*?```/g, p);
  p = applyKeepGroup(/`([^`]*)`/g, p, 1);
  p = applyKeepGroup(/!\[([^\]]*)\]\([^)]*\)/g, p, 1);
  p = applyKeepGroup(/\[([^\]]+)\]\([^)]*\)/g, p, 1);
  p = applyDelete(/<[^>]+>/g, p);
  p = applyDelete(/^\s{0,3}#{1,6}\s*/gm, p);
  p = applyKeepGroup(/\*\*([^*]+)\*\*/g, p, 1);
  p = applyKeepGroup(/__([^_]+)__/g, p, 1);
  p = applyKeepGroup(/(?<!\*)\*(?!\*)([^*\n]+)\*(?!\*)/g, p, 1);
  p = applyKeepGroup(/(?<!_)_(?!_)([^_\n]+)_(?!_)/g, p, 1);
  p = applyReplace(/\r/g, p, "\n");
  p = applyReplace(/[ \t　]+/g, p, " ");
  p = applyReplace(/\n{3,}/g, p, "\n\n");

  const lead = p.t.length - p.t.replace(/^\s+/, "").length;
  const t = p.t.trim();
  const org = p.org.slice(lead, lead + t.length);
  return { t, org };
}

function lineNo(raw: string, pos: number): number {
  let n = 1;
  for (let i = 0; i < pos && i < raw.length; i++) if (raw[i] === "\n") n++;
  return n;
}

function extractWindow(raw: string, rs: number, re: number, context: number): [number, number] {
  const para = /(?:\r?\n){2,}/g;
  let best = -1, m: RegExpExecArray | null;
  const before = raw.slice(0, rs);
  while ((m = para.exec(before)) !== null) best = m.index + m[0].length;
  let ws: number;
  if (best >= 0 && rs - best <= context) ws = best;
  else ws = Math.max(0, rs - context);
  para.lastIndex = 0;
  const after = raw.slice(re);
  const m2 = para.exec(after);
  let we: number;
  if (m2 && m2.index <= context) we = re + m2.index;
  else we = Math.min(raw.length, re + context);
  return [ws, we];
}

function renderWindow(raw: string, ws: number, we: number, rs: number, re: number): string {
  const win = raw.slice(ws, we);
  return win.slice(0, rs - ws) + "\u27e6" + win.slice(rs - ws, re - ws) + "\u27e7" + win.slice(re - ws);
}

// ============================================================ Durable Object
type Row = [string, string, string, number]; // source, title, text, chunk_index

/** Dashboard name: daozang-mcp_DaozangIndex. Instances: shard-0..5 (hold the full corpus). */
export class DaozangIndex extends DurableObject {
  private ensured = false;

  private ensure() {
    if (this.ensured) return;
    try {
      this.ctx.storage.sql.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(ft, raw UNINDEXED, source UNINDEXED, title UNINDEXED, chunk_index UNINDEXED, tokenize='unicode61')`
      );
    } catch {
      // Already exists, or DO free-tier write quota reached — reads must still work.
    }
    this.ensured = true;
  }

  async ingest(rows: Row[]) {
    this.ensure();
    const sql = this.ctx.storage.sql;
    const MAX_STMT = 25_000;
    let buf: string[] = [];
    let bufLen = 0;
    let inserted = 0;
    const flush = () => {
      if (!buf.length) return;
      sql.exec(`INSERT INTO chunks(ft, raw, source, title, chunk_index) VALUES ${buf.join(",")}`);
      inserted += buf.length;
      buf = []; bufLen = 0;
    };
    for (const [src, title, text, ci] of rows) {
      const ft = esc(zhSplit(`${title} ${text}`));
      const tuple = `('${ft}','${esc(text ?? "")}','${esc(src ?? "")}','${esc(title ?? "")}',${Number(ci) || 0})`;
      buf.push(tuple);
      bufLen += tuple.length;
      if (bufLen >= MAX_STMT) flush();
    }
    flush();
    return { inserted };
  }

  async search(m: string, limit = 10) {
    this.ensure();
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT source, title, raw, chunk_index, bm25(chunks) AS score FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT ?`,
        m, limit
      )
      .toArray();
    return { count: rows.length, rows };
  }

  /** Exact chunk text for a (source, chunk_index) pair. */
  async getChunk(source: string, chunkIndex: number) {
    this.ensure();
    const rows = this.ctx.storage.sql
      .exec(`SELECT source, title, raw, chunk_index FROM chunks WHERE source = ? AND chunk_index = ? LIMIT 1`,
        source, chunkIndex)
      .toArray();
    return rows[0] ?? null;
  }

  /** Rebuild the original-markdown window for a chunk (runs in DO: 30s CPU budget). */
  async getOriginal(source: string, chunkIndex: number, raw: string, context: number) {
    const row = await this.getChunk(source, chunkIndex);
    if (!row) return { located: false, text: `（未找到 ${source} 的块 ${chunkIndex}）` };
    const chunkText = String(row.raw ?? "");
    const { t: cleaned, org } = replayClean(raw);
    const s = cleaned.indexOf(chunkText);
    if (s < 0 || s + chunkText.length > org.length) {
      return { located: false, text: "（清洗重放与建库不一致，未能定位）", source, chunk_index: chunkIndex };
    }
    const e = s + chunkText.length;
    const rs = org[s];
    const re = org[e - 1] + 1;
    const [ws, we] = extractWindow(raw, rs, re, context);
    return {
      located: true,
      source,
      chunk_index: chunkIndex,
      title: String(row.title ?? ""),
      line_start: lineNo(raw, rs),
      line_end: lineNo(raw, re),
      window_line_start: lineNo(raw, ws),
      window_line_end: lineNo(raw, we),
      text: renderWindow(raw, ws, we, rs, re),
    };
  }

  async stats() {
    this.ensure();
    const sql = this.ctx.storage.sql;
    const c = sql.exec(`SELECT count(*) AS c FROM chunks`).toArray()[0] as { c?: number };
    return { rows: Number(c?.c ?? 0), dbSize: sql.databaseSize, dbSizeMB: +(sql.databaseSize / 1048576).toFixed(2) };
  }

  async reset() {
    try { this.ctx.storage.sql.exec(`DROP TABLE IF EXISTS chunks`); } catch { /* ignore */ }
    this.ensured = false;
    return { ok: true };
  }

  /** Nuke all stored data in this instance (used to clean up orphaned instances). */
  async wipe() {
    try {
      this.ctx.storage.deleteAll();
      return { wiped: true, dbSize: this.ctx.storage.sql.databaseSize };
    } catch (e) {
      return { wiped: false, error: String(e).slice(0, 200) };
    }
  }

  /** Remove the quota-probe row written on 2026-10-14 (source = 'test_quota_probe'). */
  async clearProbe() {
    try {
      this.ctx.storage.sql.exec(`DELETE FROM chunks WHERE source = 'test_quota_probe'`);
      const c = this.ctx.storage.sql
        .exec(`SELECT count(*) AS c FROM chunks WHERE source = 'test_quota_probe'`)
        .toArray()[0] as { c?: number };
      return { deleted: true, remaining: Number(c?.c ?? 0) };
    } catch (e) {
      return { deleted: false, error: String(e).slice(0, 200) };
    }
  }
}

/**
 * Instance names: shard-0 .. shard-5.
 * These names are load-bearing: each instance already holds ~48k indexed rows.
 * Changing them (or renaming the class) creates empty instances and forces a
 * full 285k-row re-import, which the DO free tier (100k rows written/day)
 * cannot absorb in one day. Keep as-is.
 */
function shardName(shard: number): string {
  return `shard-${shard}`;
}

function stub(env: Env, shard: number): DaozangIndex {
  return env.DAOZANG_DO.get(env.DAOZANG_DO.idFromName(shardName(shard))) as unknown as DaozangIndex;
}

// ============================================================ MCP
const METHODOLOGY = `# 道藏考据方法论

## 一、先定范围，再问问题
《中华道藏》收经 3,152 篇、28.5 万段。直接抛自然语言长问句，关键词匹配容易失焦。
先用 \`list_sources\` 以经名关键词（如「清静」「度人」「悟真」）缩小到若干部，
再把范围交给 \`search_daozang\` 的 \`source_filter\`。

## 二、检索用「原句短语」，不要用「问句」
本服务是全文（FTS5/BM25）引擎：
* 好：「周天火候」「天地悉皆归」「三官大帝」「黄庭」
* 差：「什么是内丹修炼中的周天火候？它和筑基有什么关系？」
问句请自行切出其中的专名、术语或原句片段。

## 三、必须回到原文取证
检索返回的是**建库时清洗过的正文**（已去 Markdown 记号、压缩空白），
可用于判断相关性，但**不宜直接引用**。引用前一律用 \`get_original\`：
它会重放同一套清洗规则，把块精确映射回原文，给出**行号**并用 ⟦…⟧ 标出命中范围。

## 四、结论要能溯源
每条论断都应附 \`源文件名 + 块序号（或行号）\`，便于他人复核。

## 五、注意语料的边界
* 本库为《中华道藏》文本，不含敦煌本、辑佚本等库外材料；
* 同一经文可能有异名、异体字（如「无／無」「炁／气」），检索时两种写法都试；
* 若某词零命中，先换更短的核心词，或去掉 \`source_filter\` 再试。`;

const INSTRUCTIONS = `道藏考据（DaoZang Reasoner，Cloudflare 版）—— 在《中华道藏》全文中做可溯源的检索与原文取证。

语料：3,152 篇经文、285,117 个文本块。检索引擎：Cloudflare Durable Object 上的 SQLite FTS5（中文分字 + BM25 排序）。

推荐工作流：
1. daozang_protocol  先读方法论；
2. list_sources      用关键词把范围缩到某几部经；
3. search_daozang    检索命中块（返回相关度、源文件、块序号）；
4. get_original      把命中块还原成带行号的 Markdown 原文，用 ⟦…⟧ 标出精确命中范围；
5. read_source       需要通读时取全文。

另有一路语义检索 search_semantic（AI Search / bge-m3），覆盖每篇经文的标题与开篇摘要，
适合「不知经名、只有概念」的查找；但它每月只有 1,000 次额度，且不含全文，
命中后仍需回到 search_daozang + get_original 取证。`;

const TOOLS = [
  {
    name: "daozang_protocol",
    title: "道藏考据方法论",
    description: "返回道藏考据的推荐工作流与检索技巧（先读这个再动手）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "daozang_status",
    title: "馆藏状态",
    description: "查看索引状态：块数、篇数、分片规模、可用引擎。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "search_semantic",
    title: "语义检索（AI Search）",
    description:
      "按语义相似度检索（bge-m3 向量 + 关键词混合）。用自然语言提问或概念性查找时用它；" +
      "命中后建议再用 search_daozang + get_original 回到全文中取证。注意：免费层每月仅 1,000 次语义查询。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "自然语言问题或概念描述，如「如何炼内丹」「讲斋醮科仪的经文」", minLength: 1 },
        top_k: { type: "integer", description: "返回条数", minimum: 1, maximum: 20, default: 5 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "list_sources",
    title: "按关键词列经目",
    description: "按文件名关键词列出匹配的经文及各自块数，用于缩小检索范围。",
    inputSchema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: "经名/文件名关键词，如「清静」「悟真」；留空则从首篇开始列出" },
        limit: { type: "integer", description: "最多返回篇数", minimum: 1, maximum: 500, default: 50 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "search_daozang",
    title: "检索道藏",
    description: "在 285,117 个文本块中做全文检索（FTS5 + BM25），返回相关度、源文件名与块序号。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索词，建议用专名或原句短语，如「周天火候」「天地悉皆归」", minLength: 1 },
        top_k: { type: "integer", description: "返回条数", minimum: 1, maximum: 50, default: 5 },
        source_filter: { type: "string", description: "按源文件名关键词限定范围（如「清静经」）" },
        context: { type: "integer", description: "附带原文窗口时每侧扩展字符数", minimum: 0, maximum: 2000, default: 300 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_original",
    title: "取带行号原文",
    description: "把指定块还原成保留原文格式、带行号的窗口，并用 ⟦…⟧ 标出精确命中范围。引用经文前必用。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Markdown 源文件名（取自检索结果的 source 字段，须完整）", minLength: 1 },
        chunk_index: { type: "integer", description: "块序号（取自检索结果的 chunk_index）", minimum: 0 },
        context: { type: "integer", description: "窗口每侧扩展字符数", minimum: 0, maximum: 2000, default: 300 },
      },
      required: ["source", "chunk_index"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "read_source",
    title: "读取经文全文",
    description: "读取某篇经文的 Markdown 全文（超长时截断），用于通读或核对上下文。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "Markdown 源文件名（须完整，可用 list_sources 获取）", minLength: 1 },
        max_chars: { type: "integer", description: "最多返回字符数，超出则截断", minimum: 100, maximum: 200000, default: 20000 },
      },
      required: ["source"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

interface Hit {
  score: number; source: string; title: string; chunk_index: number; text: string;
}

async function mcpSearch(env: Env, query: string, topK: number, sourceFilter?: string, context = 300) {
  const m = buildMatch(query);
  const per = Math.min(Math.max(topK, 10), 50);
  const res = await Promise.all(Array.from({ length: SHARDS }, (_, i) => stub(env, i).search(m, per)));
  let all = res.flatMap((r) => r.rows as Hit[]);
  if (sourceFilter) all = all.filter((h) => h.source.includes(sourceFilter));
  all.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  const hits = all.slice(0, topK).map((h) => ({
    score: +Number(h.score ?? 0).toFixed(4),
    source: h.source,
    title: h.title,
    chunk_index: Number(h.chunk_index ?? 0),
    text: h.raw ?? h.text ?? "",
  }));
  return { query, terms: query.trim().split(/\s+/).filter(Boolean), engine: "fts5-bm25", count: hits.length, hits };
}

async function loadSources(env: Env): Promise<{ source: string; chunks: number }[]> {
  const raw = await env.DAOZANG_KV.get("sources", "text");
  if (!raw) return [];
  try {
    return JSON.parse(raw) as { source: string; chunks: number }[];
  } catch {
    return [];
  }
}

async function fetchMarkdown(env: Env, source: string): Promise<string | null> {
  try {
    const u = new URL("https://assets.local/");
    u.pathname = `/markdowns/${source}`;
    const r = await env.ASSETS.fetch(u.toString());
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  }
}

/** AI Search doc layout is "# title\n\n源文件：<source>\n\n<body>". Recover the source. */
function parseSemanticHit(text: string) {
  const m = /源文件：([^\n]+)/.exec(text ?? "");
  const t = /^#\s*([^\n]+)/m.exec(text ?? "");
  return { source: m ? m[1].trim() : "", title: t ? t[1].trim() : "" };
}

async function semanticSearch(env: Env, query: string, topK: number) {
  const instance = env.AI_SEARCH_INSTANCE || "";
  if (!env.AI) {
    return { query, engine: "ai-search", available: false, count: 0, hits: [], note: "未绑定 Workers AI（[ai] binding），语义检索不可用" };
  }
  if (!instance) {
    return { query, engine: "ai-search", available: false, count: 0, hits: [], note: "未配置 AI_SEARCH_INSTANCE" };
  }
  try {
    // Workers binding -> { data: [{ filename, score, content: [{ text }] }] }
    // REST API        -> { chunks: [{ score, text, item: { key } }] }
    type Part = { text?: string };
    type Hit = {
      score?: number; filename?: string; text?: string;
      content?: Part[]; item?: { key?: string };
    };
    const rag = env.AI.autorag(instance) as unknown as {
      search: (o: Record<string, unknown>) => Promise<{ data?: Hit[]; chunks?: Hit[] }>;
    };
    const res = await rag.search({ query, max_num_results: topK, score_threshold: 0.3 });
    const raw = res?.data ?? res?.chunks ?? [];
    const hits = raw.map((d) => {
      const full = Array.isArray(d.content)
        ? d.content.map((c) => c?.text ?? "").join("\n")
        : (d.text ?? "");
      const { source, title } = parseSemanticHit(full);
      const body = full.replace(/^#\s*[^\n]*\n+/, "").replace(/源文件：[^\n]*\n+/, "").trim();
      return {
        score: +Number(d.score ?? 0).toFixed(4),
        source: source || d.filename || d.item?.key || "",
        title,
        key: d.filename || d.item?.key || "",
        text: body,
      };
    });
    return { query, engine: "ai-search-bge-m3", available: true, count: hits.length, hits, monthly_quota: "1,000 语义查询/月（免费层）" };
  } catch (e) {
    return {
      query, engine: "ai-search", available: false, count: 0, hits: [],
      note: `语义检索失败（可能已用尽当月 1,000 次额度）：${String(e).slice(0, 200)}`,
    };
  }
}

async function callTool(env: Env, name: string, args: Record<string, unknown>) {
  if (name === "daozang_protocol") return { methodology: METHODOLOGY };

  if (name === "daozang_status") {
    const res = await Promise.all(Array.from({ length: SHARDS }, (_, i) => stub(env, i).stats()));
    return {
      ready: res.reduce((a, r) => a + r.rows, 0) > 0,
      n_chunks: res.reduce((a, r) => a + r.rows, 0),
      n_files: TOTAL_FILES,
      engine: "fts5-bm25",
      semantic_available: Boolean(env.AI && env.AI_SEARCH_INSTANCE),
      semantic_instance: env.AI_SEARCH_INSTANCE || null,
      semantic_docs: AI_SEARCH_N_DOCS,
      shards: res.map((r, i) => ({ shard: i, rows: r.rows, mb: r.dbSizeMB })),
      total_mb: +res.reduce((a, r) => a + r.dbSizeMB, 0).toFixed(2),
    };
  }

  if (name === "search_semantic") {
    return await semanticSearch(env, String(args.query ?? ""), Number(args.top_k ?? 5));
  }

  if (name === "list_sources") {
    const keyword = String(args.keyword ?? "");
    const limit = Number(args.limit ?? 50);
    const all = await loadSources(env);
    const matched = keyword ? all.filter((s) => s.source.includes(keyword)) : all;
    return {
      keyword,
      count: Math.min(matched.length, limit),
      total_matched: matched.length,
      items: matched.slice(0, limit),
    };
  }

  if (name === "search_daozang") {
    const query = String(args.query ?? "");
    const topK = Number(args.top_k ?? 5);
    const sf = args.source_filter ? String(args.source_filter) : undefined;
    return await mcpSearch(env, query, topK, sf, Number(args.context ?? 300));
  }

  if (name === "get_original") {
    const source = String(args.source ?? "");
    const ci = Number(args.chunk_index ?? 0);
    const context = Number(args.context ?? 300);
    const raw = await fetchMarkdown(env, source);
    if (raw === null) return { located: false, source, chunk_index: ci, text: `（源文件不存在或不可读：${source}）` };
    return await stub(env, shardFor(source)).getOriginal(source, ci, raw, context);
  }

  if (name === "read_source") {
    const source = String(args.source ?? "");
    const maxChars = Number(args.max_chars ?? 20000);
    const raw = await fetchMarkdown(env, source);
    if (raw === null) return { source, total_chars: 0, truncated: false, text: `（源文件不存在或不可读：${source}）` };
    return { source, total_chars: raw.length, truncated: raw.length > maxChars, text: raw.slice(0, maxChars) };
  }

  throw new Error(`unknown tool: ${name}`);
}

function jrpc(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

// ============================================================ Worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/mcp" && request.method === "POST") {
      let body: { id?: unknown; method?: string; params?: Record<string, unknown> };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, { status: 400 });
      }
      const { id, method, params } = body;
      if (method === "initialize") {
        return jrpc(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        });
      }
      if (method === "tools/list") return jrpc(id, { tools: TOOLS });
      if (method === "tools/call") {
        const p = (params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        try {
          const out = await callTool(env, String(p.name ?? ""), p.arguments ?? {});
          return jrpc(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: false });
        } catch (e) {
          return jrpc(id, { content: [{ type: "text", text: String(e) }], isError: true });
        }
      }
      if (method === "ping") return jrpc(id, {});
      if (String(method ?? "").startsWith("notifications/")) return new Response(null, { status: 202 });
      return jrpc(id, { error: { code: -32601, message: `method not found: ${method}` } });
    }

    const isAdmin = path.startsWith("/admin/");
    if (isAdmin && env.ADMIN_TOKEN) {
      const got = request.headers.get("x-admin-token") ?? url.searchParams.get("token") ?? "";
      if (got !== env.ADMIN_TOKEN) return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    if (path === "/admin/ingest" && request.method === "POST") {
      const shard = Number(url.searchParams.get("shard") ?? 0);
      const body = (await request.json()) as { rows: Row[] };
      return Response.json(await stub(env, shard).ingest(body.rows));
    }
    if (path === "/admin/stats") {
      const res = await Promise.all(Array.from({ length: SHARDS }, (_, i) => stub(env, i).stats()));
      return Response.json({
        shards: res,
        totalRows: res.reduce((a, r) => a + r.rows, 0),
        totalMB: +res.reduce((a, r) => a + r.dbSizeMB, 0).toFixed(2),
      });
    }
    if (path === "/admin/diag") {
      const out: unknown[] = [];
      for (let i = 0; i < SHARDS; i++) {
        try {
          const s = await stub(env, i).stats();
          out.push({ shard: i, ok: true, rows: s.rows, mb: s.dbSizeMB });
        } catch (e) {
          out.push({ shard: i, ok: false, error: String(e).slice(0, 300) });
        }
      }
      return Response.json({
        bindings: { assets: typeof env.ASSETS, kv: typeof env.DAOZANG_KV, do: typeof env.DAOZANG_DO },
        shards: out,
      });
    }

    if (path === "/admin/reset" && request.method === "POST") {
      await Promise.all(Array.from({ length: SHARDS }, (_, i) => stub(env, i).reset()));
      return Response.json({ ok: true });
    }
    /** Inspect an arbitrary DO instance by hex id (for orphan detection). */
    if (path === "/admin/inspect") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return Response.json({ error: "missing ?id=" }, { status: 400 });
      try {
        const stub = env.DAOZANG_DO.get(env.DAOZANG_DO.idFromString(id)) as unknown as DaozangIndex;
        const s = await stub.stats();
        return Response.json({ id, reachable: true, ...s });
      } catch (e) {
        return Response.json({ id, reachable: false, error: String(e).slice(0, 300) });
      }
    }

    /** Wipe an arbitrary DO instance by hex id (for orphan cleanup). */
    if (path === "/admin/wipe" && request.method === "POST") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return Response.json({ error: "missing ?id=" }, { status: 400 });
      try {
        const stub = env.DAOZANG_DO.get(env.DAOZANG_DO.idFromString(id)) as unknown as DaozangIndex;
        return Response.json({ id, ...(await stub.wipe()) });
      } catch (e) {
        return Response.json({ id, wiped: false, error: String(e).slice(0, 300) });
      }
    }

    /** Map candidate instance names -> DO id, to identify orphaned instances. */
    if (path === "/admin/idof") {
      const names: string[] = [];
      for (let i = 0; i < SHARDS; i++) names.push(`shard-${i}`);
      for (let i = 0; i < SHARDS; i++) names.push(`daozang-dons-${String(i + 1).padStart(2, "0")}`);
      const out = names.map((n) => ({ name: n, id: env.DAOZANG_DO.idFromName(n).toString() }));
      return Response.json({ shards: SHARDS, mapping: out });
    }

    /** Dump the raw AI Search binding response shape (temporary debugging aid). */
    if (path === "/admin/ai-debug") {
      const q = url.searchParams.get("q") ?? "内丹";
      if (!env.AI) return Response.json({ error: "no AI binding" }, { status: 500 });
      try {
        const rag = env.AI.autorag(env.AI_SEARCH_INSTANCE || "daozang-aisearch") as unknown as {
          search: (o: Record<string, unknown>) => Promise<unknown>;
        };
        const res: Record<string, unknown> = (await rag.search({
          query: q, max_num_results: 2, score_threshold: 0.3,
        })) as Record<string, unknown>;
        const arr = ((res?.chunks ?? res?.data ?? []) as Record<string, unknown>[]) ?? [];
        return Response.json({
          topKeys: Object.keys(res ?? {}),
          nHits: arr.length,
          firstHitKeys: arr[0] ? Object.keys(arr[0]) : [],
          firstHit: arr[0] ?? null,
        });
      } catch (e) {
        return Response.json({ error: String(e).slice(0, 400) });
      }
    }

    if (path === "/admin/clear-probe" && request.method === "POST") {
      const res = await Promise.all(Array.from({ length: SHARDS }, (_, i) => stub(env, i).clearProbe()));
      return Response.json({ ok: true, shards: res });
    }
    if (path === "/admin/put-sources" && request.method === "POST") {
      const body = (await request.json()) as { items: { source: string; chunks: number }[] };
      await env.DAOZANG_KV.put("sources", JSON.stringify(body.items));
      return Response.json({ ok: true, count: body.items.length });
    }

    if (path === "/search") {
      const q = url.searchParams.get("q") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 10);
      return Response.json(await mcpSearch(env, q, limit));
    }

    return Response.json({
      ok: true, service: SERVER_NAME, version: SERVER_VERSION,
      mcp_endpoint: "/mcp", shards: SHARDS,
    });
  },
};
