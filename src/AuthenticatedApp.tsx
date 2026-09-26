import type { Session } from "@supabase/supabase-js";
import { LockKeyhole, Upload } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { App } from "./App.js";
import type { InvoiceDraft, QueueItem } from "./App.js";
import { isSupabaseConfigured, supabase } from "./infrastructure/supabase/client.js";
import { listInvoices, reprocessInvoice, saveInvoiceField, verifyInvoice, type PersistedInvoice } from "./infrastructure/supabase/invoices.js";
import { cancelIntakeScan, listIntakeReceipts, uploadEvidence, type IntakeQueueItem } from "./infrastructure/supabase/manual-intake.js";
import { loadWorkspaceSession, signIn, signOut, type WorkspaceSession } from "./infrastructure/supabase/session.js";
import { getCurrentApprovalPolicy, publishApprovalPolicy, type ApprovalPolicy } from "./infrastructure/supabase/approval-policies.js";
import { ApprovalPolicySettings } from "./ApprovalPolicySettings.js";
import { addTransactionCustomField, addTransactionParty, addTransactionRequirement, approveTransaction, beginTransactionWork, completeTransactionReview, createTransactionFile, evaluateConvergence, linkInvoice, listTransactionActionItems, listTransactionFiles, listTransactionLinkageProposals, listTransactionOwners, listTransactionTypes, reactivateTransaction, removeTransactionRequirement, resolveTransactionLinkageProposal, reviewTransactionDocument, setTransactionCustomFieldValue, setTransactionFinancial, setTransactionImportantDate, setTransactionInvoicePayment, setTransactionRequirementValue, stageTransactionDocumentUpload, submitTransactionForReview, updateTransactionDetails, updateTransactionRequirement, type TransactionActionItem, type TransactionCustomField, type TransactionDocument, type TransactionFile, type TransactionFinancial, type TransactionImportantDate, type TransactionInvoice, type TransactionLinkageProposal, type TransactionOwnerOption, type TransactionParty, type TransactionPartyRole, type TransactionPaymentStatus, type TransactionRequirement, type TransactionTypeOption } from "./infrastructure/supabase/transactions.js";
import { cancelTransactionDocumentUpload as cancelDocumentUpload } from "./infrastructure/supabase/transactions.js";
import { cancelTransactionFile, closeTransactionFile, createTransactionIssue, reopenTransactionFile, resolveInvoiceContextReview, resolveTransactionIssue, unlinkInvoice, type TransactionIssue, type TransactionIssueSeverity } from "./infrastructure/supabase/transactions.js";
import { TransactionWorkspace } from "./TransactionWorkspace.js";

