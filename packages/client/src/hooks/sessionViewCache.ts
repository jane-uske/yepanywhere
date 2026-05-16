import type {
  GlobalSessionItem,
  GlobalSessionStats,
  PaginationInfo,
  ProjectOption,
} from "../api/client";
import { api } from "../api/client";
import { reconcileCodexLinearMessages } from "../lib/codexLinearMessages";
import { getMessageId, mergeJSONLMessages } from "../lib/mergeMessages";
import { getProvider } from "../providers/registry";
import type { Message, Session } from "../types";

export interface CachedAgentContent {
  messages: Message[];
  status: "pending" | "running" | "completed" | "failed";
  contextUsage?: {
    inputTokens: number;
    percentage: number;
  };
}

export type CachedAgentContentMap = Record<string, CachedAgentContent>;

export interface CachedSessionDetail {
  session: Session;
  messages: Message[];
  pagination?: PaginationInfo;
  agentContent: CachedAgentContentMap;
  toolUseToAgentEntries: Array<[string, string]>;
  lastMessageId?: string;
}

export interface GlobalSessionsCacheOptions {
  projectId?: string | null;
  project?: string | null;
  searchQuery?: string;
  q?: string;
  limit?: number;
  includeArchived?: boolean;
  starred?: boolean;
  includeStats?: boolean;
  includeSubagents?: boolean;
}

export interface CachedGlobalSessions {
  sessions: GlobalSessionItem[];
  stats: GlobalSessionStats;
  projects: ProjectOption[];
  hasMore: boolean;
}

export type GlobalSessionPatch = Partial<GlobalSessionItem> &
  Pick<GlobalSessionItem, "id">;

export interface RecentSessionPrefetchOptions {
  nowMs?: number;
  maxAgeMs?: number;
  limit?: number;
  debounceMs?: number;
  tailCompactions?: 1 | 2;
}

interface RecentSessionPrefetchCandidate {
  id: string;
  projectId: string;
  title: string | null;
  updatedAt: string;
  messageCount: number;
  provider: GlobalSessionItem["provider"];
  tailCompactions: 1 | 2;
}

const MAX_SESSION_DETAIL_ENTRIES = 30;
const MAX_GLOBAL_SESSIONS_ENTRIES = 12;
const RECENT_PREFETCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECENT_PREFETCH_LIMIT = 5;
const RECENT_PREFETCH_DEBOUNCE_MS = 750;
const RECENT_PREFETCH_TAIL_COMPACTIONS = 1;

const sessionDetailCache = new Map<string, CachedSessionDetail>();
const inFlightSessionDetailLoads = new Map<string, Promise<unknown>>();
const globalSessionsCache = new Map<string, CachedGlobalSessions>();
const globalSessionPatchListeners = new Set<
  (patches: GlobalSessionPatch[]) => void
>();
const queuedPrefetchKeys = new Set<string>();
const prefetchQueue: RecentSessionPrefetchCandidate[] = [];
let scheduledPrefetchCandidates: RecentSessionPrefetchCandidate[] = [];
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
let prefetchRunning = false;

function sessionDetailKey(projectId: string, sessionId: string): string {
  return `${projectId}:${sessionId}`;
}

function globalSessionsKey(options: GlobalSessionsCacheOptions): string {
  return JSON.stringify({
    projectId: options.projectId ?? options.project ?? null,
    searchQuery: options.searchQuery ?? options.q ?? "",
    limit: options.limit ?? null,
    includeArchived: options.includeArchived === true,
    starred: options.starred === true,
    includeStats: options.includeStats === true,
    includeSubagents: options.includeSubagents === true,
  });
}

function evictOldest<K, V>(cache: Map<K, V>, maxEntries: number): void {
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value as K | undefined;
    if (oldestKey === undefined) return;
    cache.delete(oldestKey);
  }
}

function isCodexProvider(provider?: string): boolean {
  return provider === "codex" || provider === "codex-oss";
}

function getLastCachedMessageId(messages: Message[]): string | undefined {
  const lastMessage = messages[messages.length - 1];
  return lastMessage ? getMessageId(lastMessage) : undefined;
}

