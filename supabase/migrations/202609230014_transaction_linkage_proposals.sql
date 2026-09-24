create table public.transaction_linkage_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invoice_candidate_id uuid not null,
  transaction_file_id uuid not null,
  score numeric(5,4) not null check (score between 0 and 1),
  reasons jsonb not null check (jsonb_typeof(reasons) = 'array' and jsonb_array_length(reasons) between 1 and 20),
  resolver_version text not null check (length(trim(resolver_version)) > 0),
  status text not null default 'PROPOSED' check (status in ('PROPOSED','ACCEPTED','REJECTED','SUPERSEDED')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid,
  unique (tenant_id, id),
  foreign key (tenant_id, invoice_candidate_id) references public.invoice_candidates(tenant_id, id),
  foreign key (tenant_id, transaction_file_id) references public.transaction_files(tenant_id, id),
  check ((status = 'PROPOSED' and resolved_at is null and resolved_by is null)
    or (status <> 'PROPOSED' and resolved_at is not null))
);

create unique index transaction_linkage_proposals_active_idx
  on public.transaction_linkage_proposals (tenant_id, invoice_candidate_id, transaction_file_id)
  where status = 'PROPOSED';
create index transaction_linkage_proposals_invoice_idx
  on public.transaction_linkage_proposals (tenant_id, invoice_candidate_id, status, score desc);

alter table public.transaction_linkage_proposals enable row level security;
create policy tenant_isolation on public.transaction_linkage_proposals
  for select using (app_private.is_tenant_member(tenant_id));
grant select on public.transaction_linkage_proposals to authenticated;

