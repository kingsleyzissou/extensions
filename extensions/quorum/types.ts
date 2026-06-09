import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ProjectType = "frontend" | "backend-ts" | "go";

export type ExecFn = ExtensionAPI["exec"];

export interface ReviewerDef {
  name: string;
  label: string;
  agentFile: string;
  projectTypes: ProjectType[];
}

export interface ReviewerResult {
  reviewer: string;
  label: string;
  output: string;
  exitCode: number;
  error?: string;
}

export const PROJECT_LABELS: Record<ProjectType, string> = {
  frontend: "React/TypeScript frontend",
  "backend-ts": "TypeScript library",
  go: "Go",
};

/** Structured output written when /review --output is used. */
export interface QuorumOutput {
  baseBranch: string;
  projectType: ProjectType;
  commitCount: number;
  reviewers: {
    name: string;
    label: string;
    output: string;
    exitCode: number;
    error?: string;
  }[];
}
