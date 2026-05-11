import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { ExternalSessionTracker } from "../../src/supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import { type BusEvent, EventBus } from "../../src/watcher/EventBus.js";

const SESSION_ID = "019e17bc-cfd6-7353-92a2-d57c67b8edee";
const CWD = "/Users/rare/Desktop/yepanywhere";
const PROJECT_ID = encodeProjectId(CWD);

function makeSupervisor(): Supervisor {
  return {
    getProcessForSession: () => null,
  } as unknown as Supervisor;
}

function makeScanner(): ProjectScanner {
  return {
    getProjectBySessionDirSuffix: async () => ({ id: PROJECT_ID }),
  } as unknown as ProjectScanner;
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 40; i++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

async function createCodexSessionFile(lines: string[]): Promise<string> {
  const dir = await mkdir(join(tmpdir(), `yep-external-${Date.now()}`), {
    recursive: true,
  });
  const filePath = join(dir, `rollout-2026-05-11T23-51-50-${SESSION_ID}.jsonl`);
  await writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

function sessionMetaLine(): string {
  return JSON.stringify({
    timestamp: "2026-05-11T15:51:50.000Z",
    type: "session_meta",
    payload: {
      id: SESSION_ID,
      timestamp: "2026-05-11T15:51:50.000Z",
      cwd: CWD,
      originator: "codex_exec",
    },
  });
}

function taskStartedLine(turnId: string): string {
  return JSON.stringify({
    timestamp: "2026-05-11T16:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "task_started",
      turn_id: turnId,
      model_context_window: 258400,
      collaboration_mode_kind: "default",
    },
  });
}

describe("ExternalSessionTracker", () => {
  let tracker: ExternalSessionTracker | null = null;

  afterEach(() => {
    tracker?.dispose();
    tracker = null;
  });

  it("broadcasts Codex external sessions as in-turn while the latest turn is unfinished", async () => {
    const eventBus = new EventBus();
    const events: BusEvent[] = [];
    eventBus.subscribe((event) => events.push(event));
    const filePath = await createCodexSessionFile([
      sessionMetaLine(),
      taskStartedLine("turn-active"),
    ]);

    tracker = new ExternalSessionTracker({
      eventBus,
      supervisor: makeSupervisor(),
      scanner: makeScanner(),
      decayMs: 25,
    });

    eventBus.emit({
      type: "file-change",
      provider: "codex",
      path: filePath,
      relativePath: `2026/05/11/rollout-2026-05-11T23-51-50-${SESSION_ID}.jsonl`,
      changeType: "modify",
      timestamp: new Date().toISOString(),
      fileType: "session",
    });

    await waitForAssertion(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session-status-changed",
          sessionId: SESSION_ID,
          projectId: PROJECT_ID,
          ownership: { owner: "external" },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "process-state-changed",
          sessionId: SESSION_ID,
          projectId: PROJECT_ID,
          activity: "in-turn",
        }),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(tracker.isExternal(SESSION_ID)).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "session-status-changed" &&
          event.sessionId === SESSION_ID &&
          event.ownership.owner === "none",
      ),
    ).toBe(false);
  });
});
