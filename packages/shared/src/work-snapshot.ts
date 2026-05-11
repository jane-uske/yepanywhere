export type WorkSignalState =
  | "needs_attention"
  | "running"
  | "claimed_done"
  | "verified_done"
  | "blocked"
  | "stale";

export type WorkType =
  | "feature"
  | "bugfix"
  | "refactor"
  | "test"
  | "docs"
  | "unknown";

export type WorkConfidence = "low" | "medium" | "high";

export interface WorkChangedFile {
  path: string;
  status: string;
  staged: boolean;
  linesAdded: number | null;
  linesDeleted: number | null;
}

export interface WorkVerification {
  kind: "test" | "typecheck" | "lint" | "build" | "commit" | "approval";
  status: "passed" | "failed" | "unknown";
  label: string;
}

export interface WorkEvidenceRef {
  kind: "session" | "git" | "tool" | "process";
  label: string;
  href?: string;
}

export interface WorkSignal {
  id: string;
  provider: string;
  projectId: string;
  projectName: string;
  sessionId?: string;
  title: string;
  state: WorkSignalState;
  workType: WorkType;
  agentClaim?: string;
  changedFiles?: WorkChangedFile[];
  verification?: WorkVerification[];
  confidence: WorkConfidence;
  updatedAt: string;
  nextStep?: string;
  evidenceRefs: WorkEvidenceRef[];
}

export interface WorkProjectSummary {
  projectId: string;
  projectName: string;
  providerCounts: Record<string, number>;
  changedFileCount: number;
  activeSessionCount: number;
  needsAttentionCount: number;
}

export interface RemiWorkSnapshotResponse {
  generatedAt: string;
  window: {
    since: string;
    until: string;
  };
  attention: WorkSignal[];
  active: WorkSignal[];
  completed: WorkSignal[];
  changedProjects: WorkProjectSummary[];
  dailySummary?: {
    claim: string;
    confidence: WorkConfidence;
    evidenceCount: number;
  };
}
