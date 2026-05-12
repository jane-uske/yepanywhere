# Aidc-pageAgent Host Mode

A Yep Anywhere session can run inside the Chrome extension side panel as an iframe host mode.
The extension owns page-context capture only; the embedded app reuses its normal new
session and existing session flows to send that context to the selected agent.

Open the embedded app with:

```text
/new-session?mode=kimi-page-agent&host=chrome-extension
```

For an existing session, append the same query parameters to the session URL.

When enabled:

- sends `YEP_KPA_READY` to the parent frame
- accepts `KPA_CONTEXT` messages from trusted `chrome-extension://` origins
- the new-session page receives context but does not show an inner element picker
- the embedded Yep page does not render its own Aidc-pageAgent picker panel; the
  outer extension owns selection and refresh controls
- selected-page context is converted into the user message sent to the agent
- the outer extension owns element selection and can open a fresh new-session iframe
- page context includes a `page.product` classification; Alime maps to
  `https://code.alibaba-inc.com/aidc-mefe`, Xspace maps to
  `https://code.alibaba-inc.com/aidc-xspace`
- Xspace page context may include `page.xspace.repoHint`; for URLs such as
  `/index.htm#/system/oms/pbx-new/operation-dashboard`, the last route segment
  `operation-dashboard` is used as the primary fuzzy repository search hint

## Inbound Messages

```ts
{
  type: "KPA_CONTEXT";
  payload: KimiPageAgentContext;
  instruction?: string;
  autoInsert?: boolean;
  autoSend?: boolean;
}
```

```ts
{
  type: "KPA_INSERT_PROMPT";
  payload: {
    instruction?: string;
    context: KimiPageAgentContext;
  };
}
```

## Outbound Messages

```ts
{ type: "YEP_KPA_READY"; capabilities: string[] }
{ type: "YEP_KPA_REQUEST_CONTEXT" }
{ type: "YEP_KPA_START_PICKER" }
{ type: "YEP_KPA_CONTEXT_RECEIVED"; app?: string; hasSelection: boolean }
{ type: "YEP_KPA_PROMPT_SENT" }
```

## Framing

Production static HTML now allows `chrome-extension:` in `frame-ancestors`.
Additional allowed ancestors can be appended with:

```sh
YEP_FRAME_ANCESTORS="https://example.alibaba-inc.com chrome-extension://<id>"
```

## Sandbox / Gateway Preflight

When Yep runs behind a company sandbox gateway, the browser extension should
accept either:

- a base URL such as `https://sandbox.example.com`
- a full Yep URL such as
  `https://sandbox.example.com/projects/<projectId>/sessions/<sessionId>`

Normalize the user input like this:

1. Use the input origin as the Yep origin.
2. Use the input path/search as `targetPath`. If the user only entered an
   origin, use `/new-session`.
3. Call:

```text
GET /api/kimi-page-agent/preflight?targetPath=<encoded path and query>
```

The response includes:

- `urls.targetEmbedUrl` - iframe this URL in the extension side panel
- `urls.newSessionEmbedUrl` - fallback URL for opening a new KPA session
- `urls.websocketUrl` - connect this from the plugin to verify gateway WebSocket
  support
- `framing.expectedContentSecurityPolicy` - the CSP Yep emits for static HTML
- `auth` and `checks` - machine-readable hints for setup warnings

For the Alibaba sandbox style URL:

```text
https://cdfc69-sandbox-session633f9874a3ca4b7e9f-3400.agent.alibaba-inc.com/projects/L2hvbWUvYWRtaW4/sessions/fc624e64-ded8-4673-9105-f0fcb6600319
```

the plugin should call:

```text
https://cdfc69-sandbox-session633f9874a3ca4b7e9f-3400.agent.alibaba-inc.com/api/kimi-page-agent/preflight?targetPath=%2Fprojects%2FL2hvbWUvYWRtaW4%2Fsessions%2Ffc624e64-ded8-4673-9105-f0fcb6600319
```

and iframe the returned `urls.targetEmbedUrl`.

Server-side requirements for the gateway:

- add the sandbox hostname to `ALLOWED_HOSTS` or Yep's Allowed Hosts setting
- proxy `/api/ws` with WebSocket Upgrade support
- do not overwrite Yep's iframe CSP or add `X-Frame-Options: DENY/SAMEORIGIN`