function isCachedSessionFreshForCandidate(
  cached: CachedSessionDetail | undefined,
  candidate: RecentSessionPrefetchCandidate,
): boolean {
  if (!cached) return false;
  return (
    cached.session.updatedAt === candidate.updatedAt &&
    cached.session.messageCount === candidate.messageCount &&
    (cached.session.title ?? null) === (candidate.title ?? null)
  );
}

function buildCachedLoadResult(
  cached: CachedSessionDetail,
): Awaited<ReturnType<typeof api.getSession>> & { lastMessageId?: string } {
  return {
    session: cached.session,
    messages: cached.messages,
    ownership: cached.session.ownership,
    pendingInputRequest: null,
    slashCommands: null,
    pagination: cached.pagination,
    lastMessageId:
      cached.lastMessageId ?? getLastCachedMessageId(cached.messages),
  };
}

function hydratePrefetchedSessionDetail(
  data: Awaited<ReturnType<typeof api.getSession>>,
  cached: CachedSessionDetail | null,
): Awaited<ReturnType<typeof api.getSession>> & { lastMessageId?: string } {
  const taggedMessages = data.messages.map((message) => ({
    ...message,
    _source: "jsonl" as const,
  }));
  const mergedMessages = cached
    ? mergeJSONLMessages(cached.messages, taggedMessages, {
        skipDagOrdering: !getProvider(data.session.provider).capabilities
          .supportsDag,
      }).messages
    : taggedMessages;
  const visibleMessages = isCodexProvider(data.session.provider)
    ? reconcileCodexLinearMessages(mergedMessages)
    : mergedMessages;
  const hydratedSession = {
    ...data.session,
    messages: visibleMessages,
  };
  const lastMessageId = getLastCachedMessageId(visibleMessages);

  return {
    ...data,
    session: hydratedSession,
    messages: visibleMessages,
    lastMessageId,
  };
}

function buildRecentPrefetchCandidates(
  sessions: GlobalSessionItem[],
  options: RecentSessionPrefetchOptions,
): RecentSessionPrefetchCandidate[] {
  const nowMs = options.nowMs ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? RECENT_PREFETCH_MAX_AGE_MS;
  const limit = options.limit ?? RECENT_PREFETCH_LIMIT;
  const tailCompactions =
    options.tailCompactions ?? RECENT_PREFETCH_TAIL_COMPACTIONS;

  return sessions
    .filter((session) => isCodexProvider(session.provider))
    .filter((session) => {
      const updatedAtMs = Date.parse(session.updatedAt);
      return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs <= maxAgeMs;
    })
    .sort(
      (a, b) =>
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, limit)
    .map((session) => ({
      id: session.id,
      projectId: session.projectId,
      title: session.title,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      provider: session.provider,
      tailCompactions,
    }));
}

function cloneAgentContent(
  agentContent: CachedAgentContentMap,
): CachedAgentContentMap {
  return Object.fromEntries(
    Object.entries(agentContent).map(([agentId, content]) => [
      agentId,
      {
        ...content,
        messages: [...content.messages],
        contextUsage: content.contextUsage
          ? { ...content.contextUsage }
          : undefined,
      },
    ]),
  );
}

function cloneSessionDetail(entry: CachedSessionDetail): CachedSessionDetail {
  return {
    ...entry,
    session: { ...entry.session, messages: [...entry.messages] },
    messages: [...entry.messages],
    pagination: entry.pagination ? { ...entry.pagination } : undefined,
    agentContent: cloneAgentContent(entry.agentContent),
    toolUseToAgentEntries: [...entry.toolUseToAgentEntries],
  };
}

function cloneGlobalSessions(
  entry: CachedGlobalSessions,
): CachedGlobalSessions {
  return {
    sessions: [...entry.sessions],
    stats: {
      ...entry.stats,
      providerCounts: { ...entry.stats.providerCounts },
      executorCounts: { ...entry.stats.executorCounts },
    },
    projects: [...entry.projects],
    hasMore: entry.hasMore,
  };
}

export function getCachedSessionDetail(
  projectId: string,
  sessionId: string,
): CachedSessionDetail | null {
  const key = sessionDetailKey(projectId, sessionId);
  const entry = sessionDetailCache.get(key);
  if (!entry) return null;

  sessionDetailCache.delete(key);
  sessionDetailCache.set(key, entry);
  return cloneSessionDetail(entry);
}

