import { AlertTriangle, ArrowLeft, Building2, Check, CheckCircle2, ChevronDown, ChevronUp, Clock3, CreditCard, FilePlus2, History, Link, Link2Off, LoaderCircle, Moon, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { RequirementStatus, TransactionCustomField, TransactionDocument, TransactionFile, TransactionFinancial, TransactionImportantDate, TransactionInvoice, TransactionIssue, TransactionIssueSeverity, TransactionLinkageProposal, TransactionOwnerOption, TransactionParty, TransactionPartyRole, TransactionPaymentStatus, TransactionRequirement, TransactionTypeOption } from "./infrastructure/supabase/transactions.js";

export interface Props {
  transactions: TransactionFile[];
  initialSelectedId?: string;
  transactionTypes?: TransactionTypeOption[];
  ownerOptions?: TransactionOwnerOption[];
  selectedInvoice?: { id: string; version: number; label: string; linked: boolean; linkedTransactionId?: string };
  invoiceLinkMessage?: string;
  linkageProposals?: TransactionLinkageProposal[];
  onClose: () => void;
  onCreate: (input: { externalReference: string; propertyAddress: string; transactionTypeId: string; ownerId: string; primaryPartyName: string; primaryPartyKind: "PERSON" | "ORGANIZATION"; primaryPartyRole: "BUYER" | "SELLER" | "TENANT" | "LANDLORD" }) => Promise<void>;
  onAddRequirement?: (transaction: TransactionFile, input: { kind: TransactionRequirement["kind"]; key: string }) => Promise<void>;
  onUpdateDetails?: (transaction: TransactionFile, input: { externalReference: string; propertyAddress: string; transactionType: string; office: string; closingDate: string }) => Promise<void>;
  onRemoveRequirement?: (transaction: TransactionFile, requirement: TransactionRequirement) => Promise<void>;
  onLink: (transaction: TransactionFile) => Promise<void>;
  onResolveProposal?: (proposal: TransactionLinkageProposal, decision: "ACCEPT" | "REJECT") => Promise<void>;
  onRequirement: (transaction: TransactionFile, requirement: TransactionRequirement, status: RequirementStatus) => Promise<void>;
  onEvaluate: (transaction: TransactionFile) => Promise<void>;
  onApprove: (transaction: TransactionFile) => Promise<void>;
  onReactivate: (transaction: TransactionFile) => Promise<void>;
  onBeginWork?: (transaction: TransactionFile) => Promise<void>;
  onSubmitReview?: (transaction: TransactionFile) => Promise<void>;
  onCompleteReview?: (transaction: TransactionFile) => Promise<void>;
  onAddParty?: (transaction: TransactionFile, input: { name: string; kind: TransactionParty["kind"]; role: TransactionPartyRole; primary: boolean }) => Promise<void>;
  onSetDate?: (transaction: TransactionFile, input: { kind: TransactionImportantDate["kind"]; date: string }) => Promise<void>;
  onSetFinancial?: (transaction: TransactionFile, input: { kind: TransactionFinancial["kind"]; label: string; amount: number; currency: string }) => Promise<void>;
  onAddCustomField?: (transaction: TransactionFile, input: { key: string; label: string; dataType: TransactionCustomField["dataType"]; required: boolean; stageGate: TransactionCustomField["stageGate"] }) => Promise<void>;
  onSetCustomFieldValue?: (transaction: TransactionFile, field: TransactionCustomField, value: unknown) => Promise<void>;
  onUploadDocument?: (transaction: TransactionFile, requirement: TransactionRequirement, file: File) => Promise<void>;
  onSetRequirementValue?: (transaction: TransactionFile, requirement: TransactionRequirement, value: string) => Promise<void>;
  onReviewDocument?: (transaction: TransactionFile, document: TransactionDocument, decision: "VERIFIED" | "REJECTED", reason?: string) => Promise<void>;
  onCancelDocumentUpload?: (transaction: TransactionFile, ingestionEventId: string) => Promise<void>;
  onSetInvoicePayment?: (transaction: TransactionFile, invoice: TransactionInvoice, input: { status: TransactionPaymentStatus; paidAmount: number; scheduledFor?: string; note?: string }) => Promise<void>;
  onUnlinkInvoice?: (transaction: TransactionFile, invoice: TransactionInvoice, reason: string) => Promise<void>;
  onReviewInvoiceContext?: (transaction: TransactionFile, invoice: TransactionInvoice, resolution: string) => Promise<void>;
  onCreateIssue?: (transaction: TransactionFile, input: { title: string; category: string; severity: TransactionIssueSeverity; blocking: boolean; ownerUserId?: string; dueDate?: string }) => Promise<void>;
  onResolveIssue?: (transaction: TransactionFile, issue: TransactionIssue, resolution: string) => Promise<void>;
  onCloseFile?: (transaction: TransactionFile) => Promise<void>;
  onCancelFile?: (transaction: TransactionFile, reason: string) => Promise<void>;
  onReopenFile?: (transaction: TransactionFile, reason: string) => Promise<void>;
}

const lifecycleCopy: Record<TransactionFile["lifecycle"], string> = {
  INGESTED: "Received", ACCUMULATING: "Collecting details", AMBIGUOUS: "Needs attention",
  CONVERGED: "Ready for final review", APPROVED: "Approved", DORMANT: "Inactive", ARCHIVED: "Archived",
};
const stageCopy = { DRAFT: "Draft", DOCUMENTS_PENDING: "Documents pending", UNDER_REVIEW: "Under review", READY_FOR_CLOSING: "Ready for closing", CLOSED: "Closed", CANCELLED: "Cancelled" } as const;

export function TransactionWorkspace(props: Props) {
  const [selectedId, setSelectedId] = useState(props.initialSelectedId ?? props.transactions[0]?.id ?? "");
  const [creating, setCreating] = useState(props.transactions.length === 0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addingRequirement, setAddingRequirement] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [factEditor, setFactEditor] = useState<"PARTY" | "DATE" | "FINANCIAL" | "CUSTOM" | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [uploadRequirement, setUploadRequirement] = useState<TransactionRequirement | null>(null);
  const [localUpload, setLocalUpload] = useState<{ requirementKey: string; documentName: string; fileName: string } | null>(null);
  const [editingRequirement, setEditingRequirement] = useState<TransactionRequirement | null>(null);
  const [documentDecision, setDocumentDecision] = useState<{ document: TransactionDocument; decision: "VERIFIED" | "REJECTED" } | null>(null);
  const [historyDocumentId, setHistoryDocumentId] = useState<string | null>(null);
  const [paymentEditor, setPaymentEditor] = useState<TransactionInvoice | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<TransactionPaymentStatus>("UNPAID");
  const [unlinkingInvoice, setUnlinkingInvoice] = useState<TransactionInvoice | null>(null);
  const [reviewingInvoice, setReviewingInvoice] = useState<TransactionInvoice | null>(null);
  const [issueEditor, setIssueEditor] = useState<"CREATE" | TransactionIssue | null>(null);
  const [lifecycleAction, setLifecycleAction] = useState<"CANCEL" | "REOPEN" | null>(null);
  const [showFileActions, setShowFileActions] = useState(false);
  const fileActionsRef = useRef<HTMLDivElement>(null);
  const documentInput = useRef<HTMLInputElement>(null);
  const selected = props.transactions.find((transaction) => transaction.id === selectedId) ?? props.transactions[0];
  const blockers = useMemo(() => selected?.requirements.filter((item) => item.status !== "PRESENT") ?? [], [selected]);
  const approvalBlockers = useMemo(() => {
    if (!selected) return 0;
    const gatedRequirements = selected.requirements.filter((item) => item.stageGate !== "BEFORE_CLOSING");
    const incompleteRequirements = gatedRequirements.filter((item) => item.status !== "PRESENT").length;
    const unverifiedDocuments = gatedRequirements.filter((item) => item.kind === "ARTIFACT" && item.status === "PRESENT" && !selected.documents?.some((document) => document.requirementKey === item.key && document.status === "VERIFIED")).length;
    const requiredFields = selected.customFields?.filter((field) => field.required && field.stageGate !== "BEFORE_CLOSING" && field.value === undefined).length ?? 0;
    return incompleteRequirements + requiredFields + unverifiedDocuments;
  }, [selected]);
  const proposals = useMemo(() => props.linkageProposals?.filter((proposal) => proposal.invoiceId === props.selectedInvoice?.id && proposal.status === "PROPOSED") ?? [], [props.linkageProposals, props.selectedInvoice?.id]);
  const acceptedMatch = useMemo(() => props.linkageProposals?.find((proposal) => proposal.invoiceId === props.selectedInvoice?.id && proposal.transactionId === selected?.id && proposal.status === "ACCEPTED"), [props.linkageProposals, props.selectedInvoice?.id, selected?.id]);
  const invoiceBelongsHere = props.selectedInvoice?.linked && props.selectedInvoice.linkedTransactionId === selected?.id;

  useEffect(() => {
    function closeActions(event: PointerEvent) { if (!fileActionsRef.current?.contains(event.target as Node)) setShowFileActions(false); }
    document.addEventListener("pointerdown", closeActions);
    return () => document.removeEventListener("pointerdown", closeActions);
  }, []);

  async function run(operation: () => Promise<void>, successMessage?: string) {
    setPending(true); setError(null); setSuccess(null);
    try { await operation(); if (successMessage) setSuccess(successMessage); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "We could not complete that action. Please try again."); }
    finally { setPending(false); }
  }

  async function addParty(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !props.onAddParty) return;
    const values = new FormData(event.currentTarget);
    await run(async () => { await props.onAddParty!(selected, { name: String(values.get("name") ?? "").trim(), kind: String(values.get("kind")) as TransactionParty["kind"], role: String(values.get("role")) as TransactionPartyRole, primary: values.get("primary") === "on" }); setFactEditor(null); }, "Party added.");
  }

  async function setDate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !props.onSetDate) return;
    const values = new FormData(event.currentTarget);
    await run(async () => { await props.onSetDate!(selected, { kind: String(values.get("kind")) as TransactionImportantDate["kind"], date: String(values.get("date") ?? "") }); setFactEditor(null); }, "Important date saved.");
  }

  async function setFinancial(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !props.onSetFinancial) return;
    const values = new FormData(event.currentTarget);
    await run(async () => { await props.onSetFinancial!(selected, { kind: String(values.get("kind")) as TransactionFinancial["kind"], label: String(values.get("label") ?? "").trim(), amount: Number(values.get("amount")), currency: String(values.get("currency") ?? "").trim().toUpperCase() }); setFactEditor(null); }, "Financial entry saved.");
  }

  async function addCustomField(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !props.onAddCustomField) return;
    const values = new FormData(event.currentTarget);
    const label = String(values.get("label") ?? "").trim();
    await run(async () => { await props.onAddCustomField!(selected, { key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""), label, dataType: String(values.get("dataType")) as TransactionCustomField["dataType"], required: values.get("required") === "on", stageGate: String(values.get("stageGate")) as TransactionCustomField["stageGate"] }); setFactEditor(null); }, "Information field added.");
  }

  async function setCustomFieldValue(event: FormEvent<HTMLFormElement>, field: TransactionCustomField) {
    event.preventDefault(); if (!selected || !props.onSetCustomFieldValue) return;
    const raw = new FormData(event.currentTarget).get("value");
    const value = field.dataType === "NUMBER" ? Number(raw) : field.dataType === "BOOLEAN" ? raw === "true" : String(raw ?? "");
    await run(() => props.onSetCustomFieldValue!(selected, field, value), `${field.label} saved.`);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await run(async () => {
      await props.onCreate({ externalReference: String(values.get("reference") ?? ""), propertyAddress: String(values.get("address") ?? ""), transactionTypeId: String(values.get("transactionTypeId") ?? ""), ownerId: String(values.get("ownerId") ?? ""), primaryPartyName: String(values.get("primaryPartyName") ?? ""), primaryPartyKind: String(values.get("primaryPartyKind")) as "PERSON" | "ORGANIZATION", primaryPartyRole: String(values.get("primaryPartyRole")) as "BUYER" | "SELLER" | "TENANT" | "LANDLORD" });
      setCreating(false);
    });
  }

  async function addRequirement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !props.onAddRequirement) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    await run(async () => {
      await props.onAddRequirement!(selected, { kind: String(values.get("kind")) as TransactionRequirement["kind"], key: String(values.get("key") ?? "").trim() });
      form.reset();
      setAddingRequirement(false);
    });
  }

  async function updateDetails(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !props.onUpdateDetails) return;
    const values = new FormData(event.currentTarget);
    await run(async () => {
      await props.onUpdateDetails!(selected, { externalReference: String(values.get("reference") ?? ""), propertyAddress: String(values.get("address") ?? ""), transactionType: selected.transactionType ?? "", office: String(values.get("office") ?? ""), closingDate: selected.keyDates?.closingDate ?? "" });
      setEditingDetails(false);
    });
  }

  async function uploadDocument(file: File | undefined) {
    const requirement = uploadRequirement;
    if (!file || !selected || !requirement || !props.onUploadDocument) return;
    setLocalUpload({ requirementKey: requirement.key, documentName: humanize(requirement.key), fileName: file.name });
    await run(() => props.onUploadDocument!(selected, requirement, file), `${humanize(requirement.key)} uploaded. The safety check is running; you can leave this page and return later.`);
    setLocalUpload(null);
    setUploadRequirement(null);
    if (documentInput.current) documentInput.current.value = "";
  }

  async function setRequirementValue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !editingRequirement || !props.onSetRequirementValue) return;
    const value = String(new FormData(event.currentTarget).get("value") ?? "").trim();
    await run(async () => { await props.onSetRequirementValue!(selected, editingRequirement, value); setEditingRequirement(null); }, `${humanize(editingRequirement.key)} saved.`);
  }

  async function reviewDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !documentDecision || !props.onReviewDocument) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    await run(async () => { await props.onReviewDocument!(selected, documentDecision.document, documentDecision.decision, reason || undefined); setDocumentDecision(null); },
      documentDecision.decision === "VERIFIED" ? "Document verified." : "Document rejected. A replacement is now required.");
  }

  async function setInvoicePayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !paymentEditor || !props.onSetInvoicePayment) return;
    const values = new FormData(event.currentTarget);
    const paidAmount = paymentStatus === "PAID" ? paymentEditor.total ?? 0
      : paymentStatus === "UNPAID" || paymentStatus === "SCHEDULED" || paymentStatus === "VOIDED" ? 0
      : Number(values.get("paidAmount") ?? 0);
    await run(async () => {
      await props.onSetInvoicePayment!(selected, paymentEditor, {
        status: paymentStatus,
        paidAmount,
        ...(paymentStatus === "SCHEDULED" ? { scheduledFor: String(values.get("scheduledFor") ?? "") } : {}),
        ...(["DISPUTED", "VOIDED"].includes(paymentStatus) ? { note: String(values.get("note") ?? "").trim() } : {}),
      });
      setPaymentEditor(null);
    }, "Payment status updated.");
  }

  async function saveIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !props.onCreateIssue) return;
    const values = new FormData(event.currentTarget);
    await run(async () => { await props.onCreateIssue!(selected, { title: String(values.get("title") ?? "").trim(), category: String(values.get("category") ?? "OTHER"), severity: String(values.get("severity") ?? "MEDIUM") as TransactionIssueSeverity, blocking: values.get("blocking") === "on", ...(values.get("ownerUserId") ? { ownerUserId: String(values.get("ownerUserId")) } : {}), ...(values.get("dueDate") ? { dueDate: String(values.get("dueDate")) } : {}) }); setIssueEditor(null); }, "Issue added.");
  }
  async function unlinkInvoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !unlinkingInvoice || !props.onUnlinkInvoice) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    await run(async () => { await props.onUnlinkInvoice!(selected, unlinkingInvoice, reason); setUnlinkingInvoice(null); }, "Invoice unlinked. Verified invoices are queued for context review.");
  }
  async function reviewInvoiceContext(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !reviewingInvoice || !props.onReviewInvoiceContext) return;
    const resolution = String(new FormData(event.currentTarget).get("resolution") ?? "").trim();
    await run(async () => { await props.onReviewInvoiceContext!(selected, reviewingInvoice, resolution); setReviewingInvoice(null); }, "Invoice context review completed.");
  }

  async function resolveIssue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !issueEditor || issueEditor === "CREATE" || !props.onResolveIssue) return;
    const resolution = String(new FormData(event.currentTarget).get("resolution") ?? "").trim();
    await run(async () => { await props.onResolveIssue!(selected, issueEditor, resolution); setIssueEditor(null); }, "Issue resolved.");
  }
  async function submitLifecycleAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected || !lifecycleAction) return;
    const reason = String(new FormData(event.currentTarget).get("reason") ?? "").trim();
    await run(async () => { if (lifecycleAction === "CANCEL") await props.onCancelFile?.(selected, reason); else await props.onReopenFile?.(selected, reason); setLifecycleAction(null); }, lifecycleAction === "CANCEL" ? "Transaction File cancelled." : "Transaction File reopened.");
  }

  return <section className="transaction-page" aria-label="Transaction Files">
    <header className="transaction-header"><button className="icon-button" type="button" aria-label="Back to invoices" onClick={props.onClose}><ArrowLeft size={18} /></button><div><h1>Transaction Files</h1><p>Organize invoices and closing requirements by transaction.</p></div><button className="approve-button" type="button" onClick={() => setCreating(true)}><Plus size={16} /> New file</button></header>
    <div className="transaction-layout">
      <aside className="transaction-list" aria-label="Transaction File list">
        {props.transactions.map((transaction) => <button type="button" className={selected?.id === transaction.id ? "selected" : ""} key={transaction.id} onClick={() => { setSelectedId(transaction.id); setCreating(false); setError(null); setSuccess(null); setFactEditor(null); setEditingDetails(false); setAddingRequirement(false); }}><Building2 size={17} /><span><strong>{transaction.propertyAddress}</strong><small>{transaction.externalReference || "No reference"}</small><em>{transaction.businessStage ? stageCopy[transaction.businessStage] : lifecycleCopy[transaction.lifecycle]}</em></span></button>)}
        {props.transactions.length === 0 ? <div className="transaction-empty-list"><FilePlus2 size={22} /><span>No Transaction Files yet</span></div> : null}
      </aside>

      <main className="transaction-detail">
        {creating ? <form className="transaction-create" onSubmit={(event) => void create(event)}><div><h2>Create Transaction File</h2><p>Add the requirements needed before this transaction can be sent for final review.</p></div>
          <label>Property address<input name="address" required placeholder="1847 Cypress Avenue" /></label>
          <label>Internal reference <span>Optional</span><input name="reference" placeholder="TX-2026-1048" /></label>
          <div className="transaction-form-grid"><label>Transaction type<select name="transactionTypeId" required defaultValue=""><option value="" disabled>Select type</option>{props.transactionTypes?.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label><label>Assigned owner<select name="ownerId" required defaultValue=""><option value="" disabled>Select owner</option>{props.ownerOptions?.map((owner) => <option key={owner.userId} value={owner.userId}>{owner.label}</option>)}</select></label></div>
          <div className="transaction-form-grid"><label>Primary party<input name="primaryPartyName" required placeholder="Person or organization name" /></label><label>Party type<select name="primaryPartyKind" defaultValue="PERSON"><option value="PERSON">Person</option><option value="ORGANIZATION">Organization</option></select></label></div>
          <label>Primary party role<select name="primaryPartyRole" defaultValue="BUYER"><option value="BUYER">Buyer</option><option value="SELLER">Seller</option><option value="TENANT">Tenant</option><option value="LANDLORD">Landlord</option></select></label>
          {error ? <div className="transaction-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div> : null}
          <div className="transaction-form-actions"><button className="secondary-button" type="button" onClick={() => setCreating(false)}>Cancel</button><button className="approve-button" type="submit" disabled={pending}>{pending ? "Creating..." : "Create file"}</button></div>
        </form> : selected ? <>
          <div className="transaction-summary"><div><span className={`transaction-status status-${(selected.businessStage ?? selected.lifecycle).toLowerCase()}`}>{selected.businessStage ? stageCopy[selected.businessStage] : lifecycleCopy[selected.lifecycle]}</span><h2>{selected.propertyAddress}</h2><p>{selected.externalReference || "No internal reference"}</p></div><div className="transaction-summary-actions">
            {props.onUpdateDetails && !["DORMANT", "ARCHIVED"].includes(selected.lifecycle) ? <button className="icon-button" type="button" title="Edit details" aria-label="Edit Transaction File details" onClick={() => setEditingDetails(true)}><Pencil size={15} /></button> : null}
            {props.selectedInvoice && !props.selectedInvoice.linked && selected.lifecycle !== "DORMANT" && selected.lifecycle !== "ARCHIVED" ? <button className="secondary-button" type="button" disabled={pending} onClick={() => void run(() => props.onLink(selected))}><Link size={15} /> Link selected invoice</button> : null}
            {selected.businessStage && !["CLOSED", "CANCELLED"].includes(selected.businessStage) && props.onCancelFile ? <div className="transaction-file-menu" ref={fileActionsRef}><button className="icon-button" type="button" aria-label="Transaction File actions" aria-expanded={showFileActions} onClick={() => setShowFileActions((open) => !open)}><MoreHorizontal size={17} /></button>{showFileActions ? <div className="transaction-file-menu-popover"><button type="button" onClick={() => { setShowFileActions(false); setLifecycleAction("CANCEL"); }}><X size={15} /> Cancel transaction</button></div> : null}</div> : null}
          </div></div>
          {editingDetails ? <form className="transaction-edit-details" onSubmit={(event) => void updateDetails(event)}><label>Property address<input name="address" required defaultValue={selected.propertyAddress} /></label><label>Internal reference<input name="reference" defaultValue={selected.externalReference} /></label><label>Office<input name="office" defaultValue={selected.office} /></label><div><button className="secondary-button" type="button" onClick={() => setEditingDetails(false)}>Cancel</button><button className="approve-button" type="submit" disabled={pending}>Save details</button></div></form> : null}
          {selected.transactionType || selected.ownerUserId || selected.primaryParty || selected.office || selected.keyDates?.closingDate ? <section className="deal-summary"><h3>Deal summary</h3><dl className="transaction-metadata">
            {selected.transactionType ? <div><dt>Transaction type</dt><dd>{selected.transactionType}</dd></div> : null}
            {selected.ownerUserId ? <div><dt>Assigned owner</dt><dd>{props.ownerOptions?.find((owner) => owner.userId === selected.ownerUserId)?.label ?? "Workspace member"}</dd></div> : null}
            {selected.primaryParty ? <div><dt>Primary party</dt><dd>{selected.primaryParty.name} · {humanize(selected.primaryParty.role)}</dd></div> : null}
            {selected.office ? <div><dt>Office</dt><dd>{selected.office}</dd></div> : null}
            {selected.keyDates?.closingDate ? <div><dt>Closing date</dt><dd>{selected.keyDates.closingDate}</dd></div> : null}
          </dl></section> : null}
          {selected.health ? <section className="transaction-health" aria-label="Transaction health">
            <div><strong>{selected.health.completionPercent}%</strong><span>Complete</span></div>
            <div><strong>{selected.health.missingDocuments}</strong><span>Documents missing</span></div>
            <div><strong>{selected.health.invoiceConflicts}</strong><span>Invoice conflicts</span></div>
            <div><strong>{selected.health.closingDays === null ? "—" : selected.health.closingDays}</strong><span>{selected.health.closingDays === null ? "Closing not set" : selected.health.closingDays < 0 ? "Days overdue" : "Days to closing"}</span></div>
            <div><strong>{formatOutstanding(selected.health.outstandingByCurrency)}</strong><span>Outstanding</span></div>
          </section> : null}
          {success ? <div className="transaction-success" role="status"><CheckCircle2 size={16} /><span>{success}</span></div> : null}
          {error ? <div className="transaction-error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div> : null}
          {props.selectedInvoice && (!props.selectedInvoice.linked || invoiceBelongsHere) ? <div className="selected-invoice-note"><span>{invoiceBelongsHere ? "Linked invoice" : "Selected invoice"}</span><strong>{props.selectedInvoice.label}</strong><small>{invoiceBelongsHere ? "Linked to this file" : "Available to link"}</small></div> : !props.selectedInvoice && props.invoiceLinkMessage ? <div className="invoice-link-guidance"><AlertTriangle size={16} /><div><strong>No invoice is ready to link</strong><span>{props.invoiceLinkMessage}</span></div></div> : null}
          {invoiceBelongsHere && acceptedMatch ? <section className="accepted-match" aria-label="Accepted match evidence"><div className="match-score" aria-label={`${Math.round(acceptedMatch.score * 100)} percent match`}><strong>{Math.round(acceptedMatch.score * 100)}%</strong><span>match</span></div><div><strong>Match confirmed</strong><ul>{acceptedMatch.reasons.map((reason, index) => <li key={`${reason.label}:${index}`}><Check size={12} /> {reason.label}</li>)}</ul></div></section> : null}
          {props.selectedInvoice && !props.selectedInvoice.linked && proposals.length > 0 ? <section className="match-suggestions" aria-labelledby="match-suggestions-title">
            <header><div><h3 id="match-suggestions-title">Suggested Transaction Files</h3><p>Review why each file may belong to this invoice.</p></div><span>{proposals.length} {proposals.length === 1 ? "match" : "matches"}</span></header>
            <div className="match-list">{proposals.map((proposal) => <article className={proposal.transactionId === selected.id ? "match-row selected" : "match-row"} key={proposal.id}>
              <div className="match-score" aria-label={`${Math.round(proposal.score * 100)} percent match`}><strong>{Math.round(proposal.score * 100)}%</strong><span>match</span></div>
              <div className="match-copy"><strong>{proposal.propertyAddress}</strong><small>{proposal.externalReference || "No internal reference"}</small><ul>{proposal.reasons.map((reason, index) => <li key={`${reason.label}:${index}`}><Check size={12} /> {reason.label}</li>)}</ul></div>
              <div className="match-actions"><button className="secondary-button" type="button" disabled={pending} onClick={() => void run(() => props.onResolveProposal?.(proposal, "REJECT") ?? Promise.resolve())}><X size={14} /> Not a match</button><button className="approve-button" type="button" disabled={pending || proposal.lifecycle === "DORMANT" || proposal.lifecycle === "ARCHIVED"} onClick={() => void run(() => props.onResolveProposal?.(proposal, "ACCEPT") ?? Promise.resolve())}><Link size={14} /> Use this file</button></div>
            </article>)}</div>
          </section> : null}
          <div className="transaction-facts">
            <section className="fact-section"><header><div><h3>Parties</h3><p>{selected.parties?.length ? `${selected.parties.length} associated` : "No additional parties"}</p></div>{props.onAddParty && selected.businessStage !== "CLOSED" && selected.businessStage !== "CANCELLED" ? <button className="secondary-button" type="button" onClick={() => setFactEditor(factEditor === "PARTY" ? null : "PARTY")}><Plus size={14} /> Add party</button> : null}</header>
              {factEditor === "PARTY" ? <form className="fact-form" onSubmit={(event) => void addParty(event)}><label>Name<input name="name" required maxLength={200} /></label><label>Type<select name="kind"><option value="PERSON">Person</option><option value="ORGANIZATION">Organization</option></select></label><label>Role<select name="role"><option value="BUYER">Buyer</option><option value="SELLER">Seller</option><option value="TENANT">Tenant</option><option value="LANDLORD">Landlord</option><option value="AGENT">Agent</option><option value="LENDER">Lender</option><option value="ATTORNEY">Attorney</option><option value="TITLE_ESCROW">Title / escrow</option></select></label><label className="fact-check"><input name="primary" type="checkbox" /> Primary party</label><button className="approve-button" disabled={pending}>Add</button></form> : null}
              <div className="fact-list">{selected.parties?.map((party) => <div key={`${party.id}:${party.role}`}><strong>{party.name}</strong><span>{humanize(party.role)}{party.primary ? " · Primary" : ""}</span></div>)}{!selected.parties?.length ? <p>No parties have been added.</p> : null}</div>
            </section>
            <section className="fact-section"><header><div><h3>Important dates</h3><p>{selected.importantDates?.length ? `${selected.importantDates.length} scheduled` : "No dates scheduled"}</p></div>{props.onSetDate && selected.businessStage !== "CLOSED" && selected.businessStage !== "CANCELLED" ? <button className="secondary-button" type="button" onClick={() => setFactEditor(factEditor === "DATE" ? null : "DATE")}><Plus size={14} /> Add date</button> : null}</header>
              {factEditor === "DATE" ? <form className="fact-form" onSubmit={(event) => void setDate(event)}><label>Date type<select name="kind"><option value="AGREEMENT">Agreement</option><option value="INSPECTION">Inspection</option><option value="FINANCING">Financing</option><option value="DOCUMENT_DEADLINE">Document deadline</option><option value="CLOSING">Closing</option><option value="HANDOVER">Handover</option></select></label><label>Date<input name="date" type="date" required /></label><button className="approve-button" disabled={pending}>Save</button></form> : null}
              <div className="fact-list">{selected.importantDates?.map((date) => <div key={date.id}><strong>{humanize(date.kind)}</strong><span>{date.date ?? (date.timestamp ? new Date(date.timestamp).toLocaleString() : "Not set")}</span></div>)}{!selected.importantDates?.length ? <p>No important dates have been added.</p> : null}</div>
            </section>
            <section className="fact-section"><header><div><h3>Financials</h3><p>{selected.financials?.length ? `${selected.financials.length} entries` : "No financials recorded"}</p></div>{props.onSetFinancial && selected.businessStage !== "CLOSED" && selected.businessStage !== "CANCELLED" ? <button className="secondary-button" type="button" onClick={() => setFactEditor(factEditor === "FINANCIAL" ? null : "FINANCIAL")}><Plus size={14} /> Add financial</button> : null}</header>
              {factEditor === "FINANCIAL" ? <form className="fact-form" onSubmit={(event) => void setFinancial(event)}><label>Type<select name="kind"><option value="DEAL_VALUE">Deal value</option><option value="DEPOSIT">Deposit</option><option value="COMMISSION">Commission</option><option value="TAX">Tax</option><option value="FEE">Fee</option></select></label><label>Label<input name="label" required maxLength={120} placeholder="Purchase price" /></label><label>Amount<input name="amount" type="number" min="0" step="0.01" required /></label><label>Currency<input name="currency" required minLength={3} maxLength={3} defaultValue="USD" /></label><button className="approve-button" disabled={pending}>Save</button></form> : null}
              <div className="fact-list">{selected.financials?.map((entry) => <div key={entry.id}><strong>{entry.label}</strong><span>{new Intl.NumberFormat("en-US", { style: "currency", currency: entry.currency }).format(entry.amount)}</span></div>)}{!selected.financials?.length ? <p>No financial entries have been added.</p> : null}</div>
            </section>
          </div>
          <section className="custom-fields-section" aria-label="Required information"><header><div><h3>Required information</h3><p>{selected.requirements.filter((item) => item.kind === "FIELD" && item.status !== "PRESENT").length + (selected.customFields?.filter((field) => field.required && field.value === undefined).length ?? 0)} missing</p></div>{props.onAddCustomField && selected.businessStage !== "CLOSED" && selected.businessStage !== "CANCELLED" ? <button className="secondary-button" type="button" onClick={() => setFactEditor(factEditor === "CUSTOM" ? null : "CUSTOM")}><Plus size={14} /> Add field</button> : null}</header>
            {factEditor === "CUSTOM" ? <form className="custom-field-create" onSubmit={(event) => void addCustomField(event)}><label>Field name<input name="label" required maxLength={120} placeholder="Financing reference" /></label><label>Type<select name="dataType"><option value="TEXT">Text</option><option value="NUMBER">Number</option><option value="BOOLEAN">Yes / No</option><option value="DATE">Date</option></select></label><label>Required before<select name="stageGate"><option value="BEFORE_REVIEW">Review</option><option value="BEFORE_APPROVAL">Approval</option><option value="BEFORE_CLOSING">Closing</option></select></label><label className="fact-check"><input name="required" type="checkbox" defaultChecked /> Required</label><button className="approve-button" disabled={pending}>Add field</button></form> : null}
            <div className="custom-field-list">
              {selected.requirements.filter((item) => item.kind === "FIELD").map((requirement) => <div key={`requirement:${requirement.key}`} className={requirement.status === "PRESENT" ? "custom-field-row" : "custom-field-row missing"}><label><span>{humanize(requirement.key)}</span><small>{humanize(requirement.stageGate ?? "BEFORE_REVIEW")}</small></label><div><strong>{requirement.value ?? "Not provided"}</strong><small>{requirement.status === "PRESENT" ? "Complete" : humanize(requirement.status)}</small></div>{props.onSetRequirementValue ? <button className="secondary-button" type="button" disabled={pending} onClick={() => setEditingRequirement(requirement)}>{requirement.status === "PRESENT" ? "Update" : "Enter information"}</button> : null}</div>)}
              {selected.customFields?.map((field) => <form key={field.id} className={field.required && field.value === undefined ? "custom-field-row missing" : "custom-field-row"} onSubmit={(event) => void setCustomFieldValue(event, field)}><label><span>{field.label}{field.required ? " *" : ""}</span><small>{humanize(field.dataType)} · {humanize(field.stageGate)}</small></label>{field.dataType === "BOOLEAN" ? <select name="value" aria-label={field.label} defaultValue={field.value === undefined ? "" : String(field.value)} required={field.required}><option value="" disabled>Select</option><option value="true">Yes</option><option value="false">No</option></select> : <input name="value" aria-label={field.label} type={field.dataType === "NUMBER" ? "number" : field.dataType === "DATE" ? "date" : "text"} step={field.dataType === "NUMBER" ? "any" : undefined} defaultValue={field.value === undefined ? "" : String(field.value)} required={field.required} />}<button className="secondary-button" disabled={pending} type="submit">Save</button></form>)}
              {!selected.requirements.some((item) => item.kind === "FIELD") && !selected.customFields?.length ? <p>No required information fields have been added.</p> : null}
            </div>
          </section>
          <section className="transaction-invoices" aria-label="Invoices and payments">
            <header><div><h3>Invoices &amp; payments</h3><p>{selected.invoices?.length ? `${selected.invoices.length} linked ${selected.invoices.length === 1 ? "invoice" : "invoices"}` : "No invoices linked"}</p></div></header>
            {selected.invoices?.length ? <div className="transaction-invoice-list">{selected.invoices.map((invoice) => <article className="transaction-invoice-row" key={invoice.id}>
              <div><strong>{invoice.vendor}</strong><span>{invoice.invoiceNumber ?? "No invoice number"}</span></div>
              <div><small>Due</small><strong>{invoice.dueDate ?? "Not set"}</strong></div>
              <div><small>Amount</small><strong>{formatMoney(invoice.total ?? 0, invoice.currency)}</strong></div>
              <div><small>Approval</small><span className={`document-state ${invoice.contextReviewRequired ? "state-rejected" : ""}`}>{invoice.contextReviewRequired ? "Context review" : humanize(invoice.approvalStatus)}</span></div>
              <div><small>Payment</small><span className={`document-state payment-${invoice.paymentStatus.toLowerCase()}`}>{humanize(invoice.paymentStatus)}</span>{invoice.outstandingAmount > 0 ? <em>{formatMoney(invoice.outstandingAmount, invoice.currency)} outstanding</em> : null}</div>
              {selected.businessStage !== "CLOSED" && selected.businessStage !== "CANCELLED" ? <div className="invoice-row-actions">{invoice.contextReviewRequired && props.onReviewInvoiceContext ? <button className="secondary-button" type="button" onClick={() => setReviewingInvoice(invoice)}><Check size={14} /> Review link</button> : props.onSetInvoicePayment ? <button className="secondary-button" type="button" onClick={() => { setPaymentEditor(invoice); setPaymentStatus(invoice.paymentStatus); }}><CreditCard size={14} /> Update payment</button> : null}{props.onUnlinkInvoice ? <button className="icon-button" type="button" title="Unlink invoice" aria-label={`Unlink ${invoice.invoiceNumber ?? invoice.vendor}`} onClick={() => setUnlinkingInvoice(invoice)}><Link2Off size={14} /></button> : null}</div> : null}
            </article>)}</div> : <p className="document-empty">Linked invoices will appear here with their approval and payment status.</p>}
          </section>
          <section className="transaction-issues" aria-label="Issues and exceptions">
            <header><div><h3>Issues &amp; exceptions</h3><p>{selected.issues?.some((issue) => issue.status === "OPEN" || issue.status === "WAITING_FOR_EVIDENCE") ? `${selected.issues.filter((issue) => issue.status === "OPEN" || issue.status === "WAITING_FOR_EVIDENCE").length} open` : "No open issues"}</p></div>{props.onCreateIssue && !["CLOSED", "CANCELLED"].includes(selected.businessStage ?? "") ? <button className="secondary-button" type="button" onClick={() => setIssueEditor("CREATE")}><Plus size={14} /> Add issue</button> : null}</header>
            {selected.issues?.length ? <div className="transaction-issue-list">{selected.issues.map((issue) => { const resolved = issue.status === "RESOLVED"; return <article className={`transaction-issue-row ${issue.blocking && !resolved ? "blocking" : "resolved"}`} key={issue.id}>{resolved ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}<div><strong>{issueDisplayTitle(issue)}</strong><span>{humanize(issue.category)} · {humanize(issue.severity)}{issue.source === "GENERATED" ? resolved ? " · Automatically cleared" : " · System detected" : ""}</span>{issue.dueDate && !resolved ? <small>Due {issue.dueDate}</small> : null}{issue.resolution ? <small>Resolution: {issue.resolution}</small> : null}</div><span className={`document-state ${issue.blocking && !resolved ? "state-rejected" : ""}`}>{resolved ? "Resolved" : issue.blocking ? "Blocking" : "Open"}</span>{!resolved && props.onResolveIssue ? <button className="secondary-button" type="button" onClick={() => setIssueEditor(issue)}><Check size={14} /> Resolve</button> : null}</article>; })}</div> : <p className="document-empty">Issues, conflicts, and closing blockers will appear here.</p>}
          </section>
          <section className="documents-section">
            <header><div><h3>Documents</h3><p>{selected.documents?.length ? `${selected.documents.length} uploaded` : selected.pendingDocumentUploads?.length || localUpload ? "Upload in progress" : "No documents uploaded"}</p></div></header>
            <div className="document-list">
              {localUpload && !selected.pendingDocumentUploads?.some((upload) => upload.requirementKey === localUpload.requirementKey) ? <article className="document-row pending" aria-live="polite"><div className="document-status"><LoaderCircle className="processing-spinner" size={16} /></div><div><strong>{localUpload.documentName}</strong><span>Uploading document</span><small>{localUpload.fileName}</small></div><span className="document-state">Uploading</span></article> : null}
              {selected.pendingDocumentUploads?.map((upload) => <article className="document-row pending" key={upload.id}><div className={`document-status ${upload.status === "FAILED" ? "status-rejected" : ""}`}>{upload.status === "FAILED" ? <AlertTriangle size={16} /> : upload.processingStatus === "RUNNING" ? <LoaderCircle className="processing-spinner" size={16} /> : <Clock3 size={16} />}</div><div><strong>{upload.documentName}</strong><span>{upload.status === "FAILED" ? "Upload could not be completed" : upload.processingStatus === "RUNNING" ? "Safety check in progress" : "Waiting for safety check"}</span>{upload.failureReason ? <small>{upload.failureReason}</small> : <small>{upload.processingStatus === "QUEUED" ? "Upload complete. You can continue working; checking will start automatically when processing is available." : "The file is uploaded and being checked."}</small>}</div><span className={`document-state ${upload.status === "FAILED" ? "state-rejected" : ""}`}>{upload.status === "FAILED" ? "Action needed" : upload.processingStatus === "RUNNING" ? "Checking" : "Waiting"}</span>{props.onCancelDocumentUpload && upload.status === "WAITING_FOR_SCAN" ? <div className="document-actions"><button className="secondary-button" type="button" disabled={pending} onClick={() => void run(() => props.onCancelDocumentUpload!(selected, upload.ingestionEventId), "Document upload cancelled.")}>Cancel upload</button></div> : null}</article>)}
              {selected.documents?.map((document) => <article className="document-record" key={document.id}><div className="document-row"><div className={`document-status status-${document.status.toLowerCase()}`}><FilePlus2 size={16} /></div><div><strong>{document.name}</strong><span>{document.fileName} · Version {document.version}</span>{document.decisionReason ? <small>{document.decisionReason}</small> : null}</div><span className={`document-state state-${document.status.toLowerCase()}`}>{humanize(document.status)}</span><div className="document-actions">{document.history.length > 1 ? <button className="secondary-button" type="button" aria-expanded={historyDocumentId === document.id} onClick={() => setHistoryDocumentId(historyDocumentId === document.id ? null : document.id)}><History size={14} /> Versions {historyDocumentId === document.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</button> : null}{document.status === "RECEIVED" && props.onReviewDocument ? <><button className="secondary-button" type="button" disabled={pending} onClick={() => setDocumentDecision({ document, decision: "REJECTED" })}><X size={14} /> Reject</button><button className="approve-button" type="button" disabled={pending} onClick={() => setDocumentDecision({ document, decision: "VERIFIED" })}><Check size={14} /> Verify</button></> : null}</div></div>{historyDocumentId === document.id ? <div className="document-history" role="region" aria-label={`${document.name} version history`}>{document.history.map((stored) => <div className="document-history-row" key={stored.id}><div><strong>Version {stored.version}{stored.current ? " · Current" : ""}</strong><span>{stored.fileName}</span></div><div><span>{new Date(stored.uploadedAt).toLocaleDateString()}</span>{stored.expiresOn ? <small>Expires {stored.expiresOn}</small> : null}</div><div><span className={`document-state state-${stored.status.toLowerCase()}`}>{humanize(stored.status)}</span>{stored.decisionReason ? <small>{stored.decisionReason}</small> : null}</div></div>)}</div> : null}</article>)}
              {!selected.documents?.length && !selected.pendingDocumentUploads?.length && !localUpload ? <p className="document-empty">Upload a required document below. Its progress will appear here.</p> : null}
            </div>
          </section>
          <section className="requirements-section"><header><div><h3>Requirements</h3><p>{selected.requirements.length === 0 ? "Add at least one requirement before final review." : blockers.length === 0 ? "All requirements are complete." : `${blockers.length} ${blockers.length === 1 ? "item needs" : "items need"} attention.`}</p></div>{props.onAddRequirement && !["DORMANT", "ARCHIVED"].includes(selected.lifecycle) ? <button className="secondary-button" type="button" onClick={() => setAddingRequirement((open) => !open)}><Plus size={14} /> Add requirement</button> : null}</header>
            <input ref={documentInput} hidden type="file" accept=".pdf,.jpg,.jpeg,.png" aria-label="Choose transaction document" onChange={(event) => void uploadDocument(event.target.files?.[0])} />
            {addingRequirement ? <form className="add-requirement" onSubmit={(event) => void addRequirement(event)}><select name="kind" aria-label="Requirement type"><option value="ARTIFACT">Document</option><option value="FIELD">Information</option></select><input name="key" aria-label="Requirement name" required maxLength={120} placeholder="e.g. Closing disclosure" /><button className="approve-button" type="submit" disabled={pending}>Add</button><button className="icon-button" type="button" aria-label="Cancel adding requirement" onClick={() => setAddingRequirement(false)}><X size={15} /></button></form> : null}
            <div className="requirement-list">{selected.requirements.map((requirement) => {
              const pendingUpload = selected.pendingDocumentUploads?.find((upload) => upload.requirementKey === requirement.key && upload.status === "WAITING_FOR_SCAN");
              const uploadingLocally = localUpload?.requirementKey === requirement.key;
              const uploadInProgress = uploadingLocally || Boolean(pendingUpload);
              return <div className="requirement-row" key={`${requirement.kind}:${requirement.key}`}>
                <span className={requirement.status === "PRESENT" ? "requirement-check complete" : "requirement-check"}>{requirement.status === "PRESENT" ? <Check size={15} /> : requirement.kind === "ARTIFACT" ? <FilePlus2 size={15} /> : <AlertTriangle size={15} />}</span>
                <div><strong>{humanize(requirement.key)}</strong><small>{requirement.kind === "ARTIFACT" ? uploadInProgress ? "Document processing" : "Required document" : requirement.status === "PRESENT" ? "Completed information" : requirement.status === "CONFLICT" ? "Resolve conflicting information" : requirement.status === "LOW_CONFIDENCE" ? "Confirm this information" : "Required information"}{requirement.stageGate ? ` · ${humanize(requirement.stageGate)}` : ""}</small></div>
                {requirement.kind === "ARTIFACT" ? <div className="requirement-upload-control"><button className="secondary-button document-upload-button" type="button" disabled={pending || uploadInProgress || !props.onUploadDocument || selected.businessStage === "CLOSED" || selected.businessStage === "CANCELLED" || selected.lifecycle === "DORMANT"} onClick={() => { setUploadRequirement(requirement); window.setTimeout(() => documentInput.current?.click(), 0); }}>{uploadingLocally || pendingUpload?.processingStatus === "RUNNING" ? <LoaderCircle className="processing-spinner" size={14} /> : pendingUpload ? <Clock3 size={14} /> : <Upload size={14} />} {uploadingLocally ? "Uploading..." : pendingUpload?.processingStatus === "RUNNING" ? "Checking..." : pendingUpload ? "Waiting..." : requirement.status === "PRESENT" ? "Replace file" : "Upload document"}</button><small>{pendingUpload ? "Uploaded · Waiting for safety check" : uploadingLocally ? "Uploading securely" : "PDF, JPG or PNG · Maximum 5 MB"}</small></div> : <span className="requirement-location">See Required information</span>}
                {props.onRemoveRequirement && requirement.source !== "TEMPLATE" && !["DORMANT", "ARCHIVED"].includes(selected.lifecycle) ? <button className="icon-button" type="button" title="Remove requirement" aria-label={`Remove ${humanize(requirement.key)}`} disabled={pending} onClick={() => void run(() => props.onRemoveRequirement!(selected, requirement))}><Trash2 size={14} /></button> : <span />}
              </div>;
            })}</div>
          </section>
          {selected.businessStage === "UNDER_REVIEW" ? <section className="review-submitted" aria-label="Submitted for review"><CheckCircle2 size={19} /><div><strong>{approvalBlockers === 0 ? "Review checks complete" : "Review in progress"}</strong><span>{approvalBlockers === 0 ? "All required information is complete and every required document is verified." : `${approvalBlockers} ${approvalBlockers === 1 ? "item requires" : "items require"} attention before this file can move to closing preparation.`}</span></div></section> : null}
          <div className="transaction-actions">
            {selected.businessStage === "DRAFT" && props.onBeginWork ? <button className="approve-button" type="button" disabled={pending} onClick={() => void run(() => props.onBeginWork!(selected))}><Check size={16} /> Begin work</button> : null}
            {selected.businessStage === "DOCUMENTS_PENDING" && props.onSubmitReview ? <button className="approve-button" type="button" disabled={pending || selected.requirements.some((item) => item.stageGate === "BEFORE_REVIEW" && item.status !== "PRESENT") || selected.customFields?.some((field) => field.required && field.stageGate === "BEFORE_REVIEW" && field.value === undefined)} onClick={() => void run(() => props.onSubmitReview!(selected), "Review submitted.")}><CheckCircle2 size={16} /> Submit for review</button> : null}
            {selected.businessStage === "UNDER_REVIEW" && props.onCompleteReview ? <button className="approve-button" type="button" disabled={pending || approvalBlockers > 0} onClick={() => void run(() => props.onCompleteReview!(selected), "Review completed. This file is ready for closing preparation.")}><CheckCircle2 size={16} /> Complete review</button> : null}
            {selected.businessStage === "READY_FOR_CLOSING" && props.onCloseFile ? <button className="approve-button" type="button" disabled={pending} onClick={() => void run(() => props.onCloseFile!(selected), "Transaction File closed.")}><CheckCircle2 size={16} /> Close Transaction File</button> : null}
            {["CLOSED", "CANCELLED"].includes(selected.businessStage ?? "") && props.onReopenFile ? <button className="secondary-button" type="button" disabled={pending} onClick={() => setLifecycleAction("REOPEN")}><RefreshCw size={16} /> Reopen file</button> : null}
            {!selected.businessStage && (selected.lifecycle === "ACCUMULATING" || selected.lifecycle === "AMBIGUOUS") ? <button className="approve-button" type="button" disabled={pending || blockers.length > 0 || selected.requirements.length === 0} onClick={() => void run(() => props.onEvaluate(selected))}><CheckCircle2 size={16} /> Ready for final review</button> : null}
            {!selected.businessStage && selected.lifecycle === "CONVERGED" && selected.requirements.length > 0 ? <button className="approve-button" type="button" disabled={pending} onClick={() => void run(() => props.onApprove(selected))}><Check size={16} /> Approve Transaction File</button> : null}
            {selected.lifecycle === "DORMANT" ? <button className="approve-button" type="button" disabled={pending} onClick={() => void run(() => props.onReactivate(selected))}><RefreshCw size={16} /> Reactivate file</button> : null}
            {selected.lifecycle === "APPROVED" ? <div className="transaction-approved"><CheckCircle2 size={18} /><span>Final review complete</span></div> : null}
            {selected.lifecycle === "DORMANT" ? <div className="transaction-dormant"><Moon size={17} /><span>This file is inactive. Reactivate it before making changes.</span></div> : null}
          </div>
        </> : null}
      </main>
    </div>
    {editingRequirement ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setEditingRequirement(null)}><form className="modal requirement-value-modal" role="dialog" aria-modal="true" aria-labelledby="requirement-value-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void setRequirementValue(event)}><div className="modal-icon"><Pencil size={20} /></div><h2 id="requirement-value-title">{humanize(editingRequirement.key)}</h2><p>{editingRequirement.status === "CONFLICT" ? "Enter the correct information to resolve the conflict." : editingRequirement.status === "LOW_CONFIDENCE" ? "Review and confirm the information below." : "Enter the missing information for this Transaction File."}</p><label>Information<textarea name="value" aria-label={`${humanize(editingRequirement.key)} information`} required autoFocus defaultValue={editingRequirement.value ?? ""} placeholder="Enter complete information" /></label><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setEditingRequirement(null)}>Cancel</button><button className="approve-button" type="submit" disabled={pending}>{pending ? "Saving..." : editingRequirement.status === "LOW_CONFIDENCE" ? "Confirm information" : "Save information"}</button></div></form></div> : null}
    {documentDecision ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setDocumentDecision(null)}><form className="modal requirement-value-modal" role="dialog" aria-modal="true" aria-labelledby="document-decision-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void reviewDocument(event)}><div className="modal-icon">{documentDecision.decision === "VERIFIED" ? <Check size={20} /> : <X size={20} />}</div><h2 id="document-decision-title">{documentDecision.decision === "VERIFIED" ? "Verify document" : "Reject document"}</h2><p>{documentDecision.decision === "VERIFIED" ? `Confirm that ${documentDecision.document.name} is correct and usable.` : "Explain what is wrong so the owner knows what to replace or correct."}</p>{documentDecision.decision === "REJECTED" ? <label>Reason<textarea name="reason" aria-label="Rejection reason" required autoFocus placeholder="Describe the issue clearly" /></label> : null}<div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setDocumentDecision(null)}>Cancel</button><button className={documentDecision.decision === "VERIFIED" ? "approve-button" : "secondary-button"} type="submit" disabled={pending}>{pending ? "Saving..." : documentDecision.decision === "VERIFIED" ? "Verify document" : "Reject document"}</button></div></form></div> : null}
    {paymentEditor ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setPaymentEditor(null)}><form className="modal requirement-value-modal" role="dialog" aria-modal="true" aria-labelledby="payment-status-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void setInvoicePayment(event)}><div className="modal-icon"><CreditCard size={20} /></div><h2 id="payment-status-title">Update payment</h2><p>{paymentEditor.vendor} · {paymentEditor.invoiceNumber ?? "No invoice number"} · {formatMoney(paymentEditor.total ?? 0, paymentEditor.currency)}</p><label>Status<select name="status" aria-label="Payment status" value={paymentStatus} onChange={(event) => setPaymentStatus(event.target.value as TransactionPaymentStatus)}><option value="UNPAID">Unpaid</option><option value="SCHEDULED">Scheduled</option><option value="PARTIALLY_PAID">Partially paid</option><option value="PAID">Paid</option><option value="DISPUTED">Disputed</option><option value="VOIDED">Voided</option></select></label>{paymentStatus === "PARTIALLY_PAID" || paymentStatus === "DISPUTED" ? <label>Paid amount<input name="paidAmount" aria-label="Paid amount" type="number" min="0" max={paymentEditor.total ?? undefined} step="0.01" required defaultValue={paymentEditor.paidAmount} /></label> : null}{paymentStatus === "SCHEDULED" ? <label>Scheduled date<input name="scheduledFor" aria-label="Scheduled date" type="date" required defaultValue={paymentEditor.scheduledFor ?? ""} /></label> : null}{paymentStatus === "DISPUTED" || paymentStatus === "VOIDED" ? <label>Reason<textarea name="note" aria-label="Payment status reason" required maxLength={500} defaultValue={paymentEditor.paymentNote ?? ""} placeholder="Add a concise reason" /></label> : null}<div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setPaymentEditor(null)}>Cancel</button><button className="approve-button" type="submit" disabled={pending}>{pending ? "Saving..." : "Save payment status"}</button></div></form></div> : null}
    {unlinkingInvoice ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setUnlinkingInvoice(null)}><form className="modal requirement-value-modal" role="dialog" aria-modal="true" aria-labelledby="unlink-invoice-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void unlinkInvoice(event)}><div className="modal-icon"><Link size={20} /></div><h2 id="unlink-invoice-title">Unlink invoice</h2><p>{unlinkingInvoice.vendor} · {unlinkingInvoice.invoiceNumber ?? "No invoice number"}. The invoice will remain available and its verification history will be retained.</p><label>Reason<textarea name="reason" required autoFocus maxLength={1000} placeholder="Explain why this invoice no longer belongs to this deal" /></label><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setUnlinkingInvoice(null)}>Keep linked</button><button className="approve-button" type="submit" disabled={pending}>{pending ? "Unlinking..." : "Unlink invoice"}</button></div></form></div> : null}
    {reviewingInvoice ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setReviewingInvoice(null)}><form className="modal requirement-value-modal" role="dialog" aria-modal="true" aria-labelledby="review-invoice-context-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void reviewInvoiceContext(event)}><div className="modal-icon"><Check size={20} /></div><h2 id="review-invoice-context-title">Review invoice link</h2><p>Confirm that {reviewingInvoice.vendor} · {reviewingInvoice.invoiceNumber ?? "No invoice number"} belongs to this Transaction File and remains valid in this deal context.</p><label>Review note<textarea name="resolution" required autoFocus maxLength={1000} placeholder="Record what you checked" /></label><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setReviewingInvoice(null)}>Cancel</button><button className="approve-button" type="submit" disabled={pending}>{pending ? "Saving..." : "Complete review"}</button></div></form></div> : null}
    {issueEditor === "CREATE" ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setIssueEditor(null)}><form className="modal requirement-value-modal" role="dialog" aria-modal="true" aria-labelledby="create-issue-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void saveIssue(event)}><div className="modal-icon"><AlertTriangle size={20} /></div><h2 id="create-issue-title">Add issue</h2><p>Record an exception that needs attention before this deal can progress.</p><label>Title<input name="title" required maxLength={160} autoFocus placeholder="Describe the issue" /></label><label>Category<select name="category"><option value="DOCUMENT">Document</option><option value="INVOICE">Invoice</option><option value="PAYMENT">Payment</option><option value="PARTY">Party</option><option value="DATE">Date</option><option value="FINANCIAL">Financial</option><option value="OTHER">Other</option></select></label><label>Severity<select name="severity"><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option><option value="CRITICAL">Critical</option></select></label><label>Owner<select name="ownerUserId"><option value="">Unassigned</option>{props.ownerOptions?.map((owner) => <option key={owner.userId} value={owner.userId}>{owner.label}</option>)}</select></label><label>Due date<input name="dueDate" type="date" /></label><label className="checkbox-field"><input name="blocking" type="checkbox" /> Blocks closing</label><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setIssueEditor(null)}>Cancel</button><button className="approve-button" type="submit" disabled={pending}>{pending ? "Saving..." : "Add issue"}</button></div></form></div> : null}
    {issueEditor && issueEditor !== "CREATE" ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setIssueEditor(null)}><form className="modal requirement-value-modal" role="dialog" aria-modal="true" aria-labelledby="resolve-issue-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void resolveIssue(event)}><div className="modal-icon"><Check size={20} /></div><h2 id="resolve-issue-title">Resolve issue</h2><p>{issueEditor.title}</p><label>Resolution<textarea name="resolution" required autoFocus maxLength={1000} placeholder="Explain how this issue was resolved" /></label><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setIssueEditor(null)}>Cancel</button><button className="approve-button" type="submit" disabled={pending}>{pending ? "Saving..." : "Resolve issue"}</button></div></form></div> : null}
    {lifecycleAction ? <div className="modal-backdrop" role="presentation" onMouseDown={() => setLifecycleAction(null)}><form className="modal requirement-value-modal" role="dialog" aria-modal="true" aria-labelledby="lifecycle-action-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => void submitLifecycleAction(event)}><div className="modal-icon">{lifecycleAction === "CANCEL" ? <X size={20} /> : <RefreshCw size={20} />}</div><h2 id="lifecycle-action-title">{lifecycleAction === "CANCEL" ? "Cancel Transaction File" : "Reopen Transaction File"}</h2><p>{lifecycleAction === "CANCEL" ? "Invoices and documents will be retained. Explain why this deal is being cancelled." : "Explain why this completed file needs to return to active work."}</p><label>Reason<textarea name="reason" required autoFocus maxLength={1000} placeholder="Enter a clear reason" /></label><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setLifecycleAction(null)}>Go back</button><button className="approve-button" type="submit" disabled={pending}>{pending ? "Saving..." : lifecycleAction === "CANCEL" ? "Cancel Transaction File" : "Reopen Transaction File"}</button></div></form></div> : null}
  </section>;
}

function humanize(value: string): string {
  const spaced = value.replace(/[-_]+/g, " ").trim();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : value;
}

function formatOutstanding(totals: Record<string, number>): string {
  const entries = Object.entries(totals);
  if (entries.length === 0) return "—";
  if (entries.length > 1) return `${entries.length} currencies`;
  const [currency, amount] = entries[0]!;
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(amount));
}

function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function issueDisplayTitle(issue: TransactionIssue): string {
  if (issue.status !== "RESOLVED" || issue.source !== "GENERATED") return issue.title;
  if (issue.title === "Missing information") return "Information provided";
  if (issue.title === "Missing document") return "Document received";
  if (issue.title === "Conflicting information") return "Information conflict resolved";
  if (issue.title === "Information needs confirmation") return "Information confirmed";
  return issue.title;
}
