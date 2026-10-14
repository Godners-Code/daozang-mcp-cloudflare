#!/usr/bin/env python
"""Build and upload per-scripture summaries into the Cloudflare AI Search instance.

AI Search (free tier) budgets, per month:
  - 5,000,000 ingestion tokens   (cl100k_base; ~1 token per CJK char)
  -     1,000 semantic queries
  -     1,000 full-text queries
  - 100,000 files per instance

Ingesting the full 190 MB corpus would need ~90M tokens (18x the budget), so we
upload ONE compact document per scripture: title + source filename + the first
N chunks. That gives semantic "which scripture is this about?" discovery, while
deep full-text work stays on the Durable Object FTS5 index.

Usage
-----
    # 1. build documents locally and report the token cost (no network)
    python tools/aisearch_import.py --build --out ./aisearch_docs

    # 2. upload them
    export CLOUDFLARE_API_TOKEN=...
    export CLOUDFLARE_ACCOUNT_ID=...
    python tools/aisearch_import.py --upload --out ./aisearch_docs \
        --instance daozang-aisearch

    # combined
    python tools/aisearch_import.py --build --upload --out ./aisearch_docs
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed

import pyarrow.parquet as pq

ALL_FILES = [f"train-0000{i}-of-00006.parquet" for i in range(6)]
DEFAULT_CHUNKS_PER_DOC = 2
MONTHLY_TOKEN_BUDGET = 5_000_000

# Characters that are unsafe in an object key.
_UNSAFE = re.compile(r'[\\/:*?"<>|\r\n\t]+')


def safe_key(source: str, idx: int) -> str:
    """Object key for a scripture. Falls back to an index if the name is unusable."""
    base = os.path.basename(source or "")
    base = _UNSAFE.sub("_", base).strip().strip(".")
    if not base or len(base) > 180:
        base = f"doc-{idx:04d}.md"
    elif not base.lower().endswith(".md"):
        base += ".md"
    return base


def load_first_chunks(data_dir: str, chunks_per_doc: int):
    """source -> (title, [text of first N chunks])"""
    per_source: dict[str, list[tuple[int, str, str]]] = defaultdict(list)
    for f in ALL_FILES:
        path = os.path.join(data_dir, f)
        if not os.path.exists(path):
            print(f"  skip missing {path}", flush=True)
            continue
        t = pq.read_table(path, columns=["source", "title", "chunk_index", "text"])
        for s, ti, ci, te in zip(
            t.column("source").to_pylist(),
            t.column("title").to_pylist(),
            t.column("chunk_index").to_pylist(),
            t.column("text").to_pylist(),
        ):
            if not s:
                continue
            per_source[s].append((int(ci or 0), ti or "", te or ""))

    out = {}
    for s, rows in per_source.items():
        rows.sort(key=lambda r: r[0])
        title = rows[0][1] or s.rsplit(".", 1)[0]
        body = " ".join(re.sub(r"\s+", " ", r[2]).strip() for r in rows[:chunks_per_doc])
        out[s] = (title, body.strip())
    return out


def render(title: str, source: str, body: str) -> str:
    return f"# {title}\n\n源文件：{source}\n\n{body}\n"


def count_tokens(docs: list[str]) -> int:
    """cl100k_base count. Falls back to a char-based estimate if tiktoken is absent."""
    try:
        import tiktoken

        enc = tiktoken.get_encoding("cl100k_base")
        return sum(len(enc.encode(d)) for d in docs)
    except Exception:
        print("  (tiktoken unavailable — estimating 1 token per CJK char)", flush=True)
        return sum(len(d) for d in docs)


def build(data_dir: str, out_dir: str, chunks_per_doc: int) -> int:
    os.makedirs(out_dir, exist_ok=True)
    data = load_first_chunks(data_dir, chunks_per_doc)
    print(f"scriptures: {len(data)}", flush=True)

    docs, keys = [], []
    for i, (source, (title, body)) in enumerate(sorted(data.items())):
        keys.append(safe_key(source, i))
        docs.append(render(title, source, body))

    total = count_tokens(docs)
    pct = total / MONTHLY_TOKEN_BUDGET * 100
    print(f"documents : {len(docs)}", flush=True)
    print(f"tokens    : {total:,} ({pct:.1f}% of the {MONTHLY_TOKEN_BUDGET:,}/month budget)", flush=True)
    if total > MONTHLY_TOKEN_BUDGET:
        print("  ✗ over budget — lower --chunks-per-doc", flush=True)
        return 1

    for k, d in zip(keys, docs):
        with open(os.path.join(out_dir, k), "w", encoding="utf-8") as f:
            f.write(d)
    print(f"written   : {out_dir} ({len(keys)} files)", flush=True)
    return 0


def upload_file(path: str, account: str, instance: str, token: str, proxy: str):
    # curl (not requests) — a corporate proxy returns 502 on sustained use.
    cmd = ["curl", "-s", "-X", "POST",
           "-H", f"Authorization: Bearer {token}",
           "-F", f"file=@{path}",
           "--max-time", "120"]
    if proxy:
        cmd[1:1] = ["-x", proxy]
    cmd.append(f"https://api.cloudflare.com/client/v4/accounts/{account}"
               f"/ai-search/namespaces/default/instances/{instance}/items")
    r = subprocess.run(cmd, capture_output=True, text=True)
    out = (r.stdout or "").strip()
    try:
        j = json.loads(out)
        if j.get("success"):
            return path, True, ""
        return path, False, json.dumps(j.get("errors", out), ensure_ascii=False)[:160]
    except json.JSONDecodeError:
        return path, False, (out or r.stderr or "")[:160]


def upload(out_dir: str, account: str, instance: str, token: str,
           proxy: str, workers: int, limit: int):
    files = sorted(
        os.path.join(out_dir, f)
        for f in os.listdir(out_dir) if f.lower().endswith(".md")
    )
    if limit:
        files = files[:limit]
    print(f"uploading {len(files)} files to '{instance}' (workers={workers})", flush=True)

    done = ok = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = [ex.submit(upload_file, p, account, instance, token, proxy) for p in files]
        for fut in as_completed(futs):
            path, good, err = fut.result()
            done += 1
            if good:
                ok += 1
            elif err and done <= 5:
                print(f"  FAIL {os.path.basename(path)}: {err}", flush=True)
            if done % 250 == 0 or done == len(files):
                print(f"  {done}/{len(files)} ok={ok} {time.time()-t0:.0f}s", flush=True)
    print(f"done ok={ok}/{done} elapsed={time.time()-t0:.0f}s", flush=True)
    return 0 if ok == done else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--upload", action="store_true")
    ap.add_argument("--out", default="./aisearch_docs")
    ap.add_argument("--data-dir", default=os.environ.get("CF_DATA_DIR", "data"))
    ap.add_argument("--chunks-per-doc", type=int, default=DEFAULT_CHUNKS_PER_DOC)
    ap.add_argument("--instance", default="daozang-aisearch")
    ap.add_argument("--namespace", default="default")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    if not args.build and not args.upload:
        ap.error("pass --build and/or --upload")

    rc = 0
    if args.build:
        rc |= build(args.data_dir, args.out, args.chunks_per_doc)

    if args.upload:
        token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
        account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
        if not token or not account:
            raise SystemExit("set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID")
        rc |= upload(args.out, account, args.instance, token,
                     os.environ.get("CF_PROXY", ""), args.workers, args.limit)
    return rc


if __name__ == "__main__":
    sys.exit(main())
