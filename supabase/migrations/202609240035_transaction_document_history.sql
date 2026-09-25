create or replace function public.list_transaction_document_history(target_tenant uuid)
returns table (
  transaction_file_id uuid,
  document_id uuid,
  document_version_id uuid,
  version integer,
  file_name text,
  uploaded_at timestamptz,
  expires_on date,
  effective_status text,
  decision_reason text,
  is_current boolean
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query
    select stored.transaction_file_id, stored.document_id, stored.id, stored.version,
      regexp_replace(artifact.storage_path, '^.*/', ''), stored.uploaded_at, stored.expires_on,
      case
        when stored.expires_on < current_date then 'EXPIRED'
        else coalesce(decision.decision, 'RECEIVED')
      end,
      decision.reason,
      document.current_version_id = stored.id
    from public.transaction_document_versions stored
    join public.transaction_documents document
      on document.tenant_id = stored.tenant_id and document.id = stored.document_id
    join public.evidence_artifacts artifact
      on artifact.tenant_id = stored.tenant_id and artifact.id = stored.evidence_artifact_id
    left join lateral (
      select latest.decision, latest.reason
      from public.transaction_document_decisions latest
      where latest.tenant_id = stored.tenant_id and latest.document_version_id = stored.id
      order by latest.decided_at desc, latest.id desc
      limit 1
    ) decision on true
    where stored.tenant_id = target_tenant
    order by stored.transaction_file_id, stored.document_id, stored.version desc;
end $$;

revoke all on function public.list_transaction_document_history(uuid) from public, anon;
grant execute on function public.list_transaction_document_history(uuid) to authenticated;
