create or replace function public.stage_transaction_document_upload(
  target_transaction uuid, expected_version integer, target_evidence uuid,
  target_requirement_key text, target_name text, target_expires_on date, actor uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare file public.transaction_files%rowtype; artifact public.evidence_artifacts%rowtype;
  requirement public.transaction_requirement_statuses%rowtype; intent_id uuid;
begin
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then raise exception 'only the assigned owner, coordinator, or administrator can manage this file'; end if;
  if file.version <> expected_version then raise exception 'Transaction File changed; refresh and try again'; end if;
  if file.business_stage in ('CLOSED','CANCELLED') then raise exception 'Transaction File cannot be edited in its current stage'; end if;
  select * into artifact from public.evidence_artifacts where tenant_id = file.tenant_id and id = target_evidence;
  if not found then raise exception 'uploaded file not found'; end if;
  if artifact.safety_status = 'QUARANTINED' then raise exception 'replace the file because it did not pass safety checks'; end if;
  if exists (select 1 from public.transaction_document_upload_intents
    where tenant_id = file.tenant_id and evidence_artifact_id = artifact.id) then
    raise exception 'this upload is already assigned to a Transaction File document';
  end if;
  if length(trim(coalesce(target_name, ''))) not between 1 and 160 then raise exception 'document name is required'; end if;
  if target_expires_on is not null and target_expires_on < current_date then raise exception 'document expiry must be today or later'; end if;
  if nullif(trim(coalesce(target_requirement_key, '')), '') is not null then
    select * into requirement from public.transaction_requirement_statuses
      where tenant_id = file.tenant_id and transaction_file_id = file.id
        and requirement_kind = 'ARTIFACT' and requirement_key = trim(target_requirement_key);
    if not found then raise exception 'document requirement not found'; end if;
  end if;

  insert into public.transaction_document_upload_intents
    (tenant_id, transaction_file_id, evidence_artifact_id, requirement_key, document_name, expires_on, requested_by)
  values (file.tenant_id, file.id, artifact.id, nullif(trim(target_requirement_key), ''),
    trim(target_name), target_expires_on, actor) returning id into intent_id;
  perform app_private.invalidate_transaction_review(file.id);
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1, 'TRANSACTION_DOCUMENT_UPLOAD_STAGED', actor,
      jsonb_build_object('intent_id', intent_id, 'evidence_artifact_id', artifact.id,
        'requirement_key', nullif(trim(target_requirement_key), '')));
  if artifact.safety_status = 'SAFE' then
    perform app_private.finalize_transaction_document_intent(artifact.id);
  end if;
  return intent_id;
end $$;

create or replace function public.cancel_transaction_document_upload(
  target_transaction uuid, target_ingestion_event uuid, actor uuid
)
returns public.processing_status
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  file public.transaction_files%rowtype;
  event_row public.ingestion_events%rowtype;
  intent public.transaction_document_upload_intents%rowtype;
  job public.processing_jobs%rowtype;
  next_status public.processing_status;
begin
  if actor is distinct from auth.uid() then raise exception 'actor does not match authenticated user'; end if;
  select * into file from public.transaction_files where id = target_transaction for update;
  if not found then raise exception 'Transaction File not found'; end if;
  if not app_private.can_manage_transaction(file.tenant_id, file.id, actor) then
    raise exception 'only the assigned owner, coordinator, or administrator can manage this file';
  end if;
  select * into event_row from public.ingestion_events
    where tenant_id = file.tenant_id and id = target_ingestion_event and channel = 'MANUAL_UPLOAD';
  if not found then raise exception 'document upload not found'; end if;
  select * into intent from public.transaction_document_upload_intents
    where tenant_id = file.tenant_id and transaction_file_id = file.id
      and evidence_artifact_id = event_row.evidence_artifact_id for update;
  if not found then raise exception 'document upload not found'; end if;
  if intent.status = 'CANCELLED' then return 'CANCELLED'; end if;
  if intent.status <> 'WAITING_FOR_SCAN' then raise exception 'this document upload can no longer be cancelled'; end if;

  select * into job from public.processing_jobs
    where tenant_id = file.tenant_id and aggregate_id = intent.evidence_artifact_id
      and job_type = 'SCAN_EVIDENCE'
    order by created_at desc, id desc limit 1 for update;
  if not found then
    next_status := 'CANCELLED';
  elsif job.status in ('QUEUED', 'RETRY_SCHEDULED') then
    next_status := 'CANCELLED';
    update public.processing_jobs set status = 'CANCELLED', completed_at = now(), lock_token = null where id = job.id;
  elsif job.status = 'RUNNING' then
    next_status := 'CANCEL_REQUESTED';
    update public.processing_jobs set status = 'CANCEL_REQUESTED' where id = job.id;
  elsif job.status in ('CANCELLED', 'CANCEL_REQUESTED') then
    next_status := job.status;
  else
    raise exception 'this document upload can no longer be cancelled';
  end if;

  update public.transaction_document_upload_intents
    set status = 'CANCELLED', completed_at = now(), failure_reason = null where id = intent.id;
  perform app_private.invalidate_transaction_review(file.id);
  insert into public.audit_events
    (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
  values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version + 1,
    'TRANSACTION_DOCUMENT_UPLOAD_CANCELLED', actor,
    jsonb_build_object('intent_id', intent.id, 'ingestion_event_id', event_row.id,
      'processing_job_id', job.id, 'processing_status', next_status));
  return next_status;
end $$;

revoke all on function public.stage_transaction_document_upload(uuid, integer, uuid, text, text, date, uuid) from public, anon;
revoke all on function public.cancel_transaction_document_upload(uuid, uuid, uuid) from public, anon;
grant execute on function public.stage_transaction_document_upload(uuid, integer, uuid, text, text, date, uuid) to authenticated;
grant execute on function public.cancel_transaction_document_upload(uuid, uuid, uuid) to authenticated;
