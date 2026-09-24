import { supabase } from "./client.js";

export type TransactionLifecycle = "INGESTED" | "ACCUMULATING" | "AMBIGUOUS" | "CONVERGED" | "APPROVED" | "DORMANT" | "ARCHIVED";
export type TransactionStage = "DRAFT" | "DOCUMENTS_PENDING" | "UNDER_REVIEW" | "READY_FOR_CLOSING" | "CLOSED" | "CANCELLED";
export type TransactionPartyRole = "BUYER" | "SELLER" | "TENANT" | "LANDLORD" | "AGENT" | "LENDER" | "ATTORNEY" | "TITLE_ESCROW";
export type RequirementStatus = "PRESENT" | "MISSING" | "CONFLICT" | "LOW_CONFIDENCE";
export interface TransactionRequirement { kind: "ARTIFACT" | "FIELD"; key: string; status: RequirementStatus; confidence: number | null; value?: string; stageGate?: "BEFORE_REVIEW" | "BEFORE_APPROVAL" | "BEFORE_CLOSING"; source?: "TEMPLATE" | "TRANSACTION"; templateMandated?: boolean }
export interface TransactionParty { id: string; name: string; kind: "PERSON" | "ORGANIZATION"; role: TransactionPartyRole; primary: boolean }
export interface TransactionImportantDate { id: string; kind: "AGREEMENT" | "INSPECTION" | "FINANCING" | "DOCUMENT_DEADLINE" | "CLOSING" | "HANDOVER"; date: string | null; timestamp: string | null; timezone: string | null }
export interface TransactionFinancial { id: string; kind: "DEAL_VALUE" | "DEPOSIT" | "COMMISSION" | "TAX" | "FEE"; label: string; amount: number; currency: string }
export interface TransactionCustomField { id: string; key: string; label: string; dataType: "TEXT" | "NUMBER" | "BOOLEAN" | "DATE"; required: boolean; stageGate: "BEFORE_REVIEW" | "BEFORE_APPROVAL" | "BEFORE_CLOSING"; validation: Record<string, unknown>; value?: unknown }
export interface TransactionDocument { id: string; name: string; requirementKey: string | null; required: boolean; stageGate: "BEFORE_REVIEW" | "BEFORE_APPROVAL" | "BEFORE_CLOSING"; versionId: string; version: number; fileName: string; uploadedAt: string; expiresOn: string | null; status: "RECEIVED" | "VERIFIED" | "REJECTED" | "EXPIRED"; decisionReason: string | null }
export interface TransactionPendingDocumentUpload { id: string; ingestionEventId: string; requirementKey: string | null; documentName: string; status: "WAITING_FOR_SCAN" | "FAILED"; safetyStatus: "PENDING" | "SAFE" | "QUARANTINED"; processingStatus: "QUEUED" | "RUNNING" | "RETRY_SCHEDULED" | "SUCCEEDED" | "FAILED" | "CANCEL_REQUESTED" | "CANCELLED" | null; failureReason: string | null; createdAt: string }
export interface TransactionFile {
  id: string;
  externalReference: string;
  propertyAddress: string;
  transactionType?: string;
  transactionTypeId?: string;
  ownerUserId?: string;
  primaryParty?: { id: string; name: string; role: TransactionPartyRole };
  office?: string;
  keyDates?: Record<string, string>;
  lifecycle: TransactionLifecycle;
  businessStage?: TransactionStage;
  version: number;
  updatedAt: string;
  health?: TransactionHealth;
  parties?: TransactionParty[];
  importantDates?: TransactionImportantDate[];
  financials?: TransactionFinancial[];
  customFields?: TransactionCustomField[];
  documents?: TransactionDocument[];
  pendingDocumentUploads?: TransactionPendingDocumentUpload[];
  requirements: TransactionRequirement[];
}
export interface LinkageProposalReason { label: string }
export interface TransactionLinkageProposal {
  id: string;
  invoiceId: string;
  transactionId: string;
  transactionVersion: number;
  propertyAddress: string;
  externalReference: string;
  lifecycle: TransactionLifecycle;
  score: number;
  reasons: LinkageProposalReason[];
  status: "PROPOSED" | "ACCEPTED";
}
export interface TransactionTypeOption { id: string; code: string; name: string }
export interface TransactionOwnerOption { userId: string; role: "TENANT_ADMIN" | "REVIEWER" | "VIEWER"; label: string }
export interface TransactionHealth { completionPercent: number; missingDocuments: number; invoiceConflicts: number; closingDays: number | null; outstandingByCurrency: Record<string, number>; calculationVersion: string }
export interface TransactionActionItem { id: string; transactionId: string; kind: "PROVIDE_DOCUMENT" | "PROVIDE_INFORMATION" | "RESOLVE_CONFLICT" | "CONFIRM_INFORMATION"; status: "OPEN" | "WAITING_FOR_EVIDENCE"; assignedTo: string | null; requirementKind: "ARTIFACT" | "FIELD"; requirementKey: string }

