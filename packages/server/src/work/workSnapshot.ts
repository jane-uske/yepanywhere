import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  type RemiWorkSnapshotResponse,
  type UrlProjectId,
  type WorkChangedFile,
  type WorkConfidence,
  type WorkProjectSummary,
  type WorkSignal,
  type WorkSignalState,
  type WorkType,
  type WorkVerification,
  getSessionDisplayTitle,
} from "@yep-anywhere/shared";
import type { SessionIndexService } from "../indexes/index.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { buildProviderProjectCatalog } from "../routes/provider-catalog.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { listSessionsAcrossProviders } from "../sessions/provider-resolution.js";
import type { ISessionReader } from "../sessions/types.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  PendingInputType,
  Project,
  SessionSummary,
} from "../supervisor/types.js";

const execFileAsync = promisify(execFile);
const CLAIM_MAX_LENGTH = 240;
const MAX_CHANGED_FILES_PER_SIGNAL = 20;

export interface WorkSnapshotProvider {
  getSnapshot(options: WorkSnapshotOptions): Promise<RemiWorkSnapshotResponse>;
}

export interface WorkSnapshotOptions {
  since: Date;
  until: Date;
  limit: number;
}

export interface WorkSnapshotDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
  codexScanner?: CodexSessionScanner;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  getChangedFiles?: (project: Project) => Promise<WorkChangedFile[]>;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface ClassifyWorkTypeInput {
  title?: string | null;
  agentClaim?: string;
  changedFiles?: Array<Pick<WorkChangedFile, "path" | "status" | "staged">>;
  verification?: WorkVerification[];
}

export interface DeriveStateInput {
  pendingInputType?: PendingInputType;
  processState?: string;
  terminationReason?: string;
  processError?: boolean;
  agentClaim?: string;
  changedFiles?: Array<Pick<WorkChangedFile, "path" | "status" | "staged">>;
  verification?: WorkVerification[];
}

export interface DeriveConfidenceInput {
  state: WorkSignalState;
  agentClaim?: string;
  changedFiles?: Array<Pick<WorkChangedFile, "path" | "status" | "staged">>;
  verification?: WorkVerification[];
}

export interface BuildWorkSignalInput {
  project: Project;
  session: SessionSummary;
  pendingInputType?: PendingInputType;
  processState?: string;
  terminationReason?: string;
  processError?: boolean;
  agentClaim?: string;
  changedFiles?: WorkChangedFile[];
  verification?: WorkVerification[];
  customTitle?: string;
}

export function classifyWorkType(input: ClassifyWorkTypeInput): WorkType {
  const title = input.title ?? "";
  const claim = input.agentClaim ?? "";
  const text = `${title}\n${claim}`.toLowerCase();
  const files = input.changedFiles ?? [];
  const verification = input.verification ?? [];

  if (/\b(test|spec|vitest|jest|playwright)\b/.test(text)) return "test";
  if (
    /\b(fix|bug|error|regression|failing|failure|crash|broken)\b/.test(text)
  ) {
    return "bugfix";
  }
  if (/\b(refactor|cleanup|clean up|split|extract|simplify)\b/.test(text)) {
    return "refactor";
  }
  if (/\b(add|implement|support|create|feature|新增|实现|接入)\b/.test(text)) {
    return "feature";
  }
  if (/\b(doc|docs|readme|markdown)\b/.test(text)) return "docs";
  if (
    files.length > 0 &&
    files.every((file) => /\.(md|markdown|mdx)$/i.test(file.path))
  ) {
    return "docs";
  }
  if (
    verification.length > 0 &&
    verification.every((item) => item.kind === "test")
  ) {
    return "test";
  }
  return "unknown";
}

export function deriveSignalState(input: DeriveStateInput): WorkSignalState {
  const verification = input.verification ?? [];
  if (input.pendingInputType) return "needs_attention";
  if (input.processState === "in-turn") return "running";
  if (input.processError || input.terminationReason) return "blocked";
  if (hasFailedVerification(verification)) return "blocked";
  if (isBlockedClaim(input.agentClaim)) return "blocked";
  if (input.agentClaim) {
    if (hasPassedVerification(verification)) return "verified_done";
    return "claimed_done";
  }
  return "stale";
}

