// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransactionWorkspace } from "../src/TransactionWorkspace.js";
import type { TransactionFile, TransactionLinkageProposal } from "../src/infrastructure/supabase/transactions.js";

afterEach(cleanup);

const noOp = vi.fn().mockResolvedValue(undefined);

describe("Transaction workspace", () => {
  it("creates a Transaction File from a clear empty state", async () => {
    const user = userEvent.setup();
    const create = vi.fn().mockResolvedValue(undefined);
    render(<TransactionWorkspace transactions={[]} transactionTypes={[{ id: "type-1", code: "PURCHASE", name: "Purchase" }]} ownerOptions={[{ userId: "user-1", role: "TENANT_ADMIN", label: "ajay@example.com (you)" }]} onClose={noOp} onCreate={create} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} />);
    await user.type(screen.getByLabelText("Property address"), "1847 Cypress Avenue");
    await user.type(screen.getByLabelText(/Internal reference/), "TX-1048");
    await user.selectOptions(screen.getByLabelText("Transaction type"), "type-1");
    await user.selectOptions(screen.getByLabelText("Assigned owner"), "user-1");
    await user.type(screen.getByLabelText("Primary party"), "Jamie Buyer");
    await user.click(screen.getByRole("button", { name: "Create file" }));
    expect(create).toHaveBeenCalledWith({ externalReference: "TX-1048", propertyAddress: "1847 Cypress Avenue", transactionTypeId: "type-1", ownerId: "user-1", primaryPartyName: "Jamie Buyer", primaryPartyKind: "PERSON", primaryPartyRole: "BUYER" });
  });

  it("uploads an outstanding document and keeps final review blocked until scanning finishes", async () => {
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1048", propertyAddress: "1847 Cypress Avenue", lifecycle: "ACCUMULATING", version: 1, updatedAt: "2026-09-23T00:00:00Z", requirements: [{ kind: "ARTIFACT", key: "purchase-agreement", status: "MISSING", confidence: null }] };
    const upload = vi.fn().mockResolvedValue(undefined);
    render(<TransactionWorkspace transactions={[transaction]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onUploadDocument={upload} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} />);
    expect(screen.getByText("1 item needs attention.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Ready for final review" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Upload document" }));
    const file = new File(["document"], "agreement.pdf", { type: "application/pdf" });
    await userEvent.upload(screen.getByLabelText("Choose transaction document"), file);
    expect(upload).toHaveBeenCalledWith(transaction, transaction.requirements[0], file);
    expect(await screen.findByText(/safety check is running/i)).toBeVisible();
    expect(screen.queryByLabelText("Purchase agreement status")).not.toBeInTheDocument();
  });

  it("shows upload progress immediately while the file request is still running", async () => {
    let finishUpload!: () => void;
    const upload = vi.fn().mockImplementation(() => new Promise<void>((resolve) => { finishUpload = resolve; }));
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1", propertyAddress: "1 Main Street", lifecycle: "ACCUMULATING", businessStage: "DOCUMENTS_PENDING", version: 1, updatedAt: "2026-09-24T00:00:00Z", requirements: [{ kind: "ARTIFACT", key: "closing-disclosure", status: "MISSING", confidence: null, stageGate: "BEFORE_REVIEW" }] };
    render(<TransactionWorkspace transactions={[transaction]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onUploadDocument={upload} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} />);

    expect(screen.getByText("PDF, JPG or PNG · Maximum 5 MB")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Upload document" }));
    await userEvent.upload(screen.getByLabelText("Choose transaction document"), new File(["pdf"], "closing.pdf", { type: "application/pdf" }));
    expect(screen.getByText("Uploading document")).toBeVisible();
    expect(screen.getByText("closing.pdf")).toBeVisible();
    const processingButton = screen.getByRole("button", { name: "Processing..." });
    expect(processingButton).toBeDisabled();
    expect(processingButton.querySelector(".lucide-loader-circle")).toBeInTheDocument();
    expect(screen.getByText("File uploaded · Safety check pending")).toBeVisible();
    finishUpload();
  });

  it("uses a distinct final approval action after convergence", () => {
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1048", propertyAddress: "1847 Cypress Avenue", lifecycle: "CONVERGED", version: 4, updatedAt: "2026-09-23T00:00:00Z", requirements: [{ kind: "ARTIFACT", key: "purchase-agreement", status: "PRESENT", confidence: 1 }] };
    render(<TransactionWorkspace transactions={[transaction]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} />);
    expect(screen.getByRole("button", { name: "Approve Transaction File" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve invoice" })).not.toBeInTheDocument();
  });

  it("explains why an upload cannot be linked before processing finishes", () => {
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1048", propertyAddress: "1847 Cypress Avenue", lifecycle: "ACCUMULATING", version: 1, updatedAt: "2026-09-23T00:00:00Z", requirements: [] };
    render(<TransactionWorkspace transactions={[transaction]} invoiceLinkMessage="The selected upload must finish processing before it can be linked." onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} />);
    expect(screen.getByText("No invoice is ready to link")).toBeVisible();
    expect(screen.getByText(/must finish processing/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Link selected invoice" })).not.toBeInTheDocument();
  });

  it("explains match suggestions and supports accept and reject decisions", async () => {
    const user = userEvent.setup();
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1048", propertyAddress: "1847 Cypress Avenue", lifecycle: "ACCUMULATING", version: 3, updatedAt: "2026-09-23T00:00:00Z", requirements: [] };
    const proposal: TransactionLinkageProposal = { id: "proposal-1", invoiceId: "invoice-1", transactionId: "tx-1", transactionVersion: 3, propertyAddress: transaction.propertyAddress, externalReference: transaction.externalReference, lifecycle: transaction.lifecycle, score: .94, reasons: [{ label: "Property address matches" }, { label: "Reference number matches" }], status: "PROPOSED" };
    const resolve = vi.fn().mockResolvedValue(undefined);
    render(<TransactionWorkspace transactions={[transaction]} selectedInvoice={{ id: "invoice-1", version: 2, label: "Northstar · INV-1001", linked: false }} linkageProposals={[proposal]} onClose={noOp} onCreate={noOp} onLink={noOp} onResolveProposal={resolve} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} />);
    expect(screen.getByText("94%")).toBeVisible();
    expect(screen.getByText("Property address matches")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Not a match" }));
    expect(resolve).toHaveBeenLastCalledWith(proposal, "REJECT");
    await user.click(screen.getByRole("button", { name: "Use this file" }));
    expect(resolve).toHaveBeenLastCalledWith(proposal, "ACCEPT");
  });

  it("prevents accepting a suggestion for an inactive Transaction File", () => {
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1048", propertyAddress: "1847 Cypress Avenue", lifecycle: "DORMANT", version: 3, updatedAt: "2026-09-23T00:00:00Z", requirements: [] };
    const proposal: TransactionLinkageProposal = { id: "proposal-1", invoiceId: "invoice-1", transactionId: "tx-1", transactionVersion: 3, propertyAddress: transaction.propertyAddress, externalReference: transaction.externalReference, lifecycle: transaction.lifecycle, score: .8, reasons: [{ label: "Property address resembles source" }], status: "PROPOSED" };
    render(<TransactionWorkspace transactions={[transaction]} selectedInvoice={{ id: "invoice-1", version: 2, label: "Northstar", linked: false }} linkageProposals={[proposal]} onClose={noOp} onCreate={noOp} onLink={noOp} onResolveProposal={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} />);
    expect(screen.getByRole("button", { name: "Use this file" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not a match" })).toBeEnabled();
  });

  it("does not treat an empty requirement set as complete or approvable", () => {
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1048", propertyAddress: "1847 Cypress Avenue", lifecycle: "CONVERGED", version: 4, updatedAt: "2026-09-23T00:00:00Z", requirements: [] };
    render(<TransactionWorkspace transactions={[transaction]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} />);
    expect(screen.getByText("Add at least one requirement before final review.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve Transaction File" })).not.toBeInTheDocument();
  });

  it("adds a transaction-specific requirement and displays structured details", async () => {
    const user = userEvent.setup();
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1048", propertyAddress: "1847 Cypress Avenue", transactionType: "Purchase", office: "Austin", keyDates: { closingDate: "2026-10-15" }, lifecycle: "APPROVED", version: 5, updatedAt: "2026-09-23T00:00:00Z", requirements: [{ kind: "FIELD", key: "buyer", status: "PRESENT", confidence: 1 }] };
    const add = vi.fn().mockResolvedValue(undefined);
    render(<TransactionWorkspace transactions={[transaction]} onClose={noOp} onCreate={noOp} onAddRequirement={add} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} />);
    expect(screen.getByText("Purchase")).toBeVisible();
    expect(screen.getByText("Austin")).toBeVisible();
    expect(screen.getByText("2026-10-15")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add requirement" }));
    await user.selectOptions(screen.getByLabelText("Requirement type"), "ARTIFACT");
    await user.type(screen.getByLabelText("Requirement name"), "Closing disclosure");
    await user.click(screen.getByRole("button", { name: "Add", exact: true }));
    expect(add).toHaveBeenCalledWith(transaction, { kind: "ARTIFACT", key: "Closing disclosure" });
  });

  it("uses the new deal stages and blocks review until Before Review items are complete", async () => {
    const begin = vi.fn().mockResolvedValue(undefined);
    const submit = vi.fn().mockResolvedValue(undefined);
    const draft: TransactionFile = { id: "tx-1", externalReference: "TX-1", propertyAddress: "1 Main Street", lifecycle: "ACCUMULATING", businessStage: "DRAFT", version: 1, updatedAt: "2026-09-23T00:00:00Z", requirements: [] };
    const { rerender } = render(<TransactionWorkspace transactions={[draft]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} onBeginWork={begin} onSubmitReview={submit} />);
    expect(screen.getAllByText("Draft").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Begin work" }));
    expect(begin).toHaveBeenCalledWith(draft);
    const pending: TransactionFile = { ...draft, businessStage: "DOCUMENTS_PENDING", version: 2, requirements: [{ kind: "ARTIFACT", key: "agreement", status: "MISSING", confidence: null, stageGate: "BEFORE_REVIEW", source: "TEMPLATE", templateMandated: true }] };
    rerender(<TransactionWorkspace transactions={[pending]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} onBeginWork={begin} onSubmitReview={submit} />);
    expect(screen.getByRole("button", { name: "Submit for review" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Approve Transaction File" })).not.toBeInTheDocument();
  });

  it("shows a stable submitted state and the reviewed requirements", () => {
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1", propertyAddress: "1 Main Street", lifecycle: "ACCUMULATING", businessStage: "UNDER_REVIEW", version: 4, updatedAt: "2026-09-23T00:00:00Z", requirements: [{ kind: "ARTIFACT", key: "purchase-agreement", status: "PRESENT", confidence: 1, stageGate: "BEFORE_REVIEW", source: "TEMPLATE", templateMandated: true }] };
    render(<TransactionWorkspace transactions={[transaction]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} onSubmitReview={noOp} />);
    expect(screen.getByText("Review submitted")).toBeVisible();
    expect(screen.getByText("Purchase agreement")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Submit for review" })).not.toBeInTheDocument();
  });

  it("shows a linked invoice and its accepted score only in the owning file", async () => {
    const user = userEvent.setup();
    const transactions: TransactionFile[] = [
      { id: "tx-1", externalReference: "TX-1048", propertyAddress: "1847 Cypress Avenue", lifecycle: "ACCUMULATING", version: 3, updatedAt: "2026-09-23T00:00:00Z", requirements: [{ kind: "FIELD", key: "buyer", status: "MISSING", confidence: null }] },
      { id: "tx-2", externalReference: "TX-1456", propertyAddress: "14 North California", lifecycle: "ACCUMULATING", version: 2, updatedAt: "2026-09-23T00:00:00Z", requirements: [{ kind: "FIELD", key: "buyer", status: "MISSING", confidence: null }] },
    ];
    const accepted: TransactionLinkageProposal = { id: "proposal-1", invoiceId: "invoice-1", transactionId: "tx-1", transactionVersion: 3, propertyAddress: transactions[0]!.propertyAddress, externalReference: transactions[0]!.externalReference, lifecycle: "ACCUMULATING", score: .94, reasons: [{ label: "Property address matches" }], status: "ACCEPTED" };
    render(<TransactionWorkspace transactions={transactions} selectedInvoice={{ id: "invoice-1", version: 3, label: "Northstar · INV-1001", linked: true, linkedTransactionId: "tx-1" }} linkageProposals={[accepted]} onClose={noOp} onCreate={noOp} onLink={noOp} onResolveProposal={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} />);
    expect(screen.getByText("Linked to this file")).toBeVisible();
    expect(screen.getByText("94%")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /14 North California/ }));
    expect(screen.queryByText("Linked to this file")).not.toBeInTheDocument();
    expect(screen.queryByText("94%")).not.toBeInTheDocument();
  });

  it("adds parties, important dates, and financial entries with clear confirmation", async () => {
    const user = userEvent.setup();
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1", propertyAddress: "1 Main Street", lifecycle: "ACCUMULATING", businessStage: "DOCUMENTS_PENDING", version: 4, updatedAt: "2026-09-23T00:00:00Z", parties: [], importantDates: [], financials: [], requirements: [] };
    const addParty = vi.fn().mockResolvedValue(undefined);
    const setDate = vi.fn().mockResolvedValue(undefined);
    const setFinancial = vi.fn().mockResolvedValue(undefined);
    render(<TransactionWorkspace transactions={[transaction]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} onAddParty={addParty} onSetDate={setDate} onSetFinancial={setFinancial} />);

    await user.click(screen.getByRole("button", { name: "Add party" }));
    await user.type(screen.getByLabelText("Name"), "North Title Co");
    await user.selectOptions(screen.getByLabelText("Role"), "TITLE_ESCROW");
    await user.click(screen.getByRole("button", { name: "Add", exact: true }));
    expect(addParty).toHaveBeenCalledWith(transaction, { name: "North Title Co", kind: "PERSON", role: "TITLE_ESCROW", primary: false });
    expect(await screen.findByText("Party added.")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Add date" }));
    await user.selectOptions(screen.getByLabelText("Date type"), "CLOSING");
    await user.type(screen.getByLabelText("Date", { exact: true }), "2030-06-15");
    await user.click(screen.getByRole("button", { name: "Save", exact: true }));
    expect(setDate).toHaveBeenCalledWith(transaction, { kind: "CLOSING", date: "2030-06-15" });

    await user.click(screen.getByRole("button", { name: "Add financial" }));
    await user.type(screen.getByLabelText("Label"), "Purchase price");
    await user.type(screen.getByLabelText("Amount"), "425000.50");
    await user.click(screen.getByRole("button", { name: "Save", exact: true }));
    expect(setFinancial).toHaveBeenCalledWith(transaction, { kind: "DEAL_VALUE", label: "Purchase price", amount: 425000.5, currency: "USD" });
    expect(await screen.findByText("Financial entry saved.")).toBeVisible();
  });

  it("creates typed information fields, saves values, and blocks review while required data is missing", async () => {
    const user = userEvent.setup();
    const addCustomField = vi.fn().mockResolvedValue(undefined);
    const setCustomFieldValue = vi.fn().mockResolvedValue(undefined);
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1", propertyAddress: "1 Main Street", lifecycle: "ACCUMULATING", businessStage: "DOCUMENTS_PENDING", version: 3, updatedAt: "2026-09-23T00:00:00Z", requirements: [], customFields: [{ id: "field-1", key: "lease_term", label: "Lease term", dataType: "NUMBER", required: true, stageGate: "BEFORE_REVIEW", validation: {} }] };
    render(<TransactionWorkspace transactions={[transaction]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} onSubmitReview={noOp} onAddCustomField={addCustomField} onSetCustomFieldValue={setCustomFieldValue} />);
    expect(screen.getByRole("button", { name: "Submit for review" })).toBeDisabled();
    await user.type(screen.getByLabelText("Lease term"), "24");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(setCustomFieldValue).toHaveBeenCalledWith(transaction, transaction.customFields![0], 24);
    expect(await screen.findByText("Lease term saved.")).toBeVisible();
    await user.click(screen.getAllByRole("button", { name: "Add field" }).at(-1)!);
    await user.type(screen.getByLabelText("Field name"), "Financing reference");
    await user.selectOptions(screen.getByLabelText("Type"), "TEXT");
    await user.click(screen.getAllByRole("button", { name: "Add field" }).at(-1)!);
    expect(addCustomField).toHaveBeenCalledWith(transaction, { key: "financing_reference", label: "Financing reference", dataType: "TEXT", required: true, stageGate: "BEFORE_REVIEW" });
  });

  it("captures the actual value for required information instead of only changing its status", async () => {
    const user = userEvent.setup();
    const saveValue = vi.fn().mockResolvedValue(undefined);
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1", propertyAddress: "1 Main Street", lifecycle: "ACCUMULATING", businessStage: "DOCUMENTS_PENDING", version: 3, updatedAt: "2026-09-24T00:00:00Z", requirements: [{ kind: "FIELD", key: "property-first-owner", status: "MISSING", confidence: null, stageGate: "BEFORE_REVIEW" }] };
    render(<TransactionWorkspace transactions={[transaction]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} onSetRequirementValue={saveValue} />);
    await user.click(screen.getAllByRole("button", { name: "Enter information" })[0]!);
    expect(screen.getByRole("dialog", { name: "Property first owner" })).toBeVisible();
    await user.type(screen.getByLabelText("Property first owner information"), "Jordan Lee");
    await user.click(screen.getByRole("button", { name: "Save information" }));
    expect(saveValue).toHaveBeenCalledWith(transaction, transaction.requirements[0], "Jordan Lee");
    expect(await screen.findByText("Property first owner saved.")).toBeVisible();
  });

  it("shows completed requirement values in Required information", () => {
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1", propertyAddress: "1 Main Street", lifecycle: "ACCUMULATING", businessStage: "DOCUMENTS_PENDING", version: 4, updatedAt: "2026-09-24T00:00:00Z", requirements: [{ kind: "FIELD", key: "property-first-owner", status: "PRESENT", confidence: 1, value: "Jordan Lee", stageGate: "BEFORE_REVIEW" }], customFields: [] };
    render(<TransactionWorkspace transactions={[transaction]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} onSetRequirementValue={noOp} />);

    const section = screen.getByRole("region", { name: "Required information" });
    expect(section).toHaveTextContent("Property first owner");
    expect(section).toHaveTextContent("Jordan Lee");
    expect(section).toHaveTextContent("Complete");
  });

  it("reviews uploaded documents and requires a rejection reason", async () => {
    const user = userEvent.setup();
    const review = vi.fn().mockResolvedValue(undefined);
    const document = { id: "doc-1", name: "Closing disclosure", requirementKey: "closing-disclosure", required: true, stageGate: "BEFORE_REVIEW" as const, versionId: "version-1", version: 1, fileName: "closing.pdf", uploadedAt: "2026-09-24T00:00:00Z", expiresOn: null, status: "RECEIVED" as const, decisionReason: null };
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1", propertyAddress: "1 Main Street", lifecycle: "ACCUMULATING", businessStage: "UNDER_REVIEW", version: 3, updatedAt: "2026-09-24T00:00:00Z", requirements: [{ kind: "ARTIFACT", key: "closing-disclosure", status: "PRESENT", confidence: 1, stageGate: "BEFORE_REVIEW" }], documents: [document] };
    render(<TransactionWorkspace transactions={[transaction]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} onReviewDocument={review} />);
    expect(screen.getByText("closing.pdf · Version 1")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    const reason = screen.getByLabelText("Rejection reason");
    expect(reason).toBeRequired();
    await user.type(reason, "Signature page is missing");
    await user.click(screen.getByRole("button", { name: "Reject document" }));
    expect(review).toHaveBeenCalledWith(transaction, document, "REJECTED", "Signature page is missing");
  });

  it("keeps a staged document visible while its safety check is pending", () => {
    const transaction: TransactionFile = { id: "tx-1", externalReference: "TX-1", propertyAddress: "1 Main Street", lifecycle: "ACCUMULATING", businessStage: "DOCUMENTS_PENDING", version: 3, updatedAt: "2026-09-24T00:00:00Z", requirements: [{ kind: "ARTIFACT", key: "closing-disclosure", status: "MISSING", confidence: null, stageGate: "BEFORE_REVIEW" }], pendingDocumentUploads: [{ id: "intent-1", ingestionEventId: "event-1", requirementKey: "closing-disclosure", documentName: "Closing disclosure", status: "WAITING_FOR_SCAN", safetyStatus: "PENDING", processingStatus: "QUEUED", failureReason: null, createdAt: "2026-09-24T00:00:00Z" }] };
    render(<TransactionWorkspace transactions={[transaction]} onClose={noOp} onCreate={noOp} onLink={noOp} onRequirement={noOp} onEvaluate={noOp} onApprove={noOp} onReactivate={noOp} />);
    expect(screen.getByText("Safety check pending")).toBeVisible();
    expect(screen.getAllByText("Closing disclosure").length).toBeGreaterThan(0);
  });

  it("shows upload by default and restores it after cancelling a pending document", async () => {
    const user = userEvent.setup();
    const requirement = { kind: "ARTIFACT" as const, key: "closing-disclosure", status: "MISSING" as const, confidence: null, stageGate: "BEFORE_REVIEW" as const };
    const base: TransactionFile = { id: "tx-1", externalReference: "TX-1", propertyAddress: "1 Main Street", lifecycle: "ACCUMULATING", businessStage: "DOCUMENTS_PENDING", version: 3, updatedAt: "2026-09-24T00:00:00Z", requirements: [requirement], pendingDocumentUploads: [] };
    const cancel = vi.fn().mockResolvedValue(undefined);
    const props = { onClose: noOp, onCreate: noOp, onLink: noOp, onRequirement: noOp, onEvaluate: noOp, onApprove: noOp, onReactivate: noOp, onUploadDocument: noOp, onCancelDocumentUpload: cancel };
    const { rerender } = render(<TransactionWorkspace transactions={[base]} {...props} />);

    expect(screen.getByRole("button", { name: "Upload document" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Cancel upload" })).not.toBeInTheDocument();

    const pending = { ...base, pendingDocumentUploads: [{ id: "intent-1", ingestionEventId: "event-1", requirementKey: requirement.key, documentName: "Closing disclosure", status: "WAITING_FOR_SCAN" as const, safetyStatus: "PENDING" as const, processingStatus: "QUEUED" as const, failureReason: null, createdAt: "2026-09-24T00:00:00Z" }] };
    rerender(<TransactionWorkspace transactions={[pending]} {...props} />);
    await user.click(screen.getByRole("button", { name: "Cancel upload" }));
    expect(cancel).toHaveBeenCalledWith(pending, "event-1");

    rerender(<TransactionWorkspace transactions={[base]} {...props} />);
    expect(screen.getByRole("button", { name: "Upload document" })).toBeEnabled();
    expect(screen.queryByText("Processing...")).not.toBeInTheDocument();
  });
});
