/**
 * Static file serving for production mode.
 *
 * In production, we serve the built Vite output directly from the backend.
 * This provides a single-port deployment without needing a separate web server.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Context, Hono } from "hono";

const DEFAULT_FRAME_ANCESTORS = [
  "'self'",
  "tauri://localhost",
  "https://tauri.localhost",
  "chrome-extension:",
];

export interface StaticServeOptions {
  /** Path to the built client dist directory */
  distPath: string;
  /** Optional base path prefix to strip from requests (e.g., "/_stable") */
  basePath?: string;
  /**
   * Optional predicate for conditional static serving.
   * Return false to let later routes handle the request.
   */
  shouldServeRequest?: (c: Context) => boolean;
}

/**
 * Create Hono routes for serving static files.
 *
 * This serves:
 * - Static assets (JS, CSS, images) with appropriate headers
 * - index.html for all other routes (SPA fallback)
 */
export function createStaticRoutes(options: StaticServeOptions): Hono {
  const { distPath, basePath, shouldServeRequest } = options;
  const app = new Hono();

  // Check if dist directory exists
  if (!fs.existsSync(distPath)) {
    console.warn(
      `[Static] Warning: dist directory not found at ${distPath}. Run 'pnpm build' first.`,
    );
  }

  // Path to index.html for SPA fallback (read fresh each request to pick up rebuilds)
  const indexPath = path.join(distPath, "index.html");

  // Serve static files
  app.on(["GET", "HEAD"], "*", async (c, next) => {
    if (shouldServeRequest && !shouldServeRequest(c)) {
      return next();
    }

    let reqPath = c.req.path;

    // Strip base path prefix if configured (e.g., "/_stable" -> "")
    if (basePath && reqPath.startsWith(basePath)) {
      reqPath = reqPath.slice(basePath.length) || "/";
    }

    // Try to serve the exact file
    const filePath = path.join(distPath, reqPath);

    // Security: ensure we're not escaping the dist directory
    const normalizedFilePath = path.normalize(filePath);
    if (!normalizedFilePath.startsWith(distPath)) {
      return c.text("Forbidden", 403);
    }

    try {
      const stat = await fs.promises.stat(filePath);

      if (stat.isFile()) {
        const content = await fs.promises.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        const contentType = getContentType(ext);

        // Cache static assets (they have hashed filenames)
        const cacheControl = isHashedAsset(reqPath)
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate";

        const headers: Record<string, string> = {
          "Content-Type": contentType,
          "Cache-Control": cacheControl,
        };

        // Add CSP frame-ancestors for HTML files (must be HTTP header, not meta tag)
        if (ext === ".html") {
          headers["Content-Security-Policy"] = getFrameAncestorsCsp();
        }

        return c.body(content, 200, headers);
      }
      // Not a file (e.g., directory), fall through to SPA fallback
    } catch (err) {
      // Only fall through to SPA for missing files, not for other errors
      const isNotFound =
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT";
      if (!isNotFound) {
        console.error(`[Static] Error serving ${filePath}:`, err);
      }
    }

    // SPA fallback: serve index.html for all other routes
    // Read fresh each time to pick up rebuilds without server restart
    try {
      const indexHtml = await fs.promises.readFile(indexPath, "utf-8");
      return c.html(indexHtml, 200, {
        "Content-Security-Policy": getFrameAncestorsCsp(),
        "Cache-Control": "no-cache",
      });
    } catch {
      return c.text(
        "Not found. Did you run 'pnpm build' to build the client?",
        404,
      );
    }
  });

  return app;
}

export function getFrameAncestorsCsp(
  env: Record<string, string | undefined> = process.env,
): string {
  const extra = env.YEP_FRAME_ANCESTORS?.split(/\s+/).filter(Boolean) ?? [];
  return `frame-ancestors ${[...DEFAULT_FRAME_ANCESTORS, ...extra].join(" ")}`;
}

/**
 * In dev mode, non-local browser hosts are usually mobile/LAN/tunnel access.
 * Serving the built Vite output there avoids the slow Vite ESM module waterfall
 * over high-latency tunnels while localhost keeps HMR.
 */
export function shouldServeDevStaticFrontend(
  hostHeader: string | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (
    env.DEV_REMOTE_STATIC_FRONTEND === "false" ||
    env.REMOTE_STATIC_FRONTEND === "false"
  ) {
    return false;
  }

  const hostname = extractHostname(hostHeader);
  if (!hostname) return false;
  return !isLocalDevHostname(hostname);
}

function extractHostname(hostHeader: string | undefined): string | null {
  const value = hostHeader?.trim().toLowerCase();
  if (!value) return null;

  if (value.startsWith("[")) {
    const closeBracket = value.indexOf("]");
    if (closeBracket === -1) return value;
    return value.slice(1, closeBracket);
  }

  const firstColon = value.indexOf(":");
  const lastColon = value.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon) {
    return value.slice(0, firstColon);
  }

  return value;
}

function isLocalDevHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "0.0.0.0"
  );
}

/**
 * Get content type for a file extension.
 */
function getContentType(ext: string): string {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".map": "application/json",
  };

  return types[ext] || "application/octet-stream";
}

/**
 * Check if a path is a hashed asset (can be cached forever).
 * Vite adds hashes to filenames like: index-abc123.js
 */
function isHashedAsset(reqPath: string): boolean {
  // Match Vite hashed assets like /assets/index-D2n323UU.js.
  return /\/assets\/[^/]+-[A-Za-z0-9_-]+\.[a-z]+$/i.test(reqPath);
}
