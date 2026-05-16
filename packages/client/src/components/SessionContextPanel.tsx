import type { GitFileChange } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { GlobalSessionItem } from "../api/client";
import { useGitStatus } from "../hooks/useGitStatus";
import { useGlobalSessions } from "../hooks/useGlobalSessions";
import { useI18n } from "../i18n";
import {
  extractGeneratedResults,
  extractInspectorProgress,
} from "../lib/sessionInspector";
import { buildSessionRelationContext } from "../lib/sessionRelations";
import {
  formatShortSessionId,
  getSessionSourceInfo,
} from "../lib/sessionSource";
import type { Message, Session, SessionStatus } from "../types";
import { getSessionDisplayTitle } from "../utils";
import { Modal } from "./ui/Modal";

type ProcessState = "idle" | "in-turn" | "waiting-input" | "hold";

interface SessionContextPanelProps {
  basePath: string;
  currentSession: Session;
  messages: Message[];
  status: SessionStatus;
  processState: ProcessState;
  actualSessionId: string;
  projectName?: string;
  onCollapse?: () => void;
}

type ContextPanelSession = Pick<
  GlobalSessionItem,
  | "id"
  | "title"
  | "customTitle"
  | "createdAt"
  | "updatedAt"
  | "projectId"
  | "provider"
  | "model"
  | "ownership"
  | "activity"
  | "pendingInputType"
  | "hasUnread"
  | "source"
> & {
  projectName?: string;
};

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface GitDiffResult {
  diffHtml: string;
  structuredPatch: PatchHunk[];
  markdownHtml?: string;
}

function toCurrentPanelSession(
  session: Session,
  projectName?: string,
): ContextPanelSession {
  return {
    id: session.id,
    title: session.title,
    customTitle: session.customTitle,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    projectId: session.projectId,
    projectName,
    provider: session.provider,
    model: session.model,
    ownership: session.ownership,
    activity: session.activity,
    pendingInputType: session.pendingInputType,
    hasUnread: session.hasUnread,
    source: session.source,
  };
}

function getStatusKey(
  session: ContextPanelSession,
  options: { suppressUnread?: boolean } = {},
): "running" | "waiting" | "unread" | "idle" {
  if (session.pendingInputType || session.activity === "waiting-input") {
    return "waiting";
  }
  if (
    session.activity === "in-turn" ||
    session.ownership.owner === "self" ||
    session.ownership.owner === "external"
  ) {
    return "running";
  }
  if (!options.suppressUnread && session.hasUnread) return "unread";
  return "idle";
}

function getStatusLabel(
  status: ReturnType<typeof getStatusKey>,
  t: ReturnType<typeof useI18n>["t"],
): string {
  switch (status) {
    case "running":
      return t("sessionContextStatusRunning");
    case "waiting":
      return t("sessionContextStatusWaiting");
    case "unread":
      return t("sessionContextStatusUnread");
    case "idle":
      return t("sessionContextStatusIdle");
  }
}

function formatLineDelta(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function getFileName(path: string): string {
  return path.split("/").pop() || path;
}

function getSessionProviderMeta(session: ContextPanelSession): string {
  return session.model
    ? `${session.provider} · ${session.model}`
    : session.provider;
}

function getSubagentMeta(
  session: ContextPanelSession,
  t: ReturnType<typeof useI18n>["t"],
): string {
  const sourceInfo = getSessionSourceInfo(session.source);
  const parts = [
    sourceInfo?.subagentName,
    sourceInfo?.subagentRole,
    sourceInfo?.depth !== undefined
      ? t("sessionContextDepth", { depth: sourceInfo.depth })
      : undefined,
    sourceInfo?.parentThreadId
      ? t("sessionContextParentShort", {
          id: formatShortSessionId(sourceInfo.parentThreadId),
        })
      : undefined,
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" · ") : getSessionProviderMeta(session);
}

function SessionContextItem({
  session,
  currentSessionId,
  basePath,
  suppressUnreadStatus = false,
  meta,
}: {
  session: ContextPanelSession;
  currentSessionId: string;
  basePath: string;
  suppressUnreadStatus?: boolean;
  meta?: string;
}) {
  const { t } = useI18n();
  const title = getSessionDisplayTitle(session);
  const status = getStatusKey(session, {
    suppressUnread: suppressUnreadStatus,
  });
  const isCurrent = session.id === currentSessionId;
  const hideStatusLabel =
    suppressUnreadStatus && session.hasUnread && status === "idle";

  return (
    <Link
      to={`${basePath}/projects/${session.projectId}/sessions/${session.id}`}
      className={`session-context-item ${isCurrent ? "current" : ""}`}
      title={title}
    >
      <span className={`session-context-agent-icon status-${status}`} />
      <span className="session-context-item-main">
        <span className="session-context-item-title">
          {title}
          {isCurrent && (
            <span className="session-context-current">
              {t("sessionContextCurrent")}
            </span>
          )}
        </span>
        <span className="session-context-item-meta">
          {meta ?? getSessionProviderMeta(session)}
        </span>
      </span>
      {!hideStatusLabel && (
        <span className={`session-context-status status-${status}`}>
          {getStatusLabel(status, t)}
        </span>
      )}
    </Link>
  );
}

function InspectorSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="session-context-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function ProgressIcon({
  status,
}: {
  status: "pending" | "in_progress" | "completed";
}) {
  return (
    <span className={`session-inspector-progress-icon status-${status}`}>
      {status === "completed" ? "✓" : ""}
    </span>
  );
}

