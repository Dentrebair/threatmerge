create or replace function public.update_transaction_file_details(
  target_transaction uuid, expected_version integer, target_external_reference text,
  target_property_address text, target_transaction_type text, target_office text,
  target_closing_date text, actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction public.transaction_files%rowtype; next_version integer; next_dates jsonb;
begin
  select * into transaction from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'transaction file not found'; end if;
  perform app_private.assert_reviewer(transaction.tenant_id, actor);
  if transaction.version <> expected_version then raise exception 'transaction file changed; refresh and try again'; end if;
  if transaction.lifecycle in ('DORMANT','ARCHIVED') then raise exception 'reactivate the transaction file before editing details'; end if;
  if length(trim(coalesce(target_property_address, ''))) = 0 then raise exception 'property address is required'; end if;
  if nullif(trim(coalesce(target_closing_date, '')), '') is not null and target_closing_date !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'closing date is invalid'; end if;
  next_dates := case when nullif(trim(coalesce(target_closing_date, '')), '') is null then '{}'::jsonb else jsonb_build_object('closingDate', target_closing_date) end;
  next_version := transaction.version + 1;
  update public.transaction_files set external_reference = nullif(trim(target_external_reference), ''),
    property_address = trim(target_property_address), transaction_type = nullif(trim(target_transaction_type), ''),
    office = nullif(trim(target_office), ''), key_dates = next_dates, lifecycle = 'ACCUMULATING',
    approved_by = null, approved_at = null, version = next_version, last_material_activity_at = now(),
    last_material_resolver_id = actor, updated_at = now() where id = transaction.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (transaction.tenant_id, 'TRANSACTION_FILE', transaction.id, next_version, 'TRANSACTION_DETAILS_UPDATED', actor,
      jsonb_build_object('previous_lifecycle', transaction.lifecycle, 'property_address', trim(target_property_address),
        'transaction_type', nullif(trim(target_transaction_type), ''), 'office', nullif(trim(target_office), ''), 'key_dates', next_dates));
  return next_version;
end $$;

create or replace function public.remove_transaction_requirement(
  target_transaction uuid, expected_version integer, target_kind text, target_key text, actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction public.transaction_files%rowtype; next_version integer; remaining integer; next_snapshot jsonb;
begin
  select * into transaction from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'transaction file not found'; end if;
  perform app_private.assert_reviewer(transaction.tenant_id, actor);
  if transaction.version <> expected_version then raise exception 'transaction file changed; refresh and try again'; end if;
  if transaction.lifecycle in ('DORMANT','ARCHIVED') then raise exception 'reactivate the transaction file before removing requirements'; end if;
  select count(*) into remaining from public.transaction_requirement_statuses
    where tenant_id = transaction.tenant_id and transaction_file_id = transaction.id;
  if remaining <= 1 then raise exception 'a Transaction File must keep at least one requirement'; end if;
  delete from public.transaction_requirement_statuses where tenant_id = transaction.tenant_id
    and transaction_file_id = transaction.id and requirement_kind = target_kind and requirement_key = target_key;
  if not found then raise exception 'transaction requirement not found'; end if;
  next_snapshot := jsonb_set(transaction.requirement_snapshot,
    case when target_kind = 'ARTIFACT' then array['artifacts']::text[] else array['fields']::text[] end,
    coalesce((select jsonb_agg(value) from jsonb_array_elements(transaction.requirement_snapshot ->
      case when target_kind = 'ARTIFACT' then 'artifacts' else 'fields' end) value where value #>> '{}' <> target_key), '[]'::jsonb));
  next_version := transaction.version + 1;
  update public.transaction_files set requirement_snapshot = next_snapshot, lifecycle = 'ACCUMULATING',
    approved_by = null, approved_at = null, version = next_version, last_material_activity_at = now(),
    last_material_resolver_id = actor, updated_at = now() where id = transaction.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (transaction.tenant_id, 'TRANSACTION_FILE', transaction.id, next_version, 'TRANSACTION_REQUIREMENT_REMOVED', actor,
      jsonb_build_object('kind', target_kind, 'key', target_key, 'previous_lifecycle', transaction.lifecycle));
  return next_version;
end $$;

revoke all on function public.update_transaction_file_details(uuid, integer, text, text, text, text, text, uuid) from public, anon;
revoke all on function public.remove_transaction_requirement(uuid, integer, text, text, uuid) from public, anon;
grant execute on function public.update_transaction_file_details(uuid, integer, text, text, text, text, text, uuid) to authenticated;
grant execute on function public.remove_transaction_requirement(uuid, integer, text, text, uuid) to authenticated;
