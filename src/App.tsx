import {
  AlertTriangle,
  Archive,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  FileCheck2,
  FileSearch,
  Files,
  Filter,
  Inbox,
  Info,
  Link2Off,
  Link,
  LogOut,
  Menu,
  MoreHorizontal,
  PanelLeftClose,
  RefreshCw,
  Search,
  Settings,
  ShieldAlert,
  Upload,
  UserCheck,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApprovalPolicySettings } from "./ApprovalPolicySettings.js";
import type { ApprovalMode, ApprovalPolicy } from "./infrastructure/supabase/approval-policies.js";
import { TransactionWorkspace } from "./TransactionWorkspace.js";
import type { RequirementStatus, TransactionActionItem, TransactionCustomField, TransactionDocument, TransactionFile, TransactionFinancial, TransactionImportantDate, TransactionLinkageProposal, TransactionOwnerOption, TransactionParty, TransactionPartyRole, TransactionRequirement, TransactionTypeOption } from "./infrastructure/supabase/transactions.js";

type QueueStatus =
  | "Needs attention"
  | "Ready to review"
  | "Processing"
  | "Quarantined"
  | "Verified";

export interface QueueItem {
  id: string;
  issuer: string;
  reference: string;
  amount: string;
  age: string;
  status: QueueStatus;
  origin: "Captured" | "Generated";
  linked: boolean;
  linkedTransactionId?: string;
  blocker?: string;
  invoiceNumber?: string;
  description: string;
  assignedToMe: boolean;
  evidenceCount?: number;
  databaseVersion?: number;
  intakeStage?: "QUEUED_FOR_SCAN" | "SCANNING" | "EXTRACTING" | "ASSEMBLING" | "QUARANTINED" | "PROCESSING_FAILED";
  ingestionEventId?: string;
  intakeReceivedAt?: string;
}

export interface InvoiceDraft {
  invoiceNumber: string;
  date: string;
  issuer: string;
  billTo: string;
  currency: string;
  description: string;
  quantity: string;
  rate: string;
}

const initialQueue: QueueItem[] = [
  {
    id: "inv-1049",
    issuer: "Harborlight Staging Co.",
    reference: "Staging · 906 Juniper Lane",
    amount: "$2,850.00",
    age: "8 min",
    status: "Ready to review",
    origin: "Generated",
    linked: false,
    description: "Home staging package",
    assignedToMe: true,
    evidenceCount: 3,
  },
  {
    id: "inv-1048",
    issuer: "Northstar Home Inspections",
    reference: "Inspection · 1847 Cypress Ave",
    amount: "$486.00",
    age: "18 min",
    status: "Needs attention",
    origin: "Captured",
    linked: false,
    blocker: "Invoice number missing",
    description: "Residential inspection",
    assignedToMe: true,
  },
  {
    id: "inv-1047",
    issuer: "Apex Title Services",
    reference: "Escrow · 72 Garden Row",
    amount: "$1,240.00",
    age: "43 min",
    status: "Ready to review",
    origin: "Captured",
    linked: true,
    invoiceNumber: "ATS-78214",
    description: "Settlement coordination fee",
    assignedToMe: true,
  },
  {
    id: "inv-1046",
    issuer: "Stonebridge Appraisal",
    reference: "Appraisal · 410 Lakeview Dr",
    amount: "$675.00",
    age: "1 hr",
    status: "Processing",
    origin: "Captured",
    linked: true,
    invoiceNumber: "SBA-410-26",
    description: "Residential appraisal",
    assignedToMe: false,
  },
  {
    id: "inv-1045",
    issuer: "Unrecognized upload",
    reference: "image_2049.heic",
    amount: "—",
    age: "2 hr",
    status: "Quarantined",
    origin: "Captured",
    linked: false,
    blocker: "Unsupported file encoding",
    description: "Unreadable source",
    assignedToMe: true,
  },
  {
    id: "inv-1044",
    issuer: "Summit Photography",
    reference: "Media · 25 Westbourne St",
    amount: "$320.00",
    age: "Yesterday",
    status: "Verified",
    origin: "Captured",
    linked: true,
    invoiceNumber: "SP-091726",
    description: "Property photography package",
    assignedToMe: true,
  },
];

const statusTone: Record<QueueStatus, string> = {
  "Needs attention": "danger",
  "Ready to review": "warning",
  Processing: "info",
  Quarantined: "neutral",
  Verified: "success",
};

interface FieldProps {
  label: string;
  value: string;
  confidence?: string;
  required?: boolean;
  invalid?: boolean;
  onChange?: (value: string) => void;
  onInspect?: () => void;
  onCommit?: () => void;
}

function InvoiceField({
  label,
  value,
  confidence,
  required,
  invalid,
  onChange,
  onInspect,
  onCommit,
}: FieldProps) {
  const inputId = useId();
  return (
    <div className={`field ${invalid ? "field-invalid" : ""}`}>
      <span className="field-label">
        <label htmlFor={inputId}>
          {label}
          {required ? <span className="required">*</span> : null}
        </label>
        {confidence ? (
          <button
            className="confidence"
            type="button"
            onClick={onInspect}
            aria-label={`Inspect source for ${label}`}
            title={`Inspect source for ${label}`}
          >
            {confidence}
          </button>
        ) : null}
      </span>
      <input
        id={inputId}
        aria-invalid={invalid}
        readOnly={!onChange}
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        onBlur={onCommit}
      />
      {invalid ? <span className="field-error">Required before approval</span> : null}
    </div>
  );
}

