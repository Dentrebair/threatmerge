create or replace function app_private.valid_approval_condition(condition jsonb)
returns boolean language plpgsql immutable set search_path = public, pg_temp as $$
declare child jsonb; condition_type text;
begin
  if jsonb_typeof(condition) <> 'object' then return false; end if;
  if condition ? 'conditions' then
    if upper(coalesce(condition->>'operator', '')) not in ('AND','OR')
      or jsonb_typeof(condition->'conditions') <> 'array'
      or jsonb_array_length(condition->'conditions') = 0
      or jsonb_array_length(condition->'conditions') > 20 then return false; end if;
    for child in select value from jsonb_array_elements(condition->'conditions') loop
      if not app_private.valid_approval_condition(child) then return false; end if;
    end loop;
    return true;
  end if;
  condition_type := condition->>'type';
  if condition_type = 'TOTAL_ABOVE' then return jsonb_typeof(condition->'value') = 'number' and (condition->>'value')::numeric >= 0;
  elsif condition_type = 'NEW_ISSUER' then return (select count(*) from jsonb_object_keys(condition)) = 1;
  elsif condition_type = 'ISSUER' then return jsonb_typeof(condition->'value') = 'string' and (condition->>'value')::uuid is not null;
  elsif condition_type = 'ORIGIN' then return condition->>'value' in ('CAPTURED','GENERATED');
  elsif condition_type = 'LOW_CONFIDENCE' then return jsonb_typeof(condition->'value') = 'number' and (condition->>'value')::numeric between 0 and 1;
  elsif condition_type in ('FIELD_EQUALS','VARIANCE_ABOVE') then
    return length(trim(coalesce(condition->>'field',''))) > 0 and condition ? 'value';
  end if;
  return false;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;

create or replace function public.publish_approval_policy(
  target_tenant uuid,
  target_mode text,
  target_rules jsonb,
  actor uuid
)
returns public.approval_policy_versions
language plpgsql security definer set search_path = public, pg_temp as $$
declare next_version integer; created public.approval_policy_versions%rowtype;
begin
  if actor is distinct from auth.uid() then raise exception 'actor does not match authenticated user'; end if;
  if not app_private.has_tenant_role(target_tenant, array['TENANT_ADMIN']::public.workspace_role[]) then
    raise exception 'only tenant administrators can publish approval policies';
  end if;
  if target_mode not in ('MANDATORY','CONDITIONAL','AUTOMATIC') then raise exception 'invalid approval mode'; end if;
  if jsonb_typeof(target_rules) <> 'object' then raise exception 'policy rules must be an object'; end if;
  if target_mode = 'CONDITIONAL' and (not target_rules ? 'reviewWhen' or not app_private.valid_approval_condition(target_rules->'reviewWhen')) then
    raise exception 'conditional policy requires a valid reviewWhen condition group';
  end if;
  if target_mode <> 'CONDITIONAL' and target_rules <> '{}'::jsonb then raise exception 'rules are only supported for conditional policies'; end if;

  perform 1 from public.tenants where id = target_tenant for update;
  if not found then raise exception 'workspace not found'; end if;
  select coalesce(max(version), 0) + 1 into next_version from public.approval_policy_versions where tenant_id = target_tenant;
  insert into public.approval_policy_versions (tenant_id, version, mode, rules, published_at)
    values (target_tenant, next_version, target_mode, target_rules, now()) returning * into created;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (target_tenant, 'APPROVAL_POLICY', created.id, created.version, 'APPROVAL_POLICY_PUBLISHED', actor,
      jsonb_build_object('mode', created.mode, 'rules', created.rules));
  return created;
end $$;

revoke all on function public.publish_approval_policy(uuid, text, jsonb, uuid) from public, anon;
grant execute on function public.publish_approval_policy(uuid, text, jsonb, uuid) to authenticated;
