create or replace function public.list_transaction_closing_readiness(target_tenant uuid)
returns table (
  transaction_file_id uuid,
  ready boolean,
  blockers jsonb
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_private.is_tenant_member(target_tenant) then raise exception 'workspace not found'; end if;

  return query
    select file.id,
      count(blocker.code) = 0,
      coalesce(
        jsonb_agg(jsonb_build_object('code', blocker.code, 'message', blocker.message) order by blocker.code)
          filter (where blocker.code is not null),
        '[]'::jsonb
      )
    from public.transaction_files file
    left join lateral app_private.transaction_closing_blockers(file.id) blocker on true
    where file.tenant_id = target_tenant
    group by file.id;
end $$;

revoke all on function public.list_transaction_closing_readiness(uuid) from public, anon;
grant execute on function public.list_transaction_closing_readiness(uuid) to authenticated;
