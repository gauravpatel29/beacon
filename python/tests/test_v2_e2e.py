"""End-to-end check against the LIVE Neon branch and bucket.

Creates a workflow, uploads three files the way the ingestion screen would,
proves dry-run stores nothing, edits a manifest and re-derives from the
immutable raw bytes, merges the three, reads the bytes back out of the bucket,
exercises the error paths, then deletes everything it created.

    python/.venv/Scripts/python.exe python/tests/test_v2_e2e.py

Not a mock. It talks to the real project and cleans up after itself.
"""

import io
import json
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402

from core import objectstore as store  # noqa: E402
from core.config import get_settings  # noqa: E402

# Driven over real HTTP against a running uvicorn rather than TestClient:
# TestClient runs each request on its own event loop, and an asyncpg pool
# cannot be shared across loops. One server = one loop = what production does.
BASE_URL = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8020")

PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


SALES = (
    "npi,month_date,trx\n"
    "1234567893,2026-01-04,120\n"
    "1234567893,2026-02-11,95\n"
    "1245319599,2026-01-04,60\n"
    "1234567890,2026-01-04,999\n"
).encode("utf-8")

CALLS = (
    "npi,call_date,calls,rep\n"
    "1234567893,04-01-2026,3,R1\n"
    "1234567893,11-02-2026,2,R1\n"
    "1245319599,04-01-2026,5,R2\n"
).encode("utf-8")

XWALK = "npi,dma_id,dma_name\n1234567893,501,New York\n1245319599,803,Los Angeles\n".encode("utf-8")

SALES_MANIFEST = {
    "config_metadata": {"category": "sales"},
    "live_updates": {
        "date_formats": [{"column": "month_date", "from": "%Y-%m-%d", "to": "%Y-%m-%d"}],
        "dtype_changes": [{"column": "trx", "to": "integer"}],
        "column_renames": [{"from": "month_date", "to": "date"}],
    },
    "filters": [{"type": "npi_luhn", "column": "npi"}],
}

CALLS_MANIFEST = {
    "config_metadata": {"category": "hcp_promo"},
    "live_updates": {
        # Day-first source. Under the old inference this silently transposed
        # day/month for every day <= 12.
        "date_formats": [{"column": "call_date", "from": "%d-%m-%Y", "to": "%Y-%m-%d"}],
        "dtype_changes": [{"column": "calls", "to": "integer"}],
        "column_renames": [{"from": "call_date", "to": "date"}],
    },
}


