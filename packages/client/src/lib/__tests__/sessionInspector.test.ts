import { describe, expect, it } from "vitest";
import type { Message } from "../../types";
import {
  extractGeneratedResults,
  extractInspectorProgress,
} from "../sessionInspector";

describe("sessionInspector", () => {
  it("uses the latest update_plan tool input and normalizes statuses", () => {
    const messages: Message[] = [
      {
        id: "old",
        content: [
          {
            type: "tool_use",
            id: "plan-1",
            name: "update_plan",
            input: {
              plan: [{ step: "Old step", status: "pending" }],
            },
          },
        ],
      },
      {
        id: "new",
        content: [
          {
            type: "tool_use",
            id: "plan-2",
            name: "UpdatePlan",
            input: {
              plan: [
                { step: "Write helper", status: "done" },
                { step: "Wire UI", status: "active" },
                { step: "Run checks", status: "blocked" },
              ],
            },
          },
        ],
      },
    ];

    expect(extractInspectorProgress(messages)).toEqual([
      { label: "Write helper", status: "completed" },
      { label: "Wire UI", status: "in_progress" },
      { label: "Run checks", status: "pending" },
    ]);
  });

  it("falls back to the latest TodoWrite input when update_plan is absent", () => {
    const messages: Message[] = [
      {
        id: "todo",
        toolUse: {
          id: "todo-1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "Inspect sidebar", status: "completed" },
              { content: "Add inspector", status: "in_progress" },
            ],
          },
        },
      },
    ];

    expect(extractInspectorProgress(messages)).toEqual([
      { label: "Inspect sidebar", status: "completed" },
      { label: "Add inspector", status: "in_progress" },
    ]);
  });

  it("extracts and deduplicates generated local URLs", () => {
    const messages: Message[] = [
      {
        id: "one",
        content:
          "Started http://127.0.0.1:4100 and http://localhost:4200 for QA.",
      },
      {
        id: "two",
        message: {
          content: [
            {
              type: "text",
              text: 'Open "http://127.0.0.1:4100\\" again.',
            },
          ],
        },
      },
    ];

    expect(extractGeneratedResults(messages)).toEqual([
      {
        kind: "url",
        label: "127.0.0.1:4100",
        href: "http://127.0.0.1:4100",
      },
      {
        kind: "url",
        label: "localhost:4200",
        href: "http://localhost:4200",
      },
    ]);
  });

  it("ignores URLs from tool result blocks", () => {
    const messages: Message[] = [
      {
        id: "tool-result",
        content: [
          {
            type: "tool_result",
            tool_use_id: "shell-1",
            content: "Browser snapshot showed http://127.0.0.1:4100/projects",
          },
          {
            type: "text",
            text: "Preview available at http://localhost:4200.",
          },
        ],
      },
    ];

    expect(extractGeneratedResults(messages)).toEqual([
      {
        kind: "url",
        label: "localhost:4200",
        href: "http://localhost:4200",
      },
    ]);
  });

  it("ignores URLs from user messages", () => {
    const messages: Message[] = [
      {
        id: "user",
        type: "user",
        message: {
          content: [
            {
              type: "text",
              text: "Please check http://127.0.0.1:4100/projects",
            },
          ],
        },
      },
      {
        id: "assistant",
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Preview is at http://localhost:4200.",
            },
          ],
        },
      },
    ];

    expect(extractGeneratedResults(messages)).toEqual([
      {
        kind: "url",
        label: "localhost:4200",
        href: "http://localhost:4200",
      },
    ]);
  });
});
