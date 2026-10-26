import test from "node:test";
import assert from "node:assert/strict";
import { publicUrl, validateConfig, validateTelemetry, onRequest } from "../functions/api/[[route]].js";

test("website targets accept public HTTP origins and reject unsafe schemes, credentials and local addresses", () => {
  assert.equal(publicUrl("https://example.com/#fragment"), "https://example.com/");
  for (const target of ["file:///etc/passwd", "javascript:alert(1)", "http://localhost/", "http://127.0.0.1", "http://2130706433", "http://[::1]", "https://user:pass@example.com", "https://example.com:9000", "http://host.internal"]) {
    assert.throws(() => publicUrl(target), undefined, target);
  }
});

test("configuration removes unknown properties and validates maximum size", () => {
  const result = validateConfig({ websites: [{ name: "Site", url: "https://example.com", kind: "Domain", injected: true }], services: [{ name: "Database", status: "invented", description: "Primary" }] });
  assert.deepEqual(result.websites[0], { name: "Site", url: "https://example.com/", kind: "Domain" });
  assert.equal(result.services[0].status, "Operational");
  assert.throws(() => validateConfig({ websites: Array(11).fill({ name: "Site", url: "https://example.com" }), services: [] }));
  assert.throws(() => validateConfig({ websites: [], services: [{ name: "" }] }));
});

test("telemetry validates shape and bounds numeric values", () => {
  assert.throws(() => validateTelemetry({}));
  const report = validateTelemetry({ host: { name: "host", cpu: 900, memory: -1, network: { up: Infinity } }, containers: [], docker_available: false });
  assert.equal(report.host.cpu, 100);
  assert.equal(report.host.memory, 0);
  assert.equal(report.host.network.up, 0);
  assert.equal(report.docker_available, false);
});

test("private API routes never disclose data without a session", async () => {
  for (const route of ["overview", "config", "connection"]) {
    const response = await onRequest({ request: new Request("https://dashboard.example.com/api/" + route), env: { DB: {} } });
    assert.equal(response.status, 401);
  }
});

test("cross-origin writes are rejected before database access", async () => {
  const response = await onRequest({ request: new Request("https://dashboard.example.com/api/login", { method: "POST", headers: { Origin: "https://attacker.example", "Content-Type": "application/json" }, body: "{}" }), env: { DB: {} } });
  assert.equal(response.status, 403);
});

test("agent ingestion rejects missing and wrong tokens", async () => {
  const response = await onRequest({ request: new Request("https://dashboard.example.com/api/agent", { method: "POST", headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" }, body: "{}" }), env: { DB: {}, AGENT_TOKEN: "a".repeat(64) } });
  assert.equal(response.status, 401);
});

test("preview deployments fail closed without database bindings", async () => {
  const response = await onRequest({ request: new Request("https://preview.example.com/api/session"), env: {} });
  assert.equal(response.status, 503);
});