export function AuthenticatedApp() {
  const [session, setSession] = useState<Session | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSession | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<PersistedInvoice[] | null>(null);
  const [intakeMessage, setIntakeMessage] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<IntakeQueueItem[]>([]);
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [transactions, setTransactions] = useState<TransactionFile[]>([]);
  const [linkageProposals, setLinkageProposals] = useState<TransactionLinkageProposal[]>([]);
  const [transactionTypes, setTransactionTypes] = useState<TransactionTypeOption[]>([]);
  const [transactionOwners, setTransactionOwners] = useState<TransactionOwnerOption[]>([]);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);
  const [transactionActions, setTransactionActions] = useState<TransactionActionItem[]>([]);

  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setWorkspace(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    withTimeout(loadWorkspaceSession(session), 12000, "Workspace loading timed out")
      .then(async (result) => {
        const [loadedInvoices, loadedReceipts, loadedPolicy, loadedTransactions, loadedProposals, loadedTypes, loadedOwners, loadedActions] = await withTimeout(Promise.all([listInvoices(), listIntakeReceipts(result.tenantId), getCurrentApprovalPolicy(result.tenantId), listTransactionFiles(result.tenantId), listTransactionLinkageProposals(result.tenantId), listTransactionTypes(result.tenantId), listTransactionOwners(result.tenantId, session.user.id, session.user.email ?? "Current user"), listTransactionActionItems(result.tenantId)]), 12000, "Workspace data loading timed out");
        if (cancelled) return;
        setWorkspace(result);
        setInvoices(loadedInvoices);
        setReceipts(loadedReceipts);
        setApprovalPolicy(loadedPolicy);
        setTransactions(loadedTransactions);
        setLinkageProposals(loadedProposals);
        setTransactionTypes(loadedTypes);
        setTransactionOwners(loadedOwners);
        setTransactionActions(loadedActions);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setWorkspace(null);
        setError(reason instanceof Error ? reason.message : "Unable to load workspace");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [session?.user.id, bootstrapAttempt]);

  useEffect(() => {
    if (!workspace) return;
    const timer = window.setInterval(() => {
      void Promise.allSettled([listInvoices(), listIntakeReceipts(workspace.tenantId), listTransactionFiles(workspace.tenantId), listTransactionLinkageProposals(workspace.tenantId), listTransactionActionItems(workspace.tenantId)]).then(([invoiceResult, receiptResult, transactionResult, proposalResult, actionResult]) => {
        if (invoiceResult.status === "fulfilled") setInvoices(invoiceResult.value);
        if (receiptResult.status === "fulfilled") setReceipts(receiptResult.value);
        if (transactionResult.status === "fulfilled") setTransactions(transactionResult.value);
        if (proposalResult.status === "fulfilled") setLinkageProposals(proposalResult.value);
        if (actionResult.status === "fulfilled") setTransactionActions(actionResult.value);
        const failed = [invoiceResult, receiptResult, transactionResult, proposalResult, actionResult].filter((result) => result.status === "rejected").length;
        setSyncWarning(failed > 0 ? `Some workspace updates could not be refreshed (${failed}). Your saved data is unchanged; retry shortly.` : null);
      });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [workspace]);

  if (!isSupabaseConfigured) return <App />;
  if (loading) return <AuthStatus message="Loading workspace..." />;
  if (session && error && !workspace) return <WorkspaceLoadError error={error} onRetry={() => setBootstrapAttempt((attempt) => attempt + 1)} onSignOut={signOut} />;
  if (!session || !workspace) return <SignIn error={error} onError={setError} />;
  async function upload(file: File) {
    const receipt = await uploadEvidence({ tenantId: workspace!.tenantId, actorId: session!.user.id, file });
    setIntakeMessage(`Upload received. Receipt ${receipt.ingestionEventId.slice(0, 8)} is queued for safety scanning.`);
    setReceipts(await listIntakeReceipts(workspace!.tenantId));
  }
  async function cancelScan(ingestionEventId: string) {
    await cancelIntakeScan({ tenantId: workspace!.tenantId, ingestionEventId, actorId: session!.user.id });
    setReceipts(await listIntakeReceipts(workspace!.tenantId));
  }

  async function reloadTransactions() { setTransactions(await listTransactionFiles(workspace!.tenantId)); }
  async function reloadLinkageProposals() { setLinkageProposals(await listTransactionLinkageProposals(workspace!.tenantId)); }
  async function createTransaction(input: { externalReference: string; propertyAddress: string; transactionTypeId: string; ownerId: string; primaryPartyName: string; primaryPartyKind: "PERSON" | "ORGANIZATION"; primaryPartyRole: "BUYER" | "SELLER" | "TENANT" | "LANDLORD" }) {
    await createTransactionFile({ tenantId: workspace!.tenantId, actorId: session!.user.id, ...input }); await reloadTransactions();
  }
  async function addRequirement(transaction: TransactionFile, input: { kind: "ARTIFACT" | "FIELD"; key: string }) {
    const version = await addTransactionRequirement({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id, ...input });
    patchTransaction(transaction.id, (item) => ({ ...item, version, ...reviewStagePatch(item.businessStage), requirements: [...item.requirements, { ...input, status: "MISSING", confidence: null, stageGate: "BEFORE_REVIEW", source: "TRANSACTION", templateMandated: false }] }));
  }
  async function editTransaction(transaction: TransactionFile, input: { externalReference: string; propertyAddress: string; transactionType: string; office: string; closingDate: string }) {
    const version = await updateTransactionDetails({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id, ...input });
    patchTransaction(transaction.id, (item) => ({ ...item, version, ...reviewStagePatch(item.businessStage), externalReference: input.externalReference, propertyAddress: input.propertyAddress, transactionType: input.transactionType, office: input.office, keyDates: input.closingDate ? { closingDate: input.closingDate } : {} }));
  }
  async function removeRequirement(transaction: TransactionFile, requirement: TransactionRequirement) {
    const version = await removeTransactionRequirement({ transactionId: transaction.id, version: transaction.version, requirement, actorId: session!.user.id });
    patchTransaction(transaction.id, (item) => ({ ...item, version, ...reviewStagePatch(item.businessStage), requirements: item.requirements.filter((candidate) => candidate.kind !== requirement.kind || candidate.key !== requirement.key) }));
  }
  async function changeRequirement(transaction: TransactionFile, requirement: import("./infrastructure/supabase/transactions.js").TransactionRequirement, status: import("./infrastructure/supabase/transactions.js").RequirementStatus) {
    const version = await updateTransactionRequirement({ transactionId: transaction.id, version: transaction.version, requirement, status, actorId: session!.user.id });
    patchTransaction(transaction.id, (item) => ({ ...item, version, ...reviewStagePatch(item.businessStage), requirements: item.requirements.map((candidate) => candidate.kind === requirement.kind && candidate.key === requirement.key ? { ...candidate, status, confidence: status === "PRESENT" ? 1 : null } : candidate) }));
  }
  async function convergeTransaction(transaction: TransactionFile) {
    await evaluateConvergence({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id }); await reloadTransactions();
  }
  async function finalizeTransaction(transaction: TransactionFile) {
    await approveTransaction({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id }); await reloadTransactions();
  }
  async function restoreTransaction(transaction: TransactionFile) {
    await reactivateTransaction({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id }); const [nextInvoices] = await Promise.all([listInvoices(), reloadTransactions()]); setInvoices(nextInvoices);
  }
  async function beginWork(transaction: TransactionFile) {
    const businessStage = await beginTransactionWork({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id });
    patchTransaction(transaction.id, (item) => ({ ...item, version: item.version + 1, businessStage }));
  }
  async function submitForReview(transaction: TransactionFile) {
    const businessStage = await submitTransactionForReview({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id });
    patchTransaction(transaction.id, (item) => ({ ...item, version: item.version + 1, businessStage }));
  }
  async function completeReview(transaction: TransactionFile) {
    const businessStage = await completeTransactionReview({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id });
    patchTransaction(transaction.id, (item) => ({ ...item, version: item.version + 1, businessStage }));
  }
  function patchTransaction(transactionId: string, update: (transaction: TransactionFile) => TransactionFile) {
    setTransactions((current) => current.map((item) => item.id === transactionId ? update(item) : item));
  }
  async function addParty(transaction: TransactionFile, input: { name: string; kind: TransactionParty["kind"]; role: TransactionPartyRole; primary: boolean }) {
    const id = await addTransactionParty({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id, ...input });
    patchTransaction(transaction.id, (item) => ({ ...item, version: item.version + 1,
      ...reviewStagePatch(item.businessStage),
      parties: [...(item.parties ?? []).map((party) => input.primary ? { ...party, primary: false } : party), { id, name: input.name, kind: input.kind, role: input.role, primary: input.primary }],
    }));
  }
  async function setImportantDate(transaction: TransactionFile, input: { kind: TransactionImportantDate["kind"]; date: string }) {
    const version = await setTransactionImportantDate({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id, ...input });
    patchTransaction(transaction.id, (item) => ({ ...item, version,
      ...reviewStagePatch(item.businessStage),
      importantDates: [...(item.importantDates ?? []).filter((date) => date.kind !== input.kind), { id: `date-${input.kind}`, kind: input.kind, date: input.date, timestamp: null, timezone: null }],
      ...(input.kind === "CLOSING" ? { keyDates: { ...(item.keyDates ?? {}), closingDate: input.date } } : {}),
    }));
  }
  async function setFinancial(transaction: TransactionFile, input: { kind: TransactionFinancial["kind"]; label: string; amount: number; currency: string }) {
    const version = await setTransactionFinancial({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id, ...input });
    patchTransaction(transaction.id, (item) => ({ ...item, version,
      ...reviewStagePatch(item.businessStage),
      financials: [...(item.financials ?? []).filter((entry) => !(entry.kind === input.kind && entry.label === input.label)), { id: `financial-${input.kind}-${input.label}`, ...input }],
    }));
  }
  async function addCustomField(transaction: TransactionFile, input: { key: string; label: string; dataType: TransactionCustomField["dataType"]; required: boolean; stageGate: TransactionCustomField["stageGate"] }) {
    const id = await addTransactionCustomField({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id, ...input });
    patchTransaction(transaction.id, (item) => ({ ...item, version: item.version + 1, ...reviewStagePatch(item.businessStage), customFields: [...(item.customFields ?? []), { id, ...input, validation: {} }] }));
  }
  async function setCustomFieldValue(transaction: TransactionFile, field: TransactionCustomField, value: unknown) {
    const version = await setTransactionCustomFieldValue({ transactionId: transaction.id, version: transaction.version, definitionId: field.id, value, actorId: session!.user.id });
    patchTransaction(transaction.id, (item) => ({ ...item, version, ...reviewStagePatch(item.businessStage), customFields: (item.customFields ?? []).map((candidate) => candidate.id === field.id ? { ...candidate, value } : candidate) }));
  }
  async function uploadTransactionDocument(transaction: TransactionFile, requirement: TransactionRequirement, file: File) {
    const receipt = await uploadEvidence({ tenantId: workspace!.tenantId, actorId: session!.user.id, file });
    try {
      const intentId = await stageTransactionDocumentUpload({ transactionId: transaction.id, version: transaction.version, evidenceArtifactId: receipt.evidenceArtifactId,
        requirementKey: requirement.key, documentName: humanizeRequirement(requirement.key), actorId: session!.user.id });
      patchTransaction(transaction.id, (item) => ({ ...item, pendingDocumentUploads: [...(item.pendingDocumentUploads ?? []).filter((upload) => upload.requirementKey !== requirement.key), {
        id: intentId, ingestionEventId: receipt.ingestionEventId, requirementKey: requirement.key,
        documentName: humanizeRequirement(requirement.key), status: "WAITING_FOR_SCAN", safetyStatus: "PENDING",
        processingStatus: "QUEUED", failureReason: null, createdAt: new Date().toISOString(),
      }] }));
    } catch (reason) {
      await cancelIntakeScan({ tenantId: workspace!.tenantId, ingestionEventId: receipt.ingestionEventId, actorId: session!.user.id }).catch(() => undefined);
      throw reason;
    }
    const [nextReceipts] = await Promise.all([listIntakeReceipts(workspace!.tenantId), reloadTransactions()]);
    setReceipts(nextReceipts);
  }
  async function cancelTransactionDocumentUpload(transaction: TransactionFile, ingestionEventId: string) {
    await cancelDocumentUpload({ transactionId: transaction.id, ingestionEventId, actorId: session!.user.id });
    await reloadTransactions();
  }
  async function saveRequirementValue(transaction: TransactionFile, requirement: TransactionRequirement, value: string) {
    const version = await setTransactionRequirementValue({ transactionId: transaction.id, version: transaction.version,
      requirementKey: requirement.key, value, actorId: session!.user.id });
    patchTransaction(transaction.id, (item) => ({ ...item, version, ...reviewStagePatch(item.businessStage),
      requirements: item.requirements.map((candidate) => candidate.kind === "FIELD" && candidate.key === requirement.key
        ? { ...candidate, value, status: "PRESENT", confidence: 1 } : candidate) }));
  }
  async function reviewDocument(transaction: TransactionFile, document: TransactionDocument, decision: "VERIFIED" | "REJECTED", reason?: string) {
    await reviewTransactionDocument({ transactionId: transaction.id, version: transaction.version, documentVersionId: document.versionId,
      decision, ...(reason ? { reason } : {}), actorId: session!.user.id });
    await reloadTransactions();
    setTransactionActions(await listTransactionActionItems(workspace!.tenantId));
  }
  async function updateInvoicePayment(transaction: TransactionFile, invoice: TransactionInvoice, input: { status: TransactionPaymentStatus; paidAmount: number; scheduledFor?: string; note?: string }) {
    await setTransactionInvoicePayment({ transactionId: transaction.id, version: transaction.version, invoiceId: invoice.id, actorId: session!.user.id, ...input });
    await reloadTransactions();
  }
  async function unlinkTransactionInvoice(transaction: TransactionFile, invoice: TransactionInvoice, reason: string) {
    await unlinkInvoice({ invoiceId: invoice.id, invoiceVersion: invoice.version, transactionVersion: transaction.version, reason, actorId: session!.user.id });
    const [nextInvoices] = await Promise.all([listInvoices(), reloadTransactions()]); setInvoices(nextInvoices);
  }
  async function reviewTransactionInvoiceContext(transaction: TransactionFile, invoice: TransactionInvoice, resolution: string) {
    await resolveInvoiceContextReview({ invoiceId: invoice.id, invoiceVersion: invoice.version, transactionVersion: transaction.version, resolution, actorId: session!.user.id });
    await reloadTransactions();
  }
  async function addIssue(transaction: TransactionFile, input: { title: string; category: string; severity: TransactionIssueSeverity; blocking: boolean; ownerUserId?: string; dueDate?: string }) {
    await createTransactionIssue({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id, ...input });
    await reloadTransactions();
  }
  async function resolveIssue(transaction: TransactionFile, issue: TransactionIssue, resolution: string) {
    await resolveTransactionIssue({ issueId: issue.id, version: transaction.version, resolution, actorId: session!.user.id });
    await reloadTransactions();
  }
  async function closeFile(transaction: TransactionFile) { await closeTransactionFile({ transactionId: transaction.id, version: transaction.version, actorId: session!.user.id }); await reloadTransactions(); }
  async function cancelFile(transaction: TransactionFile, reason: string) { await cancelTransactionFile({ transactionId: transaction.id, version: transaction.version, reason, actorId: session!.user.id }); await reloadTransactions(); }
  async function reopenFile(transaction: TransactionFile, reason: string) { await reopenTransactionFile({ transactionId: transaction.id, version: transaction.version, reason, actorId: session!.user.id }); await reloadTransactions(); }

  if (!invoices?.length && receipts.length === 0 && transactions.length === 0 && transactionActions.length === 0) return <>{syncWarning ? <SyncWarning message={syncWarning} /> : null}<EmptyWorkspace workspaceName={workspace.tenantName} intakeMessage={intakeMessage} onUpload={upload} onSignOut={signOut} role={workspace.role} approvalPolicy={approvalPolicy} transactions={transactions} transactionTypes={transactionTypes} transactionOwners={transactionOwners} onCreateTransaction={createTransaction} onAddRequirement={addRequirement} onUpdateRequirement={changeRequirement} onEvaluateTransaction={convergeTransaction} onApproveTransaction={finalizeTransaction} onReactivateTransaction={restoreTransaction} onBeginWork={beginWork} onSubmitReview={submitForReview} onAddParty={addParty} onSetDate={setImportantDate} onSetFinancial={setFinancial} onAddCustomField={addCustomField} onSetCustomFieldValue={setCustomFieldValue} onUploadDocument={uploadTransactionDocument} onSetRequirementValue={saveRequirementValue} onPublish={async (mode, rules) => {
    const published = await publishApprovalPolicy({ tenantId: workspace.tenantId, mode, rules, actorId: session.user.id });
    setApprovalPolicy(published);
    return published;
  }} /></>;
  const { items, drafts } = toAppInvoices(invoices ?? [], receipts);
  return <>{syncWarning ? <SyncWarning message={syncWarning} /> : null}<App key={items.map((item) => `${item.id}:${item.status}:${item.databaseVersion ?? 0}`).join("|")} workspaceName={workspace.tenantName} userEmail={session.user.email ?? "Signed-in user"} initialQueueItems={items} initialInvoiceDrafts={drafts} workspaceRole={workspace.role} approvalPolicy={approvalPolicy} transactions={transactions} transactionActions={transactionActions.map((item) => ({ ...item, assignedToMe: item.assignedTo === session.user.id }))} linkageProposals={linkageProposals} transactionTypes={transactionTypes} transactionOwners={transactionOwners}
    onPersistField={(input) => saveInvoiceField({ ...input, actorId: session.user.id })}
    onVerify={(input) => verifyInvoice({ ...input, actorId: session.user.id })}
    onReprocess={async (input) => {
      await reprocessInvoice({ ...input, actorId: session.user.id });
      const [nextInvoices, nextReceipts] = await Promise.all([listInvoices(), listIntakeReceipts(workspace.tenantId)]);
      setInvoices(nextInvoices);
      setReceipts(nextReceipts);
    }}
    onUpload={upload}
    onCancelIntake={cancelScan}
    onCreateTransaction={createTransaction}
    onAddTransactionRequirement={addRequirement}
    onUpdateTransactionDetails={editTransaction}
    onRemoveTransactionRequirement={removeRequirement}
    onBeginTransactionWork={beginWork}
    onSubmitTransactionReview={submitForReview}
    onCompleteTransactionReview={completeReview}
    onAddTransactionParty={addParty}
    onSetTransactionDate={setImportantDate}
    onSetTransactionFinancial={setFinancial}
    onAddTransactionCustomField={addCustomField}
    onSetTransactionCustomFieldValue={setCustomFieldValue}
    onUploadTransactionDocument={uploadTransactionDocument}
    onSetTransactionRequirementValue={saveRequirementValue}
    onReviewTransactionDocument={reviewDocument}
    onCancelTransactionDocumentUpload={cancelTransactionDocumentUpload}
    onSetTransactionInvoicePayment={updateInvoicePayment}
    onUnlinkTransactionInvoice={unlinkTransactionInvoice}
    onReviewTransactionInvoiceContext={reviewTransactionInvoiceContext}
    onCreateTransactionIssue={addIssue}
    onResolveTransactionIssue={resolveIssue}
    onCloseTransactionFile={closeFile}
    onCancelTransactionFile={cancelFile}
    {...(workspace.role === "TENANT_ADMIN" ? { onReopenTransactionFile: reopenFile } : {})}
    onLinkTransaction={async (transaction, invoice) => { await linkInvoice({ invoiceId: invoice.id, invoiceVersion: invoice.databaseVersion!, transactionId: transaction.id, transactionVersion: transaction.version, actorId: session.user.id }); const [nextInvoices] = await Promise.all([listInvoices(), reloadTransactions()]); setInvoices(nextInvoices); }}
    onResolveLinkageProposal={async (proposal, invoice, decision) => {
      await resolveTransactionLinkageProposal({ proposalId: proposal.id, invoiceVersion: invoice.databaseVersion!, transactionVersion: proposal.transactionVersion, decision, actorId: session.user.id });
      const [nextInvoices] = await Promise.all([listInvoices(), reloadTransactions(), reloadLinkageProposals()]);
      setInvoices(nextInvoices);
    }}
    onUpdateTransactionRequirement={changeRequirement}
    onEvaluateTransaction={convergeTransaction}
    onApproveTransaction={finalizeTransaction}
    onReactivateTransaction={restoreTransaction}
    onPublishApprovalPolicy={async (mode, rules) => {
      const published = await publishApprovalPolicy({ tenantId: workspace.tenantId, mode, rules, actorId: session.user.id });
      setApprovalPolicy(published);
      return published;
    }}
    onSignOut={async () => {
    setLoading(true);
    setError(null);
    try {
      await signOut();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign out failed");
      setLoading(false);
    }
  }} /></>;
}

function toAppInvoices(invoices: PersistedInvoice[], receipts: IntakeQueueItem[]): { items: QueueItem[]; drafts: Record<string, InvoiceDraft> } {
  const items: QueueItem[] = invoices.map((invoice) => {
    const lineItems = extractedLineItems(invoice.fields);
    const lineItem = lineItems[0] ?? { description: "", quantity: "", unitPrice: "", amount: "" };
    return {
    id: invoice.id,
    issuer: invoice.issuer,
    reference: invoice.linkageStatus === "LINKED" ? "Linked Transaction File" : "Standalone invoice",
    amount: invoice.total === null ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: invoice.currency }).format(invoice.total),
    age: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(invoice.updatedAt)),
    status: invoice.lifecycle === "VERIFIED" ? "Verified" : invoice.lifecycle === "PENDING_REVIEW" || invoice.lifecycle === "READY_FOR_VERIFICATION" ? "Ready to review" : "Needs attention",
    origin: invoice.origin,
    linked: invoice.linkageStatus === "LINKED",
    ...(invoice.transactionFileId ? { linkedTransactionId: invoice.transactionFileId } : {}),
    invoiceNumber: invoice.origin === "Generated" ? invoice.officialInvoiceNumber : invoice.sourceInvoiceNumber,
    description: lineItem.description,
    assignedToMe: true,
    databaseVersion: invoice.version,
    ...(invoice.sourceUrl ? { sourceUrl: invoice.sourceUrl } : {}),
    ...(invoice.sourceMediaType ? { sourceMediaType: invoice.sourceMediaType } : {}),
    ...(lineItems.length ? { lineItems } : {}),
    subtotalAmount: formatInvoiceAmount(invoice.fields.subtotal, invoice.currency),
    taxAmount: formatInvoiceAmount(invoice.fields.tax ?? 0, invoice.currency),
    };
  });
  for (const receipt of receipts) items.push({
    id: `intake-${receipt.ingestionEventId}`,
    issuer: receipt.fileName,
    reference: receipt.safetyStatus === "QUARANTINED" ? "Upload requires replacement" : "Manual upload · awaiting recognition",
    amount: "—",
    age: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(receipt.receivedAt)),
    status: receipt.safetyStatus === "QUARANTINED" || receipt.processingStatus === "FAILED" ? "Quarantined" : "Processing",
    origin: "Captured",
    linked: false,
    ...(receipt.quarantineReason ? { blocker: receipt.quarantineReason } : receipt.processingStatus === "FAILED" ? { blocker: "Processing failed" } : {}),
    description: "Recognition pending",
    assignedToMe: true,
    intakeStage: receipt.safetyStatus === "QUARANTINED" ? "QUARANTINED" : receipt.processingStatus === "FAILED" ? "PROCESSING_FAILED" : receipt.processingStage === "EXTRACT_EVIDENCE" ? "EXTRACTING" : receipt.processingStage === "ASSEMBLE_INVOICE" ? "ASSEMBLING" : receipt.processingStatus === "RUNNING" ? "SCANNING" : "QUEUED_FOR_SCAN",
    ingestionEventId: receipt.ingestionEventId,
    intakeReceivedAt: receipt.receivedAt,
  });
  const drafts: Record<string, InvoiceDraft> = Object.fromEntries(invoices.map((invoice) => {
    const lineItem = extractedLineItems(invoice.fields)[0] ?? { description: "", quantity: "", unitPrice: "", amount: "" };
    return [invoice.id, {
    invoiceNumber: invoice.origin === "Generated" ? invoice.officialInvoiceNumber : invoice.sourceInvoiceNumber,
    date: String(invoice.fields.invoiceDate ?? invoice.fields.date ?? ""),
    issuer: invoice.issuer,
    billTo: String(invoice.fields.billTo ?? ""),
    currency: invoice.currency,
    description: lineItem.description,
    quantity: lineItem.quantity,
    rate: lineItem.unitPrice,
    }];
  }));
  for (const receipt of receipts) drafts[`intake-${receipt.ingestionEventId}`] = { invoiceNumber: "", date: "", issuer: receipt.fileName, billTo: "", currency: "USD", description: "", quantity: "1", rate: "0" };
  return { items, drafts };
}