export function setCachedSessionDetail(
  projectId: string,
  sessionId: string,
  entry: CachedSessionDetail,
): void {
  const key = sessionDetailKey(projectId, sessionId);
  sessionDetailCache.delete(key);
  sessionDetailCache.set(key, cloneSessionDetail(entry));
  evictOldest(sessionDetailCache, MAX_SESSION_DETAIL_ENTRIES);
}

export function getInFlightSessionDetailLoad<T>(
  projectId: string,
  sessionId: string,
): Promise<T> | null {
  const promise = inFlightSessionDetailLoads.get(
    sessionDetailKey(projectId, sessionId),
  );
  return promise ? (promise as Promise<T>) : null;
}

export function setInFlightSessionDetailLoad<T>(
  projectId: string,
  sessionId: string,
  promise: Promise<T>,
): Promise<T> {
  const key = sessionDetailKey(projectId, sessionId);
  inFlightSessionDetailLoads.set(key, promise);
  promise.finally(() => {
    if (inFlightSessionDetailLoads.get(key) === promise) {
      inFlightSessionDetailLoads.delete(key);
    }
  });
  return promise;
}

export function getCachedGlobalSessions(
  options: GlobalSessionsCacheOptions,
): CachedGlobalSessions | null {
  const key = globalSessionsKey(options);
  const entry = globalSessionsCache.get(key);
  if (!entry) return null;

  globalSessionsCache.delete(key);
  globalSessionsCache.set(key, entry);
  return cloneGlobalSessions(entry);
}

export function setCachedGlobalSessions(
  options: GlobalSessionsCacheOptions,
  entry: CachedGlobalSessions,
): void {
  const key = globalSessionsKey(options);
  globalSessionsCache.delete(key);
  globalSessionsCache.set(key, cloneGlobalSessions(entry));
  evictOldest(globalSessionsCache, MAX_GLOBAL_SESSIONS_ENTRIES);
}

export function patchCachedGlobalSessions(
  patches: GlobalSessionPatch | GlobalSessionPatch[],
): void {
  const patchList = Array.isArray(patches) ? patches : [patches];
  if (patchList.length === 0) return;

  const patchById = new Map(patchList.map((patch) => [patch.id, patch]));

  for (const [key, entry] of globalSessionsCache.entries()) {
    let changed = false;
    const sessions = entry.sessions.map((session) => {
      const patch = patchById.get(session.id);
      if (!patch) return session;
      changed = true;
      return { ...session, ...patch };
    });

    if (changed) {
      globalSessionsCache.set(key, cloneGlobalSessions({ ...entry, sessions }));
    }
  }

  for (const listener of globalSessionPatchListeners) {
    listener(patchList);
  }
}

export function subscribeToGlobalSessionPatches(
  listener: (patches: GlobalSessionPatch[]) => void,
): () => void {
  globalSessionPatchListeners.add(listener);
  return () => {
    globalSessionPatchListeners.delete(listener);
  };
}

async function prefetchSessionDetail(
  candidate: RecentSessionPrefetchCandidate,
): Promise<
  Awaited<ReturnType<typeof api.getSession>> & {
    lastMessageId?: string;
  }
> {
  const cached = getCachedSessionDetail(candidate.projectId, candidate.id);

  const metadata = await api.getSessionMetadata(
    candidate.projectId,
    candidate.id,
  );

  if (cached) {
    const metadataUnchanged =
      metadata.session.updatedAt === cached.session.updatedAt &&
      metadata.session.messageCount === cached.session.messageCount;

    if (metadataUnchanged) {
      const refreshedSession = {
        ...cached.session,
        ...metadata.session,
        messages: cached.messages,
      };
      const refreshed = {
        ...cached,
        session: refreshedSession,
        messages: cached.messages,
      };
      setCachedSessionDetail(candidate.projectId, candidate.id, refreshed);
      return buildCachedLoadResult(refreshed);
    }
  }

  const afterMessageId =
    cached?.lastMessageId ?? getLastCachedMessageId(cached?.messages ?? []);
  const data = await api.getSession(
    candidate.projectId,
    candidate.id,
    afterMessageId,
    {
      tailCompactions: candidate.tailCompactions,
    },
  );
  const hydrated = hydratePrefetchedSessionDetail(data, cached);

  setCachedSessionDetail(candidate.projectId, candidate.id, {
    session: hydrated.session,
    messages: hydrated.messages,
    pagination: hydrated.pagination,
    agentContent: cached?.agentContent ?? {},
    toolUseToAgentEntries: cached?.toolUseToAgentEntries ?? [],
    lastMessageId: hydrated.lastMessageId,
  });

  return hydrated;
}

