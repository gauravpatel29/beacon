-- Beacon :: 002_object_storage
--
-- Moves file bytes out of Postgres and into Neon Object Storage, and splits
-- "the original upload" from "what the manifest produced".
--
-- Before: workflow_files.raw_csv held the TRANSFORMED csv. Re-applying a
-- manifest therefore compounded on already-transformed data.
-- After:  object_key  -> immutable raw upload in the bucket
--         derived_key -> cache of replaying `spec` against the raw bytes
--         spec        -> the manifest itself; the source of truth
--
-- Anything derived can be thrown away and rebuilt from (raw bytes + spec),
-- which is what makes editing a manifest idempotent.

alter table workflow_files
    add column if not exists derived_key   varchar(500),
    add column if not exists derived_at    timestamptz,
    -- the resolved manifest that produced derived_key
    add column if not exists spec          jsonb  not null default '{}'::jsonb,
    -- for datasets built from other datasets (merge): the inputs it came from
    add column if not exists derived_from  jsonb,
    -- distinguishes an uploaded file from a merge output
    add column if not exists kind          varchar(20) not null default 'upload';

-- raw_csv is superseded by object storage. Keep the column so existing rows
-- are readable, but new writes must not depend on it.
comment on column workflow_files.raw_csv is
    'DEPRECATED - superseded by object_key in Neon Object Storage (migration 002).';
comment on column workflow_files.object_key is
    'Object key of the IMMUTABLE raw upload. Never rewritten after creation.';
comment on column workflow_files.derived_key is
    'Object key of the transformed output. A cache: safe to delete and rebuild.';

alter table workflow_files
    drop constraint if exists workflow_files_kind_check;
alter table workflow_files
    add constraint workflow_files_kind_check check (kind in ('upload', 'merge'));

-- The ingestion screen lists a workflow's datasets on every render.
create index if not exists workflow_files_workflow_idx
    on workflow_files (workflow_id);

-- Optimistic concurrency: two browser tabs editing one workflow's manifest
-- must not silently clobber each other.
alter table workflow_files
    add column if not exists version integer not null default 1;
