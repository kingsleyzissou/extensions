# pi-extensions

A mono-repo of [pi](https://pi.dev) extensions.

## Extensions

| Extension                                      | Description                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| [`@kingsleyzissou/quorum`](extensions/quorum/) | Ensemble PR review — spawns specialized reviewers in parallel and synthesizes feedback |

## Development

```bash
bun install
bun test
bun run typecheck
```

## Installing an extension

```bash
# From local path (for development)
pi install ./extensions/quorum

# Or test without installing
pi -e ./extensions/quorum
```
