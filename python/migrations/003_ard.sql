-- Beacon :: 003_ard
--
-- Data Stitching / ARD creation.
--
-- An ARD is the output of a multi-step join across the workflow's datasets. It
-- is stored as a dataset in its own right rather than in a separate table, so
-- preview, download, the CSV handoff and resolve_frame all work on it with no
-- special-casing downstream. `derived_from` carries the grain and the full
-- step-by-step lineage.

alter table workflow_files
    drop constraint if exists workflow_files_kind_check;
alter table workflow_files
    add constraint workflow_files_kind_check
    check (kind in ('upload', 'merge', 'ard'));

-- The ARD list is read per workflow on every visit to the stitching screen.
create index if not exists workflow_files_kind_idx
    on workflow_files (workflow_id, kind);
