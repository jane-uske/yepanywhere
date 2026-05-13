export interface KimiPageAgentContext {
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
    xspace?: KimiPageAgentXspaceContext | null;
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
  [key: string]: unknown;
}

export interface KimiPageAgentXspaceContext {
  routePath?: string;
  routeSegments?: string[];
  pageName?: string;
  repoHint?: string;
  searchTerms?: string[];
  isPageRoute?: boolean;
  source?: string;
}

export type KimiPageAgentInboundMessage =
  | {
      type: "KPA_CONTEXT";
      payload?: KimiPageAgentContext;
      context?: KimiPageAgentContext;
      instruction?: string;
      autoInsert?: boolean;
      autoSend?: boolean;
    }
  | {
      type: "KPA_INSERT_PROMPT";
      payload?: {
        instruction?: string;
        context?: KimiPageAgentContext;
      };
    }
  | {
      type: "KPA_PING";
    };

export type KimiPageAgentOutboundMessage =
  | {
      type: "YEP_KPA_READY";
      capabilities: string[];
    }
  | {
      type: "YEP_KPA_REQUEST_CONTEXT";
    }
  | {
      type: "YEP_KPA_START_PICKER";
    }
  | {
      type: "YEP_KPA_CONTEXT_RECEIVED";
      app?: string;
      hasSelection: boolean;
      contextSeq?: number;
      selectionId?: string;
    }
  | {
      type: "YEP_KPA_PROMPT_SENT";
    };

const KIMI_PAGE_AGENT_MODE_STORAGE_KEY = "kimi-page-agent.mode";

