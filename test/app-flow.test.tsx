// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, type InvoiceDraft, type QueueItem } from "../src/App.js";
import { EmptyWorkspace } from "../src/AuthenticatedApp.js";

afterEach(cleanup);

describe("Sprint 1 review flow", () => {
  it("blocks approval until the required invoice number is resolved", async () => {
    const user = userEvent.setup();
    render(<App />);

    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "1 blocker before approval",
    );

    await user.type(screen.getByLabelText(/Invoice number/), "NS-2026-1847");
    expect(approve).toBeEnabled();
    expect(screen.getByText("Validation passed")).toBeVisible();

    await user.click(approve);
    expect(
      screen.getByRole("dialog", { name: "Approve captured invoice?" }),
    ).toBeVisible();
    expect(screen.getByText("NS-2026-1847")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Approve invoice" }));
    expect(screen.getByRole("button", { name: "Verified" })).toBeDisabled();
    expect(
      screen.getByText("Invoice verified and audit event recorded"),
    ).toBeVisible();
  });

  it("filters the work queue and toggles source evidence", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(screen.getByPlaceholderText("Search work"), "Apex");
    expect(screen.getByText("Apex Title Services")).toBeVisible();
    expect(screen.queryByText("Stonebridge Appraisal")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide source" }));
    expect(screen.queryByLabelText("Source invoice preview")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show source" }));
    expect(screen.getByLabelText("Source invoice preview")).toBeVisible();
  });

  it("keeps processing and quarantine behavior distinct from review", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "All" }));
    await user.click(screen.getByRole("button", { name: /Stonebridge Appraisal/ }));
    expect(screen.getByRole("heading", { name: "Reading invoice details" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /Unrecognized upload/ }));
    expect(screen.getByText("File not recognized")).toBeVisible();
    expect(screen.queryByLabelText("Source invoice preview")).not.toBeInTheDocument();
    expect(screen.queryByText("Invoice details")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verified", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Replace file/ })).toBeVisible();
  });

  it("edits extracted data and recalculates the invoice total", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.clear(screen.getByLabelText("Quantity"));
    await user.type(screen.getByLabelText("Quantity"), "2");
    await user.clear(screen.getByLabelText("Rate"));
    await user.type(screen.getByLabelText("Rate"), "250");

    expect(screen.getAllByText("$500.00").length).toBeGreaterThan(1);
    const issuer = screen.getByRole("textbox", { name: /Issuer/ });
    await user.clear(issuer);
    await user.type(issuer, "Northstar Inspections LLC");
    expect(screen.getByDisplayValue("Northstar Inspections LLC")).toBeVisible();
  });

  it("supports assignment and archive navigation", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.click(screen.getByRole("button", { name: "Unassign from me" }));
    expect(screen.getByText("Invoice unassigned")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Archive" }));
    expect(screen.getByText("Summit Photography")).toBeVisible();
    expect(screen.queryByText("Apex Title Services")).not.toBeInTheDocument();
  });

  it("dismisses the invoice actions menu when clicking elsewhere or pressing Escape", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "More actions" }));
    expect(screen.getByRole("button", { name: "Unassign from me" })).toBeVisible();
    await user.click(screen.getByRole("heading", { name: "Review queue" }));
    expect(screen.queryByRole("button", { name: "Unassign from me" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "More actions" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Unassign from me" })).not.toBeInTheDocument();
  });

  it("maps every confidence control to its matching source region", async () => {
    const user = userEvent.setup();
    render(<App />);
    for (const [label, sourceName] of [["Issuer", "Issuer source"], ["Bill-to party", "Bill-to party source"], ["Currency", "Currency source"], ["Invoice date", "Invoice date source"]] as const) {
      await user.click(screen.getByRole("button", { name: `Inspect source for ${label}` }));
      expect(screen.getByLabelText(sourceName)).toHaveClass("source-highlight");
    }
  });

  it("can complete a processing record into a review draft", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "All" }));
    await user.click(screen.getByRole("button", { name: /Stonebridge Appraisal/ }));
    await user.click(screen.getByRole("button", { name: "Complete extraction" }));

    expect(screen.queryByRole("heading", { name: "Reading invoice details" })).not.toBeInTheDocument();
    expect(screen.getByText("Validation passed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("assembles and verifies a generated invoice from multiple evidence artifacts", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: /Harborlight Staging/ }));
    expect(screen.getByLabelText("Supporting evidence")).toBeVisible();
    expect(screen.getByText("Across 2 email threads")).toBeVisible();
    expect(screen.getByLabelText("Official invoice number")).toHaveValue("Assigned at verification");

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("dialog", { name: "Approve generated invoice?" })).toBeVisible();
    expect(screen.getByText("Assigned on approval")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Approve invoice" }));

    expect(screen.getByLabelText("Official invoice number")).toHaveValue("CLI-2026-0001");
    expect(screen.getByText(/PDF compilation queued/)).toBeVisible();
  });

  it("exposes account identity and signs out from the user menu", async () => {
    const user = userEvent.setup();
    let signedOut = false;
    render(<App workspaceName="Cedar Lane Realty" userEmail="reviewer@example.com" onSignOut={() => { signedOut = true; }} />);

    await user.click(screen.getByRole("button", { name: "User menu" }));
    expect(screen.getByText("reviewer@example.com")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signedOut).toBe(true);
  });

  it("dismisses the account menu when clicking elsewhere or pressing Escape", async () => {
    const user = userEvent.setup();
    render(<App userEmail="reviewer@example.com" onSignOut={() => undefined} />);

    await user.click(screen.getByRole("button", { name: "User menu" }));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeVisible();
    await user.click(screen.getByRole("heading", { name: "Review queue" }));
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "User menu" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Sign out" })).not.toBeInTheDocument();
  });

  it("keeps the account control mounted across every primary navigation view", async () => {
    const user = userEvent.setup();
    render(<App onSignOut={() => undefined} />);

    for (const destination of ["Invoices", "Transaction Files", "Archive", "Work queue"]) {
      await user.click(screen.getByRole("button", { name: destination }));
      expect(screen.getByRole("button", { name: "User menu" })).toBeVisible();
    }
  });

  it("lets a tenant administrator publish a conditional approval policy", async () => {
    const user = userEvent.setup();
    const publish = vi.fn().mockResolvedValue({ id: "policy-2", version: 2, mode: "CONDITIONAL", rules: { reviewWhen: { operator: "OR", conditions: [{ type: "TOTAL_ABOVE", value: 2500 }] } }, publishedAt: "2026-09-22T12:00:00Z" });
    render(<App workspaceRole="TENANT_ADMIN" approvalPolicy={{ id: "policy-1", version: 1, mode: "MANDATORY", rules: {}, publishedAt: "2026-09-21T12:00:00Z" }} onPublishApprovalPolicy={publish} />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("radio", { name: /Review by condition/ }));
    const amount = screen.getByRole("spinbutton", { name: "Amount 1" });
    await user.clear(amount);
    await user.type(amount, "2500");
    await user.click(screen.getByRole("button", { name: "Publish policy" }));

    expect(publish).toHaveBeenCalledWith("CONDITIONAL", { reviewWhen: { operator: "OR", conditions: [{ type: "TOTAL_ABOVE", value: 2500 }] } });
    expect(screen.getByText("Approval policy version 2 published")).toBeVisible();
  });

  it("shows approval policy settings as read-only to reviewers", async () => {
    const user = userEvent.setup();
    render(<App workspaceRole="REVIEWER" approvalPolicy={{ id: "policy-1", version: 1, mode: "MANDATORY", rules: {}, publishedAt: "2026-09-21T12:00:00Z" }} />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByText("Only Tenant Administrators can publish approval policies.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Publish policy" })).not.toBeInTheDocument();
  });

  it("opens approval policy settings from an empty workspace", async () => {
    const user = userEvent.setup();
    render(<EmptyWorkspace workspaceName="Cedar Lane Realty" intakeMessage={null} onUpload={vi.fn()} onSignOut={vi.fn()} role="TENANT_ADMIN" approvalPolicy={null} onPublish={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Approval policy" }));
    expect(screen.getByRole("dialog", { name: "Approval policy" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish policy" })).toBeVisible();
  });

  it("persists database-backed edits before invoking verification", async () => {
    const user = userEvent.setup();
    const item: QueueItem = { id: "00000000-0000-4000-8000-000000000031", issuer: "Northstar", reference: "Standalone invoice", amount: "$486.00", age: "Today", status: "Ready to review", origin: "Captured", linked: false, description: "Inspection", assignedToMe: true, databaseVersion: 1 };
    const draft: InvoiceDraft = { invoiceNumber: "", date: "2026-09-18", issuer: "Northstar", billTo: "Cedar Lane", currency: "USD", description: "Inspection", quantity: "1", rate: "486" };
    const persist = vi.fn().mockResolvedValue(2);
    const verify = vi.fn().mockResolvedValue("record-id");
    render(<App initialQueueItems={[item]} initialInvoiceDrafts={{ [item.id]: draft }} onPersistField={persist} onVerify={verify} />);

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    await user.type(screen.getByLabelText(/Invoice number/), "SRC-100");
    await user.tab();
    expect(persist).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1, field: "invoiceNumber", value: "SRC-100" }));
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await user.click(screen.getByRole("button", { name: "Approve invoice" }));
    expect(verify).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 2, origin: "Captured" }));
  });

  it("does not claim extraction has started for a queued intake receipt", () => {
    const receipt: QueueItem = { id: "intake-1", issuer: "invoice.pdf", reference: "Manual upload · awaiting recognition", amount: "—", age: "Today", status: "Processing", origin: "Captured", linked: false, description: "Recognition pending", assignedToMe: true, intakeStage: "QUEUED_FOR_SCAN" };
    render(<App initialQueueItems={[receipt]} initialInvoiceDrafts={{ [receipt.id]: { invoiceNumber: "", date: "", issuer: "invoice.pdf", billTo: "", currency: "USD", description: "", quantity: "1", rate: "0" } }} />);

    expect(screen.getByRole("heading", { name: "Waiting to process your invoice" })).toBeVisible();
    expect(screen.getByText("Waiting to check file")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Reading invoice details" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete extraction" })).not.toBeInTheDocument();
  });

  it("reports an unclaimed safety job instead of presenting an infinite active scan", () => {
    const receipt: QueueItem = { id: "intake-stalled", issuer: "invoice.pdf", reference: "Manual upload · awaiting recognition", amount: "—", age: "Today", status: "Processing", origin: "Captured", linked: false, description: "Recognition pending", assignedToMe: true, intakeStage: "QUEUED_FOR_SCAN", intakeReceivedAt: "2020-01-01T00:00:00.000Z" };
    render(<App initialQueueItems={[receipt]} initialInvoiceDrafts={{ [receipt.id]: { invoiceNumber: "", date: "", issuer: "invoice.pdf", billTo: "", currency: "USD", description: "", quantity: "1", rate: "0" } }} />);
    expect(screen.getByRole("heading", { name: "Processing is taking longer than usual" })).toBeVisible();
    expect(screen.getByText(/Your file is safely uploaded/)).toBeVisible();
    expect(screen.getByText(/Only cancel if you uploaded the wrong file/)).toBeVisible();
  });

  it("cancels a persisted intake scan through its command callback", async () => {
    const user = userEvent.setup();
    const cancel = vi.fn().mockResolvedValue(undefined);
    const receipt: QueueItem = { id: "intake-1", ingestionEventId: "event-1", issuer: "invoice.pdf", reference: "Manual upload · awaiting recognition", amount: "—", age: "Today", status: "Processing", origin: "Captured", linked: false, description: "Recognition pending", assignedToMe: true, intakeStage: "QUEUED_FOR_SCAN" };
    render(<App initialQueueItems={[receipt]} initialInvoiceDrafts={{ [receipt.id]: { invoiceNumber: "", date: "", issuer: "invoice.pdf", billTo: "", currency: "USD", description: "", quantity: "1", rate: "0" } }} onCancelIntake={cancel} />);

    await user.click(screen.getByRole("button", { name: "Cancel upload" }));
    expect(cancel).toHaveBeenCalledWith("event-1");
    expect(screen.getByText("Upload cancelled")).toBeVisible();
  });
});
