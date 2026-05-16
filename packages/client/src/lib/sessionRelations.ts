import { getSessionSourceInfo, isSessionSourceSubagent } from "./sessionSource";

export interface RelatableSession {
  id: string;
  source?: unknown;
  createdAt?: string;
  updatedAt?: string;
}

export interface SessionRelationContext<TSession extends RelatableSession> {
  rootSessionId: string;
  parentSessionId?: string;
  parentSession?: TSession;
  childSessions: TSession[];
}

export function getSessionParentId(
  session: RelatableSession | null | undefined,
): string | undefined {
  return getSessionSourceInfo(session?.source)?.parentThreadId;
}

export function isSubagentSession(
  session: RelatableSession | null | undefined,
): boolean {
  return isSessionSourceSubagent(session?.source);
}

function getSortTime(session: RelatableSession): number {
  const value = session.createdAt ?? session.updatedAt;
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildSessionRelationContext<TSession extends RelatableSession>(
  currentSession: TSession,
  sessions: TSession[],
): SessionRelationContext<TSession> {
  const mergedSessions = [
    currentSession,
    ...sessions.filter((session) => session.id !== currentSession.id),
  ];
  const parentSessionId = getSessionParentId(currentSession);
  const rootSessionId = parentSessionId ?? currentSession.id;
  const parentSession = parentSessionId
    ? mergedSessions.find((session) => session.id === parentSessionId)
    : undefined;

  const childSessions = mergedSessions
    .filter((session) => getSessionParentId(session) === rootSessionId)
    .sort(
      (a, b) => getSortTime(a) - getSortTime(b) || a.id.localeCompare(b.id),
    );

  return {
    rootSessionId,
    parentSessionId,
    parentSession,
    childSessions,
  };
}
