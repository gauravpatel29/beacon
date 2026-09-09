"""End-to-end check against the live Neon branch and bucket.

Creates a workflow, uploads a CSV needing all three transformation kinds,
verifies what actually landed in object storage, exercises the error paths,
then deletes everything it created.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from app import storage  # noqa: E402
from app.main import app  # noqa: E402

PASS, FAIL = [], []


def check(label: str, condition: bool, detail: str = "") -> None:
    (PASS if condition else FAIL).append(label)
    mark = "PASS" if condition else "FAIL"
    print(f"  [{mark}] {label}" + (f"  -- {detail}" if detail and not condition else ""))


CSV = (
    "cust_id,amount,txn_date,active\n"
    "C001,1234.567,15-03-2024,yes\n"
    "C002,89.1,02-11-2024,no\n"
    "C003,42,31-12-2023,yes\n"
)

MANIFEST = {
    "config_metadata": {"source_system": "SAP", "refresh": "daily"},
    "live_updates": {
        "date_formats": [
            {"column": "txn_date", "from": "%d-%m-%Y", "to": "%Y-%m-%d"}
        ],
        "dtype_changes": [
            {"column": "amount", "to": "decimal", "precision": 18, "scale": 2},
            {"column": "active", "to": "boolean"},
        ],
        "column_renames": [{"from": "cust_id", "to": "customer_id"}],
    },
}


def main() -> int:
    client = TestClient(app)
    wf_id = None

    try:
        print("\n1. Workflow CRUD")
        r = client.post("/v1/workflows", json={"workflow_name": "  E2E Probe  ",
                                               "tag": "selftest"})
        check("create returns 201", r.status_code == 201, r.text)
        wf = r.json()
        wf_id = wf["id"]
        check("state defaults to 'new'", wf["state"] == "new", str(wf))
        check("workflow_name trimmed", wf["workflow_name"] == "E2E Probe", str(wf))
        check("Location header set", "location" in {k.lower() for k in r.headers})

        r = client.post("/v1/workflows", json={"workflow_name": "   "})
        check("blank name rejected 422", r.status_code == 422, r.text)

        r = client.post("/v1/workflows", json={"workflow_name": "x", "state": "bogus"})
        check("bad state rejected 422", r.status_code == 422, r.text)

        r = client.patch(f"/v1/workflows/{wf_id}", json={"tag": None})
        check("tag cleared by explicit null", r.json()["tag"] is None, r.text)
        client.patch(f"/v1/workflows/{wf_id}", json={"tag": "selftest"})

        r = client.get("/v1/workflows", params={"state": "new", "limit": 5})
        check("list filters by state", r.status_code == 200 and "items" in r.json())

        print("\n2. Upload + transform")
        r = client.post(
            f"/v1/workflows/{wf_id}/files",
            data={"manifest": json.dumps(MANIFEST)},
            files=[("files", ("sales_2024.csv", CSV, "text/csv"))],
        )
        check("upload returns 201", r.status_code == 201, r.text)
        if r.status_code != 201:
            return 1

        stored = r.json()["files"][0]
        check("renamed column reported",
              stored["columns"][0] == "customer_id", str(stored["columns"]))
        check("row_count correct", stored["row_count"] == 3, str(stored))
        check("all three op kinds applied",
              stored["applied"]["date_formats"] == 1
              and stored["applied"]["dtype_changes"] == 2
              and stored["applied"]["column_renames"] == 1, str(stored["applied"]))
        check("object_key is {workflow_id}/{filename}",
              stored["object_key"] == f"{wf_id}/sales_2024.csv", stored["object_key"])
        check("sidecars are workflow-level, one pair per folder",
              stored["sidecars"]["config_metadata"] == f"{wf_id}/_log.json"
              and stored["sidecars"]["live_updates"]
              == f"{wf_id}/_struct_updates.json", str(stored["sidecars"]))

        print("\n3. Bytes actually in the bucket")
        obj = storage._client().get_object(
            Bucket=storage.get_settings().bucket, Key=stored["object_key"]
        )
        body = obj["Body"].read().decode()
        header, *rows = body.strip().splitlines()
        check("stored header renamed", header.split(",")[0] == "customer_id", header)
        check("date reformatted to ISO", "2024-03-15" in rows[0], rows[0])
        check("decimal quantized to 2dp", "1234.57" in rows[0], rows[0])
        check("boolean cast", rows[0].strip().endswith("True"), rows[0])

        log = storage.get_json(stored["sidecars"]["config_metadata"])
        check("_log.json keyed by filename",
              log["files"]["sales_2024.csv"] == MANIFEST["config_metadata"], str(log))
        struct = storage.get_json(stored["sidecars"]["live_updates"])
        check("_struct_updates.json keyed by filename",
              "column_renames" in struct["files"]["sales_2024.csv"], str(struct))

        # A second file must extend the same two sidecars, not create its own.
        second = "cust_id,amount,txn_date,active\nC009,5.5,01-01-2024,yes\n"
        r2 = client.post(
            f"/v1/workflows/{wf_id}/files",
            data={"manifest": json.dumps({"config_metadata": {"source_system": "CRM"},
                                          "live_updates": {}})},
            files=[("files", ("second.csv", second, "text/csv"))],
        )
        check("second upload accepted", r2.status_code == 201, r2.text)
        keys = {o["Key"] for o in storage.list_prefix(f"{wf_id}/")}
        check("still exactly one _log.json + one _struct_updates.json",
              keys == {f"{wf_id}/sales_2024.csv", f"{wf_id}/second.csv",
                       f"{wf_id}/_log.json", f"{wf_id}/_struct_updates.json"},
              str(sorted(keys)))
        log2 = storage.get_json(f"{wf_id}/_log.json")
        check("both files present in the one _log.json",
              set(log2["files"]) == {"sales_2024.csv", "second.csv"}, str(log2))
        check("first file's config not clobbered by the second",
              log2["files"]["sales_2024.csv"] == MANIFEST["config_metadata"],
              str(log2))

        print("\n4. Read paths")
        r = client.get(f"/v1/workflows/{wf_id}/files")
        check("list hides sidecars by default (2 data files)",
              len(r.json()["items"]) == 2, str(r.json()))
        r = client.get(f"/v1/workflows/{wf_id}/files",
                       params={"include_sidecars": True})
        check("list shows sidecars on request (2 data + 2 sidecars)",
              len(r.json()["items"]) == 4, str(r.json()))

        r = client.get(f"/v1/workflows/{wf_id}/files/sales_2024.csv")
        check("presigned URL returned",
              r.status_code == 200 and r.json()["download_url"].startswith("http"),
              r.text)

        r = client.get(f"/v1/workflows/{wf_id}/files/sales_2024.csv/config")
        check("config endpoint returns both sidecars",
              r.json()["config_metadata"] == MANIFEST["config_metadata"], r.text)

        r = client.patch(f"/v1/workflows/{wf_id}/files/sales_2024.csv/config",
                         json={"config_metadata": {"source_system": "Oracle"}})
        check("config PATCH rewrites _log.json", r.status_code == 200, r.text)
        check("PATCH rejects live_updates",
              client.patch(
                  f"/v1/workflows/{wf_id}/files/sales_2024.csv/config",
                  json={"config_metadata": {}, "live_updates": {}},
              ).status_code == 422)

        print("\n5. Error paths")
        r = client.post(
            f"/v1/workflows/{wf_id}/files",
            data={"manifest": json.dumps(MANIFEST)},
            files=[("files", ("sales_2024.csv", CSV, "text/csv"))],
        )
        check("duplicate upload conflicts 409", r.status_code == 409, r.text)

        bad = {"live_updates": {"column_renames": [{"from": "nope", "to": "x"}]}}
        r = client.post(
            f"/v1/workflows/{wf_id}/files",
            data={"manifest": json.dumps(bad)},
            files=[("files", ("other.csv", CSV, "text/csv"))],
        )
        check("unknown column rejected 422", r.status_code == 422, r.text)
        check("error names the column",
              r.json().get("errors", [{}])[0].get("code") == "column_not_found",
              r.text)
        check("nothing written on failure",
              not storage.exists(f"{wf_id}/other.csv"))

        bad_cast = {"live_updates": {"dtype_changes":
                                     [{"column": "cust_id", "to": "integer"}]}}
        r = client.post(
            f"/v1/workflows/{wf_id}/files",
            data={"manifest": json.dumps(bad_cast)},
            files=[("files", ("cast.csv", CSV, "text/csv"))],
        )
        check("uncastable value rejected 422", r.status_code == 422, r.text)
        check("no partial object after cast failure",
              not storage.exists(f"{wf_id}/cast.csv"))

        null_out = {"live_updates": {"dtype_changes":
                                     [{"column": "cust_id", "to": "integer",
                                       "on_error": "null_out"}]}}
        r = client.post(
            f"/v1/workflows/{wf_id}/files",
            data={"manifest": json.dumps(null_out)},
            files=[("files", ("nulled.csv", CSV, "text/csv"))],
        )
        check("on_error=null_out succeeds", r.status_code == 201, r.text)
        check("nulled_values counted",
              r.json()["files"][0]["applied"]["nulled_values"] == 3, r.text)

        r = client.post(
            f"/v1/workflows/{wf_id}/files",
            data={"manifest": json.dumps({})},
            files=[("files", ("notes.pdf", b"x", "application/pdf"))],
        )
        check("unsupported extension rejected 415", r.status_code == 415, r.text)

        r = client.post(
            "/v1/workflows/00000000-0000-0000-0000-000000000000/files",
            data={"manifest": json.dumps({})},
            files=[("files", ("a.csv", CSV, "text/csv"))],
        )
        check("unknown workflow rejected 404", r.status_code == 404, r.text)

        r = client.delete(f"/v1/workflows/{wf_id}")
        check("delete blocked while objects exist 409", r.status_code == 409, r.text)

        print("\n6. Cleanup")
        r = client.delete(f"/v1/workflows/{wf_id}/files/sales_2024.csv")
        check("file delete 204", r.status_code == 204, r.text)
        log3 = storage.get_json(f"{wf_id}/_log.json")
        check("deleted file's entry dropped from _log.json",
              "sales_2024.csv" not in log3["files"], str(log3))
        check("other files' entries survive the delete",
              "second.csv" in log3["files"], str(log3))
        check("shared sidecar object itself still exists",
              storage.exists(f"{wf_id}/_log.json"))

        r = client.delete(f"/v1/workflows/{wf_id}", params={"purge_objects": True})
        check("purge delete 204", r.status_code == 204, r.text)
        check("bucket prefix empty", storage.list_prefix(f"{wf_id}/") == [])
        check("workflow gone",
              client.get(f"/v1/workflows/{wf_id}").status_code == 404)
        wf_id = None

    finally:
        if wf_id:
            client.delete(f"/v1/workflows/{wf_id}", params={"purge_objects": True})

    print(f"\n{'=' * 46}\nPASSED {len(PASS)}   FAILED {len(FAIL)}")
    for f in FAIL:
        print("  failed:", f)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
