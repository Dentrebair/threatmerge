create or replace function public.fail_processing_job(
  target_job uuid, target_lock_token uuid, error_code text
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
    when error_code in ('NOT_AN_INVOICE','MULTIPLE_INVOICES') then 'FAILED'
    when job.attempts >= 3 then 'FAILED'
    else 'RETRY_SCHEDULED'
  end;
  update public.processing_jobs set status = next_status, last_error_code = error_code,
    available_at = case when next_status = 'RETRY_SCHEDULED' then now() + make_interval(secs => 15 * power(2, job.attempts - 1)::integer) else available_at end,
    completed_at = case when next_status = 'FAILED' then now() else null end,
    lock_token = null, locked_at = null where id = job.id;
  if error_code in ('NOT_AN_INVOICE','MULTIPLE_INVOICES') then
    insert into public.audit_events (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
      values (job.tenant_id, 'EVIDENCE', job.aggregate_id, job.attempts + 3,
        case when error_code = 'MULTIPLE_INVOICES' then 'MULTIPLE_INVOICES_DETECTED' else 'INVOICE_VALIDATION_REJECTED' end,
        jsonb_build_object('processing_job_id', job.id, 'reason', error_code));
  end if;
  return next_status;
end $$;

revoke all on function public.fail_processing_job(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.fail_processing_job(uuid, uuid, text) to service_role;