function SourceDocument({
  highlight,
  item,
}: {
  highlight: string | null;
  item: QueueItem;
}) {
  const initials = item.issuer
    .split(" ")
    .slice(0, 2)
    .map((word) => word[0])
    .join("");
  return (
    <div className="paper-wrap" aria-label="Source invoice preview">
      <article className="paper">
        <div className="scan-grain" />
        <header className="paper-header">
          <div className="source-logo">{initials}</div>
          <div className={highlight === "issuer" ? "source-highlight" : ""} data-source-field="issuer" aria-label="Issuer source">
            <strong>{item.issuer.toUpperCase()}</strong>
            <span>REAL ESTATE SERVICES</span>
          </div>
          <div className="paper-title">INVOICE</div>
        </header>
        <div className="paper-meta">
          <div>
            <small>FROM</small>
            <strong>{item.issuer}</strong>
            <span>219 Broad Street</span>
            <span>Austin, TX 78701</span>
          </div>
          <div className={highlight === "date" ? "source-highlight" : ""} data-source-field="date" aria-label="Invoice date source">
            <small>DATE</small>
            <strong>September 18, 2026</strong>
          </div>
        </div>
        <div className={highlight === "billTo" ? "paper-bill source-highlight" : "paper-bill"} data-source-field="billTo" aria-label="Bill-to party source">
          <small>BILL TO</small>
          <strong>Cedar Lane Realty LLC</strong>
          <span>1847 Cypress Avenue</span>
          <span>Austin, TX 78704</span>
        </div>
        <table className="paper-table">
          <thead>
            <tr>
              <th>DESCRIPTION</th>
              <th>QTY</th>
              <th>RATE</th>
              <th>AMOUNT</th>
            </tr>
          </thead>
          <tbody>
            <tr className={highlight === "line" ? "source-highlight" : ""} data-source-field="line" aria-label="Line item source">
              <td>{item.description}</td>
              <td>1</td>
              <td>{item.amount}</td>
              <td>{item.amount}</td>
            </tr>
          </tbody>
        </table>
        <div className="paper-total">
          <span>TOTAL DUE <small className={highlight === "currency" ? "source-highlight currency-source" : "currency-source"} data-source-field="currency" aria-label="Currency source">USD</small></span>
          <strong className={highlight === "total" ? "source-highlight" : ""}>
            {item.amount}
          </strong>
        </div>
        <div className="paper-note">
          Thank you. Please include the property address with payment.
        </div>
        <div className="paper-stamp">SCANNED</div>
      </article>
    </div>
  );
}

function EvidenceStack({ highlight }: { highlight: string | null }) {
  const evidence = [
    { kind: "Email body", title: "Staging approval", meta: "Maya Chen · Sep 19, 10:42 AM", text: "Approved Harborlight for 906 Juniper Lane. Total budget is $2,850." },
    { kind: "Attachment", title: "harborlight-scope.pdf", meta: "2 pages · Sep 19, 10:42 AM", text: "Home staging package · quantity 1 · service date Sep 24" },
    { kind: "Email body", title: "Billing details", meta: "Harborlight Staging · Sep 20, 3:18 PM", text: "Please bill Cedar Lane Realty LLC in USD after installation." },
  ];

  return (
    <div className="evidence-stack" aria-label="Supporting evidence">
      <header><strong>3 supporting artifacts</strong><span>Across 2 email threads</span></header>
      {evidence.map((item, index) => (
        <article className={highlight ? "evidence-card source-highlight" : "evidence-card"} key={item.title}>
          <div className="evidence-index">{index + 1}</div>
          <div><span className="evidence-kind">{item.kind}</span><h4>{item.title}</h4><small>{item.meta}</small><p>{item.text}</p></div>
        </article>
      ))}
      <div className="resolution-note"><Link size={16} /><div><strong>Grouped with high confidence</strong><span>Property address, Issuer, amount, and time window agree. No hard contradictions found.</span></div></div>
    </div>
  );
}

interface AppProps {
  workspaceName?: string;
  userEmail?: string;
  onSignOut?: () => void | Promise<void>;
  initialQueueItems?: QueueItem[];
  initialInvoiceDrafts?: Record<string, InvoiceDraft>;
  onPersistField?: (input: { invoiceId: string; expectedVersion: number; field: keyof InvoiceDraft; value: string }) => Promise<number>;
  onVerify?: (input: { invoiceId: string; expectedVersion: number; origin: "Captured" | "Generated" }) => Promise<string>;
  onUpload?: (file: File) => Promise<void>;
  onCancelIntake?: (ingestionEventId: string) => Promise<void>;
  workspaceRole?: "TENANT_ADMIN" | "REVIEWER" | "VIEWER" | "INTEGRATION";
  approvalPolicy?: ApprovalPolicy | null;
  onPublishApprovalPolicy?: (mode: ApprovalMode, rules: ApprovalPolicy["rules"]) => Promise<ApprovalPolicy>;
  transactions?: TransactionFile[];
  linkageProposals?: TransactionLinkageProposal[];
  transactionTypes?: TransactionTypeOption[];
  transactionOwners?: TransactionOwnerOption[];
  transactionActions?: Array<TransactionActionItem & { assignedToMe: boolean }>;
  onCreateTransaction?: (input: { externalReference: string; propertyAddress: string; transactionTypeId: string; ownerId: string; primaryPartyName: string; primaryPartyKind: "PERSON" | "ORGANIZATION"; primaryPartyRole: "BUYER" | "SELLER" | "TENANT" | "LANDLORD" }) => Promise<void>;
  onAddTransactionRequirement?: (transaction: TransactionFile, input: { kind: TransactionRequirement["kind"]; key: string }) => Promise<void>;
  onUpdateTransactionDetails?: (transaction: TransactionFile, input: { externalReference: string; propertyAddress: string; transactionType: string; office: string; closingDate: string }) => Promise<void>;
  onRemoveTransactionRequirement?: (transaction: TransactionFile, requirement: TransactionRequirement) => Promise<void>;
  onLinkTransaction?: (transaction: TransactionFile, invoice: QueueItem) => Promise<void>;
  onResolveLinkageProposal?: (proposal: TransactionLinkageProposal, invoice: QueueItem, decision: "ACCEPT" | "REJECT") => Promise<void>;
  onUpdateTransactionRequirement?: (transaction: TransactionFile, requirement: TransactionRequirement, status: RequirementStatus) => Promise<void>;
  onEvaluateTransaction?: (transaction: TransactionFile) => Promise<void>;
  onApproveTransaction?: (transaction: TransactionFile) => Promise<void>;
  onReactivateTransaction?: (transaction: TransactionFile) => Promise<void>;
  onBeginTransactionWork?: (transaction: TransactionFile) => Promise<void>;
  onSubmitTransactionReview?: (transaction: TransactionFile) => Promise<void>;
  onAddTransactionParty?: (transaction: TransactionFile, input: { name: string; kind: TransactionParty["kind"]; role: TransactionPartyRole; primary: boolean }) => Promise<void>;
  onSetTransactionDate?: (transaction: TransactionFile, input: { kind: TransactionImportantDate["kind"]; date: string }) => Promise<void>;
  onSetTransactionFinancial?: (transaction: TransactionFile, input: { kind: TransactionFinancial["kind"]; label: string; amount: number; currency: string }) => Promise<void>;
  onAddTransactionCustomField?: (transaction: TransactionFile, input: { key: string; label: string; dataType: TransactionCustomField["dataType"]; required: boolean; stageGate: TransactionCustomField["stageGate"] }) => Promise<void>;
  onSetTransactionCustomFieldValue?: (transaction: TransactionFile, field: TransactionCustomField, value: unknown) => Promise<void>;
  onUploadTransactionDocument?: (transaction: TransactionFile, requirement: TransactionRequirement, file: File) => Promise<void>;
  onSetTransactionRequirementValue?: (transaction: TransactionFile, requirement: TransactionRequirement, value: string) => Promise<void>;
  onReviewTransactionDocument?: (transaction: TransactionFile, document: TransactionDocument, decision: "VERIFIED" | "REJECTED", reason?: string) => Promise<void>;
  onCancelTransactionDocumentUpload?: (transaction: TransactionFile, ingestionEventId: string) => Promise<void>;
}

