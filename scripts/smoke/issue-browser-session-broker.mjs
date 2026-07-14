#!/usr/bin/env node

import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const SAFE_BROWSER_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ALLOWED_READBACK = new Set(["screenshot", "dom", "iframe", "console", "network_metadata"]);
const MAX_BODY_BYTES = 64 * 1024;
const MAX_EVENTS = 200;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function requiredEnv(env, key) {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function parseTargets(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("PAPERCLIP_BROWSER_BROKER_TARGETS_JSON must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PAPERCLIP_BROWSER_BROKER_TARGETS_JSON must be an object");
  }
  const targets = new Map();
  for (const [sid, rawUrl] of Object.entries(parsed)) {
    if (typeof rawUrl !== "string" || !sid.trim()) throw new Error("Each broker target needs a SID and URL");
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.search || url.hash) {
      throw new Error(`Broker target ${sid} must be an exact HTTPS URL without query or fragment`);
    }
    targets.set(sid, url.toString());
  }
  if (targets.size === 0) throw new Error("At least one broker target is required");
  return targets;
}

function loadConfig(env = process.env) {
  const issueId = requiredEnv(env, "PAPERCLIP_BROWSER_BROKER_ISSUE_ID");
  const profileDir = path.resolve(requiredEnv(env, "PAPERCLIP_BROWSER_BROKER_PROFILE_DIR"));
  if (path.basename(profileDir) !== issueId || path.basename(path.dirname(profileDir)) !== ".paperclip-browser-sessions") {
    throw new Error("Profile directory must end with .paperclip-browser-sessions/<issue-id>");
  }
  const host = env.HOST?.trim() || "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) throw new Error("Browser broker must bind to a loopback host");
  const port = Number(env.PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be a valid TCP port");
  return {
    issueId,
    agentId: requiredEnv(env, "PAPERCLIP_BROWSER_BROKER_AGENT_ID"),
    profileDir,
    host,
    port,
    targets: parseTargets(requiredEnv(env, "PAPERCLIP_BROWSER_BROKER_TARGETS_JSON")),
    chromiumPath: env.PAPERCLIP_BROWSER_BROKER_CHROMIUM_PATH?.trim() || null,
    purgeOnStop: env.PAPERCLIP_BROWSER_BROKER_PURGE_ON_STOP === "true",
    navigationTimeoutMs: Math.min(60_000, Math.max(5_000, Number(env.PAPERCLIP_BROWSER_BROKER_TIMEOUT_MS) || 30_000)),
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function safeUrl(raw) {
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

function safeMessage(raw) {
  return String(raw)
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:token|secret|password|cookie|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function audit(config, input) {
  process.stdout.write(`${JSON.stringify({
    type: "paperclip_issue_browser_broker_audit",
    issueId: config.issueId,
    actorAgentId: input.actorAgentId ?? null,
    runId: input.runId ?? null,
    at: new Date().toISOString(),
    sid: input.sid ?? null,
    viewport: input.viewport ?? null,
    outcome: input.outcome,
    code: input.code ?? null,
  })}\n`);
}

function validateInvocation(config, req, payload) {
  const actorAgentId = req.headers["x-paperclip-actor-agent-id"];
  const issueId = req.headers["x-paperclip-issue-id"];
  const runId = req.headers["x-paperclip-run-id"];
  const operationId = req.headers["x-paperclip-broker-operation"];
  if (
    actorAgentId !== config.agentId
    || issueId !== config.issueId
    || typeof runId !== "string"
    || !runId.trim()
    || operationId !== "member-smoke"
  ) {
    throw Object.assign(new Error("Verified Paperclip broker context is required"), { status: 403, code: "caller_forbidden" });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw Object.assign(new Error("JSON payload is required"), { status: 422, code: "payload_required" });
  }
  const allowedFields = new Set(["sid", "url", "viewport", "readback", "paperclipContext"]);
  if (Object.keys(payload).some((key) => !allowedFields.has(key))) {
    throw Object.assign(new Error("Payload contains a non-allowlisted field"), { status: 403, code: "payload_field_forbidden" });
  }
  const expectedUrl = config.targets.get(payload.sid);
  if (!expectedUrl || payload.url !== expectedUrl) {
    throw Object.assign(new Error("Target SID and URL are not allowlisted"), { status: 403, code: "target_forbidden" });
  }
  if (payload.viewport !== "desktop" && payload.viewport !== "mobile") {
    throw Object.assign(new Error("Viewport is not allowlisted"), { status: 403, code: "viewport_forbidden" });
  }
  if (
    !Array.isArray(payload.readback)
    || payload.readback.length === 0
    || payload.readback.some((item) => !ALLOWED_READBACK.has(item))
  ) {
    throw Object.assign(new Error("Readback selection is not allowlisted"), { status: 403, code: "readback_forbidden" });
  }
  const context = payload.paperclipContext;
  if (
    !context
    || context.actorAgentId !== actorAgentId
    || context.issueId !== issueId
    || context.runId !== runId
    || context.operationId !== operationId
  ) {
    throw Object.assign(new Error("Paperclip body and header context do not match"), { status: 403, code: "context_mismatch" });
  }
  return { actorAgentId, issueId, runId, sid: payload.sid, url: expectedUrl, viewport: payload.viewport, readback: payload.readback };
}

async function readRequestBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large"), { status: 413, code: "payload_too_large" });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Request body must be valid JSON"), { status: 422, code: "invalid_json" });
  }
}

async function runBrowserSmoke(config, input, state) {
  await fs.mkdir(config.profileDir, { recursive: true, mode: 0o700 });
  await fs.chmod(config.profileDir, 0o700);
  const viewport = input.viewport === "mobile"
    ? { width: 390, height: 844 }
    : { width: 1280, height: 900 };
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: true,
    viewport,
    deviceScaleFactor: 1,
    ...(config.chromiumPath ? { executablePath: config.chromiumPath } : {}),
  });
  state.context = context;
  const page = context.pages()[0] ?? await context.newPage();
  const consoleErrors = [];
  const network = [];
  const blockedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error" && consoleErrors.length < MAX_EVENTS) consoleErrors.push(safeMessage(message.text()));
  });
  page.on("pageerror", (error) => {
    if (consoleErrors.length < MAX_EVENTS) consoleErrors.push(safeMessage(error.message));
  });
  page.on("response", (response) => {
    if (network.length >= MAX_EVENTS) return;
    network.push({
      method: response.request().method(),
      url: safeUrl(response.url()),
      status: response.status(),
      resourceType: response.request().resourceType(),
    });
  });
  await page.route("**/*", async (route) => {
    const method = route.request().method().toUpperCase();
    if (!SAFE_BROWSER_METHODS.has(method)) {
      if (blockedRequests.length < MAX_EVENTS) blockedRequests.push({ method, url: safeUrl(route.request().url()) });
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });

  try {
    await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
    await page.waitForTimeout(2_000);
    const finalUrl = page.url();
    const dom = await page.evaluate(() => {
      const text = document.body?.innerText ?? "";
      return {
        title: document.title.slice(0, 200),
        elementCount: document.querySelectorAll("*").length,
        iframeCount: document.querySelectorAll("iframe").length,
        textLength: text.length,
        hasAuthMarker: /anmelden|einloggen|login|sign in/i.test(text),
      };
    });
    const iframeUrls = page.frames().slice(1).map((frame) => safeUrl(frame.url()));
    const authRedirect = (() => {
      try {
        return new URL(finalUrl).pathname.startsWith("/auth");
      } catch {
        return true;
      }
    })();
    if (authRedirect) {
      return {
        status: 409,
        body: {
          ok: false,
          code: "interactive_auth_required",
          sid: input.sid,
          viewport: input.viewport,
          finalUrl: safeUrl(finalUrl),
          dom,
          iframeUrls,
          consoleErrors,
          network,
          blockedRequests,
        },
      };
    }
    const screenshot = await page.screenshot({ type: "png", fullPage: true });
    await fs.writeFile(path.join(config.profileDir, ".session-ready.json"), JSON.stringify({
      verifiedAt: new Date().toISOString(),
      sid: input.sid,
    }), { mode: 0o600 });
    return {
      status: 200,
      body: {
        ok: true,
        sid: input.sid,
        viewport: input.viewport,
        finalUrl: safeUrl(finalUrl),
        ...(input.readback.includes("dom") ? { dom } : {}),
        ...(input.readback.includes("iframe") ? { iframeUrls } : {}),
        ...(input.readback.includes("console") ? { consoleErrors } : {}),
        ...(input.readback.includes("network_metadata") ? { network, blockedRequests } : {}),
        ...(input.readback.includes("screenshot") ? { screenshotPngBase64: screenshot.toString("base64") } : {}),
      },
    };
  } finally {
    await context.close();
    state.context = null;
  }
}

