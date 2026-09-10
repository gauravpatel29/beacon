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

Add **`?dry_run=true`** to preview the join without saving. It runs the whole
pipeline on the real data through the same code path as a commit, so what you
see is what you would get — and it returns the same field names, so the UI
reads one shape either way. Nothing is written and no dataset appears in the
list.

It does the full join work, so on large files a preview costs what a build
costs. That is the trade that makes it trustworthy rather than an estimate.

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
| `left_key` / `right_key` | Array (or comma-separated string). **Both sides must have the same count.** Omit for `cross` |
| `join_type` | `left` · `inner` · `right` · `outer` · `cross` |
| `target_grain` | `hcp` · `dma` · `geo` · `zip` · `national` |
| `output` | Optional. Defaults to `__ard_<grain>__.csv` |

Key names are matched **case-insensitively**, so `npi` finds `NPI`.

### Join types

| `join_type` | Keeps |
|---|---|
| `left` | every left row (default) |
| `inner` | only rows matching on both sides |
| `right` | every right row |
| `outer` | every row from both sides |
| `cross` | every combination — no keys, no matching |

`cross` is the only one that takes no keys; the other four return **422**
`keys_missing` without them.

> Send the plain value (`"left"`), not the dropdown's label text. Labels are
> tolerated, but a label containing a file name is ambiguous — `"Left Join
> (Keep all crosswalk.csv rows)"` reads as a *cross* join to anything matching
> loosely. The value is unambiguous.

### Keys

Any number of key pairs, positionally matched: `left_key[0]` joins to
`right_key[0]`, and so on. A date key is just another pair — pair it only when
both sides have a date column, since a crosswalk joins on the ID alone. Sending
2 keys on one side and 1 on the other is a **422**.

**201** (or **200** for `dry_run` — same field names either way)

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
      "keys": ["npi","month"], "rows_in": 3, "rows_out": 3 },
    { "step": 2, "left": "Step 1 Result", "right": "xwalk.csv", "join": "left",
      "keys": ["npi"], "rows_in": 3, "rows_out": 3 }
  ] },
  "derived_from": { "grain": "hcp", "inputs": ["calls.csv","sales.csv"] }
}
```

On a cross join, `keys` reads `["(cross join - no keys)"]`.

`rows_in` vs `rows_out` per step is worth showing — it's how a user spots a
join that dropped or multiplied rows.

### Steps run in order, and the LAST one is the ARD

Every step executes, in sequence. Each result is registered as `"Step N Result"`
so the next step can build on it. **The ARD is whatever the final step
produced** — not an accumulation of all of them.

So a step whose `left_file` isn't `"Step N Result"` starts a fresh chain, and
the earlier work is computed and then discarded:

```
chained      step 2 left = "Step 1 Result"  ->  columns: key, trx, calls, dma
not chained  step 2 left = "a.csv"          ->  columns: key, trx, dma
                                                          ("calls" is lost)
```

Both appear in `lineage` either way, so compare the final `columns` against
what you expect if a column goes missing.

### Two other behaviours

- **Duplicate keys on the right are aggregated before joining** (numerics
  summed, everything else takes the first value), so the ARD can't fan out past
  its own grain. Skipped for `cross`.
- **Unmatched rows get `0`** for numeric columns *brought in by that step from
  the right*. Columns already on the left keep their own nulls — so on an
  `outer` join, a right-only row shows `null` for the left's metrics rather
  than a fabricated `0`.

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