export function App({ workspaceName = "Cedar Lane Realty", userEmail = "Ajay Kumar", onSignOut, initialQueueItems = initialQueue, initialInvoiceDrafts, onPersistField, onVerify, onUpload, onCancelIntake, workspaceRole = "TENANT_ADMIN", approvalPolicy = null, onPublishApprovalPolicy, transactions = [], transactionActions = [], linkageProposals = [], transactionTypes = [], transactionOwners = [], onCreateTransaction, onAddTransactionRequirement, onUpdateTransactionDetails, onRemoveTransactionRequirement, onLinkTransaction, onResolveLinkageProposal, onUpdateTransactionRequirement, onEvaluateTransaction, onApproveTransaction, onReactivateTransaction, onBeginTransactionWork, onSubmitTransactionReview, onAddTransactionParty, onSetTransactionDate, onSetTransactionFinancial, onAddTransactionCustomField, onSetTransactionCustomFieldValue, onUploadTransactionDocument, onSetTransactionRequirementValue, onReviewTransactionDocument, onCancelTransactionDocumentUpload }: AppProps = {}) {
  const [queue, setQueue] = useState(initialQueueItems);
  const [selectedId, setSelectedId] = useState(initialQueueItems === initialQueue ? "inv-1048" : initialQueueItems[0]?.id ?? "");
  const [invoiceNumbers, setInvoiceNumbers] = useState<Record<string, string>>(
    Object.fromEntries(
      initialQueueItems.map((item) => [item.id, item.invoiceNumber ?? ""]),
    ),
  );
  const [drafts, setDrafts] = useState<Record<string, InvoiceDraft>>(
    initialInvoiceDrafts ?? Object.fromEntries(initialQueueItems.map((item) => [item.id, {
      invoiceNumber: item.invoiceNumber ?? "",
      date: "2026-09-18",
      issuer: item.issuer,
      billTo: "Cedar Lane Realty LLC",
      currency: "USD",
      description: item.description,
      quantity: "1",
      rate: item.amount.replace(/[$,]/g, "").replace("—", "0"),
    }])),
  );
  const [highlight, setHighlight] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<"mine" | "all">("mine");
  const [query, setQuery] = useState("");
  const [showSource, setShowSource] = useState(initialQueueItems[0]?.status !== "Processing" && initialQueueItems[0]?.status !== "Quarantined");
  const [showQueue, setShowQueue] = useState(false);
  const [showApprove, setShowApprove] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [statusFilter, setStatusFilter] = useState<QueueStatus | "All">("All");
  const [toast, setToast] = useState<string | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [activeNav, setActiveNav] = useState<"work" | "invoices" | "transactions" | "archive">("work");
  const [selectedTransactionId, setSelectedTransactionId] = useState<string | undefined>();
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandPending, setCommandPending] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [currentApprovalPolicy, setCurrentApprovalPolicy] = useState(approvalPolicy);
  const [clock, setClock] = useState(() => Date.now());
  const fileInput = useRef<HTMLInputElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showUserMenu) return;
    function dismiss(event: PointerEvent) {
      if (!userMenuRef.current?.contains(event.target as Node)) setShowUserMenu(false);
    }
    function dismissWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") setShowUserMenu(false);
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [showUserMenu]);

  useEffect(() => {
    if (!showActions) return;
    function dismiss(event: PointerEvent) {
      if (!actionsMenuRef.current?.contains(event.target as Node)) setShowActions(false);
    }
    function dismissWithKeyboard(event: KeyboardEvent) {
      if (event.key === "Escape") setShowActions(false);
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [showActions]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 5000);
    return () => window.clearInterval(timer);
  }, []);

  const selected = queue.find(({ id }) => id === selectedId) ?? queue[0];
  const invoiceNumber = selected ? (invoiceNumbers[selected.id] ?? "") : "";
  const draft = selected ? drafts[selected.id] : undefined;
  const total = Number(draft?.quantity || 0) * Number(draft?.rate || 0);
  const formattedTotal = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: draft?.currency || "USD",
  }).format(Number.isFinite(total) ? total : 0);
  const filteredQueue = useMemo(
    () =>
      queue.filter(
        (item) =>
          (activeFilter === "all" || item.assignedToMe) &&
          (statusFilter === "All" || item.status === statusFilter) &&
          `${item.issuer} ${item.reference} ${item.status}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [activeFilter, query, queue, statusFilter],
  );
  const filteredTransactionActions = useMemo(() => transactionActions.filter((item) => {
    const transaction = transactions.find((candidate) => candidate.id === item.transactionId);
    return (activeFilter === "all" || item.assignedToMe)
      && `${transaction?.propertyAddress ?? ""} ${transaction?.externalReference ?? ""} ${item.requirementKey}`.toLowerCase().includes(query.toLowerCase());
  }), [activeFilter, query, transactionActions, transactions]);
  const hasBlocker = selected?.origin === "Captured" && invoiceNumber.trim() === "";
  const canApprove = selected?.status !== "Processing" && selected?.status !== "Quarantined" && !hasBlocker;
  const scanQueueStalled = selected?.intakeStage === "QUEUED_FOR_SCAN" && selected.intakeReceivedAt !== undefined
    && clock - new Date(selected.intakeReceivedAt).getTime() >= 60000;

  function selectInvoice(id: string) {
    setSelectedId(id);
    setShowQueue(false);
    setHighlight(null);
    setShowActions(false);
    const next = queue.find((item) => item.id === id);
    if (next?.status === "Quarantined" || next?.status === "Processing") setShowSource(false);
  }

  function inspectSource(target: string) {
    setHighlight(target);
    setShowSource(true);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-source-field="${target}"]`)?.scrollIntoView?.({ behavior: "smooth", block: "center", inline: "center" }));
    window.setTimeout(() => setHighlight(null), 2200);
  }

  function updateInvoiceNumber(value: string) {
    if (!selected) return;
    setInvoiceNumbers((current) => ({ ...current, [selected.id]: value }));
    updateDraft("invoiceNumber", value);
  }

  function updateDraft(field: keyof InvoiceDraft, value: string) {
    if (!selected) return;
    setDrafts((current) => ({
      ...current,
      [selected.id]: { ...current[selected.id]!, [field]: value },
    }));
  }

  async function commitField(field: keyof InvoiceDraft) {
    if (!selected || !draft || !onPersistField || selected.databaseVersion === undefined) return;
    setCommandPending(true);
    setCommandError(null);
    try {
      const nextVersion = await onPersistField({
        invoiceId: selected.id,
        expectedVersion: selected.databaseVersion,
        field,
        value: draft[field],
      });
      updateSelected({ databaseVersion: nextVersion });
      notify(`${field} saved`);
    } catch (reason) {
      setCommandError(reason instanceof Error ? reason.message : "Unable to save invoice field");
    } finally {
      setCommandPending(false);
    }
  }

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  }

  function updateSelected(patch: Partial<QueueItem>, clearBlocker = false) {
    if (!selected) return;
    setQueue((current) => current.map((item) => {
      if (item.id !== selected.id) return item;
      if (!clearBlocker) return { ...item, ...patch };
      const { blocker: _blocker, ...withoutBlocker } = item;
      return { ...withoutBlocker, ...patch };
    }));
  }

  function rerunExtraction() {
    if (!selected || selected.status === "Verified") return;
    updateSelected({ status: "Processing" }, true);
    notify("Extraction restarted");
    window.setTimeout(() => {
      setQueue((current) => current.map((item) => item.id === selected.id
        ? { ...item, status: "Ready to review", amount: formattedTotal }
        : item));
    }, 1400);
  }

  function completeProcessing() {
    if (!selected) return;
    updateSelected({
      status: invoiceNumber ? "Ready to review" : "Needs attention",
      ...(invoiceNumber ? {} : { blocker: "Invoice number missing" }),
      amount: formattedTotal,
    }, Boolean(invoiceNumber));
    notify("Extraction completed and review draft created");
  }

  function showQueueView(scope: "work" | "invoices" | "archive") {
    setActiveNav(scope);
    setQuery("");
    setActiveFilter(scope === "work" ? "mine" : "all");
    setStatusFilter(scope === "archive" ? "Verified" : "All");
    setShowQueue(true);
  }

  async function approveInvoice() {
    if (!selected) return;
    setCommandPending(true);
    setCommandError(null);
    let officialNumber = selected.origin === "Generated"
      ? `CLI-2026-${String(queue.filter((item) => item.origin === "Generated" && item.status === "Verified").length + 1).padStart(4, "0")}`
      : invoiceNumber;
    if (onVerify && selected.databaseVersion !== undefined) {
      try {
        const result = await onVerify({ invoiceId: selected.id, expectedVersion: selected.databaseVersion, origin: selected.origin });
        if (selected.origin === "Generated") officialNumber = result;
      } catch (reason) {
        setCommandError(reason instanceof Error ? reason.message : "Unable to verify invoice");
        setShowApprove(false);
        setCommandPending(false);
        return;
      }
    }
    if (selected.origin === "Generated") {
      setInvoiceNumbers((current) => ({ ...current, [selected.id]: officialNumber }));
    }
    setQueue((current) =>
      current.map((item) => {
        if (item.id !== selected.id) return item;
        const { blocker: _blocker, ...verified } = item;
        return { ...verified, status: "Verified" as const, invoiceNumber: officialNumber };
      }),
    );
    setShowApprove(false);
    setToast(selected.origin === "Generated" ? `Invoice ${officialNumber} verified; PDF compilation queued` : "Invoice verified and audit event recorded");
    window.setTimeout(() => setToast(null), 3200);
    setCommandPending(false);
  }

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    if (onUpload) {
      setCommandPending(true);
      setCommandError(null);
      try {
        await onUpload(file);
        notify(`${file.name} received and queued for safety scanning`);
      } catch (reason) {
        setCommandError(reason instanceof Error ? reason.message : "Upload failed");
      } finally {
        setCommandPending(false);
        if (fileInput.current) fileInput.current.value = "";
      }
      return;
    }
    if (selected?.status === "Quarantined") {
      const replacementName = file.name.replace(/\.[^.]+$/, "");
      updateSelected({
        issuer: replacementName,
        reference: `${file.name} · awaiting extraction`,
        status: "Processing",
        description: "Extraction in progress",
      }, true);
      setDrafts((current) => ({ ...current, [selected.id]: {
        invoiceNumber: "",
        date: new Date().toISOString().slice(0, 10),
        issuer: replacementName,
        billTo: "Cedar Lane Realty LLC",
        currency: "USD",
        description: "",
        quantity: "1",
        rate: "0",
      } }));
      setInvoiceNumbers((current) => ({ ...current, [selected.id]: "" }));
      setShowSource(false);
      notify(`${file.name} replaced the quarantined file and entered processing`);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    const id = `inv-upload-${Date.now()}`;
    const next: QueueItem = {
      id,
      issuer: file.name,
      reference: "Manual upload · awaiting extraction",
      amount: "—",
      age: "Now",
      status: "Processing",
      origin: "Captured",
      linked: false,
      description: "Extraction in progress",
      assignedToMe: true,
    };
    setQueue((current) => [next, ...current]);
    setInvoiceNumbers((current) => ({ ...current, [id]: "" }));
    setDrafts((current) => ({ ...current, [id]: {
      invoiceNumber: "",
      date: new Date().toISOString().slice(0, 10),
      issuer: file.name.replace(/\.[^.]+$/, ""),
      billTo: "Cedar Lane Realty LLC",
      currency: "USD",
      description: "",
      quantity: "1",
      rate: "0",
    } }));
    setSelectedId(id);
    setShowQueue(false);
    setShowSource(true);
    setToast(`${file.name} added to processing queue`);
    window.setTimeout(() => setToast(null), 3200);
  }

  async function cancelScan() {
    if (!selected?.ingestionEventId || !onCancelIntake) return;
    setCommandPending(true);
    setCommandError(null);
    try {
      await onCancelIntake(selected.ingestionEventId);
      notify("Upload cancelled");
    } catch (reason) {
      setCommandError(reason instanceof Error ? reason.message : "Unable to cancel scan");
    } finally {
      setCommandPending(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="app-nav" aria-label="Primary navigation">
        <div className="brand-mark" title="ThreadMerge">TM</div>
        <nav>
          <button className={`nav-icon ${activeNav === "work" ? "active" : ""}`} title="Work queue" aria-label="Work queue" aria-current={activeNav === "work" ? "page" : undefined} onClick={() => showQueueView("work")}>
            <Inbox size={20} />
          </button>
          <button className={`nav-icon ${activeNav === "invoices" ? "active" : ""}`} title="Invoices" aria-label="Invoices" aria-current={activeNav === "invoices" ? "page" : undefined} onClick={() => showQueueView("invoices")}>
            <FileCheck2 size={20} />
          </button>
          <button className={`nav-icon ${activeNav === "transactions" ? "active" : ""}`} title="Transaction Files" aria-label="Transaction Files" aria-current={activeNav === "transactions" ? "page" : undefined} onClick={() => setActiveNav("transactions")}>
            <Files size={20} />
          </button>
          <button className={`nav-icon ${activeNav === "archive" ? "active" : ""}`} title="Archive" aria-label="Archive" aria-current={activeNav === "archive" ? "page" : undefined} onClick={() => showQueueView("archive")}>
            <Archive size={20} />
          </button>
        </nav>
        <div className="nav-bottom" ref={userMenuRef}>
          <button className={`nav-icon ${showSettings ? "active" : ""}`} title="Settings" aria-label="Settings" aria-expanded={showSettings} onClick={() => setShowSettings(true)}>
            <Settings size={20} />
          </button>
          <button className="avatar" title={userEmail} aria-label="User menu" aria-expanded={showUserMenu} onClick={() => setShowUserMenu((current) => !current)}>
            {userEmail.split(/[@\s]/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "U"}
          </button>
          {showUserMenu ? <div className="user-menu">
            <div><strong>{workspaceName}</strong><span>{userEmail}</span></div>
            {onSignOut ? <button type="button" onClick={() => void onSignOut()}><LogOut size={15} /> Sign out</button> : null}
          </div> : null}
        </div>
      </aside>

      {activeNav === "transactions" ? <TransactionWorkspace transactions={transactions} {...(selectedTransactionId ? { initialSelectedId: selectedTransactionId } : {})} transactionTypes={transactionTypes} ownerOptions={transactionOwners} linkageProposals={linkageProposals} {...(selected?.databaseVersion === undefined || selected.status === "Processing" || selected.status === "Quarantined" ? { invoiceLinkMessage: selected?.status === "Processing" ? "The selected upload must finish processing before it can be linked. You can return later; the Transaction File will remain available." : "Select a processed, unlinked invoice from the review queue, then return here to link it." } : { selectedInvoice: { id: selected.id, version: selected.databaseVersion, label: `${selected.issuer}${selected.invoiceNumber ? ` · ${selected.invoiceNumber}` : ""}`, linked: selected.linked, ...(selected.linkedTransactionId ? { linkedTransactionId: selected.linkedTransactionId } : {}) } })} onClose={() => setActiveNav("work")}
        onCreate={onCreateTransaction ?? (async () => undefined)}
        {...(onAddTransactionRequirement ? { onAddRequirement: onAddTransactionRequirement } : {})}
        {...(onUpdateTransactionDetails ? { onUpdateDetails: onUpdateTransactionDetails } : {})}
        {...(onRemoveTransactionRequirement ? { onRemoveRequirement: onRemoveTransactionRequirement } : {})}
        onLink={async (transaction) => { if (selected && onLinkTransaction) await onLinkTransaction(transaction, selected); }}
        onResolveProposal={async (proposal, decision) => { if (selected && onResolveLinkageProposal) await onResolveLinkageProposal(proposal, selected, decision); }}
        onRequirement={onUpdateTransactionRequirement ?? (async () => undefined)}
        onEvaluate={onEvaluateTransaction ?? (async () => undefined)}
        onApprove={onApproveTransaction ?? (async () => undefined)}
        onReactivate={onReactivateTransaction ?? (async () => undefined)}
        {...(onBeginTransactionWork ? { onBeginWork: onBeginTransactionWork } : {})}
        {...(onSubmitTransactionReview ? { onSubmitReview: onSubmitTransactionReview } : {})}
        {...(onAddTransactionParty ? { onAddParty: onAddTransactionParty } : {})}
        {...(onSetTransactionDate ? { onSetDate: onSetTransactionDate } : {})}
        {...(onSetTransactionFinancial ? { onSetFinancial: onSetTransactionFinancial } : {})}
        {...(onAddTransactionCustomField ? { onAddCustomField: onAddTransactionCustomField } : {})}
        {...(onSetTransactionCustomFieldValue ? { onSetCustomFieldValue: onSetTransactionCustomFieldValue } : {})}
        {...(onUploadTransactionDocument ? { onUploadDocument: onUploadTransactionDocument } : {})}
        {...(onSetTransactionRequirementValue ? { onSetRequirementValue: onSetTransactionRequirementValue } : {})}
        {...(onReviewTransactionDocument ? { onReviewDocument: onReviewTransactionDocument } : {})}
        {...(onCancelTransactionDocumentUpload ? { onCancelDocumentUpload: onCancelTransactionDocumentUpload } : {})} /> : null}

      <section className={`queue-panel ${showQueue ? "queue-open" : ""}`}>
        <header className="queue-header">
          <div className="workspace-name">
            <Building2 size={16} />
            <span>{workspaceName}</span>
            <ChevronDown size={14} />
          </div>
          <div className="queue-title-row">
            <div>
              <h1>Review queue</h1>
              <p>{filteredQueue.length + filteredTransactionActions.length} {filteredQueue.length + filteredTransactionActions.length === 1 ? "item" : "items"} shown</p>
            </div>
            <button
              className="icon-button queue-close"
              type="button"
              onClick={() => setShowQueue(false)}
              aria-label="Close queue"
            >
              <X size={18} />
            </button>
          </div>
          <div className="queue-tools">
            <div className="segmented" aria-label="Queue scope">
              <button
                className={activeFilter === "mine" ? "selected" : ""}
                type="button"
                onClick={() => setActiveFilter("mine")}
              >
                My work
              </button>
              <button
                className={activeFilter === "all" ? "selected" : ""}
                type="button"
                onClick={() => setActiveFilter("all")}
              >
                All
              </button>
            </div>
            <button
              className={`icon-button ${showFilters ? "pressed" : ""}`}
              type="button"
              title="Filter queue"
              aria-label="Filter queue"
              aria-expanded={showFilters}
              onClick={() => setShowFilters((current) => !current)}
            >
              <Filter size={17} />
            </button>
          </div>
          {showFilters ? (
            <label className="filter-row">
              <span>Status</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as QueueStatus | "All")}
              >
                <option>All</option>
                <option>Needs attention</option>
                <option>Ready to review</option>
                <option>Processing</option>
                <option>Quarantined</option>
                <option>Verified</option>
              </select>
            </label>
          ) : null}
          <label className="search-box">
            <Search size={16} />
            <input
              placeholder="Search work"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </header>

        <div className="queue-list">
          {filteredTransactionActions.length > 0 ? <div className="queue-group-label">Transaction tasks</div> : null}
          {filteredTransactionActions.map((item) => {
            const transaction = transactions.find((candidate) => candidate.id === item.transactionId);
            const label = item.kind === "PROVIDE_DOCUMENT" ? "Document missing" : item.kind === "PROVIDE_INFORMATION" ? "Information missing" : item.kind === "RESOLVE_CONFLICT" ? "Resolve conflict" : "Needs confirmation";
            return <button className="queue-item transaction-task" type="button" key={item.id} onClick={() => { setSelectedTransactionId(item.transactionId); setActiveNav("transactions"); setShowQueue(false); }}><div className="queue-item-top"><span className="status-dot warning" /><strong>{transaction?.propertyAddress ?? "Transaction File"}</strong><span className="age">Deal</span></div><span className="queue-reference">{humanizeQueueValue(item.requirementKey)}</span><div className="queue-meta"><span className="status-label warning">{label}</span><span className="amount">{transaction?.externalReference || ""}</span></div></button>;
          })}
          {filteredTransactionActions.length > 0 && filteredQueue.length > 0 ? <div className="queue-group-label">Invoices</div> : null}
          {filteredQueue.map((item) => (
            <button
              className={`queue-item ${selected?.id === item.id ? "selected" : ""}`}
              type="button"
              key={item.id}
              onClick={() => selectInvoice(item.id)}
            >
              <div className="queue-item-top">
                <span className={`status-dot ${statusTone[item.status]}`} />
                <strong>{item.issuer}</strong>
                <span className="age">{item.age}</span>
              </div>
              <span className="queue-reference">{item.reference}</span>
              <div className="queue-meta">
                <span className={`status-label ${statusTone[item.status]}`}>{item.status}</span>
                {!item.linked ? <Link2Off size={13} aria-label="Unlinked" /> : null}
                <span className="amount">{item.amount}</span>
              </div>
              {item.blocker ? (
                <span className="queue-blocker">
                  <AlertTriangle size={13} /> {item.blocker}
                </span>
              ) : null}
            </button>
          ))}
          {filteredQueue.length === 0 && filteredTransactionActions.length === 0 ? (
            <div className="empty-queue"><FileSearch size={22} /><strong>No matching work</strong><span>Adjust the search or queue filter.</span></div>
          ) : null}
        </div>
        <footer className="queue-footer">
          <input
            ref={fileInput}
            type="file"
            hidden
            accept=".pdf,.png,.jpg,.jpeg,.heic,.doc,.docx,.xls,.xlsx,.csv"
            onChange={(event) => void handleUpload(event.target.files?.[0])}
          />
          <button className="upload-button" type="button" disabled={commandPending} onClick={() => fileInput.current?.click()}>
            <Upload size={17} /> {commandPending ? "Uploading..." : "Upload invoice"}
          </button>
        </footer>
      </section>

      <main className="review-area">
        <header className="review-header">
          <div className="mobile-actions">
            <button className="icon-button" onClick={() => setShowQueue(true)} aria-label="Open review queue">
              <Menu size={19} />
            </button>
          </div>
          <div className="record-heading">
            <div className="record-title-line">
              <h2>{selected?.issuer}</h2>
              <span className="origin-badge">{selected?.origin}</span>
              {!selected?.linked ? <span className="unlinked-badge">Unlinked</span> : null}
            </div>
            <p>{selected?.reference}</p>
          </div>
          <div className="header-actions" ref={actionsMenuRef}>
            <button
              className="icon-button source-toggle"
              type="button"
              title={showSource ? "Hide source" : "Show source"}
              aria-label={showSource ? "Hide source" : "Show source"}
              onClick={() => setShowSource((current) => !current)}
              hidden={selected?.status === "Quarantined" || selected?.status === "Processing"}
            >
              {showSource ? <PanelLeftClose size={18} /> : <FileSearch size={18} />}
            </button>
            {selected?.status !== "Quarantined" ? <button className="icon-button" type="button" title="More actions" aria-label="More actions" aria-expanded={showActions} onClick={() => setShowActions((current) => !current)}>
              <MoreHorizontal size={19} />
            </button> : null}
            {showActions && selected?.status !== "Quarantined" ? (
              <div className="actions-menu">
                <button type="button" onClick={() => { updateSelected({ assignedToMe: !selected?.assignedToMe }); setShowActions(false); notify(selected?.assignedToMe ? "Invoice unassigned" : "Invoice assigned to you"); }}><UserCheck size={15} />{selected?.assignedToMe ? "Unassign from me" : "Assign to me"}</button>
              </div>
            ) : null}
            {selected?.status !== "Quarantined" ? <button
              className="approve-button"
              type="button"
              disabled={!canApprove || selected?.status === "Verified"}
              onClick={() => setShowApprove(true)}
            >
              <Check size={17} />
              {selected?.status === "Verified" ? "Verified" : "Approve"}
            </button> : null}
          </div>
        </header>

        <div className={`review-workspace ${showSource && selected?.status !== "Quarantined" && selected?.status !== "Processing" ? "with-source" : ""}`}>
          {showSource && selected?.status !== "Quarantined" && selected?.status !== "Processing" ? (
            <section className="source-panel">
              <div className="panel-bar">
                <div>
                  <FileSearch size={16} />
                  <span>{selected?.origin === "Generated" ? "Evidence collection" : selected?.reference.split(" · ").at(-1)}</span>
                </div>
                <span>{selected?.origin === "Generated" ? `${selected.evidenceCount} artifacts` : "Page 1 of 1 · 428 KB"}</span>
              </div>
              {selected?.origin === "Generated" ? <EvidenceStack highlight={highlight} /> : selected ? <SourceDocument highlight={highlight} item={selected} /> : null}
            </section>
          ) : null}

          {selected?.status === "Quarantined" ? (
            <section className="quarantine-panel" aria-label="Quarantined file">
              <div className="state-symbol quarantine-symbol"><ShieldAlert size={24} /></div>
              <h3>File not recognized</h3>
              <p>{selected.blocker}. No invoice was generated and the file was not sent for extraction.</p>
              <button className="replace-button" type="button" onClick={() => fileInput.current?.click()}>
                <Upload size={16} /> Replace file
              </button>
            </section>
          ) : <section className="form-panel">
            <div className="form-scroll">
              {commandError ? <div className="blocker-banner" role="alert"><AlertTriangle size={18} /><div><strong>Action failed</strong><span>{commandError}</span></div></div> : null}
              {selected?.status === "Verified" ? (
                <div className="ready-banner">
                  <CheckCircle2 size={18} />
                  <div>
                    <strong>Verified invoice</strong>
                    <span>The canonical record is read-only. Changes require a correction.</span>
                  </div>
                </div>
              ) : hasBlocker ? (
                <div className="blocker-banner" role="alert">
                  <AlertTriangle size={18} />
                  <div>
                    <strong>1 blocker before approval</strong>
                    <span>Enter the missing invoice number.</span>
                  </div>
                </div>
              ) : (
                <div className="ready-banner">
                  <CheckCircle2 size={18} />
                  <div>
                    <strong>Validation passed</strong>
                    <span>This invoice is ready for approval.</span>
                  </div>
                </div>
              )}

              <div className="section-heading">
                <div>
                  <h3>Invoice details</h3>
                  <p>Default schema · v1 · {selected?.origin} invoice</p>
                </div>
                <button className="text-button" type="button" disabled={selected?.status === "Verified"} onClick={rerunExtraction}>
                  <RefreshCw size={14} /> Re-run extraction
                </button>
              </div>

              <div className="field-grid">
                {selected?.origin === "Generated" ? (
                  <InvoiceField
                    label="Official invoice number"
                    value={selected.status === "Verified" ? invoiceNumber : "Assigned at verification"}
                  />
                ) : (
                  <InvoiceField
                    label="Invoice number"
                    value={invoiceNumber}
                    required
                    invalid={hasBlocker}
                    {...(selected?.status === "Verified" ? {} : { onChange: updateInvoiceNumber })}
                    onCommit={() => void commitField("invoiceNumber")}
                  />
                )}
                <InvoiceField
                  label="Invoice date"
                  value={draft?.date ?? ""}
                  confidence="98%"
                  onInspect={() => inspectSource("date")}
                  {...(selected?.status === "Verified" ? {} : { onChange: (value: string) => updateDraft("date", value) })}
                  onCommit={() => void commitField("date")}
                />
              </div>

              <div className="section-divider" />
              <h3 className="compact-heading">Parties</h3>
              <InvoiceField
                label="Issuer"
                value={draft?.issuer ?? ""}
                confidence="99%"
                onInspect={() => inspectSource("issuer")}
                {...(selected?.status === "Verified" ? {} : { onChange: (value: string) => updateDraft("issuer", value) })}
                onCommit={() => void commitField("issuer")}
              />
              <div className="field-grid">
                <InvoiceField label="Bill-to party" value={draft?.billTo ?? ""} confidence="96%" onInspect={() => inspectSource("billTo")} {...(selected?.status === "Verified" ? {} : { onChange: (value: string) => updateDraft("billTo", value) })} onCommit={() => void commitField("billTo")} />
                <InvoiceField label="Currency" value={draft?.currency ?? ""} confidence="99%" onInspect={() => inspectSource("currency")} {...(selected?.status === "Verified" ? {} : { onChange: (value: string) => updateDraft("currency", value.toUpperCase()) })} onCommit={() => void commitField("currency")} />
              </div>

              <div className="section-divider" />
              <div className="section-heading line-heading">
                <div>
                  <h3>Line items</h3>
                  <p>1 extracted row</p>
                </div>
                <button className="text-button" type="button" onClick={() => inspectSource("line")}>
                  <FileSearch size={14} /> Inspect source
                </button>
              </div>
              <div className="line-table">
                <div className="line-table-head">
                  <span>Description</span><span>Qty</span><span>Rate</span><span>Amount</span>
                </div>
                <div className="line-row">
                  <input aria-label="Line item description" value={draft?.description ?? ""} readOnly={selected?.status === "Verified"} onChange={(event) => updateDraft("description", event.target.value)} onBlur={() => void commitField("description")} />
                  <input aria-label="Quantity" type="number" min="0" value={draft?.quantity ?? ""} readOnly={selected?.status === "Verified"} onChange={(event) => updateDraft("quantity", event.target.value)} onBlur={() => void commitField("quantity")} />
                  <input aria-label="Rate" type="number" min="0" step="0.01" value={draft?.rate ?? ""} readOnly={selected?.status === "Verified"} onChange={(event) => updateDraft("rate", event.target.value)} onBlur={() => void commitField("rate")} />
                  <strong>{formattedTotal}</strong>
                </div>
              </div>

              <div className="totals">
                <div><span>Subtotal</span><span>{formattedTotal}</span></div>
                <div><span>Tax</span><span>$0.00</span></div>
                <div className="total-row"><strong>Total</strong><strong>{formattedTotal}</strong></div>
              </div>

              <details className="provenance">
                <summary>
                  <span><Info size={15} /> Processing details</span>
                  <ChevronDown size={15} />
                </summary>
                <div className="provenance-grid">
                  <span>Extraction run</span><strong>run_9f3c2</strong>
                  <span>Schema fingerprint</span><strong>5d9a…01c8</strong>
                  <span>Last updated</span><strong>18 min ago</strong>
                </div>
              </details>
            </div>
            {selected?.status === "Processing" ? (
              <div className="state-overlay">
                <div className={`state-symbol processing-symbol ${selected.intakeStage === "QUEUED_FOR_SCAN" ? "queued-symbol" : ""}`}>{selected.intakeStage === "QUEUED_FOR_SCAN" ? <FileSearch size={24} /> : <RefreshCw size={24} />}</div>
                <h3>{selected.intakeStage === "EXTRACTING" ? "Reading invoice details" : selected.intakeStage === "ASSEMBLING" ? "Preparing invoice for review" : selected.intakeStage === "QUEUED_FOR_SCAN" ? scanQueueStalled ? "Processing is taking longer than usual" : "Waiting to process your invoice" : selected.intakeStage ? "Checking file safety" : "Reading invoice details"}</h3>
                <p>{selected.intakeStage === "EXTRACTING" || selected.intakeStage === "ASSEMBLING" ? "You can leave this page. We will continue processing and add the invoice to your review queue when it is ready." : selected.intakeStage === "QUEUED_FOR_SCAN" ? scanQueueStalled ? "Your file is safely uploaded. You can leave this page and check back later. If it remains here, contact your workspace administrator." : "Your file is safely uploaded and next in line. This usually starts within a minute, and you do not need to keep this page open." : selected.intakeStage ? "We are checking the uploaded file before reading its invoice details." : "You can leave this page while we prepare the invoice for review."}</p>
                {scanQueueStalled ? <div className="processing-warning" role="status"><Info size={16} /><span>Only cancel if you uploaded the wrong file or no longer need it processed.</span></div> : null}
                <ol className="stage-list">
                  <li className="done"><Check size={14} /> Upload complete</li>
                  <li className={selected.intakeStage === "QUEUED_FOR_SCAN" ? "queued" : selected.intakeStage === "SCANNING" ? "active" : "done"}>{selected.intakeStage === "QUEUED_FOR_SCAN" ? <FileSearch size={14} /> : selected.intakeStage === "SCANNING" ? <RefreshCw size={14} /> : <Check size={14} />} {selected.intakeStage === "QUEUED_FOR_SCAN" ? "Waiting to check file" : selected.intakeStage === "SCANNING" ? "Checking file safety" : "File safety confirmed"}</li>
                  <li className={selected.intakeStage === "EXTRACTING" || !selected.intakeStage ? "active" : selected.intakeStage === "ASSEMBLING" ? "done" : ""}>{selected.intakeStage === "EXTRACTING" || !selected.intakeStage ? <RefreshCw size={14} /> : selected.intakeStage === "ASSEMBLING" ? <Check size={14} /> : null} Reading invoice details</li>
                  <li className={selected.intakeStage === "ASSEMBLING" ? "active" : ""}>{selected.intakeStage === "ASSEMBLING" ? <RefreshCw size={14} /> : null} Preparing for review</li>
                </ol>
                {selected.intakeStage && onCancelIntake ? <button className="secondary-button finish-processing" type="button" disabled={commandPending} onClick={() => void cancelScan()}>{commandPending ? "Cancelling..." : "Cancel upload"}</button> : null}
                {!selected.intakeStage ? <button className="secondary-button finish-processing" type="button" onClick={completeProcessing}>Complete extraction</button> : null}
              </div>
            ) : null}
          </section>}
        </div>
      </main>

      {showApprove ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setShowApprove(false)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="approve-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="modal-icon"><FileCheck2 size={22} /></div>
            <h2 id="approve-title">Approve {selected?.origin.toLowerCase()} invoice?</h2>
            <p>{selected?.origin === "Generated" ? "This reserves the Official Invoice Number and queues final PDF compilation." : "This creates a Verified Invoice Record and records your approval in the audit history."}</p>
            <dl>
              <div><dt>Issuer</dt><dd>{selected?.issuer}</dd></div>
              <div><dt>{selected?.origin === "Generated" ? "Official number" : "Invoice number"}</dt><dd>{selected?.origin === "Generated" ? "Assigned on approval" : invoiceNumber}</dd></div>
              <div><dt>Total</dt><dd>{selected?.amount} USD</dd></div>
            </dl>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setShowApprove(false)}>Cancel</button>
              <button className="approve-button" type="button" disabled={commandPending} onClick={() => void approveInvoice()}><Check size={17} /> {commandPending ? "Approving..." : "Approve invoice"}</button>
            </div>
          </section>
        </div>
      ) : null}

      {showSettings ? <ApprovalPolicySettings policy={currentApprovalPolicy} canManage={workspaceRole === "TENANT_ADMIN"} onClose={() => setShowSettings(false)} {...(onPublishApprovalPolicy ? { onPublish: async (mode: ApprovalMode, rules: ApprovalPolicy["rules"]) => {
        const published = await onPublishApprovalPolicy(mode, rules);
        setCurrentApprovalPolicy(published);
        notify(`Approval policy version ${published.version} published`);
        return published;
      } } : {})} /> : null}

      {toast ? (
        <div className="toast" role="status">
          <CheckCircle2 size={17} /> {toast}
        </div>
      ) : null}
    </div>
  );
}

function humanizeQueueValue(value: string): string {
  const spaced = value.replace(/[-_]+/g, " ").trim();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : value;
}
