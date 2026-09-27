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
  party_belongs_elsewhere boolean;
  score numeric;
  scored jsonb := '[]'::jsonb;
  top_score numeric;
  runner_up numeric;
  scored_row jsonb;
  inserted_count integer := 0;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found or candidate.linkage_status = 'LINKED' or candidate.lifecycle = 'DISMISSED' then return 0; end if;

  select nullif(trim(resolved_value #>> '{}'), '') into bill_to
    from public.invoice_field_values where tenant_id = candidate.tenant_id
      and invoice_candidate_id = candidate.id and field_name = 'billTo' limit 1;
  select case when (resolved_value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}$' then (resolved_value #>> '{}')::date end into invoice_date
    from public.invoice_field_values where tenant_id = candidate.tenant_id
      and invoice_candidate_id = candidate.id and field_name in ('invoiceDate','date')
    order by case when field_name = 'invoiceDate' then 0 else 1 end limit 1;
  normalized_bill_to := lower(regexp_replace(coalesce(bill_to, ''), '[^a-zA-Z0-9]+', '', 'g'));

  for transaction_row in
    select * from public.transaction_files
    where tenant_id = candidate.tenant_id and lifecycle not in ('DORMANT','ARCHIVED')
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
    ) and not party_match into party_belongs_elsewhere;

    if not party_belongs_elsewhere then
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
  select (entry->>'score')::numeric into runner_up from jsonb_array_elements(scored) entry
    order by (entry->>'score')::numeric desc offset 1 limit 1;
  for scored_row in select value from jsonb_array_elements(scored)
    where runner_up is null or top_score - runner_up < 0.08 or (value->>'score')::numeric = top_score
  loop
    insert into public.transaction_linkage_proposals
      (tenant_id, invoice_candidate_id, transaction_file_id, score, reasons, resolver_version)
    values (candidate.tenant_id, candidate.id, (scored_row->>'transactionId')::uuid,
      (scored_row->>'score')::numeric, scored_row->'reasons', 'transaction-linkage-v1')
    on conflict (tenant_id, invoice_candidate_id, transaction_file_id) where status = 'PROPOSED'
      do update set score = excluded.score, reasons = excluded.reasons, resolver_version = excluded.resolver_version;
    inserted_count := inserted_count + 1;
  end loop;

  if inserted_count > 0 then
    update public.invoice_candidates set linkage_status = 'AMBIGUOUS', version = version + 1, updated_at = now() where id = candidate.id;
    insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
      values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1, 'TRANSACTION_LINKAGE_EVALUATED',
        jsonb_build_object('resolver_version', 'transaction-linkage-v1', 'proposal_count', inserted_count,
          'top_score', top_score, 'winning_margin', case when runner_up is null then null else top_score - runner_up end));
  end if;
  return inserted_count;
end $$;

revoke all on function app_private.generate_transaction_linkage_proposals(uuid) from public, anon, authenticated;
grant execute on function app_private.generate_transaction_linkage_proposals(uuid) to service_role;

create or replace function app_private.propose_transaction_link_after_assembly()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare invoice_id uuid;
begin
  if new.job_type = 'ASSEMBLE_INVOICE' and new.status = 'SUCCEEDED' and old.status is distinct from new.status then
    select link.invoice_candidate_id into invoice_id
    from public.evidence_links link
    where link.tenant_id = new.tenant_id and link.evidence_artifact_id = new.aggregate_id
      and link.relationship = 'SOURCE_DOCUMENT' and link.invoice_candidate_id is not null
    order by link.created_at desc limit 1;
    if invoice_id is not null then perform app_private.generate_transaction_linkage_proposals(invoice_id); end if;
  end if;
  return new;
exception when others then
  update public.processing_jobs set payload = payload || jsonb_build_object('linkage_proposal_error', sqlerrm) where id = new.id;
  return new;
end $$;

drop trigger if exists processing_job_transaction_linkage on public.processing_jobs;
create trigger processing_job_transaction_linkage
after update of status on public.processing_jobs
for each row execute function app_private.propose_transaction_link_after_assembly();

create or replace function app_private.reevaluate_transaction_link_after_invoice_field_change()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.field_name in ('billTo','invoiceDate','date') then
    perform app_private.generate_transaction_linkage_proposals(new.invoice_candidate_id);
  end if;
  return new;
exception when others then
  return new;
end $$;

drop trigger if exists invoice_field_transaction_linkage on public.invoice_field_values;
create trigger invoice_field_transaction_linkage
after insert or update of resolved_value on public.invoice_field_values
for each row execute function app_private.reevaluate_transaction_link_after_invoice_field_change();

do $$
declare existing_invoice record;
begin
  for existing_invoice in
    select id from public.invoice_candidates
    where linkage_status <> 'LINKED' and lifecycle <> 'DISMISSED'
  loop
    begin
      perform app_private.generate_transaction_linkage_proposals(existing_invoice.id);
    exception when others then
      null;
    end;
  end loop;
end $$;
