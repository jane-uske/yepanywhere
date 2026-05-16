import { describe, expect, it } from "vitest";
import {
  buildSessionRelationContext,
  getSessionParentId,
  isSubagentSession,
} from "../sessionRelations";
import { getSessionSourceInfo } from "../sessionSource";

function subagentSource(parentThreadId: string, depth = 1): unknown {
  return {
    subagent: {
      thread_spawn: {
        parent_thread_id: parentThreadId,
        depth,
      },
    },
  };
}

describe("sessionRelations", () => {
  it("extracts the parent thread id from a Codex subagent source", () => {
    expect(
      getSessionParentId({
        id: "child",
        source: subagentSource("parent"),
      }),
    ).toBe("parent");
  });

  it("extracts subagent display metadata from Codex thread spawn source", () => {
    expect(
      getSessionSourceInfo({
        subagent: {
          thread_spawn: {
            parent_thread_id: "parent",
            depth: 1,
            agent_nickname: "McClintock",
            agent_role: "worker",
          },
        },
      }),
    ).toEqual({
      label: "Subagent",
      parentThreadId: "parent",
      depth: 1,
      subagentName: "McClintock",
      subagentRole: "worker",
    });
  });

  it("identifies sessions with a parent thread as subagent sessions", () => {
    expect(
      isSubagentSession({ id: "child", source: subagentSource("parent") }),
    ).toBe(true);
    expect(
      isSubagentSession({
        id: "review-child",
        source: { subagent: "review" },
      }),
    ).toBe(true);
    expect(isSubagentSession({ id: "parent" })).toBe(false);
  });

  it("builds child context for a parent session", () => {
    const parent = { id: "parent", createdAt: "2026-05-13T00:00:00Z" };
    const childA = {
      id: "child-a",
      source: subagentSource("parent"),
      createdAt: "2026-05-13T00:02:00Z",
    };
    const childB = {
      id: "child-b",
      source: subagentSource("parent"),
      createdAt: "2026-05-13T00:01:00Z",
    };

    const context = buildSessionRelationContext(parent, [childA, childB]);

    expect(context.rootSessionId).toBe("parent");
    expect(context.parentSessionId).toBeUndefined();
    expect(context.childSessions.map((session) => session.id)).toEqual([
      "child-b",
      "child-a",
    ]);
  });

  it("builds sibling context for a child session", () => {
    const parent = { id: "parent", createdAt: "2026-05-13T00:00:00Z" };
    const current = {
      id: "child-a",
      source: subagentSource("parent"),
      createdAt: "2026-05-13T00:02:00Z",
    };
    const sibling = {
      id: "child-b",
      source: subagentSource("parent"),
      createdAt: "2026-05-13T00:01:00Z",
    };

    const context = buildSessionRelationContext(current, [parent, sibling]);

    expect(context.rootSessionId).toBe("parent");
    expect(context.parentSessionId).toBe("parent");
    expect(context.parentSession).toBe(parent);
    expect(context.childSessions.map((session) => session.id)).toEqual([
      "child-b",
      "child-a",
    ]);
  });
});
