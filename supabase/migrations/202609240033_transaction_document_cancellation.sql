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
  insert into public.audit_events
    (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
  values (file.tenant_id, 'TRANSACTION_FILE', file.id, file.version,
    'TRANSACTION_DOCUMENT_UPLOAD_CANCELLED', actor,
    jsonb_build_object('intent_id', intent.id, 'ingestion_event_id', event_row.id,
      'processing_job_id', job.id, 'processing_status', next_status));
  return next_status;
end $$;

update public.transaction_document_upload_intents intent
set status = 'CANCELLED', completed_at = coalesce(intent.completed_at, now()), failure_reason = null
where intent.status = 'WAITING_FOR_SCAN'
  and exists (
    select 1 from public.processing_jobs job
    where job.tenant_id = intent.tenant_id and job.aggregate_id = intent.evidence_artifact_id
      and job.job_type = 'SCAN_EVIDENCE' and job.status in ('CANCELLED', 'CANCEL_REQUESTED')
  );

revoke all on function public.cancel_transaction_document_upload(uuid, uuid, uuid) from public, anon;
grant execute on function public.cancel_transaction_document_upload(uuid, uuid, uuid) to authenticated;
