"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiBrowser } from "@/lib/client";
import type { SecurityEvent } from "@/lib/types";
import { EmptyState, ErrorState, formatDate, label, LoadingState, PageHeader, shortId, StatusBadge } from "@/components/ui";
import { eventQuery } from "@/lib/event";
import { Icon } from "@/components/icon";

export function ActivityView() {
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [filters, setFilters] = useState({ provider: "", severity: "", outcome: "" });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<SecurityEvent | null>(null);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError("");
    try { setEvents((await apiBrowser<{ events: SecurityEvent[] }>(`/v1/events?${eventQuery(filters)}`)).events); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load events"); }
    finally { setLoading(false); setRefreshing(false); }
  }, [filters]);
  useEffect(() => {
    void load(true);
    const refresh = () => { if (!document.hidden) void load(); };
    const interval = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(interval); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);

  return <><PageHeader eyebrow="Audit trail" title="Security activity" description="Inspection outcomes and confirmed browser enforcement. New events refresh automatically while this page is open." action={<button type="button" className="button button--secondary" onClick={() => void load()} disabled={loading || refreshing}><Icon name="refresh" size={17} />{refreshing ? "Refreshing…" : "Refresh activity"}</button>} />
    <section className="panel"><form className="filter-bar" onSubmit={(event) => event.preventDefault()}><div className="filter-title"><Icon name="search" size={18} /><span>Filter events</span></div><div className="field"><label htmlFor="provider">Provider</label><input id="provider" value={filters.provider} onChange={(event) => setFilters({ ...filters, provider: event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })} placeholder="All providers" maxLength={64} /></div><div className="field"><label htmlFor="severity">Severity</label><select id="severity" value={filters.severity} onChange={(event) => setFilters({ ...filters, severity: event.target.value })}><option value="">All severities</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></div><div className="field"><label htmlFor="outcome">Decision</label><select id="outcome" value={filters.outcome} onChange={(event) => setFilters({ ...filters, outcome: event.target.value })}><option value="">All decisions</option><option value="block">Block</option><option value="audit">Audit</option><option value="allow">Allow</option></select></div><button className="button button--secondary filter-reset" type="button" onClick={() => setFilters({ provider: "", severity: "", outcome: "" })} disabled={!Object.values(filters).some(Boolean)}>Clear filters</button></form>
      {error ? <ErrorState message={error} retry={load} /> : loading ? <LoadingState /> : events.length === 0 ? <EmptyState title={Object.values(filters).some(Boolean) ? "No events match these filters" : "No security activity yet"} description={Object.values(filters).some(Boolean) ? "Change or clear the filters to see other recorded events." : "Activity appears after enrolled agents report inspection and enforcement results."} action={Object.values(filters).some(Boolean) ? <button className="button button--secondary" onClick={() => setFilters({ provider: "", severity: "", outcome: "" })}>Clear filters</button> : undefined} /> : <><div className="result-count">{events.length} event{events.length === 1 ? "" : "s"} · newest first</div><div className="table-wrap table-wrap--activity"><table><thead><tr><th>Occurred</th><th>Provider</th><th>Finding</th><th>Severity</th><th>Decision</th><th>Enforcement</th><th>Risk</th><th><span className="sr-only">Details</span></th></tr></thead><tbody>{events.map((event) => { const severity = event.findings.reduce((highest, finding) => ["low", "medium", "high", "critical"].indexOf(finding.severity) > ["low", "medium", "high", "critical"].indexOf(highest) ? finding.severity : highest, "low" as string); return <tr key={event.event_id}><td className="date-cell">{formatDate(event.occurred_at)}</td><td><span className="primary-cell">{event.provider}</span><span className="secondary-cell">{event.application}</span></td><td>{event.findings.length ? event.findings.map((finding) => label(finding.category)).join(", ") : "No findings"}</td><td><StatusBadge value={severity} /></td><td><StatusBadge value={event.policy_decision} /></td><td><StatusBadge value={event.enforcement_status} /></td><td><span className={`risk risk--${event.risk_score >= 80 ? "high" : event.risk_score >= 40 ? "medium" : "low"}`}>{event.risk_score}</span></td><td><button type="button" className="table-action" onClick={() => setSelected(event)} aria-label={`View event ${event.event_id}`}>Details<Icon name="arrow" size={15} /></button></td></tr>; })}</tbody></table></div></>}</section>
    {selected && <EventDetails event={selected} close={() => setSelected(null)} />}
  </>;
}

function EventDetails({ event, close }: { event: SecurityEvent; close: () => void }) {
  const drawer = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    drawer.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keyboard = (key: KeyboardEvent) => {
      if (key.key === "Escape") { close(); return; }
      if (key.key !== "Tab") return;
      const controls = drawer.current?.querySelectorAll<HTMLElement>("button, a[href], input, select, [tabindex='0']");
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (key.shiftKey && document.activeElement === first) { key.preventDefault(); last.focus(); }
      if (!key.shiftKey && document.activeElement === last) { key.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.body.style.overflow = overflow; document.removeEventListener("keydown", keyboard); previous?.focus(); };
  }, [close]);
  return <div className="drawer-layer"><button className="drawer-scrim" onClick={close} aria-label="Close event details" tabIndex={-1} /><aside ref={drawer} className="drawer" role="dialog" aria-modal="true" aria-labelledby="event-title"><div className="drawer-header"><div><p className="eyebrow">Event metadata</p><h2 id="event-title">Inspection details</h2></div><button className="icon-button" onClick={close} aria-label="Close details">×</button></div><div className="drawer-body"><div className="detail-status"><StatusBadge value={event.policy_decision} /><span className={`risk risk--${event.risk_score >= 80 ? "high" : "medium"}`}>Risk {event.risk_score}</span></div><p className="metadata-note">{event.inspection_status === "complete" ? "Decision came from a completed inspection and the assigned policy rules. A low finding can be blocked if a matching rule is configured to block Low severity." : `This decision follows the policy failure mode because inspection was ${label(event.inspection_status)}. Severity thresholds do not apply when inspection cannot complete.`}</p><dl className="detail-list detail-list--stacked"><div><dt>Event ID</dt><dd className="mono">{event.event_id}</dd></div><div><dt>Occurred</dt><dd>{formatDate(event.occurred_at)}</dd></div><div><dt>Provider / application</dt><dd>{event.provider} / {event.application}</dd></div><div><dt>Inspection</dt><dd><StatusBadge value={event.inspection_status} /></dd></div><div><dt>Enforcement</dt><dd><StatusBadge value={event.enforcement_status} /></dd></div><div><dt>Enforcement component</dt><dd>{label(event.enforcement_component)}</dd></div><div><dt>File name</dt><dd>{event.file_name || "Prompt event"}</dd></div>{event.file_name && <><div><dt>File size</dt><dd>{event.file_size.toLocaleString()} bytes</dd></div><div><dt>SHA-256</dt><dd className="mono hash-value">{event.sha256}</dd></div></>}<div><dt>Policy version</dt><dd className="mono">{shortId(event.policy_version)}</dd></div></dl><section className="finding-list"><h3>Findings</h3>{event.findings.length === 0 ? <p>No findings were recorded.</p> : event.findings.map((finding, index) => <div className="finding" key={`${finding.detector}-${index}`}><div><strong>{label(finding.category)}</strong><span>{finding.detector}</span></div><StatusBadge value={finding.severity} /></div>)}</section><p className="metadata-note">No matched values, prompt text, or file content are available in this view.</p></div></aside></div>;
}
