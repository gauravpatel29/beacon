# Beacon — Frontend API Guide

Everything the UI needs to talk to the backend. Base URL in development is
`http://127.0.0.1:8100`, and every path below is prefixed **`/v1`**.

There are two APIs:

1. **Workflow Creation** — backs the *Create New Workflow* button and its form.
2. **Object Storage** — backs the file-upload screen and everything after it.

> **No authentication yet.** Send no auth headers. When auth arrives it will be
> an added header, not a change to any path or body below.

---

## 1. Workflow Creation

### Endpoints

| Method | Path | Headers | Body | Success response |
|---|---|---|---|---|
| `POST` | `/v1/workflows` | `Content-Type: application/json` | `{ "workflow_name": "Q3 Revenue Ingest", "state": "new", "tag": "finance" }` | **201** `{ "id": "3f8a1c2e-9b4d-4e77-a1f2-6c5d8e0b7a13", "workflow_name": "Q3 Revenue Ingest", "state": "new", "tag": "finance" }` |
| `GET` | `/v1/workflows` | — | — | **200** `{ "items": [ …workflow… ], "next_cursor": null }` |
| `GET` | `/v1/workflows/{workflow_id}` | — | — | **200** one workflow object |
| `PATCH` | `/v1/workflows/{workflow_id}` | `Content-Type: application/json` | `{ "state": "configured" }` | **200** the updated workflow |
| `DELETE` | `/v1/workflows/{workflow_id}` | — | — | **204** no body |

### The create form

| Form field | JSON field | Required | Default | Rules |
|---|---|---|---|---|
| Workflow Name | `workflow_name` | **yes** | — | 1–200 chars. Whitespace is trimmed; whitespace-only is rejected |
| State | `state` | no | `"new"` | One of `new`, `configured`, `running`, `complete`, `failed` |
| Tag | `tag` | no | `null` | Max 100 chars. Omit the key, or send `null` |

Send only what the user filled in — omitting `state` and `tag` is valid:

```json
{ "workflow_name": "Q3 Revenue Ingest" }
```

### What to do with the response

The `id` is the **only** thing you need to keep. Every upload call is scoped to
it, and it is also the storage folder name. Store it in component state as
soon as the 201 lands and carry it to the upload screen.

> **Disable the Create button until the response arrives.** The backend has no
> duplicate protection — two clicks create two workflows and two storage
> folders.

### List, filter, paginate

`GET /v1/workflows` accepts:

| Query param | Meaning |
|---|---|
| `state` | Exact match |
| `tag` | Exact match |
| `q` | Case-insensitive substring of `workflow_name` |
| `limit` | 1–200, default 50 |
| `cursor` | Pass back the `next_cursor` from the previous page |

`next_cursor` is `null` on the last page — that is your "no more results"
signal. Do not construct cursors yourself; they are opaque.

### Update and delete

`PATCH` accepts any subset of `workflow_name`, `state`, `tag`. Two cases the UI
must distinguish:

- **Leave the tag alone** → omit the `tag` key entirely.
- **Clear the tag** → send `{ "tag": null }` explicitly.

`DELETE` returns **409** if the workflow still owns uploaded files. That is
deliberate. To delete anyway, re-send with `?purge_objects=true`, which also
deletes every stored file. Surface this as a confirmation step —
"This workflow has 3 files. Delete them too?"

---

## 2. Object Storage

### Endpoints

| Method | Path | Headers | Body | Success response |
|---|---|---|---|---|
| `POST` | `/v1/workflows/{workflow_id}/files` | `Content-Type: multipart/form-data` | parts: `manifest` (JSON string) + `files` (one or more) | **201** `{ "workflow_id": "…", "files": [ …stored file… ] }` |
| `GET` | `/v1/workflows/{workflow_id}/files` | — | — | **200** `{ "items": [ … ] }` |
| `GET` | `/v1/workflows/{workflow_id}/files/{filename}` | — | — | **200** file metadata **+ `download_url`** |
| `PUT` | `/v1/workflows/{workflow_id}/files/{filename}` | `Content-Type: multipart/form-data` | parts: `manifest` + `file` (single) | **200** the replaced file |
| `DELETE` | `/v1/workflows/{workflow_id}/files/{filename}` | — | — | **204** no body |
| `GET` | `/v1/workflows/{workflow_id}/files/{filename}/config` | — | — | **200** `{ "config_metadata": {…}, "live_updates": {…} }` |
| `PATCH` | `/v1/workflows/{workflow_id}/files/{filename}/config` | `Content-Type: application/json` | `{ "config_metadata": {…} }` | **200** the updated config |

