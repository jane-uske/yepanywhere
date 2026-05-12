import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthService } from "../auth/AuthService.js";
import { getFrameAncestorsCsp } from "../frontend/static.js";

const KIMI_PAGE_AGENT_MODE = "kimi-page-agent";
const KIMI_PAGE_AGENT_HOST = "chrome-extension";

type CheckStatus = "pass" | "warning" | "needs_client_check";

interface PreflightCheck {
  id: string;
  status: CheckStatus;
  message: string;
  url?: string;
}

export interface KimiPageAgentRoutesOptions {
  authService?: AuthService;
  authDisabled?: boolean;
  desktopAuthToken?: string;
}

export function createKimiPageAgentRoutes(
  options: KimiPageAgentRoutesOptions = {},
): Hono {
  const app = new Hono();

  app.options("/preflight", (c) => {
    setExtensionCorsHeaders(c);
    c.header("Access-Control-Allow-Methods", "GET, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type, X-Yep-Anywhere");
    return c.body(null, 204);
  });

  app.get("/preflight", (c) => {
    setExtensionCorsHeaders(c);

    const publicOrigin = getPublicOrigin(c);
    const targetPath = c.req.query("targetPath");
    const target = resolveTargetUrl(publicOrigin, targetPath);
    const targetEmbedUrl = withKimiPageAgentParams(target);
    const newSessionEmbedUrl = withKimiPageAgentParams(
      new URL("/new-session", publicOrigin),
    );
    const websocketUrl = getWebSocketUrl(publicOrigin);
    const auth = getAuthAdvice(options);
    const frameAncestorsCsp = getFrameAncestorsCsp();

    const checks: PreflightCheck[] = [
      {
        id: "yep_server",
        status: "pass",
        message: "Reached the Yep Anywhere Kimi Page Agent preflight endpoint.",
      },
      {
        id: "host_allowed",
        status: "pass",
        message:
          "The request Host passed Yep Anywhere host validation. If this endpoint returns 403, add the sandbox hostname to ALLOWED_HOSTS.",
      },
      {
        id: "websocket_proxy",
        status: "needs_client_check",
        message:
          "The plugin should open this WebSocket URL to verify the sandbox gateway supports Upgrade and long-lived connections.",
        url: websocketUrl,
      },
      {
        id: "framing_headers",
        status: "needs_client_check",
        message:
          "The plugin should iframe the embed URL to verify the upstream gateway does not override CSP or add X-Frame-Options.",
        url: targetEmbedUrl,
      },
    ];

    if (auth.requiredForPlugin) {
      checks.push({
        id: "auth",
        status: "warning",
        message: auth.message,
      });
    } else {
      checks.push({
        id: "auth",
        status: "pass",
        message: auth.message,
      });
    }

    c.header("Cache-Control", "no-store");
    return c.json({
      service: "yep-anywhere",
      capability: "kimi-page-agent",
      version: 1,
      origin: publicOrigin,
      urls: {
        targetEmbedUrl,
        newSessionEmbedUrl,
        websocketUrl,
        healthUrl: new URL("/health", publicOrigin).toString(),
      },
      target: {
        requestedPath: targetPath ?? null,
        resolvedPath: `${target.pathname}${target.search}${target.hash}`,
        kind: getTargetKind(target),
      },
      framing: {
        expectedContentSecurityPolicy: frameAncestorsCsp,
        defaultFrameAncestorsIncludeChromeExtension:
          frameAncestorsCsp.includes("chrome-extension:"),
      },
      auth,
      checks,
    });
  });

  return app;
}

function getPublicOrigin(c: Context): string {
  const forwardedHost = firstHeaderValue(c.req.header("x-forwarded-host"));
  const forwardedProto = firstHeaderValue(c.req.header("x-forwarded-proto"));
  const host = forwardedHost ?? c.req.header("host");

  if (host) {
    const protocol =
      forwardedProto ??
      (new URL(c.req.url).protocol === "https:" ? "https" : "http");
    return `${protocol}://${host}`;
  }

  return new URL(c.req.url).origin;
}

function firstHeaderValue(value: string | undefined): string | undefined {
  return value
    ?.split(",")
    .map((part) => part.trim())
    .find(Boolean);
}

function resolveTargetUrl(
  publicOrigin: string,
  targetPath: string | undefined,
) {
  if (!targetPath || targetPath.trim() === "" || targetPath === "/") {
    return new URL("/new-session", publicOrigin);
  }

  try {
    const target = new URL(targetPath, publicOrigin);
    if (target.origin !== publicOrigin) {
      return new URL("/new-session", publicOrigin);
    }
    return target;
  } catch {
    return new URL("/new-session", publicOrigin);
  }
}

function withKimiPageAgentParams(url: URL): string {
  const next = new URL(url);
  next.searchParams.set("mode", KIMI_PAGE_AGENT_MODE);
  next.searchParams.set("host", KIMI_PAGE_AGENT_HOST);
  return next.toString();
}

function getWebSocketUrl(publicOrigin: string): string {
  const url = new URL("/api/ws", publicOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function getTargetKind(target: URL): "new-session" | "session" | "other" {
  if (target.pathname === "/new-session") return "new-session";
  if (/^\/projects\/[^/]+\/sessions\/[^/]+/.test(target.pathname)) {
    return "session";
  }
  return "other";
}

function getAuthAdvice(options: KimiPageAgentRoutesOptions) {
  if (!options.authService) {
    return {
      mode: "unknown" as const,
      requiredForPlugin: false,
      message: "No server auth service is configured for this Yep instance.",
    };
  }

  if (options.authDisabled) {
    return {
      mode: "disabled" as const,
      requiredForPlugin: false,
      message: "Yep authentication is disabled by server configuration.",
    };
  }

  if (options.authService.isEnabled()) {
    return {
      mode: "password" as const,
      requiredForPlugin: true,
      message:
        "Yep password authentication is enabled. The iframe may need an existing login session, or the plugin should use a dedicated binding token in a later integration step.",
    };
  }

  if (options.desktopAuthToken && !options.authService.isLocalhostOpen()) {
    return {
      mode: "desktop-token-floor" as const,
      requiredForPlugin: true,
      message:
        "This server is protected by a Desktop auth token floor. Chrome extensions cannot read the Tauri desktop token; enable localhost access or use a plugin binding token.",
    };
  }

  return {
    mode: "open" as const,
    requiredForPlugin: false,
    message: "Yep API access is open for this request path.",
  };
}

function setExtensionCorsHeaders(c: Context): void {
  const origin = c.req.header("origin");
  if (!origin?.startsWith("chrome-extension://")) return;

  c.header("Access-Control-Allow-Origin", origin);
  c.header("Vary", "Origin");
}