async function start() {
  const config = loadConfig();
  const state = { busy: false, context: null, stopping: false };
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      const sessionReady = await fs.access(path.join(config.profileDir, ".session-ready.json")).then(() => true, () => false);
      sendJson(res, 200, { ok: true, issueId: config.issueId, busy: state.busy, sessionReady });
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/smoke") {
      sendJson(res, 404, { error: "Not found", code: "route_not_found" });
      return;
    }
    if (state.busy || state.stopping) {
      sendJson(res, 409, { error: "Broker is busy", code: "broker_busy" });
      return;
    }
    state.busy = true;
    let input = null;
    try {
      input = validateInvocation(config, req, await readRequestBody(req));
      const result = await runBrowserSmoke(config, input, state);
      audit(config, { ...input, outcome: result.body.ok ? "succeeded" : "blocked", code: result.body.code ?? null });
      sendJson(res, result.status, result.body);
    } catch (error) {
      const status = Number(error?.status) || 500;
      const code = error?.code || "broker_failed";
      audit(config, {
        actorAgentId: input?.actorAgentId ?? null,
        runId: input?.runId ?? null,
        sid: input?.sid ?? null,
        viewport: input?.viewport ?? null,
        outcome: status < 500 ? "denied" : "failed",
        code,
      });
      sendJson(res, status, { error: status < 500 ? error.message : "Browser broker failed", code });
    } finally {
      state.busy = false;
    }
  });

  const stop = async (signal) => {
    if (state.stopping) return;
    state.stopping = true;
    server.close();
    await state.context?.close().catch(() => undefined);
    if (config.purgeOnStop) await fs.rm(config.profileDir, { recursive: true, force: true });
    audit(config, { outcome: "stopped", code: signal, actorAgentId: null, runId: null, sid: null, viewport: null });
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : config.port;
    process.stdout.write(`${JSON.stringify({ type: "paperclip_issue_browser_broker_ready", issueId: config.issueId, host: config.host, port })}\n`);
  });
}

start().catch((error) => {
  process.stderr.write(`issue browser session broker failed to start: ${safeMessage(error?.message ?? error)}\n`);
  process.exit(1);
});
