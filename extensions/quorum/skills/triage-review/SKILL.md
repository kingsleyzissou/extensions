---
name: triage-review
description: Triage review findings from a code review or PR review. Classifies each finding as implement, defer, or pushback with reasoning. Use when you have review output and need to decide what to actually act on.
scopes: [global]
---

# Triage Review

Take review findings and sort them into what matters now, what can wait,
and what to push back on. Not every review comment deserves a code change.

## Input

The user will provide review findings in one of these forms:

- A review JSON file path (QuorumOutput format from `/review --output`)
- Pasted review text or comments
- A path to a markdown review document

Read the review content, then triage every finding.

## Verdicts

Classify each finding into exactly one category:

### ✅ Implement

The finding is valid, actionable, and worth fixing in this PR.

Implement when:

- It's a genuine bug or correctness issue in the changed code
- It's a security concern introduced by this changeset
- It's a simple fix with clear value (typo, missing null check, wrong type)
- The reviewer is right and the fix is small relative to the risk

### ⏳ Defer

The finding is valid but should not be addressed in this PR.

Defer when:

- The fix would expand the scope of the PR significantly
- It's a pre-existing issue not introduced by this changeset
- It requires design discussion or broader consensus first
- It's a refactor that deserves its own PR with proper test coverage
- The suggestion is good but the current code works and isn't dangerous

### ← Pushback

The finding is incorrect, not applicable, or not worth acting on.

Push back when:

- The reviewer misread the code or missed context
- The suggestion contradicts the project's established patterns
- It's a style preference with no functional impact
- The finding is about unchanged code outside the diff
- The "improvement" adds complexity without meaningful benefit
- It's a nitpick elevated to a blocker
- The reviewer is suggesting a different architecture without
  justifying why the current approach is wrong

## Process

1. **Read** the full review output
2. **For each finding**, assign a verdict with one-sentence reasoning
3. **Be specific** in pushbacks — say *why* the reviewer is wrong,
   not just that they are
4. **Be honest** about deferrals — distinguish "this can wait" from
   "I don't want to do this"
5. **Present the triage** grouped by verdict

## Output Format

Present findings grouped by verdict, with the implement list first
(that's the actionable output).

```markdown
## Implement

1. **[Security] Missing input validation on `parseConfig`** — Reviewer
   is right, user input flows directly into `eval()` without sanitisation.

2. **[Bug] Off-by-one in pagination offset** — The `skip` calculation
   doesn't account for 0-indexed pages. Simple fix.

## Defer

3. **[Perf] Memoize expensive selector chain** — Valid concern but the
   current performance is fine for our data volume. Worth a follow-up
   if we see slowness in production.

4. **[Refactor] Extract shared validation logic** — Good idea but
   would touch 12 files outside this PR. Separate PR.

## Pushback

5. **[Style] Prefer `for...of` over `.forEach()`** — This is a style
   preference. The codebase uses both patterns and `.forEach()` is
   fine here.

6. **[Architecture] Should use event sourcing instead of direct
   mutations** — The reviewer is suggesting a fundamentally different
   architecture. The current approach matches the rest of the codebase
   and the mutation is behind a transaction boundary.
```

## Tone

- Pragmatic, not defensive
- Respect the reviewer's time — acknowledge when they're right
- Be direct in pushbacks — vague disagreement wastes everyone's time
- If you're unsure about a finding, say so and lean toward implement
