alter table public.invoice_field_values
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default now();

create or replace function app_private.touch_invoice_field_value_timestamps()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end $$;

create trigger touch_invoice_field_value_timestamps
  before update on public.invoice_field_values
  for each row execute function app_private.touch_invoice_field_value_timestamps();

create index invoice_field_values_updated_idx
  on public.invoice_field_values (tenant_id, invoice_candidate_id, updated_at desc);
