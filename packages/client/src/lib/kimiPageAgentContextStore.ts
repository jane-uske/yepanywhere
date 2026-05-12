import type { KimiPageAgentContext } from "./kimiPageAgentBridge";

const STORAGE_KEY = "kimi-page-agent.current-context";

export interface StoredKimiPageAgentContext {
  id: string;
  updatedAt: string;
  context: KimiPageAgentContext;
}

export function createKimiPageAgentContextId(
  context: KimiPageAgentContext,
): string {
  const selector =
    context.selection?.paths?.baseScrollPath ??
    context.selection?.paths?.selector ??
    "";
  const route =
    context.page?.shell?.pathname ??
    context.page?.alime?.currentPage?.path ??
    "";
  const text = context.selection?.element?.text?.slice(0, 80) ?? "";
  return [context.tab?.url ?? "", route, selector, text]
    .filter(Boolean)
    .join("::");
}

export function readKimiPageAgentContext(): StoredKimiPageAgentContext | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as StoredKimiPageAgentContext;
    if (!parsed?.context) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

export function writeKimiPageAgentContext(
  context: KimiPageAgentContext,
): StoredKimiPageAgentContext {
  const stored = {
    id: createKimiPageAgentContextId(context),
    updatedAt: new Date().toISOString(),
    context,
  };
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }
  return stored;
}
