import type { GlobalSessionItem } from "../api/client";
import { isSubagentSession } from "./sessionRelations";

export interface SidebarProjectGroup {
  projectId: string;
  projectName: string;
  latestUpdatedAt: string;
  sessions: GlobalSessionItem[];
}

function getSortTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareSessionsByUpdatedAt(
  a: GlobalSessionItem,
  b: GlobalSessionItem,
): number {
  return (
    getSortTime(b.updatedAt) - getSortTime(a.updatedAt) ||
    a.id.localeCompare(b.id)
  );
}

export function buildSidebarProjectGroups(
  sessions: GlobalSessionItem[],
): SidebarProjectGroup[] {
  const groupsByProject = new Map<string, SidebarProjectGroup>();

  for (const session of sessions) {
    if (session.isStarred || session.isArchived || isSubagentSession(session)) {
      continue;
    }

    const existing = groupsByProject.get(session.projectId);
    if (existing) {
      existing.sessions.push(session);
      if (
        getSortTime(session.updatedAt) > getSortTime(existing.latestUpdatedAt)
      ) {
        existing.latestUpdatedAt = session.updatedAt;
      }
      continue;
    }

    groupsByProject.set(session.projectId, {
      projectId: session.projectId,
      projectName: session.projectName,
      latestUpdatedAt: session.updatedAt,
      sessions: [session],
    });
  }

  return Array.from(groupsByProject.values())
    .map((group) => ({
      ...group,
      sessions: [...group.sessions].sort(compareSessionsByUpdatedAt),
    }))
    .sort(
      (a, b) =>
        getSortTime(b.latestUpdatedAt) - getSortTime(a.latestUpdatedAt) ||
        a.projectName.localeCompare(b.projectName) ||
        a.projectId.localeCompare(b.projectId),
    );
}
