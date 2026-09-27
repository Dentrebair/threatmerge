-- Preserve the distinct unrecognized-invoice recovery flow while correcting
-- historical documents that extraction did not classify as invoices.
update public.processing_jobs job
set last_error_code = 'NOT_AN_INVOICE'
where job.job_type = 'ASSEMBLE_INVOICE'
  and job.status = 'FAILED'
  and job.last_error_code = 'UNRECOGNIZED_INVOICE'
  and not exists (
    select 1
    from public.extracted_observations observation
    where observation.tenant_id = job.tenant_id
      and observation.evidence_artifact_id = job.aggregate_id
      and observation.field_name = 'documentType'
      and upper(trim(observation.claimed_value #>> '{}')) = 'INVOICE'
  );
