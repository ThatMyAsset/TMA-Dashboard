import type { ReactNode } from "react";
import { Icon } from "./icon";

export function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1><p className="page-description">{description}</p></div>{action && <div className="page-action">{action}</div>}</div>;
}

export function StatusBadge({ value }: { value: string }) {
  return <span className={`status status--${value.replaceAll("_", "-")}`}><span className="status-dot" aria-hidden="true" />{value.replaceAll("_", " ")}</span>;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon"><Icon name="shield" size={26} /></span><h2>{title}</h2><p>{description}</p>{action}</div>;
}

export function LoadingState() {
  return <div className="loading-state" role="status"><span className="spinner" aria-hidden="true" /><span>Loading control plane data…</span></div>;
}

export function ErrorState({ message, retry }: { message: string; retry: () => void }) {
  return <div className="error-state" role="alert"><div><strong>Control plane unavailable</strong><p>{message}</p></div><button className="button button--secondary" onClick={retry}><Icon name="refresh" size={17} />Retry request</button></div>;
}

export function shortId(id: string) { return `${id.slice(0, 8)}…`; }
export function formatDate(value: string | null) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(value));
}
export function label(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
