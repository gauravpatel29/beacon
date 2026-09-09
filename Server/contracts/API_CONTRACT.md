# Beacon API Contract

Source of truth: [openapi.yaml](openapi.yaml). This document explains the
decisions behind it — read it before implementing either side.

Base path: `/v1`. All request and response bodies are JSON except the upload
endpoints, which are `multipart/form-data`. Errors use
`application/problem+json` ([RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)).

---

## Contract 1 — Workflow creation

Backs the **Create New Workflow** button and its form.

### Form → API mapping

| Form field | JSON field | Required | Default | Notes |
|---|---|---|---|---|
| Workflow Name | `workflow_name` | yes | — | Trimmed; blank rejected |
| State | `state` | no | `"new"` | Open value set, see below |
| Tag | `tag` | no | `null` | Optional |

### Create

```http
POST /v1/workflows
Content-Type: application/json

{ "workflow_name": "Q3 Revenue Ingest", "state": "new", "tag": "finance" }
```

```http
201 Created
Location: /v1/workflows/3f8a1c2e-...

{
  "id": "3f8a1c2e-9b4d-4e77-a1f2-6c5d8e0b7a13",
  "workflow_name": "Q3 Revenue Ingest",
  "state": "new",
  "tag": "finance"
}
```

The `id` in that response is what the frontend uses for every upload call —
it is also the storage folder name.

> **No idempotency protection.** A double-clicked Create button will create
> two workflows, and therefore two storage folders. Guard it on the frontend
> by disabling the button until the response lands. Adding an
> `Idempotency-Key` header later is additive and would not break this contract.

### Why `state` is `text`, not an enum

You said more states arrive later. A Postgres `enum` would need a migration
for each new value; `text` plus an application-level allowlist needs a code
change only. The DDL enforces only non-blankness. The allowlist lives next to
`WorkflowState` in the spec.

### Full CRUD surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/workflows` | Create |
| `GET` | `/v1/workflows` | List — filter by `state`, `tag`, `q`; cursor paginated |
| `GET` | `/v1/workflows/{id}` | Read one |
| `PATCH` | `/v1/workflows/{id}` | Partial update; `tag: null` clears |
| `DELETE` | `/v1/workflows/{id}` | Delete; `?purge_objects=true` to remove stored files too |

`DELETE` without `purge_objects` returns **409** when the workflow still owns
objects. That is deliberate: silently orphaning files in the bucket leaves
storage nobody can reach through the API, since the only route to an object is
through its workflow id.

### Table

See [../migrations/001_create_workflow.sql](../migrations/001_create_workflow.sql).
Four columns exactly, as specified:

```sql
create table workflow (
    id            uuid primary key default gen_random_uuid(),
    workflow_name text not null,
    state         text not null default 'new',
    tag           text
);
```

`gen_random_uuid()` is built into Postgres 13+; this branch runs 18.6, so no
extension is needed.

> **Recommendation, not implemented:** there is no `created_at`. You asked for
> four columns and I kept to that, but without a timestamp the list endpoint
> has no stable sort key and cursor pagination has to fall back to ordering by
> `id`, which is random for UUIDs. Adding `created_at timestamptz not null
> default now()` would fix both. Say the word and I'll add it.

---

## Contract 2 — Object storage

### Storage layout

Bucket `data` already exists and is **private**. One folder per workflow:

```
data/
  3f8a1c2e-9b4d-4e77-a1f2-6c5d8e0b7a13/
    sales_2024.csv          ← transformed data file
    orders.csv              ← another data file
    _log.json               ← ONE per workflow: config_metadata
    _struct_updates.json    ← ONE per workflow: live_updates
```

Exactly **one** `_log.json` and **one** `_struct_updates.json` per workflow
folder, whatever the file count. Both share an envelope keyed by filename:

```json
{
  "workflow_id": "3f8a1c2e-...",
  "updated_at": "2026-09-08T11:15:01Z",
  "files": {
    "sales_2024.csv": { "source_system": "SAP", "refresh": "daily" },
    "orders.csv":     { "source_system": "CRM" }
  }
}
```

They **accumulate**: a second upload adds an entry rather than replacing the
first file's. Deleting a file drops its entry and leaves the sidecar objects
in place, since other files still have entries in them.

> **Concurrency caveat.** Merging into a shared object is a read-modify-write,
> and object storage has no compare-and-set. Two uploads to the *same
> workflow* at the same instant can lose one entry. Uploads to different
> workflows never contend.

### Upload

```http
POST /v1/workflows/{workflow_id}/files
Content-Type: multipart/form-data; boundary=...
```

Two kinds of part:

- `manifest` — exactly one, `application/json`
- `files` — one or more file parts

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

Request-level `config_metadata` / `live_updates` apply to every file in the
request. To differ per file, add a `files` array; an entry there **replaces**
the request-level blocks for that filename rather than merging with them —
merging two partial transformation sets produces surprises.

### Why multipart, and not a presigned upload

