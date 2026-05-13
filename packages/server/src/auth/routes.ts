/**
 * Authentication API routes
 */

import * as crypto from "node:crypto";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AuthService } from "./AuthService.js";

export const SESSION_COOKIE_NAME = "yep-anywhere-session";

export interface AuthRoutesDeps {
  authService: AuthService;
  /** Whether auth is disabled by env var (--auth-disable). Overrides settings. */
  authDisabled?: boolean;
  /** Desktop auth token (for protecting localhost-access endpoint). */
  desktopAuthToken?: string;
}

interface SetupBody {
  password: string;
}

interface LoginBody {
  password: string;
}

interface ChangePasswordBody {
  newPassword: string;
}

function shouldUseSecureCookie(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): boolean {
  // Honor reverse-proxy protocol hints when present.
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    const protocol = forwardedProto.split(",")[0]?.trim().toLowerCase();
    if (protocol === "https") {
      return true;
    }
    if (protocol === "http") {
      return false;
    }
  }

  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

function getSessionCookieSameSite(c: {
  req: { url: string; header: (name: string) => string | undefined };
}): "Lax" | "None" {
  return shouldUseSecureCookie(c) ? "None" : "Lax";
}

export function createAuthRoutes(deps: AuthRoutesDeps): Hono {
  const app = new Hono();
  const { authService, authDisabled = false, desktopAuthToken } = deps;

  /**
   * GET /api/auth/status
   * Check authentication status
   *
   * Returns:
   * - enabled: whether auth is enabled (from settings)
   * - authenticated: whether user has valid session
   * - setupRequired: whether initial setup is needed (enabled but no account)
   * - disabledByEnv: whether auth is disabled by --auth-disable flag
   * - authFilePath: path to auth.json (for recovery instructions)
   */
  app.get("/status", async (c) => {
    const isEnabled = authService.isEnabled();
    const base = {
      hasDesktopToken: !!desktopAuthToken,
      localhostOpen: authService.isLocalhostOpen(),
      authFilePath: authService.getFilePath(),
    };

    // If auth is disabled by env var, it overrides settings
    if (authDisabled) {
      return c.json({
        ...base,
        enabled: isEnabled,
        authenticated: true, // Bypass auth
        setupRequired: false,
        disabledByEnv: true,
      });
    }

    // If auth is not enabled in settings, no auth required
    if (!isEnabled) {
      return c.json({
        ...base,
        enabled: false,
        authenticated: true, // No auth needed
        setupRequired: false,
        disabledByEnv: false,
      });
    }

    // Auth is enabled - check session
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const hasAccount = authService.hasAccount();

    if (!hasAccount) {
      // This shouldn't happen normally since enableAuth creates account,
      // but handle edge case
      return c.json({
        ...base,
        enabled: true,
        authenticated: false,
        setupRequired: true,
        disabledByEnv: false,
      });
    }

    if (!sessionId) {
      return c.json({
        ...base,
        enabled: true,
        authenticated: false,
        setupRequired: false,
        disabledByEnv: false,
      });
    }

    const valid = await authService.validateSession(sessionId);
    return c.json({
      ...base,
      enabled: true,
      authenticated: valid,
      setupRequired: false,
      disabledByEnv: false,
    });
  });

  /**
   * POST /api/auth/enable
   * Enable auth with a password.
   * - Allowed only when auth is currently disabled.
   * - Treated as "add protection now" instead of account-ownership recovery.
   *
   * Security model note:
   * This server defaults to localhost with auth off. In that baseline model,
   * enabling auth is opportunistic hardening. If auth is enabled unexpectedly,
   * the operator can still recover with --auth-disable or --setup-auth.
   */
  app.post("/enable", async (c) => {
    const body = await c.req.json<SetupBody>();

    if (!body.password || typeof body.password !== "string") {
      return c.json({ error: "Password is required" }, 400);
    }

    if (body.password.length < 6) {
      return c.json({ error: "Password must be at least 6 characters" }, 400);
    }

    if (authService.isEnabled()) {
      return c.json(
        { error: "Authentication is already enabled. Use change-password." },
        409,
      );
    }

    const success = await authService.enableAuth(body.password);
    if (!success) {
      return c.json({ error: "Failed to enable auth" }, 500);
    }

    // Don't auto-login - require user to log in with their new password
    return c.json({ success: true });
  });

  /**
   * POST /api/auth/disable
   * Disable auth (requires authenticated session).
   * Also clears the stored account so future enable is a fresh setup.
   */
  app.post("/disable", async (c) => {
    // Require authenticated session to disable
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (!sessionId || !(await authService.validateSession(sessionId))) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    await authService.disableAuth();

    // Clear the session cookie
    deleteCookie(c, SESSION_COOKIE_NAME, {
      path: "/",
    });

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/setup
   * Create the initial account (only works when no account exists)
   * @deprecated Use /api/auth/enable instead
   */
  app.post("/setup", async (c) => {
    if (authService.hasAccount()) {
      return c.json({ error: "Account already exists" }, 400);
    }

    const body = await c.req.json<SetupBody>();

    if (!body.password || typeof body.password !== "string") {
      return c.json({ error: "Password is required" }, 400);
    }

    if (body.password.length < 6) {
      return c.json({ error: "Password must be at least 6 characters" }, 400);
    }

    // Use enableAuth to also set the enabled flag
    const success = await authService.enableAuth(body.password);
    if (!success) {
      return c.json({ error: "Failed to create account" }, 500);
    }

    // Auto-login after setup
    const userAgent = c.req.header("User-Agent");
    const sessionId = await authService.createSession(userAgent);

    setCookie(c, SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: shouldUseSecureCookie(c),
      sameSite: getSessionCookieSameSite(c),
      path: "/",
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/login
   * Login with password
   */
  app.post("/login", async (c) => {
    if (!authService.hasAccount()) {
      c.header("X-Setup-Required", "true");
      return c.json(
        { error: "No account configured", setupRequired: true },
        401,
      );
    }

    const body = await c.req.json<LoginBody>();

    if (!body.password || typeof body.password !== "string") {
      return c.json({ error: "Password is required" }, 400);
    }

    const valid = await authService.verifyPassword(body.password);
    if (!valid) {
      return c.json({ error: "Invalid password" }, 401);
    }

    const userAgent = c.req.header("User-Agent");
    const sessionId = await authService.createSession(userAgent);

    setCookie(c, SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: shouldUseSecureCookie(c),
      sameSite: getSessionCookieSameSite(c),
      path: "/",
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/logout
   * Logout (invalidate session)
   */
  app.post("/logout", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);

    if (sessionId) {
      await authService.invalidateSession(sessionId);
    }

    deleteCookie(c, SESSION_COOKIE_NAME, {
      path: "/",
    });

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/change-password
   * Change password (requires authenticated session)
   */
  app.post("/change-password", async (c) => {
    // Require authenticated session
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (!sessionId || !(await authService.validateSession(sessionId))) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const body = await c.req.json<ChangePasswordBody>();

    if (!body.newPassword || typeof body.newPassword !== "string") {
      return c.json({ error: "New password is required" }, 400);
    }

    if (body.newPassword.length < 6) {
      return c.json(
        { error: "New password must be at least 6 characters" },
        400,
      );
    }

    const success = await authService.changePassword(body.newPassword);
    if (!success) {
      return c.json({ error: "Failed to change password" }, 500);
    }

    return c.json({ success: true });
  });

  /**
   * POST /api/auth/localhost-access
   * Toggle unauthenticated localhost access (bypasses desktop token floor).
   * Requires valid desktop token or authenticated session.
   */
  app.post("/localhost-access", async (c) => {
    // Verify caller has desktop token or valid session
    let authorized = false;

    if (desktopAuthToken) {
      const headerToken = c.req.header("x-desktop-token");
      if (
        headerToken &&
        headerToken.length === desktopAuthToken.length &&
        crypto.timingSafeEqual(
          Buffer.from(headerToken),
          Buffer.from(desktopAuthToken),
        )
      ) {
        authorized = true;
      }
    }

    if (!authorized) {
      const sessionId = getCookie(c, SESSION_COOKIE_NAME);
      if (sessionId && (await authService.validateSession(sessionId))) {
        authorized = true;
      }
    }

    if (!authorized) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const body = await c.req.json<{ open: boolean }>();
    if (typeof body.open !== "boolean") {
      return c.json({ error: "open must be a boolean" }, 400);
    }

    await authService.setLocalhostOpen(body.open);
    return c.json({ success: true, localhostOpen: body.open });
  });

  return app;
}
