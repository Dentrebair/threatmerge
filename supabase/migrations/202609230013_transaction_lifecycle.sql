alter table public.tenants
  add column transaction_inactivity_days integer not null default 30 check (transaction_inactivity_days between 1 and 365),
  add column transaction_separation_of_duties boolean not null default false;

alter table public.transaction_files
  add column requirement_snapshot jsonb not null default '{"artifacts":[],"fields":[]}'::jsonb check (jsonb_typeof(requirement_snapshot) = 'object'),
  add column approved_by uuid,
  add column approved_at timestamptz;

create table public.transaction_requirement_statuses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_file_id uuid not null,
  requirement_kind text not null check (requirement_kind in ('ARTIFACT','FIELD')),
  requirement_key text not null check (length(trim(requirement_key)) > 0),
  status text not null default 'MISSING' check (status in ('PRESENT','MISSING','CONFLICT','LOW_CONFIDENCE')),
  confidence numeric(5,4) check (confidence between 0 and 1),
  resolved_by uuid,
  updated_at timestamptz not null default now(),
  unique (tenant_id, transaction_file_id, requirement_kind, requirement_key),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id)
);

alter table public.transaction_requirement_statuses enable row level security;
create policy tenant_isolation on public.transaction_requirement_statuses using (app_private.is_tenant_member(tenant_id));
grant select on public.transaction_requirement_statuses to authenticated;

