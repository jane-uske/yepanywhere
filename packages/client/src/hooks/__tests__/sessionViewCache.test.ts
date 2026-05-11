import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GlobalSessionItem,
  GlobalSessionStats,
  ProjectOption,
} from "../../api/client";
import type { Message, Session } from "../../types";
import {
  clearSessionViewCaches,
  getCachedSessionDetail,
  prioritizeSessionDetailLoad,
  scheduleRecentSessionPrefetch,
  setCachedGlobalSessions,
  setCachedSessionDetail,
} from "../sessionViewCache";
import { useGlobalSessions } from "../useGlobalSessions";
import { useSessionMessages } from "../useSessionMessages";

const { mockApi } = vi.hoisted(() => ({
  mockApi: {
    getSession: vi.fn(),
    getSessionMetadata: vi.fn(),
    getGlobalSessions: vi.fn(),
    getGlobalSessionStats: vi.fn(),
  },
}));

vi.mock("../../api/client", () => ({
  api: mockApi,
}));

vi.mock("../../providers/registry", () => ({
  getProvider: () => ({
    capabilities: {
      supportsDag: false,
    },
  }),
}));

vi.mock("../useFileActivity", () => ({
  useFileActivity: vi.fn(),
}));

function makeMessage(id: string, content: string): Message {
  return {
    id,
    type: "assistant",
    role: "assistant",
    content,
    timestamp: `2026-05-11T00:00:0${id.length}.000Z`,
  } as Message;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    projectId: "project-1",
    title: "Cached session",
    createdAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T00:00:01.000Z",
    messageCount: 1,
    provider: "claude",
    ownership: { owner: "none" },
    messages: [makeMessage("m1", "cached")],
    ...overrides,
  } as Session;
}

function makeGlobalSession(
  id: string,
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id,
    title: `Session ${id}`,
    createdAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T00:00:00.000Z",
    messageCount: 1,
    provider: "codex",
    projectId: "project-1",
    projectName: "Project",
    ownership: { owner: "none" },
    ...overrides,
  };
}

function makeStats(): GlobalSessionStats {
  return {
    totalCount: 1,
    unreadCount: 0,
    starredCount: 0,
    archivedCount: 0,
    providerCounts: { claude: 1 },
    executorCounts: { local: 1 },
  };
}

