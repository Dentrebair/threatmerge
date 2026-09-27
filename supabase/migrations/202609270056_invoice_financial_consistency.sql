create or replace function app_private.refresh_invoice_financial_consistency()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  subtotal_value numeric;
  tax_value numeric;
  total_value numeric;
  complete boolean;
  consistent boolean;
begin
  select
    max(case when field_name = 'subtotal' and (resolved_value #>> '{}') ~ '^\d+(\.\d{1,4})?$' then (resolved_value #>> '{}')::numeric end),
    max(case when field_name = 'tax' and (resolved_value #>> '{}') ~ '^\d+(\.\d{1,4})?$' then (resolved_value #>> '{}')::numeric end),
    max(case when field_name = 'total' and (resolved_value #>> '{}') ~ '^\d+(\.\d{1,4})?$' then (resolved_value #>> '{}')::numeric end)
  into subtotal_value, tax_value, total_value
  from public.invoice_field_values
  where tenant_id = new.tenant_id and invoice_candidate_id = new.invoice_candidate_id
    and field_name in ('subtotal','tax','total');

  complete := subtotal_value is not null and tax_value is not null and total_value is not null;
  consistent := complete and abs((subtotal_value + tax_value) - total_value) <= 0.02;
  if complete and not consistent then
    if not exists (
      select 1 from public.work_items where tenant_id = new.tenant_id and record_type = 'INVOICE'
        and record_id = new.invoice_candidate_id and blocker_code = 'INVALID:financialConsistency'
        and status in ('OPEN','WAITING_FOR_EVIDENCE')
    ) then
      insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code)
        values (new.tenant_id, 'INVOICE', new.invoice_candidate_id, 'CORRECT_INVALID_FIELD', 'INVALID:financialConsistency');
    end if;
    update public.invoice_candidates set lifecycle = 'INCOMPLETE_DRAFT', updated_at = now()
      where id = new.invoice_candidate_id and lifecycle not in ('VERIFIED','VOIDED','DISMISSED');
  elsif consistent then
    update public.work_items set status = 'RESOLVED', resolved_at = now()
      where tenant_id = new.tenant_id and record_type = 'INVOICE' and record_id = new.invoice_candidate_id
        and blocker_code = 'INVALID:financialConsistency' and status in ('OPEN','WAITING_FOR_EVIDENCE');
  end if;
  return new;
end $$;

create trigger refresh_invoice_financial_consistency
  after insert or update of resolved_value on public.invoice_field_values
  for each row when (new.field_name in ('subtotal','tax','total'))
  execute function app_private.refresh_invoice_financial_consistency();
