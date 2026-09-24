create table public.transaction_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_file_id uuid not null,
  requirement_key text,
  name text not null check (length(trim(name)) between 1 and 160),
  required boolean not null default false,
  stage_gate text not null default 'BEFORE_REVIEW'
    check (stage_gate in ('BEFORE_REVIEW','BEFORE_APPROVAL','BEFORE_CLOSING')),
  current_version_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, transaction_file_id, requirement_key),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  foreign key (tenant_id, created_by) references public.tenant_memberships(tenant_id, user_id),
  check (requirement_key is null or length(trim(requirement_key)) between 1 and 120)
);

create table public.transaction_document_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_file_id uuid not null,
  document_id uuid not null,
  evidence_artifact_id uuid not null,
  version integer not null check (version > 0),
  expires_on date,
  uploaded_by uuid not null,
  uploaded_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, document_id, version),
  unique (tenant_id, document_id, evidence_artifact_id),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  foreign key (tenant_id, document_id) references public.transaction_documents(tenant_id, id),
  foreign key (tenant_id, evidence_artifact_id) references public.evidence_artifacts(tenant_id, id),
  foreign key (tenant_id, uploaded_by) references public.tenant_memberships(tenant_id, user_id)
);

alter table public.transaction_documents
  add foreign key (tenant_id, current_version_id) references public.transaction_document_versions(tenant_id, id);

create table public.transaction_document_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_file_id uuid not null,
  document_version_id uuid not null,
  decision text not null check (decision in ('VERIFIED','REJECTED')),
  reason text,
  decided_by uuid not null,
  decided_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  foreign key (tenant_id, document_version_id) references public.transaction_document_versions(tenant_id, id),
  foreign key (tenant_id, decided_by) references public.tenant_memberships(tenant_id, user_id),
  check ((decision = 'REJECTED' and length(trim(coalesce(reason, ''))) > 0)
    or (decision = 'VERIFIED' and reason is null))
);

create unique index transaction_document_latest_decision_idx
  on public.transaction_document_decisions (tenant_id, document_version_id, decided_at desc, id);

alter table public.transaction_documents enable row level security;
alter table public.transaction_document_versions enable row level security;
alter table public.transaction_document_decisions enable row level security;
create policy tenant_isolation on public.transaction_documents for select using (app_private.is_tenant_member(tenant_id));
create policy tenant_isolation on public.transaction_document_versions for select using (app_private.is_tenant_member(tenant_id));
create policy tenant_isolation on public.transaction_document_decisions for select using (app_private.is_tenant_member(tenant_id));
grant select on public.transaction_documents, public.transaction_document_versions,
  public.transaction_document_decisions to authenticated;

create trigger guard_transaction_document_write
before insert or update or delete on public.transaction_documents
for each row execute function app_private.guard_transaction_child_write();
create trigger guard_transaction_document_version_write
before insert or update or delete on public.transaction_document_versions
for each row execute function app_private.guard_transaction_child_write();
create or replace function app_private.prevent_document_history_mutation()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'document history is append-only';
end $$;
create trigger prevent_document_version_mutation before update or delete on public.transaction_document_versions
for each row execute function app_private.prevent_document_history_mutation();
create trigger prevent_document_decision_mutation before update or delete on public.transaction_document_decisions
for each row execute function app_private.prevent_document_history_mutation();

