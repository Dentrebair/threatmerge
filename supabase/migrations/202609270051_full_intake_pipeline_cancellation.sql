create or replace function public.cancel_manual_intake_scan(
  target_tenant uuid,
  target_ingestion_event uuid,
  actor uuid
)
returns public.processing_status
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  event_row public.ingestion_events%rowtype;
  running_count integer;
  cancellable_count integer;
  next_status public.processing_status;
begin
  perform app_private.assert_reviewer(target_tenant, actor);
  select * into event_row from public.ingestion_events
    where tenant_id = target_tenant and id = target_ingestion_event and channel = 'MANUAL_UPLOAD'
    for update;
  if not found then raise exception 'intake receipt not found'; end if;

  select count(*) filter (where status = 'RUNNING'),
    count(*) filter (where status in ('QUEUED','RETRY_SCHEDULED','RUNNING'))
    into running_count, cancellable_count
  from public.processing_jobs
  where tenant_id = target_tenant and aggregate_id = event_row.evidence_artifact_id;

  if cancellable_count = 0 then
    if exists (
      select 1 from public.processing_jobs
      where tenant_id = target_tenant and aggregate_id = event_row.evidence_artifact_id
        and status in ('CANCELLED','CANCEL_REQUESTED')
    ) then
      select case when exists (
        select 1 from public.processing_jobs
        where tenant_id = target_tenant and aggregate_id = event_row.evidence_artifact_id and status = 'CANCEL_REQUESTED'
      ) then 'CANCEL_REQUESTED'::public.processing_status else 'CANCELLED'::public.processing_status end into next_status;
      return next_status;
    end if;
    raise exception 'upload processing has already finished';
  end if;

  update public.processing_jobs
    set status = case when status = 'RUNNING' then 'CANCEL_REQUESTED'::public.processing_status else 'CANCELLED'::public.processing_status end,
      completed_at = case when status = 'RUNNING' then completed_at else now() end
    where tenant_id = target_tenant and aggregate_id = event_row.evidence_artifact_id
      and status in ('QUEUED','RETRY_SCHEDULED','RUNNING');

  next_status := case when running_count > 0 then 'CANCEL_REQUESTED'::public.processing_status else 'CANCELLED'::public.processing_status end;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
    values (target_tenant, 'EVIDENCE', event_row.evidence_artifact_id,
      coalesce((select max(aggregate_version) + 1 from public.audit_events where tenant_id = target_tenant and aggregate_type = 'EVIDENCE' and aggregate_id = event_row.evidence_artifact_id), 1),
      'INTAKE_PIPELINE_CANCELLATION_' || next_status::text, actor,
      jsonb_build_object('ingestion_event_id', event_row.id, 'active_jobs_cancelled', cancellable_count));
  return next_status;
end $$;

revoke all on function public.cancel_manual_intake_scan(uuid, uuid, uuid) from public, anon;
grant execute on function public.cancel_manual_intake_scan(uuid, uuid, uuid) to authenticated;
