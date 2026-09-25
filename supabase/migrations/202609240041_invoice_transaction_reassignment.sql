create or replace function public.link_invoice_to_transaction(
  target_invoice uuid, expected_invoice_version integer, target_transaction uuid,
  expected_transaction_version integer, actor uuid
)
returns table (invoice_version integer, transaction_version integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare candidate public.invoice_candidates%rowtype; transaction public.transaction_files%rowtype;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found then raise exception 'invoice not found'; end if;
  perform app_private.assert_reviewer(candidate.tenant_id, actor);
  select * into transaction from public.transaction_files where tenant_id = candidate.tenant_id and id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if candidate.version <> expected_invoice_version then raise exception 'invoice changed; refresh and try again'; end if;
  if transaction.version <> expected_transaction_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if candidate.transaction_file_id is not null then
    if candidate.transaction_file_id = transaction.id then raise exception 'invoice is already linked to this Transaction File'; end if;
    raise exception 'unlink the invoice from its current Transaction File before linking it elsewhere';
  end if;
  if transaction.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File is not accepting invoice links'; end if;
  update public.invoice_candidates set transaction_file_id = transaction.id, linkage_status = 'LINKED',
    version = version + 1, updated_at = now() where id = candidate.id;
  update public.transaction_files set version = version + 1, last_material_activity_at = now(), updated_at = now()
    where id = transaction.id;
  if candidate.lifecycle = 'VERIFIED' then
    update public.work_items set status = 'RESOLVED', resolved_at = now(), resolution = 'Superseded by a newer transaction-context change'
      where tenant_id = candidate.tenant_id and record_type = 'INVOICE' and record_id = candidate.id
        and kind = 'REVIEW_TRANSACTION_CONTEXT' and status in ('OPEN','WAITING_FOR_EVIDENCE');
    insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code, title, category, severity, is_blocking, assigned_to)
      values (candidate.tenant_id, 'INVOICE', candidate.id, 'REVIEW_TRANSACTION_CONTEXT', 'TRANSACTION_CONTEXT_CHANGED',
        'Review verified invoice after relinking', 'INVOICE', 'HIGH', true, actor);
  end if;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1, 'INVOICE_LINKED_TO_TRANSACTION', actor,
      jsonb_build_object('transaction_file_id', transaction.id, 'requires_context_review', candidate.lifecycle = 'VERIFIED'));
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (candidate.tenant_id, 'TRANSACTION_FILE', transaction.id, transaction.version + 1, 'INVOICE_LINKED', actor,
      jsonb_build_object('invoice_candidate_id', candidate.id));
  return query select candidate.version + 1, transaction.version + 1;
end $$;

