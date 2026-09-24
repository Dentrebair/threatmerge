-- Development-only fixture for testing invoice review and Transaction File linkage.
-- Do not run this script in a production workspace.

insert into public.invoice_candidates (
  id, tenant_id, issuer_id, origin, lifecycle, linkage_status,
  source_invoice_number, currency, total, schema_fingerprint
) values (
  '10000000-0000-4000-8000-000000000051',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000021',
  'CAPTURED', 'PENDING_REVIEW', 'UNLINKED',
  'TEST-INV-1001', 'USD', 486.00,
  'development-fixture:v1'
)
on conflict (id) do update set
  transaction_file_id = null,
  linkage_status = 'UNLINKED',
  lifecycle = 'PENDING_REVIEW',
  source_invoice_number = excluded.source_invoice_number,
  currency = excluded.currency,
  total = excluded.total,
  updated_at = now();

insert into public.invoice_field_values (
  tenant_id, invoice_candidate_id, field_name, resolved_value,
  resolution_method, confidence
) values
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000051', 'date', '"2026-09-23"', 'EXTRACTED', 0.99),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000051', 'billTo', '"Cedar Lane Realty LLC"', 'EXTRACTED', 0.98),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000051', 'description', '"Residential inspection"', 'EXTRACTED', 0.97),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000051', 'quantity', '1', 'EXTRACTED', 0.99),
  ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000051', 'rate', '486.00', 'EXTRACTED', 0.99)
on conflict (tenant_id, invoice_candidate_id, field_name) do update set
  resolved_value = excluded.resolved_value,
  resolution_method = excluded.resolution_method,
  confidence = excluded.confidence,
  version = public.invoice_field_values.version + 1;

insert into public.transaction_files (
  id, tenant_id, external_reference, property_address, lifecycle
) values (
  '10000000-0000-4000-8000-000000000061',
  '10000000-0000-4000-8000-000000000001',
  'TEST-TX-1048', '1847 Cypress Avenue', 'ACCUMULATING'
)
on conflict (id) do update set
  external_reference = excluded.external_reference,
  property_address = excluded.property_address,
  lifecycle = 'ACCUMULATING',
  updated_at = now();

insert into public.transaction_linkage_proposals (
  id, tenant_id, invoice_candidate_id, transaction_file_id,
  score, reasons, resolver_version, status
) values (
  '10000000-0000-4000-8000-000000000071',
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000051',
  '10000000-0000-4000-8000-000000000061',
  0.9400,
  '[{"label":"Property address matches"},{"label":"Invoice reference matches this file"}]'::jsonb,
  'development-fixture:v1', 'PROPOSED'
)
on conflict (id) do update set
  score = excluded.score,
  reasons = excluded.reasons,
  resolver_version = excluded.resolver_version,
  status = 'PROPOSED',
  resolved_at = null,
  resolved_by = null;

update public.invoice_candidates
set linkage_status = 'AMBIGUOUS', transaction_file_id = null, updated_at = now()
where id = '10000000-0000-4000-8000-000000000051';
