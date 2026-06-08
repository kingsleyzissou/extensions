# pi-extensions

A mono-repo of [pi](https://pi.dev) extensions.

## Extensions

| Extension                                            | Description                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`@kingsleyzissou/pacifista`](extensions/pacifista/) | Plan executor — runs markdown plans task-by-task with configurable checks and user gates |
| [`@kingsleyzissou/quorum`](extensions/quorum/)       | Ensemble PR review — spawns specialized reviewers in parallel and synthesizes feedback   |
| [`@kingsleyzissou/sandbox`](extensions/sandbox/)     | Container sandbox — isolates agent tool operations inside Podman containers              |

## Apps

| App                       | Description                                                                    |
| ------------------------- | ------------------------------------------------------------------------------ |
| [`kuma`](apps/pacifista/) | CLI + TUI for pacifista — interactive wizard, progress spinner, approval gates |

## Usage

```bash
# Run a plan
kuma execute docs/plans/my-plan.md -w ./my-worktree

# Or launch the interactive wizard
kuma

# Resume a paused run
kuma resume

# Check status
kuma status
```

## Configuration

Create `.kuma/config.js` in your project (or bare repo root):

```js
export default {
  checks: [
    { name: 'typecheck', command: 'bun run types' },
    { name: 'lint', command: 'bun run lint' },
    { name: 'tests', command: 'bun test', scope: 'final' },
  ],

  hooks: {
    beforeRun: async ctx => {
      await ctx.exec('bun install');
    },
  },

  prompt: {
    preamble: 'You are working in a Bun monorepo...',
    rules: ['Colocate tests next to source files'],
  },

  gate: {
    autoApprove: false,
  },
};
```

## Development

```bash
bun install
bun test
bun run typecheck
```

## Installing an extension

```bash
# From local path (for development)
pi install ./extensions/pacifista

# Or test without installing
pi -e ./extensions/pacifista
```
