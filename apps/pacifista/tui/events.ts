import * as p from '@clack/prompts';
import type { PacifistaEvent } from '@kingsleyzissou/pacifista-core';

/**
 * Collapse line continuations and newlines, but do NOT truncate.
 */
function formatCommand(raw: string): string {
  return raw.replace(/\\\n/g, ' ').replace(/\n/g, ' && ').replace(/\s+/g, ' ').trim();
}

function formatElapsed(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return mins > 0 ? `${mins}m ${secs.toString().padStart(2, '0')}s` : `${secs}s`;
}

/**
 * Create an event handler backed by clack's spinner.
 *
 * The spinner message format:
 *   <elapsed> · <tool>: <full message>
 *
 * Elapsed time is updated every second via an interval.
 * Tool messages are shown in full — no truncation.
 *
 * Important: anything that writes directly to stdout/stderr
 * (e.g. a hook using `stdio: 'inherit'`) will corrupt the
 * spinner’s cursor positioning. Hooks should pipe their I/O.
 */
export function createEventRenderer(): {
  handler: (event: PacifistaEvent) => void;
  startSpinner: () => void;
  stopSpinner: (message?: string) => void;
} {
  const s = p.spinner();
  let spinnerActive = false;
  let taskStartTime = 0;
  let currentStatus = '';
  let timerInterval: ReturnType<typeof setInterval> | null = null;

  const updateMessage = () => {
    if (!spinnerActive) return;
    const elapsed = formatElapsed(taskStartTime);
    s.message(`${elapsed} · ${currentStatus}`);
  };

  const startTimer = () => {
    stopTimer();
    taskStartTime = Date.now();
    timerInterval = setInterval(updateMessage, 1000);
  };

  const stopTimer = () => {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  };

  const startSpinner = () => {
    if (!spinnerActive) {
      s.start('starting...');
      spinnerActive = true;
      startTimer();
    }
  };

  const stopSpinner = (message?: string) => {
    stopTimer();
    if (spinnerActive) {
      s.stop(message ?? 'Done');
      spinnerActive = false;
    }
  };

  const setStatus = (status: string) => {
    currentStatus = status;
    updateMessage();
  };

  const handler = (event: PacifistaEvent): void => {
    switch (event.type) {
      case 'plan:loaded':
        p.log.info(`Plan: ${event.plan.title} (${event.plan.tasks.length} tasks)`);
        break;

      case 'setup:start':
        startSpinner();
        setStatus(`setup: ${event.command}`);
        break;

      case 'setup:output': {
        stopSpinner();
        const lines = event.text
          .split('\n')
          .map(line => `  \x1b[2m${line}\x1b[0m`)
          .join('\n');
        console.log(lines);
        startSpinner();
        setStatus('setup...');
        break;
      }

      case 'setup:done':
        stopSpinner(event.ok ? 'Setup complete' : 'Setup failed');
        break;

      case 'task:start':
        stopSpinner();
        p.log.step(`Task ${event.task.id}: ${event.task.title} (attempt ${event.attempt})`);
        startSpinner();
        setStatus('agent starting...');
        break;

      case 'task:complete':
        if (event.exitCode !== 0) {
          stopSpinner(`Agent exited with code ${event.exitCode}`);
        } else {
          stopSpinner('Agent complete');
        }
        break;

      case 'tool:start':
        if (!spinnerActive) break;
        if (event.toolName === 'bash') {
          const cmd = formatCommand(String(event.args['command'] ?? ''));
          setStatus(`bash: ${cmd}`);
        } else if (event.toolName === 'edit') {
          setStatus(`editing: ${String(event.args['path'] ?? '')}`);
        } else if (event.toolName === 'write') {
          setStatus(`writing: ${String(event.args['path'] ?? '')}`);
        } else if (event.toolName === 'read') {
          setStatus(`reading: ${String(event.args['path'] ?? '')}`);
        } else {
          setStatus(`${event.toolName}...`);
        }
        break;

      case 'tool:end':
        if (spinnerActive && event.isError) {
          setStatus(`✗ ${event.toolName} failed`);
        }
        break;

      case 'agent:thinking':
        if (spinnerActive) {
          setStatus('thinking...');
        }
        break;

      case 'checks:start':
        startSpinner();
        setStatus('running checks...');
        break;

      case 'checks:done': {
        const summary = event.result.checks.map(c => `${c.name} ${c.status}`).join(' · ');
        stopSpinner(`Checks: ${summary}`);
        break;
      }

      case 'task:approved':
        p.log.success(`Task ${event.task.id} approved`);
        break;

      case 'task:rejected':
        p.log.error(`Task ${event.task.id} rejected`);
        break;

      case 'state:saved':
        p.log.info('State saved. Resume later with `kuma resume`.');
        break;

      case 'final-checks:start':
        startSpinner();
        setStatus('running final checks...');
        break;

      case 'final-checks:done': {
        const finalSummary = event.result.checks.map(c => `${c.name} ${c.status}`).join(' · ');
        stopSpinner(`Final checks: ${finalSummary}`);
        break;
      }

      case 'final-checks:failed': {
        const failSummary = event.result.checks.map(c => `${c.name} ${c.status}`).join(' · ');
        stopSpinner(`Final checks failed: ${failSummary}`);
        for (const check of event.result.checks) {
          if (check.output) {
            p.log.error(`${check.name}:\n${check.output}`);
          }
        }
        break;
      }

      case 'review:start':
        startSpinner();
        setStatus('starting ensemble review...');
        break;

      case 'review:reviewing':
        setStatus(`ensemble review: ${event.message ?? 'reviewing...'}`);
        break;

      case 'review:triage':
        setStatus('ensemble review: triaging findings...');
        break;

      case 'review:verdicts': {
        stopSpinner();
        const fixCount = event.verdicts.filter(v => v.verdict === 'fix').length;
        const deferCount = event.verdicts.filter(v => v.verdict === 'defer').length;
        const pushbackCount = event.verdicts.filter(v => v.verdict === 'pushback').length;
        const parts: string[] = [];
        if (fixCount > 0) parts.push(`${fixCount} fix`);
        if (deferCount > 0) parts.push(`${deferCount} defer`);
        if (pushbackCount > 0) parts.push(`${pushbackCount} pushback`);
        p.log.info(`Triage: ${parts.join(', ')}`);

        // Show each verdict
        const lines = event.verdicts.map(v => {
          const icon = v.verdict === 'fix' ? '\u2717' : v.verdict === 'defer' ? '\u25CB' : '\u2190';
          return `${icon} [${v.verdict}] ${v.description}${v.sha ? ` (${v.sha})` : ''}`;
        });
        if (lines.length > 0) {
          p.note(lines.join('\n'), 'Triage Verdicts');
        }
        break;
      }

      case 'review:applying':
        startSpinner();
        setStatus(`applying ${event.total} fix${event.total === 1 ? '' : 'es'}...`);
        break;

      case 'review:fix':
        setStatus(
          `ensemble review: applying fix ${event.current}/${event.total} — ${event.description}`,
        );
        break;

      case 'review:done':
        stopSpinner(`Review complete (${event.fixes} fixes applied)`);
        break;

      case 'error':
        stopSpinner();
        p.log.error(event.message);
        break;

      case 'run:summary': {
        const r = event.result;
        const lines = r.tasks.map(task => {
          const icon =
            task.status === 'approved'
              ? '✓'
              : task.status === 'rejected'
                ? '✗'
                : task.status === 'skipped'
                  ? '○'
                  : '…';
          return `${icon} Task ${task.id}: ${task.title} [${task.status}]`;
        });
        p.note(lines.join('\n'), `${r.completed}/${r.total} tasks completed`);
        break;
      }
    }
  };

  return { handler, startSpinner, stopSpinner };
}
