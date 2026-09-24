create or replace function app_private.valid_transaction_template(configuration jsonb)
returns boolean language plpgsql immutable set search_path = public, pg_temp as $$
declare weights jsonb; weight_total numeric;
begin
  if jsonb_typeof(configuration) <> 'object' then return false; end if;
  if not configuration ? 'requirements' or jsonb_typeof(configuration->'requirements') <> 'object'
    or jsonb_typeof(configuration->'requirements'->'artifacts') <> 'array'
    or jsonb_typeof(configuration->'requirements'->'fields') <> 'array' then return false; end if;
  if exists (select 1 from jsonb_array_elements(configuration->'requirements'->'artifacts') item
    where jsonb_typeof(item) <> 'object' or length(trim(coalesce(item->>'key',''))) = 0
      or coalesce(item->>'gate','') not in ('BEFORE_REVIEW','BEFORE_APPROVAL','BEFORE_CLOSING')) then return false; end if;
  if exists (select 1 from jsonb_array_elements(configuration->'requirements'->'fields') item
    where jsonb_typeof(item) <> 'object' or length(trim(coalesce(item->>'key',''))) = 0
      or coalesce(item->>'gate','') not in ('BEFORE_REVIEW','BEFORE_APPROVAL','BEFORE_CLOSING')) then return false; end if;
  if configuration ? 'paymentPolicy' and (
    jsonb_typeof(configuration->'paymentPolicy') <> 'object'
    or jsonb_typeof(configuration->'paymentPolicy'->'requireApprovedInvoices') <> 'boolean'
    or jsonb_typeof(configuration->'paymentPolicy'->'allowDeferredPayments') <> 'boolean'
  ) then return false; end if;
  if configuration ? 'healthWeights' then
    weights := configuration->'healthWeights';
    if jsonb_typeof(weights) <> 'object' or exists (
      select 1 from jsonb_each(weights) entry where jsonb_typeof(entry.value) <> 'number' or (entry.value #>> '{}')::numeric < 0
    ) then return false; end if;
    select coalesce(sum((value #>> '{}')::numeric), 0) into weight_total from jsonb_each(weights);
    if weight_total <> 100 then return false; end if;
  end if;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end $$;

create or replace function public.create_transaction_type(
  target_tenant uuid, target_code text, target_name text, actor uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare created_id uuid; normalized_code text;
begin
  if actor is distinct from auth.uid() then raise exception 'actor does not match authenticated user'; end if;
  if not app_private.has_tenant_role(target_tenant, array['TENANT_ADMIN']::public.workspace_role[]) then
    raise exception 'only tenant administrators can manage transaction types';
  end if;
  normalized_code := upper(trim(coalesce(target_code, '')));
  if normalized_code !~ '^[A-Z][A-Z0-9_]{1,39}$' then raise exception 'transaction type code is invalid'; end if;
  if length(trim(coalesce(target_name, ''))) not between 2 and 80 then raise exception 'transaction type name is invalid'; end if;
  insert into public.transaction_types (tenant_id, code, name)
    values (target_tenant, normalized_code, trim(target_name)) returning id into created_id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (target_tenant, 'TRANSACTION_TYPE', created_id, 1, 'TRANSACTION_TYPE_CREATED', actor,
      jsonb_build_object('code', normalized_code, 'name', trim(target_name)));
  return created_id;
exception when unique_violation then raise exception 'transaction type code already exists';
end $$;

create or replace function public.set_transaction_type_active(
  target_type uuid, target_active boolean, actor uuid
)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare type_row public.transaction_types%rowtype;
begin
  select * into type_row from public.transaction_types where id = target_type for update;
  if not found then raise exception 'transaction type not found'; end if;
  if actor is distinct from auth.uid() then raise exception 'actor does not match authenticated user'; end if;
  if not app_private.has_tenant_role(type_row.tenant_id, array['TENANT_ADMIN']::public.workspace_role[]) then
    raise exception 'only tenant administrators can manage transaction types';
  end if;
  update public.transaction_types set active = target_active where id = type_row.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (type_row.tenant_id, 'TRANSACTION_TYPE', type_row.id,
      (select count(*)::integer + 1 from public.audit_events where tenant_id = type_row.tenant_id and aggregate_type = 'TRANSACTION_TYPE' and aggregate_id = type_row.id),
      case when target_active then 'TRANSACTION_TYPE_ACTIVATED' else 'TRANSACTION_TYPE_DEACTIVATED' end,
      actor, jsonb_build_object('active', target_active));
  return target_active;
end $$;

create or replace function public.publish_transaction_template(
  target_type uuid, target_configuration jsonb, actor uuid
)
returns public.transaction_template_versions
language plpgsql security definer set search_path = public, pg_temp as $$
declare type_row public.transaction_types%rowtype; next_version integer; created public.transaction_template_versions%rowtype;
begin
  select * into type_row from public.transaction_types where id = target_type for update;
  if not found then raise exception 'transaction type not found'; end if;
  if actor is distinct from auth.uid() then raise exception 'actor does not match authenticated user'; end if;
  if not app_private.has_tenant_role(type_row.tenant_id, array['TENANT_ADMIN']::public.workspace_role[]) then
    raise exception 'only tenant administrators can publish transaction templates';
  end if;
  if not type_row.active then raise exception 'activate the transaction type before publishing a template'; end if;
  if not app_private.valid_transaction_template(target_configuration) then raise exception 'transaction template is invalid'; end if;
  select coalesce(max(version), 0) + 1 into next_version from public.transaction_template_versions
    where tenant_id = type_row.tenant_id and transaction_type_id = type_row.id;
  insert into public.transaction_template_versions
    (tenant_id, transaction_type_id, version, configuration, published_at, published_by)
  values (type_row.tenant_id, type_row.id, next_version, target_configuration, now(), actor)
  returning * into created;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (type_row.tenant_id, 'TRANSACTION_TEMPLATE', created.id, created.version, 'TRANSACTION_TEMPLATE_PUBLISHED', actor,
      jsonb_build_object('transaction_type_id', type_row.id, 'version', created.version));
  return created;
end $$;

revoke all on function public.create_transaction_type(uuid, text, text, uuid) from public, anon;
revoke all on function public.set_transaction_type_active(uuid, boolean, uuid) from public, anon;
revoke all on function public.publish_transaction_template(uuid, jsonb, uuid) from public, anon;
grant execute on function public.create_transaction_type(uuid, text, text, uuid) to authenticated;
grant execute on function public.set_transaction_type_active(uuid, boolean, uuid) to authenticated;
grant execute on function public.publish_transaction_template(uuid, jsonb, uuid) to authenticated;
