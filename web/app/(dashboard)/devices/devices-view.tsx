"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { apiBrowser } from "@/lib/client";
import type { Device } from "@/lib/types";
import { EmptyState, ErrorState, formatDate, label, LoadingState, PageHeader, shortId, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/icon";

export function DevicesView() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pairingOpen, setPairingOpen] = useState(false);
  const [pairing, setPairing] = useState<{ code: string; expires_at: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [revoking, setRevoking] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError("");
    try { setDevices((await apiBrowser<{ devices: Device[] }>("/v1/devices")).devices); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load devices"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function createCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setPending(true); setError(""); setCopied(false);
    const form = new FormData(event.currentTarget);
    try { setPairing(await apiBrowser<{ code: string; expires_at: string }>("/v1/pairing-codes", { method: "POST", body: JSON.stringify({ ttl_hours: Number(form.get("ttl_hours")) }) })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not create pairing code"); }
    finally { setPending(false); }
  }
  async function copyCode() {
    if (!pairing) return;
    try { await navigator.clipboard.writeText(pairing.code); setCopied(true); }
    catch { setError("Clipboard access was denied. Select and copy the pairing code manually."); }
  }
  async function revoke(device: Device) {
    if (!window.confirm(`Revoke ${device.hostname}? Its device token will stop working immediately. This cannot be undone.`)) return;
    setRevoking(device.id); setError(""); setNotice("");
    try { await apiBrowser(`/v1/devices/${device.id}/revoke`, { method: "POST", body: "{}" }); setNotice(`${device.hostname} was revoked.`); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not revoke device"); }
    finally { setRevoking(""); }
  }

  const active = devices.filter((device) => !device.revoked_at);
  const revoked = devices.filter((device) => device.revoked_at);
  return <><PageHeader eyebrow="Endpoint fleet" title="Devices" description="Enroll Windows agents, monitor protection readiness, and revoke access when an endpoint leaves your control." action={<button className="button button--primary" onClick={() => { setPairingOpen(!pairingOpen); setPairing(null); setError(""); }} aria-expanded={pairingOpen}><Icon name="plus" size={18} />Enroll device</button>} />
    {notice && <div className="success-banner" role="status"><Icon name="check" size={19} />{notice}</div>}
    {pairingOpen && <section className="panel enrollment-panel"><div className="panel-header"><div><h2>Enroll a Windows endpoint</h2><p>Generate a one-time code. The agent exchanges it for its own device token.</p></div><button className="icon-button" onClick={() => setPairingOpen(false)} aria-label="Close enrollment">×</button></div>{!pairing ? <form className="pairing-form" onSubmit={createCode}><div className="field"><label htmlFor="ttl_hours">Code lifetime</label><select id="ttl_hours" name="ttl_hours" defaultValue="1"><option value="1">1 hour</option><option value="4">4 hours</option><option value="8">8 hours</option><option value="24">24 hours</option></select><p className="field-help">Shorter lifetimes reduce exposure if the code is shared.</p></div><button className="button button--primary" disabled={pending}>{pending ? "Generating…" : "Generate pairing code"}</button></form> : <div className="pairing-result"><div className="pairing-instructions"><span className="step-number">1</span><p>Copy this code into the agent enrollment prompt. It works once and expires {formatDate(pairing.expires_at)}.</p></div><div className="code-box"><code>{pairing.code}</code><button className="button button--secondary" onClick={copyCode}><Icon name={copied ? "check" : "copy"} size={17} />{copied ? "Copied" : "Copy code"}</button></div><div className="pairing-instructions"><span className="step-number">2</span><p>Run the agent enrollment command and store the returned device token in the agent’s protected configuration. The code and token cannot be recovered from this dashboard.</p></div><button className="text-link" onClick={() => { setPairing(null); setCopied(false); }}>Generate another code</button></div>}</section>}
    {error && <ErrorState message={error} retry={load} />}
    <section className="panel"><div className="panel-header"><div><h2>Endpoint inventory</h2><p>{active.length} active · {revoked.length} revoked</p></div><button className="icon-button" onClick={load} aria-label="Refresh devices"><Icon name="refresh" size={18} /></button></div>{loading ? <LoadingState /> : devices.length === 0 ? <EmptyState title="No devices enrolled" description="Start by generating a one-time pairing code. Device readiness appears after the first agent heartbeat." action={<button className="button button--primary" onClick={() => setPairingOpen(true)}><Icon name="plus" size={17} />Enroll first device</button>} /> : <div className="table-wrap"><table><thead><tr><th>Device</th><th>Status</th><th>Readiness</th><th>Agent</th><th>Last heartbeat</th><th>Policy</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{devices.map((device) => <tr key={device.id} className={device.revoked_at ? "row--muted" : ""}><td><span className="device-name"><span className="device-icon"><Icon name="devices" size={18} /></span><span><strong>{device.hostname}</strong><small>{device.os} · {shortId(device.id)}</small></span></span></td><td>{device.revoked_at ? <StatusBadge value="revoked" /> : <StatusBadge value={device.status} />}</td><td><div className="readiness"><span className={device.inspection_engine_ready ? "ready" : "not-ready"}><span aria-hidden="true">{device.inspection_engine_ready ? "✓" : "—"}</span> Engine</span><span className={device.browser_connected ? "ready" : "not-ready"}><span aria-hidden="true">{device.browser_connected ? "✓" : "—"}</span> Browser</span></div></td><td>{device.agent_version}</td><td className="date-cell">{formatDate(device.last_seen_at)}</td><td className="mono">{device.policy_version ? shortId(device.policy_version) : "Not assigned"}</td><td>{device.revoked_at ? <span className="secondary-cell">{formatDate(device.revoked_at)}</span> : <button className="danger-button" onClick={() => revoke(device)} disabled={revoking === device.id}>{revoking === device.id ? "Revoking…" : "Revoke"}</button>}</td></tr>)}</tbody></table></div>}</section>
    <section className="info-strip"><Icon name="shield" size={21} /><div><strong>Readiness determines protection status</strong><p>An agent cannot report protected unless both its inspection engine and browser connection are ready. A heartbeat with incomplete readiness is rejected.</p></div></section>
  </>;
}