function renderOwnerLabel(
  status: SessionStatus,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (status.owner === "self") return t("sessionContextStatusRunning");
  if (status.owner === "external") return "external";
  return t("sessionContextStatusIdle");
}

export function SessionContextPanel({
  basePath,
  currentSession,
  messages,
  status,
  processState,
  actualSessionId,
  projectName,
  onCollapse,
}: SessionContextPanelProps) {
  const { t } = useI18n();
  const [diffFile, setDiffFile] = useState<GitFileChange | null>(null);
  const { sessions, loading: relationLoading } = useGlobalSessions({
    projectId: currentSession.projectId,
    limit: 500,
    includeArchived: true,
    includeSubagents: true,
  });
  const {
    gitStatus,
    loading: gitLoading,
    error: gitError,
  } = useGitStatus(currentSession.projectId);

  const currentPanelSession = toCurrentPanelSession(
    currentSession,
    projectName,
  );
  const panelSessions: ContextPanelSession[] = sessions.map((session) => ({
    ...session,
    ownership: session.ownership,
  }));
  const context = buildSessionRelationContext(
    currentPanelSession,
    panelSessions,
  );
  const parentSession = context.parentSession;
  const parentTitle = parentSession
    ? getSessionDisplayTitle(parentSession)
    : context.parentSessionId
      ? formatShortSessionId(context.parentSessionId)
      : undefined;
  const progressItems = useMemo(
    () => extractInspectorProgress(messages),
    [messages],
  );
  const generatedResults = useMemo(
    () => extractGeneratedResults(messages),
    [messages],
  );
  const changedFiles = gitStatus?.files ?? [];
  const totalLinesAdded = changedFiles.reduce(
    (sum, file) => sum + (file.linesAdded ?? 0),
    0,
  );
  const totalLinesDeleted = changedFiles.reduce(
    (sum, file) => sum + (file.linesDeleted ?? 0),
    0,
  );

  return (
    <aside
      className="session-context-panel"
      aria-label={t("sessionInspectorTitle")}
    >
      <div className="session-context-panel-inner">
        <div className="session-context-header">
          <h2>{t("sessionInspectorTitle")}</h2>
          {onCollapse && (
            <button
              type="button"
              className="session-context-toggle"
              onClick={onCollapse}
              title={t("sessionInspectorCollapse")}
              aria-label={t("sessionInspectorCollapse")}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <line x1="15" y1="4" x2="15" y2="20" />
              </svg>
            </button>
          )}
        </div>

        <section className="session-context-relationship">
          <span className="session-context-relationship-kicker">
            {context.parentSessionId
              ? t("sessionContextRoleSubagent")
              : t("sessionContextRoleMain")}
          </span>
          <strong>
            {context.parentSessionId
              ? t("sessionContextSpawnedFrom", {
                  title:
                    parentTitle ??
                    formatShortSessionId(context.parentSessionId),
                })
              : t("sessionContextRunsSubagents", {
                  count: context.childSessions.length,
                })}
          </strong>
          <span title={context.rootSessionId}>
            {t("sessionContextRoot", {
              id: formatShortSessionId(context.rootSessionId),
            })}
          </span>
        </section>

        <InspectorSection title={t("sessionInspectorProgress")}>
          {progressItems.length === 0 ? (
            <p className="session-context-empty">
              {t("sessionInspectorNoProgress")}
            </p>
          ) : (
            <div className="session-inspector-progress-list">
              {progressItems.map((item, index) => (
                <div
                  key={`${item.label}-${index}`}
                  className={`session-inspector-progress-item status-${item.status}`}
                >
                  <ProgressIcon status={item.status} />
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          )}
        </InspectorSection>

        <InspectorSection title={t("sessionInspectorBranchDetails")}>
          {gitLoading ? (
            <p className="session-context-empty">{t("gitStatusLoading")}</p>
          ) : gitError || !gitStatus?.isGitRepo ? (
            <p className="session-context-empty">
              {t("sessionInspectorGitUnavailable")}
            </p>
          ) : (
            <div className="session-inspector-git">
              <div className="session-inspector-row">
                <span>{t("sessionInspectorBranch")}</span>
                <strong>{gitStatus.branch || "HEAD"}</strong>
              </div>
              <div className="session-inspector-row">
                <span>{t("sessionInspectorChanges")}</span>
                {changedFiles.length === 0 ? (
                  <strong>{t("sessionInspectorWorkingTreeClean")}</strong>
                ) : (
                  <strong className="session-inspector-delta">
                    <span className="git-lines-added">
                      +{formatLineDelta(totalLinesAdded)}
                    </span>
                    <span className="git-lines-deleted">
                      -{formatLineDelta(totalLinesDeleted)}
                    </span>
                  </strong>
                )}
              </div>
              {changedFiles.length > 0 && (
                <div className="session-inspector-file-list">
                  {changedFiles.slice(0, 8).map((file) => (
                    <button
                      key={`${file.path}-${file.status}-${file.staged}`}
                      type="button"
                      className="session-inspector-file"
                      onClick={() => setDiffFile(file)}
                      title={t("sessionInspectorViewDiff")}
                    >
                      <span className="session-inspector-file-status">
                        {file.status}
                      </span>
                      <span className="session-inspector-file-name">
                        {getFileName(file.path)}
                      </span>
                      <span className="session-inspector-file-counts">
                        {file.linesAdded !== null && (
                          <span className="git-lines-added">
                            +{file.linesAdded}
                          </span>
                        )}
                        {file.linesDeleted !== null && (
                          <span className="git-lines-deleted">
                            -{file.linesDeleted}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </InspectorSection>

        <InspectorSection title={t("sessionInspectorGeneratedResults")}>
          {generatedResults.length === 0 ? (
            <p className="session-context-empty">
              {t("sessionInspectorNoGeneratedResults")}
            </p>
          ) : (
            <div className="session-inspector-result-list">
              {generatedResults.map((result) => (
                <a
                  key={result.href}
                  className="session-inspector-result"
                  href={result.href}
                  target="_blank"
                  rel="noreferrer"
                  title={t("sessionInspectorOpenResult")}
                >
                  <span className="session-inspector-result-icon">◎</span>
                  <span>{result.label}</span>
                </a>
              ))}
            </div>
          )}
        </InspectorSection>

        <InspectorSection title={t("sessionInspectorBackgroundTerminal")}>
          <div className="session-inspector-terminal-list">
            <div className="session-inspector-terminal-row">
              <span>{t("sessionInspectorProcessOwner")}</span>
              <strong>{renderOwnerLabel(status, t)}</strong>
            </div>
            <div className="session-inspector-terminal-row">
              <span>{t("sessionInspectorProcessState")}</span>
              <strong>{processState}</strong>
            </div>
            {status.owner === "self" ? (
              <div className="session-inspector-terminal-row">
                <span>{t("sessionInspectorProcessId")}</span>
                <strong title={status.processId}>{status.processId}</strong>
              </div>
            ) : (
              <p className="session-context-empty">
                {t("sessionInspectorNoBackgroundProcess")}
              </p>
            )}
            <div className="session-inspector-terminal-row">
              <span>session</span>
              <strong title={actualSessionId}>
                {formatShortSessionId(actualSessionId)}
              </strong>
            </div>
          </div>
        </InspectorSection>

        {context.parentSessionId && (
          <InspectorSection title={t("sessionContextParent")}>
            {parentSession ? (
              <SessionContextItem
                session={parentSession}
                currentSessionId={currentSession.id}
                basePath={basePath}
              />
            ) : (
              <Link
                to={`${basePath}/projects/${currentSession.projectId}/sessions/${context.parentSessionId}`}
                className="session-context-parent-fallback"
                title={context.parentSessionId}
              >
                {formatShortSessionId(context.parentSessionId)}
              </Link>
            )}
          </InspectorSection>
        )}

        <InspectorSection title={t("sessionContextSubagents")}>
          {relationLoading && context.childSessions.length === 0 ? (
            <p className="session-context-empty">
              {t("sessionContextLoading")}
            </p>
          ) : context.childSessions.length === 0 ? (
            <p className="session-context-empty">
              {t("sessionContextNoSubagents")}
            </p>
          ) : (
            <div className="session-context-list">
              {context.childSessions.map((childSession) => (
                <SessionContextItem
                  key={childSession.id}
                  session={childSession}
                  currentSessionId={currentSession.id}
                  basePath={basePath}
                  meta={getSubagentMeta(childSession, t)}
                  suppressUnreadStatus
                />
              ))}
            </div>
          )}
        </InspectorSection>
      </div>

      {diffFile && (
        <InspectorGitDiffModal
          file={diffFile}
          projectId={currentSession.projectId}
          t={t}
          onClose={() => setDiffFile(null)}
        />
      )}
    </aside>
  );
}

function InspectorGitDiffModal({
  file,
  projectId,
  t,
  onClose,
}: {
  file: GitFileChange;
  projectId: string;
  t: ReturnType<typeof useI18n>["t"];
  onClose: () => void;
}) {
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getGitDiff(projectId, {
        path: file.path,
        staged: file.staged,
        status: file.status,
      })
      .then((result) => {
        if (!cancelled) {
          setDiffResult(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : t("gitStatusLoadDiffFailed"),
          );
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, file.path, file.staged, file.status, t]);

  return (
    <Modal title={getFileName(file.path)} onClose={onClose}>
      {loading ? (
        <div className="git-diff-loading">{t("gitStatusLoadingDiff")}</div>
      ) : error ? (
        <div className="git-diff-error">{error}</div>
      ) : diffResult ? (
        <InspectorGitDiffModalContent
          file={file}
          projectId={projectId}
          diffResult={diffResult}
          t={t}
        />
      ) : null}
    </Modal>
  );
}

function InspectorGitDiffModalContent({
  file,
  projectId,
  diffResult,
  t,
}: {
  file: GitFileChange;
  projectId: string;
  diffResult: GitDiffResult;
  t: ReturnType<typeof useI18n>["t"];
}) {
  const [showFullContext, setShowFullContext] = useState(false);
  const [fullContextResult, setFullContextResult] =
    useState<GitDiffResult | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleToggleContext = useCallback(async () => {
    if (!showFullContext && !fullContextResult) {
      setContextLoading(true);
      setContextError(null);
      try {
        const result = await api.getGitDiff(projectId, {
          path: file.path,
          staged: file.staged,
          status: file.status,
          fullContext: true,
        });
        setFullContextResult(result);
      } catch (err) {
        setContextError(
          err instanceof Error ? err.message : t("gitStatusLoadContextFailed"),
        );
        setContextLoading(false);
        return;
      }
      setContextLoading(false);
    }
    setShowFullContext(!showFullContext);
  }, [
    showFullContext,
    fullContextResult,
    projectId,
    file.path,
    file.staged,
    file.status,
    t,
  ]);

  useEffect(() => {
    if (showFullContext && fullContextResult && contentRef.current) {
      requestAnimationFrame(() => {
        const firstChange = contentRef.current?.querySelector(
          ".line-deleted, .line-inserted",
        );
        if (firstChange) {
          firstChange.scrollIntoView({ block: "center", behavior: "instant" });
        }
      });
    }
  }, [showFullContext, fullContextResult]);

  const displayResult =
    showFullContext && fullContextResult ? fullContextResult : diffResult;

  return (
    <div className="diff-modal-content" ref={contentRef}>
      <div className="diff-context-controls">
        <span className="diff-context-path">{file.path}</span>
        <button
          type="button"
          className="diff-context-toggle"
          onClick={handleToggleContext}
          disabled={contextLoading}
        >
          {contextLoading
            ? t("gitStatusLoading")
            : showFullContext
              ? t("gitStatusDiffOnly")
              : t("gitStatusFullContext")}
        </button>
        {contextError && (
          <span className="diff-context-error">{contextError}</span>
        )}
      </div>

      {displayResult.diffHtml ? (
        <HighlightedDiff diffHtml={displayResult.diffHtml} />
      ) : (
        <DiffLines
          lines={displayResult.structuredPatch.flatMap((h) => h.lines)}
        />
      )}
    </div>
  );
}

const HighlightedDiff = memo(function HighlightedDiff({
  diffHtml,
}: {
  diffHtml: string;
}) {
  return (
    <div
      className="highlighted-diff"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered shiki output
      dangerouslySetInnerHTML={{ __html: diffHtml }}
    />
  );
});

const DiffLines = memo(function DiffLines({ lines }: { lines: string[] }) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {lines.map((line, index) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          return (
            <div key={`${index}-${line.slice(0, 50)}`} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});
