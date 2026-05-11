/**
 * Unified thinking/running indicator component.
 * Use this for all "thinking", "running", or "processing" state indicators.
 *
 * Variants:
 * - "dot": Compact loading spinner only
 * - "pill": Pill badge with loading spinner and text label
 *
 * Examples:
 *   <ThinkingIndicator />                    // Just a loading spinner
 *   <ThinkingIndicator variant="pill" />     // Pill with "Thinking" text
 *   <ThinkingIndicator variant="pill" label="Running" />
 */

interface ThinkingIndicatorProps {
  /** Visual variant - "dot" for compact, "pill" for badge with text */
  variant?: "dot" | "pill";
  /** Text label for pill variant (default: "Thinking") */
  label?: string;
  /** Optional className for additional styling */
  className?: string;
}

export function ThinkingIndicator({
  variant = "dot",
  label = "Thinking",
  className,
}: ThinkingIndicatorProps) {
  const spinner = <span className="thinking-indicator-spinner" />;

  if (variant === "pill") {
    return (
      <span className={`thinking-indicator-pill ${className ?? ""}`}>
        {spinner}
        <span className="thinking-indicator-label">{label}</span>
      </span>
    );
  }

  return (
    <span className={`thinking-indicator ${className ?? ""}`}>{spinner}</span>
  );
}
