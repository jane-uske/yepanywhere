import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStaticRoutes,
  shouldServeDevStaticFrontend,
} from "../../src/frontend/static.js";

const tempDirs: string[] = [];

function createDistFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yep-static-test-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "index.html"),
    '<!doctype html><script type="module" src="/assets/index-D2n323UU.js"></script><div id="root"></div>',
  );
  fs.writeFileSync(
    path.join(dir, "assets", "index-D2n323UU.js"),
    "console.log('built client');",
  );
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("frontend static serving", () => {
  it("serves dev static frontend for remote hosts but not localhost", () => {
    expect(shouldServeDevStaticFrontend("raredesk.remi.run")).toBe(true);
    expect(shouldServeDevStaticFrontend("192.168.31.200:3400")).toBe(true);
    expect(shouldServeDevStaticFrontend("localhost:3400")).toBe(false);
    expect(shouldServeDevStaticFrontend("127.0.0.1:3400")).toBe(false);
    expect(shouldServeDevStaticFrontend("[::1]:3400")).toBe(false);
    expect(
      shouldServeDevStaticFrontend("raredesk.remi.run", {
        DEV_REMOTE_STATIC_FRONTEND: "false",
      }),
    ).toBe(false);
  });

  it("falls through to Vite fallback for localhost requests", async () => {
    const distPath = createDistFixture();
    const app = new Hono();

    app.route(
      "/",
      createStaticRoutes({
        distPath,
        shouldServeRequest: (c) =>
          shouldServeDevStaticFrontend(
            c.req.header("x-forwarded-host") ?? c.req.header("host"),
          ),
      }),
    );
    app.get("*", (c) => c.text("vite fallback"));

    const local = await app.request("/", {
      headers: { host: "localhost:3400" },
    });
    expect(await local.text()).toBe("vite fallback");

    const forwardedRemote = await app.request("/", {
      headers: {
        host: "127.0.0.1:3400",
        "x-forwarded-host": "raredesk.remi.run",
      },
    });
    expect(forwardedRemote.status).toBe(200);
    expect(await forwardedRemote.text()).toContain("/assets/index-D2n323UU.js");

    const remote = await app.request("/projects/example", {
      headers: { host: "raredesk.remi.run" },
    });
    expect(remote.status).toBe(200);
    expect(await remote.text()).toContain("/assets/index-D2n323UU.js");
    expect(remote.headers.get("cache-control")).toBe("no-cache");

    const asset = await app.request("/assets/index-D2n323UU.js", {
      headers: { host: "raredesk.remi.run" },
    });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("built client");
    expect(asset.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });
});
