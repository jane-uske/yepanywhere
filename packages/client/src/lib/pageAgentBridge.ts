export interface PageAgentContext {
  capturedAt?: string;
  kpa?: {
    contextSeq?: number;
    selectionId?: string;
    source?: string;
    sentAt?: string;
    hasSelection?: boolean;
  };
  tab?: {
    title?: string;
    url?: string;
  };
  page?: {
    product?: {
      key?: "alime" | "xspace" | "unknown" | string;
      name?: string;
      codeGroup?: string | null;
      confidence?: "high" | "medium" | "low" | string;
      reason?: string;
      domain?: string;
    };
    shell?: {
      type?: string;
      url?: string;
      origin?: string;
      pathname?: string;
      title?: string;
      env?: string;
      cdnPath?: string | null;
    };
    alime?: {
      currentPage?: {
        title?: string;
        path?: string;
        app?: {
          title?: string;
          group?: string;
          name?: string;
          version?: string;
        };
        subLink?: {
          title?: string;
          path?: string;
          menuCode?: string;
        } | null;
      } | null;
    };
    xspace?: PageAgentXspaceContext | null;
  };
  selection?: {
    element?: {
      tag?: string;
      id?: string | null;
      text?: string;
      classes?: string[];
      cssModuleHints?: string[];
      attributes?: Record<string, string>;
      role?: string | null;
      ariaLabel?: string | null;
      title?: string | null;
      placeholder?: string | null;
    };
    layout?: {
      rect?: {
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      };
      computedStyle?: Record<string, string>;
    };
    paths?: {
      selector?: string;
      baseScrollPath?: string;
      textPath?: string;
    };
    context?: {
      ownerContainer?: unknown;
      nearestLandmarks?: unknown[];
    };
  } | null;
  screenshot?: string | { error?: string };
  devGuide?: {
    prompt?: string;
    repoPath?: string;
    repoUrl?: string;
    codeGroup?: string | null;
    cdnHints?: Array<{
      cdnGroup?: string;
      name?: string;
      version?: string;
      repoPath?: string;
    }>;
  } | null;
  [key: string]: unknown;
}

export interface PageAgentXspaceContext {
  routePath?: string;
  routeSegments?: string[];
  pageName?: string;
  repoHint?: string;
  searchTerms?: string[];
  isPageRoute?: boolean;
  source?: string;
}

export type PageAgentInboundMessage =
  | {
      type: "PA_CONTEXT";
      payload?: PageAgentContext;
      context?: PageAgentContext;
      instruction?: string;
      prompt?: string;
      autoInsert?: boolean;
      autoSend?: boolean;
    }
  | {
      type: "PA_INSERT_PROMPT";
      payload?: {
        instruction?: string;
        context?: PageAgentContext;
      };
    }
  | {
      type: "PA_SELECTION_UPDATE";
      selection: PageAgentContext["selection"];
    }
  | {
      type: "PA_PING";
    };

export type PageAgentOutboundMessage =
  | {
      type: "YEP_PA_READY";
      capabilities: string[];
    }
  | {
      type: "YEP_PA_REQUEST_CONTEXT";
    }
  | {
      type: "YEP_PA_START_PICKER";
    }
  | {
      type: "YEP_PA_CONTEXT_RECEIVED";
      app?: string;
      hasSelection: boolean;
      contextSeq?: number;
      selectionId?: string;
    }
  | {
      type: "YEP_PA_PROMPT_SENT";
    };

const PAGE_AGENT_MODE_STORAGE_KEY = "page-agent.mode";
const PAGE_AGENT_HOST_ORIGIN_KEY = "page-agent.hostOrigin";

