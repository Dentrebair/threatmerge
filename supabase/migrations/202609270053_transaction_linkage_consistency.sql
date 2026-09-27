create or replace function app_private.generate_transaction_linkage_proposals(target_invoice uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  candidate public.invoice_candidates%rowtype;
  transaction_row public.transaction_files%rowtype;
  bill_to text;
  invoice_date date;
  normalized_bill_to text;
  normalized_address text;
  party_match boolean;
  address_match boolean;
  temporal_match boolean;
  hard_contradiction boolean;
  score numeric;
  scored jsonb := '[]'::jsonb;
  top_score numeric;
  scored_row jsonb;
  previous_count integer;
  inserted_count integer := 0;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found then raise exception 'invoice not found'; end if;

  select count(*) into previous_count
  from public.transaction_linkage_proposals
  where tenant_id = candidate.tenant_id and invoice_candidate_id = candidate.id and status = 'PROPOSED';

  update public.transaction_linkage_proposals
  set status = 'SUPERSEDED', resolved_at = now()
  where tenant_id = candidate.tenant_id and invoice_candidate_id = candidate.id and status = 'PROPOSED';

  if candidate.linkage_status = 'LINKED' or candidate.lifecycle = 'DISMISSED' then return 0; end if;

  select nullif(trim(resolved_value #>> '{}'), '') into bill_to
  from public.invoice_field_values
  where tenant_id = candidate.tenant_id and invoice_candidate_id = candidate.id and field_name = 'billTo'
  limit 1;
  select case when (resolved_value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$' then (resolved_value #>> '{}')::date end into invoice_date
  from public.invoice_field_values
  where tenant_id = candidate.tenant_id and invoice_candidate_id = candidate.id and field_name in ('invoiceDate','date')
  order by case when field_name = 'invoiceDate' then 0 else 1 end limit 1;
  normalized_bill_to := lower(regexp_replace(coalesce(bill_to, ''), '[^a-zA-Z0-9]+', '', 'g'));

  for transaction_row in
    select * from public.transaction_files
    where tenant_id = candidate.tenant_id
      and lifecycle not in ('DORMANT','ARCHIVED')
      and business_stage not in ('CLOSED','CANCELLED')
  loop
    normalized_address := lower(regexp_replace(coalesce(transaction_row.property_address, ''), '[^a-zA-Z0-9]+', '', 'g'));
    select exists (
      select 1 from public.transaction_party_assignments assignment
      join public.transaction_parties party on party.tenant_id = assignment.tenant_id and party.id = assignment.party_id
      where assignment.tenant_id = candidate.tenant_id and assignment.transaction_file_id = transaction_row.id
        and lower(regexp_replace(party.display_name, '[^a-zA-Z0-9]+', '', 'g')) = normalized_bill_to
    ) into party_match;
    address_match := length(normalized_address) >= 8 and length(normalized_bill_to) >= 8
      and (normalized_bill_to like '%' || normalized_address || '%' or normalized_address like '%' || normalized_bill_to || '%');
    select invoice_date is not null and exists (
      select 1 from public.transaction_important_dates important_date
      where important_date.tenant_id = candidate.tenant_id and important_date.transaction_file_id = transaction_row.id
        and important_date.date_value is not null and abs(important_date.date_value - invoice_date) <= 365
    ) into temporal_match;
    select normalized_bill_to <> '' and exists (
      select 1 from public.transaction_party_assignments assignment
      join public.transaction_parties party on party.tenant_id = assignment.tenant_id and party.id = assignment.party_id
      where assignment.tenant_id = candidate.tenant_id and assignment.transaction_file_id <> transaction_row.id
        and lower(regexp_replace(party.display_name, '[^a-zA-Z0-9]+', '', 'g')) = normalized_bill_to
    ) and not party_match into hard_contradiction;

    if not hard_contradiction then
      score := (case when party_match then 0.60 else 0 end)
        + (case when address_match then 0.30 else 0 end)
        + (case when temporal_match then 0.10 else 0 end);
      if score >= 0.55 then
        scored := scored || jsonb_build_array(jsonb_build_object(
          'transactionId', transaction_row.id, 'score', score,
          'reasons', (select jsonb_agg(reason) from (
            select jsonb_build_object('label', 'Bill-to party matches') reason where party_match
            union all select jsonb_build_object('label', 'Property address matches') where address_match
            union all select jsonb_build_object('label', 'Invoice date fits transaction timeline') where temporal_match
          ) explanation)
        ));
      end if;
    end if;
  end loop;

  select max((entry->>'score')::numeric) into top_score from jsonb_array_elements(scored) entry;
  for scored_row in
    select value from jsonb_array_elements(scored)
    where top_score - (value->>'score')::numeric < 0.08
    order by (value->>'score')::numeric desc, value->>'transactionId'
  loop
    insert into public.transaction_linkage_proposals
      (tenant_id, invoice_candidate_id, transaction_file_id, score, reasons, resolver_version)
    values (candidate.tenant_id, candidate.id, (scored_row->>'transactionId')::uuid,
      (scored_row->>'score')::numeric, scored_row->'reasons', 'transaction-linkage-v2');
    inserted_count := inserted_count + 1;
  end loop;

  if inserted_count > 0 then
    update public.invoice_candidates
    set linkage_status = 'AMBIGUOUS', version = version + 1, updated_at = now()
    where id = candidate.id;
  elsif candidate.linkage_status = 'AMBIGUOUS' or previous_count > 0 then
    update public.invoice_candidates
    set linkage_status = 'UNLINKED', version = version + 1, updated_at = now()
    where id = candidate.id;
  end if;

  if inserted_count > 0 or previous_count > 0 then
    insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
    values (candidate.tenant_id, 'INVOICE', candidate.id,
      candidate.version + case when inserted_count > 0 or candidate.linkage_status = 'AMBIGUOUS' or previous_count > 0 then 1 else 0 end,
      'TRANSACTION_LINKAGE_EVALUATED', jsonb_build_object(
        'resolver_version', 'transaction-linkage-v2', 'proposal_count', inserted_count,
        'superseded_count', previous_count, 'top_score', top_score, 'review_margin', 0.08));
  end if;
  return inserted_count;
end $$;

revoke all on function app_private.generate_transaction_linkage_proposals(uuid) from public, anon, authenticated;
grant execute on function app_private.generate_transaction_linkage_proposals(uuid) to service_role;