create or replace function app_private.valid_transaction_requirements(requirements jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select jsonb_typeof(requirements) = 'object'
    and jsonb_typeof(requirements->'artifacts') = 'array'
    and jsonb_typeof(requirements->'fields') = 'array'
    and jsonb_array_length(requirements->'artifacts') <= 50
    and jsonb_array_length(requirements->'fields') <= 100
    and not exists (
      select 1 from jsonb_array_elements(requirements->'artifacts') value
      where jsonb_typeof(value) <> 'string' or length(trim(value #>> '{}')) = 0
    )
    and not exists (
      select 1 from jsonb_array_elements(requirements->'fields') value
      where jsonb_typeof(value) <> 'string' or length(trim(value #>> '{}')) = 0
    );
$$;

create or replace function public.create_transaction_file(
  target_tenant uuid,
  target_external_reference text,
  target_property_address text,
  target_requirements jsonb,
  actor uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction_id uuid; requirement jsonb;
begin
  perform app_private.assert_reviewer(target_tenant, actor);
  if length(trim(target_property_address)) = 0 then raise exception 'property address is required'; end if;
  if not app_private.valid_transaction_requirements(target_requirements) then raise exception 'transaction requirements are invalid'; end if;
  insert into public.transaction_files (tenant_id, external_reference, property_address, lifecycle, requirement_snapshot)
    values (target_tenant, nullif(trim(target_external_reference), ''), trim(target_property_address), 'ACCUMULATING', target_requirements)
    returning id into transaction_id;
  for requirement in select value from jsonb_array_elements(target_requirements->'artifacts') loop
    insert into public.transaction_requirement_statuses (tenant_id, transaction_file_id, requirement_kind, requirement_key)
      values (target_tenant, transaction_id, 'ARTIFACT', requirement #>> '{}');
  end loop;
  for requirement in select value from jsonb_array_elements(target_requirements->'fields') loop
    insert into public.transaction_requirement_statuses (tenant_id, transaction_file_id, requirement_kind, requirement_key)
      values (target_tenant, transaction_id, 'FIELD', requirement #>> '{}');
  end loop;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (target_tenant, 'TRANSACTION_FILE', transaction_id, 1, 'TRANSACTION_FILE_CREATED', actor,
      jsonb_build_object('property_address', trim(target_property_address), 'requirements', target_requirements));
  return transaction_id;
end $$;

create or replace function public.link_invoice_to_transaction(
  target_invoice uuid,
  expected_invoice_version integer,
  target_transaction uuid,
  expected_transaction_version integer,
  actor uuid
)
returns table (invoice_version integer, transaction_version integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare candidate public.invoice_candidates%rowtype; transaction public.transaction_files%rowtype;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found then raise exception 'invoice not found'; end if;
  perform app_private.assert_reviewer(candidate.tenant_id, actor);
  select * into transaction from public.transaction_files where tenant_id = candidate.tenant_id and id = target_transaction for update;
  if not found then raise exception 'transaction file not found'; end if;
  if candidate.version <> expected_invoice_version then raise exception 'invoice changed; refresh and try again'; end if;
  if transaction.version <> expected_transaction_version then raise exception 'transaction file changed; refresh and try again'; end if;
  if transaction.lifecycle in ('DORMANT','ARCHIVED') then raise exception 'transaction file is not accepting invoice links'; end if;
  update public.invoice_candidates set transaction_file_id = transaction.id, linkage_status = 'LINKED',
    version = version + 1, updated_at = now() where id = candidate.id;
  update public.transaction_files set version = version + 1, last_material_activity_at = now(), updated_at = now()
    where id = transaction.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1, 'INVOICE_LINKED_TO_TRANSACTION', actor,
      jsonb_build_object('transaction_file_id', transaction.id));
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (candidate.tenant_id, 'TRANSACTION_FILE', transaction.id, transaction.version + 1, 'INVOICE_LINKED', actor,
      jsonb_build_object('invoice_candidate_id', candidate.id));
  return query select candidate.version + 1, transaction.version + 1;
end $$;

create or replace function public.record_transaction_requirement(
  target_transaction uuid,
  expected_version integer,
  target_kind text,
  target_key text,
  target_status text,
  target_confidence numeric,
  actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction public.transaction_files%rowtype; next_version integer;
begin
  select * into transaction from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'transaction file not found'; end if;
  perform app_private.assert_reviewer(transaction.tenant_id, actor);
  if transaction.version <> expected_version then raise exception 'transaction file changed; refresh and try again'; end if;
  if transaction.lifecycle in ('DORMANT','ARCHIVED') then raise exception 'reactivate the transaction file before updating requirements'; end if;
  if target_kind not in ('ARTIFACT','FIELD') or target_status not in ('PRESENT','MISSING','CONFLICT','LOW_CONFIDENCE') then raise exception 'requirement update is invalid'; end if;
  update public.transaction_requirement_statuses set status = target_status,
    confidence = case when target_status in ('PRESENT','LOW_CONFIDENCE') then target_confidence else null end,
    resolved_by = actor, updated_at = now()
    where tenant_id = transaction.tenant_id and transaction_file_id = transaction.id
      and requirement_kind = target_kind and requirement_key = target_key;
  if not found then raise exception 'transaction requirement not found'; end if;
  next_version := transaction.version + 1;
  update public.transaction_files set lifecycle = (case when target_status = 'CONFLICT' then 'AMBIGUOUS' else 'ACCUMULATING' end)::public.transaction_lifecycle,
    version = next_version, last_material_activity_at = now(), last_material_resolver_id = actor,
    approved_by = null, approved_at = null, updated_at = now() where id = transaction.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (transaction.tenant_id, 'TRANSACTION_FILE', transaction.id, next_version, 'TRANSACTION_REQUIREMENT_RECORDED', actor,
      jsonb_build_object('kind', target_kind, 'key', target_key, 'status', target_status, 'confidence', target_confidence));
  return next_version;
end $$;

create or replace function public.evaluate_transaction_convergence(target_transaction uuid, expected_version integer, actor uuid)
returns public.transaction_lifecycle
language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction public.transaction_files%rowtype; blocker_count integer;
begin
  select * into transaction from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'transaction file not found'; end if;
  perform app_private.assert_reviewer(transaction.tenant_id, actor);
  if transaction.version <> expected_version then raise exception 'transaction file changed; refresh and try again'; end if;
  if transaction.lifecycle not in ('ACCUMULATING','AMBIGUOUS') then raise exception 'transaction file is not ready for convergence evaluation'; end if;
  select count(*) into blocker_count from public.transaction_requirement_statuses
    where tenant_id = transaction.tenant_id and transaction_file_id = transaction.id and status <> 'PRESENT';
  if blocker_count > 0 then raise exception 'transaction file still has % unresolved requirement(s)', blocker_count; end if;
  update public.transaction_files set lifecycle = 'CONVERGED', version = version + 1, updated_at = now() where id = transaction.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id)
    values (transaction.tenant_id, 'TRANSACTION_FILE', transaction.id, transaction.version + 1, 'TRANSACTION_FILE_CONVERGED', actor);
  return 'CONVERGED';
end $$;

create or replace function public.approve_transaction_file(target_transaction uuid, expected_version integer, actor uuid)
returns public.transaction_lifecycle
language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction public.transaction_files%rowtype; separation boolean;
begin
  select * into transaction from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'transaction file not found'; end if;
  perform app_private.assert_reviewer(transaction.tenant_id, actor);
  if transaction.version <> expected_version then raise exception 'transaction file changed; refresh and try again'; end if;
  if transaction.lifecycle <> 'CONVERGED' then raise exception 'transaction file is not ready for final approval'; end if;
  select transaction_separation_of_duties into separation from public.tenants where id = transaction.tenant_id;
  if separation and transaction.last_material_resolver_id = actor then raise exception 'another reviewer must approve this transaction file'; end if;
  update public.transaction_files set lifecycle = 'APPROVED', approved_by = actor, approved_at = now(),
    version = version + 1, updated_at = now() where id = transaction.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id)
    values (transaction.tenant_id, 'TRANSACTION_FILE', transaction.id, transaction.version + 1, 'TRANSACTION_FILE_APPROVED', actor);
  return 'APPROVED';
end $$;

create or replace function public.mark_transaction_dormant(target_transaction uuid)
returns public.transaction_lifecycle
language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction public.transaction_files%rowtype; inactivity_days integer;
begin
  select * into transaction from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'transaction file not found'; end if;
  if transaction.lifecycle <> 'ACCUMULATING' then raise exception 'only an accumulating transaction file can become dormant'; end if;
  select transaction_inactivity_days into inactivity_days from public.tenants where id = transaction.tenant_id;
  if transaction.last_material_activity_at > now() - make_interval(days => inactivity_days) then raise exception 'transaction file is still active'; end if;
  update public.transaction_files set lifecycle = 'DORMANT', version = version + 1, updated_at = now() where id = transaction.id;
  update public.invoice_candidates set lifecycle = 'SUSPENDED', version = version + 1, updated_at = now()
    where tenant_id = transaction.tenant_id and transaction_file_id = transaction.id and lifecycle = 'INCOMPLETE_DRAFT';
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
    values (transaction.tenant_id, 'TRANSACTION_FILE', transaction.id, transaction.version + 1, 'TRANSACTION_FILE_DORMANT',
      jsonb_build_object('inactivity_days', inactivity_days));
  return 'DORMANT';
end $$;

create or replace function public.reactivate_transaction_file(target_transaction uuid, expected_version integer, actor uuid)
returns public.transaction_lifecycle
language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction public.transaction_files%rowtype;
begin
  select * into transaction from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'transaction file not found'; end if;
  perform app_private.assert_reviewer(transaction.tenant_id, actor);
  if transaction.version <> expected_version then raise exception 'transaction file changed; refresh and try again'; end if;
  if transaction.lifecycle <> 'DORMANT' then raise exception 'transaction file is not dormant'; end if;
  update public.transaction_files set lifecycle = 'ACCUMULATING', version = version + 1,
    last_material_activity_at = now(), updated_at = now() where id = transaction.id;
  update public.invoice_candidates set lifecycle = 'INCOMPLETE_DRAFT', version = version + 1, updated_at = now()
    where tenant_id = transaction.tenant_id and transaction_file_id = transaction.id and lifecycle = 'SUSPENDED';
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id)
    values (transaction.tenant_id, 'TRANSACTION_FILE', transaction.id, transaction.version + 1, 'TRANSACTION_FILE_REACTIVATED', actor);
  return 'ACCUMULATING';
end $$;

revoke all on function public.create_transaction_file(uuid, text, text, jsonb, uuid) from public, anon;
revoke all on function public.link_invoice_to_transaction(uuid, integer, uuid, integer, uuid) from public, anon;
revoke all on function public.record_transaction_requirement(uuid, integer, text, text, text, numeric, uuid) from public, anon;
revoke all on function public.evaluate_transaction_convergence(uuid, integer, uuid) from public, anon;
revoke all on function public.approve_transaction_file(uuid, integer, uuid) from public, anon;
revoke all on function public.mark_transaction_dormant(uuid) from public, anon, authenticated;
revoke all on function public.reactivate_transaction_file(uuid, integer, uuid) from public, anon;
grant execute on function public.create_transaction_file(uuid, text, text, jsonb, uuid) to authenticated;
grant execute on function public.link_invoice_to_transaction(uuid, integer, uuid, integer, uuid) to authenticated;
grant execute on function public.record_transaction_requirement(uuid, integer, text, text, text, numeric, uuid) to authenticated;
grant execute on function public.evaluate_transaction_convergence(uuid, integer, uuid) to authenticated;
grant execute on function public.approve_transaction_file(uuid, integer, uuid) to authenticated;
grant execute on function public.mark_transaction_dormant(uuid) to service_role;
grant execute on function public.reactivate_transaction_file(uuid, integer, uuid) to authenticated;
