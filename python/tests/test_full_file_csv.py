"""GET /v2/workflows/{id}/files/{name}/csv returns the whole upload.

    python/.venv/Scripts/python.exe python/tests/test_full_file_csv.py

The Time-Series Trend on the ingestion screen used to chart `previewRows` -
the first hundred rows - because the comment above it said no endpoint
returned a raw file's full content. One does: the same `/csv` the Data Review
page uses for an ARD works for an upload too. This pins what the chart now
depends on:

  * every row comes back, not a preview window;
  * the frame is RESOLVED, so a renamed column arrives under its new name and
    a dropped one does not arrive at all - which is why the chart looks rows
    up through `renamedName` rather than by the name on the pill;
  * a filter in the spec is reflected in the row count, so the trend redraws
    to match what the rest of the screen says the file contains.
"""

import io
import os
import uuid

import httpx

BASE = os.environ.get("BEACON_BASE_URL", "http://127.0.0.1:8090")
PASS, FAIL = [], []


def check(label, cond, detail=""):
    (PASS if cond else FAIL).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (f"  :: {detail}" if detail and not cond else ""))


ROWS = 450  # comfortably past any 100-row preview window
CSV = "week,region,trx,spend\n" + "".join(
    f"2026-01-{(i % 28) + 1:02d},R{i % 3},{i},{i * 2}\n" for i in range(ROWS)
)


def body_rows(text):
    return [ln for ln in text.strip().splitlines()[1:] if ln]


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=180.0)
    wf = None
    try:
        wf = c.post("/v1/workflows",
                    json={"workflow_name": "fullcsv " + uuid.uuid4().hex[:6]}).json()["id"]
        r = c.post(f"/v2/workflows/{wf}/files", params={"overwrite": True},
                   files=[("files", ("t.csv", CSV.encode(), "text/csv"))],
                   data={"manifest": "{}"})
        check("uploaded", r.status_code in (200, 201), r.text[:250])

        print("\n1. the whole file, not a preview window")
        r = c.get(f"/v2/workflows/{wf}/files/t.csv/csv")
        check("csv fetched", r.status_code == 200, r.text[:200])
        rows = body_rows(r.text)
        check(f"all {ROWS} rows returned", len(rows) == ROWS, len(rows))
        check("more than a preview's worth", len(rows) > 100, len(rows))

        print("\n2. the preview really is only a window - which is what was being charted")
        meta = c.get(f"/v2/workflows/{wf}/files/t.csv").json()
        check("row_count agrees with the csv", meta["row_count"] == ROWS, meta["row_count"])
        check("but the preview is capped", len(meta["preview"]) < ROWS, len(meta["preview"]))

        print("\n3. the frame is resolved, so a rename lands in the header")
        spec = {"live_updates": {"column_renames": [{"from": "trx", "to": "scripts"}],
                                 "column_drops": ["region"]}}
        r = c.patch(f"/v2/workflows/{wf}/files/t.csv/spec", json=spec)
        check("spec committed", r.status_code == 200, r.text[:250])
        header = c.get(f"/v2/workflows/{wf}/files/t.csv/csv").text.splitlines()[0].split(",")
        check("renamed column is under its new name", "scripts" in header, header)
        check("the old name is gone", "trx" not in header, header)
        check("the dropped column is gone", "region" not in header, header)
        check("row count is untouched by a rename",
              len(body_rows(c.get(f"/v2/workflows/{wf}/files/t.csv/csv").text)) == ROWS,
              "rows changed")

        print("\n4. a filter shows up in what the chart would draw")
        spec_filtered = {
            "live_updates": {"column_renames": [{"from": "trx", "to": "scripts"}]},
            # Filters run after the renames, so the column is "scripts" here.
            "filters": [{"type": "range", "column": "scripts", "min": 200}],
        }
        r = c.patch(f"/v2/workflows/{wf}/files/t.csv/spec", json=spec_filtered)
        check("filtered spec committed", r.status_code == 200, r.text[:250])
        filtered = body_rows(c.get(f"/v2/workflows/{wf}/files/t.csv/csv").text)
        check("fewer rows than the raw file", len(filtered) < ROWS, len(filtered))
        check("exactly the rows that pass", len(filtered) == ROWS - 200, len(filtered))

        return 1 if FAIL else 0
    finally:
        if wf:
            c.delete(f"/v2/workflows/{wf}/files/t.csv")
            c.delete(f"/v1/workflows/{wf}")
            print("\n  cleaned up")
        print("=" * 58)
        print(f"PASSED {len(PASS)} / {len(PASS) + len(FAIL)}")
        for f in FAIL:
            print("   FAILED: " + f)


if __name__ == "__main__":
    raise SystemExit(main())
