create table public.transaction_custom_field_definitions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_file_id uuid not null,
  field_key text not null check (field_key ~ '^[a-z][a-z0-9_-]{1,79}$'),
  label text not null check (length(trim(label)) between 1 and 120),
  data_type text not null check (data_type in ('TEXT','NUMBER','BOOLEAN','DATE')),
  required boolean not null default false,
  stage_gate text not null default 'BEFORE_REVIEW'
    check (stage_gate in ('BEFORE_REVIEW','BEFORE_APPROVAL','BEFORE_CLOSING')),
  validation jsonb not null default '{}'::jsonb check (jsonb_typeof(validation) = 'object'),
  source text not null default 'TRANSACTION' check (source in ('TEMPLATE','TRANSACTION')),
  template_version_id uuid,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, transaction_file_id, field_key),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  foreign key (tenant_id, template_version_id) references public.transaction_template_versions(tenant_id, id),
  foreign key (tenant_id, created_by) references public.tenant_memberships(tenant_id, user_id),
  check ((source = 'TEMPLATE') = (template_version_id is not null))
);

create table public.transaction_custom_field_values (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_file_id uuid not null,
  definition_id uuid not null,
  normalized_value jsonb not null,
  provenance jsonb not null default '{"method":"MANUAL"}'::jsonb check (jsonb_typeof(provenance) = 'object'),
  verified_by uuid,
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, transaction_file_id, definition_id),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  foreign key (tenant_id, definition_id) references public.transaction_custom_field_definitions(tenant_id, id),
  foreign key (tenant_id, verified_by) references public.tenant_memberships(tenant_id, user_id),
  foreign key (tenant_id, updated_by) references public.tenant_memberships(tenant_id, user_id)
);

alter table public.transaction_custom_field_definitions enable row level security;
alter table public.transaction_custom_field_values enable row level security;
create policy tenant_isolation on public.transaction_custom_field_definitions
  for select using (app_private.is_tenant_member(tenant_id));
create policy tenant_isolation on public.transaction_custom_field_values
  for select using (app_private.is_tenant_member(tenant_id));
grant select on public.transaction_custom_field_definitions, public.transaction_custom_field_values to authenticated;

create trigger guard_transaction_custom_definition_write
before insert or update or delete on public.transaction_custom_field_definitions
for each row execute function app_private.guard_transaction_child_write();
create trigger guard_transaction_custom_value_write
before insert or update or delete on public.transaction_custom_field_values
for each row execute function app_private.guard_transaction_child_write();

