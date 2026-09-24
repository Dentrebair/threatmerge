create or replace function public.resolve_invoice_transaction_context(
  target_invoice uuid, expected_invoice_version integer, expected_transaction_version integer,
  target_resolution text, actor uuid
)
returns table (invoice_version integer, transaction_version integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare candidate public.invoice_candidates%rowtype; file public.transaction_files%rowtype;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found or candidate.transaction_file_id is null then raise exception 'linked invoice not found'; end if;
  select * into file from public.transaction_files where tenant_id = candidate.tenant_id and id = candidate.transaction_file_id for update;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then raise exception 'only the assigned owner, coordinator, or administrator can review this link'; end if;
  if candidate.version <> expected_invoice_version then raise exception 'invoice changed; refresh and try again'; end if;
  if file.version <> expected_transaction_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'reopen the Transaction File before reviewing invoice context'; end if;
  if length(trim(coalesce(target_resolution, ''))) not between 2 and 1000 then raise exception 'review resolution is required'; end if;
  update public.work_items set status = 'RESOLVED', resolved_at = now(), resolution = trim(target_resolution)
    where tenant_id = candidate.tenant_id and record_type = 'INVOICE' and record_id = candidate.id
      and kind = 'REVIEW_TRANSACTION_CONTEXT' and status in ('OPEN','WAITING_FOR_EVIDENCE');
  if not found then raise exception 'invoice context review is not pending'; end if;
  update public.invoice_candidates set version = version + 1, updated_at = now() where id = candidate.id;
  update public.transaction_files set version = version + 1, updated_at = now() where id = file.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1, 'INVOICE_TRANSACTION_CONTEXT_REVIEWED', actor,
      jsonb_build_object('transaction_file_id', file.id, 'resolution', trim(target_resolution)));
  return query select candidate.version + 1, file.version + 1;
end $$;

create or replace function public.close_transaction_file(target_transaction uuid, expected_version integer, actor uuid)
returns public.transaction_stage
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; blocker record;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then raise exception 'only the assigned owner, coordinator, or administrator can close this file'; end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage <> 'READY_FOR_CLOSING' then raise exception 'Transaction File is not ready for closing'; end if;
  select * into blocker from app_private.transaction_closing_blockers(file.id) limit 1;
  if found then raise exception '%', blocker.message; end if;
  if exists (select 1 from public.invoice_candidates invoice join public.work_items work
    on work.tenant_id = invoice.tenant_id and work.record_type = 'INVOICE' and work.record_id = invoice.id
    where invoice.tenant_id = file.tenant_id and invoice.transaction_file_id = file.id
      and work.kind = 'REVIEW_TRANSACTION_CONTEXT' and work.status in ('OPEN','WAITING_FOR_EVIDENCE')) then
    raise exception 'review all reassigned invoices before closing this file';
  end if;
  update public.transaction_files set business_stage = 'CLOSED', lifecycle = 'ARCHIVED', version = version + 1, updated_at = now() where id = file.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_FILE_CLOSED', actor);
  return 'CLOSED';
end $$;

revoke all on function public.resolve_invoice_transaction_context(uuid, integer, integer, text, uuid) from public, anon;
grant execute on function public.resolve_invoice_transaction_context(uuid, integer, integer, text, uuid) to authenticated;
