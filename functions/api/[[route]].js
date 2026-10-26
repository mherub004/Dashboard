const encoder = new TextEncoder();
const COOKIE = "__Host-dashboard";
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra }
});
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const now = () => Math.floor(Date.now() / 1000);
const hex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
async function digest(value) { return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value))); }
async function passwordHash(password, salt = crypto.randomUUID()) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt: encoder.encode(salt), iterations: 100000, hash: "SHA-256" }, key, 256);
  return salt + ":" + hex(bits);
}
function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return mismatch === 0;
}
function cookieToken(request) {
  return (request.headers.get("Cookie") || "").split(";").map(x => x.trim()).find(x => x.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1) || "";
}
function cookie(token, maxAge) { return COOKIE + "=" + token + "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=" + maxAge; }
async function session(request, db) {
  const token = cookieToken(request);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = await digest(token);
  return await db.prepare("SELECT token_hash FROM sessions WHERE token_hash=? AND expires>?").bind(hash, now()).first();
}
async function body(request) {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) fail("Send JSON", 415);
  if (Number(request.headers.get("Content-Length") || 0) > 65536) fail("Request too large", 413);
  const text = await request.text();
  if (text.length > 65536) fail("Request too large", 413);
  try { const data = JSON.parse(text); if (!data || typeof data !== "object" || Array.isArray(data)) fail("Invalid request"); return data; }
  catch { fail("Invalid JSON"); }
}
async function rateLimit(db, key, limit, window = 900) {
  const time = now();
  const row = await db.prepare("INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires<=? THEN 1 ELSE count+1 END, expires=CASE WHEN expires<=? THEN ? ELSE expires END RETURNING count")
    .bind(key, time + window, time, time, time + window).first();
  if (row.count > limit) fail("Too many attempts. Please try again later.", 429);
}
function text(value, max = 80) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }
function number(value, max = Number.MAX_SAFE_INTEGER) { return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0; }
export function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail("Enter a valid HTTP or HTTPS website address"); }
  const host = url.hostname.toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      (url.port && !["80", "443"].includes(url.port)) || !/^[a-z0-9.-]+$/.test(host) ||
      !host.includes(".") || !/[a-z]/.test(host) || host.endsWith(".") ||
      /(^|\.)(localhost|local|internal|test|invalid|onion)$/.test(host) || /^(\d+\.){3}\d+$/.test(host) ||
      host === "metadata.google.internal") fail("Use a public domain with HTTP or HTTPS on a standard port");
  url.hash = "";
  return url.href;
}
export function validateConfig(data) {
  if (!Array.isArray(data.websites) || !Array.isArray(data.services) || data.websites.length > 10 || data.services.length > 50) fail("Maximum 10 websites and 50 services");
  return {
    websites: data.websites.map(x => {
      if (!x || !text(x.name)) fail("Give every website a name");
      return { name: text(x.name), url: publicUrl(x.url), kind: x.kind === "Domain" ? "Domain" : "Website" };
    }),
    services: data.services.map(x => {
      if (!x || !text(x.name)) fail("Give every service a name");
      return { name: text(x.name), description: text(x.description, 160), status: ["Operational", "Maintenance", "Degraded"].includes(x.status) ? x.status : "Operational" };
    })
  };
}
export function validateTelemetry(data) {
  if (!data.host || typeof data.host !== "object" || !text(data.host.name) || !Array.isArray(data.containers)) fail("Invalid agent report");
  const h = data.host, n = h.network || {};
  return {
    host: {
      name: text(h.name), cpu: number(h.cpu, 100), memory: number(h.memory, 100),
      memory_used: number(h.memory_used), memory_total: number(h.memory_total),
      disk: number(h.disk, 100), disk_used: number(h.disk_used), disk_total: number(h.disk_total),
      uptime: number(h.uptime),
      network: { sent: number(n.sent), received: number(n.received), up: number(n.up), down: number(n.down), interfaces: text(n.interfaces, 200) }
    },
    docker_available: data.docker_available === true,
    docker_error: data.docker_available === true ? null : ["permission_denied", "socket_missing", "daemon_unreachable"].includes(data.docker_error) ? data.docker_error : "unknown",
    containers: data.containers.slice(0, 100).map(c => ({
      id: text(c.id, 16), name: text(c.name), status: text(c.status, 24), cpu: number(c.cpu), memory: number(c.memory),
      image: text(c.image, 160), stats_available: c.stats_available === true
    }))
  };
}
async function configuration(db) {
  const row = await db.prepare("SELECT value FROM settings WHERE id='config'").first();
  return row ? JSON.parse(row.value) : { websites: [], services: [] };
}
async function checkSite(site, db) {
  const cached = await db.prepare("SELECT data,checked_at FROM checks WHERE url=?").bind(site.url).first();
  if (cached && now() - cached.checked_at < 60) return { ...site, ...JSON.parse(cached.data) };
  const start = Date.now();
  let result = { status: "Offline", code: null, latency: null, checked_at: now() };
  try {
    let target = publicUrl(site.url);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const response = await fetch(target, { method: "GET", redirect: "manual", signal: controller.signal, headers: { "User-Agent": "MTechInfraDashboard/1.0" } });
        const code = response.status;
        await response.body?.cancel();
        if ([301, 302, 303, 307, 308].includes(code) && response.headers.get("Location")) {
          if (redirects === 3) throw new Error("Too many redirects");
          target = publicUrl(new URL(response.headers.get("Location"), target).href);
          continue;
        }
        result = { status: code >= 200 && code < 400 ? "Online" : "Degraded", code, latency: Date.now() - start, checked_at: now() };
        break;
      }
    } finally { clearTimeout(timeout); }
  } catch { /* A failed request is an availability result, not an API failure. */ }
  await db.prepare("INSERT INTO checks(url,data,checked_at) VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET data=excluded.data,checked_at=excluded.checked_at")
    .bind(site.url, JSON.stringify(result), now()).run();
  return { ...site, ...result };
}
export async function onRequest({ request, env }) {
  try {
    const path = new URL(request.url).pathname.replace(/\/+$/, "");
    const method = request.method;
    if (!env.DB) return json({ detail: "This preview has no production database." }, 503);
    if (path === "/api/health" && method === "GET") return json({ status: "ok" });
    if (path === "/api/agent" && method === "POST") {
      const supplied = request.headers.get("Authorization") || "";
      if (!env.AGENT_TOKEN || !equal(await digest(supplied), await digest("Bearer " + env.AGENT_TOKEN))) fail("Invalid agent token", 401);
      await rateLimit(env.DB, "agent", 12, 60);
      const report = validateTelemetry(await body(request));
      await env.DB.prepare("INSERT INTO telemetry(id,data,received_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,received_at=excluded.received_at")
        .bind(JSON.stringify(report), now()).run();
      return json({ accepted: true });
    }
    if (!["GET", "HEAD"].includes(method)) {
      const origin = request.headers.get("Origin");
      if (origin !== new URL(request.url).origin) fail("Invalid request origin", 403);
    }
    if (path === "/api/login" && method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      await rateLimit(env.DB, "login:" + await digest(ip), 8);
      const input = await body(request);
      const username = text(input.username);
      const record = await env.DB.prepare("SELECT password_hash FROM users WHERE username='admin'").first();
      if (!record) fail("Admin account is not configured", 503);
      const supplied = await passwordHash(typeof input.password === "string" ? input.password.slice(0, 256) : "", record.password_hash.split(":")[0]);
      if (username !== "admin" || !equal(supplied, record.password_hash)) fail("The username or password is incorrect", 401);
      const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
      await env.DB.batch([
        env.DB.prepare("DELETE FROM sessions WHERE expires<=?").bind(now()),
        env.DB.prepare("DELETE FROM rate_limits WHERE expires<=?").bind(now()),
        env.DB.prepare("INSERT INTO sessions(token_hash,expires) VALUES(?,?)").bind(await digest(token), now() + 43200)
      ]);
      return json({ authenticated: true, username: "admin" }, 200, { "Set-Cookie": cookie(token, 43200) });
    }
    const current = await session(request, env.DB);
    if (path === "/api/session" && method === "GET") return json({ authenticated: !!current, username: current ? "admin" : null });
    if (!current) fail("Sign in to continue", 401);
    if (path === "/api/logout" && method === "POST") {
      await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(current.token_hash).run();
      return json({ authenticated: false }, 200, { "Set-Cookie": cookie("", 0) });
    }
    if (path === "/api/password" && method === "POST") {
      await rateLimit(env.DB, "password", 8);
      const input = await body(request);
      if (typeof input.new_password !== "string" || input.new_password.length < 16 || input.new_password.length > 128) fail("Use a password between 16 and 128 characters");
      const record = await env.DB.prepare("SELECT password_hash FROM users WHERE username='admin'").first();
      if (!equal(await passwordHash(String(input.current_password || ""), record.password_hash.split(":")[0]), record.password_hash)) fail("Current password is incorrect", 401);
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET password_hash=? WHERE username='admin'").bind(await passwordHash(input.new_password)),
        env.DB.prepare("DELETE FROM sessions")
      ]);
      return json({ changed: true }, 200, { "Set-Cookie": cookie("", 0) });
    }
    if (path === "/api/connection" && method === "GET") return json({ dashboard_url: new URL(request.url).origin, agent_token: env.AGENT_TOKEN });
    if (path === "/api/config" && method === "GET") return json(await configuration(env.DB));
    if (path === "/api/config" && method === "PUT") {
      const config = validateConfig(await body(request));
      await env.DB.batch([
        env.DB.prepare("INSERT INTO settings(id,value) VALUES('config',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").bind(JSON.stringify(config)),
        env.DB.prepare("DELETE FROM checks")
      ]);
      return json(config);
    }
    if (path === "/api/notes" && method === "GET") {
      const row = await env.DB.prepare("SELECT value FROM settings WHERE id='notes'").first();
      return json({ notes: row ? JSON.parse(row.value) : {} });
    }
    if (path === "/api/notes" && method === "PUT") {
      const input = await body(request);
      const date = typeof input.date === "string" ? new Date(input.date + "T12:00:00.000Z") : null;
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date) || Number.isNaN(date.getTime()) || date.toISOString().slice(0,10) !== input.date) fail("Choose a valid calendar date");
      if (typeof input.note !== "string" || input.note.length > 2000) fail("Notes can be up to 2,000 characters");
      const row = await env.DB.prepare("SELECT value FROM settings WHERE id='notes'").first();
      const notes = row ? JSON.parse(row.value) : {};
      if (input.note.trim()) notes[input.date] = input.note.trim(); else delete notes[input.date];
      await env.DB.prepare("INSERT INTO settings(id,value) VALUES('notes',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").bind(JSON.stringify(notes)).run();
      return json({ saved: true, date: input.date });
    }
    if (path === "/api/overview" && method === "GET") {
      const config = await configuration(env.DB);
      const report = await env.DB.prepare("SELECT data,received_at FROM telemetry WHERE id=1").first();
      const live = !!report && now() - report.received_at < 120;
      const metrics = report ? JSON.parse(report.data) : { host: null, containers: [], docker_available: false, docker_error: "unknown" };
      const websites = [];
      for (let i = 0; i < config.websites.length; i += 4) {
        websites.push(...await Promise.all(config.websites.slice(i, i + 4).map(s => checkSite(s, env.DB))));
      }
      return json({ ...metrics, agent_connected: live, received_at: report?.received_at || null, websites, services: config.services, checked_at: new Date().toISOString() });
    }
    return json({ detail: "Endpoint not found" }, 404);
  } catch (error) {
    if (error.status) return json({ detail: error.message }, error.status);
    console.error("Dashboard API failure", error.name);
    return json({ detail: "The dashboard could not complete this request. Please try again." }, 500);
  }
}
