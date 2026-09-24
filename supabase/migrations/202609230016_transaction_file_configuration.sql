alter table public.transaction_files
  add column transaction_type text,
  add column office text,
  add column key_dates jsonb not null default '{}'::jsonb check (jsonb_typeof(key_dates) = 'object');

create or replace function public.create_transaction_file_with_details(
  target_tenant uuid,
  target_external_reference text,
  target_property_address text,
  target_transaction_type text,
  target_office text,
  target_key_dates jsonb,
  target_requirements jsonb,
  actor uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction_id uuid; requirement jsonb;
begin
  perform app_private.assert_reviewer(target_tenant, actor);
  if length(trim(coalesce(target_property_address, ''))) = 0 then raise exception 'property address is required'; end if;
  if jsonb_typeof(target_key_dates) <> 'object' or exists (
    select 1 from jsonb_each_text(target_key_dates) date_entry
    where length(trim(date_entry.key)) = 0 or date_entry.value !~ '^\d{4}-\d{2}-\d{2}$'
  ) then raise exception 'key dates are invalid'; end if;
  if not app_private.valid_transaction_requirements(target_requirements) then raise exception 'transaction requirements are invalid'; end if;

  insert into public.transaction_files (
    tenant_id, external_reference, property_address, transaction_type, office,
    key_dates, lifecycle, requirement_snapshot
  ) values (
    target_tenant, nullif(trim(target_external_reference), ''), trim(target_property_address),
    nullif(trim(target_transaction_type), ''), nullif(trim(target_office), ''),
    target_key_dates, 'ACCUMULATING', target_requirements
  ) returning id into transaction_id;

  for requirement in select value from jsonb_array_elements(target_requirements->'artifacts') loop
    insert into public.transaction_requirement_statuses (tenant_id, transaction_file_id, requirement_kind, requirement_key)
      values (target_tenant, transaction_id, 'ARTIFACT', trim(requirement #>> '{}'));
  end loop;
  for requirement in select value from jsonb_array_elements(target_requirements->'fields') loop
    insert into public.transaction_requirement_statuses (tenant_id, transaction_file_id, requirement_kind, requirement_key)
      values (target_tenant, transaction_id, 'FIELD', trim(requirement #>> '{}'));
  end loop;

  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (target_tenant, 'TRANSACTION_FILE', transaction_id, 1, 'TRANSACTION_FILE_CREATED', actor,
      jsonb_build_object('property_address', trim(target_property_address), 'transaction_type', nullif(trim(target_transaction_type), ''),
        'office', nullif(trim(target_office), ''), 'key_dates', target_key_dates, 'requirements', target_requirements));
  return transaction_id;
end $$;

create or replace function public.add_transaction_requirement(
  target_transaction uuid,
  expected_version integer,
  target_kind text,
  target_key text,
  actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction public.transaction_files%rowtype; next_version integer; normalized_key text; next_snapshot jsonb;
begin
  select * into transaction from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'transaction file not found'; end if;
  perform app_private.assert_reviewer(transaction.tenant_id, actor);
  if transaction.version <> expected_version then raise exception 'transaction file changed; refresh and try again'; end if;
  if transaction.lifecycle in ('DORMANT','ARCHIVED') then raise exception 'reactivate the transaction file before adding requirements'; end if;
  if target_kind not in ('ARTIFACT','FIELD') then raise exception 'requirement type is invalid'; end if;
  normalized_key := trim(coalesce(target_key, ''));
  if length(normalized_key) = 0 or length(normalized_key) > 120 then raise exception 'requirement name is invalid'; end if;

  insert into public.transaction_requirement_statuses
    (tenant_id, transaction_file_id, requirement_kind, requirement_key)
  values (transaction.tenant_id, transaction.id, target_kind, normalized_key);

  next_snapshot := jsonb_set(transaction.requirement_snapshot,
    case when target_kind = 'ARTIFACT' then array['artifacts']::text[] else array['fields']::text[] end,
    coalesce(transaction.requirement_snapshot -> case when target_kind = 'ARTIFACT' then 'artifacts' else 'fields' end, '[]'::jsonb) || to_jsonb(normalized_key));
  next_version := transaction.version + 1;
  update public.transaction_files set requirement_snapshot = next_snapshot, lifecycle = 'ACCUMULATING',
    approved_by = null, approved_at = null, version = next_version, last_material_activity_at = now(),
    last_material_resolver_id = actor, updated_at = now() where id = transaction.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (transaction.tenant_id, 'TRANSACTION_FILE', transaction.id, next_version, 'TRANSACTION_REQUIREMENT_ADDED', actor,
      jsonb_build_object('kind', target_kind, 'key', normalized_key, 'previous_lifecycle', transaction.lifecycle));
  return next_version;
exception when unique_violation then
  raise exception 'this requirement already exists';
end $$;

revoke all on function public.create_transaction_file_with_details(uuid, text, text, text, text, jsonb, jsonb, uuid) from public, anon;
revoke all on function public.add_transaction_requirement(uuid, integer, text, text, uuid) from public, anon;
grant execute on function public.create_transaction_file_with_details(uuid, text, text, text, text, jsonb, jsonb, uuid) to authenticated;
grant execute on function public.add_transaction_requirement(uuid, integer, text, text, uuid) to authenticated;
