-- Beacon :: 001_create_workflow
-- Table backing the "Create New Workflow" form.
-- Four columns exactly, per spec: id, workflow_name, state, tag.

create table if not exists workflow (
    id            uuid primary key default gen_random_uuid(),
    workflow_name text not null,
    state         text not null default 'new',
    tag           text,

    constraint workflow_name_not_blank
        check (length(btrim(workflow_name)) > 0),

    -- `state` is deliberately text, not an enum: the spec says more values
    -- arrive later, and adding an allowed value must not require a migration.
    -- The API layer owns the allowlist (see openapi.yaml -> WorkflowState).
    constraint workflow_state_not_blank
        check (length(btrim(state)) > 0)
);

-- The upload path resolves a workflow by id on every request.
-- (Primary key already indexes id; this covers the common list filter.)
create index if not exists workflow_state_idx on workflow (state);
create index if not exists workflow_tag_idx   on workflow (tag) where tag is not null;

-- gen_random_uuid() is built into PostgreSQL 13+; this branch runs 18.6,
-- so no pgcrypto extension is required.
