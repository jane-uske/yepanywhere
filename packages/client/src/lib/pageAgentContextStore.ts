import type { PageAgentContext } from "./pageAgentBridge";

const STORAGE_KEY = "page-agent.current-context";

export interface StoredPageAgentContext {
  id: string;
  updatedAt: string;
  context: PageAgentContext;
}

export function createPageAgentContextId(context: PageAgentContext): string {
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

export function readPageAgentContext(): StoredPageAgentContext | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as StoredPageAgentContext;
    if (!parsed?.context) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

export function writePageAgentContext(
  context: PageAgentContext,
): StoredPageAgentContext {
  const stored = {
    id: createPageAgentContextId(context),
    updatedAt: new Date().toISOString(),
    context,
  };
  if (typeof window !== "undefined") {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
  }
  return stored;
}
