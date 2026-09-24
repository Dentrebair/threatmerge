create or replace function app_private.valid_transaction_requirements(requirements jsonb)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select jsonb_typeof(requirements) = 'object'
    and jsonb_typeof(requirements->'artifacts') = 'array'
    and jsonb_typeof(requirements->'fields') = 'array'
    and jsonb_array_length(requirements->'artifacts') <= 50
    and jsonb_array_length(requirements->'fields') <= 100
    and jsonb_array_length(requirements->'artifacts') + jsonb_array_length(requirements->'fields') > 0
    and not exists (
      select 1 from jsonb_array_elements(requirements->'artifacts') value
      where jsonb_typeof(value) <> 'string' or length(trim(value #>> '{}')) = 0
    )
    and not exists (
      select 1 from jsonb_array_elements(requirements->'fields') value
      where jsonb_typeof(value) <> 'string' or length(trim(value #>> '{}')) = 0
    );
$$;

create or replace function app_private.guard_transaction_readiness()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare requirement_count integer; blocker_count integer;
begin
  if new.lifecycle in ('CONVERGED','APPROVED') and new.lifecycle is distinct from old.lifecycle then
    select count(*), count(*) filter (where status <> 'PRESENT')
      into requirement_count, blocker_count
      from public.transaction_requirement_statuses
      where tenant_id = new.tenant_id and transaction_file_id = new.id;
    if requirement_count = 0 then raise exception 'at least one transaction requirement is required'; end if;
    if blocker_count > 0 then raise exception 'transaction file still has % unresolved requirement(s)', blocker_count; end if;
  end if;
  return new;
end $$;

drop trigger if exists guard_transaction_readiness on public.transaction_files;
create trigger guard_transaction_readiness
before update of lifecycle on public.transaction_files
for each row execute function app_private.guard_transaction_readiness();

insert into public.audit_events
  (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
select tenant_id, 'TRANSACTION_FILE', id, version + 1, 'INVALID_READINESS_REVOKED',
  jsonb_build_object('previous_lifecycle', lifecycle, 'reason', 'NO_REQUIREMENTS_CONFIGURED')
from public.transaction_files transaction_file
where lifecycle in ('CONVERGED','APPROVED')
  and not exists (
    select 1 from public.transaction_requirement_statuses requirement
    where requirement.tenant_id = transaction_file.tenant_id
      and requirement.transaction_file_id = transaction_file.id
  );

update public.transaction_files transaction_file
set lifecycle = 'ACCUMULATING', approved_by = null, approved_at = null,
  version = version + 1, updated_at = now()
where lifecycle in ('CONVERGED','APPROVED')
  and not exists (
    select 1 from public.transaction_requirement_statuses requirement
    where requirement.tenant_id = transaction_file.tenant_id
      and requirement.transaction_file_id = transaction_file.id
  );
