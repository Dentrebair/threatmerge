alter table public.transaction_requirement_statuses
  add column resolved_value text;

alter table public.transaction_requirement_statuses
  add check (resolved_value is null or length(trim(resolved_value)) > 0);

create or replace function public.set_transaction_requirement_value(
  target_transaction uuid, expected_version integer, target_key text,
  target_value text, actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; next_version integer;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then
    raise exception 'only the assigned owner, coordinator, or administrator can manage this file';
  end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  if length(trim(coalesce(target_value, ''))) = 0 then raise exception 'required information value is empty'; end if;

  update public.transaction_requirement_statuses
    set resolved_value = trim(target_value), status = 'PRESENT', confidence = 1,
      resolved_by = actor, updated_at = now()
    where tenant_id = file.tenant_id and transaction_file_id = file.id
      and requirement_kind = 'FIELD' and requirement_key = target_key;
  if not found then raise exception 'required information field not found'; end if;

  perform app_private.invalidate_transaction_review(file.id);
  select version into next_version from public.transaction_files where id = file.id;
  insert into public.audit_events
    (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
  values (file.tenant_id, 'TRANSACTION_FILE', file.id, next_version,
    'TRANSACTION_REQUIRED_INFORMATION_SET', actor,
    jsonb_build_object('requirement_key', target_key));
  return next_version;
end $$;

create or replace function app_private.sync_transaction_requirement_work_item()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare owner_id uuid; blocker text; work_kind text;
begin
  blocker := 'REQUIREMENT:' || new.requirement_kind || ':' || new.requirement_key;
  select assignment.user_id into owner_id
    from public.transaction_team_assignments assignment
    where assignment.tenant_id = new.tenant_id
      and assignment.transaction_file_id = new.transaction_file_id
      and assignment.responsibility = 'OWNER';
  if new.status = 'PRESENT' then
    update public.work_items set status = 'RESOLVED', resolved_at = now()
      where tenant_id = new.tenant_id and record_type = 'TRANSACTION_FILE'
        and record_id = new.transaction_file_id and blocker_code = blocker
        and status in ('OPEN','WAITING_FOR_EVIDENCE');
  else
    work_kind := case
      when new.status = 'CONFLICT' then 'RESOLVE_CONFLICT'
      when new.status = 'LOW_CONFIDENCE' then 'CONFIRM_INFORMATION'
      when new.requirement_kind = 'ARTIFACT' then 'PROVIDE_DOCUMENT'
      else 'PROVIDE_INFORMATION' end;
    if not exists (
      select 1 from public.work_items where tenant_id = new.tenant_id
        and record_type = 'TRANSACTION_FILE' and record_id = new.transaction_file_id
        and blocker_code = blocker and status in ('OPEN','WAITING_FOR_EVIDENCE')
    ) then
      insert into public.work_items
        (tenant_id, record_type, record_id, kind, status, assigned_to, blocker_code)
      values (new.tenant_id, 'TRANSACTION_FILE', new.transaction_file_id, work_kind,
        case when new.requirement_kind = 'ARTIFACT' then 'WAITING_FOR_EVIDENCE' else 'OPEN' end,
        owner_id, blocker);
    else
      update public.work_items set kind = work_kind, assigned_to = coalesce(assigned_to, owner_id),
        status = case when new.requirement_kind = 'ARTIFACT' then 'WAITING_FOR_EVIDENCE' else 'OPEN' end,
        resolved_at = null
      where tenant_id = new.tenant_id and record_type = 'TRANSACTION_FILE'
        and record_id = new.transaction_file_id and blocker_code = blocker
        and status in ('OPEN','WAITING_FOR_EVIDENCE');
    end if;
  end if;
  return new;
end $$;

create trigger sync_transaction_requirement_work_item
after insert or update of status on public.transaction_requirement_statuses
for each row execute function app_private.sync_transaction_requirement_work_item();

insert into public.work_items (tenant_id, record_type, record_id, kind, status, assigned_to, blocker_code)
select requirement.tenant_id, 'TRANSACTION_FILE', requirement.transaction_file_id,
  case when requirement.status = 'CONFLICT' then 'RESOLVE_CONFLICT'
    when requirement.status = 'LOW_CONFIDENCE' then 'CONFIRM_INFORMATION'
    when requirement.requirement_kind = 'ARTIFACT' then 'PROVIDE_DOCUMENT'
    else 'PROVIDE_INFORMATION' end,
  case when requirement.requirement_kind = 'ARTIFACT' then 'WAITING_FOR_EVIDENCE' else 'OPEN' end,
  owner.user_id,
  'REQUIREMENT:' || requirement.requirement_kind || ':' || requirement.requirement_key
from public.transaction_requirement_statuses requirement
left join public.transaction_team_assignments owner
  on owner.tenant_id = requirement.tenant_id
  and owner.transaction_file_id = requirement.transaction_file_id
  and owner.responsibility = 'OWNER'
where requirement.status <> 'PRESENT'
  and not exists (
    select 1 from public.work_items work where work.tenant_id = requirement.tenant_id
      and work.record_type = 'TRANSACTION_FILE' and work.record_id = requirement.transaction_file_id
      and work.blocker_code = 'REQUIREMENT:' || requirement.requirement_kind || ':' || requirement.requirement_key
      and work.status in ('OPEN','WAITING_FOR_EVIDENCE')
  );

revoke all on function public.set_transaction_requirement_value(uuid, integer, text, text, uuid) from public, anon;
grant execute on function public.set_transaction_requirement_value(uuid, integer, text, text, uuid) to authenticated;
