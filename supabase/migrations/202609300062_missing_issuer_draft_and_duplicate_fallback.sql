-- A recognized invoice with no extractable issuer name (e.g. an informal handwritten
-- receipt) previously hard-failed to UNRECOGNIZED_INVOICE, discarding it and forcing a
-- re-upload, purely because invoice_candidates.issuer_id is NOT NULL. Only reject when
-- the document itself isn't invoice-shaped; a recognized invoice with a missing issuer
-- now gets a placeholder issuer and a normal MISSING:issuer blocker, resolved through
-- the existing manual-completion path (record_invoice_field_value already re-resolves
-- issuer_id to a real issuer when a reviewer fills it in).
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
  if exists (
    select 1 from public.ingestion_events event
    where event.tenant_id = job.tenant_id and event.evidence_artifact_id = job.aggregate_id and event.dismissed_at is not null
  ) then
    update public.processing_jobs set status = 'CANCELLED', completed_at = now(), lock_token = null where id = job.id;
    return null;
  end if;

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

  if document_type is distinct from 'INVOICE' then
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

  if length(coalesce(issuer_name, '')) = 0 then
    normalized_issuer := '(unspecified)';
    insert into public.issuers (tenant_id, legal_name, normalized_name)
      values (job.tenant_id, 'Unspecified issuer', normalized_issuer)
      on conflict (tenant_id, normalized_name) do update set legal_name = public.issuers.legal_name
      returning id into issuer_id;
  else
    normalized_issuer := lower(regexp_replace(issuer_name, '\s+', ' ', 'g'));
    insert into public.issuers (tenant_id, legal_name, normalized_name)
      values (job.tenant_id, issuer_name, normalized_issuer)
      on conflict (tenant_id, normalized_name) do update set legal_name = public.issuers.legal_name
      returning id into issuer_id;
  end if;

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

  if length(coalesce(issuer_name, '')) = 0 then
    missing_required := true;
    insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code)
      values (job.tenant_id, 'INVOICE', invoice_id, 'COMPLETE_REQUIRED_FIELD', 'MISSING:issuer');
  else
    insert into public.invoice_field_values (tenant_id, invoice_candidate_id, field_name, resolved_value, resolution_method, confidence)
      values (job.tenant_id, invoice_id, 'issuer', to_jsonb(issuer_name), 'EXTRACTED', 1);
  end if;

  -- issuer is handled unconditionally above (always required, regardless of schema
  -- configuration), so it is excluded here to avoid a duplicate MISSING:issuer blocker
  -- if a tenant's schema also happens to list it as required.
  for required_field in select key from jsonb_each(schema_row.rules->'fields') where value->>'required' = 'true' and key <> 'issuer' loop
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

-- A missing-issuer draft has no source_invoice_number either (it was never extracted
-- as a clean field), so the existing issuer+invoice-number duplicate check never fires
-- for it. Add a fallback: when neither candidate has an invoice number, treat matching
-- issuer, matching total, and byte-identical extracted line items together as a
-- probable duplicate. Two unrelated invoices sharing all three is unlikely; this never
-- auto-merges, only routes to mandatory review same as the primary check.
create or replace function public.route_invoice_approval(target_job uuid, target_lock_token uuid)
returns public.invoice_lifecycle
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  job public.processing_jobs%rowtype;
  candidate public.invoice_candidates%rowtype;
  policy public.approval_policy_versions%rowtype;
  requires_review boolean := true;
  reason text := 'MANDATORY_POLICY';
  probable_duplicate boolean;
  eligible boolean := false;
  values_snapshot jsonb;
  allocated text;
  sequence_row public.official_number_sequences%rowtype;
