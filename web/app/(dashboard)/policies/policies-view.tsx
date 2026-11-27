"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiBrowser } from "@/lib/client";
import type { Decision, Policy, PolicyRule, Severity } from "@/lib/types";
import { EmptyState, ErrorState, formatDate, label, LoadingState, PageHeader, shortId, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/icon";

const fileTypes = ["txt", "csv", "json", "xml", "yaml", "yml", "log", "env", "sql", "py", "js", "ts", "go", "rs"];
const availableTags = [
  "credential", "private_key", "pii", "financial", "environment:env",
  "identity:id:nik", "identity:us:ssn", "identity:ca:sin", "identity:gb:ni_number", "identity:in:pan", "identity:in:aadhaar"
];

function uuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function newRule(priority: number): PolicyRule {
  return { id: uuid(), name: "", enabled: true, priority, action: "block", categories: [], min_severity: "high", providers: [], tags: [] };
}

export function PoliciesView() {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [failureMode, setFailureMode] = useState<"block" | "audit">("block");
  const [allowedFileTypes, setAllowedFileTypes] = useState<string[]>(fileTypes);
  const [tags, setTags] = useState<string[]>(availableTags.slice(0, 5));
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<Policy | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setPolicies((await apiBrowser<{ policies: Policy[] }>("/v1/policies")).policies); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load policies"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (editorOpen) document.getElementById("policy-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [editorOpen]);

  function openEditor(current?: Policy) {
    setEditing(current ?? null);
    setFailureMode(current?.failure_mode ?? "block");
    setAllowedFileTypes(current?.allowed_file_types?.length ? current.allowed_file_types : fileTypes);
    setTags(current?.tags?.length ? current.tags : availableTags.slice(0, 5));
    setRules(current ? current.rules.map((rule) => ({ ...rule, id: uuid(), tags: rule.tags ?? [] })) : [
      { ...newRule(10), name: "Block credentials", categories: ["credential", "private_key"], min_severity: "high" },
      { ...newRule(20), name: "Audit personal and financial data", action: "audit", categories: ["pii", "financial"], min_severity: "medium" },
      { ...newRule(1000), name: "Allow complete inspection", action: "allow", min_severity: "low" }
    ]);
    setEditorOpen(true); setError(""); setNotice("");
  }
  function updateRule<K extends keyof PolicyRule>(index: number, key: K, value: PolicyRule[K]) {
    setRules((current) => current.map((rule, position) => position === index ? { ...rule, [key]: value } : rule));
  }
  function csv(value: string) { return value.split(",").map((part) => part.trim().toLowerCase()).filter(Boolean); }

  async function savePolicy(event: FormEvent) {
    event.preventDefault(); setPending(true); setError(""); setNotice("");
    if (!rules.length || rules.some((rule) => !rule.name.trim())) { setError("Every rule needs a name."); setPending(false); return; }
    if (!allowedFileTypes.length) { setError("Select at least one supported file type."); setPending(false); return; }
    if (new Set(rules.map((rule) => rule.priority)).size !== rules.length) { setError("Rule priorities must be unique so evaluation is deterministic."); setPending(false); return; }
    const policy: Policy = { version: uuid(), generated_at: new Date().toISOString(), failure_mode: failureMode, allowed_file_types: allowedFileTypes, tags, rules: rules.map((rule) => ({ ...rule, name: rule.name.trim() })) };
    try {
      await apiBrowser<Policy>("/v1/policies", { method: "POST", body: JSON.stringify(policy) });
      setNotice(`Policy ${shortId(policy.version)} ${editing ? "saved as a new version" : "created"}. Assign it to devices from the Devices page.`);
      setEditorOpen(false); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save policy"); }
    finally { setPending(false); }
  }

  async function deletePolicy(policy: Policy) {
    if (!window.confirm(`Delete policy ${shortId(policy.version)}? Policies assigned to devices or referenced by activity cannot be deleted.`)) return;
    setError(""); setNotice("");
    try { await apiBrowser(`/v1/policies/${policy.version}`, { method: "DELETE" }); setNotice(`Policy ${shortId(policy.version)} deleted.`); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete policy"); }
  }

  return <><PageHeader eyebrow="Protection configuration" title="Policies" description="Build versioned controls for supported files and sensitive data labels. Assign each version to the devices that should use it." action={<button type="button" className="button button--primary" onClick={() => openEditor()}><Icon name="plus" size={18} />New policy version</button>} />
    {notice && <div className="success-banner" role="status"><Icon name="check" size={19} />{notice}</div>}
    {error && !editorOpen && <ErrorState message={error} retry={load} />}
    {editorOpen && <section id="policy-editor" className="panel policy-editor"><div className="panel-header"><div><h2>{editing ? `Edit ${shortId(editing.version)} as new version` : "New policy version"}</h2><p>Saving creates an immutable version. Existing devices keep their assignment until you change it.</p></div><button type="button" className="icon-button" onClick={() => setEditorOpen(false)} aria-label="Close policy editor">×</button></div>
      <form onSubmit={savePolicy}>
        <div className="policy-settings">
          <div className="field"><label htmlFor="failure-mode">Failure mode</label><select id="failure-mode" value={failureMode} onChange={(event) => setFailureMode(event.target.value as "block" | "audit")}><option value="block">Block failed or incomplete inspection</option><option value="audit">Audit failed or incomplete inspection</option></select><p className="field-help">Unsupported or incomplete content follows this setting.</p></div>
          <div className="field"><label>File types allowed for inspection</label><div className="readiness">{fileTypes.map((extension) => <label key={extension}><input type="checkbox" checked={allowedFileTypes.includes(extension)} onChange={(event) => setAllowedFileTypes((current) => event.target.checked ? [...current, extension] : current.filter((value) => value !== extension))} /> .{extension}</label>)}</div><p className="field-help">These are the text formats currently supported by the Agent. Other files follow the failure mode.</p></div>
          <div className="field"><label>Sensitive data tags</label><div className="readiness">{availableTags.map((tag) => <label key={tag}><input type="checkbox" checked={tags.includes(tag)} onChange={(event) => setTags((current) => event.target.checked ? [...current, tag] : current.filter((value) => value !== tag))} /> {tag}</label>)}</div><p className="field-help">Current contextual identity detectors cover Indonesia NIK, US SSN, Canada SIN, UK NI number and India PAN/Aadhaar. Coverage is limited and does not include every national document.</p></div>
          <div className="precedence-note"><span>Priority order</span><strong>Lowest number wins</strong><p>Only enabled rules participate. Empty provider and category lists match all.</p></div>
        </div>
        <div className="rule-editor-head"><h3>Rules</h3><button className="button button--secondary" type="button" onClick={() => setRules((current) => [...current, newRule(current.length ? Math.max(...current.map((rule) => rule.priority)) + 10 : 10)])}><Icon name="plus" size={16} />Add rule</button></div>
        <div className="rule-list">{rules.map((rule, index) => <fieldset className="rule-editor" key={rule.id}><legend className="sr-only">Rule {index + 1}</legend><div className="rule-title"><label className="toggle"><input type="checkbox" checked={rule.enabled} onChange={(event) => updateRule(index, "enabled", event.target.checked)} /><span aria-hidden="true" /><span>{rule.enabled ? "Enabled" : "Disabled"}</span></label><span className="rule-number">Rule {index + 1}</span><button className="danger-button" type="button" onClick={() => setRules((current) => current.filter((_, position) => position !== index))} disabled={rules.length === 1}>Remove rule</button></div>
          <div className="rule-grid">
            <div className="field field--wide"><label htmlFor={`name-${index}`}>Rule name</label><input id={`name-${index}`} value={rule.name} onChange={(event) => updateRule(index, "name", event.target.value)} required maxLength={120} placeholder="Describe the protection" /></div>
            <div className="field"><label htmlFor={`priority-${index}`}>Priority</label><input id={`priority-${index}`} type="number" min="0" max="100000" step="1" value={rule.priority} onChange={(event) => updateRule(index, "priority", Number(event.target.value))} required /></div>
            <div className="field"><label htmlFor={`action-${index}`}>Action</label><select id={`action-${index}`} value={rule.action} onChange={(event) => updateRule(index, "action", event.target.value as Decision)}><option value="block">Block</option><option value="audit">Audit</option><option value="allow">Allow</option></select></div>
            <div className="field"><label htmlFor={`severity-${index}`}>Minimum severity</label><select id={`severity-${index}`} value={rule.min_severity} onChange={(event) => updateRule(index, "min_severity", event.target.value as Severity)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></div>
            <div className="field"><label htmlFor={`categories-${index}`}>Categories</label><input id={`categories-${index}`} value={rule.categories.join(", ")} onChange={(event) => updateRule(index, "categories", csv(event.target.value))} placeholder="All categories" /><p className="field-help">credential, private_key, pii, financial</p></div>
            <div className="field"><label htmlFor={`tags-${index}`}>Detector tags</label><input id={`tags-${index}`} value={rule.tags.join(", ")} onChange={(event) => updateRule(index, "tags", csv(event.target.value))} placeholder="All detector tags" /><p className="field-help">For example identity:id:nik or environment:env.</p></div>
            <div className="field"><label htmlFor={`providers-${index}`}>Providers</label><input id={`providers-${index}`} value={rule.providers.join(", ")} onChange={(event) => updateRule(index, "providers", csv(event.target.value))} placeholder="All providers" /><p className="field-help">For example chatgpt, claude.</p></div>
          </div></fieldset>)}</div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions"><button className="button button--secondary" type="button" onClick={() => setEditorOpen(false)}>Cancel</button><button className="button button--primary" type="submit" disabled={pending}>{pending ? "Saving version…" : editing ? "Save as new version" : "Create policy version"}</button></div>
      </form></section>}
    <section className="panel"><div className="panel-header"><div><h2>Policy history</h2><p>Assign a policy version to devices from the Devices page.</p></div><button type="button" className="icon-button" onClick={load} aria-label="Refresh policies"><Icon name="refresh" size={18} /></button></div>{loading ? <LoadingState /> : policies.length === 0 ? <EmptyState title="No policy versions" description="Create a deterministic policy before enrolling agents." action={<button type="button" className="button button--primary" onClick={() => openEditor()}>Create first policy</button>} /> : <div className="policy-history">{policies.map((policy) => <article className="policy-row" key={policy.version}><div className="policy-row-main"><span className="policy-symbol"><Icon name="policies" size={22} /></span><div><div className="policy-name"><h3>{shortId(policy.version)}</h3><span className="secondary-cell">Version</span></div><p>{policy.rules.filter((rule) => rule.enabled).length} enabled rules · {policy.allowed_file_types?.length ?? fileTypes.length} file types · Created {formatDate(policy.generated_at)}</p></div></div><div className="policy-row-meta"><StatusBadge value={policy.failure_mode === "block" ? "fail closed" : "audit on failure"} /><button type="button" className="button button--secondary" onClick={() => openEditor(policy)}>Edit as new version</button><button type="button" className="danger-button" onClick={() => void deletePolicy(policy)}>Delete</button></div><details className="policy-rule-details"><summary>View {policy.rules.length} rules</summary><div className="policy-rules">{[...policy.rules].sort((a, b) => a.priority - b.priority).map((rule) => <div key={rule.id}><span className="priority">{rule.priority}</span><div><strong>{rule.name}</strong><span>{rule.categories.length ? rule.categories.map(label).join(", ") : "All categories"} · {rule.tags?.join(", ") || "all tags"} · {rule.min_severity}+ · {rule.providers.length ? rule.providers.join(", ") : "all providers"}</span></div><StatusBadge value={rule.enabled ? rule.action : "disabled"} /></div>)}</div></details></article>)}</div>}</section>
    <section className="info-strip"><Icon name="shield" size={21} /><div><strong>Incomplete inspection never means allow</strong><p>Complete inspections use rule priority. Failed, unsupported, or timed-out inspection follows the configured failure mode.</p></div></section>
  </>;
}
