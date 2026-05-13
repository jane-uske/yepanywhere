const CUSTOM_CODEX_SLASH_COMMANDS = [
  "model",
  "think",
  "fast",
  "status",
  "stop",
  "new",
  "help",
] as const;

export function mergeCodexSlashCommands(commands: string[]): string[] {
  return [
    ...CUSTOM_CODEX_SLASH_COMMANDS,
    ...commands.filter(
      (command) =>
        !CUSTOM_CODEX_SLASH_COMMANDS.includes(
          command as (typeof CUSTOM_CODEX_SLASH_COMMANDS)[number],
        ),
    ),
  ];
}

export function getCodexSlashCommandsForSession(
  provider: string | undefined,
  owner: string,
  commands: string[],
): string[] {
  if (provider !== "codex" || owner === "external") {
    return commands;
  }

  return mergeCodexSlashCommands(commands);
}
