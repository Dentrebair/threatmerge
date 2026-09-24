create or replace function app_private.guard_transaction_child_write()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare tenant uuid; transaction_id uuid; actor uuid;
begin
  tenant := coalesce(new.tenant_id, old.tenant_id);
  transaction_id := coalesce(new.transaction_file_id, old.transaction_file_id);
  actor := auth.uid();
  if actor is not null and not app_private.can_manage_transaction(tenant, transaction_id, actor) then
    raise exception 'only the assigned owner, coordinator, or administrator can manage this file';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger guard_transaction_party_assignment_write
before insert or update or delete on public.transaction_party_assignments
for each row execute function app_private.guard_transaction_child_write();
create trigger guard_transaction_important_date_write
before insert or update or delete on public.transaction_important_dates
for each row execute function app_private.guard_transaction_child_write();
create trigger guard_transaction_financial_write
before insert or update or delete on public.transaction_financial_entries
for each row execute function app_private.guard_transaction_child_write();
create trigger guard_transaction_requirement_write
before insert or update or delete on public.transaction_requirement_statuses
for each row execute function app_private.guard_transaction_child_write();

create or replace function app_private.invalidate_review_after_requirement_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare transaction_id uuid;
begin
  transaction_id := coalesce(new.transaction_file_id, old.transaction_file_id);
  update public.transaction_files set business_stage = 'DOCUMENTS_PENDING'
    where id = transaction_id and business_stage in ('UNDER_REVIEW','READY_FOR_CLOSING');
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

create trigger invalidate_review_after_requirement_change
after insert or update or delete on public.transaction_requirement_statuses
for each row execute function app_private.invalidate_review_after_requirement_change();

create or replace function app_private.guard_transaction_file_consistency()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.business_stage in ('CLOSED','CANCELLED') and (
    new.property_address is distinct from old.property_address
    or new.external_reference is distinct from old.external_reference
    or new.office is distinct from old.office
    or new.transaction_type_id is distinct from old.transaction_type_id
    or new.requirement_snapshot is distinct from old.requirement_snapshot
  ) then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  if old.business_stage in ('UNDER_REVIEW','READY_FOR_CLOSING') and (
    new.property_address is distinct from old.property_address
    or new.external_reference is distinct from old.external_reference
    or new.office is distinct from old.office
    or new.transaction_type_id is distinct from old.transaction_type_id
    or new.requirement_snapshot is distinct from old.requirement_snapshot
  ) then new.business_stage := 'DOCUMENTS_PENDING'; end if;
  return new;
end $$;

create trigger guard_transaction_file_consistency
before update on public.transaction_files
for each row execute function app_private.guard_transaction_file_consistency();
