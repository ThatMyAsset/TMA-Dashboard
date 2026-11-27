"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiBrowser } from "@/lib/client";
import type { Decision, Policy, PolicyRule, Severity } from "@/lib/types";
import { EmptyState, ErrorState, formatDate, label, LoadingState, PageHeader, shortId, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/icon";

const fileTypes = ["txt", "md", "markdown", "mdx", "rst", "csv", "tsv", "json", "jsonl", "ndjson", "xml", "html", "htm", "yaml", "yml", "toml", "ini", "conf", "config", "properties", "log", "env", "sql", "py", "js", "jsx", "mjs", "cjs", "ts", "tsx", "go", "rs", "c", "h", "cc", "cpp", "hpp", "hxx", "cs", "java", "kt", "kts", "swift", "php", "rb", "sh", "bash", "zsh", "ps1", "bat", "cmd", "css", "scss", "less", "vue", "svelte", "tf", "tfvars", "hcl", "dockerignore", "gitignore", "dockerfile", "makefile"];
const categoryOptions = [
  { value: "credential", title: "Access keys and passwords" },
  { value: "private_key", title: "Private keys" },
  { value: "pii", title: "Personal information" },
  { value: "financial", title: "Payment card numbers" }
];
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
  const [name, setName] = useState("");
  const [allowedFileTypes, setAllowedFileTypes] = useState<string[]>(fileTypes);
  const [tags, setTags] = useState<string[]>(availableTags.slice(0, 5));
  const [rules, setRules] = useState<PolicyRule[]>([]);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<Policy | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [retryAction, setRetryAction] = useState<(() => void) | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setPolicies((await apiBrowser<{ policies: Policy[] }>("/v1/policies")).policies); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load policies"); setRetryAction(() => load); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (editorOpen) document.getElementById("policy-editor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [editorOpen]);

  function openEditor(current?: Policy) {
    setEditing(current ?? null);
    setName(current?.name || "Baseline protection");
    setFailureMode(current?.failure_mode ?? "block");
    setAllowedFileTypes(current?.allowed_file_types?.length ? current.allowed_file_types : fileTypes);
    setTags(current?.tags?.length ? current.tags : availableTags.slice(0, 5));
    setRules(current ? current.rules.map((rule) => ({ ...rule, tags: rule.tags ?? [] })) : [
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
    const policy: Policy = { name: name.trim(), version: editing?.version ?? uuid(), generated_at: new Date().toISOString(), failure_mode: failureMode, allowed_file_types: allowedFileTypes, tags, rules: rules.map((rule) => ({ ...rule, name: rule.name.trim() })) };
    if (!policy.name) { setError("Give this policy a name."); setPending(false); return; }
    try {
      await apiBrowser<Policy>(editing ? `/v1/policies/${policy.version}` : "/v1/policies", { method: editing ? "PUT" : "POST", body: JSON.stringify(policy) });
      setNotice(editing ? `Policy “${policy.name}” updated. Assigned devices receive the changes on their next sync.` : `Policy “${policy.name}” created. Assign it to devices from the Devices page.`);
      setEditorOpen(false); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save policy"); }
    finally { setPending(false); }
  }

  async function deletePolicy(policy: Policy) {
    if (!window.confirm(`Delete “${policy.name}”? Active devices using it will move to the most recently updated policy. If this is the last policy, a safe baseline will be created automatically. Activity history remains available.`)) return;
    setError(""); setNotice(""); setDeleting(policy.version);
    try { await apiBrowser(`/v1/policies/${policy.version}`, { method: "DELETE" }); setNotice(`Policy “${policy.name}” deleted. Any assigned active devices now use a replacement policy.`); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete policy"); setRetryAction(() => () => { void deletePolicy(policy); }); }
    finally { setDeleting(null); }
  }

  return <><PageHeader eyebrow="Protection configuration" title="Policies" description="Name each protection policy, choose which files to inspect, and set the action for sensitive data. Edits update the policy on assigned devices." action={<button type="button" className="button button--primary" onClick={() => openEditor()}><Icon name="plus" size={18} />Create policy</button>} />
    {notice && <div className="success-banner" role="status"><Icon name="check" size={19} />{notice}</div>}
    {error && !editorOpen && <ErrorState message={error} retry={retryAction ?? load} />}
    {editorOpen && <section id="policy-editor" className="panel policy-editor"><div className="panel-header"><div><h2>{editing ? `Edit ${editing.name}` : "Create policy"}</h2><p>Changes apply to devices assigned to this policy after their next sync.</p></div><button type="button" className="icon-button" onClick={() => setEditorOpen(false)} aria-label="Close policy editor">×</button></div>
      <form onSubmit={savePolicy}>
        <div className="policy-settings">
          <div className="field"><label htmlFor="policy-name">Policy name</label><input id="policy-name" value={name} onChange={(event) => setName(event.target.value)} required maxLength={120} placeholder="For example, Finance team" /></div>
          <div className="field"><label htmlFor="failure-mode">If inspection cannot finish</label><select id="failure-mode" value={failureMode} onChange={(event) => setFailureMode(event.target.value as "block" | "audit")}><option value="block">Block the upload</option><option value="audit">Allow and record an audit event</option></select><p className="field-help">Applies to failed, incomplete, unsupported, or timed-out inspection. This is independent of finding severity.</p></div>
          <div className="field"><label>File formats supported by inspection</label><div className="readiness">{fileTypes.map((extension) => <label key={extension}><input type="checkbox" checked={allowedFileTypes.includes(extension)} onChange={(event) => setAllowedFileTypes((current) => event.target.checked ? [...current, extension] : current.filter((value) => value !== extension))} /> .{extension}</label>)}</div><p className="field-help">Unchecked or unsupported files follow Failure mode. This is separate from severity rules.</p></div>
          <div className="field"><label>Sensitive data tags</label><div className="readiness">{availableTags.map((tag) => <label key={tag}><input type="checkbox" checked={tags.includes(tag)} onChange={(event) => setTags((current) => event.target.checked ? [...current, tag] : current.filter((value) => value !== tag))} /> {tag}</label>)}</div><p className="field-help">Current contextual identity detectors cover Indonesia NIK, US SSN, Canada SIN, UK NI number and India PAN/Aadhaar. Coverage is limited and does not include every national document.</p></div>
          <div className="precedence-note"><span>How decisions work</span><strong>Complete inspection → first matching rule</strong><p>Severity is checked only after category/tag matches. Low findings are allowed by the default policy. Failed, incomplete, unsupported, or timed-out inspection follows Failure mode and can still block without a high severity finding.</p></div>
        </div>
        <div className="rule-editor-head"><h3>Rules</h3><button className="button button--secondary" type="button" onClick={() => setRules((current) => [...current, newRule(current.length ? Math.max(...current.map((rule) => rule.priority)) + 10 : 10)])}><Icon name="plus" size={16} />Add rule</button></div>
        <div className="rule-list">{rules.map((rule, index) => <fieldset className="rule-editor" key={rule.id}><legend className="sr-only">Rule {index + 1}</legend><div className="rule-title"><label className="toggle"><input type="checkbox" checked={rule.enabled} onChange={(event) => updateRule(index, "enabled", event.target.checked)} /><span aria-hidden="true" /><span>{rule.enabled ? "Enabled" : "Disabled"}</span></label><span className="rule-number">Rule {index + 1}</span><button className="danger-button" type="button" onClick={() => setRules((current) => current.filter((_, position) => position !== index))} disabled={rules.length === 1}>Remove rule</button></div>
          <div className="rule-grid">
            <div className="field field--wide"><label htmlFor={`name-${index}`}>Rule name</label><input id={`name-${index}`} value={rule.name} onChange={(event) => updateRule(index, "name", event.target.value)} required maxLength={120} placeholder="Describe the protection" /></div>
            <div className="field"><label htmlFor={`action-${index}`}>If it matches</label><select id={`action-${index}`} value={rule.action} onChange={(event) => updateRule(index, "action", event.target.value as Decision)}><option value="block">Block the upload</option><option value="audit">Allow and record activity</option><option value="allow">Allow the upload</option></select></div>
            <div className="field"><label htmlFor={`severity-${index}`}>Severity threshold</label><select id={`severity-${index}`} value={rule.min_severity} onChange={(event) => updateRule(index, "min_severity", event.target.value as Severity)}><option value="low">Low or higher</option><option value="medium">Medium or higher</option><option value="high">High or higher</option><option value="critical">Critical only</option></select><p className="field-help">Only applies to the data types selected below.</p></div>
            <fieldset className="field field--wide category-picker"><legend>Protect these data types</legend><div className="category-options">{categoryOptions.map((option) => <label key={option.value}><input type="checkbox" checked={rule.categories.includes(option.value)} onChange={(event) => updateRule(index, "categories", event.target.checked ? [...rule.categories, option.value] : rule.categories.filter((value) => value !== option.value))} />{option.title}</label>)}</div>{rule.categories.length === 0 && <p className="field-help">No types selected: this rule can match any finding.</p>}</fieldset>
            <details className="rule-advanced"><summary>More options</summary><div className="rule-grid">
              <div className="field"><label htmlFor={`priority-${index}`}>Rule order</label><input id={`priority-${index}`} type="number" min="0" max="100000" step="1" value={rule.priority} onChange={(event) => updateRule(index, "priority", Number(event.target.value))} required /><p className="field-help">Smaller number wins when multiple rules match.</p></div>
              <div className="field"><label htmlFor={`tags-${index}`}>Detector tags</label><input id={`tags-${index}`} value={rule.tags.join(", ")} onChange={(event) => updateRule(index, "tags", csv(event.target.value))} placeholder="All detector tags" /><p className="field-help">For example identity:id:nik or environment:env.</p></div>
              <div className="field"><label htmlFor={`providers-${index}`}>Providers</label><input id={`providers-${index}`} value={rule.providers.join(", ")} onChange={(event) => updateRule(index, "providers", csv(event.target.value))} placeholder="All providers" /><p className="field-help">For example chatgpt, claude.</p></div>
            </div></details>
          </div></fieldset>)}</div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="form-actions"><button className="button button--secondary" type="button" onClick={() => setEditorOpen(false)}>Cancel</button><button className="button button--primary" type="submit" disabled={pending}>{pending ? "Saving policy…" : editing ? "Save changes" : "Create policy"}</button></div>
      </form></section>}
    <section className="panel"><div className="panel-header"><div><h2>Saved policies</h2><p>Assign a named policy to one or more active devices from Devices.</p></div><button type="button" className="icon-button" onClick={load} aria-label="Refresh policies"><Icon name="refresh" size={18} /></button></div>{loading ? <LoadingState /> : policies.length === 0 ? <EmptyState title="No saved policies" description="Create a policy before enrolling agents." action={<button type="button" className="button button--primary" onClick={() => openEditor()}>Create first policy</button>} /> : <div className="policy-history">{policies.map((policy) => <article className="policy-row" key={policy.version}><div className="policy-row-main"><span className="policy-symbol"><Icon name="policies" size={22} /></span><div><div className="policy-name"><h3>{policy.name || "Unnamed policy"}</h3><span className="secondary-cell">{shortId(policy.version)}</span></div><p>{policy.rules.filter((rule) => rule.enabled).length} enabled rules · {policy.allowed_file_types?.length ?? fileTypes.length} file types · Updated {formatDate(policy.generated_at)}</p></div></div><div className="policy-row-meta"><StatusBadge value={policy.failure_mode === "block" ? "fail closed" : "audit on failure"} /><button type="button" className="button button--secondary" onClick={() => openEditor(policy)}>Edit policy</button><button type="button" className="danger-button" onClick={() => void deletePolicy(policy)} disabled={deleting === policy.version}>{deleting === policy.version ? "Deleting…" : "Delete"}</button></div><details className="policy-rule-details"><summary>View {policy.rules.length} rules</summary><div className="policy-rules">{[...policy.rules].sort((a, b) => a.priority - b.priority).map((rule) => <div key={rule.id}><span className="priority">{rule.priority}</span><div><strong>{rule.name}</strong><span>{rule.categories.length ? rule.categories.map(label).join(", ") : "All categories"} · {rule.tags?.join(", ") || "all tags"} · {rule.min_severity}+ · {rule.providers.length ? rule.providers.join(", ") : "all providers"}</span></div><StatusBadge value={rule.enabled ? rule.action : "disabled"} /></div>)}</div></details></article>)}</div>}</section>
    <section className="info-strip"><Icon name="shield" size={21} /><div><strong>Incomplete inspection never means allow</strong><p>Complete inspections use rule priority. Failed, unsupported, or timed-out inspection follows the configured failure mode.</p></div></section>
  </>;
}
