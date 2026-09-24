create or replace function app_private.project_invoice_field_value()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.field_name = 'invoiceNumber' then
    update public.invoice_candidates
      set source_invoice_number = new.resolved_value #>> '{}'
      where tenant_id = new.tenant_id and id = new.invoice_candidate_id and origin = 'CAPTURED';
  elsif new.field_name = 'currency' then
    update public.invoice_candidates
      set currency = upper(new.resolved_value #>> '{}')
      where tenant_id = new.tenant_id and id = new.invoice_candidate_id;
  elsif new.field_name = 'total' then
    update public.invoice_candidates
      set total = (new.resolved_value #>> '{}')::numeric
      where tenant_id = new.tenant_id and id = new.invoice_candidate_id;
  end if;
  return new;
end $$;

create trigger invoice_field_value_projection
  after insert or update of resolved_value on public.invoice_field_values
  for each row execute function app_private.project_invoice_field_value();
