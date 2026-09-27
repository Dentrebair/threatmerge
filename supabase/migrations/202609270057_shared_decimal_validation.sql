create or replace function app_private.is_decimal_string(value text)
returns boolean language sql immutable as $$
  select value ~ '^\d+(\.\d{1,4})?$';
$$;

create or replace function public.complete_invoice_assembly(
  target_job uuid,
  target_lock_token uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  job public.processing_jobs%rowtype;
  artifact public.evidence_artifacts%rowtype;
  run_id uuid;
  document_type text;
  issuer_name text;
  normalized_issuer text;
  issuer_id uuid;
  schema_row public.invoice_schema_versions%rowtype;
  invoice_id uuid;
  field_record record;
  required_field text;
  missing_required boolean := false;
begin
  select * into job from public.processing_jobs where id = target_job for update;
  if not found or job.job_type <> 'ASSEMBLE_INVOICE' then raise exception 'assembly job not found'; end if;
  if job.lock_token is distinct from target_lock_token then raise exception 'stale worker lease'; end if;
  if job.status = 'CANCEL_REQUESTED' then
    update public.processing_jobs set status = 'CANCELLED', completed_at = now(), lock_token = null where id = job.id;
    return null;
  end if;
  if job.status <> 'RUNNING' then raise exception 'assembly job is not running'; end if;

  select * into artifact from public.evidence_artifacts where tenant_id = job.tenant_id and id = job.aggregate_id;
  if not found or artifact.safety_status <> 'SAFE' then raise exception 'only safe evidence may be assembled'; end if;
  run_id := nullif(job.payload->>'extraction_run_id', '')::uuid;
  if run_id is null or not exists (
    select 1 from public.extraction_runs run
    where run.tenant_id = job.tenant_id and run.id = run_id and run.evidence_artifact_id = artifact.id
  ) then raise exception 'valid extraction run is required'; end if;

  select upper(trim(observation.claimed_value #>> '{}')) into document_type
    from public.extracted_observations observation
    where observation.tenant_id = job.tenant_id and observation.extraction_run_id = run_id
      and observation.field_name = 'documentType' and jsonb_typeof(observation.claimed_value) = 'string'
    order by observation.confidence desc nulls last, observation.created_at desc limit 1;
  select trim(observation.claimed_value #>> '{}') into issuer_name
    from public.extracted_observations observation
    where observation.tenant_id = job.tenant_id and observation.extraction_run_id = run_id
      and observation.field_name = 'issuer' and jsonb_typeof(observation.claimed_value) = 'string'
    order by observation.confidence desc nulls last, observation.created_at desc limit 1;

  if document_type is distinct from 'INVOICE' or length(coalesce(issuer_name, '')) = 0 then
    update public.processing_jobs set status = 'FAILED', completed_at = now(), lock_token = null,
      last_error_code = 'UNRECOGNIZED_INVOICE' where id = job.id;
    insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code)
      values (job.tenant_id, 'EVIDENCE', artifact.id, 'REPLACE_UNRECOGNIZED_FILE', 'UNRECOGNIZED_INVOICE')
      on conflict do nothing;
    insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
      values (job.tenant_id, 'EVIDENCE', artifact.id, job.attempts + 3, 'INVOICE_NOT_RECOGNIZED',
        jsonb_build_object('processing_job_id', job.id, 'extraction_run_id', run_id));
    return null;
  end if;

  normalized_issuer := lower(regexp_replace(issuer_name, '\s+', ' ', 'g'));
  insert into public.issuers (tenant_id, legal_name, normalized_name)
    values (job.tenant_id, issuer_name, normalized_issuer)
    on conflict (tenant_id, normalized_name) do update set legal_name = public.issuers.legal_name
    returning id into issuer_id;

  select * into schema_row from public.invoice_schema_versions schema_version
    where schema_version.tenant_id = job.tenant_id and schema_version.published_at is not null
      and schema_version.scope = 'INVOICE_PARTY'
      and (schema_version.rules->>'issuerId' = issuer_id::text or lower(schema_version.rules->>'issuerNormalizedName') = normalized_issuer)
    order by schema_version.version desc limit 1;
  if not found then
    select * into schema_row from public.invoice_schema_versions schema_version
      where schema_version.tenant_id = job.tenant_id and schema_version.published_at is not null
        and schema_version.scope = 'BROKERAGE_DEFAULT'
      order by schema_version.version desc limit 1;
  end if;
  if not found then raise exception 'published default invoice schema is required'; end if;

  insert into public.invoice_candidates (tenant_id, issuer_id, origin, lifecycle, linkage_status, schema_fingerprint)
    values (job.tenant_id, issuer_id, 'CAPTURED', 'INCOMPLETE_DRAFT', 'UNLINKED', schema_row.id::text || ':v' || schema_row.version)
    returning id into invoice_id;
  insert into public.evidence_links (tenant_id, evidence_artifact_id, invoice_candidate_id, relationship, confidence)
    values (job.tenant_id, artifact.id, invoice_id, 'SOURCE_DOCUMENT', 1);

  for field_record in
    select observation.field_name, min(observation.claimed_value::text)::jsonb as claimed_value,
      max(observation.confidence) as confidence, count(distinct observation.claimed_value) as value_count
    from public.extracted_observations observation
    where observation.tenant_id = job.tenant_id and observation.extraction_run_id = run_id
      and observation.field_name not in ('documentType', 'issuer')
    group by observation.field_name
  loop
    if field_record.value_count > 1 then
      insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code)
        values (job.tenant_id, 'INVOICE', invoice_id, 'RESOLVE_FIELD_CONFLICT', 'CONFLICT:' || field_record.field_name);
    elsif field_record.field_name = 'currency' and
      (jsonb_typeof(field_record.claimed_value) <> 'string' or upper(field_record.claimed_value #>> '{}') !~ '^[A-Z]{3}$') then
      insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code)
        values (job.tenant_id, 'INVOICE', invoice_id, 'CORRECT_INVALID_FIELD', 'INVALID:currency');
    elsif field_record.field_name = 'total' and
      (jsonb_typeof(field_record.claimed_value) not in ('number','string') or not app_private.is_decimal_string(field_record.claimed_value #>> '{}')) then
      insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code)
        values (job.tenant_id, 'INVOICE', invoice_id, 'CORRECT_INVALID_FIELD', 'INVALID:total');
    else
      insert into public.invoice_field_values (tenant_id, invoice_candidate_id, field_name, resolved_value, resolution_method, confidence)
        values (job.tenant_id, invoice_id, field_record.field_name, field_record.claimed_value, 'EXTRACTED', field_record.confidence);
    end if;
  end loop;
  insert into public.invoice_field_values (tenant_id, invoice_candidate_id, field_name, resolved_value, resolution_method, confidence)
    values (job.tenant_id, invoice_id, 'issuer', to_jsonb(issuer_name), 'EXTRACTED', 1);

  for required_field in select key from jsonb_each(schema_row.rules->'fields') where value->>'required' = 'true' loop
    if not exists (
      select 1 from public.invoice_field_values field_value
      where field_value.tenant_id = job.tenant_id and field_value.invoice_candidate_id = invoice_id
        and field_value.field_name = required_field and field_value.resolved_value <> 'null'::jsonb
    ) then
      missing_required := true;
      insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code)
        values (job.tenant_id, 'INVOICE', invoice_id, 'COMPLETE_REQUIRED_FIELD', 'MISSING:' || required_field);
    end if;
  end loop;

  if not missing_required and not exists (
    select 1 from public.work_items where tenant_id = job.tenant_id and record_type = 'INVOICE'
      and record_id = invoice_id and status = 'OPEN'
  ) then
    update public.invoice_candidates set lifecycle = 'READY_FOR_VERIFICATION', updated_at = now() where id = invoice_id;
    insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key, payload)
      values (job.tenant_id, 'ROUTE_INVOICE_APPROVAL', invoice_id, 'route-invoice-approval:' || invoice_id,
        jsonb_build_object('invoice_candidate_id', invoice_id, 'schema_version_id', schema_row.id));
  end if;
  update public.processing_jobs set status = 'SUCCEEDED', completed_at = now(), lock_token = null where id = job.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
    values (job.tenant_id, 'INVOICE', invoice_id, 1, 'INVOICE_CANDIDATE_ASSEMBLED',
      jsonb_build_object('evidence_artifact_id', artifact.id, 'extraction_run_id', run_id, 'schema_version_id', schema_row.id));
  return invoice_id;
end $$;

create or replace function public.record_invoice_field_value(
  target_invoice uuid,
  expected_version integer,
  target_field text,
  target_value jsonb,
  actor uuid
)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  candidate public.invoice_candidates%rowtype;
  next_version integer;
  entered_text text;
  normalized_issuer text;
  resolved_issuer_id uuid;
  ready_for_routing boolean;
begin
  if length(trim(target_field)) = 0 or target_value is null or target_value = 'null'::jsonb then
    raise exception 'field name and non-null value are required';
  end if;
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found or not app_private.is_tenant_member(candidate.tenant_id) then raise exception 'invoice not found'; end if;
  perform app_private.assert_reviewer(candidate.tenant_id, actor);
  if candidate.version <> expected_version then raise exception 'stale invoice version'; end if;
  if candidate.lifecycle in ('VERIFIED','VOIDED','DISMISSED') then raise exception 'terminal invoice cannot be edited'; end if;

  entered_text := case when jsonb_typeof(target_value) = 'string' then trim(target_value #>> '{}') else null end;
  if target_field in ('issuer','invoiceNumber','currency','invoiceDate','billTo') and length(coalesce(entered_text, '')) = 0 then
    raise exception '% must be a non-empty text value', target_field;
  end if;
  if target_field = 'currency' and upper(entered_text) !~ '^[A-Z]{3}$' then raise exception 'currency must be a three-letter code'; end if;
  if target_field in ('total','subtotal','tax') and
    (jsonb_typeof(target_value) not in ('number','string') or not app_private.is_decimal_string(target_value #>> '{}')) then
    raise exception '% must be a non-negative decimal amount', target_field;
  end if;

  if target_field = 'issuer' then
    normalized_issuer := lower(regexp_replace(entered_text, '\s+', ' ', 'g'));
    insert into public.issuers (tenant_id, legal_name, normalized_name)
      values (candidate.tenant_id, entered_text, normalized_issuer)
      on conflict (tenant_id, normalized_name) do update set legal_name = excluded.legal_name
      returning id into resolved_issuer_id;
    update public.invoice_candidates set issuer_id = resolved_issuer_id where id = candidate.id;
  elsif target_field = 'invoiceNumber' then
    update public.invoice_candidates set source_invoice_number = entered_text where id = candidate.id;
  elsif target_field = 'currency' then
    update public.invoice_candidates set currency = upper(entered_text) where id = candidate.id;
    target_value := to_jsonb(upper(entered_text));
  elsif target_field = 'total' then
    update public.invoice_candidates set total = (target_value #>> '{}')::numeric where id = candidate.id;
  end if;

  next_version := candidate.version + 1;
  insert into public.invoice_field_values (tenant_id, invoice_candidate_id, field_name, resolved_value, resolution_method, version)
    values (candidate.tenant_id, candidate.id, target_field, target_value, 'REVIEWER_ENTERED', 1)
    on conflict (tenant_id, invoice_candidate_id, field_name) do update
      set resolved_value = excluded.resolved_value, resolution_method = 'REVIEWER_ENTERED', confidence = null,
          version = public.invoice_field_values.version + 1;

  update public.work_items set status = 'RESOLVED', resolved_at = now()
    where tenant_id = candidate.tenant_id and record_type = 'INVOICE' and record_id = candidate.id
      and status in ('OPEN','WAITING_FOR_EVIDENCE')
      and blocker_code in ('MISSING:' || target_field, 'INVALID:' || target_field, 'CONFLICT:' || target_field);

  select not exists (
    select 1 from public.work_items
    where tenant_id = candidate.tenant_id and record_type = 'INVOICE' and record_id = candidate.id
      and status in ('OPEN','WAITING_FOR_EVIDENCE')
  ) into ready_for_routing;

  update public.invoice_candidates set version = next_version, updated_at = now(),
    lifecycle = case when ready_for_routing then 'READY_FOR_VERIFICATION'::public.invoice_lifecycle else lifecycle end
    where id = candidate.id;
  if ready_for_routing then
    insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key, payload)
      values (candidate.tenant_id, 'ROUTE_INVOICE_APPROVAL', candidate.id, 'route-invoice-approval:' || candidate.id,
        jsonb_build_object('invoice_candidate_id', candidate.id))
      on conflict (tenant_id, idempotency_key) do update
        set status = 'QUEUED', attempts = 0, available_at = now(), completed_at = null,
            lock_token = null, locked_at = null, last_error_code = null;
  end if;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (candidate.tenant_id, 'INVOICE', candidate.id, next_version, 'FIELD_VALUE_RECORDED', actor,
      jsonb_build_object('field_name', target_field, 'became_ready', ready_for_routing));
  return next_version;
end $$;

revoke all on function public.record_invoice_field_value(uuid, integer, text, jsonb, uuid) from public, anon;
grant execute on function public.record_invoice_field_value(uuid, integer, text, jsonb, uuid) to authenticated;

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
    max(case when field_name = 'subtotal' and app_private.is_decimal_string(resolved_value #>> '{}') then (resolved_value #>> '{}')::numeric end),
    max(case when field_name = 'tax' and app_private.is_decimal_string(resolved_value #>> '{}') then (resolved_value #>> '{}')::numeric end),
    max(case when field_name = 'total' and app_private.is_decimal_string(resolved_value #>> '{}') then (resolved_value #>> '{}')::numeric end)
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
