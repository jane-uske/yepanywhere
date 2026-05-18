# Page Agent Host Mode

Yep Anywhere can be embedded inside a **Page Agent** browser extension that
injects page context (URL, selected text, page structure) into the Claude Code
session.

## How it works

1. The extension opens Yep Anywhere in an iframe with `?mode=page-agent`.
2. The client detects the mode and signals readiness via `postMessage`.
3. The extension sends page context; the client builds a contextual prompt.
4. User can start a new session or inject context into an existing one.

## Message Protocol

**Outbound (Yep → Extension):**
- `YEP_PA_READY` — client is ready to receive context
- `YEP_PA_REQUEST_CONTEXT` — request fresh page context
- `YEP_PA_PROMPT_SENT` — prompt was sent to Claude

**Inbound (Extension → Yep):**
- `PA_CONTEXT` — page context payload (url, title, selection, etc.)
- `PA_PING` — extension checking if client is alive

## Server Preflight

`GET /api/page-agent/preflight` returns connection diagnostics:
- Whether auth is required
- The target session/project URL with mode params appended
- WebSocket URL for the extension to connect directly

## CSP Configuration

To allow the extension to embed Yep Anywhere:

```bash
YEP_FRAME_ANCESTORS="chrome-extension://<extension-id>" pnpm dev
```

## Example URLs

```
https://your-host:3400/projects/<id>/sessions/<sid>?mode=page-agent&host=chrome-extension
https://your-host:3400/api/page-agent/preflight?targetPath=/projects/<id>/sessions/<sid>
```
