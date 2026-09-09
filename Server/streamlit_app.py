"""Streamlit tester for the Beacon API.

Run the API first, then this:

    .venv\\Scripts\\python.exe run.py
    .venv\\Scripts\\python.exe -m streamlit run streamlit_app.py

Use run.py, not the bare `uvicorn` command: on Windows uvicorn builds its event
loop before importing the app, and async psycopg cannot use it.

It is a thin client over HTTP - it never touches the database or the bucket
directly, so what you see here is exactly what the contract delivers.
"""

import io
import json

import pandas as pd
import requests
import streamlit as st

st.set_page_config(page_title="Beacon API Tester", page_icon=":satellite:", layout="wide")

DEFAULT_BASE = "http://127.0.0.1:8100"


# ----------------------------------------------------------------- helpers


def api(base: str) -> str:
    return base.rstrip("/") + "/v1"


def show_problem(r: requests.Response) -> None:
    """Render a problem+json body the way the contract defines it."""
    try:
        body = r.json()
    except ValueError:
        st.error(f"HTTP {r.status_code}: {r.text[:500]}")
        return

    st.error(f"HTTP {r.status_code} - {body.get('title', 'Error')}")
    if body.get("detail"):
        st.caption(body["detail"])
    if body.get("errors"):
        st.dataframe(pd.DataFrame(body["errors"]), use_container_width=True)
    with st.expander("Raw response"):
        st.json(body)


def ok(r: requests.Response) -> bool:
    return 200 <= r.status_code < 300


def fetch_workflows(base: str) -> list[dict]:
    try:
        r = requests.get(f"{api(base)}/workflows", params={"limit": 200}, timeout=15)
    except requests.RequestException as exc:
        st.session_state["conn_error"] = str(exc)
        return []
    st.session_state.pop("conn_error", None)
    return r.json().get("items", []) if ok(r) else []


def rows_to_ops(df: pd.DataFrame, cols: list[str]) -> list[dict]:
    """Drop blank rows from a data_editor grid and return clean dicts."""
    out = []
    for _, row in df.iterrows():
        values = {c: (str(row[c]).strip() if pd.notna(row[c]) else "") for c in cols}
        if all(values[c] for c in cols if c not in ("precision", "scale", "on_error")):
            out.append(values)
    return out


# ----------------------------------------------------------------- sidebar

st.sidebar.title("Beacon")
base_url = st.sidebar.text_input("API base URL", DEFAULT_BASE)

try:
    health = requests.get(f"{base_url.rstrip('/')}/health", timeout=5)
    if ok(health):
        st.sidebar.success("API reachable")
    else:
        st.sidebar.error(f"API returned {health.status_code}")
except requests.RequestException:
    st.sidebar.error("API unreachable")
    st.sidebar.caption(
        "Start it with:\n\n`.venv\\Scripts\\python.exe run.py`"
    )

st.sidebar.divider()
st.sidebar.caption(
    "Storage layout\n\n"
    "```\n"
    "data/{workflow_id}/\n"
    "  file.csv\n"
    "  other.csv\n"
    "  _log.json\n"
    "  _struct_updates.json\n"
    "```\n\n"
    "One `_log.json` and one `_struct_updates.json` per workflow, "
    "keyed by filename."
)

tab_create, tab_browse, tab_upload, tab_files = st.tabs(
    ["Create workflow", "Workflows", "Upload files", "Stored files"]
)


# ------------------------------------------------------ 1. create workflow

with tab_create:
    st.header("Create New Workflow")
    st.caption("POST /v1/workflows")

    with st.form("create_workflow"):
        name = st.text_input("Workflow Name *", placeholder="Q3 Revenue Ingest")
        state = st.selectbox(
            "State", ["new", "configured", "running", "complete", "failed"], index=0
        )
        tag = st.text_input("Tag (optional)", placeholder="finance")
        submitted = st.form_submit_button("Create", type="primary")

    if submitted:
        if not name.strip():
            st.warning("Workflow Name is required.")
        else:
            payload = {"workflow_name": name, "state": state}
            if tag.strip():
                payload["tag"] = tag.strip()

            r = requests.post(
                f"{api(base_url)}/workflows", json=payload, timeout=20
            )
            if ok(r):
                body = r.json()
                st.success(f"Created workflow {body['id']}")
                st.json(body)
                st.session_state["last_workflow"] = body["id"]
            else:
                show_problem(r)

    st.divider()
    st.subheader("Try the validation rules")
    c1, c2 = st.columns(2)
    if c1.button("Send a blank name (expect 422)"):
        show_problem(
            requests.post(f"{api(base_url)}/workflows",
                          json={"workflow_name": "   "}, timeout=15)
        )
    if c2.button("Send an unknown state (expect 422)"):
        show_problem(
            requests.post(f"{api(base_url)}/workflows",
                          json={"workflow_name": "probe", "state": "bogus"}, timeout=15)
        )


