import type { AppContentBlock, Message } from "../types";

export type InspectorProgressStatus = "pending" | "in_progress" | "completed";

export interface InspectorProgressItem {
  label: string;
  status: InspectorProgressStatus;
}

export interface InspectorGeneratedResult {
  kind: "url";
  label: string;
  href: string;
}

interface ToolUseLike {
  name: string;
  input: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeToolName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeProgressStatus(status: unknown): InspectorProgressStatus {
  if (typeof status !== "string") return "pending";
  const normalized = status.trim().toLowerCase();
  if (
    normalized === "completed" ||
    normalized === "complete" ||
    normalized === "done"
  ) {
    return "completed";
  }
  if (
    normalized === "in_progress" ||
    normalized === "in-progress" ||
    normalized === "active" ||
    normalized === "running"
  ) {
    return "in_progress";
  }
  return "pending";
}

function getMessageBlocks(message: Message): AppContentBlock[] {
  const blocks: AppContentBlock[] = [];
  if (Array.isArray(message.content)) {
    blocks.push(...message.content);
  }
  if (Array.isArray(message.message?.content)) {
    blocks.push(...message.message.content);
  }
  return blocks;
}

function getToolUses(message: Message): ToolUseLike[] {
  const tools: ToolUseLike[] = [];
  if (
    message.toolUse &&
    typeof message.toolUse.name === "string" &&
    "input" in message.toolUse
  ) {
    tools.push({
      name: message.toolUse.name,
      input: message.toolUse.input,
    });
  }

  for (const block of getMessageBlocks(message)) {
    if (
      isRecord(block) &&
      block.type === "tool_use" &&
      typeof block.name === "string"
    ) {
      tools.push({
        name: block.name,
        input: block.input,
      });
    }
  }

  return tools;
}

function extractUpdatePlanItems(input: unknown): InspectorProgressItem[] {
  if (!isRecord(input) || !Array.isArray(input.plan)) return [];
  return input.plan
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && typeof item.step === "string",
    )
    .map((item) => ({
      label: String(item.step).trim(),
      status: normalizeProgressStatus(item.status),
    }))
    .filter((item) => item.label.length > 0);
}

function extractTodoItems(input: unknown): InspectorProgressItem[] {
  if (!isRecord(input) || !Array.isArray(input.todos)) return [];
  return input.todos
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && typeof item.content === "string",
    )
    .map((item) => ({
      label: String(item.content).trim(),
      status: normalizeProgressStatus(item.status),
    }))
    .filter((item) => item.label.length > 0);
}

export function extractInspectorProgress(
  messages: Message[],
): InspectorProgressItem[] {
  let latestPlan: InspectorProgressItem[] = [];
  let latestTodos: InspectorProgressItem[] = [];

  for (const message of messages) {
    for (const tool of getToolUses(message)) {
      const toolName = normalizeToolName(tool.name);
      if (toolName === "updateplan") {
        const items = extractUpdatePlanItems(tool.input);
        if (items.length > 0) latestPlan = items;
      } else if (toolName === "todowrite") {
        const items = extractTodoItems(tool.input);
        if (items.length > 0) latestTodos = items;
      }
    }
  }

  return latestPlan.length > 0 ? latestPlan : latestTodos;
}

function getMessageTextParts(message: Message): string[] {
  const parts: string[] = [];
  if (message.type === "user" || message.role === "user") {
    return parts;
  }

  if (typeof message.content === "string") {
    parts.push(message.content);
  }
  if (typeof message.message?.content === "string") {
    parts.push(message.message.content);
  }

  for (const block of getMessageBlocks(message)) {
    if (!isRecord(block)) continue;
    const blockType = typeof block.type === "string" ? block.type : "";
    if (blockType === "tool_use" || blockType === "tool_result") {
      continue;
    }
    if (typeof block.text === "string") {
      parts.push(block.text);
    }
    if (
      (blockType === "" || blockType === "text") &&
      typeof block.content === "string"
    ) {
      parts.push(block.content);
    }
  }

  return parts;
}

function normalizeUrlLabel(href: string): string {
  return href.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function extractGeneratedResults(
  messages: Message[],
  limit = 6,
): InspectorGeneratedResult[] {
  const results: InspectorGeneratedResult[] = [];
  const seen = new Set<string>();
  const urlPattern =
    /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/[^\s\\)"'<>]*)?/gi;

  for (const message of messages) {
    for (const text of getMessageTextParts(message)) {
      for (const match of text.matchAll(urlPattern)) {
        const href = match[0].replace(/[\\),.;]+$/, "");
        if (seen.has(href)) continue;
        seen.add(href);
        results.push({
          kind: "url",
          label: normalizeUrlLabel(href),
          href,
        });
        if (results.length >= limit) return results;
      }
    }
  }

  return results;
}
