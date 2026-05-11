import { describe, expect, it, vi } from "vitest";
import { createRemiWorkRoutes } from "../../src/routes/remi-work.js";
import type { WorkSnapshotProvider } from "../../src/work/workSnapshot.js";

describe("remi work route", () => {
  it("returns an empty bounded snapshot with default local-day window", async () => {
    const provider: WorkSnapshotProvider = {
      getSnapshot: vi.fn(async ({ since, until, limit }) => ({
        generatedAt: until.toISOString(),
        window: {
          since: since.toISOString(),
          until: until.toISOString(),
        },
        attention: [],
        active: [],
        completed: [],
        changedProjects: [],
      })),
    };
    const routes = createRemiWorkRoutes({ provider });

    const response = await routes.request("/work-snapshot");
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(provider.getSnapshot).toHaveBeenCalledTimes(1);
    const args = vi.mocked(provider.getSnapshot).mock.calls[0][0];
    expect(args.limit).toBe(20);
    expect(args.since.getHours()).toBe(0);
    expect(args.since.getMinutes()).toBe(0);
    expect(args.since.getSeconds()).toBe(0);
    expect(args.until.getTime()).toBeGreaterThanOrEqual(args.since.getTime());
    expect(body.attention).toEqual([]);
    expect(body.active).toEqual([]);
    expect(body.completed).toEqual([]);
    expect(body.changedProjects).toEqual([]);
  });

  it("caps limit at 50", async () => {
    const provider: WorkSnapshotProvider = {
      getSnapshot: vi.fn(async ({ since, until }) => ({
        generatedAt: until.toISOString(),
        window: { since: since.toISOString(), until: until.toISOString() },
        attention: [],
        active: [],
        completed: [],
        changedProjects: [],
      })),
    };
    const routes = createRemiWorkRoutes({ provider });

    const response = await routes.request("/work-snapshot?limit=999");

    expect(response.status).toBe(200);
    expect(vi.mocked(provider.getSnapshot).mock.calls[0][0].limit).toBe(50);
  });

  it("rejects invalid since values", async () => {
    const provider: WorkSnapshotProvider = {
      getSnapshot: vi.fn(),
    };
    const routes = createRemiWorkRoutes({ provider });

    const response = await routes.request("/work-snapshot?since=not-a-date");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid since" });
    expect(provider.getSnapshot).not.toHaveBeenCalled();
  });
});
