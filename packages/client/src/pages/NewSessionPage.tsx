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
  type KimiPageAgentContext,
  type KimiPageAgentInboundMessage,
  buildKimiPageAgentPrompt,
  getKimiContextSummary,
  isKimiPageAgentMode,
  isTrustedKimiPageAgentOrigin,
  postKimiPageAgentMessage,
} from "../lib/kimiPageAgentBridge";
import {
  readKimiPageAgentContext,
  writeKimiPageAgentContext,
} from "../lib/kimiPageAgentContextStore";
import { generateUUID } from "../lib/uuid";

export function NewSessionPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const kimiMode = isKimiPageAgentMode();
  const [kimiContext, setKimiContext] = useState<KimiPageAgentContext | null>(
    () => readKimiPageAgentContext()?.context ?? null,
  );
  const [kimiInjectedText, setKimiInjectedText] = useState<{
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
    if (!kimiMode) return;

    const postReady = () => {
      postKimiPageAgentMessage({
        type: "YEP_KPA_READY",
        capabilities: ["receivePageContext", "insertPrompt", "createSession"],
      });
    };

    postReady();
    postKimiPageAgentMessage({ type: "YEP_KPA_REQUEST_CONTEXT" });

    const onMessage = (event: MessageEvent<KimiPageAgentInboundMessage>) => {
      const data = event.data;
      if (
        !data ||
        typeof data !== "object" ||
        !("type" in data) ||
        !String(data.type).startsWith("KPA_") ||
        !isTrustedKimiPageAgentOrigin(event.origin)
      ) {
        return;
      }

      if (data.type === "KPA_PING") {
        postReady();
        return;
      }

      const nextContext =
        data.type === "KPA_CONTEXT"
          ? (data.payload ?? data.context ?? null)
          : (data.payload?.context ?? null);
      const nextInstruction =
        data.type === "KPA_CONTEXT"
          ? data.instruction
          : data.payload?.instruction;

      if (!nextContext) return;

      writeKimiPageAgentContext(nextContext);
      setKimiContext(nextContext);

      const summary = getKimiContextSummary(nextContext);
      postKimiPageAgentMessage({
        type: "YEP_KPA_CONTEXT_RECEIVED",
        app: summary.appLabel,
        hasSelection: Boolean(nextContext.selection),
        contextSeq: nextContext.kpa?.contextSeq,
        selectionId: nextContext.kpa?.selectionId,
      });

      const prompt = buildKimiPageAgentPrompt(nextContext, nextInstruction);
      if (data.type === "KPA_INSERT_PROMPT" || data.autoInsert) {
        setKimiInjectedText({ id: generateUUID(), text: prompt });
      }
      if (data.type === "KPA_CONTEXT" && data.autoSend) {
        setKimiInjectedText({
          id: generateUUID(),
          text: prompt,
          autoStart: true,
        });
        postKimiPageAgentMessage({ type: "YEP_KPA_PROMPT_SENT" });
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [kimiMode]);

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
                injectedText={kimiInjectedText}
                transformMessage={
                  kimiMode && kimiContext
                    ? (message) =>
                        buildKimiPageAgentPrompt(kimiContext, message)
                    : undefined
                }
                onInjectedTextApplied={(id) => {
                  setKimiInjectedText((current) =>
                    current?.id === id ? null : current,
                  );
                }}
                onSessionStarted={() => {
                  if (kimiMode) {
                    postKimiPageAgentMessage({ type: "YEP_KPA_PROMPT_SENT" });
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