function extractedLineItems(fields: Record<string, unknown>): Array<{ description: string; quantity: string; unitPrice: string; amount: string }> {
  if (!Array.isArray(fields.lineItems)) return [];
  return fields.lineItems.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    return [{
      description: typeof item.description === "string" ? item.description : "",
      quantity: typeof item.quantity === "string" || typeof item.quantity === "number" ? String(item.quantity) : "",
      unitPrice: typeof item.unitPrice === "string" || typeof item.unitPrice === "number" ? String(item.unitPrice) : "",
      amount: typeof item.amount === "string" || typeof item.amount === "number" ? String(item.amount) : "",
    }];
  });
}

function formatInvoiceAmount(value: unknown, currency: string): string {
  const amount = typeof value === "number" || typeof value === "string" ? Number(value) : 0;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(Number.isFinite(amount) ? amount : 0);
}

function invalidateReviewStage(stage: TransactionFile["businessStage"]): TransactionFile["businessStage"] {
  return stage === "UNDER_REVIEW" || stage === "READY_FOR_CLOSING" ? "DOCUMENTS_PENDING" : stage;
}

function reviewStagePatch(stage: TransactionFile["businessStage"]): Pick<TransactionFile, "businessStage"> | Record<string, never> {
  const next = invalidateReviewStage(stage);
  return next ? { businessStage: next } : {};
}