# ----------------------------------------------------------- 2. workflows

with tab_browse:
    st.header("Workflows")
    st.caption("GET /v1/workflows")

    c1, c2, c3, c4 = st.columns([1, 1, 2, 1])
    f_state = c1.selectbox(
        "state", ["(any)", "new", "configured", "running", "complete", "failed"]
    )
    f_tag = c2.text_input("tag", "")
    f_q = c3.text_input("name contains", "")
    c4.write("")
    if c4.button("Refresh"):
        st.rerun()

    params: dict = {"limit": 200}
    if f_state != "(any)":
        params["state"] = f_state
    if f_tag.strip():
        params["tag"] = f_tag.strip()
    if f_q.strip():
        params["q"] = f_q.strip()

    try:
        r = requests.get(f"{api(base_url)}/workflows", params=params, timeout=15)
        if ok(r):
            items = r.json()["items"]
            if items:
                st.dataframe(pd.DataFrame(items), use_container_width=True)
                st.caption(f"{len(items)} workflow(s)")
            else:
                st.info("No workflows match.")
        else:
            show_problem(r)
    except requests.RequestException as exc:
        st.error(f"Cannot reach the API: {exc}")

    st.divider()
    st.subheader("Update or delete")
    workflows = fetch_workflows(base_url)
    if workflows:
        labels = {f"{w['workflow_name']} ({w['id'][:8]})": w for w in workflows}
        picked = st.selectbox("Workflow", list(labels), key="edit_pick")
        wf = labels[picked]

        c1, c2 = st.columns(2)
        with c1:
            st.markdown("**PATCH**")
            new_state = st.selectbox(
                "state",
                ["(unchanged)", "new", "configured", "running", "complete", "failed"],
                key="patch_state",
            )
            new_tag = st.text_input("tag", wf.get("tag") or "", key="patch_tag")
            clear_tag = st.checkbox("Clear tag (send null)", key="patch_clear")
            if st.button("Apply update"):
                body: dict = {}
                if new_state != "(unchanged)":
                    body["state"] = new_state
                if clear_tag:
                    body["tag"] = None
                elif new_tag.strip() != (wf.get("tag") or ""):
                    body["tag"] = new_tag.strip() or None
                if not body:
                    st.warning("Nothing changed.")
                else:
                    resp = requests.patch(
                        f"{api(base_url)}/workflows/{wf['id']}", json=body, timeout=20
                    )
                    if ok(resp):
                        st.success("Updated")
                        st.json(resp.json())
                    else:
                        show_problem(resp)

        with c2:
            st.markdown("**DELETE**")
            purge = st.checkbox(
                "purge_objects",
                help="Without this, deleting a workflow that still owns files "
                     "returns 409 rather than orphaning them.",
            )
            if st.button("Delete workflow", type="secondary"):
                resp = requests.delete(
                    f"{api(base_url)}/workflows/{wf['id']}",
                    params={"purge_objects": purge}, timeout=30,
                )
                if resp.status_code == 204:
                    st.success("Deleted")
                    st.rerun()
                else:
                    show_problem(resp)
    else:
        st.info("Create a workflow first.")


# --------------------------------------------------------- 3. upload files

