create or replace function public.list_transaction_document_uploads(target_tenant uuid)
returns table (
  intent_id uuid, transaction_file_id uuid, ingestion_event_id uuid,
  requirement_key text, document_name text, intent_status text, failure_reason text,
  safety_status public.safety_status, processing_status public.processing_status,
  created_at timestamptz
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query
    select intent.id, intent.transaction_file_id, event.id, intent.requirement_key,
      intent.document_name, intent.status, intent.failure_reason, artifact.safety_status,
      latest.status, intent.created_at
    from public.transaction_document_upload_intents intent
    join public.evidence_artifacts artifact
      on artifact.tenant_id = intent.tenant_id and artifact.id = intent.evidence_artifact_id
    join public.ingestion_events event
      on event.tenant_id = intent.tenant_id and event.evidence_artifact_id = intent.evidence_artifact_id
    left join lateral (
      select job.status from public.processing_jobs job
      where job.tenant_id = intent.tenant_id and job.aggregate_id = intent.evidence_artifact_id
        and job.job_type = 'SCAN_EVIDENCE'
      order by job.created_at desc, job.id desc limit 1
    ) latest on true
    where intent.tenant_id = target_tenant and intent.status in ('WAITING_FOR_SCAN','FAILED')
    order by intent.created_at desc;
end $$;

revoke all on function public.list_transaction_document_uploads(uuid) from public, anon;
grant execute on function public.list_transaction_document_uploads(uuid) to authenticated;
