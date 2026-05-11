import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  type SessionsDeps,
  createSessionsRoutes,
} from "../../src/routes/sessions.js";
import type {
  ISessionReader,
  LoadedSession,
} from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";

function createProject(): Project {
  return {
    id: "proj-1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/project/.claude-sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

function createSummary(): SessionSummary {
  return {
    id: "sess-1",
    projectId: "proj-1" as UrlProjectId,
    title: "Session",
    fullTitle: "Session",
    createdAt: "2026-03-10T09:45:00.000Z",
    updatedAt: "2026-03-10T09:46:00.000Z",
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "claude",
  };
}

function createLoadedSession(): LoadedSession {
  const summary = createSummary();
  return {
    summary,
    data: {
      provider: "claude",
      session: {
        messages: [
          {
            type: "user",
            uuid: "msg-1",
            parentUuid: null,
            cwd: "/tmp/project",
            message: { role: "user", content: "hello" },
          } as never,
        ],
      },
    },
  };
}

describe("Session detail tail options", () => {
  it("passes tailCompactions to the session reader before route-level slicing", async () => {
    const project = createProject();
    const getSession = vi.fn(async () => createLoadedSession());
    const reader = {
      getSession,
    } as unknown as ISessionReader;

    const routes = createSessionsRoutes({
      supervisor: {
        getProcessForSession: vi.fn(() => null),
        wasEverOwned: vi.fn(() => false),
      } as unknown as SessionsDeps["supervisor"],
      scanner: {
        getOrCreateProject: vi.fn(async () => project),
      } as unknown as SessionsDeps["scanner"],
      readerFactory: vi.fn(() => reader),
    });

    const response = await routes.request(
      `/projects/${project.id}/sessions/sess-1?tailCompactions=2`,
    );

    expect(response.status).toBe(200);
    expect(getSession).toHaveBeenCalledWith(
      "sess-1",
      project.id,
      undefined,
      expect.objectContaining({
        includeOrphans: false,
        tailCompactions: 2,
      }),
    );
  });
});
