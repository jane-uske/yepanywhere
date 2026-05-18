import {
  type KimiPageAgentContext,
  getKimiContextSummary,
} from "../lib/kimiPageAgentBridge";

interface Props {
  context: KimiPageAgentContext | null;
  onSelectElement: () => void;
  onRefreshContext: () => void;
  onInsertPrompt: () => void;
  onSendPrompt: () => void;
  disabled?: boolean;
  sendLabel?: string;
}

export function KimiPageAgentPanel({
  context,
  onSelectElement,
  onRefreshContext,
  onInsertPrompt,
  onSendPrompt,
  disabled,
  sendLabel = "Send to agent",
}: Props) {
  const summary = getKimiContextSummary(context);
  const hasContext = Boolean(context);
  const hasSelection = Boolean(context?.selection);

  return (
    <div className="kimi-page-agent-panel">
      <div className="kimi-page-agent-header">
        <div>
          <div className="kimi-page-agent-title">Aidc-pageAgent</div>
          <div className="kimi-page-agent-subtitle">
            {hasContext
              ? `${summary.appLabel}${summary.appVersion ? ` @ ${summary.appVersion}` : ""}`
              : "Waiting for page context from the browser extension"}
          </div>
        </div>
        <div className="kimi-page-agent-status">
          {hasSelection ? "Element selected" : "No selection"}
        </div>
      </div>

      {hasContext && (
        <div className="kimi-page-agent-meta">
          <span>{summary.pageLabel || "Unknown page"}</span>
          <span>{summary.elementLabel}</span>
          {summary.rectLabel && <span>{summary.rectLabel}</span>}
        </div>
      )}

      <div className="kimi-page-agent-actions">
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
