import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { UrlProjectId, WorkChangedFile } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type {
  ISessionReader,
  LoadedSession,
} from "../../src/sessions/types.js";
import type { Project, SessionSummary } from "../../src/supervisor/types.js";
import {
  buildWorkSignal,
  classifyWorkType,
  createWorkSnapshotProvider,
  deriveConfidence,
  deriveSignalState,
} from "../../src/work/workSnapshot.js";

const execFileAsync = promisify(execFile);

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj1" as UrlProjectId,
    path: "/tmp/project",
    name: "project",
    sessionCount: 1,
    sessionDir: "/tmp/sessions",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
    ...overrides,
  };
}

function createSession(
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id: "sess1",
    projectId: "proj1" as UrlProjectId,
    title: "Implement Remi work snapshot API",
    fullTitle: "Implement Remi work snapshot API",
    createdAt: "2026-05-11T00:00:00.000Z",
    updatedAt: "2026-05-11T08:00:00.000Z",
    messageCount: 3,
    ownership: { owner: "none" },
    provider: "claude",
    ...overrides,
  };
}

function createReader(
  sessions: SessionSummary[],
  messages: unknown[],
): ISessionReader {
  const loadedSession: LoadedSession = {
    summary: sessions[0] ?? createSession(),
    data: {
      session: {
        id: sessions[0]?.id ?? "sess1",
        projectId: sessions[0]?.projectId ?? ("proj1" as UrlProjectId),
        messages,
      },
    } as LoadedSession["data"],
  };

  return {
    listSessions: vi.fn(async () => sessions),
    getSessionSummary: vi.fn(async () => sessions[0] ?? null),
    getSession: vi.fn(async () => loadedSession),
    getSessionSummaryIfChanged: vi.fn(async () => null),
    getAgentMappings: vi.fn(async () => []),
    getAgentSession: vi.fn(async () => null),
  };
}

function createScanner(projects: Project[]): ProjectScanner {
  return {
    listProjects: vi.fn(async () => projects),
  } as unknown as ProjectScanner;
}

async function readSingleSignal({
  project = createProject({
    hasCodexSessions: false,
    hasGeminiSessions: false,
  }),
  session = createSession({ provider: "codex" }),
  messages,
  getChangedFiles,
  cacheTtlMs,
  now,
}: {
  project?: Project;
  session?: SessionSummary;
  messages: unknown[];
  getChangedFiles?: () => Promise<never[]>;
  cacheTtlMs?: number;
  now?: () => number;
}) {
  const reader = createReader([session], messages);
  const provider = createWorkSnapshotProvider({
    scanner: createScanner([project]),
    readerFactory: () => reader,
    ...(getChangedFiles ? { getChangedFiles } : {}),
    cacheTtlMs,
    now,
  });

  const snapshot = await provider.getSnapshot({
    since: new Date("2026-05-11T00:00:00.000Z"),
    until: new Date("2026-05-11T12:00:00.000Z"),
    limit: 20,
  });

  return { snapshot, reader };
}

async function readSnapshotForProjects({
  projects,
  sessionsByProjectId,
  messagesBySessionId,
  changedFilesByProjectId,
}: {
  projects: Project[];
  sessionsByProjectId: Map<string, SessionSummary[]>;
  messagesBySessionId: Map<string, unknown[]>;
  changedFilesByProjectId: Map<string, WorkChangedFile[]>;
}) {
  const readers = new Map<string, ISessionReader>();
  for (const project of projects) {
    const sessions = sessionsByProjectId.get(project.id) ?? [];
    readers.set(project.id, {
      listSessions: vi.fn(async () => sessions),
      getSessionSummary: vi.fn(
        async (sessionId: string) =>
          sessions.find((session) => session.id === sessionId) ?? null,
      ),
      getSession: vi.fn(async (sessionId: string) => {
        const summary = sessions.find((session) => session.id === sessionId);
        return {
          summary: summary ?? createSession({ id: sessionId }),
          data: {
            session: {
              id: sessionId,
              projectId: project.id,
              messages: messagesBySessionId.get(sessionId) ?? [],
            },
          } as LoadedSession["data"],
        };
      }),
      getSessionSummaryIfChanged: vi.fn(async () => null),
      getAgentMappings: vi.fn(async () => []),
      getAgentSession: vi.fn(async () => null),
    });
  }

  const provider = createWorkSnapshotProvider({
    scanner: createScanner(projects),
    readerFactory: (project) => readers.get(project.id) ?? createReader([], []),
    getChangedFiles: vi.fn(
      async (project) => changedFilesByProjectId.get(project.id) ?? [],
    ),
    cacheTtlMs: 0,
  });

  return provider.getSnapshot({
    since: new Date("2026-05-11T00:00:00.000Z"),
    until: new Date("2026-05-11T12:00:00.000Z"),
    limit: 20,
  });
}

