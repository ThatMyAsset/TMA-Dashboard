import type { Finding, Severity } from "./types";

const order: Severity[] = ["low", "medium", "high", "critical"];

export function highestSeverity(findings: Finding[]): Severity {
  return findings.reduce<Severity>((highest, finding) => order.indexOf(finding.severity) > order.indexOf(highest) ? finding.severity : highest, "low");
}

export function eventQuery(filters: { provider: string; severity: string; outcome: string }) {
  const query = new URLSearchParams({ limit: "200" });
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  return query.toString();
}