create or replace function public.register_transaction_document_version(
  target_transaction uuid, expected_version integer, target_requirement_key text,
  target_name text, target_evidence uuid, target_expires_on date, actor uuid
)
returns table (document_id uuid, document_version_id uuid, transaction_version integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; artifact public.evidence_artifacts%rowtype;
  document public.transaction_documents%rowtype; version_id uuid; next_document_version integer;
  requirement public.transaction_requirement_statuses%rowtype;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then raise exception 'only the assigned owner, coordinator, or administrator can manage this file'; end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  select * into artifact from public.evidence_artifacts where tenant_id = file.tenant_id and id = target_evidence;
  if not found then raise exception 'uploaded file not found'; end if;
  if artifact.safety_status <> 'SAFE' then raise exception 'file must pass safety checks before it can be added'; end if;
  if length(trim(coalesce(target_name, ''))) not between 1 and 160 then raise exception 'document name is required'; end if;
  if target_expires_on is not null and target_expires_on < current_date then raise exception 'document expiry must be today or later'; end if;
  if nullif(trim(coalesce(target_requirement_key, '')), '') is not null then
    select * into requirement from public.transaction_requirement_statuses
      where tenant_id = file.tenant_id and transaction_file_id = file.id
        and requirement_kind = 'ARTIFACT' and requirement_key = trim(target_requirement_key);
    if not found then raise exception 'document requirement not found'; end if;
  end if;
  select * into document from public.transaction_documents
    where tenant_id = file.tenant_id and transaction_file_id = file.id
      and requirement_key is not distinct from nullif(trim(target_requirement_key), '') for update;
  if not found then
    insert into public.transaction_documents
      (tenant_id, transaction_file_id, requirement_key, name, required, stage_gate, created_by)
    values (file.tenant_id, file.id, nullif(trim(target_requirement_key), ''), trim(target_name),
      requirement.id is not null, coalesce(requirement.stage_gate, 'BEFORE_REVIEW'), actor)
    returning * into document;
  end if;
  select coalesce(max(stored_version.version), 0) + 1 into next_document_version
    from public.transaction_document_versions stored_version
    where stored_version.tenant_id = file.tenant_id and stored_version.document_id = document.id;
  insert into public.transaction_document_versions
    (tenant_id, transaction_file_id, document_id, evidence_artifact_id, version, expires_on, uploaded_by)
  values (file.tenant_id, file.id, document.id, artifact.id, next_document_version, target_expires_on, actor)
  returning id into version_id;
  update public.transaction_documents set current_version_id = version_id, name = trim(target_name) where id = document.id;
  insert into public.evidence_links (tenant_id, evidence_artifact_id, transaction_file_id, relationship, confidence)
    values (file.tenant_id, artifact.id, file.id, 'TRANSACTION_DOCUMENT_VERSION', 1);
  if requirement.id is not null then
    update public.transaction_requirement_statuses set status = 'PRESENT', confidence = 1,
      resolved_by = actor, updated_at = now() where id = requirement.id;
  end if;
  perform app_private.invalidate_transaction_review(file.id);
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_DOCUMENT_VERSION_ADDED', actor,
      jsonb_build_object('document_id', document.id, 'document_version_id', version_id,
        'evidence_artifact_id', artifact.id, 'version', next_document_version));
  return query select document.id, version_id, file.version + 1;
end $$;

create or replace function public.review_transaction_document(
  target_transaction uuid, expected_version integer, target_document_version uuid,
  target_decision text, target_reason text, actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; version public.transaction_document_versions%rowtype;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  perform app_private.assert_reviewer(file.tenant_id, actor);
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  select * into version from public.transaction_document_versions
    where tenant_id = file.tenant_id and transaction_file_id = file.id and id = target_document_version;
  if not found then raise exception 'document version not found'; end if;
  if target_decision not in ('VERIFIED','REJECTED') then raise exception 'document decision is invalid'; end if;
  if target_decision = 'REJECTED' and length(trim(coalesce(target_reason, ''))) = 0 then raise exception 'explain why the document was rejected'; end if;
  insert into public.transaction_document_decisions
    (tenant_id, transaction_file_id, document_version_id, decision, reason, decided_by)
  values (file.tenant_id, file.id, version.id, target_decision,
    case when target_decision = 'REJECTED' then trim(target_reason) else null end, actor);
  perform app_private.invalidate_transaction_review(file.id);
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1,
      'TRANSACTION_DOCUMENT_' || target_decision, actor,
      jsonb_build_object('document_version_id', version.id, 'reason', nullif(trim(coalesce(target_reason, '')), '')));
  return file.version + 1;
end $$;

create or replace function public.list_transaction_documents(target_tenant uuid)
returns table (
  transaction_file_id uuid, document_id uuid, name text, requirement_key text,
  required boolean, stage_gate text, document_version_id uuid, version integer,
  evidence_artifact_id uuid, file_name text, uploaded_at timestamptz, expires_on date,
  effective_status text, decision_reason text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query select document.transaction_file_id, document.id, document.name, document.requirement_key,
    document.required, document.stage_gate, version.id, version.version, version.evidence_artifact_id,
    regexp_replace(artifact.storage_path, '^.*/', ''), version.uploaded_at, version.expires_on,
    case when version.id is null then 'MISSING'
      when version.expires_on < current_date then 'EXPIRED'
      else coalesce(decision.decision, 'RECEIVED') end,
    decision.reason
  from public.transaction_documents document
  left join public.transaction_document_versions version
    on version.tenant_id = document.tenant_id and version.id = document.current_version_id
  left join public.evidence_artifacts artifact
    on artifact.tenant_id = version.tenant_id and artifact.id = version.evidence_artifact_id
  left join lateral (
    select latest.decision, latest.reason from public.transaction_document_decisions latest
    where latest.tenant_id = document.tenant_id and latest.document_version_id = version.id
    order by latest.decided_at desc, latest.id desc limit 1
  ) decision on true
  where document.tenant_id = target_tenant order by document.created_at, document.id;
end $$;

revoke all on function public.register_transaction_document_version(uuid, integer, text, text, uuid, date, uuid) from public, anon;
revoke all on function public.review_transaction_document(uuid, integer, uuid, text, text, uuid) from public, anon;
revoke all on function public.list_transaction_documents(uuid) from public, anon;
grant execute on function public.register_transaction_document_version(uuid, integer, text, text, uuid, date, uuid) to authenticated;
grant execute on function public.review_transaction_document(uuid, integer, uuid, text, text, uuid) to authenticated;
grant execute on function public.list_transaction_documents(uuid) to authenticated;
