import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

function taskStateTags(value: string) {
  const tags: Array<{ id: string; state: string }> = [];
  for (const match of value.matchAll(/<task\b[^>]*>/gi)) {
    const tag = match[0];
    const id = tag.match(/\bid=["']([^"']+)["']/i)?.[1]?.trim() ?? "";
    const state = tag.match(/\bstate=["']([^"']+)["']/i)?.[1]?.trim().toLowerCase() ?? "";
    if (id && state) tags.push({ id, state });
  }
  return tags;
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const pendingBackgroundTasks = new Set<string>();
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = asString(part.text, "").trim();
      if (text) {
        messages.push(text);
        for (const task of taskStateTags(text)) {
          if (task.state === "completed" || task.state === "error") {
            pendingBackgroundTasks.delete(task.id);
          }
        }
      }
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      const metadata = parseObject(state.metadata);
      if (asString(part.tool, "") === "task" && metadata.background === true) {
        const output = asString(state.output, "");
        const tags = taskStateTags(output);
        const runningTags = tags.filter((task) => task.state === "running");
        for (const task of runningTags) pendingBackgroundTasks.add(task.id);
        for (const task of tags) {
          if (task.state === "completed" || task.state === "error") {
            pendingBackgroundTasks.delete(task.id);
          }
        }
        if (runningTags.length === 0 && tags.length === 0) {
          const fallbackId =
            asString(metadata.jobId, "").trim() ||
            asString(metadata.sessionId, "").trim() ||
            `unidentified:${currentSessionId || "background-task"}`;
          pendingBackgroundTasks.add(fallbackId);
        }
      }
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
    pendingBackgroundTasks: [...pendingBackgroundTasks].sort(),
  };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}
