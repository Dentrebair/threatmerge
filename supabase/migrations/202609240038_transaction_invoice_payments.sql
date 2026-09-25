create type public.transaction_payment_status as enum (
  'UNPAID','SCHEDULED','PARTIALLY_PAID','PAID','DISPUTED','VOIDED'
);

create table public.transaction_invoice_payments (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  transaction_file_id uuid not null,
  invoice_candidate_id uuid not null,
  status public.transaction_payment_status not null default 'UNPAID',
  paid_amount numeric(19,4) not null default 0 check (paid_amount >= 0),
  scheduled_for date,
  note text check (note is null or length(trim(note)) between 1 and 500),
  updated_by uuid not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, invoice_candidate_id),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  foreign key (tenant_id, invoice_candidate_id) references public.invoice_candidates(tenant_id, id),
  foreign key (tenant_id, updated_by) references public.tenant_memberships(tenant_id, user_id),
  check ((status = 'SCHEDULED') = (scheduled_for is not null)),
  check (status <> 'UNPAID' or paid_amount = 0),
  check (status <> 'VOIDED' or paid_amount = 0)
);

alter table public.transaction_invoice_payments enable row level security;
create policy tenant_isolation on public.transaction_invoice_payments
  for select using (app_private.is_tenant_member(tenant_id));
grant select on public.transaction_invoice_payments to authenticated;

create or replace function public.set_transaction_invoice_payment(
  target_transaction uuid,
  expected_version integer,
  target_invoice uuid,
  target_status text,
  target_paid_amount numeric,
  target_scheduled_for date,
  target_note text,
  actor uuid
)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; invoice public.invoice_candidates%rowtype;
  normalized_status public.transaction_payment_status; normalized_amount numeric; normalized_note text;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then
    raise exception 'only the assigned owner, coordinator, or administrator can manage this file';
  end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  if target_status not in ('UNPAID','SCHEDULED','PARTIALLY_PAID','PAID','DISPUTED','VOIDED') then
    raise exception 'payment status is invalid';
  end if;
  normalized_status := target_status::public.transaction_payment_status;
  normalized_amount := coalesce(target_paid_amount, 0);
  normalized_note := nullif(trim(coalesce(target_note, '')), '');

  select * into invoice from public.invoice_candidates
    where tenant_id = file.tenant_id and id = target_invoice and transaction_file_id = file.id for update;
  if not found then raise exception 'linked invoice not found'; end if;
  if invoice.total is null then raise exception 'invoice total is required before tracking payment'; end if;
  if normalized_amount < 0 or normalized_amount > invoice.total then raise exception 'paid amount must be between zero and the invoice total'; end if;
  if normalized_status = 'SCHEDULED' and target_scheduled_for is null then raise exception 'scheduled payment date is required'; end if;
  if normalized_status <> 'SCHEDULED' and target_scheduled_for is not null then raise exception 'scheduled date is only allowed for scheduled payments'; end if;
  if normalized_status = 'UNPAID' and normalized_amount <> 0 then raise exception 'unpaid invoices cannot have a paid amount'; end if;
  if normalized_status = 'PARTIALLY_PAID' and (normalized_amount <= 0 or normalized_amount >= invoice.total) then
    raise exception 'partial payment must be greater than zero and less than the invoice total';
  end if;
  if normalized_status = 'PAID' and normalized_amount <> invoice.total then raise exception 'paid amount must equal the invoice total'; end if;
  if normalized_status = 'VOIDED' and normalized_amount <> 0 then raise exception 'voided payment tracking cannot retain a paid amount'; end if;
  if normalized_status in ('DISPUTED','VOIDED') and normalized_note is null then
    raise exception 'a reason is required for disputed or voided payment tracking';
  end if;

  insert into public.transaction_invoice_payments
    (tenant_id, transaction_file_id, invoice_candidate_id, status, paid_amount, scheduled_for, note, updated_by)
  values (file.tenant_id, file.id, invoice.id, normalized_status, normalized_amount,
    case when normalized_status = 'SCHEDULED' then target_scheduled_for else null end,
    normalized_note, actor)
  on conflict (tenant_id, invoice_candidate_id) do update set
    transaction_file_id = excluded.transaction_file_id,
    status = excluded.status,
    paid_amount = excluded.paid_amount,
    scheduled_for = excluded.scheduled_for,
    note = excluded.note,
    updated_by = excluded.updated_by,
    updated_at = now();
  update public.transaction_files set version = version + 1, updated_at = now() where id = file.id;
  insert into public.audit_events
    (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
  values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1,
    'TRANSACTION_INVOICE_PAYMENT_UPDATED', actor,
    jsonb_build_object('invoice_candidate_id', invoice.id, 'status', normalized_status,
      'paid_amount', normalized_amount, 'scheduled_for', target_scheduled_for,
      'note', normalized_note));
  return file.version + 1;
end $$;

