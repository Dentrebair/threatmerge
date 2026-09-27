-- extracted_observations has no index on either foreign key, so every invoice-list join
-- (evidence_artifacts -> extracted_observations) and every assembly-job lookup by
-- extraction_run_id scans the whole table.
create index if not exists extracted_observations_artifact_idx
  on public.extracted_observations (tenant_id, evidence_artifact_id);
create index if not exists extracted_observations_run_idx
  on public.extracted_observations (tenant_id, extraction_run_id);

-- work_items_queue_idx leads with (status, assigned_to), which doesn't serve the
-- "active blockers for these invoice ids" lookup used by the invoice list. Partial on
-- the two open statuses so it stays small regardless of how many resolved/dismissed
-- work items accumulate.
create index if not exists work_items_active_record_idx
  on public.work_items (tenant_id, record_type, record_id)
  where status in ('OPEN', 'WAITING_FOR_EVIDENCE');
