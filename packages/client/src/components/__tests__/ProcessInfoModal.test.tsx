import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ProcessInfoModal } from "../ProcessInfoModal";

vi.mock("../../hooks/useActivityBusState", () => ({
  useActivityBusState: () => ({
    connected: true,
    connectionState: "connected",
  }),
}));

describe("ProcessInfoModal", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders Codex subagent source metadata without crashing and shows the parent thread", () => {
    render(
      <I18nProvider>
        <ProcessInfoModal
          sessionId="child-thread"
          provider="codex"
          status={{ owner: "none" }}
          processState="idle"
          sessionSource={{
            subagent: {
              thread_spawn: {
                parent_thread_id: "parent-thread",
                depth: 1,
              },
            },
          }}
          sessionStreamConnected={false}
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Subagent")).toBeDefined();
    expect(screen.getByText("parent-thread")).toBeDefined();
  });
});
