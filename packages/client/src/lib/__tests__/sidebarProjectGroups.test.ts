import { describe, expect, it } from "vitest";
import type { GlobalSessionItem } from "../../api/client";
import { buildSidebarProjectGroups } from "../sidebarProjectGroups";

function session(
  id: string,
  projectId: string,
  projectName: string,
  updatedAt: string,
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    provider: "codex",
    projectId,
    projectName,
    ownership: { owner: "none" },
    ...overrides,
  };
}

describe("buildSidebarProjectGroups", () => {
  it("groups sessions by project and sorts projects by latest session", () => {
    const groups = buildSidebarProjectGroups([
      session("old-a", "project-a", "Project A", "2026-05-12T10:00:00Z"),
      session("new-b", "project-b", "Project B", "2026-05-14T10:00:00Z"),
      session("new-a", "project-a", "Project A", "2026-05-15T10:00:00Z"),
      session("old-b", "project-b", "Project B", "2026-05-11T10:00:00Z"),
    ]);

    expect(groups.map((group) => group.projectId)).toEqual([
      "project-a",
      "project-b",
    ]);
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual([
      "new-a",
      "old-a",
    ]);
    expect(groups[1]?.sessions.map((item) => item.id)).toEqual([
      "new-b",
      "old-b",
    ]);
  });

  it("excludes starred, archived, and subagent sessions", () => {
    const groups = buildSidebarProjectGroups([
      session("visible", "project-a", "Project A", "2026-05-15T10:00:00Z"),
      session("starred", "project-a", "Project A", "2026-05-16T10:00:00Z", {
        isStarred: true,
      }),
      session("archived", "project-a", "Project A", "2026-05-17T10:00:00Z", {
        isArchived: true,
      }),
      session("subagent", "project-a", "Project A", "2026-05-18T10:00:00Z", {
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "visible",
            },
          },
        },
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions.map((item) => item.id)).toEqual(["visible"]);
  });
});