### The upload request

This is **not** a JSON request. It is `multipart/form-data` with two kinds of
part:

- **`manifest`** — exactly one part, a JSON **string**
- **`files`** — one or more file parts, all using the field name `files`

```js
const form = new FormData();
form.append("manifest", JSON.stringify(manifest));   // note: stringified
for (const file of selectedFiles) {
  form.append("files", file, file.name);             // same field name each time
}

const res = await fetch(`/v1/workflows/${workflowId}/files`, {
  method: "POST",
  body: form,          // do NOT set Content-Type yourself
});
```

> Let the browser set `Content-Type` — it has to add the multipart boundary.
> Setting it manually is the single most common cause of a 400 here.

Accepted extensions: `.csv`, `.tsv`, `.txt`, `.xlsx`, `.xlsm`. Max 200 MB per
file.

### The manifest

One JSON object covering the whole request:

```json
{
  "config_metadata": {
    "source_system": "SAP",
    "refresh": "daily",
    "owner": "finance-ops"
  },
  "live_updates": {
    "date_formats": [
      { "column": "txn_date", "from": "%d-%m-%Y", "to": "%Y-%m-%d" }
    ],
    "dtype_changes": [
      { "column": "amount", "to": "decimal", "precision": 18, "scale": 2 }
    ],
    "column_renames": [
      { "from": "cust_id", "to": "customer_id" }
    ]
  }
}
```

**`config_metadata`** is whatever your configuration form collects. It is free
-form — any JSON object. The backend stores it untouched and never interprets
it.

**`live_updates`** is the structural changes. All three keys are optional;
omit any you don't need, or send `"live_updates": {}` for none.

### live_updates operation shapes

| Operation | Shape | Notes |
|---|---|---|
| `column_renames` | `{ "from": "cust_id", "to": "customer_id" }` | Both required |
| `dtype_changes` | `{ "column": "amount", "to": "decimal", "precision": 18, "scale": 2, "on_error": "fail" }` | `precision`/`scale` for `decimal` only; `scale` is **required** for decimal |
| `date_formats` | `{ "column": "txn_date", "from": "%d-%m-%Y", "to": "%Y-%m-%d" }` | strptime/strftime patterns |

`to` for a dtype change is one of: `string`, `integer`, `bigint`, `float`,
`decimal`, `boolean`, `date`, `timestamp`.

`on_error` is `fail` (default — one bad value rejects the whole upload) or
`null_out` (bad values become null, and the response counts them). Offer this
as a checkbox: *"Replace values that can't be converted with blanks."*

### Two rules that will bite you

**1. Every operation names the column as it appears in the uploaded file.**

Operations run in a fixed order — `date_formats` → `dtype_changes` →
`column_renames` — with renames applied **last**. So if you rename `cust_id` to
`customer_id` *and* want to change its type, the dtype change must still say
`"column": "cust_id"`. Naming `customer_id` fails with `column_not_found`.

Build your form against the **original** header row you parsed from the file,
and never against the renamed values.

**2. Per-file settings replace, they do not merge.**

By default the request-level `config_metadata` and `live_updates` apply to
*every* file in the request. For per-file settings, add a `files` array:

```json
{
  "config_metadata": { "source_system": "SAP" },
  "live_updates": { "column_renames": [{ "from": "cust_id", "to": "customer_id" }] },
  "files": [
    {
      "filename": "orders.csv",
      "live_updates": { "date_formats": [{ "column": "dt", "from": "%d/%m/%Y", "to": "%Y-%m-%d" }] }
    }
  ]
}
```

Here `orders.csv` gets **only** the date format — it does **not** inherit the
rename. A `filename` that doesn't match an uploaded part is a 422.

### The upload response

```json
{
  "workflow_id": "3f8a1c2e-9b4d-4e77-a1f2-6c5d8e0b7a13",
  "files": [
    {
      "filename": "sales_2024.csv",
      "object_key": "3f8a1c2e-…/sales_2024.csv",
      "size_bytes": 184320,
      "content_type": "text/csv",
      "checksum_sha256": "9f2c…",
      "stored_at": "2026-09-08T11:15:01Z",
      "row_count": 4821,
      "columns": ["customer_id", "amount", "txn_date"],
      "sidecars": {
        "config_metadata": "3f8a1c2e-…/_log.json",
        "live_updates": "3f8a1c2e-…/_struct_updates.json"
      },
      "applied": {
        "column_renames": 1, "dtype_changes": 1,
        "date_formats": 1, "nulled_values": 0
      }
    }
  ]
}
```