describe("work snapshot classification", () => {
  it("prioritizes pending input as needs_attention", () => {
    expect(
      deriveSignalState({
        pendingInputType: "tool-approval",
        processState: "in-turn",
        agentClaim: "Implemented the feature",
        verification: [{ kind: "test", status: "passed", label: "vitest" }],
      }),
    ).toBe("needs_attention");
  });

  it("does not mark claimed work as verified_done without verification", () => {
    expect(
      deriveSignalState({
        agentClaim: "Implemented the API and tests.",
        changedFiles: [{ path: "src/api.ts", status: "M", staged: false }],
      }),
    ).toBe("claimed_done");
  });

  it("marks verified_done only when a completion claim has passing verification", () => {
    expect(
      deriveSignalState({
        agentClaim: "Done. Tests pass.",
        verification: [{ kind: "test", status: "passed", label: "pnpm test" }],
      }),
    ).toBe("verified_done");
  });

  it("classifies work type conservatively from claim and changed files", () => {
    expect(
      classifyWorkType({
        title: "Investigate failing login",
        agentClaim: "Fixed auth regression",
        changedFiles: [{ path: "src/auth.ts", status: "M", staged: false }],
      }),
    ).toBe("bugfix");

    expect(
      classifyWorkType({
        title: "Update docs",
        changedFiles: [
          { path: "docs/plans/remi.md", status: "M", staged: false },
          { path: "README.md", status: "M", staged: false },
        ],
      }),
    ).toBe("docs");

    expect(classifyWorkType({ title: "Review current state" })).toBe("unknown");
  });

  it("keeps confidence medium for claims with changed files but no verification", () => {
    expect(
      deriveConfidence({
        state: "claimed_done",
        agentClaim: "Implemented API route.",
        changedFiles: [{ path: "src/route.ts", status: "M", staged: false }],
        verification: [],
      }),
    ).toBe("medium");
  });

  it("builds a bounded signal without raw log text", () => {
    const signal = buildWorkSignal({
      project: createProject(),
      session: createSession(),
      pendingInputType: undefined,
      processState: undefined,
      agentClaim:
        "Implemented the route with enough text that the public signal should keep it compact and not expose a full transcript body.",
      changedFiles: [
        {
          path: "packages/server/src/routes/remi-work.ts",
          status: "A",
          staged: false,
        },
      ],
      verification: [],
    });

    expect(signal.id).toBe("claude:proj1:sess1");
    expect(signal.agentClaim?.length).toBeLessThanOrEqual(240);
    expect(signal.state).toBe("claimed_done");
    expect(signal.confidence).toBe("medium");
    expect(signal.evidenceRefs.map((ref) => ref.kind)).toContain("session");
    expect(signal.evidenceRefs.map((ref) => ref.kind)).toContain("git");
  });
});