function SignIn({ error, onError }: { error: string | null; onError: (error: string | null) => void }) {
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    setSubmitting(true);
    onError(null);
    try {
      await signIn(String(values.get("email")), String(values.get("password")));
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Sign in failed");
      setSubmitting(false);
    }
  }

  return <main className="auth-page">
    <form className="auth-form" onSubmit={submit}>
      <div className="auth-mark"><LockKeyhole size={20} /></div>
      <h1>Sign in to ThreadMerge</h1>
      <p>Use the account assigned to your brokerage workspace.</p>
      <label>Email<input name="email" type="email" autoComplete="email" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      {error ? <div className="auth-error" role="alert">{error}</div> : null}
      <button className="approve-button" type="submit" disabled={submitting}>{submitting ? "Signing in..." : "Sign in"}</button>
    </form>
  </main>;
}

function AuthStatus({ message }: { message: string }) {
  return <main className="auth-page"><div className="auth-loading">{message}</div></main>;
}

function SyncWarning({ message }: { message: string }) {
  return <div className="sync-warning" role="status">{message}</div>;
}

function humanizeRequirement(value: string): string {
  const spaced = value.replace(/[-_]+/g, " ").trim();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : value;
}

function WorkspaceLoadError({ error, onRetry, onSignOut }: { error: string; onRetry: () => void; onSignOut: () => Promise<void> }) {
  return <main className="auth-page"><section className="workspace-error" role="alert"><LockKeyhole size={22} /><h1>Workspace could not load</h1><p>{error}</p><button className="approve-button" type="button" onClick={onRetry}>Retry</button><button className="empty-signout" type="button" onClick={() => void onSignOut()}>Sign out</button></section></main>;
}

