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

  next_snapshot := jsonb_set(
    transaction.requirement_snapshot,
    case
      when target_kind = 'ARTIFACT' then array['artifacts']::text[]
      else array['fields']::text[]
    end,
    coalesce(
      transaction.requirement_snapshot -> case when target_kind = 'ARTIFACT' then 'artifacts' else 'fields' end,
      '[]'::jsonb
    ) || to_jsonb(normalized_key)
  );
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

revoke all on function public.add_transaction_requirement(uuid, integer, text, text, uuid) from public, anon;
grant execute on function public.add_transaction_requirement(uuid, integer, text, text, uuid) to authenticated;
