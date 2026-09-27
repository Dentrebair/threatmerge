create or replace function public.fail_processing_job(
  target_job uuid,
  target_lock_token uuid,
  error_code text
)
returns public.processing_status
language plpgsql security definer set search_path = public, pg_temp as $$
declare job public.processing_jobs%rowtype; next_status public.processing_status;
begin
  select * into job from public.processing_jobs where id = target_job for update;
  if not found then raise exception 'processing job not found'; end if;
  if job.lock_token is distinct from target_lock_token or job.status <> 'RUNNING' then raise exception 'stale worker lease'; end if;
  if length(trim(error_code)) = 0 then raise exception 'error code is required'; end if;
  next_status := case
    when error_code = 'NOT_AN_INVOICE' then 'FAILED'
    when job.attempts >= 3 then 'FAILED'
    else 'RETRY_SCHEDULED'
  end;
  update public.processing_jobs set status = next_status, last_error_code = error_code,
    available_at = case when next_status = 'RETRY_SCHEDULED' then now() + make_interval(secs => 15 * power(2, job.attempts - 1)::integer) else available_at end,
    completed_at = case when next_status = 'FAILED' then now() else null end,
    lock_token = null, locked_at = null where id = job.id;
  if error_code = 'NOT_AN_INVOICE' then
    insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
      values (job.tenant_id, 'EVIDENCE', job.aggregate_id, job.attempts + 3, 'INVOICE_VALIDATION_REJECTED',
        jsonb_build_object('processing_job_id', job.id, 'reason', error_code));
  end if;
  return next_status;
end $$;

revoke all on function public.fail_processing_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fail_processing_job(uuid, uuid, text) to service_role;

drop function public.list_manual_intake_pipeline(uuid);
create function public.list_manual_intake_pipeline(target_tenant uuid)
returns table (
  ingestion_event_id uuid, evidence_artifact_id uuid, file_name text, media_type text,
  byte_size bigint, safety_status public.safety_status, quarantine_reason text,
  processing_stage text, processing_status public.processing_status, failure_reason text,
  received_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query
    select event.id, artifact.id, regexp_replace(artifact.storage_path, '^.*/', ''), artifact.media_type,
      artifact.byte_size, artifact.safety_status, artifact.quarantine_reason,
      latest.job_type, latest.status, latest.last_error_code, event.received_at
    from public.ingestion_events event
    join public.evidence_artifacts artifact on artifact.tenant_id = event.tenant_id and artifact.id = event.evidence_artifact_id
    left join lateral (
      select job.job_type, job.status, job.last_error_code from public.processing_jobs job
      where job.tenant_id = event.tenant_id and job.aggregate_id = event.evidence_artifact_id
      order by job.created_at desc, job.id desc limit 1
    ) latest on true
    where event.tenant_id = target_tenant and event.channel = 'MANUAL_UPLOAD'
      and coalesce(latest.status::text, '') not in ('CANCELLED','CANCEL_REQUESTED')
      and not exists (
        select 1 from public.transaction_document_upload_intents intent
        where intent.tenant_id = event.tenant_id and intent.evidence_artifact_id = event.evidence_artifact_id
      )
      and not exists (
        select 1 from public.evidence_links link
        join public.invoice_candidates invoice
          on invoice.tenant_id = link.tenant_id and invoice.id = link.invoice_candidate_id
        where link.tenant_id = event.tenant_id and link.evidence_artifact_id = event.evidence_artifact_id
          and invoice.lifecycle <> 'DISMISSED'
      )
    order by event.received_at desc;
end $$;

revoke all on function public.list_manual_intake_pipeline(uuid) from public, anon;
grant execute on function public.list_manual_intake_pipeline(uuid) to authenticated;
