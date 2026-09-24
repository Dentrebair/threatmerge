alter table public.transaction_requirement_statuses
  add column stage_gate text not null default 'BEFORE_REVIEW'
    check (stage_gate in ('BEFORE_REVIEW','BEFORE_APPROVAL','BEFORE_CLOSING')),
  add column requirement_source text not null default 'TRANSACTION'
    check (requirement_source in ('TEMPLATE','TRANSACTION')),
  add column template_mandated boolean not null default false;

create or replace function app_private.can_manage_transaction(target_tenant uuid, target_transaction uuid, actor uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select actor = auth.uid() and (
    app_private.has_tenant_role(target_tenant, array['TENANT_ADMIN']::public.workspace_role[])
    or exists (
      select 1 from public.transaction_team_assignments assignment
      where assignment.tenant_id = target_tenant and assignment.transaction_file_id = target_transaction
        and assignment.user_id = actor and assignment.responsibility in ('OWNER','COORDINATOR')
    )
  );
$$;

create or replace function public.create_transaction_file_v2(
  target_tenant uuid, target_external_reference text, target_property_address text,
  target_transaction_type uuid, target_owner uuid, target_primary_party_name text,
  target_primary_party_kind text, target_primary_party_role text, actor uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction_id uuid; party_id uuid; template public.transaction_template_versions%rowtype; type_row public.transaction_types%rowtype; requirement jsonb;
begin
  perform app_private.assert_reviewer(target_tenant, actor);
  if length(trim(coalesce(target_property_address, ''))) = 0 then raise exception 'property address is required'; end if;
  select * into type_row from public.transaction_types where tenant_id = target_tenant and id = target_transaction_type and active;
  if not found then raise exception 'transaction type is unavailable'; end if;
  if not exists (select 1 from public.tenant_memberships where tenant_id = target_tenant and user_id = target_owner and active and role <> 'INTEGRATION') then raise exception 'assigned owner is unavailable'; end if;
  if length(trim(coalesce(target_primary_party_name, ''))) = 0 then raise exception 'primary party name is required'; end if;
  if target_primary_party_kind not in ('PERSON','ORGANIZATION') then raise exception 'primary party type is invalid'; end if;
  if target_primary_party_role not in ('BUYER','SELLER','TENANT','LANDLORD') then raise exception 'primary party role is invalid'; end if;
  select * into template from public.transaction_template_versions
    where tenant_id = target_tenant and transaction_type_id = type_row.id and published_at is not null order by version desc limit 1;
  insert into public.transaction_files (tenant_id, external_reference, property_address, transaction_type,
    transaction_type_id, template_version_id, lifecycle, business_stage, requirement_snapshot)
  values (target_tenant, nullif(trim(target_external_reference), ''), trim(target_property_address), type_row.code,
    type_row.id, template.id, 'ACCUMULATING', 'DRAFT', coalesce(template.configuration->'requirements', '{"artifacts":[],"fields":[]}'::jsonb))
  returning id into transaction_id;
  insert into public.transaction_team_assignments (tenant_id, transaction_file_id, user_id, responsibility)
    values (target_tenant, transaction_id, target_owner, 'OWNER');
  insert into public.transaction_parties (tenant_id, display_name, normalized_name, party_kind)
    values (target_tenant, trim(target_primary_party_name), lower(regexp_replace(trim(target_primary_party_name), '\s+', ' ', 'g')), target_primary_party_kind)
    returning id into party_id;
  insert into public.transaction_party_assignments (tenant_id, transaction_file_id, party_id, role, is_primary)
    values (target_tenant, transaction_id, party_id, target_primary_party_role::public.transaction_party_role, true);
  if template.id is not null then
    for requirement in select value from jsonb_array_elements(template.configuration->'requirements'->'artifacts') loop
      insert into public.transaction_requirement_statuses (tenant_id, transaction_file_id, requirement_kind, requirement_key, stage_gate, requirement_source, template_mandated)
        values (target_tenant, transaction_id, 'ARTIFACT', requirement->>'key', requirement->>'gate', 'TEMPLATE', true);
    end loop;
    for requirement in select value from jsonb_array_elements(template.configuration->'requirements'->'fields') loop
      insert into public.transaction_requirement_statuses (tenant_id, transaction_file_id, requirement_kind, requirement_key, stage_gate, requirement_source, template_mandated)
        values (target_tenant, transaction_id, 'FIELD', requirement->>'key', requirement->>'gate', 'TEMPLATE', true);
    end loop;
  end if;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (target_tenant, 'TRANSACTION_FILE', transaction_id, 1, 'TRANSACTION_FILE_V2_CREATED', actor,
      jsonb_build_object('transaction_type_id', type_row.id, 'owner_user_id', target_owner, 'primary_party_id', party_id,
        'primary_party_role', target_primary_party_role, 'template_version_id', template.id));
  return transaction_id;
end $$;

create or replace function public.begin_transaction_work(target_transaction uuid, expected_version integer, actor uuid)
returns public.transaction_stage
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'transaction file not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then raise exception 'only the assigned owner, coordinator, or administrator can manage this file'; end if;
  if file.version <> expected_version then raise exception 'transaction file changed; refresh and try again'; end if;
  if file.business_stage <> 'DRAFT' then raise exception 'transaction file is not in Draft'; end if;
  update public.transaction_files set business_stage = 'DOCUMENTS_PENDING', version = version + 1,
    last_material_activity_at = now(), updated_at = now() where id = file.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_WORK_BEGAN', actor);
  return 'DOCUMENTS_PENDING';
end $$;

create or replace function public.submit_transaction_for_review(target_transaction uuid, expected_version integer, actor uuid)
returns public.transaction_stage
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; blockers integer;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'transaction file not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then raise exception 'only the assigned owner, coordinator, or administrator can manage this file'; end if;
  if file.version <> expected_version then raise exception 'transaction file changed; refresh and try again'; end if;
  if file.business_stage <> 'DOCUMENTS_PENDING' then raise exception 'transaction file is not collecting documents'; end if;
  select count(*) into blockers from public.transaction_requirement_statuses
    where tenant_id = file.tenant_id and transaction_file_id = file.id
      and stage_gate = 'BEFORE_REVIEW' and status <> 'PRESENT';
  if blockers > 0 then raise exception 'complete % Before Review requirement(s)', blockers; end if;
  update public.transaction_files set business_stage = 'UNDER_REVIEW', version = version + 1, updated_at = now() where id = file.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_SUBMITTED_FOR_REVIEW', actor);
  return 'UNDER_REVIEW';
end $$;

revoke all on function public.begin_transaction_work(uuid, integer, uuid) from public, anon;
revoke all on function public.submit_transaction_for_review(uuid, integer, uuid) from public, anon;
grant execute on function public.begin_transaction_work(uuid, integer, uuid) to authenticated;
grant execute on function public.submit_transaction_for_review(uuid, integer, uuid) to authenticated;