export function isKimiPageAgentMode(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  const enabledByUrl =
    params.get("mode") === "kimi-page-agent" ||
    params.get("kpa") === "1" ||
    params.get("host") === "chrome-extension";

  if (enabledByUrl) {
    try {
      window.sessionStorage.setItem(KIMI_PAGE_AGENT_MODE_STORAGE_KEY, "1");
    } catch {
      // Ignore storage failures; URL parameters are still enough for this render.
    }
    return true;
  }

  try {
    return (
      window.sessionStorage.getItem(KIMI_PAGE_AGENT_MODE_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

export function isTrustedKimiPageAgentOrigin(origin: string): boolean {
  if (origin === window.location.origin) return true;
  if (origin.startsWith("chrome-extension://")) return true;

  const params = new URLSearchParams(window.location.search);
  const allowedOrigin = params.get("hostOrigin");
  if (allowedOrigin && origin === allowedOrigin) return true;

  return false;
}

export function postKimiPageAgentMessage(
  message: KimiPageAgentOutboundMessage,
): void {
  if (typeof window === "undefined" || window.parent === window) return;
  window.parent.postMessage(message, "*");
}

export function getKimiContextSummary(context: KimiPageAgentContext | null) {
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

export function buildKimiPageAgentPrompt(
  context: KimiPageAgentContext,
  instruction?: string,
): string {
  const taskIntent = inferKimiPageAgentTaskIntent(instruction);
  const readonlyTask = taskIntent === "readonly";
  const fallback = readonlyTask
    ? context.selection
      ? "请基于当前选中的页面元素定位相关代码并说明实现逻辑。不要修改代码。"
      : "请基于当前页面上下文定位相关代码并说明实现逻辑。不要修改代码。"
    : context.selection
      ? "请基于当前选中的页面元素定位相关代码并完成修改。"
      : "请基于当前页面上下文定位相关代码并完成修改。";
  const task = instruction?.trim() || fallback;
  const productTarget = resolveProductTarget(context);
  const xspaceRouteHint =
    productTarget.key === "xspace" ? resolveXspaceRouteHint(context) : null;
  const codeGroupConstraint = productTarget.codeGroup
    ? `- 页面产品分类为 ${productTarget.label}，代码平台搜索范围使用 ${productTarget.codeGroup}。`
    : "- 页面产品暂未明确分类；先根据域名、页面标题、资源路径判断产品归属。确认是 Xspace 时使用 https://code.alibaba-inc.com/aidc-xspace，确认是 Alime 时使用 https://code.alibaba-inc.com/aidc-mefe。";
  const xspaceRouteConstraint =
    xspaceRouteHint?.repoHint && productTarget.codeGroup
      ? `- Xspace 页面路由线索为 ${xspaceRouteHint.routePath ?? "-"}；如果是 page 路由，优先用最后一段 ${xspaceRouteHint.repoHint} 在当前 workspace 和 ${productTarget.codeGroup} 代码组做模糊检索。`
      : null;
  const workflowConstraint = readonlyTask
    ? "- 本次任务是只读分析：不要编辑文件、不要创建迭代、不要提交或部署；如果判断必须修改，先说明建议改法并等待确认。"
    : "- 定位仓库后按需要通过 o2 MCP 建迭代、推进改动、提交和部署。";
  const externalToolsConstraint = readonlyTask
    ? "- 需要查产品文档、业务说明或规范时使用 yuque MCP；代码仓库相关操作使用 code 平台 MCP；本次不要使用 o2 创建迭代、部署或发布。"
    : "- 需要查产品文档、业务说明或规范时使用 yuque MCP；代码仓库相关操作使用 code 平台 MCP；迭代、部署和发布流程使用 o2 MCP。";
  const finalInstruction = readonlyTask
    ? "请基于上述最小页面上下文定位代码并说明按钮/页面逻辑、相关文件和调用链；不要修改、提交或部署任何代码。最后说明查看位置和结论。"
    : "请基于上述最小页面上下文定位代码并完成修改，最后说明改动和验证结果。";

  return [
    task,
    "",
    "执行约束：",
    codeGroupConstraint,
    ...(xspaceRouteConstraint ? [xspaceRouteConstraint] : []),
    "- 定位仓库时先检查当前 workspace 内是否已有对应仓库；没有时，再通过 code 平台 MCP 在产品对应代码组搜索并下载/拉取。",
    "- 不要在 workspace 之外盲目扫本地目录；如果 workspace 与 code 平台结果冲突，说明选择依据。",
    workflowConstraint,
    externalToolsConstraint,
    "- 不要创建额外的任务系统；如果必须偏离上述路径，先说明原因。",
    "",
    "页面上下文来自 Aidc-pageAgent 浏览器插件：",
    "```json",
    JSON.stringify(getPromptContext(context, xspaceRouteHint), null, 2),
    "```",
    "",
    finalInstruction,
  ].join("\n");
}

export function buildKimiPageAgentFollowupPrompt(
  context: KimiPageAgentContext,
  instruction: string,
): string {
  if (!context.selection) return instruction;

  const productTarget = resolveProductTarget(context);
  const xspaceRouteHint =
    productTarget.key === "xspace" ? resolveXspaceRouteHint(context) : null;
  const currentPage = context.page?.alime?.currentPage;
  const element = context.selection.element;
  const paths = context.selection.paths;

  const followupContext = pickDefined({
    product: context.page?.product
      ? pickDefined({
          key: context.page.product.key,
          name: context.page.product.name,
          codeGroup: context.page.product.codeGroup,
        })
      : undefined,
    xspace: xspaceRouteHint
      ? pickDefined({
          routePath: xspaceRouteHint.routePath,
          repoHint: xspaceRouteHint.repoHint,
          searchTerms: xspaceRouteHint.searchTerms,
        })
      : undefined,
    currentPage: currentPage
      ? pickDefined({
          title: currentPage.title,
          path: currentPage.path,
          app: currentPage.app,
          subLink: currentPage.subLink,
        })
      : undefined,
    selection: pickDefined({
      element: element
        ? pickDefined({
            tag: element.tag,
            id: element.id,
            text: truncate(element.text, 180),
            classes: element.classes?.slice(0, 8),
            cssModuleHints: element.cssModuleHints?.slice(0, 6),
            role: element.role,
            ariaLabel: element.ariaLabel,
            title: element.title,
            placeholder: element.placeholder,
          })
        : undefined,
      rect: context.selection.layout?.rect,
      paths: pickDefined({
        selector: paths?.selector,
        baseScrollPath: paths?.baseScrollPath,
        textPath: truncate(paths?.textPath, 220),
      }),
    }),
  });

  return [
    instruction.trim(),
    "",
    "本轮 Aidc-pageAgent 新选中元素上下文（仅用于定位代码，不重复执行约束）：",
    "```json",
    JSON.stringify(followupContext, null, 2),
    "```",
  ].join("\n");
}

function inferKimiPageAgentTaskIntent(
  instruction: string | undefined,
): "readonly" | "modify" {
  const text = instruction?.trim();
  if (!text) return "modify";

  const compact = text.toLowerCase().replace(/\s+/g, "");

  if (
    /(不要|不用|先别|别|无需|不需要|不必|禁止)(修改|改动|改代码|动代码|写代码|实现|提交|部署|变更|编辑|保存|落地)/.test(
      compact,
    ) ||
    /(只看|仅看|只分析|仅分析|只解释|只定位|只说明|readonly|don'?tchange|donotchange|nocodechanges)/.test(
      compact,
    )
  ) {
    return "readonly";
  }

  if (
    /(修改|改一下|改成|修复|实现|新增|删除|替换|调整|优化|落地|完成修改|提交|部署|发版|建迭代|修一下|帮我改|做一下|加上|去掉|移除|隐藏|显示|对齐|改为|改下|fix|implement|change|update|add|remove|delete|refactor|deploy)/.test(
      compact,
    )
  ) {
    return "modify";
  }

  if (
    /(看下|看看|看一下|查下|查一下|分析|解释|说明|讲下|讲一下|梳理|了解|定位|排查|确认|判断|逻辑|为什么|怎么回事|是什么|含义|作用|入口|链路|流程|where|why|explain|analy[sz]e|inspect|investigate|understand)/.test(
      compact,
    )
  ) {
    return "readonly";
  }

  return "modify";
}

function resolveProductTarget(context: KimiPageAgentContext) {
  const declaredKey = context.page?.product?.key?.toLowerCase();
  if (declaredKey === "xspace") {
    return {
      key: "xspace",
      label: "Xspace",
      codeGroup: "https://code.alibaba-inc.com/aidc-xspace",
    };
  }
  if (declaredKey === "alime" || declaredKey === "alimebot") {
    return {
      key: "alime",
      label: declaredKey === "alimebot" ? "AlimeBot" : "Alime",
      codeGroup: "https://code.alibaba-inc.com/aidc-mefe",
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

  if (/(^|[./_-])(xspace|xp)([./_-]|$)|xp-subapp|aidc-xspace/.test(signal)) {
    return {
      key: "xspace",
      label: "Xspace",
      codeGroup: "https://code.alibaba-inc.com/aidc-xspace",
    };
  }
  if (currentPage || /(^|[./_-])alime([./_-]|$)|aidc-mefe/.test(signal)) {
    return {
      key: "alime",
      label: "Alime",
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
  context: KimiPageAgentContext,
): KimiPageAgentXspaceContext | null {
  const fromPayload = normalizeXspaceRouteHint(context.page?.xspace);
  if (fromPayload?.repoHint) return fromPayload;

  return (
    parseXspaceRouteHint(context.tab?.url) ??
    parseXspaceRouteHint(context.page?.shell?.url) ??
    null
  );
}

function normalizeXspaceRouteHint(
  value: KimiPageAgentXspaceContext | null | undefined,
): KimiPageAgentXspaceContext | null {
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
): KimiPageAgentXspaceContext | null {
  if (!rawUrl) return null;

  let hash = "";
  try {
    hash = new URL(rawUrl, "https://aidc-page-agent.invalid").hash;
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
): KimiPageAgentXspaceContext | null {
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
  context: KimiPageAgentContext,
  xspaceRouteHint: KimiPageAgentXspaceContext | null = resolveXspaceRouteHint(
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