begin
  select * into job from public.processing_jobs where id = target_job for update;
  if not found or job.job_type <> 'ROUTE_INVOICE_APPROVAL' then raise exception 'approval routing job not found'; end if;
  if job.lock_token is distinct from target_lock_token then raise exception 'stale worker lease'; end if;
  if job.status = 'CANCEL_REQUESTED' then
    update public.processing_jobs set status = 'CANCELLED', completed_at = now(), lock_token = null where id = job.id;
    return null;
  end if;
  if job.status <> 'RUNNING' then raise exception 'approval routing job is not running'; end if;
  select * into candidate from public.invoice_candidates where tenant_id = job.tenant_id and id = job.aggregate_id for update;
  if not found or candidate.lifecycle <> 'READY_FOR_VERIFICATION' then raise exception 'invoice is not ready for approval routing'; end if;

  select * into policy from public.approval_policy_versions policy_version
    where policy_version.tenant_id = candidate.tenant_id and policy_version.published_at is not null
    order by policy_version.version desc limit 1;
  if not found then raise exception 'published approval policy is required'; end if;

  select
    exists (
      select 1 from public.invoice_candidates existing
      where existing.tenant_id = candidate.tenant_id and existing.id <> candidate.id
        and existing.issuer_id = candidate.issuer_id and existing.source_invoice_number is not distinct from candidate.source_invoice_number
        and candidate.source_invoice_number is not null and existing.lifecycle <> 'DISMISSED'
    )
    or exists (
      select 1 from public.invoice_candidates existing
      join public.invoice_field_values existing_items
        on existing_items.tenant_id = existing.tenant_id and existing_items.invoice_candidate_id = existing.id and existing_items.field_name = 'lineItems'
      join public.invoice_field_values candidate_items
        on candidate_items.tenant_id = candidate.tenant_id and candidate_items.invoice_candidate_id = candidate.id and candidate_items.field_name = 'lineItems'
      where existing.tenant_id = candidate.tenant_id and existing.id <> candidate.id
        and existing.issuer_id = candidate.issuer_id
        and candidate.source_invoice_number is null and existing.source_invoice_number is null
        and candidate.total is not null and existing.total = candidate.total
        and existing_items.resolved_value = candidate_items.resolved_value
        and existing.lifecycle <> 'DISMISSED'
    )
  into probable_duplicate;
  if probable_duplicate then
    requires_review := true; reason := 'PROBABLE_DUPLICATE';
    insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code)
      values (candidate.tenant_id, 'INVOICE', candidate.id, 'RESOLVE_PROBABLE_DUPLICATE', 'PROBABLE_DUPLICATE');
  elsif policy.mode = 'MANDATORY' then
    requires_review := true; reason := 'MANDATORY_POLICY';
  elsif policy.mode = 'CONDITIONAL' and app_private.approval_condition_matches(candidate.id, policy.rules->'reviewWhen') then
    requires_review := true; reason := 'CONDITIONAL_MATCH';
  else
    requires_review := false; reason := case when policy.mode = 'AUTOMATIC' then 'AUTOMATIC_POLICY' else 'NO_CONDITIONAL_MATCH' end;
  end if;

  if not requires_review then
    select exists (
      select 1 from public.evidence_links link
      join public.extraction_runs run on run.tenant_id = link.tenant_id and run.evidence_artifact_id = link.evidence_artifact_id
      join public.automatic_verification_profiles profile on profile.tenant_id = candidate.tenant_id
        and profile.origin = candidate.origin and profile.document_class = 'INVOICE'
        and profile.provider = run.provider and profile.model_version = run.model_version
        and profile.prompt_version = run.prompt_version and profile.schema_fingerprint = candidate.schema_fingerprint
        and profile.revoked_at is null
      where link.tenant_id = candidate.tenant_id and link.invoice_candidate_id = candidate.id
    ) into eligible;
    if not eligible then requires_review := true; reason := 'AUTOMATION_PROFILE_NOT_APPROVED'; end if;
  end if;

  if requires_review then
    update public.invoice_candidates set lifecycle = 'PENDING_REVIEW', approval_policy_version_id = policy.id,
      approval_decision = 'HUMAN_REVIEW', approval_reason = reason, version = version + 1, updated_at = now()
      where id = candidate.id;
    update public.processing_jobs set status = 'SUCCEEDED', completed_at = now(), lock_token = null where id = job.id;
    insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
      values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1, 'INVOICE_ROUTED_TO_REVIEW',
        jsonb_build_object('approval_policy_version_id', policy.id, 'reason', reason));
    return 'PENDING_REVIEW';
  end if;

  if candidate.total is null or (candidate.origin = 'CAPTURED' and nullif(trim(candidate.source_invoice_number), '') is null) then
    raise exception 'invoice is incomplete for automatic verification';
  end if;
  select coalesce(jsonb_object_agg(field_name, resolved_value), '{}'::jsonb) into values_snapshot
    from public.invoice_field_values where tenant_id = candidate.tenant_id and invoice_candidate_id = candidate.id;
  if candidate.origin = 'GENERATED' then
    select * into sequence_row from public.official_number_sequences where tenant_id = candidate.tenant_id and issuer_id = candidate.issuer_id for update;
    if not found then raise exception 'official number sequence is not configured'; end if;
    allocated := sequence_row.prefix || lpad(sequence_row.next_value::text, 6, '0');
    update public.official_number_sequences set next_value = next_value + 1 where tenant_id = candidate.tenant_id and issuer_id = candidate.issuer_id;
  end if;
  update public.invoice_candidates set lifecycle = 'VERIFIED', official_invoice_number = allocated,
    compilation_status = case when origin = 'GENERATED' then 'PENDING' else compilation_status end,
    approval_policy_version_id = policy.id, approval_decision = 'AUTOMATIC_VERIFICATION', approval_reason = reason,
    version = version + 1, updated_at = now() where id = candidate.id;
  insert into public.verified_invoice_records (tenant_id, invoice_candidate_id, origin, issuer_id, source_invoice_number,
    official_invoice_number, currency, total, field_values, schema_fingerprint, candidate_version, verified_by, verification_method)
    values (candidate.tenant_id, candidate.id, candidate.origin, candidate.issuer_id, candidate.source_invoice_number,
      allocated, candidate.currency, candidate.total, values_snapshot, candidate.schema_fingerprint, candidate.version + 1, null, 'AUTOMATIC');
  if candidate.origin = 'GENERATED' then
    insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key)
      values (candidate.tenant_id, 'COMPILE_GENERATED_INVOICE_PDF', candidate.id, 'generated-invoice:' || candidate.id || ':pdf:v1');
  end if;
  update public.processing_jobs set status = 'SUCCEEDED', completed_at = now(), lock_token = null where id = job.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
    values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1, 'INVOICE_AUTOMATICALLY_VERIFIED',
      jsonb_build_object('approval_policy_version_id', policy.id, 'reason', reason));
  return 'VERIFIED';
end $$;
