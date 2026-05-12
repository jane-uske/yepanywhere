import { describe, expect, it } from "vitest";
import {
  getCodexSlashCommandsForSession,
  mergeCodexSlashCommands,
} from "../codexSlashCommands";

describe("mergeCodexSlashCommands", () => {
  it("adds the practical client-side Codex commands without duplicating SDK commands", () => {
    expect(mergeCodexSlashCommands(["model", "custom"])).toEqual([
      "model",
      "think",
      "fast",
      "status",
      "stop",
      "new",
      "help",
      "custom",
    ]);
  });

  it("shows client-side Codex commands for idle sessions", () => {
    expect(getCodexSlashCommandsForSession("codex", "none", [])).toEqual([
      "model",
      "think",
      "fast",
      "status",
      "stop",
      "new",
      "help",
    ]);
  });

  it("does not inject Codex commands into external sessions", () => {
    expect(getCodexSlashCommandsForSession("codex", "external", [])).toEqual(
      [],
    );
  });
});