export function deriveConfidence(input: DeriveConfidenceInput): WorkConfidence {
  const verification = input.verification ?? [];
  const changedFiles = input.changedFiles ?? [];
  if (input.state === "verified_done" && hasPassedVerification(verification)) {
    return "high";
  }
  if (input.state === "blocked" || hasFailedVerification(verification)) {
    return "low";
  }
  if (input.agentClaim && changedFiles.length > 0) return "medium";
  if (input.state === "running" || input.state === "needs_attention") {
    return "medium";
  }
  return "low";
}

export function buildWorkSignal(input: BuildWorkSignalInput): WorkSignal {
  const changedFiles = (input.changedFiles ?? []).slice(
    0,
    MAX_CHANGED_FILES_PER_SIGNAL,
  );
  const verification = input.verification ?? [];
  const title = getSessionDisplayTitle({
    customTitle: input.customTitle,
    title: input.session.title,
  });
  const agentClaim = input.agentClaim
    ? truncateSingleLine(input.agentClaim, CLAIM_MAX_LENGTH)
    : undefined;
  const state = deriveSignalState({
    pendingInputType: input.pendingInputType,
    processState: input.processState,
    terminationReason: input.terminationReason,
    processError: input.processError,
    agentClaim,
    changedFiles,
    verification,
  });
  const confidence = deriveConfidence({
    state,
    agentClaim,
    changedFiles,
    verification,
  });

  const evidenceRefs: WorkSignal["evidenceRefs"] = [
    {
      kind: "session",
      label: input.session.id,
      href: `/projects/${input.project.id}/sessions/${input.session.id}`,
    },
  ];
  if (changedFiles.length > 0) {
    evidenceRefs.push({ kind: "git", label: `${changedFiles.length} files` });
  }
  if (verification.length > 0) {
    evidenceRefs.push({
      kind: "tool",
      label: `${verification.length} verification signals`,
    });
  }
  if (input.processState) {
    evidenceRefs.push({ kind: "process", label: input.processState });
  }

  return {
    id: `${input.session.provider}:${input.project.id}:${input.session.id}`,
    provider: input.session.provider,
    projectId: input.project.id,
    projectName: input.project.name,
    sessionId: input.session.id,
    title,
    state,
    workType: classifyWorkType({
      title,
      agentClaim,
      changedFiles,
      verification,
    }),
    agentClaim,
    changedFiles: changedFiles.length > 0 ? changedFiles : undefined,
    verification: verification.length > 0 ? verification : undefined,
    confidence,
    updatedAt: input.session.updatedAt,
    nextStep: buildNextStep(state),
    evidenceRefs,
  };
}

export function buildNextStep(state: WorkSignalState): string | undefined {
  switch (state) {
    case "needs_attention":
      return "User input or approval is required.";
    case "blocked":
      return "Inspect the failed command, rejected approval, or blocker claim.";
    case "claimed_done":
      return "Verify with tests, typecheck, build, or commit evidence before treating as done.";
    case "running":
      return "Wait for the active turn to finish.";
    default:
      return undefined;
  }
}

