import * as p from '@clack/prompts';
import type {
  ChecksResult,
  GateAction,
  GateConfig,
  PlanTask,
} from '@kingsleyzissou/pacifista-core';

/**
 * Present the user gate using clack prompts.
 */
export async function presentGate(
  task: PlanTask,
  attempt: number,
  changedFiles: string[],
  checksResult: ChecksResult,
  gateConfig: GateConfig,
): Promise<GateAction> {
  // Auto-approve check
  if (shouldAutoApprove(gateConfig, task, checksResult)) {
    p.log.success(`Auto-approved: Task ${task.id}: ${task.title}`);
    return { action: 'approve' };
  }

  // Display results
  p.log.info(`Task ${task.id}: ${task.title} — Attempt ${attempt}`);

  // Changed files
  if (changedFiles.length > 0) {
    p.log.message('Changed files:\n' + changedFiles.map(f => `  ${f}`).join('\n'));
  } else {
    p.log.warn('No files changed');
  }

  // Check results
  const checkSummary = checksResult.checks
    .map(c => `  ${c.name}: ${fmtStatus(c.status)}`)
    .join('\n');
  p.log.message(`Check Results:\n${checkSummary}`);

  // Show error output for failures
  for (const check of checksResult.checks) {
    if (check.output) {
      p.log.error(`${check.name} errors:\n${check.output}`);
    }
  }

  // Prompt for action
  const action = await p.select({
    message: 'What would you like to do?',
    options: [
      { value: 'approve', label: 'Approve', hint: 'accept and continue' },
      { value: 'revise', label: 'Revise', hint: 'retry with feedback' },
      { value: 'reject', label: 'Reject', hint: 'reject this task' },
      { value: 'quit', label: 'Quit', hint: 'save and exit' },
    ],
  });

  if (p.isCancel(action)) {
    return { action: 'quit' };
  }

  switch (action) {
    case 'approve':
      return { action: 'approve' };

    case 'revise': {
      const feedback = await p.text({
        message: 'Revision feedback:',
        placeholder: 'Describe what needs to change...',
        validate: v => {
          if (!v?.trim()) return 'Feedback is required';
        },
      });
      if (p.isCancel(feedback)) return { action: 'quit' };
      return { action: 'revise', feedback: String(feedback).trim() };
    }

    case 'reject': {
      const stop = await p.confirm({
        message: 'Stop execution entirely?',
        initialValue: false,
      });
      if (p.isCancel(stop)) return { action: 'quit' };
      return { action: 'reject', stop: !!stop };
    }

    case 'quit':
      return { action: 'quit' };

    default:
      return { action: 'quit' };
  }
}

function shouldAutoApprove(
  config: GateConfig,
  task: PlanTask,
  checksResult: ChecksResult,
): boolean {
  if (typeof config.autoApprove === 'function') {
    return config.autoApprove(task, checksResult);
  }
  if (config.autoApprove === true) {
    return checksResult.passed;
  }
  return false;
}

function fmtStatus(status: 'pass' | 'fail'): string {
  switch (status) {
    case 'pass':
      return '✓ pass';
    case 'fail':
      return '✗ fail';
    default: {
      const _exhaustive: never = status;
      return String(_exhaustive);
    }
  }
}
