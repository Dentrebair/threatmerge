alter table public.processing_jobs
  add column if not exists lock_token uuid,
  add column if not exists locked_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists completed_at timestamptz;

create or replace function public.claim_processing_jobs(
  worker_id text,
  accepted_job_types text[],
  batch_size integer default 5
)
returns setof public.processing_jobs
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if length(trim(worker_id)) = 0 then raise exception 'worker id is required'; end if;
  if batch_size < 1 or batch_size > 25 then raise exception 'batch size must be between 1 and 25'; end if;
  return query
    with claimable as (
      select id from public.processing_jobs
      where job_type = any(accepted_job_types)
        and available_at <= now()
        and (
          status in ('QUEUED','RETRY_SCHEDULED')
          or (status = 'RUNNING' and locked_at < now() - interval '5 minutes')
        )
      order by available_at, created_at
      for update skip locked
      limit batch_size
    )
    update public.processing_jobs job
      set status = 'RUNNING', attempts = attempts + 1,
          lock_token = gen_random_uuid(), locked_at = now(), last_error_code = null,
          payload = job.payload || jsonb_build_object('worker_id', worker_id)
      from claimable where job.id = claimable.id
      returning job.*;
end $$;

create or replace function public.complete_evidence_scan(
  target_job uuid,
  target_lock_token uuid,
  is_safe boolean,
  failure_reason text default null
)
returns public.processing_status
language plpgsql security definer set search_path = public, pg_temp as $$
declare job public.processing_jobs%rowtype;
begin
  select * into job from public.processing_jobs where id = target_job for update;
  if not found or job.job_type <> 'SCAN_EVIDENCE' then raise exception 'scan job not found'; end if;
  if job.lock_token is distinct from target_lock_token then raise exception 'stale worker lease'; end if;
  if job.status = 'CANCEL_REQUESTED' then
    update public.processing_jobs set status = 'CANCELLED', completed_at = now(), lock_token = null where id = job.id;
    return 'CANCELLED';
  end if;
  if job.status <> 'RUNNING' then raise exception 'scan job is not running'; end if;
  if not is_safe and length(trim(coalesce(failure_reason, ''))) = 0 then raise exception 'unsafe scan requires a reason'; end if;

  if is_safe then
    update public.evidence_artifacts set safety_status = 'SAFE', quarantine_reason = null
      where tenant_id = job.tenant_id and id = job.aggregate_id;
    insert into public.processing_jobs (tenant_id, job_type, aggregate_id, idempotency_key, payload)
      values (job.tenant_id, 'EXTRACT_EVIDENCE', job.aggregate_id, 'extract-evidence:' || job.aggregate_id,
        jsonb_build_object('evidence_artifact_id', job.aggregate_id))
      on conflict (tenant_id, idempotency_key) do nothing;
  else
    update public.evidence_artifacts set safety_status = 'QUARANTINED', quarantine_reason = failure_reason
      where tenant_id = job.tenant_id and id = job.aggregate_id;
    insert into public.work_items (tenant_id, record_type, record_id, kind, blocker_code)
      values (job.tenant_id, 'EVIDENCE', job.aggregate_id, 'REPLACE_UNSAFE_FILE', 'SAFETY_SCAN_FAILED');
  end if;
  update public.processing_jobs set status = 'SUCCEEDED', completed_at = now(), lock_token = null where id = job.id;
  insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
    values (job.tenant_id, 'EVIDENCE', job.aggregate_id, job.attempts + 1,
      case when is_safe then 'SAFETY_SCAN_PASSED' else 'EVIDENCE_QUARANTINED' end,
      jsonb_build_object('processing_job_id', job.id, 'reason', failure_reason));
  return 'SUCCEEDED';
end $$;

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
  next_status := case when job.attempts >= 3 then 'FAILED' else 'RETRY_SCHEDULED' end;
  update public.processing_jobs set status = next_status, last_error_code = error_code,
    available_at = case when next_status = 'RETRY_SCHEDULED' then now() + make_interval(secs => 15 * power(2, job.attempts - 1)::integer) else available_at end,
    completed_at = case when next_status = 'FAILED' then now() else null end,
    lock_token = null, locked_at = null where id = job.id;
  return next_status;
end $$;

revoke all on function public.claim_processing_jobs(text, text[], integer) from public, anon, authenticated;
revoke all on function public.complete_evidence_scan(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.fail_processing_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_processing_jobs(text, text[], integer) to service_role;
grant execute on function public.complete_evidence_scan(uuid, uuid, boolean, text) to service_role;
grant execute on function public.fail_processing_job(uuid, uuid, text) to service_role;