The usual pattern for private buckets is: server hands out a presigned URL,
browser uploads straight to storage. That cannot work here. Your requirement is
that `live_updates` are applied *before* the file is saved, and a presigned
upload goes browser → bucket without the backend ever seeing the bytes. The
file must pass through the API for the transformation to happen at all.

Downloads have no such constraint, so `GET` returns a short-lived presigned URL
instead of streaming bytes through the API.

### Operation order

This is the part most likely to cause bugs, so the contract fixes it:

```
date_formats  →  dtype_changes  →  column_renames
```

**Every operation names columns as they appear in the uploaded file.** Renames
are applied last, so no operation ever has to refer to a name produced by
another operation. Without this rule, `{"from": "cust_id", "to": "customer_id"}`
combined with `{"column": "customer_id", "to": "string"}` is ambiguous — does
the dtype change run before or after the rename? Here it is unambiguous: that
dtype change would fail, because `customer_id` does not exist in the upload.

Date handling runs first because a date column arriving as text must be
reformatted while still text; casting to `date` first would discard the source
format.

### Atomicity

A request is all-or-nothing. Validation runs against each file's real header
row before any object is written, and if any file fails, objects already
written by that request are removed. Object storage has no transactions, so
this is compensating cleanup, not a rollback — but the visible outcome is that
you never get a data file with no sidecar entry, or three files stored out of
four.

### File CRUD surface

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/workflows/{id}/files` | Upload + transform + store. `?overwrite=` |
| `GET` | `/v1/workflows/{id}/files` | List objects. `?include_sidecars=` |
| `GET` | `/v1/workflows/{id}/files/{filename}` | Metadata + presigned download URL |
| `PUT` | `/v1/workflows/{id}/files/{filename}` | Re-upload one file, re-run transforms |
| `DELETE` | `/v1/workflows/{id}/files/{filename}` | Delete file; drops its entry from both sidecars |
| `GET` | `/v1/workflows/{id}/files/{filename}/config` | Read this file's slice of both sidecars |
| `PATCH` | `/v1/workflows/{id}/files/{filename}/config` | Update `config_metadata` only |

`PATCH .../config` accepts `config_metadata` but **not** `live_updates`.
`config_metadata` is descriptive, so editing it is harmless.
`live_updates` describes a transformation already baked into the stored bytes —
editing the sidecar alone would leave it lying about the data. Structural
change means re-uploading through `PUT`.

### Upload response

```json
{
  "workflow_id": "3f8a1c2e-...",
  "files": [
    {
      "filename": "sales_2024.csv",
      "object_key": "3f8a1c2e-.../sales_2024.csv",
      "size_bytes": 184320,
      "content_type": "text/csv",
      "checksum_sha256": "9f2c...",
      "row_count": 4821,
      "columns": ["customer_id", "amount", "txn_date"],
      "sidecars": {
        "config_metadata": "3f8a1c2e-.../_log.json",
        "live_updates": "3f8a1c2e-.../_struct_updates.json"
      },
      "applied": {
        "date_formats": 1, "dtype_changes": 1,
        "column_renames": 1, "nulled_values": 0
      }
    }
  ]
}
```

`columns` reflects the **final** names, after renames — so the frontend can
confirm what actually landed rather than assuming the manifest applied cleanly.

---

## Errors

| Status | When |
|---|---|
| `400` | Malformed JSON, missing manifest part, no file parts |
| `404` | Workflow or file does not exist |
| `409` | Object key exists and `overwrite=false`; or delete with objects still present |
| `413` | Upload over the size limit |
| `415` | Unsupported file type |
| `422` | Validation failed, or a `live_updates` operation could not be applied |

A `422` from an upload names the file and column that failed:

```json
{
  "type": "https://beacon.api/problems/transform-failed",
  "title": "Transformation failed",
  "status": 422,
  "detail": "No object was written; the request was rolled back.",
  "errors": [
    { "filename": "sales_2024.csv", "column": "cust_idd",
      "code": "column_not_found",
      "message": "Column \"cust_idd\" is not present in the uploaded file." },
    { "filename": "sales_2024.csv", "column": "amount",
      "code": "cast_failed",
      "message": "Value \"N/A\" at row 42 cannot be cast to decimal(18,2)." }
  ]
}
```

`dtype_changes` accepts `on_error: "null_out"` to write nulls instead of
failing on uncastable values; the count comes back in `applied.nulled_values`.
The default is `fail`, because silently nulling financial data is worse than a
rejected upload.

---

## Open points

These are decisions the contract makes that you may want to change:

1. **No `created_at`** on `workflow` — see the recommendation above.
2. **No auth.** No security scheme is defined. Adding one later is additive.
3. **Size and type limits** are referenced (`413`, `415`) but not numbered.
   Pick a max upload size and an accepted extension list.
4. **No link from files back to the table.** Stored objects are discoverable
   only by listing the bucket prefix. If you later want to query "which files
   belong to this workflow" in SQL, that needs a second table.
