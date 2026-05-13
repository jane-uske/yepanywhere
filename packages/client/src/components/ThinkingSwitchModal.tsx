import type { ThinkingOption } from "@yep-anywhere/shared";
import { Modal } from "./ui/Modal";

interface ThinkingSwitchModalProps {
  currentThinking: ThinkingOption;
  onThinkingChanged: (thinking: ThinkingOption) => void;
  onClose: () => void;
}

const THINKING_OPTIONS: Array<{
  id: ThinkingOption;
  name: string;
  description: string;
}> = [
  {
    id: "auto",
    name: "Auto",
    description: "Use the model default reasoning behavior.",
  },
  {
    id: "on:low",
    name: "Low",
    description: "Lighter reasoning for simple work.",
  },
  {
    id: "on:medium",
    name: "Medium",
    description: "Balanced reasoning for everyday work.",
  },
  {
    id: "on:high",
    name: "High",
    description: "Deeper reasoning for complex tasks.",
  },
  {
    id: "on:max",
    name: "XHigh",
    description: "Maximum reasoning effort where supported.",
  },
];

function normalizeThinking(option: ThinkingOption): ThinkingOption {
  if (option === "low" || option === "medium" || option === "high") {
    return `on:${option}`;
  }
  if (option === "max") {
    return "on:max";
  }
  return option;
}

export function ThinkingSwitchModal({
  currentThinking,
  onThinkingChanged,
  onClose,
}: ThinkingSwitchModalProps) {
  const normalizedCurrent = normalizeThinking(currentThinking);

  const handleSelect = (thinking: ThinkingOption) => {
    onThinkingChanged(thinking);
    onClose();
  };

  return (
    <Modal title="Thinking" onClose={onClose}>
      <div className="model-switch-content">
        <div className="model-switch-list">
          {THINKING_OPTIONS.map((option) => {
            const isCurrent = normalizedCurrent === option.id;
            return (
              <button
                key={option.id}
                type="button"
                className={`model-switch-item ${isCurrent ? "current" : ""}`}
                onClick={() => handleSelect(option.id)}
              >
                <span className="model-switch-name">{option.name}</span>
                <span className="model-switch-description">
                  {option.description}
                </span>
                {isCurrent && (
                  <span className="model-switch-badge">Current</span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}
