#!/usr/bin/env python
"""Ingest DaoZang chunks into sharded Cloudflare Durable Object FTS5 indexes."""
import argparse
import json
import os
import subprocess
import tempfile
import time
from collections import defaultdict

import pyarrow.parquet as pq
from concurrent.futures import ThreadPoolExecutor, as_completed

# All credentials/endpoints come from the environment — nothing is hardcoded.
#   CF_WORKER       deployed Worker origin, e.g. https://daozang-mcp.<sub>.workers.dev
#   CF_ADMIN_TOKEN  value of the ADMIN_TOKEN secret
#   CF_PROXY        optional HTTP proxy ("" = direct)
#   CF_DATA_DIR     directory holding the parquet shards
PROXY = os.environ.get("CF_PROXY", "")
BASE = os.environ.get("CF_WORKER", "")
ADMIN = os.environ.get("CF_ADMIN_TOKEN", "")
SHARDS = 6
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("CF_DATA_DIR", os.path.join(os.path.dirname(ROOT), "data"))

if not BASE or not ADMIN:
    raise SystemExit("set CF_WORKER and CF_ADMIN_TOKEN before running")

ALL_FILES = [f"train-0000{i}-of-00006.parquet" for i in range(6)]


def shard_for(source: str) -> int:
    """Must match shardFor() in src/index.ts (h*31 + charCode, mod SHARDS)."""
    h = 0
    for ch in source:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h % SHARDS


def read_all(files, limit, offset):
    rows = []
    for f in files:
        path = f if os.path.isabs(f) else os.path.join(DATA_DIR, f)
        if not os.path.exists(path):
            print(f"  skip missing {path}", flush=True)
            continue
        t = pq.read_table(path, columns=["source", "title", "text", "chunk_index"])
        src = t.column("source").to_pylist()
        title = t.column("title").to_pylist()
        text = t.column("text").to_pylist()
        ci = t.column("chunk_index").to_pylist()
        for s, ti, te, c in zip(src, title, text, ci):
            te = te or ""
            if not te.strip():
                continue
            rows.append([s or "", ti or "", te, int(c or 0)])
        print(f"  read {f}: total {len(rows)}", flush=True)
        if limit and len(rows) >= limit + offset:
            break
    return rows[offset : (offset + limit) if limit else None]


def curl_args():
    """Base curl flags. We shell out to curl because `requests` returns 502
    when pushed through a corporate proxy for sustained uploads."""
    a = ["curl", "-s"]
    if PROXY:
        a += ["-x", PROXY]
    return a


def post_batch(shard, batch, idx):
    """Upload via curl (requests through the local proxy returns 502 on sustained use)."""
    payload = json.dumps({"rows": batch}, ensure_ascii=False)
    last = ""
    for attempt in range(4):
        fd, path = tempfile.mkstemp(suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(payload)
            r = subprocess.run(
                curl_args() + [
                    "-X", "POST",
                    "-H", "Content-Type: application/json",
                    "-H", f"x-admin-token: {ADMIN}",
                    "--data-binary", f"@{path}",
                    "--max-time", "300",
                    f"{BASE}/admin/ingest?shard={shard}",
                ],
                capture_output=True, text=True,
            )
            out = (r.stdout or "").strip()
            last = out or (r.stderr or "").strip()
            if out:
                try:
                    j = json.loads(out)
                    if "inserted" in j:
                        return idx, j
                except json.JSONDecodeError:
                    pass
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
        time.sleep(1 + attempt * 2)
    return idx, {"error": last[:180] or "empty response"}


def stats():
    r = subprocess.run(
        curl_args() + ["-H", f"x-admin-token: {ADMIN}", f"{BASE}/admin/stats"],
        capture_output=True, text=True, timeout=90,
    )
    return (r.stdout or "").strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="0 = all rows")
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--batch", type=int, default=1000)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--files", default="")
    ap.add_argument("--reset", action="store_true")
    ap.add_argument(
        "--shards", default="",
        help="Comma-separated shard numbers to import this run, e.g. '0,1'. Empty = all 6 shards. "
             "Used for the multi-day import (DO free tier allows 100k rows written / day).",
    )
    ap.add_argument(
        "--max-rows", type=int, default=0,
        help="Hard cap on rows uploaded this run (0 = unlimited). Keep <= 95000 to stay under the "
             "DO daily write quota with headroom for retries.",
    )
    args = ap.parse_args()

    if args.reset:
        r = subprocess.run(
            curl_args() + ["-X", "POST", "-H", f"x-admin-token: {ADMIN}", f"{BASE}/admin/reset"],
            capture_output=True, text=True, timeout=90,
        )
        print("reset:", (r.stdout or "").strip(), flush=True)

    files = args.files.split(",") if args.files else ALL_FILES
    print(f"reading {len(files)} parquet file(s), limit={args.limit or 'ALL'} offset={args.offset}", flush=True)
    rows = read_all(files, args.limit, args.offset)
    print(f"loaded {len(rows)} rows", flush=True)
    if not rows:
        return

    buckets = defaultdict(list)
    for r in rows:
        buckets[shard_for(r[0])].append(r)

    # --shards: restrict this run to specific shards (multi-day import).
    shard_filter: set[int] = set()
    if args.shards:
        shard_filter = {int(s.strip()) for s in args.shards.split(",") if s.strip()}
        bad = shard_filter - set(range(SHARDS))
        if bad:
            raise SystemExit(f"invalid shard(s) {sorted(bad)}; valid range 0..{SHARDS - 1}")
    print("shard sizes (full corpus):", {k: len(v) for k, v in sorted(buckets.items())}, flush=True)

    # --max-rows: hard cap so we never blow the DO daily write quota in one run.
    remaining = args.max_rows if args.max_rows else None
    planned = 0
    tasks = []
    for si in sorted(buckets):
        if shard_filter and si not in shard_filter:
            continue
        rs = buckets[si]
        if remaining is not None:
            if remaining <= 0:
                break
            rs = rs[:remaining]
            remaining -= len(rs)
        planned += len(rs)
        for i in range(0, len(rs), args.batch):
            tasks.append((si, rs[i : i + args.batch]))

    sel = sorted(shard_filter) if shard_filter else "ALL"
    cap = f" cap={args.max_rows}" if args.max_rows else ""
    print(f"shards={sel} rows_this_run={planned}{cap}", flush=True)
    if not tasks:
        print("nothing to do", flush=True)
        return
    print(f"{len(tasks)} batches (batch={args.batch})", flush=True)

    done = 0
    failed = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(post_batch, si, b, i): i for i, (si, b) in enumerate(tasks)}
        for fut in as_completed(futs):
            idx, res = fut.result()
            done += 1
            if "error" in res:
                failed += 1
                if failed <= 5:
                    print(f"  batch {idx} FAILED: {res['error']}", flush=True)
            if done % 50 == 0 or done == len(tasks):
                el = time.time() - t0
                print(f"  {done}/{len(tasks)} ({done*args.batch} rows) {el:.0f}s failed={failed}", flush=True)

    print(f"done batches={done} failed={failed} elapsed={time.time()-t0:.0f}s", flush=True)
    print("stats:", stats(), flush=True)


if __name__ == "__main__":
    main()
