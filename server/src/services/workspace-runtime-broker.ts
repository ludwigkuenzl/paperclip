const SENSITIVE_FIELD_PATTERN =
  /(^|[-_])(api[-_]?key|auth(?:orization)?|bearer|cookies?|credential|headers?|jwt|password|passwd|private[-_]?key|refresh[-_]?token|secret|session|token)([-_]|$)/i;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

type JsonScalar = string | number | boolean | null;
type JsonValue = JsonScalar | JsonValue[] | { [key: string]: JsonValue };

interface RuntimeBrokerOperation {
  id: string;
  method: "GET" | "POST";
  path: string;
  readOnly: true;
  agentIds: string[];
  issueIds: string[];
  requiredFields: string[];
  payloadAllowlist: Record<string, JsonScalar[]>;
  auditFields: string[];
  maxResponseBytes: number;
  timeoutMs: number;
}

export interface RuntimeBrokerContext {
  actorAgentId: string;
  issueId: string;
  runId: string;
  operationId: string;
}

export interface RuntimeBrokerInvocationResult {
  status: number;
  body: JsonValue;
}

export class RuntimeBrokerPolicyError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RuntimeBrokerPolicyError";
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(readString)
    .filter((item): item is string => Boolean(item));
}

function readBoundedInteger(value: unknown, fallback: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(value)));
}

function isJsonScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isSensitiveField(field: string) {
  const normalized = field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  return SENSITIVE_FIELD_PATTERN.test(normalized);
}

function readPayloadAllowlist(value: unknown): Record<string, JsonScalar[]> {
  if (!isRecord(value)) return {};
  const result: Record<string, JsonScalar[]> = {};
  for (const [key, allowed] of Object.entries(value)) {
    if (isSensitiveField(key) || !Array.isArray(allowed)) continue;
    const scalars = allowed.filter(isJsonScalar);
    if (scalars.length > 0) result[key] = scalars;
  }
  return result;
}

function scalarMatches(value: JsonScalar, allowed: JsonScalar[]) {
  return allowed.some((candidate) => Object.is(candidate, value));
}

function validateAllowedValue(field: string, value: unknown, allowed: JsonScalar[]) {
  if (Array.isArray(value)) {
    if (value.length === 0 || value.some((item) => !isJsonScalar(item) || !scalarMatches(item, allowed))) {
      throw new RuntimeBrokerPolicyError(403, "payload_value_forbidden", `Payload field "${field}" contains a forbidden value`);
    }
    return;
  }
  if (!isJsonScalar(value) || !scalarMatches(value, allowed)) {
    throw new RuntimeBrokerPolicyError(403, "payload_value_forbidden", `Payload field "${field}" contains a forbidden value`);
  }
}

export function readRuntimeBrokerOperation(serviceConfig: unknown, operationId: string): RuntimeBrokerOperation {
  const broker = isRecord(serviceConfig) ? serviceConfig.broker : null;
  if (!isRecord(broker) || broker.enabled !== true) {
    throw new RuntimeBrokerPolicyError(404, "broker_disabled", "Runtime broker is not enabled for this service");
  }
  const operations = Array.isArray(broker.operations)
    ? broker.operations.filter(isRecord)
    : [];
  const raw = operations.find((operation) => readString(operation.id) === operationId);
  if (!raw) {
    throw new RuntimeBrokerPolicyError(404, "operation_not_found", "Runtime broker operation is not configured");
  }

  const method = readString(raw.method)?.toUpperCase();
  const path = readString(raw.path);
  const agentIds = readStringArray(raw.agentIds);
  const issueIds = readStringArray(raw.issueIds);
  if (raw.readOnly !== true || (method !== "GET" && method !== "POST") || !path?.startsWith("/")) {
    throw new RuntimeBrokerPolicyError(422, "operation_not_read_only", "Runtime broker operation must be explicitly read-only and use GET or POST");
  }
  if (agentIds.length === 0 || issueIds.length === 0) {
    throw new RuntimeBrokerPolicyError(422, "operation_allowlist_missing", "Runtime broker operation needs non-empty agent and issue allowlists");
  }

  return {
    id: operationId,
    method,
    path,
    readOnly: true,
    agentIds,
    issueIds,
    requiredFields: readStringArray(raw.requiredFields),
    payloadAllowlist: readPayloadAllowlist(raw.payloadAllowlist),
    auditFields: readStringArray(raw.auditFields).filter((field) => !isSensitiveField(field)),
    maxResponseBytes: readBoundedInteger(raw.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES),
    timeoutMs: readBoundedInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
  };
}