function runPrefetchQueue(): void {
  if (prefetchRunning) return;

  const candidate = prefetchQueue.shift();
  if (!candidate) return;

  const key = sessionDetailKey(candidate.projectId, candidate.id);
  queuedPrefetchKeys.delete(key);

  const cached = sessionDetailCache.get(key);
  if (
    inFlightSessionDetailLoads.has(key) ||
    isCachedSessionFreshForCandidate(cached, candidate)
  ) {
    runPrefetchQueue();
    return;
  }

  prefetchRunning = true;
  setInFlightSessionDetailLoad(
    candidate.projectId,
    candidate.id,
    prefetchSessionDetail(candidate),
  )
    .catch(() => {
      // Prefetch must never surface errors or disturb the visible UI.
    })
    .finally(() => {
      prefetchRunning = false;
      runPrefetchQueue();
    });
}

function enqueueScheduledPrefetches(): void {
  const candidates = scheduledPrefetchCandidates;
  scheduledPrefetchCandidates = [];

  for (const candidate of candidates) {
    const key = sessionDetailKey(candidate.projectId, candidate.id);
    const cached = sessionDetailCache.get(key);
    if (
      queuedPrefetchKeys.has(key) ||
      inFlightSessionDetailLoads.has(key) ||
      isCachedSessionFreshForCandidate(cached, candidate)
    ) {
      continue;
    }

    queuedPrefetchKeys.add(key);
    prefetchQueue.push(candidate);
  }

  runPrefetchQueue();
}

export function scheduleRecentSessionPrefetch(
  sessions: GlobalSessionItem[],
  options: RecentSessionPrefetchOptions = {},
): void {
  const candidates = buildRecentPrefetchCandidates(sessions, options);
  if (candidates.length === 0) {
    scheduledPrefetchCandidates = [];
    if (prefetchTimer) {
      clearTimeout(prefetchTimer);
      prefetchTimer = null;
    }
    return;
  }

  scheduledPrefetchCandidates = candidates;

  if (prefetchTimer) {
    clearTimeout(prefetchTimer);
    prefetchTimer = null;
  }

  const debounceMs = options.debounceMs ?? RECENT_PREFETCH_DEBOUNCE_MS;
  if (debounceMs <= 0) {
    enqueueScheduledPrefetches();
    return;
  }

  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    enqueueScheduledPrefetches();
  }, debounceMs);
}

export function prioritizeSessionDetailLoad(
  projectId: string,
  sessionId: string,
): void {
  const key = sessionDetailKey(projectId, sessionId);
  queuedPrefetchKeys.delete(key);
  scheduledPrefetchCandidates = scheduledPrefetchCandidates.filter(
    (candidate) => sessionDetailKey(candidate.projectId, candidate.id) !== key,
  );

  for (let index = prefetchQueue.length - 1; index >= 0; index--) {
    const candidate = prefetchQueue[index];
    if (!candidate) continue;
    if (sessionDetailKey(candidate.projectId, candidate.id) === key) {
      prefetchQueue.splice(index, 1);
    }
  }
}

export function clearSessionViewCaches(): void {
  sessionDetailCache.clear();
  inFlightSessionDetailLoads.clear();
  globalSessionsCache.clear();
  globalSessionPatchListeners.clear();
  queuedPrefetchKeys.clear();
  prefetchQueue.length = 0;
  scheduledPrefetchCandidates = [];
  prefetchRunning = false;
  if (prefetchTimer) {
    clearTimeout(prefetchTimer);
    prefetchTimer = null;
  }
}
