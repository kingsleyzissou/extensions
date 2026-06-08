---
name: commit-message
description: Commit message conventions used by pacifista when creating task commits. Use when reviewing commit messages, suggesting improvements, or helping write new commit messages.
---

# Commit Messages

This project uses component-prefixed commit messages. Do not use semantic
commit prefixes (feat, fix, chore, etc.).

## Format

```
Component: short description

Optional body explaining why, not what.
```

## Subject Line

- **Prefix with the component or area**, followed by a colon and space
- Use sentence case after the prefix (lowercase unless proper noun)
- Keep under 72 characters
- Use imperative mood ("add", "fix", "remove", not "added", "fixes", "removed")

### Picking Prefixes

Use the component, module, or area of the codebase that the change
primarily touches. Examples:

| Prefix       | Use for                                   |
| ------------ | ----------------------------------------- |
| `tests:`     | Unit test changes                         |
| `e2e:`       | End-to-end test changes                   |
| `api:`       | API code or endpoints                     |
| `ci:`        | CI/CD workflows                           |
| `deps:`      | Dependency updates (manual)               |
| `devDeps:`   | Dev dependency updates (manual)           |
| `src:`       | Cross-cutting changes across multiple areas |

For dependency bumps from bots (Dependabot, Renovate), the bot format is
acceptable as-is.

## Body

- Explain **why** the change was made, not what (the diff shows what)
- Wrap at 72 characters
- Leave a blank line between subject and body
- **Do not repeat the subject line** in the body

### Good body examples

```
store: add derived selectors for FS customizations

We were doing a lot of computation in frontend components to get this
information. Moving it to memoized selectors simplifies the UI code.
```

### Bad body examples

```
Wizard: add misc formats to ImageOverview section

Add miscellaneous formats to the ImageOverview card.
```

^ Body just repeats the subject. Either remove the body or explain why.

## When to Skip the Body

Skip the body for self-explanatory changes:

- `Button: add disabled state`
- `tests: remove legacy integration test`
- `deps: bump lodash from 4.17.23 to 4.18.1`

## Common Mistakes

| Mistake                     | Fix                                      |
| --------------------------- | ---------------------------------------- |
| `feat(wizard): add feature` | `Wizard: add feature`                    |
| `fix: broken button`        | `Button: fix broken button`              |
| `chore(deps): update X`     | `deps: update X`                         |
| `Added new component`       | `Component: add new component` (imperative) |
| Body repeats subject        | Remove body or expand with reasoning     |

## Agentic Workflows

When commits are authored as part of an agentic workflow, add a
`Co-authored-by` trailer to attribute AI collaboration. Use the
**full model name** and email:

```
Co-authored-by: <Model Full Name> <email-address>
```

For example:

```
Wizard: add TimezoneSelector component skeleton

Scaffold the component file and export so subsequent commits can
build on a working baseline.

Co-authored-by: Claude Opus 4.6 <noreply@anthropic.com>
```

The trailer goes after the body, separated by a blank line. If there is
no body, place it directly after the subject with one blank line.

## Reviewing Commits

When reviewing commit messages, check for:

1. Component prefix present and appropriate
2. Imperative mood in subject
3. Subject under 72 characters
4. Body explains why (if present)
5. No typos in subject or body
6. Body doesn't just repeat the subject
7. `Co-authored-by` trailer with full model name present for agentic workflow commits