describe("session view cache", () => {
  beforeEach(() => {
    clearSessionViewCaches();
    vi.clearAllMocks();
  });

  it("renders cached session messages immediately and skips full session fetch when metadata is unchanged", async () => {
    const cachedSession = makeSession();
    setCachedSessionDetail("project-1", "session-1", {
      session: cachedSession,
      messages: cachedSession.messages,
      pagination: undefined,
      agentContent: {},
      toolUseToAgentEntries: [],
      lastMessageId: "m1",
    });

    mockApi.getSessionMetadata.mockResolvedValue({
      session: { ...cachedSession, messages: [] },
      ownership: { owner: "none" },
      pendingInputRequest: null,
      slashCommands: null,
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
      }),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.messages).toEqual(cachedSession.messages);

    await waitFor(() => {
      expect(mockApi.getSessionMetadata).toHaveBeenCalledTimes(1);
    });
    expect(mockApi.getSession).not.toHaveBeenCalled();
  });

  it("uses afterMessageId and dedupes when cached session metadata changed", async () => {
    const m1 = makeMessage("m1", "cached");
    const m2 = makeMessage("m2", "new");
    const cachedSession = makeSession({ messages: [m1] });
    const updatedSession = makeSession({
      updatedAt: "2026-05-11T00:01:00.000Z",
      messageCount: 2,
      messages: [m1, m2],
    });

    setCachedSessionDetail("project-1", "session-1", {
      session: cachedSession,
      messages: [m1],
      pagination: undefined,
      agentContent: {},
      toolUseToAgentEntries: [],
      lastMessageId: "m1",
    });

    mockApi.getSessionMetadata.mockResolvedValue({
      session: { ...updatedSession, messages: [] },
      ownership: { owner: "none" },
      pendingInputRequest: null,
      slashCommands: null,
    });
    mockApi.getSession.mockResolvedValue({
      session: updatedSession,
      messages: [m1, m2],
      ownership: { owner: "none" },
      pendingInputRequest: null,
      slashCommands: null,
    });

    const { result } = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
      }),
    );

    expect(result.current.messages).toEqual([m1]);

    await waitFor(() => {
      expect(mockApi.getSession).toHaveBeenCalledWith(
        "project-1",
        "session-1",
        "m1",
      );
    });
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    });
  });

  it("reuses an unfinished initial session load after navigating away and back", async () => {
    const loadedSession = makeSession();
    let resolveSession:
      | ((value: {
          session: Session;
          messages: Message[];
          ownership: { owner: "none" };
          pendingInputRequest: null;
          slashCommands: null;
        }) => void)
      | undefined;
    const pendingSession = new Promise<{
      session: Session;
      messages: Message[];
      ownership: { owner: "none" };
      pendingInputRequest: null;
      slashCommands: null;
    }>((resolve) => {
      resolveSession = resolve;
    });

    mockApi.getSession.mockReturnValueOnce(pendingSession);

    const first = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
      }),
    );

    expect(first.result.current.loading).toBe(true);
    first.unmount();

    const second = renderHook(() =>
      useSessionMessages({
        projectId: "project-1",
        sessionId: "session-1",
      }),
    );

    expect(mockApi.getSession).toHaveBeenCalledTimes(1);
    expect(second.result.current.loading).toBe(true);

    await act(async () => {
      resolveSession?.({
        session: loadedSession,
        messages: loadedSession.messages,
        ownership: { owner: "none" },
        pendingInputRequest: null,
        slashCommands: null,
      });
      await pendingSession;
    });

    await waitFor(() => {
      expect(second.result.current.loading).toBe(false);
    });
    expect(second.result.current.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(mockApi.getSession).toHaveBeenCalledTimes(1);
  });

  it("renders cached global sessions before background refresh updates them", async () => {
    const cachedSessions: GlobalSessionItem[] = [
      {
        id: "cached-session",
        title: "Cached",
        createdAt: "2026-05-11T00:00:00.000Z",
        updatedAt: "2026-05-11T00:00:01.000Z",
        messageCount: 1,
        provider: "claude",
        projectId: "project-1",
        projectName: "Project",
        ownership: { owner: "none" },
      },
    ];
    const cachedSession = cachedSessions[0];
    if (!cachedSession) throw new Error("missing cached session fixture");
    const freshSessions: GlobalSessionItem[] = [
      {
        ...cachedSession,
        id: "fresh-session",
        title: "Fresh",
      },
    ];
    const projects: ProjectOption[] = [{ id: "project-1", name: "Project" }];

    setCachedGlobalSessions(
      { includeStats: true, limit: 100 },
      {
        sessions: cachedSessions,
        stats: makeStats(),
        projects,
        hasMore: false,
      },
    );

    mockApi.getGlobalSessions.mockResolvedValue({
      sessions: freshSessions,
      stats: makeStats(),
      projects,
      hasMore: false,
    });
    mockApi.getGlobalSessionStats.mockResolvedValue({ stats: makeStats() });

    const { result } = renderHook(() =>
      useGlobalSessions({ includeStats: true, limit: 100 }),
    );

    expect(result.current.loading).toBe(false);
    expect(result.current.sessions.map((s) => s.id)).toEqual([
      "cached-session",
    ]);

    await waitFor(() => {
      expect(mockApi.getGlobalSessions).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.sessions.map((s) => s.id)).toEqual([
        "fresh-session",
      ]);
    });
  });

  it("syncs session title updates between cached global session views", async () => {
    const staleSession: GlobalSessionItem = {
      id: "session-1",
      title: "Old auto title",
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:01.000Z",
      messageCount: 1,
      provider: "claude",
      projectId: "project-1",
      projectName: "Project",
      ownership: { owner: "none" },
    };
    const freshSession: GlobalSessionItem = {
      ...staleSession,
      customTitle: "Fresh custom title",
      updatedAt: "2026-05-11T00:00:02.000Z",
    };
    const projects: ProjectOption[] = [{ id: "project-1", name: "Project" }];

    setCachedGlobalSessions(
      { limit: 50, includeStats: false },
      {
        sessions: [staleSession],
        stats: makeStats(),
        projects,
        hasMore: false,
      },
    );

    const never = new Promise<never>(() => {});
    mockApi.getGlobalSessions.mockImplementation(
      (params?: { project?: string }) => {
        if (params?.project === "project-1") {
          return Promise.resolve({
            sessions: [freshSession],
            stats: makeStats(),
            projects,
            hasMore: false,
          });
        }
        return never;
      },
    );
    mockApi.getGlobalSessionStats.mockResolvedValue({ stats: makeStats() });

    const all = renderHook(() =>
      useGlobalSessions({ includeStats: false, limit: 50 }),
    );
    const filtered = renderHook(() =>
      useGlobalSessions({
        projectId: "project-1",
        includeStats: false,
        limit: 50,
      }),
    );

    expect(all.result.current.sessions[0]?.title).toBe("Old auto title");

    await waitFor(() => {
      expect(filtered.result.current.sessions[0]?.customTitle).toBe(
        "Fresh custom title",
      );
    });
    await waitFor(() => {
      expect(all.result.current.sessions[0]?.customTitle).toBe(
        "Fresh custom title",
      );
    });
  });

  it("prefetches only the five most recent 24h codex sessions with concurrency one", async () => {
    const nowMs = Date.parse("2026-05-11T12:00:00.000Z");
    const recentSessions = Array.from({ length: 6 }, (_, index) =>
      makeGlobalSession(`recent-${index + 1}`, {
        updatedAt: new Date(nowMs - index * 60_000).toISOString(),
        messageCount: index + 1,
      }),
    );
    const oldSession = makeGlobalSession("old-session", {
      updatedAt: new Date(nowMs - 25 * 60 * 60_000).toISOString(),
    });
    const claudeSession = makeGlobalSession("claude-session", {
      provider: "claude",
      updatedAt: new Date(nowMs - 30_000).toISOString(),
    });

    const sessionById = new Map(
      [...recentSessions, oldSession, claudeSession].map((session) => [
        session.id,
        session,
      ]),
    );
    mockApi.getSessionMetadata.mockImplementation(
      async (projectId: string, sessionId: string) => {
        const source = sessionById.get(sessionId);
        if (!source) throw new Error(`missing fixture: ${sessionId}`);
        return {
          session: makeSession({
            id: sessionId,
            projectId: projectId as Session["projectId"],
            title: source.title,
            updatedAt: source.updatedAt,
            messageCount: source.messageCount,
            provider: source.provider,
            messages: [],
          }),
          ownership: { owner: "none" },
          pendingInputRequest: null,
          slashCommands: null,
        };
      },
    );

    const pendingLoads: Array<() => void> = [];
    let activeLoads = 0;
    let maxActiveLoads = 0;
    mockApi.getSession.mockImplementation(
      (
        projectId: string,
        sessionId: string,
        afterMessageId?: string,
        options?: { tailCompactions?: number },
      ) => {
        activeLoads++;
        maxActiveLoads = Math.max(maxActiveLoads, activeLoads);
        return new Promise((resolve) => {
          pendingLoads.push(() => {
            activeLoads--;
            resolve({
              session: makeSession({
                id: sessionId,
                projectId: projectId as Session["projectId"],
                title: sessionById.get(sessionId)?.title,
                updatedAt: sessionById.get(sessionId)?.updatedAt,
                messageCount: sessionById.get(sessionId)?.messageCount,
                provider: "codex",
                messages: [makeMessage(`${sessionId}-m1`, "prefetched")],
              }),
              messages: [makeMessage(`${sessionId}-m1`, "prefetched")],
              ownership: { owner: "none" },
              pendingInputRequest: null,
              slashCommands: null,
              pagination: undefined,
              afterMessageId,
              options,
            });
          });
        });
      },
    );

    scheduleRecentSessionPrefetch(
      [...recentSessions, oldSession, claudeSession],
      {
        nowMs,
        debounceMs: 0,
        tailCompactions: 1,
      },
    );

    await waitFor(() => {
      expect(mockApi.getSession).toHaveBeenCalledTimes(1);
    });
    expect(mockApi.getSession).toHaveBeenLastCalledWith(
      "project-1",
      "recent-1",
      undefined,
      { tailCompactions: 1 },
    );
    expect(mockApi.getSessionMetadata).toHaveBeenCalledTimes(1);

    for (let expected = 2; expected <= 5; expected++) {
      await act(async () => {
        pendingLoads.shift()?.();
      });
      await waitFor(() => {
        expect(mockApi.getSession).toHaveBeenCalledTimes(expected);
      });
    }

    await act(async () => {
      pendingLoads.shift()?.();
    });
    await Promise.resolve();

    expect(mockApi.getSession).toHaveBeenCalledTimes(5);
    expect(mockApi.getSession.mock.calls.map((call) => call[1])).toEqual([
      "recent-1",
      "recent-2",
      "recent-3",
      "recent-4",
      "recent-5",
    ]);
    expect(maxActiveLoads).toBe(1);
  });

  it("skips full prefetch when cached session metadata is unchanged", async () => {
    const cachedSession = makeSession({
      provider: "codex",
      title: "Old title",
      updatedAt: "2026-05-11T00:00:01.000Z",
      messageCount: 1,
    });
    setCachedSessionDetail("project-1", "session-1", {
      session: cachedSession,
      messages: cachedSession.messages,
      pagination: undefined,
      agentContent: {},
      toolUseToAgentEntries: [],
      lastMessageId: "m1",
    });

    mockApi.getSessionMetadata.mockResolvedValue({
      session: {
        ...cachedSession,
        title: "Codex generated title",
        messages: [],
      },
      ownership: { owner: "none" },
      pendingInputRequest: null,
      slashCommands: null,
    });

    scheduleRecentSessionPrefetch(
      [
        makeGlobalSession("session-1", {
          title: "Codex generated title",
          updatedAt: cachedSession.updatedAt,
          messageCount: cachedSession.messageCount,
        }),
      ],
      { nowMs: Date.parse("2026-05-11T12:00:00.000Z"), debounceMs: 0 },
    );

    await waitFor(() => {
      expect(mockApi.getSessionMetadata).toHaveBeenCalledTimes(1);
    });

    expect(mockApi.getSession).not.toHaveBeenCalled();
    expect(
      getCachedSessionDetail("project-1", "session-1")?.session.title,
    ).toBe("Codex generated title");
  });

  it("removes a queued prefetch when the user explicitly opens that session", async () => {
    vi.useFakeTimers();

    scheduleRecentSessionPrefetch([makeGlobalSession("session-1")], {
      nowMs: Date.parse("2026-05-11T12:00:00.000Z"),
      debounceMs: 1_000,
    });
    prioritizeSessionDetailLoad("project-1", "session-1");

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });

    expect(mockApi.getSessionMetadata).not.toHaveBeenCalled();
    expect(mockApi.getSession).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
