import { useState } from "react";
import "./InteractiveSelect.css";

export interface InteractiveSelectOption {
  label: string;
  value: string;
  description?: string;
}

interface InteractiveSelectProps {
  prompt: string;
  options: InteractiveSelectOption[];
  multiple?: boolean;
  onSubmit: (selected: string | string[]) => void;
  onDismiss: () => void;
}

export function InteractiveSelect({
  prompt,
  options,
  multiple,
  onSubmit,
  onDismiss,
}: InteractiveSelectProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [customInput, setCustomInput] = useState("");

  const toggle = (value: string) => {
    if (multiple) {
      setSelected((prev) =>
        prev.includes(value)
          ? prev.filter((v) => v !== value)
          : [...prev, value],
      );
    } else {
      setSelected([value]);
    }
  };

  const handleSubmit = () => {
    if (selected.length > 0) {
      onSubmit(multiple ? selected : selected[0]);
    }
  };

  const handleCustom = () => {
    if (customInput.trim()) {
      onSubmit(customInput.trim());
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onDismiss();
    }
  };

  return (
    <div className="is-overlay" onKeyDown={handleKeyDown}>
      <div className="is-panel">
        <div className="is-prompt">{prompt}</div>
        <div className="is-options">
          {options.map((opt) => {
            const active = selected.includes(opt.value);
            return (
              <button
                key={opt.value}
                className={`is-option${active ? " is-active" : ""}`}
                onClick={() => toggle(opt.value)}
                onDoubleClick={() => {
                  toggle(opt.value);
                  if (!multiple) handleSubmit();
                }}
              >
                <span className="is-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="is-option-desc">{opt.description}</span>
                )}
                {active && <span className="is-check">&#10003;</span>}
              </button>
            );
          })}
        </div>

        <div className="is-custom-row">
          <input
            className="is-custom-input"
            type="text"
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            placeholder="Or type your answer..."
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCustom();
            }}
          />
          <button
            className="is-custom-btn"
            onClick={handleCustom}
            disabled={!customInput.trim()}
          >
            Send
          </button>
        </div>

        <div className="is-actions">
          {multiple && (
            <button
              className="btn-primary"
              onClick={handleSubmit}
              disabled={selected.length === 0}
            >
              Confirm ({selected.length})
            </button>
          )}
          <button className="btn-secondary" onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