export function createWorkSnapshotProvider(
  deps: WorkSnapshotDeps,
): WorkSnapshotProvider {
  const cacheTtlMs = Math.max(0, deps.cacheTtlMs ?? 15_000);
  const getNow = deps.now ?? Date.now;
  let cache: {
    key: string;
    expiresAt: number;
    snapshot: RemiWorkSnapshotResponse;
  } | null = null;

  return {
    async getSnapshot({ since, until, limit }) {
      const cacheKey = `${since.toISOString()}:${limit}`;
      const now = getNow();
      if (cache && cache.key === cacheKey && now < cache.expiresAt) {
        return cache.snapshot;
      }

      const projects = await deps.scanner.listProjects();
      const providerCatalog = await buildProviderProjectCatalog({
        projects,
        codexScanner: deps.codexScanner,
        geminiScanner: deps.geminiScanner,
      });

      const signals: WorkSignal[] = [];
      const changedProjects = new Map<string, WorkProjectSummary>();

      const projectResults = await Promise.all(
        projects.map(async (project) => {
          const [sessions, changedFiles] = await Promise.all([
            listSessionsAcrossProviders(
              project,
              {
                readerFactory: deps.readerFactory,
                sessionIndexService: deps.sessionIndexService,
                codexSessionsDir: deps.codexSessionsDir,
                codexReaderFactory: deps.codexReaderFactory,
                geminiSessionsDir: deps.geminiSessionsDir,
                geminiReaderFactory: deps.geminiReaderFactory,
                geminiHashToCwd: providerCatalog.geminiHashToCwd,
              },
              providerCatalog,
            ).catch(() => [] as SessionSummary[]),
            (deps.getChangedFiles ?? getGitChangedFiles)(project).catch(
              () => [] as WorkChangedFile[],
            ),
          ]);
          return { project, sessions, changedFiles };
        }),
      );
      const projectFilesById = new Map(
        projectResults.map((result) => [
          result.project.id,
          result.changedFiles,
        ]),
      );

      for (const { project, sessions, changedFiles } of projectResults) {
        const recentSessions = sessions
          .filter((session) => {
            const updatedAt = new Date(session.updatedAt).getTime();
            return (
              Number.isFinite(updatedAt) &&
              updatedAt >= since.getTime() &&
              updatedAt <= until.getTime()
            );
          })
          .sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
          )
          .slice(0, limit);

        const summary = ensureProjectSummary(changedProjects, project);
        summary.changedFileCount = changedFiles.length;

        for (const session of recentSessions) {
          const metadata = deps.sessionMetadataService?.getMetadata(session.id);
          const isArchived =
            metadata?.isArchived ?? session.isArchived ?? false;
          if (isArchived) continue;

          const process = deps.supervisor?.getProcessForSession(session.id);
          const pendingRequest = process?.getPendingInputRequest();
          const pendingInputType = pendingRequest
            ? pendingRequest.type === "tool-approval"
              ? "tool-approval"
              : "user-question"
            : undefined;
          const processState = process?.state.type;
          if (processState === "in-turn") summary.activeSessionCount++;
          if (pendingInputType) summary.needsAttentionCount++;
          summary.providerCounts[session.provider] =
            (summary.providerCounts[session.provider] ?? 0) + 1;

          const { agentClaim, verification, fileHints } =
            await readSessionSignals(
              deps.readerFactory(project),
              session,
              project,
            );
          const signalProject =
            inferProjectFromFileHints(fileHints, projects) ?? project;
          const signalChangedFiles = selectSignalChangedFiles({
            project: signalProject,
            changedFiles: projectFilesById.get(signalProject.id) ?? [],
            fileHints,
            projectSessionCount: recentSessions.length,
          });

          signals.push(
            buildWorkSignal({
              project: signalProject,
              session,
              pendingInputType,
              processState,
              terminationReason:
                process?.state.type === "terminated"
                  ? process.state.reason
                  : undefined,
              processError:
                process?.state.type === "terminated" && !!process.state.error,
              agentClaim,
              changedFiles: signalChangedFiles,
              verification,
              customTitle: metadata?.customTitle ?? session.customTitle,
            }),
          );
        }
      }

      const sortedSignals = signals
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
        .slice(0, limit);

      const snapshot: RemiWorkSnapshotResponse = {
        generatedAt: until.toISOString(),
        window: {
          since: since.toISOString(),
          until: until.toISOString(),
        },
        attention: sortedSignals.filter((signal) =>
          ["needs_attention", "blocked"].includes(signal.state),
        ),
        active: sortedSignals.filter((signal) => signal.state === "running"),
        completed: sortedSignals.filter((signal) =>
          ["claimed_done", "verified_done"].includes(signal.state),
        ),
        changedProjects: Array.from(changedProjects.values()).filter(
          (project) =>
            project.changedFileCount > 0 ||
            project.activeSessionCount > 0 ||
            project.needsAttentionCount > 0,
        ),
      };

      if (cacheTtlMs > 0) {
        cache = {
          key: cacheKey,
          expiresAt: now + cacheTtlMs,
          snapshot,
        };
      }

      return snapshot;
    },
  };
}

