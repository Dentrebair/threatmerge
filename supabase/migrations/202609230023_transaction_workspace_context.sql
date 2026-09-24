create or replace function public.list_transaction_workspace_context(target_tenant uuid)
returns table (
  transaction_file_id uuid,
  transaction_type_id uuid,
  transaction_type_name text,
  owner_user_id uuid,
  primary_party_id uuid,
  primary_party_name text,
  primary_party_role public.transaction_party_role
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;
  return query
    select file.id, type_row.id, coalesce(type_row.name, file.transaction_type), owner.user_id,
      party.id, party.display_name, association.role
    from public.transaction_files file
    left join public.transaction_types type_row
      on type_row.tenant_id = file.tenant_id and type_row.id = file.transaction_type_id
    left join public.transaction_team_assignments owner
      on owner.tenant_id = file.tenant_id and owner.transaction_file_id = file.id and owner.responsibility = 'OWNER'
    left join public.transaction_party_assignments association
      on association.tenant_id = file.tenant_id and association.transaction_file_id = file.id and association.is_primary
    left join public.transaction_parties party
      on party.tenant_id = association.tenant_id and party.id = association.party_id
    where file.tenant_id = target_tenant
    order by file.updated_at desc;
end $$;

revoke all on function public.list_transaction_workspace_context(uuid) from public, anon;
grant execute on function public.list_transaction_workspace_context(uuid) to authenticated;
