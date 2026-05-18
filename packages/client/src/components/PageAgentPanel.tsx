import {
  type PageAgentContext,
  getPageAgentContextSummary,
} from "../lib/pageAgentBridge";

interface Props {
  context: PageAgentContext | null;
  onSelectElement: () => void;
  onRefreshContext: () => void;
  onInsertPrompt: () => void;
  onSendPrompt: () => void;
  disabled?: boolean;
  sendLabel?: string;
}

export function PageAgentPanel({
  context,
  onSelectElement,
  onRefreshContext,
  onInsertPrompt,
  onSendPrompt,
  disabled,
  sendLabel = "Send to agent",
}: Props) {
  const summary = getPageAgentContextSummary(context);
  const hasContext = Boolean(context);
  const hasSelection = Boolean(context?.selection);

  return (
    <div className="page-agent-panel">
      <div className="page-agent-header">
        <div>
          <div className="page-agent-title">Page Agent</div>
          <div className="page-agent-subtitle">
            {hasContext
              ? `${summary.appLabel}${summary.appVersion ? ` @ ${summary.appVersion}` : ""}`
              : "Waiting for page context from the browser extension"}
          </div>
        </div>
        <div className="page-agent-status">
          {hasSelection ? "Element selected" : "No selection"}
        </div>
      </div>

      {hasContext && (
        <div className="page-agent-meta">
          <span>{summary.pageLabel || "Unknown page"}</span>
          <span>{summary.elementLabel}</span>
          {summary.rectLabel && <span>{summary.rectLabel}</span>}
        </div>
      )}

      <div className="page-agent-actions">
        <button type="button" onClick={onSelectElement}>
          Select element
        </button>
        <button type="button" onClick={onRefreshContext}>
          Refresh context
        </button>
        <button type="button" onClick={onInsertPrompt} disabled={!hasContext}>
          Insert prompt
        </button>
        <button
          type="button"
          className="primary"
          onClick={onSendPrompt}
          disabled={!hasContext || disabled}
        >
          {sendLabel}
        </button>
      </div>
    </div>
  );
}
