create type public.issue_severity as enum ('LOW','MEDIUM','HIGH','CRITICAL');

alter table public.work_items
  add column title text,
  add column category text,
  add column severity public.issue_severity not null default 'MEDIUM',
  add column is_blocking boolean not null default false,
  add column due_date date,
  add column resolution text,
  add column created_by uuid,
  add foreign key (tenant_id, created_by) references public.tenant_memberships(tenant_id, user_id),
  add check (title is null or length(trim(title)) between 2 and 160),
  add check (category is null or length(trim(category)) between 2 and 60),
  add check (resolution is null or length(trim(resolution)) between 2 and 1000);

create or replace function public.create_transaction_issue(
  target_transaction uuid, expected_version integer, target_title text, target_category text,
  target_severity text, target_blocking boolean, target_owner uuid, target_due_date date, actor uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; issue_id uuid; normalized_severity public.issue_severity;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then
    raise exception 'only the assigned owner, coordinator, or administrator can manage this file';
  end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  if length(trim(coalesce(target_title, ''))) not between 2 and 160 then raise exception 'issue title is required'; end if;
  if length(trim(coalesce(target_category, ''))) not between 2 and 60 then raise exception 'issue category is required'; end if;
  if target_severity not in ('LOW','MEDIUM','HIGH','CRITICAL') then raise exception 'issue severity is invalid'; end if;
  normalized_severity := target_severity::public.issue_severity;
  if target_owner is not null and not exists (select 1 from public.tenant_memberships membership
    where membership.tenant_id = file.tenant_id and membership.user_id = target_owner and membership.active) then
    raise exception 'issue owner must belong to this workspace';
  end if;
  insert into public.work_items
    (tenant_id, record_type, record_id, kind, blocker_code, assigned_to, title, category,
      severity, is_blocking, due_date, created_by)
  values (file.tenant_id, 'TRANSACTION_FILE', file.id, 'TRANSACTION_ISSUE',
    'ISSUE:MANUAL', target_owner, trim(target_title), trim(target_category), normalized_severity,
    coalesce(target_blocking, false), target_due_date, actor)
  returning id into issue_id;
  update public.transaction_files set version = version + 1, updated_at = now() where id = file.id;
  insert into public.audit_events
    (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
  values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_ISSUE_CREATED', actor,
    jsonb_build_object('issue_id', issue_id, 'title', trim(target_title), 'category', trim(target_category),
      'severity', normalized_severity, 'blocking', coalesce(target_blocking, false), 'owner', target_owner,
      'due_date', target_due_date));
  return issue_id;
end $$;

create or replace function public.resolve_transaction_issue(
  target_issue uuid, expected_version integer, target_resolution text, actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare issue public.work_items%rowtype; file public.transaction_files%rowtype;
begin
  select * into issue from public.work_items where id = target_issue for update;
  if not found or issue.record_type <> 'TRANSACTION_FILE' then raise exception 'issue not found'; end if;
  select * into file from public.transaction_files where tenant_id = issue.tenant_id and id = issue.record_id for update;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then
    raise exception 'only the assigned owner, coordinator, or administrator can manage this file';
  end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if issue.status not in ('OPEN','WAITING_FOR_EVIDENCE') then raise exception 'issue is already resolved'; end if;
  if length(trim(coalesce(target_resolution, ''))) not between 2 and 1000 then raise exception 'resolution is required'; end if;
  update public.work_items set status = 'RESOLVED', resolution = trim(target_resolution),
    resolved_at = now() where id = issue.id;
  update public.transaction_files set version = version + 1, updated_at = now() where id = file.id;
  insert into public.audit_events
    (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
  values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_ISSUE_RESOLVED', actor,
    jsonb_build_object('issue_id', issue.id, 'resolution', trim(target_resolution)));
  return file.version + 1;
end $$;

create or replace function public.list_transaction_issues(target_tenant uuid)
returns table (
  issue_id uuid, transaction_file_id uuid, title text, category text, severity public.issue_severity,
  is_blocking boolean, status text, owner_user_id uuid, due_date date, resolution text,
  source text, created_at timestamptz, resolved_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query
    select work.id, work.record_id,
      coalesce(work.title, case
        when work.kind = 'PROVIDE_DOCUMENT' then 'Missing document'
        when work.kind = 'PROVIDE_INFORMATION' then 'Missing information'
        when work.kind = 'RESOLVE_CONFLICT' then 'Conflicting information'
        when work.kind = 'CONFIRM_INFORMATION' then 'Information needs confirmation'
        else initcap(replace(work.kind, '_', ' ')) end),
      coalesce(work.category, case when work.blocker_code like 'REQUIREMENT:%' then 'REQUIREMENT' else 'WORKFLOW' end),
      work.severity, work.is_blocking or work.blocker_code is not null, work.status,
      work.assigned_to, work.due_date, work.resolution,
      case when work.kind = 'TRANSACTION_ISSUE' then 'MANUAL' else 'GENERATED' end,
      work.created_at, work.resolved_at
    from public.work_items work
    where work.tenant_id = target_tenant and work.record_type = 'TRANSACTION_FILE'
      and (work.kind = 'TRANSACTION_ISSUE' or work.blocker_code is not null)
    order by (work.status in ('OPEN','WAITING_FOR_EVIDENCE')) desc,
      (work.is_blocking or work.blocker_code is not null) desc, work.created_at desc;
end $$;

revoke all on function public.create_transaction_issue(uuid, integer, text, text, text, boolean, uuid, date, uuid) from public, anon;
revoke all on function public.resolve_transaction_issue(uuid, integer, text, uuid) from public, anon;
revoke all on function public.list_transaction_issues(uuid) from public, anon;
grant execute on function public.create_transaction_issue(uuid, integer, text, text, text, boolean, uuid, date, uuid) to authenticated;
grant execute on function public.resolve_transaction_issue(uuid, integer, text, uuid) to authenticated;
grant execute on function public.list_transaction_issues(uuid) to authenticated;