async function readSessionSignals(
  reader: ISessionReader,
  session: SessionSummary,
  project: Project,
): Promise<{
  agentClaim?: string;
  verification: WorkVerification[];
  fileHints: string[];
}> {
  try {
    const loaded = await reader.getSession(session.id, project.id, undefined, {
      tailCompactions: 1,
    });
    const messages = getLoadedSessionItems(loaded?.data);
    return {
      agentClaim: extractLatestAgentClaim(messages),
      verification: extractVerification(messages),
      fileHints: extractFileHints(messages),
    };
  } catch {
    return { verification: [], fileHints: [] };
  }
}

function getLoadedSessionItems(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const session = (data as { session?: unknown }).session;
  if (!session || typeof session !== "object") return [];
  const record = session as { messages?: unknown; entries?: unknown };
  if (Array.isArray(record.messages)) return record.messages;
  if (Array.isArray(record.entries)) return record.entries;
  return [];
}

function extractLatestAgentClaim(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isAssistantMessageLike(message)) continue;
    const text = extractMessageText(message);
    if (!text || !isCompletionClaim(text)) continue;
    return truncateSingleLine(text, CLAIM_MAX_LENGTH);
  }
  return undefined;
}

function extractVerification(messages: unknown[]): WorkVerification[] {
  const seen = new Set<string>();
  const verification: WorkVerification[] = [];
  const pendingCalls = new Map<string, ToolInvocation>();

  const addVerification = (
    invocation: ToolInvocation,
    status: WorkVerification["status"],
  ) => {
    const kind = classifyCommandKind(invocation.command, invocation.toolName);
    if (!kind) return;
    const label = truncateSingleLine(invocation.command, 120);
    if (seen.has(`${kind}:${label}`)) return;
    seen.add(`${kind}:${label}`);
    verification.push({ kind, status, label });
  };

  for (const message of messages) {
    const output = extractToolOutput(message);
    if (output?.callId) {
      const pending = pendingCalls.get(output.callId);
      if (pending) {
        addVerification(pending, output.status);
        pendingCalls.delete(output.callId);
      }
      continue;
    }

    const invocation = extractToolInvocation(message);
    if (!invocation) continue;
    if (invocation.deferUntilOutput && invocation.callId) {
      pendingCalls.set(invocation.callId, invocation);
      continue;
    }
    addVerification(invocation, getToolExecutionStatus(message));
  }

  for (const invocation of pendingCalls.values()) {
    addVerification(invocation, "unknown");
  }
  return verification;
}

function extractFileHints(messages: unknown[]): string[] {
  const hints = new Set<string>();
  const addFromText = (text?: string) => {
    if (!text) return;
    for (const hint of extractPathLikeSegments(text)) {
      hints.add(hint);
    }
  };

  for (const message of messages) {
    addFromText(extractMessageText(message));
    const invocation = extractToolInvocation(message);
    addFromText(invocation?.command);
  }

  return Array.from(hints);
}