create or replace function public.list_transaction_invoices(target_tenant uuid)
returns table (
  transaction_file_id uuid,
  invoice_candidate_id uuid,
  vendor text,
  invoice_number text,
  currency text,
  total numeric,
  due_date date,
  approval_status text,
  payment_status public.transaction_payment_status,
  paid_amount numeric,
  outstanding_amount numeric,
  scheduled_for date,
  payment_note text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query
    select invoice.transaction_file_id, invoice.id, issuer.legal_name,
      coalesce(invoice.official_invoice_number, invoice.source_invoice_number), invoice.currency::text,
      invoice.total,
      case when due.value ~ '^\d{4}-\d{2}-\d{2}$' then due.value::date else null end,
      invoice.lifecycle::text,
      coalesce(payment.status, 'UNPAID'::public.transaction_payment_status),
      coalesce(payment.paid_amount, 0),
      case when coalesce(payment.status, 'UNPAID'::public.transaction_payment_status) in ('PAID','DISPUTED','VOIDED')
        then 0 else greatest(coalesce(invoice.total, 0) - coalesce(payment.paid_amount, 0), 0) end,
      payment.scheduled_for, payment.note
    from public.invoice_candidates invoice
    join public.issuers issuer on issuer.tenant_id = invoice.tenant_id and issuer.id = invoice.issuer_id
    left join public.transaction_invoice_payments payment
      on payment.tenant_id = invoice.tenant_id and payment.invoice_candidate_id = invoice.id
    left join lateral (
      select value.resolved_value #>> '{}' as value
      from public.invoice_field_values value
      where value.tenant_id = invoice.tenant_id and value.invoice_candidate_id = invoice.id
        and value.field_name in ('due_date','dueDate')
      order by value.version desc limit 1
    ) due on true
    where invoice.tenant_id = target_tenant and invoice.transaction_file_id is not null
      and invoice.lifecycle <> 'DISMISSED'
    order by invoice.transaction_file_id, due_date nulls last, invoice.created_at;
end $$;

create or replace function public.list_transaction_health(target_tenant uuid)
returns table (
  transaction_file_id uuid, completion_percent integer, missing_documents integer,
  invoice_conflicts integer, closing_days integer, outstanding_by_currency jsonb,
  calculation_version text
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query
    select file.id,
      case when requirement.total_count = 0 then 0
        else round(100.0 * requirement.complete_count / requirement.total_count)::integer end,
      requirement.missing_documents::integer,
      coalesce(conflicts.conflict_count, 0)::integer,
      case when nullif(file.key_dates->>'closingDate', '') is null then null
        else (file.key_dates->>'closingDate')::date - current_date end,
      coalesce(outstanding.totals, '{}'::jsonb),
      'requirements-payments-v2'::text
    from public.transaction_files file
    left join lateral (
      select count(*)::integer total_count,
        count(*) filter (where status = 'PRESENT')::integer complete_count,
        count(*) filter (where requirement_kind = 'ARTIFACT' and status <> 'PRESENT')::integer missing_documents
      from public.transaction_requirement_statuses requirement
      where requirement.tenant_id = file.tenant_id and requirement.transaction_file_id = file.id
    ) requirement on true
    left join lateral (
      select count(distinct work.id)::integer conflict_count
      from public.invoice_candidates invoice
      join public.work_items work on work.tenant_id = invoice.tenant_id
        and work.record_type = 'INVOICE' and work.record_id = invoice.id
      where invoice.tenant_id = file.tenant_id and invoice.transaction_file_id = file.id
        and work.status in ('OPEN','WAITING_FOR_EVIDENCE')
        and (work.blocker_code like 'CONFLICT:%' or work.blocker_code = 'PROBABLE_DUPLICATE')
    ) conflicts on true
    left join lateral (
      select jsonb_object_agg(currency, amount) totals from (
        select invoice.currency, sum(greatest(invoice.total - coalesce(payment.paid_amount, 0), 0))::numeric amount
        from public.invoice_candidates invoice
        left join public.transaction_invoice_payments payment
          on payment.tenant_id = invoice.tenant_id and payment.invoice_candidate_id = invoice.id
        where invoice.tenant_id = file.tenant_id and invoice.transaction_file_id = file.id
          and invoice.lifecycle = 'VERIFIED' and invoice.total is not null
          and coalesce(payment.status, 'UNPAID'::public.transaction_payment_status) not in ('PAID','DISPUTED','VOIDED')
        group by invoice.currency
      ) currency_total
    ) outstanding on true
    where file.tenant_id = target_tenant order by file.updated_at desc;
end $$;

revoke all on function public.set_transaction_invoice_payment(uuid, integer, uuid, text, numeric, date, text, uuid) from public, anon;
revoke all on function public.list_transaction_invoices(uuid) from public, anon;
grant execute on function public.set_transaction_invoice_payment(uuid, integer, uuid, text, numeric, date, text, uuid) to authenticated;
grant execute on function public.list_transaction_invoices(uuid) to authenticated;
