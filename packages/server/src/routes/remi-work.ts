import type { RemiWorkSnapshotResponse } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { WorkSnapshotProvider } from "../work/workSnapshot.js";

export interface RemiWorkRoutesDeps {
  provider: WorkSnapshotProvider;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

export function createRemiWorkRoutes(deps: RemiWorkRoutesDeps): Hono {
  const routes = new Hono();

  routes.get("/work-snapshot", async (c) => {
    const sinceResult = parseSince(c.req.query("since"));
    if (!sinceResult.ok) {
      return c.json({ error: "Invalid since" }, 400);
    }

    const limit = parseLimit(c.req.query("limit"));
    if (limit === null) {
      return c.json({ error: "Invalid limit" }, 400);
    }

    const until = new Date();
    const snapshot: RemiWorkSnapshotResponse = await deps.provider.getSnapshot({
      since: sinceResult.value,
      until,
      limit,
    });
    return c.json(snapshot);
  });

  return routes;
}

function parseSince(
  value: string | undefined,
): { ok: true; value: Date } | { ok: false } {
  if (!value) return { ok: true, value: startOfLocalDay(new Date()) };
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return { ok: false };
  return { ok: true, value: parsed };
}

function parseLimit(value: string | undefined): number | null {
  if (!value) return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return Math.min(parsed, MAX_LIMIT);
}

function startOfLocalDay(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}