with tab_upload:
    st.header("Upload files")
    st.caption("POST /v1/workflows/{workflow_id}/files  (multipart/form-data)")

    workflows = fetch_workflows(base_url)
    if not workflows:
        st.info("Create a workflow first.")
    else:
        labels = {f"{w['workflow_name']} ({w['id'][:8]})": w["id"] for w in workflows}
        default_idx = 0
        last = st.session_state.get("last_workflow")
        if last:
            for i, wid in enumerate(labels.values()):
                if wid == last:
                    default_idx = i
        picked = st.selectbox("Workflow", list(labels), index=default_idx)
        workflow_id = labels[picked]

        uploads = st.file_uploader(
            "Data files", type=["csv", "tsv", "txt", "xlsx", "xlsm"],
            accept_multiple_files=True,
        )

        if uploads:
            with st.expander("Preview the first file as uploaded", expanded=False):
                head = uploads[0]
                try:
                    raw = head.getvalue()
                    preview = (
                        pd.read_excel(io.BytesIO(raw), dtype=object)
                        if head.name.lower().endswith((".xlsx", ".xlsm"))
                        else pd.read_csv(io.BytesIO(raw), dtype=object)
                    )
                    st.dataframe(preview.head(20), use_container_width=True)
                    st.caption("Columns: " + ", ".join(str(c) for c in preview.columns))
                except Exception as exc:  # noqa: BLE001
                    st.warning(f"Could not preview: {exc}")

        st.subheader("config_metadata")
        st.caption(
            "Stored under `files/{filename}` in the workflow's single "
            "`_log.json`. Free-form JSON."
        )
        config_text = st.text_area(
            "config_metadata JSON",
            value=json.dumps(
                {"source_system": "SAP", "refresh": "daily", "owner": "finance-ops"},
                indent=2,
            ),
            height=140,
        )

        st.subheader("live_updates")
        st.caption(
            "Applied **before** the file is stored, in fixed order: "
            "date_formats -> dtype_changes -> column_renames. "
            "Every row names the column as it appears in the *uploaded* file. "
            "Saved under `files/{filename}` in the workflow's single "
            "`_struct_updates.json`."
        )

        c1, c2, c3 = st.columns(3)
        with c1:
            st.markdown("**date_formats**")
            dates = st.data_editor(
                pd.DataFrame([{"column": "", "from": "", "to": ""}]),
                num_rows="dynamic", use_container_width=True, key="ed_dates",
                column_config={
                    "from": st.column_config.TextColumn(help="e.g. %d-%m-%Y"),
                    "to": st.column_config.TextColumn(help="e.g. %Y-%m-%d"),
                },
            )
        with c2:
            st.markdown("**dtype_changes**")
            dtypes = st.data_editor(
                pd.DataFrame(
                    [{"column": "", "to": "", "precision": "", "scale": "",
                      "on_error": "fail"}]
                ),
                num_rows="dynamic", use_container_width=True, key="ed_dtypes",
                column_config={
                    "to": st.column_config.SelectboxColumn(
                        options=["string", "integer", "bigint", "float", "decimal",
                                 "boolean", "date", "timestamp"]
                    ),
                    "on_error": st.column_config.SelectboxColumn(
                        options=["fail", "null_out"]
                    ),
                },
            )
        with c3:
            st.markdown("**column_renames**")
            renames = st.data_editor(
                pd.DataFrame([{"from": "", "to": ""}]),
                num_rows="dynamic", use_container_width=True, key="ed_renames",
            )

        live_updates: dict = {}
        for op in rows_to_ops(dates, ["column", "from", "to"]):
            live_updates.setdefault("date_formats", []).append(op)
        for row in rows_to_ops(dtypes, ["column", "to", "precision", "scale",
                                        "on_error"]):
            entry = {"column": row["column"], "to": row["to"]}
            if row.get("precision"):
                entry["precision"] = int(row["precision"])
            if row.get("scale"):
                entry["scale"] = int(row["scale"])
            if row.get("on_error") and row["on_error"] != "fail":
                entry["on_error"] = row["on_error"]
            live_updates.setdefault("dtype_changes", []).append(entry)
        for op in rows_to_ops(renames, ["from", "to"]):
            live_updates.setdefault("column_renames", []).append(op)

        try:
            config_metadata = json.loads(config_text) if config_text.strip() else {}
            config_ok = isinstance(config_metadata, dict)
        except json.JSONDecodeError as exc:
            config_metadata, config_ok = {}, False
            st.error(f"config_metadata is not valid JSON: {exc}")

        manifest = {"config_metadata": config_metadata, "live_updates": live_updates}
        with st.expander("Manifest that will be sent", expanded=True):
            st.code(json.dumps(manifest, indent=2), language="json")

        overwrite = st.checkbox(
            "overwrite", help="Without this, re-uploading the same filename is a 409."
        )

        if st.button("Upload", type="primary", disabled=not (uploads and config_ok)):
            parts = [
                ("files", (f.name, f.getvalue(), "application/octet-stream"))
                for f in uploads
            ]
            resp = requests.post(
                f"{api(base_url)}/workflows/{workflow_id}/files",
                data={"manifest": json.dumps(manifest)},
                files=parts, params={"overwrite": overwrite}, timeout=180,
            )
            if ok(resp):
                body = resp.json()
                st.success(f"Stored {len(body['files'])} file(s)")
                for f in body["files"]:
                    st.markdown(f"**{f['filename']}** -> `{f['object_key']}`")
                    m1, m2, m3 = st.columns(3)
                    m1.metric("rows", f.get("row_count") or 0)
                    m2.metric("bytes", f["size_bytes"])
                    applied = f.get("applied") or {}
                    m3.metric(
                        "ops applied",
                        applied.get("date_formats", 0)
                        + applied.get("dtype_changes", 0)
                        + applied.get("column_renames", 0),
                    )
                    if applied.get("nulled_values"):
                        st.warning(
                            f"{applied['nulled_values']} value(s) nulled by "
                            f"on_error=null_out."
                        )
                    st.caption("Final columns: " + ", ".join(f.get("columns", [])))
                    st.json(f, expanded=False)
                st.session_state["last_workflow"] = workflow_id
            else:
                show_problem(resp)