describe("work snapshot Codex facts", () => {
  it("extracts Codex response_item assistant completion claims", async () => {
    const { snapshot } = await readSingleSignal({
      messages: [
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Implemented the API." }],
          },
        },
      ],
    });

    expect(snapshot.completed[0]?.agentClaim).toBe("Implemented the API.");
    expect(snapshot.completed[0]?.state).toBe("claimed_done");
  });

  it("pairs Codex function_call output process code 0 as passed verification", async () => {
    const { snapshot } = await readSingleSignal({
      messages: [
        {
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-1",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "pnpm --filter @yep-anywhere/server test test/work/workSnapshot.test.ts",
            }),
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "Tests passed\nProcess exited with code 0",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: "Done. Tests pass.",
          },
        },
      ],
    });

    expect(snapshot.completed[0]?.verification).toEqual([
      {
        kind: "test",
        status: "passed",
        label:
          "pnpm --filter @yep-anywhere/server test test/work/workSnapshot.test.ts",
      },
    ]);
    expect(snapshot.completed[0]?.state).toBe("verified_done");
  });

  it("maps failed Codex command output to blocked even with a done claim", async () => {
    const { snapshot } = await readSingleSignal({
      messages: [
        {
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "call-1",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "pnpm test" }),
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "call-1",
            output: "1 failed\nProcess exited with code 1",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: "Done.",
          },
        },
      ],
    });

    expect(snapshot.attention[0]?.verification).toEqual([
      { kind: "test", status: "failed", label: "pnpm test" },
    ]);
    expect(snapshot.attention[0]?.state).toBe("blocked");
  });

  it("does not treat custom_tool_call apply_patch as verification by itself", async () => {
    const { snapshot } = await readSingleSignal({
      messages: [
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            call_id: "patch-1",
            name: "apply_patch",
            input:
              "*** Begin Patch\n*** Update File: packages/server/test/work/workSnapshot.test.ts\n*** End Patch",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "patch-1",
            output: "Success. Process exited with code 0",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: "Implemented the parsing change.",
          },
        },
      ],
    });

    expect(snapshot.completed[0]?.verification).toBeUndefined();
    expect(snapshot.completed[0]?.state).toBe("claimed_done");
  });

  it("does not treat read-only searches as failed verification just because paths mention test or lint", async () => {
    const { snapshot } = await readSingleSignal({
      messages: [
        {
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "read-skill",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "sed -n '1,220p' /Users/rare/.codex/skills/superpowers/test-driven-development/SKILL.md",
            }),
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "read-skill",
            output: "Process exited with code 1",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call",
            call_id: "search-format",
            name: "exec_command",
            arguments: JSON.stringify({
              cmd: "rg -n '\"format\"|prettier|eslint|lint' package.json",
            }),
          },
        },
        {
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: "search-format",
            output: "Process exited with code 1",
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: "Implemented the parsing change.",
          },
        },
      ],
    });

    expect(snapshot.attention).toEqual([]);
    expect(snapshot.completed[0]?.verification).toBeUndefined();
    expect(snapshot.completed[0]?.state).toBe("claimed_done");
  });
});

