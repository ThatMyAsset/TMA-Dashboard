package model

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"
	"time"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$`)
var shaPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var categoryPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,63}$`)
var detectorPattern = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9_.-]{0,127}$`)

func UUID(s string) bool { return uuidPattern.MatchString(s) }

func NewUUID() string {
	var b [16]byte
	mustRandom(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(b[0:4]), hex.EncodeToString(b[4:6]), hex.EncodeToString(b[6:8]), hex.EncodeToString(b[8:10]), hex.EncodeToString(b[10:16]))
}

func TokenHash(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

type PolicyRule struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Enabled     bool     `json:"enabled"`
	Priority    int      `json:"priority"`
	Action      string   `json:"action"`
	Categories  []string `json:"categories"`
	MinSeverity string   `json:"min_severity"`
	Providers   []string `json:"providers"`
	Tags        []string `json:"tags"`
}

func UTCTime(s string) (time.Time, error) {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return t, err
	}
	if len(s) >= 6 && (s[len(s)-6] == '+' || s[len(s)-6] == '-') && s[len(s)-6:len(s)] != "+00:00" && s[len(s)-6:len(s)] != "-00:00" {
		return t, errors.New("timestamp must use UTC")
	}
	return t.UTC(), nil
}

func (p *Policy) UnmarshalJSON(data []byte) error {
	type plain Policy
	var decoded plain
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*p = Policy(decoded)
	var raw struct {
		GeneratedAt string `json:"generated_at"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if raw.GeneratedAt != "" {
		parsed, err := UTCTime(raw.GeneratedAt)
		if err != nil {
			return fmt.Errorf("generated_at: %w", err)
		}
		p.GeneratedAt = parsed
	}
	return nil
}

type Policy struct {
	Version          string       `json:"version"`
	GeneratedAt      time.Time    `json:"generated_at"`
	FailureMode      string       `json:"failure_mode"`
	AllowedFileTypes []string     `json:"allowed_file_types"`
	Tags             []string     `json:"tags"`
	Rules            []PolicyRule `json:"rules"`
}

func DefaultPolicy() Policy {
	now := time.Now().UTC().Truncate(time.Second)
	return Policy{
		Version: NewUUID(), GeneratedAt: now, FailureMode: "block",
		AllowedFileTypes: []string{"txt", "csv", "json", "xml", "yaml", "yml", "log", "env", "sql", "py", "js", "ts", "go", "rs"},
		Tags:             []string{"credential", "private_key", "pii", "financial", "identity:id:nik", "environment:env"},
		Rules: []PolicyRule{
			{ID: NewUUID(), Name: "Block credentials", Enabled: true, Priority: 10, Action: "block", Categories: []string{"credential", "private_key"}, MinSeverity: "high", Providers: []string{}, Tags: []string{}},
			{ID: NewUUID(), Name: "Audit personal and financial data", Enabled: true, Priority: 20, Action: "audit", Categories: []string{"pii", "financial"}, MinSeverity: "medium", Providers: []string{}, Tags: []string{}},
			{ID: NewUUID(), Name: "Allow complete inspection", Enabled: true, Priority: 1000, Action: "allow", Categories: []string{}, MinSeverity: "low", Providers: []string{}, Tags: []string{}},
		},
	}
}

var actions = set("block", "audit", "allow")
var severities = set("low", "medium", "high", "critical")
var statuses = set("pending_enrollment", "limited", "protected", "degraded")
var inspectionStatuses = set("complete", "incomplete", "failed", "unsupported", "timeout")
var enforcementStatuses = set("pending", "confirmed", "prevented", "failed", "not_required")

func set(values ...string) map[string]bool {
	m := make(map[string]bool, len(values))
	for _, value := range values {
		m[value] = true
	}
	return m
}

func validEnum(value string, allowed map[string]bool) bool { return allowed[value] }