function extractPathLikeSegments(text: string): string[] {
  const segments: string[] = [];
  const normalized = text.replace(/[`"'(),]/g, " ");
  const absoluteMatches = normalized.match(/\/Users\/[^\s]+/g) ?? [];
  segments.push(...absoluteMatches);

  const relativeMatches =
    normalized.match(
      /\b(?:packages|src|server|web|infra|capabilities|test|tests|docs|scripts|brain|memory|storage|voice)\/[^\s]+/g,
    ) ?? [];
  segments.push(...relativeMatches);

  return segments
    .map((segment) => segment.replace(/[.:;，。]+$/u, ""))
    .filter((segment) => segment.length > 0);
}

function inferProjectFromFileHints(
  fileHints: string[],
  projects: Project[],
): Project | undefined {
  let best:
    | {
        project: Project;
        score: number;
      }
    | undefined;

  for (const project of projects) {
    const projectRoot = normalizePath(project.path);
    let score = 0;
    for (const hint of fileHints) {
      if (!path.isAbsolute(hint)) continue;
      const normalizedHint = normalizePath(hint);
      if (isPathInside(normalizedHint, projectRoot)) {
        score += projectRoot.length;
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { project, score };
    }
  }

  return best?.project;
}

function selectSignalChangedFiles({
  project,
  changedFiles,
  fileHints,
  projectSessionCount,
}: {
  project: Project;
  changedFiles: WorkChangedFile[];
  fileHints: string[];
  projectSessionCount: number;
}): WorkChangedFile[] {
  if (changedFiles.length === 0) return [];
  const matched = changedFiles.filter((file) =>
    fileHints.some((hint) =>
      changedFileMatchesHint(project.path, file.path, hint),
    ),
  );
  if (matched.length > 0) return matched;
  return projectSessionCount <= 1 ? changedFiles : [];
}

function changedFileMatchesHint(
  projectPath: string,
  changedFilePath: string,
  hint: string,
): boolean {
  const normalizedChanged = normalizePath(changedFilePath);
  if (!path.isAbsolute(hint)) {
    return (
      normalizedChanged === normalizePath(hint) ||
      normalizedChanged.endsWith(`/${normalizePath(hint)}`)
    );
  }

  const relative = path.relative(projectPath, hint);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return normalizePath(relative) === normalizedChanged;
}

function normalizePath(value: string): string {
  return path.normalize(value).replace(/\\/g, "/");
}

function isPathInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

interface ToolInvocation {
  command: string;
  callId?: string;
  toolName?: string;
  deferUntilOutput?: boolean;
}

function isAssistantMessageLike(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const record = message as Record<string, unknown>;
  if (record.type === "assistant") return true;
  const payload = getCodexResponsePayload(record);
  if (payload?.type === "message" && payload.role === "assistant") return true;
  if (record.type === "item.completed") {
    const item = record.item;
    return (
      !!item &&
      typeof item === "object" &&
      (item as Record<string, unknown>).type === "agent_message"
    );
  }
  return false;
}

function extractMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  const payload = getCodexResponsePayload(record);
  if (payload?.type === "message") {
    return extractTextContent(payload.content);
  }
  const item = record.item;
  if (item && typeof item === "object") {
    const text = (item as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  const nestedMessage = record.message;
  const content =
    nestedMessage && typeof nestedMessage === "object"
      ? (nestedMessage as Record<string, unknown>).content
      : undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return extractTextContent(content);
  }
  return undefined;
}

function extractToolInvocation(message: unknown): ToolInvocation | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  const payload = getCodexResponsePayload(record);
  if (
    payload?.type === "function_call" ||
    payload?.type === "custom_tool_call"
  ) {
    const command = extractCommandLikeText(payload.arguments ?? payload.input);
    if (!command) return undefined;
    return {
      command,
      callId: typeof payload.call_id === "string" ? payload.call_id : undefined,
      toolName: typeof payload.name === "string" ? payload.name : undefined,
      deferUntilOutput: true,
    };
  }

  const item = record.item;
  if (item && typeof item === "object") {
    const itemRecord = item as Record<string, unknown>;
    if (
      itemRecord.type === "command_execution" &&
      typeof itemRecord.command === "string"
    ) {
      return {
        command: itemRecord.command,
        callId: typeof itemRecord.id === "string" ? itemRecord.id : undefined,
        toolName: "command_execution",
      };
    }
  }
  const toolUse = record.toolUse;
  const input =
    toolUse && typeof toolUse === "object"
      ? (toolUse as Record<string, unknown>).input
      : undefined;
  if (!input || typeof input !== "object") return undefined;
  const inputRecord = input as Record<string, unknown>;
  for (const key of ["cmd", "command", "args"]) {
    const value = inputRecord[key];
    if (typeof value === "string") {
      return {
        command: value,
        callId:
          typeof record.toolUseId === "string" ? record.toolUseId : undefined,
        toolName:
          typeof (toolUse as Record<string, unknown>).name === "string"
            ? ((toolUse as Record<string, unknown>).name as string)
            : undefined,
      };
    }
    if (Array.isArray(value)) {
      return {
        command: value.join(" "),
        callId:
          typeof record.toolUseId === "string" ? record.toolUseId : undefined,
        toolName:
          typeof (toolUse as Record<string, unknown>).name === "string"
            ? ((toolUse as Record<string, unknown>).name as string)
            : undefined,
      };
    }
  }
  return undefined;
}

function extractToolOutput(
  message: unknown,
): { callId?: string; status: WorkVerification["status"] } | undefined {
  if (!message || typeof message !== "object") return undefined;
  const record = message as Record<string, unknown>;
  const payload = getCodexResponsePayload(record);
  if (
    payload?.type === "function_call_output" ||
    payload?.type === "custom_tool_call_output"
  ) {
    return {
      callId: typeof payload.call_id === "string" ? payload.call_id : undefined,
      status: getToolExecutionStatus(message),
    };
  }
  return undefined;
}

function getCodexResponsePayload(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (record.type !== "response_item") return undefined;
  const payload = record.payload;
  if (!payload || typeof payload !== "object") return undefined;
  return payload as Record<string, unknown>;
}

function extractTextContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => {
      if (!block || typeof block !== "object") return undefined;
      const text = (block as Record<string, unknown>).text;
      return typeof text === "string" ? text : undefined;
    })
    .filter((text): text is string => !!text)
    .join("\n");
  return text || undefined;
}

function extractCommandLikeText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const parsed = parseJsonObject(value);
    if (parsed) return extractCommandLikeText(parsed) ?? value;
    return value;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["cmd", "command", "script", "input", "args"]) {
    const nested = record[key];
    if (typeof nested === "string") return nested;
    if (Array.isArray(nested)) return nested.join(" ");
    if (nested && typeof nested === "object") {
      const extracted = extractCommandLikeText(nested);
      if (extracted) return extracted;
    }
  }
  return undefined;
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function classifyCommandKind(
  command: string,
  toolName?: string,
): WorkVerification["kind"] | undefined {
  if (toolName === "apply_patch") return undefined;
  const normalized = command.toLowerCase().trim();
  const executable = normalized.split(/\s+/)[0] ?? "";
  const invokes = (pattern: RegExp) => pattern.test(normalized);

  if (invokes(/\bgit\s+commit\b/)) return "commit";
  if (
    invokes(/(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(?:[^\s]+\s+)*typecheck\b/) ||
    invokes(/(^|\s)(npx\s+)?tsc(\s|$)/)
  ) {
    return "typecheck";
  }
  if (
    invokes(/(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(?:[^\s]+\s+)*lint\b/) ||
    invokes(/(^|\s)biome\s+check(\s|$)/) ||
    invokes(/(^|\s)eslint(\s|$)/)
  ) {
    return "lint";
  }
  if (
    invokes(/(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(?:[^\s]+\s+)*build\b/) ||
    invokes(/(^|\s)(vite|tsup)\s+build(\s|$)/) ||
    invokes(/(^|\s)next\s+build(\s|$)/)
  ) {
    return "build";
  }
  if (
    invokes(/(^|\s)(npm|pnpm|yarn|bun)\s+(run\s+)?(?:[^\s]+\s+)*test\b/) ||
    invokes(/(^|\s)(npx\s+)?(vitest|jest|mocha|pytest|playwright)\b/) ||
    (executable === "go" && invokes(/\bgo\s+test\b/)) ||
    (executable === "cargo" && invokes(/\bcargo\s+test\b/))
  ) {
    return "test";
  }
  return undefined;
}

function getToolExecutionStatus(message: unknown): WorkVerification["status"] {
  if (!message || typeof message !== "object") return "unknown";
  const record = message as Record<string, unknown>;
  const payload = getCodexResponsePayload(record);
  const payloadStatus = getProcessExitStatus(
    payload ? extractTextContent(payload.output ?? payload.content) : undefined,
  );
  if (payloadStatus !== "unknown") return payloadStatus;

  const item = record.item;
  if (item && typeof item === "object") {
    const itemRecord = item as Record<string, unknown>;
    if (typeof itemRecord.exit_code === "number") {
      return itemRecord.exit_code === 0 ? "passed" : "failed";
    }
    if (itemRecord.status === "failed") return "failed";
    const itemStatus = getProcessExitStatus(
      extractTextContent(itemRecord.aggregated_output ?? itemRecord.output),
    );
    if (itemStatus !== "unknown") return itemStatus;
  }
  const toolUseResult = record.toolUseResult;
  if (toolUseResult && typeof toolUseResult === "object") {
    const result = toolUseResult as Record<string, unknown>;
    if (result.is_error === true) return "failed";
    if (result.exitCode === 0) return "passed";
    if (result.exitCode === 1) return "failed";
    const resultStatus = getProcessExitStatus(
      extractTextContent(result.content ?? result.output),
    );
    if (resultStatus !== "unknown") return resultStatus;
  }
  return "unknown";
}

function getProcessExitStatus(text?: string): WorkVerification["status"] {
  if (!text) return "unknown";
  const match = text.match(/Process exited with code\s+(-?\d+)/i);
  if (!match) return "unknown";
  return Number(match[1]) === 0 ? "passed" : "failed";
}

function isCompletionClaim(text: string): boolean {
  return /\b(implemented|fixed|added|updated|created|completed|done|finished|wired|tests pass|验证通过)\b/i.test(
    text,
  );
}

function isBlockedClaim(text?: string): boolean {
  return (
    !!text &&
    /\b(blocked|stuck|failed|cannot proceed|can't proceed)\b/i.test(text)
  );
}

function hasPassedVerification(verification: WorkVerification[]): boolean {
  return verification.some(
    (item) =>
      ["test", "typecheck", "lint", "build", "commit"].includes(item.kind) &&
      item.status === "passed",
  );
}

function hasFailedVerification(verification: WorkVerification[]): boolean {
  return verification.some((item) => item.status === "failed");
}

function truncateSingleLine(text: string, maxLength: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}

function ensureProjectSummary(
  summaries: Map<string, WorkProjectSummary>,
  project: Project,
): WorkProjectSummary {
  const existing = summaries.get(project.id);
  if (existing) return existing;
  const summary: WorkProjectSummary = {
    projectId: project.id,
    projectName: project.name,
    providerCounts: {},
    changedFileCount: 0,
    activeSessionCount: 0,
    needsAttentionCount: 0,
  };
  summaries.set(project.id, summary);
  return summary;
}

async function getGitChangedFiles(
  project: Project,
): Promise<WorkChangedFile[]> {
  const [{ stdout }, numstatByPath] = await Promise.all([
    execFileAsync("git", ["-C", project.path, "status", "--porcelain=v1"], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }),
    getGitNumstat(project.path),
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => parsePorcelainStatus(line, numstatByPath))
    .filter((file): file is WorkChangedFile => file !== null);
}

async function getGitNumstat(
  projectPath: string,
): Promise<Map<string, Pick<WorkChangedFile, "linesAdded" | "linesDeleted">>> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectPath, "diff", "--numstat", "HEAD", "--"],
      { timeout: 10_000, maxBuffer: 1024 * 1024 },
    );
    const byPath = new Map<
      string,
      Pick<WorkChangedFile, "linesAdded" | "linesDeleted">
    >();
    for (const line of stdout.split("\n").filter(Boolean)) {
      const parsed = parseNumstatLine(line);
      if (parsed) byPath.set(parsed.path, parsed);
    }
    return byPath;
  } catch {
    return new Map();
  }
}

function parseNumstatLine(line: string):
  | (Pick<WorkChangedFile, "linesAdded" | "linesDeleted"> & {
      path: string;
    })
  | null {
  const [added, deleted, ...pathParts] = line.split("\t");
  const path = pathParts.join("\t").trim();
  if (!added || !deleted || !path) return null;
  const linesAdded = added === "-" ? null : Number.parseInt(added, 10);
  const linesDeleted = deleted === "-" ? null : Number.parseInt(deleted, 10);
  return {
    path,
    linesAdded: Number.isFinite(linesAdded) ? linesAdded : null,
    linesDeleted: Number.isFinite(linesDeleted) ? linesDeleted : null,
  };
}

function parsePorcelainStatus(
  line: string,
  numstatByPath: Map<
    string,
    Pick<WorkChangedFile, "linesAdded" | "linesDeleted">
  >,
): WorkChangedFile | null {
  if (line.length < 4) return null;
  const status = line.slice(0, 2);
  const path = line.slice(3).trim();
  if (!path) return null;
  const numstat = numstatByPath.get(path);
  return {
    path,
    status: status.trim() || "?",
    staged: status[0] !== " " && status[0] !== "?",
    linesAdded: numstat?.linesAdded ?? null,
    linesDeleted: numstat?.linesDeleted ?? null,
  };
}
