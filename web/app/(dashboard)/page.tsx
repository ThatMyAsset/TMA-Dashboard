import type { Metadata } from "next";
import Link from "next/link";
import { apiServer } from "@/lib/api";
import type { Device, Overview, SecurityEvent } from "@/lib/types";
import { EmptyState, formatDate, PageHeader, shortId, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/icon";
import { OverviewError } from "@/components/overview-error";
import { RefreshButton } from "@/components/refresh-button";

export const metadata: Metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  try {
    const [overview, eventData, deviceData] = await Promise.all([
      apiServer<Overview>("/api/v1/overview"),
      apiServer<{ events: SecurityEvent[] }>("/api/v1/events?limit=6"),
      apiServer<{ devices: Device[] }>("/api/v1/devices")
    ]);
    const active = deviceData.devices.filter((device) => !device.revoked_at);
    const limited = active.filter((device) => device.status === "limited").length;
    return <>
      <PageHeader eyebrow="Security posture" title="Protection at a glance" description="Live device readiness, enforcement activity, and policy state from the control plane." action={<RefreshButton />} />
      <section className="metric-grid" aria-label="Current protection metrics">
        <article className="metric-card"><div className="metric-top"><span>Protected devices</span><span className="metric-icon metric-icon--green"><Icon name="shield" size={19} /></span></div><strong>{overview.protected_devices}<small> / {overview.total_devices}</small></strong><p>{overview.total_devices === 0 ? "No enrolled endpoints" : `${active.length} active enrollment${active.length === 1 ? "" : "s"}`}</p></article>
        <article className="metric-card"><div className="metric-top"><span>Events in 24 hours</span><span className="metric-icon"><Icon name="activity" size={19} /></span></div><strong>{overview.events_24h}</strong><p>Metadata-only events received</p></article>
        <article className="metric-card"><div className="metric-top"><span>Blocked in 24 hours</span><span className="metric-icon metric-icon--red"><Icon name="policies" size={19} /></span></div><strong>{overview.blocked_24h}</strong><p>Policy decisions marked block</p></article>
        <article className="metric-card"><div className="metric-top"><span>Needs attention</span><span className="metric-icon metric-icon--amber"><Icon name="devices" size={19} /></span></div><strong>{overview.degraded_devices + overview.failed_24h + limited + overview.pending_devices}</strong><p>{overview.failed_24h} failed enforcement · {limited} limited device{limited === 1 ? "" : "s"}</p></article>
      </section>
      {overview.total_devices === 0 && <section className="onboarding"><div className="onboarding-number">01</div><div><h2>Enroll your first endpoint</h2><p>Generate a one-time pairing code, then provide it to the endpoint agent during enrollment. Devices remain pending until their first ready heartbeat.</p></div><Link className="button button--primary" href="/devices">Set up devices<Icon name="arrow" size={18} /></Link></section>}
      <div className="overview-grid">
        <section className="panel"><div className="panel-header"><div><h2>Recent activity</h2><p>Latest enforcement events across all devices.</p></div><Link className="text-link" href="/activity">View activity<Icon name="arrow" size={16} /></Link></div>{eventData.events.length === 0 ? <EmptyState title="No activity recorded" description="Events appear here after an enrolled agent reports browser inspection and enforcement metadata." /> : <div className="table-wrap"><table><thead><tr><th>Provider</th><th>Decision</th><th>Risk</th><th>Occurred</th></tr></thead><tbody>{eventData.events.map((event) => <tr key={event.event_id}><td><span className="primary-cell">{event.provider}</span><span className="secondary-cell">{event.application}</span></td><td><StatusBadge value={event.policy_decision} /></td><td><span className={`risk risk--${event.risk_score >= 80 ? "high" : event.risk_score >= 40 ? "medium" : "low"}`}>{event.risk_score}</span></td><td className="date-cell">{formatDate(event.occurred_at)}</td></tr>)}</tbody></table></div>}</section>
        <section className="panel"><div className="panel-header"><div><h2>Latest policy</h2><p>Devices can use different named policies.</p></div><Link className="text-link" href="/policies">Manage<Icon name="arrow" size={16} /></Link></div>{overview.active_policy ? <div className="active-policy"><div className="policy-version"><span className="policy-symbol"><Icon name="policies" size={24} /></span><div><strong>{overview.active_policy.name || "Unnamed policy"}</strong><span>{shortId(overview.active_policy.version)} · Updated {formatDate(overview.active_policy.generated_at)}</span></div><StatusBadge value={overview.active_policy.failure_mode === "block" ? "fail closed" : "audit on failure"} /></div><dl className="detail-list"><div><dt>Enabled rules</dt><dd>{overview.active_policy.rules.filter((rule) => rule.enabled).length}</dd></div><div><dt>Failure mode</dt><dd>{overview.active_policy.failure_mode}</dd></div><div><dt>Lowest priority</dt><dd>{overview.active_policy.rules.some((rule) => rule.enabled) ? Math.min(...overview.active_policy.rules.filter((rule) => rule.enabled).map((rule) => rule.priority)) : "None"}</dd></div></dl><div className="policy-note"><Icon name="shield" size={18} /><p>Failed or incomplete inspection follows the failure mode. It never silently allows content.</p></div></div> : <EmptyState title="No active policy" description="Create a policy before enrolling agents." action={<Link className="button button--secondary" href="/policies">Create policy</Link>} />}</section>
      </div>
    </>;
  } catch (cause) {
    return <><PageHeader eyebrow="Security posture" title="Protection at a glance" description="Live device readiness, enforcement activity, and policy state from the control plane." /><OverviewError message={cause instanceof Error ? cause.message : "Unknown error"} /></>;
  }
}