func (p Policy) Validate() error {
	if !UUID(p.Version) {
		return errors.New("version must be a UUID")
	}
	if p.GeneratedAt.IsZero() || p.GeneratedAt.Location() != time.UTC {
		return errors.New("generated_at must be an RFC3339 UTC timestamp")
	}
	if p.FailureMode != "block" && p.FailureMode != "audit" {
		return errors.New("failure_mode must be block or audit")
	}
	if len(p.Rules) == 0 || len(p.Rules) > 100 {
		return errors.New("rules must contain between 1 and 100 items")
	}
	if len(p.AllowedFileTypes) == 0 || len(p.AllowedFileTypes) > 100 || len(p.Tags) > 100 {
		return errors.New("allowed_file_types must contain 1 to 100 items and tags at most 100 items")
	}
	supportedTypes := set("txt", "csv", "json", "xml", "yaml", "yml", "log", "env", "sql", "py", "js", "ts", "go", "rs")
	for _, extension := range p.AllowedFileTypes {
		if !supportedTypes[extension] {
			return errors.New("allowed_file_types must contain supported lowercase file extensions without dots")
		}
	}
	for _, tag := range p.Tags {
		if len(tag) == 0 || len(tag) > 64 || !regexp.MustCompile(`^[a-z][a-z0-9:_-]*$`).MatchString(tag) {
			return errors.New("tags must contain valid lowercase data labels")
		}
	}
	configuredTags := make(map[string]bool, len(p.Tags))
	for _, tag := range p.Tags {
		configuredTags[tag] = true
	}
	ids := map[string]bool{}
	priorities := map[int]bool{}
	for i, rule := range p.Rules {
		if !UUID(rule.ID) {
			return fmt.Errorf("rules[%d].id must be a UUID", i)
		}
		if ids[rule.ID] {
			return fmt.Errorf("rules[%d].id must be unique", i)
		}
		ids[rule.ID] = true
		if priorities[rule.Priority] {
			return fmt.Errorf("rules[%d].priority must be unique", i)
		}
		priorities[rule.Priority] = true
		if strings.TrimSpace(rule.Name) == "" || len(rule.Name) > 120 {
			return fmt.Errorf("rules[%d].name must contain 1 to 120 characters", i)
		}
		if rule.Priority < 0 || rule.Priority > 100000 {
			return fmt.Errorf("rules[%d].priority must be between 0 and 100000", i)
		}
		if !validEnum(rule.Action, actions) || !validEnum(rule.MinSeverity, severities) {
			return fmt.Errorf("rules[%d] has an invalid action or min_severity", i)
		}
		if len(rule.Categories) > 30 || len(rule.Providers) > 30 {
			return fmt.Errorf("rules[%d] has too many categories or providers", i)
		}
		if len(rule.Tags) > 50 {
			return fmt.Errorf("rules[%d] has too many tags", i)
		}
		if rule.Categories == nil || rule.Providers == nil {
			return fmt.Errorf("rules[%d].categories and providers must be arrays", i)
		}
		for _, category := range rule.Categories {
			if !categoryPattern.MatchString(category) {
				return fmt.Errorf("rules[%d] contains an invalid category", i)
			}
		}
		for _, provider := range rule.Providers {
			if !categoryPattern.MatchString(provider) {
				return fmt.Errorf("rules[%d] contains an invalid provider", i)
			}
		}
		for _, tag := range rule.Tags {
			if len(tag) == 0 || len(tag) > 64 || !regexp.MustCompile(`^[a-z][a-z0-9:_-]*$`).MatchString(tag) {
				return fmt.Errorf("rules[%d] contains an invalid tag", i)
			}
			if !configuredTags[tag] {
				return fmt.Errorf("rules[%d] references a tag that is not enabled by the policy", i)
			}
		}
	}
	return nil
}

type Finding struct {
	Category string `json:"category"`
	Severity string `json:"severity"`
	Detector string `json:"detector"`
}

type Event struct {
	EventID              string    `json:"event_id"`
	OccurredAt           time.Time `json:"occurred_at"`
	Channel              string    `json:"channel"`
	Provider             string    `json:"provider"`
	Application          string    `json:"application"`
	FileName             string    `json:"file_name"`
	FileSize             int64     `json:"file_size"`
	SHA256               string    `json:"sha256"`
	InspectionStatus     string    `json:"inspection_status"`
	InspectionComplete   bool      `json:"inspection_complete"`
	PolicyDecision       string    `json:"policy_decision"`
	EnforcementComponent string    `json:"enforcement_component"`
	EnforcementStatus    string    `json:"enforcement_status"`
	EnforcementConfirmed bool      `json:"enforcement_confirmed"`
	Findings             []Finding `json:"findings"`
	RiskScore            int       `json:"risk_score"`
	PolicyVersion        string    `json:"policy_version"`
}