def main() -> int:
    s = get_settings()
    if not (s.db_configured() and s.storage_configured()):
        print("Missing config: " + ", ".join(s.missing()))
        return 1

    client = httpx.Client(base_url=BASE_URL, timeout=120.0)
    wf_id = None
    created = False

    try:
        print("\n1. Workflow (Postgres-backed /v1, not the JSON-file /api)")
        r = client.post("/v1/workflows",
                        json={"workflow_name": "v2 e2e probe " + uuid.uuid4().hex[:6],
                              "tag": "selftest"})
        created = r.status_code == 201 and isinstance(r.json(), dict) and bool(r.json().get("id"))
        check("workflow created", created, f"{r.status_code} {r.text[:200]}")
        if not created:
            return 1
        wf_id = r.json()["id"]

        print("\n2. dry_run stores nothing")
        r = client.post(
            f"/v2/workflows/{wf_id}/files?dry_run=true",
            files=[("files", ("sales.csv", io.BytesIO(SALES), "text/csv"))],
            data={"manifest": json.dumps(SALES_MANIFEST)},
        )
        check("dry_run returns 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")
        body = r.json()
        check("dry_run flagged", body.get("dry_run") is True)
        prev = body["files"][0]
        check("preview shows renamed column", "date" in prev["columns"], prev["columns"])
        check("preview shows luhn filtering", prev["row_count"] == 3, prev["row_count"])
        check("preview reports counts", prev["applied"]["rows_removed"] == 1, prev["applied"])
        r2 = client.get(f"/v2/workflows/{wf_id}/files")
        check("nothing persisted by dry_run", r2.json()["items"] == [], r2.text[:200])

        print("\n3. dry_run surfaces errors without storing")
        r = client.post(
            f"/v2/workflows/{wf_id}/files?dry_run=true",
            files=[("files", ("sales.csv", io.BytesIO(SALES), "text/csv"))],
            data={"manifest": json.dumps({"live_updates": {
                "date_formats": [{"column": "month_date", "from": "%d/%m/%Y", "to": "%Y-%m-%d"}]}})},
        )
        check("bad format rejected", r.status_code == 422, r.status_code)
        check("problem+json", r.headers["content-type"].startswith("application/problem+json"),
              r.headers.get("content-type"))
        errs = r.json().get("errors", [])
        check("error names value and row", errs and "row 2" in errs[0]["message"], errs[:1])

        print("\n4. real upload of three files")
        r = client.post(
            f"/v2/workflows/{wf_id}/files",
            files=[("files", ("sales.csv", io.BytesIO(SALES), "text/csv")),
                   ("files", ("calls.csv", io.BytesIO(CALLS), "text/csv")),
                   ("files", ("xwalk.csv", io.BytesIO(XWALK), "text/csv"))],
            data={"manifest": json.dumps({
                **SALES_MANIFEST,
                "files": [
                    {"filename": "calls.csv", **CALLS_MANIFEST},
                    {"filename": "xwalk.csv", "config_metadata": {"category": "dma_hcp_map"},
                     "live_updates": {}, "filters": []},
                ],
            })},
        )
        check("upload returns 201", r.status_code == 201, f"{r.status_code} {r.text[:400]}")
        files = {f["filename"]: f for f in r.json()["files"]}
        check("three datasets stored", len(files) == 3, list(files))
        check("sales luhn-filtered", files["sales.csv"]["row_count"] == 3, files["sales.csv"]["row_count"])
        check("xwalk untouched by request-level filters",
              files["xwalk.csv"]["row_count"] == 2, files["xwalk.csv"]["row_count"])

        print("\n5. day-first dates are NOT transposed")
        r = client.get(f"/v2/workflows/{wf_id}/files/calls.csv")
        dates = sorted({row["date"] for row in r.json()["preview"]})
        check("11-02-2026 -> 2026-02-11 (not 2026-11-02)",
              dates == ["2026-01-04", "2026-02-11"], dates)

        print("\n6. raw bytes are immutable; derived is separate")
        meta = client.get(f"/v2/workflows/{wf_id}/files/sales.csv").json()
        raw = store.get_bytes(meta["object_key"])
        derived = store.get_bytes(meta["derived_key"])
        check("raw object in bucket", raw == SALES, "raw differs from upload")
        check("derived object differs from raw", derived is not None and derived != raw)
        check("raw still holds the filtered-out NPI", b"1234567890" in raw)
        check("derived dropped it", b"1234567890" not in derived)

        print("\n7. edit the manifest -> re-derive from RAW, not from derived")
        r = client.patch(
            f"/v2/workflows/{wf_id}/files/sales.csv/spec",
            json={"config_metadata": {"category": "sales"},
                  "live_updates": SALES_MANIFEST["live_updates"],
                  "filters": []},  # drop the Luhn filter
        )
        check("spec commit 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")
        check("re-derived from raw (row comes back)", r.json()["row_count"] == 4,
              r.json()["row_count"])
        check("version incremented", r.json()["version"] > 1, r.json()["version"])

        r = client.patch(
            f"/v2/workflows/{wf_id}/files/sales.csv/spec",
            json={"config_metadata": {"category": "sales"},
                  "live_updates": SALES_MANIFEST["live_updates"],
                  "filters": SALES_MANIFEST["filters"]},
        )
        check("re-applying the filter returns to 3 rows", r.json()["row_count"] == 3,
              r.json()["row_count"])

        print("\n8. optimistic concurrency")
        r = client.patch(
            f"/v2/workflows/{wf_id}/files/sales.csv/spec",
            json={"config_metadata": {}, "live_updates": SALES_MANIFEST["live_updates"],
                  "expected_version": 1},
        )
        check("stale version rejected with 409", r.status_code == 409, r.status_code)

        print("\n9. granularity rollup reports unhandled columns")
        r = client.post(
            f"/v2/workflows/{wf_id}/files/calls.csv/preview",
            json={"live_updates": CALLS_MANIFEST["live_updates"],
                  "granularity": {"from": "Daily", "to": "Monthly", "date_column": "date",
                                  "geo_column": "npi", "numeric": {"calls": "sum"}}},
        )
        check("rollup preview 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")
        check("'rep' reported, not silently dropped",
              r.json()["applied"]["unhandled_columns"] == ["rep"],
              r.json()["applied"]["unhandled_columns"])

        print("\n10. merge")
        r = client.post(f"/v2/workflows/{wf_id}/merge?dry_run=true",
                        json={"inputs": ["sales.csv", "calls.csv", "xwalk.csv"],
                              "on": ["npi"], "how": "left"})
        check("merge dry_run 200", r.status_code == 200, f"{r.status_code} {r.text[:300]}")
        check("merge dry_run persists nothing",
              "__merged__.csv" not in
              {f["filename"] for f in client.get(f"/v2/workflows/{wf_id}/files").json()["items"]})

        r = client.post(f"/v2/workflows/{wf_id}/merge",
                        json={"inputs": ["sales.csv", "calls.csv", "xwalk.csv"],
                              "on": ["npi"], "how": "left"})
        check("merge 201", r.status_code == 201, f"{r.status_code} {r.text[:300]}")
        merged = r.json()
        check("merge is its own dataset", merged["kind"] == "merge", merged["kind"])
        check("merge records its inputs",
              merged["derived_from"]["inputs"] == ["sales.csv", "calls.csv", "xwalk.csv"],
              merged["derived_from"])
        cols = set(merged["columns"])
        check("merged carries columns from all three",
              {"trx", "calls", "dma_name"} <= cols, sorted(cols))

        r = client.post(f"/v2/workflows/{wf_id}/merge",
                        json={"inputs": ["sales.csv", "xwalk.csv"], "on": ["nope"]})
        check("missing join key -> 422", r.status_code == 422, r.status_code)
        check("names the offending key",
              r.json()["errors"][0]["code"] == "join_key_missing", r.json().get("errors"))

        print("\n11. download presigns")
        r = client.get(f"/v2/workflows/{wf_id}/files/sales.csv/download?which=raw")
        check("presigned url returned", r.status_code == 200 and r.json()["download_url"].startswith("http"),
              r.text[:200])

        print("\n12. error paths")
        check("unknown workflow -> 404",
              client.get("/v2/workflows/wf_does_not_exist/files").status_code == 404)
        check("unknown file -> 404",
              client.get(f"/v2/workflows/{wf_id}/files/ghost.csv").status_code == 404)
        r = client.post(f"/v2/workflows/{wf_id}/files",
                        files=[("files", ("bad.pdf", io.BytesIO(b"x"), "application/pdf"))])
        check("unsupported extension -> 415", r.status_code == 415, r.status_code)
        r = client.post(f"/v2/workflows/{wf_id}/files",
                        files=[("files", ("sales.csv", io.BytesIO(SALES), "text/csv"))])
        check("duplicate without overwrite -> 409", r.status_code == 409, r.status_code)

        print("\n13. health tells the truth")
        h = client.get("/health").json()
        check("health probes db", h["database"]["ok"] is True, h)
        check("health probes storage", h["storage"]["ok"] is True, h)

        return 1 if FAIL else 0

    finally:
        print("\n14. cleanup")
        try:
            if wf_id is None:
                raise RuntimeError("no workflow was created; nothing to clean up")
            listed = client.get(f"/v2/workflows/{wf_id}/files").json().get("items", [])
            for item in listed:
                client.delete(f"/v2/workflows/{wf_id}/files/{item['filename']}")
            leftover = store.list_prefix(store.workflow_prefix(wf_id))
            store.delete_keys([o["Key"] for o in leftover])
            if created and wf_id:
                client.delete(f"/v1/workflows/{wf_id}")
            remaining = store.list_prefix(store.workflow_prefix(wf_id))
            print(f"  removed {len(listed)} dataset(s); {len(remaining)} object(s) left behind")
        except Exception as exc:
            print(f"  cleanup warning: {type(exc).__name__}: {exc}")

        print("\n" + "=" * 62)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