create or replace function public.record_transaction_linkage_proposal(
  target_invoice uuid,
  expected_invoice_version integer,
  target_transaction uuid,
  target_score numeric,
  target_reasons jsonb,
  target_resolver_version text
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare candidate public.invoice_candidates%rowtype; transaction public.transaction_files%rowtype; proposal_id uuid;
begin
  select * into candidate from public.invoice_candidates where id = target_invoice for update;
  if not found then raise exception 'invoice not found'; end if;
  if candidate.version <> expected_invoice_version then raise exception 'invoice changed; refresh and try again'; end if;
  if candidate.linkage_status = 'LINKED' then raise exception 'invoice is already linked'; end if;
  select * into transaction from public.transaction_files
    where tenant_id = candidate.tenant_id and id = target_transaction;
  if not found then raise exception 'transaction file not found'; end if;
  if transaction.lifecycle in ('DORMANT','ARCHIVED') then raise exception 'transaction file is not accepting invoice links'; end if;
  if target_score is null or target_score not between 0 and 1 then raise exception 'proposal score is invalid'; end if;
  if jsonb_typeof(target_reasons) <> 'array' or jsonb_array_length(target_reasons) not between 1 and 20
    or exists (select 1 from jsonb_array_elements(target_reasons) reason
      where jsonb_typeof(reason) <> 'object' or length(trim(coalesce(reason->>'label',''))) = 0)
  then raise exception 'proposal reasons are invalid'; end if;
  if length(trim(coalesce(target_resolver_version, ''))) = 0 then raise exception 'resolver version is required'; end if;

  insert into public.transaction_linkage_proposals
    (tenant_id, invoice_candidate_id, transaction_file_id, score, reasons, resolver_version)
  values (candidate.tenant_id, candidate.id, transaction.id, target_score, target_reasons, trim(target_resolver_version))
  returning id into proposal_id;
  update public.invoice_candidates set linkage_status = 'AMBIGUOUS', version = version + 1, updated_at = now()
    where id = candidate.id;
  insert into public.audit_events
    (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, metadata)
  values (candidate.tenant_id, 'INVOICE', candidate.id, candidate.version + 1, 'TRANSACTION_LINK_PROPOSED',
    jsonb_build_object('proposal_id', proposal_id, 'transaction_file_id', transaction.id, 'score', target_score,
      'resolver_version', trim(target_resolver_version)));
  return proposal_id;
end $$;

create or replace function public.resolve_transaction_linkage_proposal(
  target_proposal uuid,
  expected_invoice_version integer,
  expected_transaction_version integer,
  target_decision text,
  actor uuid
)
returns table (invoice_version integer, transaction_version integer, linkage_status public.linkage_status)
language plpgsql security definer set search_path = public, pg_temp as $$
declare proposal public.transaction_linkage_proposals%rowtype; candidate public.invoice_candidates%rowtype; transaction public.transaction_files%rowtype; next_linkage public.linkage_status;
begin
  select * into proposal from public.transaction_linkage_proposals where id = target_proposal for update;
  if not found then raise exception 'match suggestion not found'; end if;
  perform app_private.assert_reviewer(proposal.tenant_id, actor);
  if proposal.status <> 'PROPOSED' then raise exception 'match suggestion has already been resolved'; end if;
  if target_decision not in ('ACCEPT','REJECT') then raise exception 'match decision is invalid'; end if;
  select * into candidate from public.invoice_candidates
    where tenant_id = proposal.tenant_id and id = proposal.invoice_candidate_id for update;
  select * into transaction from public.transaction_files
    where tenant_id = proposal.tenant_id and id = proposal.transaction_file_id for update;
  if candidate.version <> expected_invoice_version then raise exception 'invoice changed; refresh and try again'; end if;
  if transaction.version <> expected_transaction_version then raise exception 'transaction file changed; refresh and try again'; end if;
  if candidate.linkage_status = 'LINKED' then raise exception 'invoice is already linked'; end if;

  if target_decision = 'ACCEPT' then
    if transaction.lifecycle in ('DORMANT','ARCHIVED') then raise exception 'transaction file is not accepting invoice links'; end if;
    update public.transaction_linkage_proposals set status = case when id = proposal.id then 'ACCEPTED' else 'SUPERSEDED' end,
      resolved_at = now(), resolved_by = actor
      where tenant_id = proposal.tenant_id and invoice_candidate_id = candidate.id and status = 'PROPOSED';
    update public.invoice_candidates set transaction_file_id = transaction.id, linkage_status = 'LINKED',
      version = version + 1, updated_at = now() where id = candidate.id;
    update public.transaction_files set version = version + 1, last_material_activity_at = now(), updated_at = now()
      where id = transaction.id;
    next_linkage := 'LINKED';
  else
    update public.transaction_linkage_proposals set status = 'REJECTED', resolved_at = now(), resolved_by = actor
      where id = proposal.id;
    if exists (select 1 from public.transaction_linkage_proposals
      where tenant_id = proposal.tenant_id and invoice_candidate_id = candidate.id and status = 'PROPOSED')
    then next_linkage := 'AMBIGUOUS'; else next_linkage := 'UNLINKED'; end if;
    update public.invoice_candidates set linkage_status = next_linkage, version = version + 1, updated_at = now()
      where id = candidate.id;
  end if;

  insert into public.audit_events
    (tenant_id, aggregate_type, aggregate_id, aggregate_version, event_type, actor_id, metadata)
  values (proposal.tenant_id, 'INVOICE', candidate.id, candidate.version + 1,
    case when target_decision = 'ACCEPT' then 'TRANSACTION_LINK_ACCEPTED' else 'TRANSACTION_LINK_REJECTED' end,
    actor, jsonb_build_object('proposal_id', proposal.id, 'transaction_file_id', transaction.id,
      'score', proposal.score));
  return query select candidate.version + 1,
    case when target_decision = 'ACCEPT' then transaction.version + 1 else transaction.version end,
    next_linkage;
end $$;

revoke all on function public.record_transaction_linkage_proposal(uuid, integer, uuid, numeric, jsonb, text) from public, anon, authenticated;
grant execute on function public.record_transaction_linkage_proposal(uuid, integer, uuid, numeric, jsonb, text) to service_role;
revoke all on function public.resolve_transaction_linkage_proposal(uuid, integer, integer, text, uuid) from public, anon;
grant execute on function public.resolve_transaction_linkage_proposal(uuid, integer, integer, text, uuid) to authenticated;
