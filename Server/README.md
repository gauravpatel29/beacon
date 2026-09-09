# Beacon — Server

Python backend implementing [contracts/openapi.yaml](contracts/openapi.yaml).
FastAPI + SQLAlchemy (async psycopg3) against Neon Postgres, with pandas
transformations written into Neon Object Storage.

## Run it

```powershell
cd Server
.venv\Scripts\python.exe scripts\migrate.py      # once, creates the workflow table
.venv\Scripts\python.exe run.py                  # API  -> http://127.0.0.1:8100
.venv\Scripts\python.exe -m streamlit run streamlit_app.py   # UI -> :8501
```

Interactive API docs: <http://127.0.0.1:8100/docs>

> **Use `run.py`, not `uvicorn app.main:app`.** On Windows uvicorn builds its
> event loop *before* importing the app, so async psycopg fails with
> `Psycopg cannot use the 'ProactorEventLoop'`. `run.py` sets the selector
> policy first. The same guard sits in `app/__init__.py` for the scripts.

> Port 8100, not 8000 — something else on this machine already listens on 8000.

## Layout

```
Server/
  app/
    main.py          FastAPI assembly, CORS, error handlers
    config.py        settings from .env.local; the WORKFLOW_STATES allowlist
    db.py            async engine + session
    models.py        Workflow ORM model (4 columns)
    schemas.py       Pydantic models mirroring the contract
    errors.py        RFC 9457 problem+json
    transform.py     live_updates engine
    storage.py       S3-compatible bucket access + shared-sidecar merging
    routers/
      workflows.py   contract 1
      files.py       contract 2
  contracts/         openapi.yaml + API_CONTRACT.md
  migrations/        001_create_workflow.sql
  scripts/
    migrate.py       apply migrations
    e2e_check.py     48 assertions against the live branch and bucket
  run.py             API launcher
  streamlit_app.py   manual test UI
```

## Testing

```powershell
.venv\Scripts\python.exe scripts\e2e_check.py
```

48 assertions. Creates a workflow, uploads a CSV needing all three
transformation kinds, uploads a second file to prove the shared sidecars
accumulate rather than clobber, reads the stored bytes back out of the bucket,
exercises every error path, then deletes everything it made. It talks to the **real** `production` branch
and the **real** bucket — it cleans up after itself, but it is not a mock.

The Streamlit app is a thin HTTP client over the same API: four tabs for
creating workflows, browsing them, uploading with a grid-based `live_updates`
builder, and inspecting what landed in storage.

## How a transformation runs

`live_updates` is applied in fixed order:

```
date_formats  ->  dtype_changes  ->  column_renames
```

Every operation names columns **as they appear in the uploaded file**. Renames
land last, so no operation refers to a name another operation produced. Column
existence is validated up front, so a typo fails before any object is written.

Uploads are all-or-nothing: object storage has no transactions, so a failure
triggers compensating deletes of whatever that request already wrote.

Each workflow folder holds exactly **one** `_log.json` and **one**
`_struct_updates.json`, both keyed by filename under a `files` map. A second
upload merges in; deleting a file drops only its entry.

Uploads must be multipart to this API rather than presigned direct-to-bucket —
a presigned PUT goes browser → bucket, and the backend would never see the
bytes it has to transform. Downloads *are* presigned, since bucket `data` is
private.

## Known gaps

1. **No duplicate protection on create.** A double-clicked Create button makes
   two workflows and two storage folders. The frontend must disable the button
   until the response lands.
2. **Sidecar writes are read-modify-write.** One `_log.json` per workflow means
   each upload reads it, adds an entry and writes it back. Object storage has
   no compare-and-set, so two uploads to the *same* workflow at the same
   instant can lose an entry. Different workflows never contend.
3. **No auth.** No security scheme anywhere; every endpoint is open.
4. **No `created_at`.** The spec asked for four columns. Without a timestamp
   the list endpoint sorts by UUID, which is effectively random order.
5. **Upload limit is 200 MB** and files are processed in memory — pandas loads
   the whole frame. Large files will need streaming or a worker queue.
6. **Bucket objects have no database record.** Files are discoverable only by
   listing the storage prefix; SQL cannot answer "which files does this
   workflow own".
7. **CORS is wide open** (`allow_origins=["*"]`) for local development.

## Environment

`.env.local` is written by `neon link` and is gitignored. It carries
`DATABASE_URL` (pooled, used by the API), `DATABASE_URL_UNPOOLED` (used by
migrations, since pgbouncer breaks transactional DDL), and the `AWS_*` values
for the S3-compatible bucket.
