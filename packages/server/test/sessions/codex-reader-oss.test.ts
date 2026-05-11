import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { UrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeProjectId } from "../../src/projects/paths.js";
import { CodexSessionReader } from "../../src/sessions/codex-reader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("CodexSessionReader - OSS Support", () => {
  let testDir: string;
  let reader: CodexSessionReader;

  beforeEach(async () => {
    testDir = join(tmpdir(), `codex-reader-oss-test-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
    reader = new CodexSessionReader({ sessionsDir: testDir });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  const createSessionFile = async (
    sessionId: string,
    provider: string | undefined,
    model: string | undefined,
    originator?: string,
    tokenUsage?: {
      totalInputTokens: number;
      totalCachedInputTokens?: number;
      lastInputTokens?: number;
      lastCachedInputTokens?: number;
      modelContextWindow?: number;
    },
  ) => {
    const metaPayload = {
      id: sessionId,
      cwd: "/test/project",
      timestamp: new Date().toISOString(),
      ...(provider ? { model_provider: provider } : {}),
      ...(originator ? { originator } : {}),
    };

    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: new Date().toISOString(),
        payload: metaPayload,
      }),
    ];

    if (model) {
      lines.push(
        JSON.stringify({
          type: "turn_context",
          timestamp: new Date().toISOString(),
          payload: { model },
        }),
      );
    }

    // Add a user message so it's a valid session with messages
    lines.push(
      JSON.stringify({
        type: "event_msg",
        timestamp: new Date().toISOString(),
        payload: {
          type: "user_message",
          message: "Hello world",
        },
      }),
    );

    if (tokenUsage) {
      lines.push(
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: tokenUsage.totalInputTokens,
                cached_input_tokens: tokenUsage.totalCachedInputTokens ?? 0,
                output_tokens: 10,
                total_tokens: tokenUsage.totalInputTokens + 10,
              },
              ...(tokenUsage.lastInputTokens !== undefined && {
                last_token_usage: {
                  input_tokens: tokenUsage.lastInputTokens,
                  cached_input_tokens: tokenUsage.lastCachedInputTokens ?? 0,
                  output_tokens: 5,
                  total_tokens: tokenUsage.lastInputTokens + 5,
                },
              }),
              model_context_window: tokenUsage.modelContextWindow ?? 258400,
            },
          },
        }),
      );
    }

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );
  };

  it("identifies session as codex-oss when model_provider is ollama", async () => {
    const sessionId = "oss-session-1";
    await createSessionFile(sessionId, "ollama", "mistral");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");

    const session = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(session?.data.provider).toBe("codex-oss");
  });

  it("identifies session as codex-oss when model_provider is local", async () => {
    const sessionId = "oss-session-2";
    await createSessionFile(sessionId, "local", "deepseek-coder");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");
  });

  it("identifies session as codex when model_provider is openai", async () => {
    const sessionId = "openai-session-1";
    await createSessionFile(sessionId, "openai", "gpt-4o");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
  });

  it("falls back to codex-oss based on model name (llama)", async () => {
    const sessionId = "heuristic-session-1";
    await createSessionFile(sessionId, undefined, "llama-3-8b");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");
  });

  it("falls back to codex-oss based on model name (qwen)", async () => {
    const sessionId = "heuristic-session-2";
    await createSessionFile(sessionId, undefined, "qwen2.5-coder");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex-oss");
  });

  it("defaults to codex when no provider and unknown model", async () => {
    const sessionId = "unknown-session";
    await createSessionFile(sessionId, undefined, "unknown-model");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
  });

  it("marks an unfinished Codex turn as external in-turn", async () => {
    const sessionId = "active-turn-session";
    await createSessionFile(sessionId, "openai", "gpt-5.1-codex");
    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: new Date().toISOString(),
          payload: {
            id: sessionId,
            cwd: "/test/project",
            timestamp: new Date().toISOString(),
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: {
            type: "user_message",
            message: "Run the long task",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: {
            type: "task_started",
            turn_id: "turn-active",
            model_context_window: 258400,
            collaboration_mode_kind: "default",
          },
        }),
      ].join("\n")}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.ownership).toEqual({ owner: "external" });
    expect(summary?.activity).toBe("in-turn");
  });

  it("filters mixed-slash Windows cwd variants as the same project", async () => {
    const sessionId = "windows-mixed-slash";
    await createSessionFile(
      sessionId,
      "openai",
      "gpt-4o",
      undefined,
      undefined,
    );

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${[
        JSON.stringify({
          type: "session_meta",
          timestamp: new Date().toISOString(),
          payload: {
            id: sessionId,
            cwd: "C:\\Users\\kyle\\Documents\\webvam",
            timestamp: new Date().toISOString(),
            model_provider: "openai",
          },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: new Date().toISOString(),
          payload: {
            type: "user_message",
            message: "Hello world",
          },
        }),
      ].join("\n")}\n`,
    );

    const filteredReader = new CodexSessionReader({
      sessionsDir: testDir,
      projectPath: "c:/Users/kyle/Documents/webvam",
    });

    const summaries = await filteredReader.listSessions(
      encodeProjectId("C:/Users/kyle/Documents/webvam"),
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].id).toBe(sessionId);
  });

  it("identifies codex based on model name (gpt-4)", async () => {
    const sessionId = "heuristic-openai";
    await createSessionFile(sessionId, undefined, "gpt-4-turbo");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.provider).toBe("codex");
  });

  it("uses last_token_usage input_tokens for context usage", async () => {
    const sessionId = "context-last-usage";
    await createSessionFile(sessionId, "openai", "gpt-5.3-codex", undefined, {
      totalInputTokens: 236_673,
      totalCachedInputTokens: 116_000,
      lastInputTokens: 120_000,
      lastCachedInputTokens: 118_000,
      modelContextWindow: 258_000,
    });

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.contextUsage?.inputTokens).toBe(120_000);
    expect(summary?.contextUsage?.percentage).toBe(47);
    expect(summary?.contextUsage?.contextWindow).toBe(258_000);
  });

  it("falls back to total_token_usage input_tokens when last_token_usage is absent", async () => {
    const sessionId = "context-total-fallback";
    await createSessionFile(sessionId, "openai", "gpt-5.3-codex", undefined, {
      totalInputTokens: 85_000,
      totalCachedInputTokens: 40_000,
      modelContextWindow: 258_000,
    });

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.contextUsage?.inputTokens).toBe(85_000);
    expect(summary?.contextUsage?.percentage).toBe(33);
  });

  it("excludes developer messages from messageCount", async () => {
    const sessionId = "developer-filter";
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "openai",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "internal instructions" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: now,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible response" }],
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.messageCount).toBe(1);
  });

  it("preserves originator from session metadata", async () => {
    const sessionId = "originator-passthrough";
    await createSessionFile(sessionId, "openai", "gpt-4o", "yep-anywhere");

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(summary?.originator).toBe("yep-anywhere");
  });

  it("uses Codex session_index thread_name as the session title", async () => {
    const sessionId = "indexed-title-session";
    const sessionIndexPath = join(testDir, "session_index.jsonl");
    reader = new CodexSessionReader({
      sessionsDir: testDir,
      sessionIndexPath,
    });
    await createSessionFile(sessionId, "openai", "gpt-5.3-codex");
    await writeFile(
      sessionIndexPath,
      `${JSON.stringify({
        id: sessionId,
        thread_name: "优化会话切换加载",
        updated_at: new Date().toISOString(),
      })}\n`,
    );

    const summary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );

    expect(summary?.title).toBe("优化会话切换加载");
    expect(summary?.fullTitle).toBe("优化会话切换加载");
  });

  it("refreshes cached summaries when Codex session_index changes", async () => {
    const sessionId = "indexed-title-refresh";
    const sessionIndexPath = join(testDir, "session_index.jsonl");
    reader = new CodexSessionReader({
      sessionsDir: testDir,
      sessionIndexPath,
    });
    await createSessionFile(sessionId, "openai", "gpt-5.3-codex");
    await writeFile(
      sessionIndexPath,
      `${JSON.stringify({
        id: sessionId,
        thread_name: "Old title",
        updated_at: new Date().toISOString(),
      })}\n`,
    );

    const firstSummary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(firstSummary?.title).toBe("Old title");

    await writeFile(
      sessionIndexPath,
      `${JSON.stringify({
        id: sessionId,
        thread_name: "Updated Codex generated title",
        updated_at: new Date().toISOString(),
      })}\n`,
    );

    const secondSummary = await reader.getSessionSummary(
      sessionId,
      "test-project" as UrlProjectId,
    );
    expect(secondSummary?.title).toBe("Updated Codex generated title");
  });

  it("returns only the compacted tail for tailCompactions detail loads", async () => {
    const sessionId = "tail-compactions-detail";
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({
        type: "session_meta",
        timestamp: now,
        payload: {
          id: sessionId,
          cwd: "/test/project",
          timestamp: now,
          model_provider: "ollama",
        },
      }),
      JSON.stringify({
        type: "turn_context",
        timestamp: now,
        payload: {
          cwd: "/test/project",
          approval_policy: "never",
          model: "qwen3-coder",
        },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "old user message",
        },
      }),
      JSON.stringify({
        type: "compacted",
        timestamp: now,
        payload: { message: "first compaction" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "middle user message",
        },
      }),
      JSON.stringify({
        type: "compacted",
        timestamp: now,
        payload: { message: "second compaction" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: now,
        payload: {
          type: "user_message",
          message: "tail user message",
        },
      }),
    ];

    await writeFile(
      join(testDir, `${sessionId}.jsonl`),
      `${lines.join("\n")}\n`,
    );

    const loaded = await reader.getSession(
      sessionId,
      "test-project" as UrlProjectId,
      undefined,
      { tailCompactions: 1 } as never,
    );

    expect(loaded?.data.provider).toBe("codex-oss");
    expect(loaded?.data.session.entries.map((entry) => entry.type)).toEqual([
      "compacted",
      "event_msg",
    ]);
    expect(loaded?.pagination).toMatchObject({
      hasOlderMessages: true,
      totalMessageCount: 3,
      returnedMessageCount: 1,
      totalCompactions: 2,
    });
  });
});