export function validateRuntimeBrokerInvocation(input: {
  operation: RuntimeBrokerOperation;
  context: RuntimeBrokerContext;
  payload: unknown;
}): Record<string, JsonValue> {
  const { operation, context } = input;
  if (!operation.agentIds.includes(context.actorAgentId)) {
    throw new RuntimeBrokerPolicyError(403, "actor_forbidden", "Runtime broker actor is not allowed");
  }
  if (!operation.issueIds.includes(context.issueId)) {
    throw new RuntimeBrokerPolicyError(403, "issue_forbidden", "Runtime broker issue is not allowed");
  }
  if (!isRecord(input.payload)) {
    throw new RuntimeBrokerPolicyError(422, "payload_required", "Runtime broker payload must be a JSON object");
  }
  for (const field of operation.requiredFields) {
    if (!Object.prototype.hasOwnProperty.call(input.payload, field)) {
      throw new RuntimeBrokerPolicyError(422, "payload_field_required", `Payload field "${field}" is required`);
    }
  }

  const payload: Record<string, JsonValue> = {};
  for (const [field, value] of Object.entries(input.payload)) {
    if (isSensitiveField(field)) {
      throw new RuntimeBrokerPolicyError(403, "sensitive_field_forbidden", `Sensitive payload field "${field}" is forbidden`);
    }
    const allowed = operation.payloadAllowlist[field];
    if (!allowed) {
      throw new RuntimeBrokerPolicyError(403, "payload_field_forbidden", `Payload field "${field}" is not allowlisted`);
    }
    validateAllowedValue(field, value, allowed);
    payload[field] = value as JsonValue;
  }
  return payload;
}

export function redactRuntimeBrokerJson(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(redactRuntimeBrokerJson);
  if (!isRecord(value)) return isJsonScalar(value) ? value : String(value);
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = isSensitiveField(key) ? "[REDACTED]" : redactRuntimeBrokerJson(child);
  }
  return result;
}

export function selectRuntimeBrokerAuditFields(
  operation: RuntimeBrokerOperation,
  payload: Record<string, JsonValue>,
) {
  const audit: Record<string, JsonValue> = {};
  for (const field of operation.auditFields) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) audit[field] = payload[field]!;
  }
  return audit;
}

function resolveLoopbackOperationUrl(serviceUrl: string, operationPath: string) {
  let base: URL;
  try {
    base = new URL(serviceUrl);
  } catch {
    throw new RuntimeBrokerPolicyError(422, "service_url_invalid", "Runtime broker service URL is invalid");
  }
  if (base.protocol !== "http:" || !LOOPBACK_HOSTS.has(base.hostname)) {
    throw new RuntimeBrokerPolicyError(403, "service_url_forbidden", "Runtime broker only invokes loopback HTTP services");
  }
  const target = new URL(operationPath, `${base.origin}/`);
  if (target.origin !== base.origin) {
    throw new RuntimeBrokerPolicyError(403, "operation_url_forbidden", "Runtime broker operation escaped the configured service origin");
  }
  return target.toString();
}

export async function invokeRuntimeBroker(input: {
  serviceUrl: string;
  serviceConfig: unknown;
  context: RuntimeBrokerContext;
  payload: unknown;
  fetchImpl?: typeof fetch;
}): Promise<RuntimeBrokerInvocationResult> {
  const operation = readRuntimeBrokerOperation(input.serviceConfig, input.context.operationId);
  const payload = validateRuntimeBrokerInvocation({ operation, context: input.context, payload: input.payload });
  const targetUrl = resolveLoopbackOperationUrl(input.serviceUrl, operation.path);
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(targetUrl, {
    method: operation.method,
    redirect: "error",
    signal: AbortSignal.timeout(operation.timeoutMs),
    headers: {
      "content-type": "application/json",
      "x-paperclip-actor-agent-id": input.context.actorAgentId,
      "x-paperclip-issue-id": input.context.issueId,
      "x-paperclip-run-id": input.context.runId,
      "x-paperclip-broker-operation": operation.id,
    },
    body: operation.method === "POST"
      ? JSON.stringify({
          ...payload,
          paperclipContext: {
            actorAgentId: input.context.actorAgentId,
            issueId: input.context.issueId,
            runId: input.context.runId,
            operationId: operation.id,
          },
        })
      : undefined,
  });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new RuntimeBrokerPolicyError(502, "response_content_type_forbidden", "Runtime broker upstream must return application/json");
  }
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > operation.maxResponseBytes) {
    throw new RuntimeBrokerPolicyError(502, "response_too_large", "Runtime broker upstream response exceeded the configured byte limit");
  }
  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    throw new RuntimeBrokerPolicyError(502, "response_invalid_json", "Runtime broker upstream returned invalid JSON");
  }
  return {
    status: response.status,
    body: redactRuntimeBrokerJson(parsed),
  };
}
