#!/usr/bin/env python
"""Build the source->chunk-count index and store it in Workers KV (single key)."""
import json
import os
import subprocess
import tempfile
from collections import Counter

import pyarrow.parquet as pq

# All credentials/endpoints come from the environment — nothing is hardcoded.
#   CF_WORKER       deployed Worker origin
#   CF_ADMIN_TOKEN  value of the ADMIN_TOKEN secret
#   CF_PROXY        optional HTTP proxy ("" = direct)
#   CF_DATA_DIR     directory holding the parquet shards
PROXY = os.environ.get("CF_PROXY", "")
BASE = os.environ.get("CF_WORKER", "")
ADMIN = os.environ.get("CF_ADMIN_TOKEN", "")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("CF_DATA_DIR", os.path.join(os.path.dirname(ROOT), "data"))
ALL_FILES = [f"train-0000{i}-of-00006.parquet" for i in range(6)]

if not BASE or not ADMIN:
    raise SystemExit("set CF_WORKER and CF_ADMIN_TOKEN before running")


def main():
    c = Counter()
    for f in ALL_FILES:
        path = os.path.join(DATA_DIR, f)
        if not os.path.exists(path):
            print("skip missing", path, flush=True)
            continue
        t = pq.read_table(path, columns=["source"])
        c.update(t.column("source").to_pylist())
        print(f"  {f}: unique sources so far {len(c)}", flush=True)

    items = [{"source": s, "chunks": n} for s, n in sorted(c.items())]
    print(f"total sources={len(items)} total chunks={sum(c.values())}", flush=True)

    payload = json.dumps({"items": items}, ensure_ascii=False)
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        fh.write(payload)
    try:
        curl = ["curl", "-s"] + (["-x", PROXY] if PROXY else [])
        r = subprocess.run(
            curl + [
                "-X", "POST",
                "-H", "Content-Type: application/json",
                "-H", f"x-admin-token: {ADMIN}",
                "--data-binary", f"@{path}",
                "--max-time", "300",
                f"{BASE}/admin/put-sources",
            ],
            capture_output=True, text=True,
        )
        print("put-sources:", (r.stdout or "").strip()[:300], flush=True)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


if __name__ == "__main__":
    main()