describe("work snapshot git facts and cache", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("fills changed file line counts from git diff numstat", async () => {
    const repoDir = await mkdtemp(join(tmpdir(), "work-snapshot-"));
    tempDirs.push(repoDir);
    await execFileAsync("git", ["-C", repoDir, "init"]);
    await execFileAsync("git", [
      "-C",
      repoDir,
      "config",
      "user.email",
      "test@example.com",
    ]);
    await execFileAsync("git", [
      "-C",
      repoDir,
      "config",
      "user.name",
      "Test User",
    ]);
    await mkdir(join(repoDir, "src"));
    await writeFile(join(repoDir, "src", "tracked.ts"), "one\ntwo\nthree\n");
    await execFileAsync("git", ["-C", repoDir, "add", "src/tracked.ts"]);
    await execFileAsync("git", ["-C", repoDir, "commit", "-m", "initial"]);
    await writeFile(
      join(repoDir, "src", "tracked.ts"),
      "one\nthree\nfour\nfive\n",
    );

    const { snapshot } = await readSingleSignal({
      project: createProject({
        path: repoDir,
        hasCodexSessions: false,
        hasGeminiSessions: false,
      }),
      messages: [
        {
          type: "assistant",
          message: { content: "Implemented the change." },
        },
      ],
    });

    expect(snapshot.completed[0]?.changedFiles).toContainEqual({
      path: "src/tracked.ts",
      status: "M",
      staged: false,
      linesAdded: 2,
      linesDeleted: 1,
    });
  });

  it("does not attach whole-project changed files to every session when multiple sessions are present", async () => {
    const project = createProject({
      id: "proj-noisy" as UrlProjectId,
      path: "/Users/rare/Desktop/yepanywhere",
      name: "yepanywhere",
      hasCodexSessions: false,
      hasGeminiSessions: false,
    });
    const first = createSession({
      id: "sess-with-path",
      projectId: project.id,
      title: "Mature work snapshot parsing",
      updatedAt: "2026-05-11T10:00:00.000Z",
    });
    const second = createSession({
      id: "sess-without-path",
      projectId: project.id,
      title: "Discuss unrelated idea",
      updatedAt: "2026-05-11T09:00:00.000Z",
    });

    const snapshot = await readSnapshotForProjects({
      projects: [project],
      sessionsByProjectId: new Map([[project.id, [first, second]]]),
      messagesBySessionId: new Map([
        [
          first.id,
          [
            {
              type: "assistant",
              message: {
                content:
                  "Implemented /Users/rare/Desktop/yepanywhere/packages/server/src/work/workSnapshot.ts",
              },
            },
          ],
        ],
        [
          second.id,
          [
            {
              type: "assistant",
              message: { content: "Implemented the discussion summary." },
            },
          ],
        ],
      ]),
      changedFilesByProjectId: new Map([
        [
          project.id,
          [
            {
              path: "packages/server/src/work/workSnapshot.ts",
              status: "M",
              staged: false,
              linesAdded: 20,
              linesDeleted: 2,
            },
            {
              path: "packages/client/src/pages/SessionPage.tsx",
              status: "M",
              staged: false,
              linesAdded: 3,
              linesDeleted: 1,
            },
          ],
        ],
      ]),
    });

    const withPath = snapshot.completed.find(
      (signal) => signal.sessionId === first.id,
    );
    const withoutPath = snapshot.completed.find(
      (signal) => signal.sessionId === second.id,
    );
    expect(withPath?.changedFiles).toEqual([
      {
        path: "packages/server/src/work/workSnapshot.ts",
        status: "M",
        staged: false,
        linesAdded: 20,
        linesDeleted: 2,
      },
    ]);
    expect(withoutPath?.changedFiles).toBeUndefined();
  });

  it("reassigns a signal to another known project when absolute file evidence points there", async () => {
    const yepProject = createProject({
      id: "proj-yep" as UrlProjectId,
      path: "/Users/rare/Desktop/yepanywhere",
      name: "yepanywhere",
      hasCodexSessions: false,
      hasGeminiSessions: false,
    });
    const remiProject = createProject({
      id: "proj-remi" as UrlProjectId,
      path: "/Users/rare/Desktop/remi-ai",
      name: "remi-ai",
      hasCodexSessions: false,
      hasGeminiSessions: false,
    });
    const session = createSession({
      id: "sess-remi-work",
      projectId: yepProject.id,
      title: "Mature Remi work status",
      updatedAt: "2026-05-11T10:00:00.000Z",
    });

    const snapshot = await readSnapshotForProjects({
      projects: [yepProject, remiProject],
      sessionsByProjectId: new Map([
        [yepProject.id, [session]],
        [remiProject.id, []],
      ]),
      messagesBySessionId: new Map([
        [
          session.id,
          [
            {
              type: "assistant",
              message: {
                content:
                  "Implemented /Users/rare/Desktop/remi-ai/capabilities/yep_work_status_capability.ts",
              },
            },
          ],
        ],
      ]),
      changedFilesByProjectId: new Map([
        [yepProject.id, []],
        [
          remiProject.id,
          [
            {
              path: "capabilities/yep_work_status_capability.ts",
              status: "A",
              staged: false,
              linesAdded: 120,
              linesDeleted: 0,
            },
          ],
        ],
      ]),
    });

    expect(snapshot.completed[0]?.projectId).toBe(remiProject.id);
    expect(snapshot.completed[0]?.projectName).toBe("remi-ai");
    expect(snapshot.completed[0]?.changedFiles).toEqual([
      {
        path: "capabilities/yep_work_status_capability.ts",
        status: "A",
        staged: false,
        linesAdded: 120,
        linesDeleted: 0,
      },
    ]);
  });

  it("returns cached snapshots within ttl without rescanning", async () => {
    let nowMs = 1_000;
    const listProjects = vi.fn(async () => [
      createProject({ hasCodexSessions: false, hasGeminiSessions: false }),
    ]);
    const reader = createReader(
      [createSession()],
      [{ type: "assistant", message: { content: "Implemented the API." } }],
    );
    const provider = createWorkSnapshotProvider({
      scanner: { listProjects } as unknown as ProjectScanner,
      readerFactory: () => reader,
      getChangedFiles: vi.fn(async () => []),
      cacheTtlMs: 15_000,
      now: () => nowMs,
    });
    const options = {
      since: new Date("2026-05-11T00:00:00.000Z"),
      until: new Date("2026-05-11T12:00:00.000Z"),
      limit: 20,
    };

    const first = await provider.getSnapshot(options);
    nowMs += 1_000;
    const second = await provider.getSnapshot({
      ...options,
      until: new Date("2026-05-11T12:00:01.000Z"),
    });

    expect(second).toBe(first);
    expect(listProjects).toHaveBeenCalledTimes(1);
    expect(reader.getSession).toHaveBeenCalledTimes(1);
  });
});