export function isPageAgentMode(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const enabledByUrl =
    params.get("mode") === "page-agent" ||
    params.get("kpa") === "1" ||
    params.get("host") === "chrome-extension";

  if (enabledByUrl) {
    try {
      window.sessionStorage.setItem(PAGE_AGENT_MODE_STORAGE_KEY, "1");
    } catch {
      // Ignore storage failures; URL parameters are still enough for this render.
    }
    return true;
  }

  try {
    return window.sessionStorage.getItem(PAGE_AGENT_MODE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function isTrustedPageAgentOrigin(origin: string): boolean {
  if (origin === window.location.origin) return true;
  if (origin.startsWith("chrome-extension://")) return true;

  const params = new URLSearchParams(window.location.search);
  const allowedOrigin = params.get("hostOrigin");
  if (allowedOrigin) {
    try {
      window.sessionStorage.setItem(PAGE_AGENT_HOST_ORIGIN_KEY, allowedOrigin);
    } catch {
      // Ignore storage failures
    }
    if (origin === allowedOrigin) return true;
  }

  try {
    const stored = window.sessionStorage.getItem(PAGE_AGENT_HOST_ORIGIN_KEY);
    if (stored && origin === stored) return true;
  } catch {
    // Ignore storage failures
  }

  return false;
}

export function postPageAgentMessage(message: PageAgentOutboundMessage): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage(message, "*");
}

export function getPageAgentContextSummary(context: PageAgentContext | null) {
  const app = context?.page?.alime?.currentPage?.app;
  const page = context?.page?.alime?.currentPage;
  const productTarget = context ? resolveProductTarget(context) : null;
  const element = context?.selection?.element;
  const rect = context?.selection?.layout?.rect;

  return {
    appLabel: app
      ? `${app.group}/${app.name}`
      : (productTarget?.label ?? "Unknown app"),
    appVersion: app?.version ?? "",
    pageLabel: page?.subLink?.title ?? page?.title ?? page?.path ?? "",
    elementLabel: element
      ? [element.tag, element.text ? `"${element.text.slice(0, 32)}"` : ""]
          .filter(Boolean)
          .join(" ")
      : "No element selected",
    rectLabel:
      rect?.width && rect?.height ? `${rect.width} x ${rect.height}` : "",
  };
}

export function buildPageAgentPrompt(
  context: PageAgentContext,
  instruction?: string,
): string {
  const fallback = context.selection
    ? "请基于当前选中的页面元素定位相关代码并完成修改。"
    : "请基于当前页面上下文定位相关代码并完成修改。";
  const task = instruction?.trim() || fallback;
  const productTarget = resolveProductTarget(context);
  const xspaceRouteHint =
    productTarget.key === "xspace" ? resolveXspaceRouteHint(context) : null;
  const codeGroupConstraint = productTarget.codeGroup
    ? `- 页面产品分类为 ${productTarget.label}，代码平台搜索范围使用 ${productTarget.codeGroup}。`
    : "- Page context product not yet classified; infer from domain, title, and resource path.";
  const cdnHints = (context.selection as any)?.cdnHints as
    | Array<{
        repoPath: string;
        version: string;
        source: string;
        appName?: string;
      }>
    | undefined;
  const cdnHintConstraint =
    cdnHints && cdnHints.length > 0
      ? `- 选中元素关联的 CDN 仓库线索（按可信度排序）：${cdnHints.map((h) => `${h.repoPath}@${h.version}（来源：${h.source}${h.appName ? `，micro-app name: ${h.appName}` : ""}）`).join("；")}。优先用这些 repoPath 在代码平台直接搜索仓库，不需要再猜。`
      : null;
  const xspaceRouteConstraint =
    xspaceRouteHint?.repoHint && productTarget.codeGroup
      ? `- Xspace 页面路由线索为 ${xspaceRouteHint.routePath ?? "-"}；如果是 page 路由，优先用最后一段 ${xspaceRouteHint.repoHint} 在当前 workspace 和 ${productTarget.codeGroup} 代码组做模糊检索。`
      : null;
  const devGuideConstraint = context.devGuide?.prompt
    ? `- 本地调试指引：\n${context.devGuide.prompt}`
    : null;

  return [
    task,
    "",
    "执行约束：",
    codeGroupConstraint,
    ...(cdnHintConstraint ? [cdnHintConstraint] : []),
    ...(xspaceRouteConstraint ? [xspaceRouteConstraint] : []),
    ...(devGuideConstraint ? [devGuideConstraint] : []),
    "- 定位仓库时先检查当前 workspace 内是否已有对应仓库；没有时，再通过 code 平台 MCP 在产品对应代码组搜索并下载/拉取。",
    "- 不要在 workspace 之外盲目扫本地目录；如果 workspace 与 code 平台结果冲突，说明选择依据。",
    "- 定位仓库后按需要通过 o2 MCP 建迭代、推进改动、提交和部署。",
    "- 需要查产品文档、业务说明或规范时使用 yuque MCP；代码仓库相关操作使用 code 平台 MCP；迭代、部署和发布流程使用 o2 MCP。",
    "- 不要创建额外的任务系统；如果必须偏离上述路径，先说明原因。",
    "",
    "页面上下文来自 Page Agent browser extension：",
    "```json",
    JSON.stringify(getPromptContext(context, xspaceRouteHint), null, 2),
    "```",
    "",
    "请基于上述最小页面上下文定位代码并完成修改，最后说明改动和验证结果。",
  ].join("\n");
}

function resolveProductTarget(context: PageAgentContext) {
  const declaredKey = context.page?.product?.key?.toLowerCase();
  const declaredCodeGroup = context.page?.product?.codeGroup;

  if (declaredKey === "xspace") {
    return {
      key: "xspace",
      label: "Xspace",
      codeGroup:
        declaredCodeGroup || "https://code.alibaba-inc.com/aidc-xspace",
    };
  }
  if (declaredKey === "alime" || declaredKey === "alimebot") {
    return {
      key: "alimebot",
      label: "AlimeBot",
      codeGroup: declaredCodeGroup || "https://code.alibaba-inc.com/aidc-mefe",
    };
  }

  const currentPage = context.page?.alime?.currentPage;
  const xspaceRouteHint = resolveXspaceRouteHint(context);
  const signal = [
    context.tab?.url,
    context.tab?.title,
    context.page?.shell?.origin,
    context.page?.shell?.pathname,
    context.page?.shell?.title,
    xspaceRouteHint?.routePath,
    xspaceRouteHint?.repoHint,
    currentPage?.path,
    currentPage?.app?.group,
    currentPage?.app?.name,
    context.page?.product?.name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/(^|[./_-])(xspace|xp)([./_-]|$)|xp-subapp|xspace/.test(signal)) {
    return {
      key: "xspace",
      label: "Xspace",
      codeGroup: "https://code.alibaba-inc.com/aidc-xspace",
    };
  }
  if (currentPage || /(^|[./_-])alime([./_-]|$)|mefe/.test(signal)) {
    return {
      key: "alimebot",
      label: "AlimeBot",
      codeGroup: "https://code.alibaba-inc.com/aidc-mefe",
    };
  }

  return {
    key: "unknown",
    label: "Unknown product",
    codeGroup: null,
  };
}

function resolveXspaceRouteHint(
  context: PageAgentContext,
): PageAgentXspaceContext | null {
  const fromPayload = normalizeXspaceRouteHint(context.page?.xspace);
  if (fromPayload?.repoHint) return fromPayload;

  return (
    parseXspaceRouteHint(context.tab?.url) ??
    parseXspaceRouteHint(context.page?.shell?.url) ??
    null
  );
}

function normalizeXspaceRouteHint(
  value: PageAgentXspaceContext | null | undefined,
): PageAgentXspaceContext | null {
  if (!value) return null;

  const rebuilt = value.routePath
    ? buildXspaceRouteHint(value.routePath, value.source ?? "plugin")
    : null;
  const repoHint = value.repoHint || rebuilt?.repoHint || value.pageName;
  if (!repoHint) return rebuilt;

  return pickDefined({
    routePath: rebuilt?.routePath ?? value.routePath,
    routeSegments: value.routeSegments ?? rebuilt?.routeSegments,
    pageName: value.pageName ?? repoHint,
    repoHint,
    searchTerms: uniqueStrings([
      ...(value.searchTerms ?? []),
      ...(rebuilt?.searchTerms ?? []),
      repoHint,
    ]).slice(0, 4),
    isPageRoute: value.isPageRoute ?? rebuilt?.isPageRoute,
    source: value.source ?? rebuilt?.source,
  });
}

function parseXspaceRouteHint(
  rawUrl: string | null | undefined,
): PageAgentXspaceContext | null {
  if (!rawUrl) return null;

  let hash = "";
  try {
    hash = new URL(rawUrl, "https://page-agent.invalid").hash;
  } catch {
    const hashIndex = rawUrl.indexOf("#");
    hash = hashIndex >= 0 ? rawUrl.slice(hashIndex) : "";
  }

  if (!hash) return null;
  const routePath = normalizeRoutePath(hash.replace(/^#/, ""));
  return routePath ? buildXspaceRouteHint(routePath, "url-hash") : null;
}

function normalizeRoutePath(value: string) {
  const withoutQuery = value.replace(/^!/, "").split(/[?#]/)[0] ?? "";
  const decoded = safeDecodeUri(withoutQuery).trim();
  const withSlash = decoded.startsWith("/") ? decoded : `/${decoded}`;
  const normalized = withSlash.replace(/\/+/g, "/").replace(/\/$/, "");
  if (!normalized || normalized === "/") return "";
  return normalized;
}

function buildXspaceRouteHint(
  routePath: string,
  source: string,
): PageAgentXspaceContext | null {
  const normalizedRoutePath = normalizeRoutePath(routePath);
  if (!normalizedRoutePath) return null;

  const routeSegments = normalizedRoutePath.split("/").filter(Boolean);
  const repoHint = routeSegments.at(-1);
  if (!repoHint) return null;

  return {
    routePath: normalizedRoutePath,
    routeSegments,
    pageName: repoHint,
    repoHint,
    searchTerms: uniqueStrings([repoHint, routeSegments.at(-2)]).slice(0, 4),
    isPageRoute: true,
    source,
  };
}

function getPromptContext(
  context: PageAgentContext,
  xspaceRouteHint: PageAgentXspaceContext | null = resolveXspaceRouteHint(
    context,
  ),
) {
  const selection = context.selection;
  const currentPage = context.page?.alime?.currentPage;
  const element = selection?.element;
  const computedStyle = selection?.layout?.computedStyle;

  return {
    capturedAt: context.capturedAt,
    kpa: {
      contextSeq: context.kpa?.contextSeq,
      selectionId: context.kpa?.selectionId,
      hasSelection: context.kpa?.hasSelection,
    },
    tab: pickDefined({
      title: context.tab?.title,
      url: context.tab?.url,
    }),
    page: pickDefined({
      product: context.page?.product,
      shell: pickDefined({
        type: context.page?.shell?.type,
        origin: context.page?.shell?.origin,
        pathname: context.page?.shell?.pathname,
        title: context.page?.shell?.title,
        env: context.page?.shell?.env,
        cdnPath: context.page?.shell?.cdnPath,
      }),
      currentPage: currentPage
        ? pickDefined({
            title: currentPage.title,
            path: currentPage.path,
            app: currentPage.app,
            subLink: currentPage.subLink,
          })
        : null,
      xspace: xspaceRouteHint
        ? pickDefined({
            routePath: xspaceRouteHint.routePath,
            routeSegments: xspaceRouteHint.routeSegments,
            pageName: xspaceRouteHint.pageName,
            repoHint: xspaceRouteHint.repoHint,
            searchTerms: xspaceRouteHint.searchTerms,
            isPageRoute: xspaceRouteHint.isPageRoute,
            source: xspaceRouteHint.source,
          })
        : null,
    }),
    selection: selection
      ? pickDefined({
          cdnHints: (selection as any).cdnHints?.length
            ? (selection as any).cdnHints
            : undefined,
          element: element
            ? pickDefined({
                tag: element.tag,
                id: element.id,
                text: truncate(element.text, 240),
                classes: element.classes?.slice(0, 12),
                cssModuleHints: element.cssModuleHints?.slice(0, 8),
                role: element.role,
                ariaLabel: element.ariaLabel,
                title: element.title,
                placeholder: element.placeholder,
                attributes: pickElementAttributes(element.attributes),
              })
            : undefined,
          layout: pickDefined({
            rect: selection.layout?.rect,
            style: pickComputedStyle(computedStyle),
          }),
          paths: selection.paths,
          ownerContainer: selection.context?.ownerContainer,
        })
      : null,
    devGuide: context.devGuide
      ? pickDefined({
          repoPath: context.devGuide.repoPath,
          repoUrl: context.devGuide.repoUrl,
          codeGroup: context.devGuide.codeGroup,
          cdnHints: context.devGuide.cdnHints,
        })
      : undefined,
  };
}

function safeDecodeUri(value: string) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter(Boolean))) as string[];
}

function pickComputedStyle(style?: Record<string, string>) {
  if (!style) return undefined;
  return pickDefined({
    display: style.display,
    position: style.position,
    width: style.width,
    height: style.height,
    color: style.color,
    backgroundColor: style.backgroundColor,
    border: style.border,
    borderRadius: style.borderRadius,
    padding: style.padding,
    margin: style.margin,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
  });
}

function pickElementAttributes(attributes?: Record<string, string>) {
  if (!attributes) return undefined;
  const entries = Object.entries(attributes)
    .filter(([key]) => /^(data-|aria-|id$|name$|type$|title$)/.test(key))
    .slice(0, 16)
    .map(([key, value]) => [key, truncate(value, 160)] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function pickDefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}

function truncate(value: string | null | undefined, max: number) {
  if (!value) return value;
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