async function withTimeout<T>(operation: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve(operation), new Promise<T>((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), timeoutMs); })]);
  } finally { if (timeout) clearTimeout(timeout); }
}

export function EmptyWorkspace({ workspaceName, intakeMessage, onUpload, onSignOut, role, approvalPolicy, transactions = [], transactionTypes = [], transactionOwners = [], onPublish, onCreateTransaction = async () => undefined, onAddRequirement, onUpdateRequirement = async () => undefined, onEvaluateTransaction = async () => undefined, onApproveTransaction = async () => undefined, onReactivateTransaction = async () => undefined, onBeginWork, onSubmitReview, onAddParty, onSetDate, onSetFinancial, onAddCustomField, onSetCustomFieldValue, onUploadDocument, onSetRequirementValue }: { workspaceName: string; intakeMessage: string | null; onUpload: (file: File) => Promise<void>; onSignOut: () => Promise<void>; role: WorkspaceSession["role"]; approvalPolicy: ApprovalPolicy | null; transactions?: TransactionFile[]; transactionTypes?: TransactionTypeOption[]; transactionOwners?: TransactionOwnerOption[]; onPublish: (mode: import("./infrastructure/supabase/approval-policies.js").ApprovalMode, rules: ApprovalPolicy["rules"]) => Promise<ApprovalPolicy>; onCreateTransaction?: (input: { externalReference: string; propertyAddress: string; transactionTypeId: string; ownerId: string; primaryPartyName: string; primaryPartyKind: "PERSON" | "ORGANIZATION"; primaryPartyRole: "BUYER" | "SELLER" | "TENANT" | "LANDLORD" }) => Promise<void>; onAddRequirement?: (transaction: TransactionFile, input: { kind: "ARTIFACT" | "FIELD"; key: string }) => Promise<void>; onUpdateRequirement?: (transaction: TransactionFile, requirement: import("./infrastructure/supabase/transactions.js").TransactionRequirement, status: import("./infrastructure/supabase/transactions.js").RequirementStatus) => Promise<void>; onEvaluateTransaction?: (transaction: TransactionFile) => Promise<void>; onApproveTransaction?: (transaction: TransactionFile) => Promise<void>; onReactivateTransaction?: (transaction: TransactionFile) => Promise<void>; onBeginWork?: (transaction: TransactionFile) => Promise<void>; onSubmitReview?: (transaction: TransactionFile) => Promise<void>; onAddParty?: (transaction: TransactionFile, input: { name: string; kind: TransactionParty["kind"]; role: TransactionPartyRole; primary: boolean }) => Promise<void>; onSetDate?: (transaction: TransactionFile, input: { kind: TransactionImportantDate["kind"]; date: string }) => Promise<void>; onSetFinancial?: (transaction: TransactionFile, input: { kind: TransactionFinancial["kind"]; label: string; amount: number; currency: string }) => Promise<void>; onAddCustomField?: (transaction: TransactionFile, input: { key: string; label: string; dataType: TransactionCustomField["dataType"]; required: boolean; stageGate: TransactionCustomField["stageGate"] }) => Promise<void>; onSetCustomFieldValue?: (transaction: TransactionFile, field: TransactionCustomField, value: unknown) => Promise<void>; onUploadDocument?: (transaction: TransactionFile, requirement: TransactionRequirement, file: File) => Promise<void>; onSetRequirementValue?: (transaction: TransactionFile, requirement: TransactionRequirement, value: string) => Promise<void> }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [currentPolicy, setCurrentPolicy] = useState(approvalPolicy);
  const [showTransactions, setShowTransactions] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function selected(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try { await onUpload(file); }
    catch (reason) { setUploadError(reason instanceof Error ? reason.message : "Upload failed"); }
    finally { setUploading(false); if (input.current) input.current.value = ""; }
  }
  return <main className="auth-page"><div className="empty-workspace"><h1>{workspaceName}</h1><p>No persisted invoices are available yet.</p>
    <input ref={input} hidden type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={(event) => void selected(event.target.files?.[0])} />
    {intakeMessage ? <div className="intake-success" role="status">{intakeMessage}</div> : null}
    {uploadError ? <div className="auth-error" role="alert">{uploadError}</div> : null}
    <button className="approve-button" type="button" disabled={uploading} onClick={() => input.current?.click()}><Upload size={16} /> {uploading ? "Uploading..." : "Upload invoice"}</button>
    <button className="empty-settings" type="button" onClick={() => setShowTransactions(true)}>Create Transaction File</button>
    <button className="empty-settings" type="button" onClick={() => setShowSettings(true)}>Approval policy</button>
    <button className="empty-signout" type="button" onClick={() => void onSignOut()}>Sign out</button>
    {showSettings ? <ApprovalPolicySettings policy={currentPolicy} canManage={role === "TENANT_ADMIN"} onClose={() => setShowSettings(false)} onPublish={async (mode, rules) => {
      const published = await onPublish(mode, rules); setCurrentPolicy(published); return published;
    }} /> : null}
    {showTransactions ? <TransactionWorkspace transactions={transactions} transactionTypes={transactionTypes} ownerOptions={transactionOwners} onClose={() => setShowTransactions(false)} onCreate={onCreateTransaction} {...(onAddRequirement ? { onAddRequirement } : {})} {...(onBeginWork ? { onBeginWork } : {})} {...(onSubmitReview ? { onSubmitReview } : {})} {...(onAddParty ? { onAddParty } : {})} {...(onSetDate ? { onSetDate } : {})} {...(onSetFinancial ? { onSetFinancial } : {})} {...(onAddCustomField ? { onAddCustomField } : {})} {...(onSetCustomFieldValue ? { onSetCustomFieldValue } : {})} {...(onUploadDocument ? { onUploadDocument } : {})} {...(onSetRequirementValue ? { onSetRequirementValue } : {})} onLink={async () => undefined} onRequirement={onUpdateRequirement} onEvaluate={onEvaluateTransaction} onApprove={onApproveTransaction} onReactivate={onReactivateTransaction} /> : null}
  </div></main>;
}