func (e *Event) UnmarshalJSON(data []byte) error {
	type plain Event
	var decoded plain
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil {
		return err
	}
	*e = Event(decoded)
	var raw struct {
		OccurredAt string `json:"occurred_at"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	if raw.OccurredAt != "" {
		parsed, err := UTCTime(raw.OccurredAt)
		if err != nil {
			return fmt.Errorf("occurred_at: %w", err)
		}
		e.OccurredAt = parsed
	}
	return nil
}

func (e Event) Severity() string {
	severity := "low"
	for _, finding := range e.Findings {
		if severityRank(finding.Severity) > severityRank(severity) {
			severity = finding.Severity
		}
	}
	return severity
}

func severityRank(s string) int {
	return map[string]int{"low": 0, "medium": 1, "high": 2, "critical": 3}[s]
}

func (e Event) Validate() error {
	if !UUID(e.EventID) || !UUID(e.PolicyVersion) {
		return errors.New("event_id and policy_version must be UUIDs")
	}
	if e.OccurredAt.IsZero() || e.OccurredAt.Location() != time.UTC {
		return errors.New("occurred_at must be an RFC3339 UTC timestamp")
	}
	if e.OccurredAt.After(time.Now().Add(5 * time.Minute)) {
		return errors.New("occurred_at cannot be more than five minutes in the future")
	}
	if e.Channel != "browser" {
		return errors.New("channel must be browser in this release")
	}
	if !categoryPattern.MatchString(e.Provider) {
		return errors.New("provider is invalid")
	}
	if len(e.Application) == 0 || len(e.Application) > 120 || len(e.FileName) > 255 || e.FileSize < 0 || e.FileSize > 1<<40 {
		return errors.New("application, file_name, or file_size is invalid")
	}
	if e.SHA256 != "" && !shaPattern.MatchString(e.SHA256) {
		return errors.New("sha256 must contain 64 lowercase hexadecimal characters or be empty")
	}
	if e.FileName == "" && (e.FileSize != 0 || e.SHA256 != "") {
		return errors.New("prompt events cannot include file metadata")
	}
	if e.FileName != "" && e.SHA256 == "" {
		return errors.New("file events must include sha256")
	}
	if !validEnum(e.InspectionStatus, inspectionStatuses) || !validEnum(e.PolicyDecision, actions) || !validEnum(e.EnforcementStatus, enforcementStatuses) {
		return errors.New("inspection, policy, or enforcement status is invalid")
	}
	if e.InspectionComplete != (e.InspectionStatus == "complete") {
		return errors.New("inspection_complete must agree with inspection_status")
	}
	if !e.InspectionComplete && e.PolicyDecision == "allow" {
		return errors.New("incomplete inspection cannot be allowed")
	}
	if e.EnforcementConfirmed != (e.EnforcementStatus == "confirmed" || e.EnforcementStatus == "prevented") {
		return errors.New("enforcement_confirmed must agree with enforcement_status")
	}
	if e.PolicyDecision == "block" && e.EnforcementStatus != "prevented" && e.EnforcementStatus != "pending" && e.EnforcementStatus != "failed" {
		return errors.New("blocked events must use prevented, pending, or failed enforcement_status")
	}
	if e.PolicyDecision == "allow" && e.EnforcementStatus != "not_required" && e.EnforcementStatus != "confirmed" {
		return errors.New("allowed events must use not_required or confirmed enforcement_status")
	}
	if e.PolicyDecision == "audit" && e.EnforcementStatus != "not_required" && e.EnforcementStatus != "confirmed" {
		return errors.New("audited events must use not_required or confirmed enforcement_status")
	}
	if len(e.EnforcementComponent) == 0 || len(e.EnforcementComponent) > 120 || e.RiskScore < 0 || e.RiskScore > 100 {
		return errors.New("enforcement_component or risk_score is invalid")
	}
	if len(e.Findings) > 100 {
		return errors.New("findings cannot contain more than 100 items")
	}
	for i, finding := range e.Findings {
		if !categoryPattern.MatchString(finding.Category) || !validEnum(finding.Severity, severities) || !detectorPattern.MatchString(finding.Detector) {
			return fmt.Errorf("findings[%d] is invalid", i)
		}
	}
	return nil
}

func ValidateText(value, field string, max int) error {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > max {
		return fmt.Errorf("%s must contain 1 to %d characters", field, max)
	}
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("%s contains control characters", field)
		}
	}
	return nil
}

type Device struct {
	ID                    string     `json:"id"`
	Hostname              string     `json:"hostname"`
	OS                    string     `json:"os"`
	AgentVersion          string     `json:"agent_version"`
	Status                string     `json:"status"`
	InspectionEngineReady bool       `json:"inspection_engine_ready"`
	BrowserConnected      bool       `json:"browser_connected"`
	EnrolledAt            time.Time  `json:"enrolled_at"`
	LastSeenAt            *time.Time `json:"last_seen_at"`
	RevokedAt             *time.Time `json:"revoked_at"`
	PolicyVersion         *string    `json:"policy_version"`
}

type PairingCode struct {
	ID         string    `json:"id"`
	Ciphertext []byte    `json:"-"`
	Code       string    `json:"code"`
	CreatedAt  time.Time `json:"created_at"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type EventFilters struct {
	Provider, Severity, Outcome, DeviceID string
	Limit                                 int
}

type Overview struct {
	TotalDevices     int     `json:"total_devices"`
	ProtectedDevices int     `json:"protected_devices"`
	DegradedDevices  int     `json:"degraded_devices"`
	PendingDevices   int     `json:"pending_devices"`
	Events24h        int     `json:"events_24h"`
	Blocked24h       int     `json:"blocked_24h"`
	Failed24h        int     `json:"failed_24h"`
	ActivePolicy     *Policy `json:"active_policy"`
}

func ParseIP(value string) string {
	if ip := net.ParseIP(strings.TrimSpace(value)); ip != nil {
		return ip.String()
	}
	return ""
}
