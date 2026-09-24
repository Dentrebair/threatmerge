import { AlertTriangle, Plus, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApprovalCondition, ApprovalMode, ApprovalPolicy } from "./infrastructure/supabase/approval-policies.js";

interface Props {
  policy: ApprovalPolicy | null;
  canManage: boolean;
  onClose: () => void;
  onPublish?: (mode: ApprovalMode, rules: ApprovalPolicy["rules"]) => Promise<ApprovalPolicy>;
}

const labels: Record<ApprovalMode, { title: string; detail: string }> = {
  MANDATORY: { title: "Review every invoice", detail: "Every valid invoice waits for a reviewer." },
  CONDITIONAL: { title: "Review by condition", detail: "Matching invoices wait for review; others may verify automatically." },
  AUTOMATIC: { title: "Automatic verification", detail: "Eligible valid invoices verify without review." },
};

export function ApprovalPolicySettings({ policy, canManage, onClose, onPublish }: Props) {
  const [mode, setMode] = useState<ApprovalMode>(policy?.mode ?? "MANDATORY");
  const [operator, setOperator] = useState<"AND" | "OR">(policy?.rules.reviewWhen?.operator ?? "OR");
  const [conditions, setConditions] = useState<ApprovalCondition[]>(policy?.rules.reviewWhen?.conditions ?? [{ type: "TOTAL_ABOVE", value: 1000 }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function close(event: KeyboardEvent) { if (event.key === "Escape") onClose(); }
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [onClose]);

  function replaceCondition(index: number, next: ApprovalCondition) {
    setConditions((current) => current.map((condition, position) => position === index ? next : condition));
  }

  async function publish() {
    if (!onPublish) return;
    setSaving(true); setError(null);
    try {
      await onPublish(mode, mode === "CONDITIONAL" ? { reviewWhen: { operator, conditions } } : {});
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to publish approval policy");
    } finally { setSaving(false); }
  }

  return <div className="settings-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="policy-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><h2 id="policy-title">Approval policy</h2><p>Applies only to invoices that enter processing after publication.</p></div><button className="icon-button" type="button" aria-label="Close settings" onClick={onClose}><X size={18} /></button></header>
      <div className="settings-scroll">
        <div className="policy-version"><span>Current policy</span><strong>{policy ? `Version ${policy.version}` : "Not configured"}</strong></div>
        <fieldset className="policy-modes" disabled={!canManage || saving}><legend>Review mode</legend>
          {(Object.keys(labels) as ApprovalMode[]).map((value) => <label key={value} className={mode === value ? "selected" : ""}>
            <input type="radio" name="approval-mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
            <span><strong>{labels[value].title}</strong><small>{labels[value].detail}</small></span>
          </label>)}
        </fieldset>

        {mode === "CONDITIONAL" ? <section className="condition-builder"><div className="condition-heading"><div><h3>Review conditions</h3><p>Choose whether any or all conditions must match.</p></div><div className="condition-operator" aria-label="Condition matching"><button type="button" className={operator === "OR" ? "selected" : ""} disabled={!canManage} onClick={() => setOperator("OR")}>Any</button><button type="button" className={operator === "AND" ? "selected" : ""} disabled={!canManage} onClick={() => setOperator("AND")}>All</button></div></div>
          <div className="condition-list">{conditions.map((condition, index) => <div className="condition-row" key={index}>
            <select aria-label={`Condition ${index + 1}`} disabled={!canManage} value={condition.type} onChange={(event) => {
              const type = event.target.value as ApprovalCondition["type"];
              replaceCondition(index, type === "NEW_ISSUER" ? { type } : type === "ORIGIN" ? { type, value: "CAPTURED" } : { type, value: type === "LOW_CONFIDENCE" ? 0.8 : 1000 });
            }}>
              <option value="TOTAL_ABOVE">Total above</option><option value="NEW_ISSUER">New invoice party</option><option value="LOW_CONFIDENCE">Confidence below</option><option value="ORIGIN">Invoice origin</option>
            </select>
            {condition.type === "TOTAL_ABOVE" ? <input aria-label={`Amount ${index + 1}`} disabled={!canManage} type="number" min="0" step="0.01" value={condition.value} onChange={(event) => replaceCondition(index, { type: "TOTAL_ABOVE", value: Number(event.target.value) })} /> : null}
            {condition.type === "LOW_CONFIDENCE" ? <input aria-label={`Confidence ${index + 1}`} disabled={!canManage} type="number" min="0" max="1" step="0.01" value={condition.value} onChange={(event) => replaceCondition(index, { type: "LOW_CONFIDENCE", value: Number(event.target.value) })} /> : null}
            {condition.type === "ORIGIN" ? <select aria-label={`Origin ${index + 1}`} disabled={!canManage} value={condition.value} onChange={(event) => replaceCondition(index, { type: "ORIGIN", value: event.target.value as "CAPTURED" | "GENERATED" })}><option value="CAPTURED">Captured</option><option value="GENERATED">Generated</option></select> : null}
            <button className="icon-button" type="button" title="Remove condition" aria-label={`Remove condition ${index + 1}`} disabled={!canManage || conditions.length === 1} onClick={() => setConditions((current) => current.filter((_, position) => position !== index))}><Trash2 size={15} /></button>
          </div>)}</div>
          <button className="add-condition" type="button" disabled={!canManage || conditions.length >= 20} onClick={() => setConditions((current) => [...current, { type: "TOTAL_ABOVE", value: 1000 }])}><Plus size={15} /> Add condition</button>
        </section> : null}

        {mode === "AUTOMATIC" || mode === "CONDITIONAL" ? <div className="automation-notice"><AlertTriangle size={18} /><div><strong>Automation remains eligibility-gated</strong><span>Invoices without an approved matching extraction profile are routed to human review.</span></div></div> : null}
        {!canManage ? <div className="read-only-notice">Only Tenant Administrators can publish approval policies.</div> : null}
        {error ? <div className="auth-error" role="alert">{error}</div> : null}
      </div>
      <footer><button className="secondary-button" type="button" onClick={onClose}>Cancel</button>{canManage ? <button className="approve-button" type="button" disabled={saving || (mode === "CONDITIONAL" && conditions.length === 0)} onClick={() => void publish()}><Save size={16} /> {saving ? "Publishing..." : "Publish policy"}</button> : null}</footer>
    </section>
  </div>;
}
