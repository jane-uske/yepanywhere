export interface SessionSourceInfo {
  label: string;
  parentThreadId?: string;
  depth?: number;
  subagentName?: string;
  subagentRole?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function isSessionSourceSubagent(source: unknown): boolean {
  return isRecord(source) && "subagent" in source;
}

export function getSessionSourceInfo(
  source: unknown,
): SessionSourceInfo | null {
  if (source === undefined || source === null) {
    return null;
  }

  if (typeof source === "string") {
    return { label: source };
  }

  if (!isRecord(source)) {
    return { label: String(source) };
  }

  const subagent = source.subagent;
  if (typeof subagent === "string") {
    return { label: "Subagent", subagentName: subagent };
  }

  if (isRecord(subagent)) {
    const threadSpawn = subagent.thread_spawn;
    if (isRecord(threadSpawn)) {
      const parentThreadId = threadSpawn.parent_thread_id;
      const depth = threadSpawn.depth;
      const agentNickname = threadSpawn.agent_nickname;
      const agentRole = threadSpawn.agent_role;
      return {
        label: "Subagent",
        ...(typeof parentThreadId === "string" && { parentThreadId }),
        ...(typeof depth === "number" && { depth }),
        ...(typeof agentNickname === "string" && {
          subagentName: agentNickname,
        }),
        ...(typeof agentRole === "string" && { subagentRole: agentRole }),
      };
    }
    const other = subagent.other;
    return {
      label: "Subagent",
      ...(typeof other === "string" && { subagentName: other }),
    };
  }

  const other = source.other;
  if (typeof other === "string") {
    return { label: other };
  }

  return { label: "Structured source" };
}

export function formatShortSessionId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 8)}...${id.slice(-4)}`;
}