create or replace function public.unlink_invoice_from_transaction(
  target_invoice uuid, expected_invoice_version integer, expected_transaction_version integer,
  target_reason text, actor uuid
)
returns table (invoice_version integer, transaction_version integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare candidate public.invoice_candidates%rowtype; transaction public.transaction_files%rowtype; payment jsonb;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found or candidate.transaction_file_id is null then raise exception 'linked invoice not found'; end if;
  perform app_private.assert_reviewer(candidate.tenant_id, actor);
  select * into transaction from public.transaction_files
    where tenant_id = candidate.tenant_id and id = candidate.transaction_file_id for update;
  if candidate.version <> expected_invoice_version then raise exception 'invoice changed; refresh and try again'; end if;
  if transaction.version <> expected_transaction_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if transaction.business_stage in ('CLOSED','CANCELLED') then raise exception 'reopen the Transaction File before unlinking invoices'; end if;
  if length(trim(coalesce(target_reason, ''))) not between 2 and 1000 then raise exception 'unlink reason is required'; end if;
  select to_jsonb(tracking) - 'tenant_id' - 'invoice_candidate_id' into payment
    from public.transaction_invoice_payments tracking
    where tracking.tenant_id = candidate.tenant_id and tracking.invoice_candidate_id = candidate.id;
  delete from public.transaction_invoice_payments where tenant_id = candidate.tenant_id and invoice_candidate_id = candidate.id;
  update public.invoice_candidates set transaction_file_id = null, linkage_status = 'UNLINKED',
    version = version + 1, updated_at = now() where id = candidate.id;
  update public.transaction_files set version = version + 1, last_material_activity_at = now(), updated_at = now()
    where id = transaction.id;
  if candidate.lifecycle = 'VERIFIED' then
    update public.work_items set status = 'RESOLVED', resolved_at = now(), resolution = 'Superseded by a newer transaction-context change'
      where tenant_id = candidate.tenant_id and record_type = 'INVOICE' and record_id = candidate.id
        and kind = 'REVIEW_TRANSACTION_CONTEXT' and status in ('OPEN','WAITING_FOR_EVIDENCE');
    insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code, title, category, severity, is_blocking, assigned_to)
      values (candidate.tenant_id, 'INVOICE', candidate.id, 'REVIEW_TRANSACTION_CONTEXT', 'TRANSACTION_CONTEXT_CHANGED',
        'Review verified invoice after unlinking', 'INVOICE', 'HIGH', true, actor);
  end if;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1, 'INVOICE_UNLINKED_FROM_TRANSACTION', actor,
      jsonb_build_object('transaction_file_id', transaction.id, 'reason', trim(target_reason),
        'previous_payment_tracking', payment, 'requires_context_review', candidate.lifecycle = 'VERIFIED'));
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (candidate.tenant_id, 'TRANSACTION_FILE', transaction.id, transaction.version + 1, 'INVOICE_UNLINKED', actor,
      jsonb_build_object('invoice_candidate_id', candidate.id, 'reason', trim(target_reason)));
  return query select candidate.version + 1, transaction.version + 1;
end $$;

revoke all on function public.unlink_invoice_from_transaction(uuid, integer, integer, text, uuid) from public, anon;
grant execute on function public.unlink_invoice_from_transaction(uuid, integer, integer, text, uuid) to authenticated;

drop function public.list_transaction_invoices(uuid);
create function public.list_transaction_invoices(target_tenant uuid)
returns table (
  transaction_file_id uuid, invoice_candidate_id uuid, invoice_version integer, vendor text,
  invoice_number text, currency text, total numeric, due_date date, approval_status text,
  payment_status public.transaction_payment_status, paid_amount numeric, outstanding_amount numeric,
  scheduled_for date, payment_note text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query select invoice.transaction_file_id, invoice.id, invoice.version, issuer.legal_name,
    coalesce(invoice.official_invoice_number, invoice.source_invoice_number), invoice.currency::text, invoice.total,
    case when due.value ~ '^\d{4}-\d{2}-\d{2}$' then due.value::date else null end,
    invoice.lifecycle::text, coalesce(payment.status, 'UNPAID'::public.transaction_payment_status),
    coalesce(payment.paid_amount, 0),
    case when coalesce(payment.status, 'UNPAID'::public.transaction_payment_status) in ('PAID','DISPUTED','VOIDED')
      then 0 else greatest(coalesce(invoice.total, 0) - coalesce(payment.paid_amount, 0), 0) end,
    payment.scheduled_for, payment.note
  from public.invoice_candidates invoice
  join public.issuers issuer on issuer.tenant_id = invoice.tenant_id and issuer.id = invoice.issuer_id
  left join public.transaction_invoice_payments payment on payment.tenant_id = invoice.tenant_id and payment.invoice_candidate_id = invoice.id
  left join lateral (select value.resolved_value #>> '{}' as value from public.invoice_field_values value
    where value.tenant_id = invoice.tenant_id and value.invoice_candidate_id = invoice.id
      and value.field_name in ('due_date','dueDate') order by value.version desc limit 1) due on true
  where invoice.tenant_id = target_tenant and invoice.transaction_file_id is not null and invoice.lifecycle <> 'DISMISSED'
  order by invoice.transaction_file_id, due_date nulls last, invoice.created_at;
end $$;
revoke all on function public.list_transaction_invoices(uuid) from public, anon;
grant execute on function public.list_transaction_invoices(uuid) to authenticated;