create or replace function app_private.valid_custom_field_value(
  target_type text, target_value jsonb, validation jsonb
)
returns boolean language plpgsql immutable set search_path = public, pg_temp as $$
declare text_value text; number_value numeric;
begin
  if target_value is null or target_value = 'null'::jsonb then return false; end if;
  if target_type = 'TEXT' then
    if jsonb_typeof(target_value) <> 'string' then return false; end if;
    text_value := target_value #>> '{}';
    if validation ? 'minLength' and length(text_value) < (validation->>'minLength')::integer then return false; end if;
    if validation ? 'maxLength' and length(text_value) > (validation->>'maxLength')::integer then return false; end if;
    if validation ? 'options' and not exists (select 1 from jsonb_array_elements_text(validation->'options') option where option = text_value) then return false; end if;
    return true;
  elsif target_type = 'NUMBER' then
    if jsonb_typeof(target_value) <> 'number' then return false; end if;
    number_value := (target_value #>> '{}')::numeric;
    if validation ? 'minimum' and number_value < (validation->>'minimum')::numeric then return false; end if;
    if validation ? 'maximum' and number_value > (validation->>'maximum')::numeric then return false; end if;
    return true;
  elsif target_type = 'BOOLEAN' then return jsonb_typeof(target_value) = 'boolean';
  elsif target_type = 'DATE' then
    return jsonb_typeof(target_value) = 'string' and (target_value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$'
      and ((target_value #>> '{}')::date)::text = target_value #>> '{}';
  end if;
  return false;
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then return false;
end $$;

create or replace function public.add_transaction_custom_field(
  target_transaction uuid, expected_version integer, target_key text, target_label text,
  target_type text, target_required boolean, target_gate text, target_validation jsonb, actor uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; definition_id uuid; normalized_key text;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then raise exception 'only the assigned owner, coordinator, or administrator can manage this file'; end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  normalized_key := lower(trim(coalesce(target_key, '')));
  if normalized_key !~ '^[a-z][a-z0-9_-]{1,79}$' then raise exception 'field key must use lowercase letters, numbers, hyphens, or underscores'; end if;
  if length(trim(coalesce(target_label, ''))) not between 1 and 120 then raise exception 'field label is required'; end if;
  if target_type not in ('TEXT','NUMBER','BOOLEAN','DATE') then raise exception 'field type is invalid'; end if;
  if target_gate not in ('BEFORE_REVIEW','BEFORE_APPROVAL','BEFORE_CLOSING') then raise exception 'field gate is invalid'; end if;
  if jsonb_typeof(target_validation) <> 'object' then raise exception 'field validation is invalid'; end if;
  if target_validation ? 'options' and (target_type <> 'TEXT' or jsonb_typeof(target_validation->'options') <> 'array') then raise exception 'field options are invalid'; end if;
  insert into public.transaction_custom_field_definitions
    (tenant_id, transaction_file_id, field_key, label, data_type, required, stage_gate, validation, created_by)
  values (file.tenant_id, file.id, normalized_key, trim(target_label), target_type, target_required, target_gate, target_validation, actor)
  returning id into definition_id;
  perform app_private.invalidate_transaction_review(file.id);
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_CUSTOM_FIELD_ADDED', actor,
      jsonb_build_object('definition_id', definition_id, 'field_key', normalized_key, 'data_type', target_type,
        'required', target_required, 'stage_gate', target_gate));
  return definition_id;
exception when unique_violation then raise exception 'a custom field with this key already exists';
end $$;

create or replace function public.set_transaction_custom_field_value(
  target_transaction uuid, expected_version integer, target_definition uuid,
  target_value jsonb, target_provenance jsonb, actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; definition public.transaction_custom_field_definitions%rowtype;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then raise exception 'only the assigned owner, coordinator, or administrator can manage this file'; end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  select * into definition from public.transaction_custom_field_definitions
    where tenant_id = file.tenant_id and transaction_file_id = file.id and id = target_definition;
  if not found then raise exception 'custom field not found'; end if;
  if not app_private.valid_custom_field_value(definition.data_type, target_value, definition.validation) then
    raise exception 'value does not match the custom field rules';
  end if;
  if jsonb_typeof(target_provenance) <> 'object' then raise exception 'field provenance is invalid'; end if;
  insert into public.transaction_custom_field_values
    (tenant_id, transaction_file_id, definition_id, normalized_value, provenance, updated_by)
  values (file.tenant_id, file.id, definition.id, target_value, target_provenance, actor)
  on conflict (tenant_id, transaction_file_id, definition_id) do update
    set normalized_value = excluded.normalized_value, provenance = excluded.provenance,
      verified_by = null, updated_by = excluded.updated_by, updated_at = now();
  perform app_private.invalidate_transaction_review(file.id);
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_CUSTOM_FIELD_VALUE_SET', actor,
      jsonb_build_object('definition_id', definition.id, 'field_key', definition.field_key));
  return file.version + 1;
end $$;

create or replace function public.submit_transaction_for_review(target_transaction uuid, expected_version integer, actor uuid)
returns public.transaction_stage
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; requirement_blockers integer; field_blockers integer;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then raise exception 'only the assigned owner, coordinator, or administrator can manage this file'; end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage <> 'DOCUMENTS_PENDING' then raise exception 'Transaction File is not collecting documents'; end if;
  select count(*) into requirement_blockers from public.transaction_requirement_statuses
    where tenant_id = file.tenant_id and transaction_file_id = file.id
      and stage_gate = 'BEFORE_REVIEW' and status <> 'PRESENT';
  select count(*) into field_blockers from public.transaction_custom_field_definitions definition
    where definition.tenant_id = file.tenant_id and definition.transaction_file_id = file.id
      and definition.required and definition.stage_gate = 'BEFORE_REVIEW'
      and not exists (select 1 from public.transaction_custom_field_values value
        where value.tenant_id = definition.tenant_id and value.transaction_file_id = definition.transaction_file_id
          and value.definition_id = definition.id);
  if requirement_blockers + field_blockers > 0 then
    raise exception 'complete % Before Review item(s)', requirement_blockers + field_blockers;
  end if;
  update public.transaction_files set business_stage = 'UNDER_REVIEW', version = version + 1, updated_at = now() where id = file.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id,
    metadata) values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1,
      'TRANSACTION_SUBMITTED_FOR_REVIEW', actor,
      jsonb_build_object('requirement_count', requirement_blockers, 'custom_field_count', field_blockers));
  return 'UNDER_REVIEW';
end $$;

revoke all on function public.add_transaction_custom_field(uuid, integer, text, text, text, boolean, text, jsonb, uuid) from public, anon;
revoke all on function public.set_transaction_custom_field_value(uuid, integer, uuid, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.add_transaction_custom_field(uuid, integer, text, text, text, boolean, text, jsonb, uuid) to authenticated;
grant execute on function public.set_transaction_custom_field_value(uuid, integer, uuid, jsonb, jsonb, uuid) to authenticated;
