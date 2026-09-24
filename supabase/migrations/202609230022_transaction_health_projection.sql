create or replace function public.list_transaction_health(target_tenant uuid)
returns table (
  transaction_file_id uuid,
  completion_percent integer,
  missing_documents integer,
  invoice_conflicts integer,
  closing_days integer,
  outstanding_by_currency jsonb,
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
      'requirements-v1'::text
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
      join public.work_items work on work.tenant_id = invoice.tenant_id and work.record_type = 'INVOICE' and work.record_id = invoice.id
      where invoice.tenant_id = file.tenant_id and invoice.transaction_file_id = file.id
        and work.status in ('OPEN','WAITING_FOR_EVIDENCE')
        and (work.blocker_code like 'CONFLICT:%' or work.blocker_code = 'PROBABLE_DUPLICATE')
    ) conflicts on true
    left join lateral (
      select jsonb_object_agg(currency, amount) totals from (
        select invoice.currency, sum(invoice.total)::numeric amount
        from public.invoice_candidates invoice
        where invoice.tenant_id = file.tenant_id and invoice.transaction_file_id = file.id
          and invoice.lifecycle = 'VERIFIED' and invoice.total is not null
        group by invoice.currency
      ) currency_total
    ) outstanding on true
    where file.tenant_id = target_tenant
    order by file.updated_at desc;
end $$;

revoke all on function public.list_transaction_health(uuid) from public, anon;
grant execute on function public.list_transaction_health(uuid) to authenticated;
