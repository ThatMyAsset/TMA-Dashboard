"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiBrowser } from "@/lib/client";
import type { Device, Policy } from "@/lib/types";
import { EmptyState, ErrorState, formatDate, label, LoadingState, PageHeader, shortId, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/icon";

export function DevicesView() {
  type ActivePairing = { id: string; code: string; created_at: string; expires_at: string };
  const [devices, setDevices] = useState<Device[]>([]);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expires_at: string } | null>(null);
  const [activePairings, setActivePairings] = useState<ActivePairing[]>([]);
  const [copied, setCopied] = useState(false);
  const [copyNotice, setCopyNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [revoking, setRevoking] = useState("");
  const [assigning, setAssigning] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const [deviceData, policyData, pairingData] = await Promise.all([
        apiBrowser<{ devices: Device[] }>("/v1/devices"),
        apiBrowser<{ policies: Policy[] }>("/v1/policies"),
        apiBrowser<{ pairing_codes: ActivePairing[] }>("/v1/pairing-codes")
      ]);
      setDevices(deviceData.devices); setPolicies(policyData.policies); setActivePairings(pairingData.pairing_codes);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load devices"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function createCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); setCopied(false);
    const form = new FormData(event.currentTarget);
    try { setPairing(await apiBrowser<{ code: string; expires_at: string }>("/v1/pairing-codes", { method: "POST", body: JSON.stringify({ ttl_hours: Number(form.get("ttl_hours")) }) })); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create pairing code"); }
    finally { setPending(false); }
  }
  async function copyCode() {
    if (!pairing) return;
    setCopyNotice("");
    try {
      await navigator.clipboard.writeText(pairing.code);
      setCopied(true);
      setCopyNotice("Pairing code copied.");
    } catch {
      const input = document.getElementById("pairing-code") as HTMLInputElement | null;
      input?.focus(); input?.select(); input?.setSelectionRange(0, input.value.length);
      let copiedWithFallback = false;
      try { copiedWithFallback = document.execCommand("copy"); } catch { /* Keep the code selected for manual copy. */ }
      setCopied(copiedWithFallback);
      setCopyNotice(copiedWithFallback ? "Pairing code copied." : "Clipboard is unavailable. The code is selected; press Ctrl+C to copy it.");
    }
  }
  async function revoke(device: Device) {
    if (!window.confirm(`Revoke ${device.hostname}? Its device token will stop working immediately. This cannot be undone.`)) return;
    setRevoking(device.id); setError(""); setNotice("");
    try { await apiBrowser(`/v1/devices/${device.id}/revoke`, { method: "POST", body: "{}" }); setNotice(`${device.hostname} was revoked.`); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not revoke device"); }
    finally { setRevoking(""); }
  }

  async function assignPolicy(device: Device, policyVersion: string) {
    if (!policyVersion || policyVersion === device.policy_version) return;
    setAssigning(device.id); setError(""); setNotice("");
    try {
      await apiBrowser(`/v1/devices/${device.id}/policy`, { method: "PUT", body: JSON.stringify({ policy_version: policyVersion }) });
      setNotice(`Policy ${shortId(policyVersion)} assigned to ${device.hostname}. The agent applies it on its next policy sync.`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not assign policy"); }
    finally { setAssigning(""); }
  }
  async function revokePairing(code: ActivePairing) {
    if (!window.confirm("Revoke this pairing code? It will stop working immediately.")) return;
    try { await apiBrowser(`/v1/pairing-codes/${code.id}`, { method: "DELETE" }); setNotice("Pairing code revoked."); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not revoke pairing code"); }
  }

  const active = devices.filter((device) => !device.revoked_at);
  const revoked = devices.filter((device) => device.revoked_at);
  return <><PageHeader eyebrow="Endpoint fleet" title="Devices" description="Enroll Windows agents, monitor protection readiness, and revoke access when an endpoint leaves your control." action={<button type="button" className="button button--primary" onClick={() => { setPairingOpen(!pairingOpen); setPairing(null); setCopyNotice(""); setError(""); }} aria-expanded={pairingOpen}><Icon name="plus" size={18} />Enroll device</button>} />
    {notice && <div className="success-banner" role="status"><Icon name="check" size={19} />{notice}</div>}
    {pairingOpen && <section className="panel enrollment-panel"><div className="panel-header"><div><h2>Enroll a Windows endpoint</h2><p>Generate a one-time code. The agent exchanges it for its own device token.</p></div><button type="button" className="icon-button" onClick={() => setPairingOpen(false)} aria-label="Close enrollment">×</button></div>{!pairing ? <form className="pairing-form" onSubmit={createCode}><div className="field"><label htmlFor="ttl_hours">Code lifetime</label><select id="ttl_hours" name="ttl_hours" defaultValue="1"><option value="1">1 hour</option><option value="4">4 hours</option><option value="8">8 hours</option><option value="24">24 hours</option></select><p className="field-help">Shorter lifetimes reduce exposure if the code is shared.</p></div><button className="button button--primary" disabled={pending}>{pending ? "Generating…" : "Generate pairing code"}</button></form> : <div className="pairing-result"><div className="pairing-instructions"><span className="step-number">1</span><p>Copy this code into the agent enrollment prompt. It works once and expires {formatDate(pairing.expires_at)}.</p></div><div className="code-box"><input id="pairing-code" className="pairing-code-input" aria-label="Pairing code" value={pairing.code} readOnly onFocus={(event) => event.currentTarget.select()} /><button type="button" className="button button--secondary" onClick={() => void copyCode()}><Icon name={copied ? "check" : "copy"} size={17} />{copied ? "Copied" : "Copy code"}</button></div>{copyNotice && <p className={`copy-notice${copied ? " copy-notice--success" : ""}`} role="status">{copied && <Icon name="check" size={16} />}{copyNotice}</p>}<div className="pairing-instructions"><span className="step-number">2</span><p>Run the agent enrollment command and store the returned device token in the agent’s protected configuration. The code and token cannot be recovered from this dashboard.</p></div><button type="button" className="text-link" onClick={() => { setPairing(null); setCopied(false); setCopyNotice(""); }}>Generate another code</button></div>}</section>}
    <section className="panel"><div className="panel-header"><div><h2>Valid pairing codes</h2><p>{activePairings.length} unused codes that have not expired</p></div></div>{activePairings.length === 0 ? <p className="empty-inline">No valid pairing codes. Generate one when enrolling a device.</p> : <div className="table-wrap"><table><thead><tr><th>Pairing code</th><th>Expires</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{activePairings.map((code) => <tr key={code.id}><td><code>{code.code}</code></td><td>{formatDate(code.expires_at)}</td><td><button className="danger-button" type="button" onClick={() => void revokePairing(code)}>Revoke</button></td></tr>)}</tbody></table></div>}</section>
    {error && <ErrorState message={error} retry={load} />}
    {policies.length === 0 && !loading && <div className="info-strip"><Icon name="policies" size={21} /><div><strong>No policies available</strong><p>Create a policy first, then assign it to devices.</p></div></div>}
    <section className="panel"><div className="panel-header"><div><h2>Endpoint inventory</h2><p>{active.length} active · {revoked.length} revoked</p></div><button type="button" className="icon-button" onClick={load} aria-label="Refresh devices"><Icon name="refresh" size={18} /></button></div>{loading ? <LoadingState /> : devices.length === 0 ? <EmptyState title="No devices enrolled" description="Start by generating a one-time pairing code. Device readiness appears after the first agent heartbeat." action={<button type="button" className="button button--primary" onClick={() => setPairingOpen(true)}><Icon name="plus" size={17} />Enroll first device</button>} /> : <div className="table-wrap table-wrap--devices"><table><thead><tr><th>Device</th><th>Status</th><th>Readiness</th><th>Agent</th><th>Last heartbeat</th><th>Policy</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{devices.map((device) => <tr key={device.id} className={device.revoked_at ? "row--muted" : ""}><td><span className="device-name"><span className="device-icon"><Icon name="devices" size={18} /></span><span><strong>{device.hostname}</strong><small>{device.os} · {shortId(device.id)}</small></span></span></td><td>{device.revoked_at ? <StatusBadge value="revoked" /> : <StatusBadge value={device.status} />}</td><td><div className="readiness"><span className={device.inspection_engine_ready ? "ready" : "not-ready"}><span aria-hidden="true">{device.inspection_engine_ready ? "✓" : "—"}</span> Engine</span><span className={device.browser_connected ? "ready" : "not-ready"}><span aria-hidden="true">{device.browser_connected ? "✓" : "—"}</span> Browser</span></div></td><td>{device.agent_version}</td><td className="date-cell">{formatDate(device.last_seen_at)}</td><td><select aria-label={`Policy for ${device.hostname}`} value={device.policy_version ?? ""} disabled={!!device.revoked_at || assigning === device.id || policies.length === 0} onChange={(event) => void assignPolicy(device, event.target.value)}><option value="" disabled>Not assigned</option>{policies.map((policy) => <option key={policy.version} value={policy.version}>{shortId(policy.version)}</option>)}</select></td><td>{device.revoked_at ? <span className="secondary-cell">{formatDate(device.revoked_at)}</span> : <button type="button" className="danger-button" onClick={() => void revoke(device)} disabled={revoking === device.id}>{revoking === device.id ? "Revoking…" : "Revoke"}</button>}</td></tr>)}</tbody></table></div>}</section>
    <section className="info-strip"><Icon name="shield" size={21} /><div><strong>Readiness determines protection status</strong><p>An agent cannot report protected unless both its inspection engine and browser connection are ready. A heartbeat with incomplete readiness is rejected.</p></div></section>
  </>;
}
