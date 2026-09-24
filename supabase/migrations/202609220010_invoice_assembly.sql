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
      (jsonb_typeof(field_record.claimed_value) not in ('number','string') or (field_record.claimed_value #>> '{}') !~ '^\d+(\.\d{1,4})?$') then
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

revoke all on function public.complete_invoice_assembly(uuid, uuid) from public, anon, authenticated;
grant execute on function public.complete_invoice_assembly(uuid, uuid) to service_role;
