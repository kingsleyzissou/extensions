import type { Plan, PlanTask } from './types.ts';

/**
 * Parse a markdown plan file into structured tasks.
 *
 * Supported heading formats:
 *   ## Task 1: Title
 *   ## Task 1 -- Title
 *   ### 1. Title
 *   ### 1: Title
 */
export function parsePlan(markdown: string): Plan {
  const lines = markdown.split('\n');

  let title = '';
  let context = '';
  const tasks: PlanTask[] = [];

  let section: 'none' | 'context' | 'task' = 'none';
  let currentTask: PlanTask | null = null;
  let bodyLines: string[] = [];
  const contextLines: string[] = [];

  const taskHeadingRe = /^#{2,3}\s+(?:Task\s+)?(\d+)\s*(?::|--|\.)\s*(.+)/i;

  function flushTask() {
    if (currentTask) {
      const { body, fields } = extractFields(bodyLines.join('\n').trim());
      currentTask.body = body;
      currentTask.fields = fields;
      tasks.push(currentTask);
      currentTask = null;
      bodyLines = [];
    }
  }

  for (const line of lines) {
    // Plan title: # Plan: <name>
    const titleMatch = line.match(/^#\s+(?:Plan:\s*)?(.*)/);
    if (titleMatch && !title) {
      title = titleMatch[1]!.trim();
      continue;
    }

    // Context heading: ## Context
    if (/^#{2}\s+Context\s*$/i.test(line)) {
      flushTask();
      section = 'context';
      continue;
    }

    // Tasks container heading: ## Tasks (optional, skip it)
    if (/^#{2}\s+Tasks\s*$/i.test(line)) {
      flushTask();
      if (section === 'context') {
        context = contextLines.join('\n').trim();
      }
      section = 'none';
      continue;
    }

    // Task heading
    const taskMatch = line.match(taskHeadingRe);
    if (taskMatch) {
      if (section === 'context') {
        context = contextLines.join('\n').trim();
      }
      flushTask();
      section = 'task';
      currentTask = {
        id: parseInt(taskMatch[1]!, 10),
        title: taskMatch[2]!.trim(),
        body: '',
        fields: {},
      };
      continue;
    }

    // Any other ## heading ends the current context/task
    if (/^#{2}\s+/.test(line) && section === 'context') {
      context = contextLines.join('\n').trim();
      section = 'none';
    }

    // Accumulate content
    if (section === 'context') {
      contextLines.push(line);
    } else if (section === 'task') {
      bodyLines.push(line);
    }
  }

  // Flush remaining
  if (section === 'context') {
    context = contextLines.join('\n').trim();
  }
  flushTask();

  return { title, context, tasks };
}

/**
 * Extract **key**: value fields from the body text.
 */
function extractFields(text: string): {
  body: string;
  fields: Record<string, string>;
} {
  const fields: Record<string, string> = {};
  const remaining: string[] = [];
  const fieldRe = /^-\s+\*\*(\w+)\*\*:\s*(.+)/;

  for (const line of text.split('\n')) {
    const match = line.match(fieldRe);
    if (match) {
      fields[match[1]!.toLowerCase()] = match[2]!.trim();
    } else {
      remaining.push(line);
    }
  }

  return { body: remaining.join('\n').trim(), fields };
}
