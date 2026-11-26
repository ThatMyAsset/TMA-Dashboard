import assert from "node:assert/strict";
import test from "node:test";
import { eventQuery, highestSeverity } from "../lib/event.ts";
import type { Finding } from "../lib/types.ts";

test("empty findings are low severity", () => {
  assert.equal(highestSeverity([]), "low");
});

test("highest finding severity wins independent of order", () => {
  const findings: Finding[] = [
    { category: "pii", severity: "medium", detector: "email" },
    { category: "credential", severity: "critical", detector: "private_key" },
    { category: "financial", severity: "high", detector: "credit_card" }
  ];
  assert.equal(highestSeverity(findings), "critical");
});

test("event query includes only active filters and bounded limit", () => {
  assert.equal(eventQuery({ provider: "", severity: "", outcome: "" }), "limit=200");
  assert.equal(eventQuery({ provider: "chatgpt", severity: "high", outcome: "block" }), "limit=200&provider=chatgpt&severity=high&outcome=block");
});
