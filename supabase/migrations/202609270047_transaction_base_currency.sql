alter table public.transaction_files
  add column base_currency text check (base_currency is null or base_currency ~ '^[A-Z]{3}$');

with preferred as (
  select distinct on (entry.transaction_file_id)
    entry.transaction_file_id, entry.currency
  from public.transaction_financial_entries entry
  order by entry.transaction_file_id,
    case when entry.financial_kind = 'DEAL_VALUE' then 0 else 1 end,
    entry.updated_at desc,
    entry.id
)
update public.transaction_files file
set base_currency = preferred.currency
from preferred
where preferred.transaction_file_id = file.id;

with unambiguous_invoice_currency as (
  select invoice.transaction_file_id, min(invoice.currency::text) currency
  from public.invoice_candidates invoice
  where invoice.transaction_file_id is not null and invoice.currency is not null
  group by invoice.transaction_file_id
  having count(distinct invoice.currency) = 1
)
update public.transaction_files file
set base_currency = source.currency
from unambiguous_invoice_currency source
where source.transaction_file_id = file.id and file.base_currency is null;

create or replace function app_private.assign_transaction_base_currency()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.transaction_files
  set base_currency = new.currency
  where tenant_id = new.tenant_id and id = new.transaction_file_id
    and (base_currency is null or new.financial_kind = 'DEAL_VALUE');
  return new;
end $$;

create trigger assign_transaction_base_currency_before_financial
before insert or update of currency, financial_kind on public.transaction_financial_entries
for each row execute function app_private.assign_transaction_base_currency();

insert into public.audit_events
  (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
select file.tenant_id, 'TRANSACTION_FILE', file.id, file.version,
  'TRANSACTION_BASE_CURRENCY_ESTABLISHED',
  jsonb_build_object('base_currency', file.base_currency, 'source', 'MIGRATION_BACKFILL')
from public.transaction_files file
where file.base_currency is not null;
