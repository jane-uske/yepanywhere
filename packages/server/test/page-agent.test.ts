import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AuthService } from "../src/auth/AuthService.js";
import { createPageAgentRoutes } from "../src/routes/page-agent.js";
import { MockClaudeSDK } from "../src/sdk/mock.js";

describe("Page Agent preflight", () => {
  it("builds embed URLs from forwarded sandbox origin and session target path", async () => {
    const routes = createPageAgentRoutes();
    const targetPath =
      "/projects/L2hvbWUvYWRtaW4/sessions/fc624e64-ded8-4673-9105-f0fcb6600319";

    const res = await routes.request(
      `/preflight?targetPath=${encodeURIComponent(targetPath)}`,
      {
        headers: {
          "x-forwarded-proto": "https",
          "x-forwarded-host": "localhost:3400",
        },
      },
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.service).toBe("yep-anywhere");
    expect(json.capability).toBe("page-agent");
    expect(json.origin).toBe("http://localhost:3400");
    expect(json.target.kind).toBe("session");
    expect(json.urls.targetEmbedUrl).toBe(
      "http://localhost:3400/projects/L2hvbWUvYWRtaW4/sessions/fc624e64-ded8-4673-9105-f0fcb6600319?mode=page-agent&host=chrome-extension",
    );
    expect(json.urls.websocketUrl).toBe("ws://localhost:3400/api/ws");
  });

  it("preserves existing target query params when adding KPA params", async () => {
    const routes = createPageAgentRoutes();

    const res = await routes.request(
      `/preflight?targetPath=${encodeURIComponent("/new-session?projectId=abc")}`,
    );
    const json = await res.json();
    const embed = new URL(json.urls.targetEmbedUrl);

    expect(embed.pathname).toBe("/new-session");
    expect(embed.searchParams.get("projectId")).toBe("abc");
    expect(embed.searchParams.get("mode")).toBe("page-agent");
    expect(embed.searchParams.get("host")).toBe("chrome-extension");
  });

  it("falls back to new-session for cross-origin target URLs", async () => {
    const routes = createPageAgentRoutes();

    const res = await routes.request(
      `/preflight?targetPath=${encodeURIComponent("https://evil.example/path")}`,
    );
    const json = await res.json();
    const embed = new URL(json.urls.targetEmbedUrl);

    expect(embed.origin).toBe("http://localhost");
    expect(embed.pathname).toBe("/new-session");
    expect(json.target.kind).toBe("new-session");
  });

  it("adds explicit CORS headers for chrome extension preflight reads", async () => {
    const routes = createPageAgentRoutes();

    const res = await routes.request("/preflight", {
      headers: {
        origin: "chrome-extension://abcdefghijklmnop",
      },
    });

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "chrome-extension://abcdefghijklmnop",
    );
  });

  it("reports desktop token floor as plugin auth warning", async () => {
    const authService = {
      isEnabled: () => false,
      isLocalhostOpen: () => false,
    } as AuthService;
    const routes = createPageAgentRoutes({
      authService,
      desktopAuthToken: "secret",
    });

    const res = await routes.request("/preflight");
    const json = await res.json();

    expect(json.auth.mode).toBe("desktop-token-floor");
    expect(json.auth.requiredForPlugin).toBe(true);
    expect(
      json.checks.some(
        (check: { id: string; status: string }) =>
          check.id === "auth" && check.status === "warning",
      ),
    ).toBe(true);
  });

  it("is reachable through createApp even when auth is enabled", async () => {
    const authService = {
      isEnabled: () => true,
      isLocalhostOpen: () => false,
    } as AuthService;
    const { app } = createApp({ authService, sdk: new MockClaudeSDK() });

    const res = await app.request("/api/page-agent/preflight");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.auth.mode).toBe("password");
  });
});