# ---------------------------------------------------------- 4. stored files

with tab_files:
    st.header("Stored files")
    st.caption("GET / PATCH / DELETE /v1/workflows/{workflow_id}/files")

    workflows = fetch_workflows(base_url)
    if not workflows:
        st.info("Create a workflow first.")
    else:
        labels = {f"{w['workflow_name']} ({w['id'][:8]})": w["id"] for w in workflows}
        picked = st.selectbox("Workflow", list(labels), key="files_pick")
        workflow_id = labels[picked]

        show_sidecars = st.checkbox("include_sidecars", value=True)
        r = requests.get(
            f"{api(base_url)}/workflows/{workflow_id}/files",
            params={"include_sidecars": show_sidecars}, timeout=20,
        )
        if not ok(r):
            show_problem(r)
        else:
            items = r.json()["items"]
            if not items:
                st.info("Nothing stored for this workflow yet.")
            else:
                st.dataframe(pd.DataFrame(items), use_container_width=True)

                data_files = [
                    i["filename"] for i in items
                    if i["filename"] not in ("_log.json", "_struct_updates.json")
                ]
                if data_files:
                    st.divider()
                    chosen = st.selectbox("Inspect data file", data_files)

                    c1, c2, c3 = st.columns(3)

                    if c1.button("Get download URL"):
                        d = requests.get(
                            f"{api(base_url)}/workflows/{workflow_id}/files/{chosen}",
                            timeout=20,
                        )
                        if ok(d):
                            body = d.json()
                            st.success("Presigned URL (bucket `data` is private)")
                            st.code(body["download_url"])
                            st.caption(f"expires {body['download_url_expires_at']}")
                            try:
                                got = requests.get(body["download_url"], timeout=30)
                                st.dataframe(
                                    pd.read_csv(io.BytesIO(got.content),
                                                dtype=object).head(25),
                                    use_container_width=True,
                                )
                                st.caption("Contents as stored, after transformation.")
                            except Exception:  # noqa: BLE001
                                st.caption("(Preview only works for CSV.)")
                        else:
                            show_problem(d)

                    if c2.button("Read sidecars"):
                        d = requests.get(
                            f"{api(base_url)}/workflows/{workflow_id}"
                            f"/files/{chosen}/config",
                            timeout=20,
                        )
                        if ok(d):
                            body = d.json()
                            left, right = st.columns(2)
                            left.markdown("**_log.json** (config_metadata)")
                            left.json(body["config_metadata"])
                            right.markdown("**_struct_updates.json** (live_updates)")
                            right.json(body["live_updates"])
                        else:
                            show_problem(d)

                    if c3.button("Delete file", type="secondary"):
                        d = requests.delete(
                            f"{api(base_url)}/workflows/{workflow_id}/files/{chosen}",
                            timeout=30,
                        )
                        if d.status_code == 204:
                            st.success(f"Deleted {chosen} and both sidecars")
                            st.rerun()
                        else:
                            show_problem(d)

                    st.divider()
                    st.subheader("Update config_metadata")
                    st.caption(
                        "PATCH rewrites `_log.json` only. `live_updates` is rejected: "
                        "it describes a transformation already baked into the stored "
                        "bytes, so editing it alone would make the sidecar lie."
                    )
                    new_config = st.text_area(
                        "New config_metadata JSON", value="{}", height=120,
                        key="patch_config",
                    )
                    if st.button("Apply config PATCH"):
                        try:
                            parsed = json.loads(new_config)
                        except json.JSONDecodeError as exc:
                            st.error(f"Not valid JSON: {exc}")
                        else:
                            d = requests.patch(
                                f"{api(base_url)}/workflows/{workflow_id}"
                                f"/files/{chosen}/config",
                                json={"config_metadata": parsed}, timeout=20,
                            )
                            if ok(d):
                                st.success("Rewrote _log.json")
                                st.json(d.json())
                            else:
                                show_problem(d)
