# Data Stitching & ARD — API notes

For the **Data Stitching & ARD Creation** screen only. Four calls.

Base path is relative (`/v2/...`); the dev server proxies it to the backend.
Full contract for everything else: [FRONTEND_API_GUIDE.md](FRONTEND_API_GUIDE.md).

> **The screen sends step definitions, not data.** Steps name datasets and the
> server loads them from storage. Never post CSV text to build an ARD.

---

## 1. On page load — fill the dropdowns

`GET /v2/workflows/{workflow_id}/files`

```json
{ "items": [
  { "filename": "sales.csv", "columns": ["npi","month","trx"],
    "row_count": 12000, "kind": "upload" }
] }
```

Use `filename` for the source checklist and `columns` for the key pickers.

**Filter out `kind === "ard"`** — otherwise a previously built ARD shows up as a
source and can be joined into itself.

Nothing here means the user hasn't uploaded on the Ingestion screen yet.

---

## 2. Run the pipeline

`POST /v2/workflows/{workflow_id}/ard/build`

Add `?dry_run=true` to see the result without saving.

```json
{
  "steps": [
    { "left_file": "sales.csv", "right_file": "calls.csv",
      "left_key": ["npi", "month"], "right_key": ["NPI", "Month"],
      "join_type": "left" },
    { "left_file": "Step 1 Result", "right_file": "xwalk.csv",
      "left_key": ["npi"], "right_key": ["npi"],
      "join_type": "left" }
  ],
  "target_grain": "hcp",
  "output": "HCP_Master_ARD"
}
```

| Field | Notes |
|---|---|
| `left_file` / `right_file` | A dataset filename, or `"Step N Result"` to chain off an earlier step |
| `left_key` / `right_key` | Array (or comma-separated string). **Both sides must have the same count** |
| `join_type` | `left` or `inner` |
| `target_grain` | `hcp` · `dma` · `geo` · `zip` · `national` |
| `output` | Optional. Defaults to `__ard_<grain>__.csv` |

Key names are matched **case-insensitively**, so `npi` finds `NPI`.

**A date key is optional.** Pair it only when both sides have one — a crosswalk
joins on the ID alone. Sending 2 keys on one side and 1 on the other is a 422.

**201** (or **200** for `dry_run`)

```json
{
  "filename": "HCP_Master_ARD.csv",
  "kind": "ard",
  "version": 1,
  "row_count": 3,
  "columns": ["npi","month","trx","calls","dma_id","dma_name"],
  "preview": [ /* up to 100 rows */ ],
  "lineage": { "steps_executed": [
    { "step": 1, "left": "sales.csv", "right": "calls.csv", "join": "left",
      "rows_in": 3, "rows_out": 3, "rows_matched": 3 }
  ] },
  "derived_from": { "grain": "hcp", "inputs": ["calls.csv","sales.csv"] }
}
```

`lineage.steps_executed[].rows_in` vs `rows_out` is worth showing — it's how a
user spots a join that dropped or multiplied rows.

Two behaviours to know:

- **Duplicate keys on the right are aggregated before joining** (numerics
  summed, everything else takes the first value), so the ARD can't fan out past
  its own grain.
- **Unmatched rows get `0`, not null,** for numeric columns from the right side.

---

## 3. List previously built ARDs

`GET /v2/workflows/{workflow_id}/ard` → `{ "items": [ ... ] }`, newest first,
each with a `grain` field. Same object shape as the build response.

---

## 4. Hand off to the next screen

`GET /v2/workflows/{workflow_id}/files/{filename}/csv` → `text/csv`

EDA and the stages after it still take a CSV string. Call this **once** after a
successful build and pass the result on. Don't put it in `localStorage`.

The ARD is a normal dataset, so `/files/{filename}` (metadata + preview),
`/download` (presigned URL) and `DELETE` all work on it too.

---

## Errors

Every failure is `application/problem+json`:

```json
{ "title": "Stitching failed", "status": 422,
  "errors": [ { "step": 1, "code": "left_key_not_found",
                "column": "nope",
                "message": "Step 1: \"nope\" is not a column of \"sales.csv\"." } ] }
```

`problemMessage(err)` in `services/api.js` turns this into a toast string. For
inline display, read `err.response.data.errors` — messages are written to be
shown as-is, and `step` tells you which card to highlight.

| `code` | Means |
|---|---|
| `dataset_not_found` | A step names a file that isn't in this workflow |
| `left_key_not_found` / `right_key_not_found` | That column isn't in that dataset |
| `key_count_mismatch` | Different number of keys on each side |
| `keys_missing` | No key chosen on one side |
| `left_not_found` / `right_not_found` | Bad `Step N Result` reference |
| `empty_result` | Pipeline produced 0 rows — the keys don't overlap |

`404` means the workflow doesn't exist. `503` means the backend has no database
or bucket credentials — not the user's fault.

---

## Client helpers

Already in `client/src/services/api.js`:

```js
v2ListFiles(workflowId)                      // step 1
v2BuildArd(workflowId, payload, { dryRun })  // step 2
v2ListArds(workflowId)                       // step 3
v2GetCsv(workflowId, filename)               // step 4
problemMessage(err, fallback)
```

Reference implementation: `client/src/pages/DataStitching.jsx`.
