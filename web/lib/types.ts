export type Severity = "low" | "medium" | "high" | "critical";
export type Decision = "block" | "audit" | "allow";
export type DeviceStatus = "pending_enrollment" | "limited" | "protected" | "degraded";

export type PolicyRule = {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  action: Decision;
  categories: string[];
  min_severity: Severity;
  providers: string[];
  tags: string[];
};

export type Policy = {
  version: string;
  generated_at: string;
  failure_mode: "block" | "audit";
  allowed_file_types: string[];
  tags: string[];
  rules: PolicyRule[];
};

export type Device = {
  id: string;
  hostname: string;
  os: string;
  agent_version: string;
  status: DeviceStatus;
  inspection_engine_ready: boolean;
  browser_connected: boolean;
  enrolled_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  policy_version: string | null;
};

export type Finding = { category: string; severity: Severity; detector: string };
export type SecurityEvent = {
  event_id: string;
  occurred_at: string;
  channel: string;
  provider: string;
  application: string;
  file_name: string;
  file_size: number;
  sha256: string;
  inspection_status: string;
  inspection_complete: boolean;
  policy_decision: Decision;
  enforcement_component: string;
  enforcement_status: string;
  enforcement_confirmed: boolean;
  findings: Finding[];
  risk_score: number;
  policy_version: string;
};

export type Overview = {
  total_devices: number;
  protected_devices: number;
  degraded_devices: number;
  pending_devices: number;
  events_24h: number;
  blocked_24h: number;
  failed_24h: number;
  active_policy: Policy | null;
};

export type ApiError = { error: { code: string; message: string } };
