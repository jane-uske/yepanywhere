import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { NewSessionForm } from "../components/NewSessionForm";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useProject, useProjects } from "../hooks/useProjects";
import { resolvePreferredProjectId } from "../hooks/useRecentProject";
import { useI18n } from "../i18n";
import { useNavigationLayout } from "../layouts";
import {
  type PageAgentContext,
  type PageAgentInboundMessage,
  buildPageAgentPrompt,
  getPageAgentContextSummary,
  isPageAgentMode,
  isTrustedPageAgentOrigin,
  postPageAgentMessage,
} from "../lib/pageAgentBridge";
import {
  readPageAgentContext,
  writePageAgentContext,
} from "../lib/pageAgentContextStore";
import { generateUUID } from "../lib/uuid";

export function NewSessionPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const pageAgentMode = isPageAgentMode();
  const [pageAgentContext, setPageAgentContext] =
    useState<PageAgentContext | null>(
      () => readPageAgentContext()?.context ?? null,
    );
  const [pageAgentInjectedText, setPageAgentInjectedText] = useState<{
    id: string;
    text: string;
    autoStart?: boolean;
  } | null>(null);
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  // Get all projects to find default if no projectId specified
  const { projects, loading: projectsLoading } = useProjects();

  // Use the provided projectId, or the preferred recent project when available
  const effectiveProjectId = projectId || resolvePreferredProjectId(projects);

  const {
    project,
    loading: projectLoading,
    error,
  } = useProject(effectiveProjectId ?? undefined);

  // Update browser tab title (must be called unconditionally before any early returns)
  useDocumentTitle(project?.name, t("newSessionTitle"));

  // Callback to update projectId in URL without navigation
  const handleProjectChange = (newProjectId: string) => {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set("projectId", newProjectId);
    setSearchParams(nextParams, { replace: true });
  };

  useEffect(() => {
    if (!pageAgentMode) return;

    const postReady = () => {
      postPageAgentMessage({
        type: "YEP_PA_READY",
        capabilities: ["receivePageContext", "insertPrompt", "createSession"],
      });
    };

    postReady();
    postPageAgentMessage({ type: "YEP_PA_REQUEST_CONTEXT" });

    const onMessage = (event: MessageEvent<PageAgentInboundMessage>) => {
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        !("type" in data) ||
        !String(data.type).startsWith("PA_") ||
        !isTrustedPageAgentOrigin(event.origin)
      ) {
        return;
      }

      if (data.type === "PA_PING") {
        postReady();
        return;
      }

      const nextContext =
        data.type === "PA_CONTEXT"
          ? (data.payload ?? data.context ?? null)
          : (data.payload?.context ?? null);
      const nextInstruction =
        data.type === "PA_CONTEXT"
          ? data.instruction
          : data.payload?.instruction;

      if (!nextContext) return;

      writePageAgentContext(nextContext);
      setPageAgentContext(nextContext);

      const summary = getPageAgentContextSummary(nextContext);
      postPageAgentMessage({
        type: "YEP_PA_CONTEXT_RECEIVED",
        app: summary.appLabel,
        hasSelection: Boolean(nextContext.selection),
        contextSeq: nextContext.kpa?.contextSeq,
        selectionId: nextContext.kpa?.selectionId,
      });

      const prompt = buildPageAgentPrompt(nextContext, nextInstruction);
      if (data.type === "PA_INSERT_PROMPT" || data.autoInsert) {
        setPageAgentInjectedText({ id: generateUUID(), text: prompt });
      }
      if (data.type === "PA_CONTEXT" && data.autoSend) {
        setPageAgentInjectedText({
          id: generateUUID(),
          text: prompt,
          autoStart: true,
        });
        postPageAgentMessage({ type: "YEP_PA_PROMPT_SENT" });
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pageAgentMode]);

  const loading = projectLoading || projectsLoading;

  // Guard against missing projectId (no projects available)
  if (!effectiveProjectId && !projectsLoading && projects.length === 0) {
    return <div className="error">{t("newSessionNoProjects")}</div>;
  }

  // Render loading/error states
  if (loading || error) {
    return (
      <div
        className={
          isWideScreen ? "main-content-wrapper" : "main-content-mobile"
        }
      >
        <div
          className={
            isWideScreen
              ? "main-content-constrained"
              : "main-content-mobile-inner"
          }
        >
          <PageHeader
            title={t("newSessionTitle")}
            onOpenSidebar={openSidebar}
            onToggleSidebar={toggleSidebar}
            isWideScreen={isWideScreen}
            isSidebarCollapsed={isSidebarCollapsed}
          />
          <main className="page-scroll-container">
            <div className="page-content-inner">
              {loading ? (
                <div className="loading">{t("newSessionLoading")}</div>
              ) : (
                <div className="error">
                  {t("newSessionErrorPrefix")} {error?.message}
                </div>
              )}
            </div>
          </main>
        </div>
      </div>
    );
  }

  return (
    <div
      className={isWideScreen ? "main-content-wrapper" : "main-content-mobile"}
    >
      <div
        className={
          isWideScreen
            ? "main-content-constrained"
            : "main-content-mobile-inner"
        }
      >
        <PageHeader
          title={project?.name ?? t("newSessionTitle")}
          titleElement={
            effectiveProjectId ? (
              <ProjectSelector
                currentProjectId={effectiveProjectId}
                currentProjectName={project?.name}
                onProjectChange={(p) => handleProjectChange(p.id)}
              />
            ) : undefined
          }
          onOpenSidebar={openSidebar}
          onToggleSidebar={toggleSidebar}
          isWideScreen={isWideScreen}
          isSidebarCollapsed={isSidebarCollapsed}
        />

        <main className="page-scroll-container">
          <div className="page-content-inner">
            {effectiveProjectId && (
              <NewSessionForm
                projectId={effectiveProjectId}
                injectedText={pageAgentInjectedText}
                transformMessage={
                  pageAgentMode && pageAgentContext
                    ? (message) =>
                        buildPageAgentPrompt(pageAgentContext, message)
                    : undefined
                }
                onInjectedTextApplied={(id) => {
                  setPageAgentInjectedText((current) =>
                    current?.id === id ? null : current,
                  );
                }}
                onSessionStarted={() => {
                  if (pageAgentMode) {
                    postPageAgentMessage({ type: "YEP_PA_PROMPT_SENT" });
                  }
                }}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