Show the user `columns` and `applied` after a successful upload — `columns` is
the **final** header after renames, so it confirms what actually landed rather
than what was requested. If `applied.nulled_values` is above zero, warn them:
that many values were unconvertible and became blank.

### What gets stored

```
data/
  3f8a1c2e-9b4d-4e77-a1f2-6c5d8e0b7a13/
    sales_2024.csv          the transformed file
    orders.csv              another transformed file
    _log.json               ONE per workflow — all config_metadata
    _struct_updates.json    ONE per workflow — all live_updates
```

There is exactly **one** `_log.json` and **one** `_struct_updates.json` per
workflow folder, no matter how many files. Both are keyed by filename:

```json
{
  "workflow_id": "3f8a1c2e-…",
  "updated_at": "2026-09-08T11:15:01Z",
  "files": {
    "sales_2024.csv": { "source_system": "SAP", "refresh": "daily" },
    "orders.csv":     { "source_system": "CRM" }
  }
}
```

They accumulate — uploading a second file adds an entry rather than replacing
the first. Deleting a file removes only its entry.

### Downloading

The bucket is private, so `GET /v1/workflows/{id}/files/{filename}` does not
return bytes. It returns metadata plus a short-lived signed URL:

```json
{
  "filename": "sales_2024.csv",
  "download_url": "https://…?X-Amz-Signature=…",
  "download_url_expires_at": "2026-09-08T11:30:01Z"
}
```

Fetch a fresh URL each time the user clicks download. **Do not cache it** — it
expires in 15 minutes.

### Editing configuration after upload

`PATCH /…/files/{filename}/config` accepts `config_metadata` **only**. It
rejects `live_updates` with a 422, by design: those describe a transformation
already baked into the stored file, so editing the record alone would make it
lie about the data. To change structure, re-upload the file with `PUT`.

---

## Errors

Every error uses `Content-Type: application/problem+json` with this shape:

```json
{
  "type": "https://beacon.api/problems/transform-failed",
  "title": "Transformation failed",
  "status": 422,
  "detail": "No object was written; the request was rolled back.",
  "instance": "/v1/workflows/3f8a1c2e-…/files",
  "errors": [
    {
      "filename": "sales_2024.csv",
      "column": "cust_idd",
      "code": "column_not_found",
      "message": "Column \"cust_idd\" is not present in the uploaded file."
    }
  ]
}
```

Render `title` as the headline and, when `errors` is present, list each entry —
those are the actionable, per-field messages. `errors[].pointer` (on validation
failures) is a JSON Pointer into what you sent, e.g. `/workflow_name`.

| Status | Meaning | What the UI should do |
|---|---|---|
| `400` | Malformed request | Usually a bug — check the manifest is a JSON *string* and that you didn't set `Content-Type` |
| `404` | Workflow or file not found | The workflow may have been deleted in another tab; refresh |
| `409` | Conflict | Filename already exists → offer "Replace?" (`?overwrite=true`). On workflow delete → offer "Delete files too?" (`?purge_objects=true`) |
| `413` | File too large | Limit is 200 MB — validate before uploading |
| `415` | Unsupported file type | Restrict the file picker to the accepted extensions |
| `422` | Validation or transformation failed | Show `errors[]` inline against the offending field or column |

### Uploads are all-or-nothing

If any file in a multi-file upload fails, **nothing** is stored — not even the
files that succeeded. Report the whole request as failed and let the user
correct and retry. Never show partial success.

---

## Suggested screen flow

1. **Create Workflow** — form → `POST /v1/workflows` → keep `id`.
2. **Upload** — file picker; parse the header row client-side to populate the
   column dropdowns in the transformation builder.
3. **Configure** — config form (free-form → `config_metadata`) plus three
   grids for renames, dtype changes and date formats (→ `live_updates`).
   Every column dropdown lists **original** column names.
4. **Review** — show the manifest you're about to send.
5. **Submit** — `POST …/files`; on 201 show `columns` and `applied`; on 422
   map `errors[].column` back to the offending grid row.
6. **Manage** — list files, download via signed URL, delete, or edit
   `config_metadata`.
