import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { PlanTask, RunState, TaskState } from "./types.ts";

const STATE_DIR = ".pacifista";
const STATE_FILE = "state.json";

export function getStatePath(projectRoot: string): string {
  return `${projectRoot}/${STATE_DIR}/${STATE_FILE}`;
}

export function createState(
  planPath: string,
  worktreePath: string,
  tasks: PlanTask[],
): RunState {
  return {
    planPath,
    worktreePath,
    startedAt: new Date().toISOString(),
    currentTask: tasks[0]?.id ?? 1,
    tasks: tasks.map(
      (t): TaskState => ({
        id: t.id,
        title: t.title,
        status: "pending",
        attempts: [],
      }),
    ),
  };
}

export async function loadState(statePath: string): Promise<RunState> {
  const file = Bun.file(statePath);
  if (!(await file.exists())) {
    throw new Error(`State file not found: ${statePath}`);
  }
  return file.json() as Promise<RunState>;
}

export async function saveState(
  statePath: string,
  state: RunState,
): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true });
  await Bun.write(statePath, JSON.stringify(state, null, 2) + "\n");
}
