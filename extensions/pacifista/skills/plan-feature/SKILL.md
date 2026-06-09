---
name: plan-feature
description: Interactive planning session that produces a markdown plan file compatible with pacifista. Use when you need to break a feature or bugfix into discrete, agent-executable tasks with TDD and quality gates.
scopes: [global]
---

# Plan Feature

Interactive session that produces a single artifact: a markdown plan file
formatted for pacifista execution. The plan drives mechanical, task-by-task
execution with isolated agent sessions, deterministic QC, and user approval
gates.

## When to Use

- Starting a new feature, bugfix, or refactor that spans multiple files
- Breaking down a Jira issue or spec into executable tasks
- Any work that benefits from isolated, reviewable commits

## Output

A single markdown file saved to:

```
docs/plans/YYYY-MM-DD-<topic>.md
```

## Plan Format

The pacifista plan parser expects this structure. Follow it exactly.

```markdown
# Plan: <Feature Name>

## Context

<Background the agent needs for every task. This entire section is
prepended to each task prompt, so the agent understands the broader
picture without seeing the full plan.>

<Include: what the feature does, why it exists, architectural constraints,
relevant existing code, patterns to follow, patterns to avoid.>

## Tasks

## Task 1: <Title>

<Freeform description. Be specific enough that an agent with no prior
context can implement this in a single session. Include:
- What to create, modify, or delete
- Expected behavior
- Edge cases to handle
- Relevant file paths>

- **files**: <comma-separated list of files involved>
- **acceptance**: <how to verify the task is done>

## Task 2: <Title>

...

- **commit**: `Component: short description`
```

### Format Rules

1. **Top heading**: `# Plan: <name>` -- names the plan
2. **Context section**: `## Context` -- shared context for all tasks. This
   is the most important section. An agent seeing only this + one task must
   have enough background to work.
3. **Tasks section**: `## Tasks` -- optional container (tasks can appear
   without it)
4. **Task headings**: `## Task N: <Title>` -- numbered, sequential. The
   number and title are required. Also accepts `### N. Title` or
   `### N: Title`.
5. **Task body**: Freeform markdown under each heading. Sent to the agent
   as-is.
6. **Structured fields** (optional, extracted by parser):
   - `- **files**: src/foo.ts, src/bar.ts` -- files involved
   - `- **acceptance**: tests pass, type exports correctly` -- done criteria
   - `- **commit**: \`Component: short description\`` -- commit message
   - `- **depends**: 1` -- task dependency (reserved, not yet enforced)

## Planning Process

### 1. Gather Context

- Understand the feature/bugfix from the user (rough intent is fine)
- Read relevant code, specs, or Jira issues
- Identify the files, modules, and patterns involved
- Ask 2-3 clarifying questions if the scope is ambiguous

### 2. Decompose into Tasks

Break the work into tasks that follow these constraints:

- **One logical change per task** -- each task should produce one atomic,
  reviewable commit
- **Each task must compile independently** -- after the agent finishes a
  task, typecheck and lint must pass
- **TDD** -- each task that adds or modifies behavior should include
  colocated test files (`.test.ts` / `.test.tsx`)
- **Skeleton-first ordering** -- types and interfaces before
  implementations, infrastructure before consumers
- **No forward references** -- a task must not depend on code that a later
  task will create
- **Self-contained descriptions** -- an agent seeing only the Context
  section + this one task must be able to implement it without guessing
- **Every task must produce code changes** -- do NOT create
  verification-only tasks (e.g. "verify everything works", "run the
  test suite", "check for regressions"). The orchestrator runs QC
  automatically after every task and runs a full QC suite after all
  tasks complete. A task that produces no file changes will fail the
  commit step.

### 3. Write the Context Section

This is the most critical section. It must include:

- What the feature is and why it exists
- The architectural approach (high level)
- Key patterns to follow (with file path examples from the existing code)
- Patterns or anti-patterns to avoid
- Any constraints (backwards compatibility, performance, etc.)

### 4. Write Each Task

For each task, include:

- A clear title that describes the deliverable (not the activity)
- What files to create, modify, or delete
- Expected behavior and edge cases
- The `files`, `acceptance`, and `commit` structured fields where useful
- Exact code snippets when precision matters (e.g., type definitions,
  API contracts)

### Commit Messages

Each task should include a `commit` field with a pre-written commit
message. The orchestrator commits on the host after approval — the
agent never runs `git commit`.

Follow these conventions:

- **Format**: `Component: short description`
- Prefix with the component or area, followed by a colon and space
- Use sentence case after the prefix
- Keep under 72 characters
- Use imperative mood ("add", "fix", "remove")
- Do NOT use semantic prefixes (feat, fix, chore, etc.)

Examples:
- `- **commit**: \`TimezoneSelector: add component skeleton\``
- `- **commit**: \`store: add derived selectors for FS customizations\``
- `- **commit**: \`tests: remove legacy azure integration test\``

If the task title already follows this format, you can omit the
`commit` field — the orchestrator will fall back to the task title.

### 5. Review with the User

Present the plan task-by-task. For each task, confirm:

- Is the scope right? (not too big, not too small)
- Is the description clear enough for an agent with no prior context?
- Are the acceptance criteria verifiable?
- Is the ordering correct? (no forward references)

### 6. Save the Plan

Save the approved plan to:

```
docs/plans/YYYY-MM-DD-<topic>.md
```

Use today's date and a short kebab-case topic name.

## Task Sizing Guidelines

A well-sized task:

- Changes 1-5 files
- Can be implemented in a single agent session (a few minutes)
- Has a clear "done" state that QC can verify
- Produces a commit that makes sense in isolation

If a task touches more than 5-10 files, consider splitting it. For
bulk migrations (e.g., updating 30 import statements), grouping by
directory or pattern is acceptable.

## After Planning

Tell the user:

> Plan saved to `docs/plans/<filename>.md`.
>
> To execute:
>
> ```bash
> pacifista execute docs/plans/<filename>.md -w ./<worktree>
> ```
>
> Or just run `pacifista` for the interactive wizard.
