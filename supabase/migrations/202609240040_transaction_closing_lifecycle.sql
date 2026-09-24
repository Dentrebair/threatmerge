create or replace function app_private.transaction_closing_blockers(target_transaction uuid)
returns table (code text, message text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; policy jsonb; allow_deferred boolean;
begin
  select * into file from public.transaction_files where id = target_transaction;
  if not found then return query select 'NOT_FOUND'::text, 'Transaction File not found'::text; return; end if;
  select coalesce(template.configuration->'paymentPolicy', '{}'::jsonb) into policy
    from public.transaction_template_versions template where template.id = file.template_version_id;
  allow_deferred := coalesce((policy->>'allowDeferredPayments')::boolean, false);

  if nullif(file.key_dates->>'closingDate', '') is null then
    return query select 'CLOSING_DATE'::text, 'Set the closing date before closing this file.'::text;
  end if;
  return query select 'REQUIREMENT'::text, 'Complete all final requirements before closing.'::text
    where exists (select 1 from public.transaction_requirement_statuses requirement
      where requirement.tenant_id = file.tenant_id and requirement.transaction_file_id = file.id
        and requirement.stage_gate = 'BEFORE_CLOSING' and requirement.status <> 'PRESENT');
  return query select 'INFORMATION'::text, 'Complete all final information before closing.'::text
    where exists (select 1 from public.transaction_custom_field_definitions definition
      where definition.tenant_id = file.tenant_id and definition.transaction_file_id = file.id
        and definition.required and definition.stage_gate = 'BEFORE_CLOSING'
        and not exists (select 1 from public.transaction_custom_field_values value
          where value.tenant_id = definition.tenant_id and value.definition_id = definition.id));
  return query select 'DOCUMENT'::text, 'Verify all final documents before closing.'::text
    where exists (select 1 from public.transaction_requirement_statuses requirement
      where requirement.tenant_id = file.tenant_id and requirement.transaction_file_id = file.id
        and requirement.requirement_kind = 'ARTIFACT' and requirement.stage_gate = 'BEFORE_CLOSING'
        and not exists (select 1 from public.transaction_documents document
          join public.transaction_document_versions stored on stored.tenant_id = document.tenant_id and stored.id = document.current_version_id
          where document.tenant_id = requirement.tenant_id and document.transaction_file_id = requirement.transaction_file_id
            and document.requirement_key = requirement.requirement_key
            and (stored.expires_on is null or stored.expires_on >= current_date)
            and (select decision.decision from public.transaction_document_decisions decision
              where decision.tenant_id = stored.tenant_id and decision.document_version_id = stored.id
              order by decision.decided_at desc, decision.id desc limit 1) = 'VERIFIED'));
  return query select 'ISSUE'::text, 'Resolve all blocking issues before closing.'::text
    where exists (select 1 from public.work_items work where work.tenant_id = file.tenant_id
      and work.record_type = 'TRANSACTION_FILE' and work.record_id = file.id
      and work.status in ('OPEN','WAITING_FOR_EVIDENCE') and (work.is_blocking or work.blocker_code is not null));
  return query select 'INVOICE_APPROVAL'::text, 'Every linked invoice must be approved before closing.'::text
    where exists (select 1 from public.invoice_candidates invoice where invoice.tenant_id = file.tenant_id
      and invoice.transaction_file_id = file.id and invoice.lifecycle not in ('VERIFIED','DISMISSED'));
  return query select 'PAYMENT'::text,
      case when allow_deferred then 'Document every deferred payment before closing.' else 'Complete all invoice payments before closing.' end
    where exists (select 1 from public.invoice_candidates invoice
      left join public.transaction_invoice_payments payment on payment.tenant_id = invoice.tenant_id and payment.invoice_candidate_id = invoice.id
      where invoice.tenant_id = file.tenant_id and invoice.transaction_file_id = file.id and invoice.lifecycle = 'VERIFIED'
        and (coalesce(payment.status, 'UNPAID'::public.transaction_payment_status) in ('DISPUTED','VOIDED')
          or (not allow_deferred and coalesce(payment.status, 'UNPAID'::public.transaction_payment_status) <> 'PAID')
          or (allow_deferred and coalesce(payment.status, 'UNPAID'::public.transaction_payment_status) <> 'PAID'
            and nullif(trim(coalesce(payment.note, '')), '') is null)));
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
  update public.transaction_files set business_stage = 'CLOSED', lifecycle = 'ARCHIVED', version = version + 1, updated_at = now() where id = file.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_FILE_CLOSED', actor);
  return 'CLOSED';
end $$;

create or replace function public.cancel_transaction_file(target_transaction uuid, expected_version integer, target_reason text, actor uuid)
returns public.transaction_stage
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then raise exception 'only the assigned owner, coordinator, or administrator can cancel this file'; end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File is already complete'; end if;
  if length(trim(coalesce(target_reason, ''))) not between 2 and 1000 then raise exception 'cancellation reason is required'; end if;
  update public.transaction_files set business_stage = 'CANCELLED', lifecycle = 'ARCHIVED', version = version + 1, updated_at = now() where id = file.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_FILE_CANCELLED', actor,
      jsonb_build_object('reason', trim(target_reason)));
  return 'CANCELLED';
end $$;

create or replace function public.reopen_transaction_file(target_transaction uuid, expected_version integer, target_reason text, actor uuid)
returns public.transaction_stage
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; next_stage public.transaction_stage; blocker record;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if actor is distinct from auth.uid() or not app_private.has_tenant_role(file.tenant_id, array['TENANT_ADMIN']::public.workspace_role[]) then raise exception 'only tenant administrators can reopen a file'; end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage not in ('CLOSED','CANCELLED') then raise exception 'only closed or cancelled files can be reopened'; end if;
  if length(trim(coalesce(target_reason, ''))) not between 2 and 1000 then raise exception 'reopen reason is required'; end if;
  select * into blocker from app_private.transaction_closing_blockers(file.id) limit 1;
  next_stage := case when found then 'DOCUMENTS_PENDING'::public.transaction_stage else 'UNDER_REVIEW'::public.transaction_stage end;
  update public.transaction_files set business_stage = next_stage, lifecycle = 'ACCUMULATING', version = version + 1, updated_at = now() where id = file.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_FILE_REOPENED', actor,
      jsonb_build_object('reason', trim(target_reason), 'next_stage', next_stage));
  return next_stage;
end $$;

revoke all on function app_private.transaction_closing_blockers(uuid) from public, anon, authenticated;
revoke all on function public.close_transaction_file(uuid, integer, uuid) from public, anon;
revoke all on function public.cancel_transaction_file(uuid, integer, text, uuid) from public, anon;
revoke all on function public.reopen_transaction_file(uuid, integer, text, uuid) from public, anon;
grant execute on function public.close_transaction_file(uuid, integer, uuid) to authenticated;
grant execute on function public.cancel_transaction_file(uuid, integer, text, uuid) to authenticated;
grant execute on function public.reopen_transaction_file(uuid, integer, text, uuid) to authenticated;
