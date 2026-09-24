-- Deterministic development records. Auth users are created separately by the local auth fixture.
insert into public.tenants (id, name, slug, active) values
  ('10000000-0000-4000-8000-000000000001', 'Cedar Lane Realty', 'cedar-lane-realty', true);

insert into public.tenant_memberships (tenant_id, user_id, role) values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000011', 'TENANT_ADMIN'),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000012', 'REVIEWER');

insert into public.issuers (id, tenant_id, legal_name, normalized_name) values
  ('10000000-0000-4000-8000-000000000021', '10000000-0000-4000-8000-000000000001', 'Cedar Lane Realty LLC', 'cedar lane realty llc');

insert into public.invoice_schema_versions (id, tenant_id, version, scope, rules, published_at) values
  ('10000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000001', 1, 'BROKERAGE_DEFAULT',
   '{"fields":{"issuer":{"required":true},"billTo":{"required":true},"invoiceDate":{"required":true},"lineItems":{"required":true},"currency":{"required":true}}}', now());

insert into public.approval_policy_versions (id, tenant_id, version, mode, published_at) values
  ('10000000-0000-4000-8000-000000000041', '10000000-0000-4000-8000-000000000001', 1, 'MANDATORY', now());

insert into public.official_number_sequences (tenant_id, issuer_id, prefix) values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000021', 'CLI-2026-');
