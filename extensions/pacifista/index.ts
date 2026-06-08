import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { runPlan } from "@kingsleyzissou/pacifista-core";
import type { GateAction, PacifistaEvent } from "@kingsleyzissou/pacifista-core";

export default function activate(pi: ExtensionAPI) {
  pi.registerCommand("/execute", {
    description:
      "Execute a markdown plan file with QC gates and user approval",
    handler: async (raw, ctx) => {
      const args = raw.trim().split(/\s+/);

      if (args.length === 0 || !args[0]) {
        ctx.ui.notify(
          "Usage: /execute <plan.md> [--worktree <path>] [--skip-review] [--start-from <n>]",
          "info",
        );
        return;
      }

      const planPath = resolve(args[0]);
      let worktree = process.cwd();
      let startFrom: number | undefined;
      let skipReview = false;

      for (let i = 1; i < args.length; i++) {
        const arg = args[i]!;
        switch (arg) {
          case "-w":
          case "--worktree":
            worktree = resolve(args[++i] ?? ".");
            break;
          case "--start-from":
            startFrom = parseInt(args[++i] ?? "1", 10);
            break;
          case "--skip-review":
            skipReview = true;
            break;
        }
      }

      ctx.ui.notify(`▶ Starting plan: ${planPath}`, "info");

      const onEvent = (event: PacifistaEvent): void => {
        switch (event.type) {
          case "task:start":
            ctx.ui.notify(
              `Task ${event.task.id}: ${event.task.title} (attempt ${event.attempt})`,
              "info",
            );
            break;
          case "task:approved":
            ctx.ui.notify(`✓ Task ${event.task.id} approved`, "info");
            break;
          case "task:rejected":
            ctx.ui.notify(`✗ Task ${event.task.id} rejected`, "warning");
            break;
          case "error":
            ctx.ui.notify(event.message, "error");
            break;
          case "run:summary":
            ctx.ui.notify(
              `${event.result.completed}/${event.result.total} tasks completed`,
              event.result.completed === event.result.total ? "info" : "warning",
            );
            break;
        }
      };

      // Auto-approve gate for extension mode (non-interactive)
      const onGate = async (): Promise<GateAction> => {
        return { action: "approve" };
      };

      try {
        const result = await runPlan(
          {
            planPath,
            worktreePath: worktree,
            startFromTask: startFrom,
            commitPerTask: true,
            skipReview,
          },
          onEvent,
          onGate,
        );

        ctx.ui.notify(
          `✓ Plan complete: ${result.completed}/${result.total} tasks approved`,
          result.completed === result.total ? "info" : "warning",
        );
      } catch (err) {
        ctx.ui.notify(
          `Plan execution failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });
}