export async function listTransactionActionItems(tenantId: string): Promise<TransactionActionItem[]> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.from("work_items").select("id,record_id,kind,status,assigned_to,blocker_code")
    .eq("tenant_id", tenantId).eq("record_type", "TRANSACTION_FILE").in("status", ["OPEN", "WAITING_FOR_EVIDENCE"])
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Unable to load Transaction File tasks: ${error.message}`);
  return data.flatMap((row) => {
    const match = /^REQUIREMENT:(ARTIFACT|FIELD):(.+)$/.exec(String(row.blocker_code ?? ""));
    if (!match) return [];
    return [{ id: row.id as string, transactionId: row.record_id as string, kind: row.kind as TransactionActionItem["kind"],
      status: row.status as TransactionActionItem["status"], assignedTo: row.assigned_to as string | null,
      requirementKind: match[1] as TransactionActionItem["requirementKind"], requirementKey: match[2]! }];
  });
}

export async function listTransactionTypes(tenantId: string): Promise<TransactionTypeOption[]> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.from("transaction_types").select("id,code,name").eq("tenant_id", tenantId).eq("active", true).order("name");
  if (error) throw new Error(`Unable to load transaction types: ${error.message}`);
  return data.map((row) => ({ id: row.id as string, code: row.code as string, name: row.name as string }));
}

export async function listTransactionOwners(tenantId: string, currentUserId: string, currentUserLabel: string): Promise<TransactionOwnerOption[]> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.from("tenant_memberships").select("user_id,role").eq("tenant_id", tenantId).eq("active", true).neq("role", "INTEGRATION");
  if (error) throw new Error(`Unable to load eligible owners: ${error.message}`);
  return data.map((row) => ({ userId: row.user_id as string, role: row.role as TransactionOwnerOption["role"], label: row.user_id === currentUserId ? `${currentUserLabel} (you)` : `${humanRole(row.role as string)} · ${(row.user_id as string).slice(0, 8)}` }));
}

function humanRole(role: string): string { return role === "TENANT_ADMIN" ? "Administrator" : role === "REVIEWER" ? "Reviewer" : "Viewer"; }

export async function listTransactionFiles(tenantId: string): Promise<TransactionFile[]> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.from("transaction_files")
    .select("id, external_reference, property_address, transaction_type, office, key_dates, lifecycle, business_stage, version, updated_at, transaction_requirement_statuses(requirement_kind,requirement_key,status,confidence,resolved_value,stage_gate,requirement_source,template_mandated)")
    .eq("tenant_id", tenantId).order("updated_at", { ascending: false });
  if (error) throw new Error(`Unable to load Transaction Files: ${error.message}`);
  const { data: healthData, error: healthError } = await supabase.rpc("list_transaction_health", { target_tenant: tenantId });
  if (healthError) throw new Error(`Unable to load Transaction File health: ${healthError.message}`);
  const health = new Map((healthData as Array<{ transaction_file_id: string; completion_percent: number; missing_documents: number; invoice_conflicts: number; closing_days: number | null; outstanding_by_currency: Record<string, number>; calculation_version: string }>).map((item) => [item.transaction_file_id, item]));
  const { data: contextData, error: contextError } = await supabase.rpc("list_transaction_workspace_context", { target_tenant: tenantId });
  if (contextError) throw new Error(`Unable to load Transaction File context: ${contextError.message}`);
  const context = new Map((contextData as Array<{ transaction_file_id: string; transaction_type_id: string | null; transaction_type_name: string | null; owner_user_id: string | null; primary_party_id: string | null; primary_party_name: string | null; primary_party_role: TransactionPartyRole }>).map((item) => [item.transaction_file_id, item]));
  const [{ data: partyData, error: partyError }, { data: dateData, error: dateError }, { data: financialData, error: financialError }, { data: customDefinitionData, error: customDefinitionError }, { data: customValueData, error: customValueError }, { data: documentData, error: documentError }, { data: pendingDocumentData, error: pendingDocumentError }] = await Promise.all([
    supabase.from("transaction_party_assignments").select("transaction_file_id,role,is_primary,transaction_parties!inner(id,display_name,party_kind)").eq("tenant_id", tenantId),
    supabase.from("transaction_important_dates").select("id,transaction_file_id,date_kind,date_value,timestamp_value,timezone").eq("tenant_id", tenantId).order("date_kind"),
    supabase.from("transaction_financial_entries").select("id,transaction_file_id,financial_kind,label,amount,currency").eq("tenant_id", tenantId).order("financial_kind"),
    supabase.from("transaction_custom_field_definitions").select("id,transaction_file_id,field_key,label,data_type,required,stage_gate,validation").eq("tenant_id", tenantId).order("label"),
    supabase.from("transaction_custom_field_values").select("transaction_file_id,definition_id,normalized_value").eq("tenant_id", tenantId),
    supabase.rpc("list_transaction_documents", { target_tenant: tenantId }),
    supabase.rpc("list_transaction_document_uploads", { target_tenant: tenantId }),
  ]);
  if (partyError) throw new Error(`Unable to load transaction parties: ${partyError.message}`);
  if (dateError) throw new Error(`Unable to load important dates: ${dateError.message}`);
  if (financialError) throw new Error(`Unable to load transaction financials: ${financialError.message}`);
  if (customDefinitionError) throw new Error(`Unable to load required information: ${customDefinitionError.message}`);
  if (customValueError) throw new Error(`Unable to load required information values: ${customValueError.message}`);
  if (documentError) throw new Error(`Unable to load Transaction File documents: ${documentError.message}`);
  if (pendingDocumentError) throw new Error(`Unable to load pending document uploads: ${pendingDocumentError.message}`);
  const parties = groupByTransaction(partyData, (item) => item.transaction_file_id as string);
  const dates = groupByTransaction(dateData, (item) => item.transaction_file_id as string);
  const financials = groupByTransaction(financialData, (item) => item.transaction_file_id as string);
  const customDefinitions = groupByTransaction(customDefinitionData, (item) => item.transaction_file_id as string);
  const customValues = new Map(customValueData.map((item) => [item.definition_id as string, item.normalized_value]));
  const documents = groupByTransaction(documentData as Array<Record<string, unknown>>, (item) => item.transaction_file_id as string);
  const pendingDocuments = groupByTransaction(pendingDocumentData as Array<Record<string, unknown>>, (item) => item.transaction_file_id as string);
  return data.map((row) => ({
    id: row.id as string,
    externalReference: (row.external_reference as string | null) ?? "",
    propertyAddress: row.property_address as string,
    transactionType: context.get(row.id as string)?.transaction_type_name ?? (row.transaction_type as string | null) ?? "",
    ...(context.get(row.id as string)?.transaction_type_id ? { transactionTypeId: context.get(row.id as string)!.transaction_type_id! } : {}),
    ...(context.get(row.id as string)?.owner_user_id ? { ownerUserId: context.get(row.id as string)!.owner_user_id! } : {}),
    ...(context.get(row.id as string)?.primary_party_id ? { primaryParty: { id: context.get(row.id as string)!.primary_party_id!, name: context.get(row.id as string)!.primary_party_name!, role: context.get(row.id as string)!.primary_party_role } } : {}),
    office: (row.office as string | null) ?? "",
    keyDates: (row.key_dates as Record<string, string> | null) ?? {},
    lifecycle: row.lifecycle as TransactionLifecycle,
    businessStage: row.business_stage as TransactionStage,
    version: row.version as number,
    updatedAt: row.updated_at as string,
    ...(health.get(row.id as string) ? { health: { completionPercent: health.get(row.id as string)!.completion_percent, missingDocuments: health.get(row.id as string)!.missing_documents, invoiceConflicts: health.get(row.id as string)!.invoice_conflicts, closingDays: health.get(row.id as string)!.closing_days, outstandingByCurrency: health.get(row.id as string)!.outstanding_by_currency, calculationVersion: health.get(row.id as string)!.calculation_version } } : {}),
    parties: (parties.get(row.id as string) ?? []).map((item) => { const party = item.transaction_parties as unknown as { id: string; display_name: string; party_kind: "PERSON" | "ORGANIZATION" }; return { id: party.id, name: party.display_name, kind: party.party_kind, role: item.role as TransactionPartyRole, primary: item.is_primary as boolean }; }),
    importantDates: (dates.get(row.id as string) ?? []).map((item) => ({ id: item.id as string, kind: item.date_kind as TransactionImportantDate["kind"], date: item.date_value as string | null, timestamp: item.timestamp_value as string | null, timezone: item.timezone as string | null })),
    financials: (financials.get(row.id as string) ?? []).map((item) => ({ id: item.id as string, kind: item.financial_kind as TransactionFinancial["kind"], label: item.label as string, amount: Number(item.amount), currency: item.currency as string })),
    customFields: (customDefinitions.get(row.id as string) ?? []).map((item) => ({ id: item.id as string, key: item.field_key as string, label: item.label as string, dataType: item.data_type as TransactionCustomField["dataType"], required: item.required as boolean, stageGate: item.stage_gate as TransactionCustomField["stageGate"], validation: item.validation as Record<string, unknown>, ...(customValues.has(item.id as string) ? { value: customValues.get(item.id as string) } : {}) })),
    documents: (documents.get(row.id as string) ?? []).filter((item) => item.document_version_id).map((item) => ({ id: item.document_id as string, name: item.name as string, requirementKey: item.requirement_key as string | null, required: item.required as boolean, stageGate: item.stage_gate as TransactionDocument["stageGate"], versionId: item.document_version_id as string, version: Number(item.version), fileName: item.file_name as string, uploadedAt: item.uploaded_at as string, expiresOn: item.expires_on as string | null, status: item.effective_status as TransactionDocument["status"], decisionReason: item.decision_reason as string | null })),
    pendingDocumentUploads: (pendingDocuments.get(row.id as string) ?? []).map((item) => ({ id: item.intent_id as string, ingestionEventId: item.ingestion_event_id as string, requirementKey: item.requirement_key as string | null, documentName: item.document_name as string, status: item.intent_status as TransactionPendingDocumentUpload["status"], safetyStatus: item.safety_status as TransactionPendingDocumentUpload["safetyStatus"], processingStatus: item.processing_status as TransactionPendingDocumentUpload["processingStatus"], failureReason: item.failure_reason as string | null, createdAt: item.created_at as string })),
    requirements: (row.transaction_requirement_statuses as Array<{ requirement_kind: "ARTIFACT" | "FIELD"; requirement_key: string; status: RequirementStatus; confidence: number | null; resolved_value: string | null; stage_gate: "BEFORE_REVIEW" | "BEFORE_APPROVAL" | "BEFORE_CLOSING"; requirement_source: "TEMPLATE" | "TRANSACTION"; template_mandated: boolean }>).map((item) => ({ kind: item.requirement_kind, key: item.requirement_key, status: item.status, confidence: item.confidence === null ? null : Number(item.confidence), ...(item.resolved_value ? { value: item.resolved_value } : {}), stageGate: item.stage_gate, source: item.requirement_source, templateMandated: item.template_mandated })),
  }));
}

export async function listTransactionLinkageProposals(tenantId: string): Promise<TransactionLinkageProposal[]> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.from("transaction_linkage_proposals")
    .select("id, invoice_candidate_id, transaction_file_id, score, reasons, status, transaction_files!inner(external_reference,property_address,lifecycle,version)")
    .eq("tenant_id", tenantId).in("status", ["PROPOSED", "ACCEPTED"]).order("score", { ascending: false });
  if (error) throw new Error(`Unable to load Transaction File suggestions: ${error.message}`);
  return data.map((row) => {
    const transaction = row.transaction_files as unknown as { external_reference: string | null; property_address: string; lifecycle: TransactionLifecycle; version: number };
    const reasons = Array.isArray(row.reasons) ? row.reasons : [];
    return {
      id: row.id as string,
      invoiceId: row.invoice_candidate_id as string,
      transactionId: row.transaction_file_id as string,
      transactionVersion: transaction.version,
      propertyAddress: transaction.property_address,
      externalReference: transaction.external_reference ?? "",
      lifecycle: transaction.lifecycle,
      score: Number(row.score),
      reasons: reasons.filter((reason): reason is LinkageProposalReason => typeof reason === "object" && reason !== null && typeof (reason as { label?: unknown }).label === "string"),
      status: row.status as "PROPOSED" | "ACCEPTED",
    };
  });
}

export async function resolveTransactionLinkageProposal(input: { proposalId: string; invoiceVersion: number; transactionVersion: number; decision: "ACCEPT" | "REJECT"; actorId: string }): Promise<void> {
  await rpc("resolve_transaction_linkage_proposal", {
    target_proposal: input.proposalId, expected_invoice_version: input.invoiceVersion,
    expected_transaction_version: input.transactionVersion, target_decision: input.decision, actor: input.actorId,
  });
}

export interface CreateTransactionFileInput { tenantId: string; externalReference: string; propertyAddress: string; transactionTypeId: string; ownerId: string; primaryPartyName: string; primaryPartyKind: "PERSON" | "ORGANIZATION"; primaryPartyRole: "BUYER" | "SELLER" | "TENANT" | "LANDLORD"; actorId: string }

export async function createTransactionFile(input: CreateTransactionFileInput): Promise<string> {
  return rpc<string>("create_transaction_file_v2", { target_tenant: input.tenantId, target_external_reference: input.externalReference,
    target_property_address: input.propertyAddress, target_transaction_type: input.transactionTypeId, target_owner: input.ownerId,
    target_primary_party_name: input.primaryPartyName, target_primary_party_kind: input.primaryPartyKind,
    target_primary_party_role: input.primaryPartyRole, actor: input.actorId });
}

export async function addTransactionRequirement(input: { transactionId: string; version: number; kind: TransactionRequirement["kind"]; key: string; actorId: string }): Promise<number> {
  return rpc<number>("add_transaction_requirement", { target_transaction: input.transactionId, expected_version: input.version,
    target_kind: input.kind, target_key: input.key, actor: input.actorId });
}

export async function updateTransactionDetails(input: { transactionId: string; version: number; externalReference: string; propertyAddress: string; transactionType: string; office: string; closingDate: string; actorId: string }): Promise<number> {
  return rpc<number>("update_transaction_file_details", { target_transaction: input.transactionId, expected_version: input.version,
    target_external_reference: input.externalReference, target_property_address: input.propertyAddress,
    target_transaction_type: input.transactionType, target_office: input.office, target_closing_date: input.closingDate, actor: input.actorId });
}

export async function removeTransactionRequirement(input: { transactionId: string; version: number; requirement: TransactionRequirement; actorId: string }): Promise<number> {
  return rpc<number>("remove_transaction_requirement", { target_transaction: input.transactionId, expected_version: input.version,
    target_kind: input.requirement.kind, target_key: input.requirement.key, actor: input.actorId });
}

export async function linkInvoice(input: { invoiceId: string; invoiceVersion: number; transactionId: string; transactionVersion: number; actorId: string }): Promise<void> {
  await rpc("link_invoice_to_transaction", { target_invoice: input.invoiceId, expected_invoice_version: input.invoiceVersion,
    target_transaction: input.transactionId, expected_transaction_version: input.transactionVersion, actor: input.actorId });
}

export async function updateTransactionRequirement(input: { transactionId: string; version: number; requirement: TransactionRequirement; status: RequirementStatus; actorId: string }): Promise<number> {
  return rpc<number>("record_transaction_requirement", { target_transaction: input.transactionId, expected_version: input.version,
    target_kind: input.requirement.kind, target_key: input.requirement.key, target_status: input.status,
    target_confidence: input.status === "PRESENT" ? 1 : input.requirement.confidence, actor: input.actorId });
}

export async function setTransactionRequirementValue(input: { transactionId: string; version: number; requirementKey: string; value: string; actorId: string }): Promise<number> {
  return rpc<number>("set_transaction_requirement_value", { target_transaction: input.transactionId,
    expected_version: input.version, target_key: input.requirementKey, target_value: input.value, actor: input.actorId });
}

export async function evaluateConvergence(input: { transactionId: string; version: number; actorId: string }): Promise<TransactionLifecycle> {
  return rpc<TransactionLifecycle>("evaluate_transaction_convergence", { target_transaction: input.transactionId, expected_version: input.version, actor: input.actorId });
}

export async function approveTransaction(input: { transactionId: string; version: number; actorId: string }): Promise<TransactionLifecycle> {
  return rpc<TransactionLifecycle>("approve_transaction_file", { target_transaction: input.transactionId, expected_version: input.version, actor: input.actorId });
}

export async function reactivateTransaction(input: { transactionId: string; version: number; actorId: string }): Promise<TransactionLifecycle> {
  return rpc<TransactionLifecycle>("reactivate_transaction_file", { target_transaction: input.transactionId, expected_version: input.version, actor: input.actorId });
}

export async function beginTransactionWork(input: { transactionId: string; version: number; actorId: string }): Promise<TransactionStage> {
  return rpc<TransactionStage>("begin_transaction_work", { target_transaction: input.transactionId, expected_version: input.version, actor: input.actorId });
}

export async function submitTransactionForReview(input: { transactionId: string; version: number; actorId: string }): Promise<TransactionStage> {
  return rpc<TransactionStage>("submit_transaction_for_review", { target_transaction: input.transactionId, expected_version: input.version, actor: input.actorId });
}

export async function addTransactionParty(input: { transactionId: string; version: number; name: string; kind: TransactionParty["kind"]; role: TransactionPartyRole; primary: boolean; actorId: string }): Promise<string> {
  return rpc<string>("add_transaction_party", { target_transaction: input.transactionId, expected_version: input.version, target_name: input.name,
    target_kind: input.kind, target_role: input.role, target_primary: input.primary, actor: input.actorId });
}

export async function setTransactionImportantDate(input: { transactionId: string; version: number; kind: TransactionImportantDate["kind"]; date: string; actorId: string }): Promise<number> {
  return rpc<number>("set_transaction_important_date", { target_transaction: input.transactionId, expected_version: input.version,
    target_kind: input.kind, target_date: input.date, target_timestamp: null, target_timezone: null, actor: input.actorId });
}

export async function setTransactionFinancial(input: { transactionId: string; version: number; kind: TransactionFinancial["kind"]; label: string; amount: number; currency: string; actorId: string }): Promise<number> {
  return rpc<number>("set_transaction_financial", { target_transaction: input.transactionId, expected_version: input.version,
    target_kind: input.kind, target_label: input.label, target_amount: input.amount, target_currency: input.currency, actor: input.actorId });
}

export async function addTransactionCustomField(input: { transactionId: string; version: number; key: string; label: string; dataType: TransactionCustomField["dataType"]; required: boolean; stageGate: TransactionCustomField["stageGate"]; actorId: string }): Promise<string> {
  return rpc<string>("add_transaction_custom_field", { target_transaction: input.transactionId, expected_version: input.version,
    target_key: input.key, target_label: input.label, target_type: input.dataType, target_required: input.required,
    target_gate: input.stageGate, target_validation: {}, actor: input.actorId });
}

export async function setTransactionCustomFieldValue(input: { transactionId: string; version: number; definitionId: string; value: unknown; actorId: string }): Promise<number> {
  return rpc<number>("set_transaction_custom_field_value", { target_transaction: input.transactionId, expected_version: input.version,
    target_definition: input.definitionId, target_value: input.value, target_provenance: { method: "MANUAL" }, actor: input.actorId });
}

export async function stageTransactionDocumentUpload(input: { transactionId: string; version: number; evidenceArtifactId: string; requirementKey: string; documentName: string; expiresOn?: string; actorId: string }): Promise<string> {
  return rpc<string>("stage_transaction_document_upload", {
    target_transaction: input.transactionId, expected_version: input.version,
    target_evidence: input.evidenceArtifactId, target_requirement_key: input.requirementKey,
    target_name: input.documentName, target_expires_on: input.expiresOn || null, actor: input.actorId,
  });
}

export async function cancelTransactionDocumentUpload(input: { transactionId: string; ingestionEventId: string; actorId: string }): Promise<"CANCEL_REQUESTED" | "CANCELLED"> {
  return rpc<"CANCEL_REQUESTED" | "CANCELLED">("cancel_transaction_document_upload", {
    target_transaction: input.transactionId,
    target_ingestion_event: input.ingestionEventId,
    actor: input.actorId,
  });
}

export async function reviewTransactionDocument(input: { transactionId: string; version: number; documentVersionId: string; decision: "VERIFIED" | "REJECTED"; reason?: string; actorId: string }): Promise<number> {
  return rpc<number>("review_transaction_document", { target_transaction: input.transactionId,
    expected_version: input.version, target_document_version: input.documentVersionId,
    target_decision: input.decision, target_reason: input.reason ?? null, actor: input.actorId });
}

function groupByTransaction<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) grouped.set(key(item), [...(grouped.get(key(item)) ?? []), item]);
  return grouped;
}

async function rpc<T = unknown>(name: string, parameters: Record<string, unknown>): Promise<T> {
  if (!supabase) throw new Error("Supabase is not configured");
  const { data, error } = await supabase.rpc(name, parameters);
  if (error) throw friendlyTransactionError(error.message);
  return data as T;
}

function friendlyTransactionError(message: string): Error {
  if (message.includes("changed; refresh")) return new Error("This Transaction File changed. Refresh and try again.");
  if (message.includes("already been resolved")) return new Error("This suggestion was already reviewed. Refresh to see the latest matches.");
  if (message.includes("already linked")) return new Error("This invoice is already linked to a Transaction File.");
  if (message.includes("unresolved requirement")) return new Error("Complete the remaining requirements before marking this file ready for review.");
  if (message.includes("another reviewer")) return new Error("Another reviewer must provide final approval for this file.");
  if (message.includes("not accepting invoice links")) return new Error("This Transaction File is not accepting new invoices.");
  if (message.includes("role cannot")) return new Error("Your role does not allow this action.");
  if (message.includes("keep at least one requirement")) return new Error("Add another requirement before removing this one.");
  if (message.includes("Before Review requirement")) return new Error("Complete the items marked Before review, then submit again.");
  if (message.includes("assigned owner, coordinator")) return new Error("Only the assigned owner, coordinator, or an administrator can perform this action.");
  if (message.includes("cannot be edited in its current stage")) return new Error("This Transaction File is closed and cannot be edited.");
  if (message.includes("time zone is required")) return new Error("Choose a time zone when entering a specific time.");
  if (message.includes("three-letter code")) return new Error("Enter a valid three-letter currency code, such as USD or INR.");
  if (message.includes("does not match the custom field rules")) return new Error("Enter a value that matches this field's format and limits.");
  if (message.includes("document requirement not found")) return new Error("This document requirement no longer exists. Refresh and try again.");
  if (message.includes("replace the file because")) return new Error("This file did not pass the safety check. Choose a different file.");
  if (message.includes("document expiry")) return new Error("Choose today or a future expiry date.");
  if (message.includes("already assigned")) return new Error("This file is already attached to a Transaction File.");
  if (message.includes("required information value is empty")) return new Error("Enter the missing information before saving.");
  if (message.includes("required information field not found")) return new Error("This information requirement no longer exists. Refresh and try again.");
  if (message.includes("explain why the document was rejected")) return new Error("Enter a reason so the uploader knows what to replace or correct.");
  if (message.includes("only the current document version")) return new Error("A newer version of this document is available. Refresh before reviewing it.");
  return new Error(message);
}
