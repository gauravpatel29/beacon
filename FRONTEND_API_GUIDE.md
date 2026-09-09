# Beacon — Frontend API Guide

Scope: the **Workflow Creation** screen and the **Data Ingestion** screen.

These are the only endpoints those two screens call — nothing here is optional
or "maybe useful later". Every example is a **real captured request/response**,
not an illustration.

### Which screen calls what

| Screen | Endpoint | Section |
|---|---|---|
| **Workflow Creation** | `POST /v1/workflows` | [3.1](#31-create) |
| | `GET /v1/workflows` | [3.2](#32-list) |
| | `GET /v1/workflows/{id}` | [3.3](#33-get-one) |
| | `PATCH /v1/workflows/{id}` | [3.4](#34-update) |
| | `DELETE /v1/workflows/{id}` | [3.5](#35-delete) |
| **Data Ingestion** | `POST /v2/workflows/{id}/files` | [4.1](#41-upload) |
| | `POST /v2/.../files/{name}/preview` | [4.2](#42-preview-a-manifest--the-dry-run) |
| | `PATCH /v2/.../files/{name}/spec` | [4.3](#43-commit-a-manifest) |
| | `GET /v2/workflows/{id}/files` | [4.4](#44-list-datasets) |
| | `GET /v2/.../files/{name}/profile` | [4.5](#45-profile-the-columns--how-the-form-pre-fills-itself) |
| | `GET /v2/.../files/{name}/csv` | [4.6](#46-get-as-csv--transitional) |
| | `DELETE /v2/.../files/{name}` | [4.7](#47-delete) |
| | `POST /v2/.../files/{name}/detect-granularity` | [4.8](#48-detect-granularity) |

`PATCH /v1/workflows/{id}` is also called by the ingestion screen, via
`saveWorkflowSnapshot` on **Proceed**.

The API has a few other routes (single-dataset fetch, presigned download). They
are not used by these screens and are deliberately left out.

---

## 0. Orientation

### The one idea that shapes every call

> **The browser holds an id, never the file.**

Uploaded bytes live in Neon Object Storage and are addressed by
`(workflow_id, filename)`. No endpoint in this guide accepts or returns a CSV
payload as a request field — the single exception is the deliberately
transitional `/csv` endpoint (§4.6), which exists only until the downstream
screens are migrated.

Practically, this means: **do not** put file contents in React state,
`localStorage`, or a workflow snapshot. Keep `workflowId` and `filename`.

### Base URLs

| Environment | What the browser calls | Who serves it |
|---|---|---|
| Development | `/v1/...`, `/v2/...` (relative) | CRA dev server (`:3000`) proxies → Node gateway (`:5001`) → FastAPI (`:8000`) |
| Direct to API | `http://127.0.0.1:8000/v1/...` | FastAPI, bypassing the gateway (useful for Swagger at `/docs`) |
| Shared API | `https://<tunnel-host>/v1/...` | Someone else's FastAPI, exposed over a tunnel — see below |

Use **relative paths** in the client. `client/src/services/api.js` already
defines the two axios instances:

```js
const V1 = axios.create({ baseURL: "/v1", timeout: 120000 });
const V2 = axios.create({ baseURL: "/v2", timeout: 300000 });
```

The Node gateway forwards `/v1` and `/v2` verbatim — all verbs, path params,
query strings and multipart — and preserves the upstream status code and body.
It adds nothing, so the contract below is the whole contract.

### Working against someone else's API

**Only port `8000` needs to be shared.** FastAPI serves `/v1`, `/v2` *and* every
`/api/*` route. The Node gateway on `:5001` is a verbatim passthrough for `/v1`
and `/v2`, so it adds nothing you need — you do not have to run it, and neither
does whoever is hosting.

Point your dev server at the tunnel instead of localhost, in
`client/package.json`:

```json
"proxy": "https://<tunnel-host>"
```

Then keep using relative `/v1` and `/v2` paths — nothing else changes. Restart
the dev server after editing `proxy`; CRA only reads it at startup.

CORS is wide open and echoes your origin, so calling the API directly from
another origin also works if you'd rather not use the proxy.

You do **not** need Neon credentials. They live server-side; the API is the
only thing you talk to.

### Authentication

**None.** Send no auth headers. When auth arrives it will be an added header,
not a change to any path or body here.

### Two API surfaces

| Prefix | Owns | Backed by |
|---|---|---|
| `/v1/workflows` | The workflow entity — the container everything else hangs off | Neon Postgres (`workflows` table) |
| `/v2/workflows/{id}/...` | Datasets: upload, transform, read | Postgres metadata + Neon Object Storage bytes |

> ⚠️ **There is a legacy `/api/workflows` that writes to a JSON file.** It is not
> the same store. A workflow created there does not exist in Postgres, so every
> `/v2` call against it returns **404 Workflow not found**. Always use `/v1`.

---

## 1. The flow

The ingestion screen is a genuine sequence, and the API mirrors it:

| # | Step | Call | Writes? |
|---|---|---|---|
| 1 | Create workflow | `POST /v1/workflows` | yes |
| 2 | Drop files | `POST /v2/workflows/{id}/files` with `manifest={}` | yes (raw bytes) |
| 2b | Pre-fill the form | `profile` on that response, or `GET /v2/.../files/{name}/profile` | no |
| 3 | Configure + **Preview** | `POST /v2/.../files/{name}/preview` | **no** |
| 4 | **Apply** | `PATCH /v2/.../files/{name}/spec` | yes (re-derives) |
| 5 | Hand off to EDA | `GET /v2/.../files/{name}/csv` | no |

Steps 3 and 4 are the loop the user spends their time in. **Step 3 is free** —
run it on every meaningful change.

### The dry-run contract

`preview` and the real apply run the **same code path** on the server. That
gives you a guarantee worth designing around:

> A preview that succeeds means the apply will succeed on the same bytes.
> A preview that fails returns **exactly** the errors the apply would have.

So: preview freely, and only enable **Apply** once a preview has come back
clean. You never have to write speculative UI for "it might fail on save".

---

## 2. Errors

Every error is [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
`application/problem+json`. Same envelope everywhere:

```json
{
  "type": "https://beacon.api/problems/transformation-failed",
  "title": "Transformation failed",
  "status": 422,
  "instance": "/v2/workflows/af0a15ff-.../files/calls.csv/preview",
  "detail": "The stored dataset is unchanged.",
  "errors": [ { "...": "..." } ]
}
```

| Field | Always present | Use it for |
|---|---|---|
| `title` | yes | The toast / banner headline |
| `detail` | usually | The sentence under it — often says whether anything was written |
| `errors[]` | on 422 | The per-field list to render inline |
| `type` | yes | Branching in code; never show the URL to a user |

`problemMessage(err, fallback)` in `api.js` already flattens this into a string
for toasts. For inline rendering, read `err.response.data.errors`.

### Two different `errors[]` shapes

**A. Schema validation** — your manifest is malformed. `type` ends
`/validation-failed`. Entries are JSON-pointer shaped:

```json
{
  "type": "https://beacon.api/problems/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "The manifest does not match the contract.",
  "errors": [
    { "pointer": "/live_updates/date_formats/0/from",
      "code": "missing",
      "message": "Field required" }
  ]
}
```

Treat these as **your bug** — a well-built form should not be able to produce
one. The `pointer` tells you which control to highlight.

**B. Transformation failure** — the manifest is well-formed but doesn't fit the
data. `type` ends `/transformation-failed`. Entries name a file, a column, and
usually the offending value and row:

```json
{
  "type": "https://beacon.api/problems/transformation-failed",
  "title": "Transformation failed",
  "status": 422,
  "detail": "The stored dataset is unchanged.",
  "errors": [
    { "filename": "calls.csv",
      "column": "call_date",
      "code": "date_parse_failed",
      "message": "Value \"04-01-2026\" at row 2 does not match format \"%Y-%m-%d\"." }
  ]
}
```

These are **the user's to fix**, and the messages are written to be shown
verbatim. Render them as a list against the relevant column.

### Error codes

| `code` | Means | Point the user at |
|---|---|---|
| `column_not_found` | A named column isn't in the file | The control naming it — check it isn't a pre-rename name |
| `rename_collision` | Rename would create duplicate headers | The rename input |
| `date_parse_failed` | A value doesn't match the stated `from` format | The source-format dropdown |
| `cast_failed` | A value can't become the target dtype | The dtype dropdown, or offer `on_error: "null_out"` |
| `npi_luhn_no_matches` | *No* value in the column is a valid NPI | The column picker — almost always the wrong column |
| `column_dropped` | A deselected column is also being transformed | Re-check **Keep**, or remove the transform |
| `all_columns_dropped` | Every column was deselected | Keep at least one column |
| `granularity_undetectable` | Fewer than two distinct dates | The date column choice |
| `unreadable` | The file couldn't be parsed at all | The upload itself |

### Status codes

| Status | When | UI response |
|---|---|---|
| `200` / `201` | Success | — |
| `204` | Delete succeeded | No body — don't parse it |
| `400` | Malformed request (e.g. `manifest` isn't JSON) | Developer error |
| `404` | Unknown workflow or dataset | Refresh the list; it may have been deleted elsewhere |
| `409` | Duplicate filename, **or** stale `expected_version` | See §4.3 (version conflict) and §4.1 (duplicate filename) |
| `413` | File over 200 MB | Say the limit before upload |
| `415` | Unsupported extension | Say the accepted list |
| `422` | Validation or transformation failure | Render `errors[]` |
| `503` | Backend not configured (no DB / bucket creds) | "Backend unavailable" — not the user's fault |

---

## 3. Workflows — `/v1`

### 3.1 Create

`POST /v1/workflows` · `Content-Type: application/json`

```json
{ "workflow_name": "Q3 HCP Ingest", "state": "new", "tag": "finance" }
```

| Field | Required | Default | Rules |
|---|---|---|---|
| `workflow_name` | **yes** | — | 1–200 chars, trimmed; whitespace-only rejected |
| `state` | no | `"new"` | `new` · `configured` · `running` · `complete` · `failed` |
| `tag` | no | `null` | ≤100 chars |

**201**

```json
{
  "id": "af0a15ff-75d6-4b02-9fa7-e29abfafe9ca",
  "workflow_name": "Docs capture b532a",
  "state": "new",
  "tag": "docs",
  "created_at": "2026-09-09T07:46:37.536152+00:00",
  "updated_at": "2026-09-09T07:46:37.536152+00:00"
}
```

The `id` is the only thing you must keep. Every `/v2` call is scoped to it.

> **Disable the Create button until the response lands.** There is no duplicate
> protection — two clicks make two workflows.

### 3.2 List

`GET /v1/workflows`

| Query param | Meaning |
|---|---|
| `limit` | Page size (default 50) |
| `state` | Exact match |
| `tag` | Exact match |
| `q` | Case-insensitive substring of `workflow_name` |
| `cursor` | From a previous `next_cursor` |

**200** — note the envelope is `items`, not `workflows`:

```json
{ "items": [ /* workflow objects */ ], "next_cursor": null }
```

List rows carry the resume fields (`current_stage`, `module_status`), so the
Home screen can render progress without a second fetch.

### 3.3 Get one

`GET /v1/workflows/{workflow_id}` → **200**, one workflow including
`current_stage`, `current_route`, `module_status`, `state_data`.

### 3.4 Update

`PATCH /v1/workflows/{workflow_id}` — send **only** the keys you're changing.

```json
{
  "state": "running",
  "current_stage": "Data Ingestion",
  "current_route": "/ingestion",
  "module_status": { "ingestion": "in_progress", "eda": "pending" },
  "state_data": { "activeDataset": "calls.csv" }
}
```

**200**

```json
{
  "id": "af0a15ff-75d6-4b02-9fa7-e29abfafe9ca",
  "workflow_name": "Docs capture b532a",
  "name": "Docs capture b532a",
  "state": "running",
  "tag": "docs",
  "created_at": "2026-09-09T07:46:37.536152+00:00",
  "updated_at": "2026-09-09T07:46:40.540332+00:00",
  "current_stage": "Data Ingestion",
  "current_route": "/ingestion",
  "module_status": { "eda": "pending", "ingestion": "in_progress" },
  "state_data": { "activeDataset": "calls.csv" }
}
```

`name` is a duplicate of `workflow_name`, kept so older screens keep working.
**Prefer `workflow_name`** in new code.

`state_data` is a free-form JSON blob for session resume — put UI state there
(selected columns, active dataset), **never file contents**.

### 3.5 Delete

`DELETE /v1/workflows/{workflow_id}` → **204**, no body.

---

## 4. Datasets — `/v2`

### 4.1 Upload

`POST /v2/workflows/{workflow_id}/files` · `multipart/form-data`

| Part | Type | Notes |
|---|---|---|
| `files` | file (repeatable) | Send the field name `files` once per file |
| `manifest` | string | JSON, as a **string** form field. Send `{}` to just land the bytes |

| Query param | Default | Meaning |
|---|---|---|
| `dry_run` | `false` | Validate + preview, **store nothing** |
| `overwrite` | `false` | Replace an existing filename instead of 409 |
| `preview_rows` | `100` | Rows returned per file (1–1000) |

Accepted extensions: `.csv` `.tsv` `.txt` `.xlsx` `.xlsm` `.xls`. Max 200 MB per file.

```js
const form = new FormData();
files.forEach((f) => form.append("files", f));
form.append("manifest", JSON.stringify({}));
await v2Upload(workflowId, form, { overwrite: true });
```

**201** (or **200** when `dry_run=true`)

```json
{
  "workflow_id": "af0a15ff-...",
  "dry_run": false,
  "files": [ /* dataset objects, each with a `preview` array */ ]
}
```

> **Recommended pattern: upload with an empty manifest.** Land the raw bytes
> first, read `columns` off the response to populate your dropdowns, then
> configure with `/preview` (§4.2). Configuring at upload time means the user is
> choosing column names before they've seen the columns.

**All-or-nothing.** Every file is validated before any is stored. If file 3
fails, files 1 and 2 are not written.

**A request-level manifest applies to every file.** This is the most common
mistake — a `date_formats` entry for `call_date` sent alongside a crosswalk file
that has no such column fails the whole request:

```json
{ "status": 422, "title": "Transformation failed",
  "detail": "Nothing was stored; the request was rolled back.",
  "errors": [ { "filename": "xwalk.csv", "column": "call_date",
                "code": "column_not_found",
                "message": "Column \"call_date\" is not present in the uploaded file." } ] }
```

Use per-file overrides (§5.7) or an empty manifest to avoid it.

### 4.2 Preview a manifest — the dry run

`POST /v2/workflows/{workflow_id}/files/{filename}/preview` · JSON body

Runs a manifest against the **stored raw bytes**. No re-upload, nothing written.
This is what the configuration UI calls.

Body is a manifest **without** the `files[]` key (see §5):

```json
{
  "config_metadata": { "category": "hcp_promo" },
  "live_updates": {
    "date_formats":   [{ "column": "call_date", "from": "%d-%m-%Y", "to": "%Y-%m-%d" }],
    "dtype_changes":  [{ "column": "calls", "to": "integer" }],
    "column_renames": [{ "from": "npi", "to": "provider_id" },
                       { "from": "call_date", "to": "date" }]
  },
  "filters": [{ "type": "npi_luhn", "column": "provider_id" }]
}
```

**200**

```json
{
  "filename": "calls.csv",
  "dry_run": true,
  "row_count": 3,
  "columns": ["provider_id", "date", "calls", "rep"],
  "preview": [
    { "provider_id": "1234567893", "date": "2026-01-04", "calls": 3, "rep": "R1" },
    { "provider_id": "1234567893", "date": "2026-02-11", "calls": 2, "rep": "R1" },
    { "provider_id": "1245319599", "date": "2026-01-04", "calls": 5, "rep": "R2" }
  ],
  "applied": {
    "column_renames": 2, "dtype_changes": 1, "date_formats": 1,
    "nulled_values": 0, "filters_applied": 1,
    "rows_in": 4, "rows_out": 3, "rows_removed": 1,
    "granularity_applied": false, "unhandled_columns": []
  }
}
```

`preview` rows are JSON-safe: `NaN`/`NaT` become `null`, decimals become
numbers. Safe to feed straight into a table.

### 4.3 Commit a manifest

`PATCH /v2/workflows/{workflow_id}/files/{filename}/spec` · JSON body

Same body as `/preview`, plus an optional `expected_version`. Persists the
manifest and **re-derives from the immutable raw bytes**.

```json
{ "config_metadata": {}, "live_updates": { }, "filters": [], "expected_version": 3 }
```

**200** — the full dataset object, with the manifest now stored in `spec` and a
bumped `version`.

**Because it re-derives from raw, editing is safe and idempotent.** Removing a
filter brings the rows back; re-adding it removes them again. There is no
accumulated state to undo, so your UI needs no "reset" affordance.

**Optimistic concurrency.** Send `expected_version` (from the dataset you read)
and a stale value gets **409**:

```json
{ "type": "https://beacon.api/problems/dataset",
  "title": "Version conflict", "status": 409,
  "detail": "\"calls.csv\" was modified by someone else (expected version 1, found 2). Re-read the dataset and retry." }
```

Omit `expected_version` to force last-write-wins. Send it if two tabs on one
workflow is plausible.

### 4.4 List datasets

`GET /v2/workflows/{workflow_id}/files` → **200**

```json
{ "workflow_id": "af0a15ff-...", "items": [ /* dataset objects, no preview */ ] }
```

#### The dataset object

| Field | Type | Notes |
|---|---|---|
| `filename` | string | The id within a workflow. Unique per workflow |
| `object_key` | string | Raw upload in the bucket. **Never rewritten** |
| `derived_key` | string | Transformed output. A rebuildable cache |
| `size_bytes` | int | Size of the **raw** upload |
| `checksum_sha256` | string | Of the raw bytes |
| `row_count` | int | Rows **after** the manifest — what the user sees |
| `columns` | string[] | Column names after renames |
| `applied` | object | See §6 |
| `spec` | object | The stored manifest. **Hydrate your form from this** |
| `derived_from` | object or null | Provenance for datasets the API derived from others. Always `null` here |
| `kind` | string | `"upload"` for everything this screen creates |
| `version` | int | Increments on every commit; use for `expected_version` |

`spec` is what makes the screen resumable: read it back and rebuild the form
controls. That is exactly what `DataIngestion.jsx` does on mount.

### 4.5 Profile the columns — how the form pre-fills itself

`GET /v2/workflows/{workflow_id}/files/{filename}/profile` → **200**

Describes the **raw upload** (not the derived output), because the form
configures against the file as it arrived. Also returned inline as `profile` on
each file in the upload response, so the drop → configure path needs no second
call.

```json
{
  "filename": "prof.csv",
  "row_count_sampled": 3,
  "columns": ["npi", "call_date", "amount", "active", "notes"],
  "profile": [
    {
      "column": "call_date",
      "non_null": 3,
      "null_count": 0,
      "unique_count": 3,
      "samples": ["04-01-2026", "15-03-2026", "28-02-2026"],
      "date_candidates": [
        { "format": "%d-%m-%Y", "match_rate": 1.0 }
      ],
      "ambiguous_date": false,
      "suggested_dtype": "date",
      "suggested_date_from": "%d-%m-%Y",
      "suggested_date_to": "%Y-%m-%d"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `samples` | Up to 3 distinct values — show these next to the column |
| `null_count` / `non_null` / `unique_count` | Counts over the sampled rows |
| `date_candidates` | Candidate formats, best first. **Empty means it isn't a date** |
| `ambiguous_date` | `true` when two or more formats fit equally well |
| `ambiguous_between` | Present only when ambiguous: the tied formats |
| `suggested_dtype` | `string` `integer` `float` `boolean` `date` |
| `suggested_date_from` / `_to` | Pre-fill values for the date controls |
| `id_like` | `true` for NPI/ZIP/ID-ish names — kept as `string` so leading zeros survive |

#### How to use it

1. **Show `suggested_dtype` as the selected value in every type dropdown.**
   There is no "leave as-is" option — the form states what each column will be,
   and the user edits it if that's wrong. Highlight any control they change so
   an override is visible at a glance.
2. **Show the date-format controls only where `date_candidates` is non-empty**
   (or where the user has picked `date`/`timestamp` by hand). That's the answer
   to "which columns get a Date Formatting option".
3. **Pre-select `suggested_date_from`**, so the common case is a glance and a
   confirmation, not a decision.
4. **Populate that dropdown from `date_candidates`**, not the full format list —
   only formats that actually fit this column.
5. **When `ambiguous_date` is true, leave the control empty and flag it.**
   `04-01-2026` fits both `%d-%m-%Y` and `%m-%d-%Y` perfectly; only the person
   who owns the file knows which. Guessing here is the original bug.

#### Turning the form back into a manifest

Showing a type for every column does **not** mean sending a cast for every
column. Two entries must be dropped when you serialise:

| Selected type | Emit `dtype_changes`? | Why |
|---|---|---|
| `string` | **no** | The file is read as text, so this is already the resting state — the cast is a no-op |
| `date` / `timestamp` | **never** | A cast to `date` falls back to per-value `to_datetime` **inference**. Date conversion belongs solely to `date_formats`, which carries an explicit `from` |
| anything else | yes | A real conversion |

That second rule matters most on ambiguous columns: they're intentionally left
without a `date_formats` entry, so emitting `{"to": "date"}` would hand exactly
those values back to the guesser. See `client/src/pages/DataIngestion.jsx` →
`draftToSpec()`.

#### How detection works

Whether a column *is* a date uses the **same rule as the pre-v2 ingestion
screen** (`processing.detect_date_columns_by_sampling`), so the set of columns
offered date controls is unchanged from what users saw before:

- sample up to **200 rows**
- ignore values shorter than **6 characters**
- it's a date if any of these eight formats parses **≥ 80%** of what remains:
  `%d/%m/%Y` `%Y/%m/%d` `%Y/%d/%m` `%m/%d/%Y` `%m-%d-%Y` `%d-%m-%Y` `%Y-%d-%m` `%Y-%m-%d`

A parity test (`python/tests/test_detection_parity.py`) asserts the profiler
flags exactly the same columns as the original function.

**Detection and format-choice are separate concerns.** Detection was never the
source of the day/month transposition bug — that came from *parsing* with
`dayfirst=True` inference at transform time. So detection is unchanged, and only
the parsing is now explicit. Once a column is detected, `date_candidates` ranks
which formats could have produced those values, for pre-filling `from`.

> **The suggestion is a UI default, never a server-side inference.** The
> manifest still carries an explicit `from`, and the transform engine still
> refuses to guess. The difference is that a human saw the value before it was
> applied. `profile` is a hint for the form, not a validation — the
> authoritative check is `/preview`.

Profiling the raw bytes means the result never changes, so it is safe to cache
per filename for the session.

### 4.6 Get as CSV — transitional

`GET /v2/workflows/{workflow_id}/files/{filename}/csv` → **200**, `text/csv`

```csv
provider_id,date,calls,rep,dma_id,dma_name
1234567893,2026-01-04,3,R1,501,New York
1234567893,2026-02-11,2,R1,501,New York
1245319599,2026-01-04,5,R2,803,Los Angeles
```

> ⚠️ **Deliberately temporary.** It exists only because EDA and the screens after
> it still take a `csv_data` string. Call it **once**, at the handoff, and pass
> the result straight into context — never store it in `localStorage`. It
> disappears when those routers resolve datasets by id.

### 4.7 Delete

`DELETE /v2/workflows/{workflow_id}/files/{filename}` → **204**, no body.
Removes the row and both objects. Not recoverable — confirm first.

### 4.8 Detect granularity

`POST /v2/workflows/{workflow_id}/files/{filename}/detect-granularity`

Backs the **Detect Granularity** button. Answers "what grain is this column
already at?" so the form can offer only coarser targets. Nothing is stored.

Send the draft manifest so far, so detection reads the dates as the user has
configured them rather than as raw text:

```json
{ "date_column": "week_end_date",
  "live_updates": { "date_formats": [ ... ], "column_renames": [ ... ] },
  "filters": [ ... ] }
```

`date_column` is the **post-rename** name. `live_updates` and `filters` are
optional; omit them to detect against the raw file.

**200**

```json
{ "filename": "calls.csv",
  "date_column": "week_end_date",
  "granularity": "Weekly",
  "distinct_dates": 3,
  "min_date": "2026-01-04",
  "max_date": "2026-01-18" }
```

`granularity` is `Daily`, `Weekly`, `Monthly` or `Yearly`. Feed it straight into
`granularity.from` and offer only coarser values for `to`:

| Detected | Offer as target |
|---|---|
| `Daily` | Weekly, Monthly |
| `Weekly` | Monthly |
| `Monthly` | Yearly |

Two failure modes, both **422** — show the message and keep the user on the tab:

| `code` | Means |
|---|---|
| `date_parse_failed` | Nothing in the column parses as a date — set its source format on Columns & Types first |
| `granularity_undetectable` | Fewer than two distinct dates to compare |

> Detection uses the same rule as the pre-v2 screen: gaps between consecutive
> distinct dates, with weekly/monthly/yearly bands. It reads the column through
> the format `date_formats` wrote, so a column reformatted to `%d/%m/%Y` is
> still understood.


## 5. The manifest

One declarative document describing everything done to a file. It is the
**source of truth**: raw bytes are stored once, and the output is derived by
replaying this.

```json
{
  "config_metadata": { "category": "hcp_promo" },
  "live_updates": { "date_formats": [], "dtype_changes": [], "column_renames": [] },
  "filters": [],
  "granularity": null,
  "files": []
}
```

Every key is optional. `{}` is valid and means "store as-is".

### Order of operations — read this before building the form

```
live_updates  →  filters  →  granularity
   ├─ 1. column_drops     ← drops land FIRST
   ├─ 2. date_formats
   ├─ 3. dtype_changes
   └─ 4. column_renames   ← renames land LAST
```

Two consequences your UI must reflect:

1. **Everything inside `live_updates` names columns as they appear in the file.**
   A `dtype_changes` entry uses the *original* name even if you're also renaming
   that column.
2. **`filters` and `granularity` name columns as they appear *after* renames.**

Get this backwards and you get `column_not_found`. In `DataIngestion.jsx` this is
handled by `columnsAfterRenames()`, which feeds the filter and granularity
column pickers.

> **Unknown keys are rejected.** The schema is strict (`extra="forbid"`), so a
> typo like `column_rename` (singular) returns 422 rather than being silently
> ignored. This is deliberate — it means a malformed manifest can never quietly
> do nothing.

### 5.1 `live_updates.column_drops`

Columns to discard, named as they appear in the **uploaded** file. Backs the
**Keep** checkbox on the Columns & Types tab — an unchecked row becomes an entry
here.

```json
{ "column_drops": ["NOTES", "internal_ref"] }
```

Applied **first**, before every other operation, so nothing downstream sees a
dropped column. Two rules the form must respect:

| Situation | Result |
|---|---|
| A dropped column is also renamed / cast / date-formatted | **422** `column_dropped` |
| Every column dropped | **422** `all_columns_dropped` |

Omit the key (or send `[]`) to keep everything. `applied.columns_dropped`
reports how many went.

### 5.2 `live_updates.date_formats`

```json
{ "column": "call_date", "from": "%d-%m-%Y", "to": "%Y-%m-%d" }
```

| Field | Required | Notes |
|---|---|---|
| `column` | **yes** | Pre-rename name |
| `from` | **yes** | The format the file actually uses |
| `to` | **yes** | Output format |

> **`from` is mandatory and never inferred.** This is the single most important
> rule in the API. Inferring a date format is what silently transposed day and
> month for every day-of-month ≤ 12 — `2026-02-04` became `2026-04-02` with no
> error. Make the source format an explicit, required dropdown in your UI — but pre-fill it from `/profile` (§4.5) so the user usually just confirms.

Common `strftime` patterns to offer:

| Pattern | Example |
|---|---|
| `%Y-%m-%d` | `2026-03-15` |
| `%d/%m/%Y` | `15/03/2026` |
| `%m/%d/%Y` | `03/15/2026` |
| `%d-%m-%Y` | `15-03-2026` |
| `%m-%d-%Y` | `03-15-2026` |
| `%Y/%m/%d` | `2026/03/15` |
| `%d.%m.%Y` | `15.03.2026` |
| `%Y%m%d` | `20260315` |
| `%Y-%m-%d %H:%M:%S` | `2026-03-15 13:45:00` |

A value that doesn't match fails the whole request and names the value and row.
Blank cells are allowed and become `null`.

### 5.3 `live_updates.dtype_changes`

```json
{ "column": "amount", "to": "decimal", "precision": 18, "scale": 2, "on_error": "fail" }
```

| Field | Required | Default | Notes |
|---|---|---|---|
| `column` | **yes** | — | Pre-rename name |
| `to` | **yes** | — | See below |
| `precision` | no | — | `decimal` only, cosmetic |
| `scale` | no | — | **Required when `to` is `decimal`** |
| `on_error` | no | `"fail"` | `fail` \| `null_out` |

`to` accepts: `string` · `integer` · `bigint` · `float` · `decimal` · `boolean` ·
`date` · `timestamp`

- **`boolean`** accepts `true/1/yes/y/t` and `false/0/no/n/f`, case-insensitive.
- **`on_error: "null_out"`** replaces unconvertible values with `null` instead of
  failing, and counts them in `applied.nulled_values`. Good UX: on a
  `cast_failed` error, offer this as a one-click alternative.

### 5.4 `live_updates.column_renames`

```json
{ "from": "npi", "to": "provider_id" }
```

Renaming onto a name that survives, or two renames onto the same target, is
rejected as `rename_collision` — a duplicate-header bug caught before it happens.

### 5.5 `filters`

An array of typed objects, applied in order and combined with **AND**. All
`column` values are post-rename.

| `type` | Extra fields | Keeps rows where |
|---|---|---|
| `npi_luhn` | — | The NPI passes the official CMS Luhn checksum |
| `date_range` | `start`, `end` (`YYYY-MM-DD`, ≥1 required, inclusive) | The date falls in range |
| `value_in` | `values[]` (≥1) | The value is in the list |
| `value_not_in` | `values[]` (≥1) | The value is not in the list |
| `range` | `min`, `max` (≥1 required, inclusive) | The number falls in range |
| `not_null` | — | The cell is non-empty |

```json
[
  { "type": "npi_luhn", "column": "provider_id" },
  { "type": "date_range", "column": "date", "start": "2026-01-01", "end": "2026-03-31" },
  { "type": "value_in", "column": "region", "values": ["East", "West"] },
  { "type": "range", "column": "spend", "min": 100 }
]
```

`date_range` bounds are **ISO `YYYY-MM-DD` only** — the same no-guessing rule as
`date_formats`. An `<input type="date">` gives you this natively.

**`npi_luhn` has a safety net:** if *no* value in the column is a valid NPI it
errors with `npi_luhn_no_matches` instead of silently returning zero rows. Show
that message — it almost always means the wrong column was picked.

### 5.6 `granularity`

Rolls rows up to a coarser period. `null` or omitted means no rollup.

```json
{
  "from": "Daily",
  "to": "Monthly",
  "date_column": "date",
  "geo_column": "provider_id",
  "numeric": { "calls": "sum", "spend": "sum" },
  "categorical": { "region": "first" }
}
```

| Field | Required | Notes |
|---|---|---|
| `from` | **yes** | `Daily` · `Weekly` · `Monthly` |
| `to` | **yes** | `Weekly` · `Monthly` · `Yearly` — must be **coarser** than `from` |
| `date_column` | **yes** | Post-rename |
| `geo_column` | **yes** | Post-rename. Grouping is `geo × period` |
| `numeric` | no | `{column: op}` — `sum` `average` `min` `max` `product` |
| `categorical` | no | `{column: op}` — `first` `last` `count` `distinct_count` `mode` |

Output rows are stamped with the **first day of the period** (weekly rolls to
Monday).

> **Columns you don't assign an operation are dropped by the rollup.** They come
> back in `applied.unhandled_columns` so you can warn *before* the user applies.
> Surface this prominently — it was a silent data-loss bug in the previous
> implementation. `DataIngestion.jsx` highlights those rows amber and shows a
> banner.

### 5.7 `files` — per-file overrides (upload only)

Only valid on `POST .../files`. Not accepted by `/preview` or `/spec`, which are
already scoped to one file.

```json
{
  "live_updates": { "column_renames": [{ "from": "npi", "to": "id" }] },
  "filters": [{ "type": "not_null", "column": "id" }],
  "files": [
    { "filename": "xwalk.csv",
      "live_updates": { "column_renames": [{ "from": "npi", "to": "id" }] },
      "filters": [] }
  ]
}
```

**An override replaces its key entirely — it never merges.** Above, `xwalk.csv`
gets its own renames and *no* filters. That's the only way to express "this file
has no filters" when a request-level filter exists.

Referencing a filename that wasn't uploaded is a 422 (`file_not_uploaded`) — a
typo can't silently fall back to the request-level block.

---

## 6. `applied` — what actually happened

Returned by `/preview`, upload, and `/spec`. Built for showing the user the
consequences of their configuration.

| Field | Type | Meaning |
|---|---|---|
| `rows_in` | int | Rows read from the raw file |
| `rows_out` | int | Rows after everything |
| `rows_removed` | int | `rows_in − rows_out` |
| `date_formats` | int | Date columns reformatted |
| `dtype_changes` | int | Columns cast |
| `column_renames` | int | Columns renamed |
| `nulled_values` | int | Cells nulled by `on_error: "null_out"` |
| `filters_applied` | int | Filters that ran |
| `granularity_applied` | bool | Whether a rollup ran |
| `unhandled_columns` | string[] | **Columns the rollup dropped** — warn on this |

Good things to put on screen: `rows_out` as the headline, `rows_removed` next to
it (users are rightly nervous about disappearing rows), and
`unhandled_columns` as a warning banner whenever it's non-empty.

---

## 7. Client helpers

`client/src/services/api.js` wraps all of the above:

```js
// Workflow Creation screen
v1CreateWorkflow(payload)          v1ListWorkflows()
v1GetWorkflow(id)                  v1PatchWorkflow(id, payload)
v1DeleteWorkflow(id)

// Data Ingestion screen
v2Upload(workflowId, formData, { dryRun, overwrite })
v2Preview(workflowId, filename, spec)
v2CommitSpec(workflowId, filename, spec)
v2ListFiles(workflowId)            v2GetProfile(workflowId, filename)
v2DeleteFile(workflowId, filename) v2DetectGranularity(workflowId, filename, body)
v2GetCsv(workflowId, filename)     // transitional - EDA handoff only

// Errors
problemMessage(err, fallback)      // problem+json → a string for a toast
```

Filenames are `encodeURIComponent`-ed for you.

---

## 8. Building the screen — practical notes

**Keep the manifest in local state; don't call the API per control.** The four
config tabs should mutate one draft object. Only **Preview** and **Apply** touch
the network. `draftToSpec()` in `DataIngestion.jsx` is the serializer.

**Invalidate the preview when the draft changes.** A preview describes one exact
manifest. The moment the user edits a control, the shown result is stale — clear
it rather than leaving a number on screen that no longer matches the form.

**Hydrate from `spec`, not from local storage.** On mount, `GET .../files` and
rebuild each draft from `item.spec`. The server is the source of truth, so a
refresh, a different browser, and a resumed workflow all behave identically.

**Gate Apply on a clean preview** — it's free, and it removes the need for
optimistic-save UI.

**Never put CSV text in `localStorage`.** It's megabytes, the ~5 MB quota fails
silently, and it takes the whole session with it. Keep ids.

**Show `rows_removed` whenever it's non-zero**, and `unhandled_columns` whenever
it's non-empty. Both are cases where the user's data changed in a way they may
not have intended.

**Two 409s mean different things.** On upload it's a duplicate filename — offer
"replace?" and retry with `overwrite=true`. On `/spec` it's a version conflict —
re-fetch and tell the user someone else changed it.

---

## 9. Interactive exploration

FastAPI serves Swagger UI at **`http://127.0.0.1:8000/docs`** with every endpoint
above, live. Useful for checking a response shape without writing code.

Health check — probes the database and bucket for real:

```json
{ "status": "ok",
  "database": { "configured": true, "ok": true },
  "storage": { "ok": true, "bucket": "data", "prefix": "beacon" } }
```

`status` is `"degraded"` if either dependency is down. A `503` from any `/v2`
endpoint means credentials are missing — check here first.
