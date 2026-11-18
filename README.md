# pi-extensions

A mono-repo of [pi](https://pi.dev) extensions.

## Extensions

| Extension                                        | Description                                                    |
| ------------------------------------------------ | -------------------------------------------------------------- |
| [`@kingsleyzissou/sandbox`](extensions/sandbox/) | Container sandbox — Apple Containers on macOS, Podman on Linux |

## Code review

Use OpenCodeReview's `ocr` command (`ocr review`) for code reviews.

## Development

```bash
bun install
bun test
bun run typecheck
```

## Installing an extension

```bash
# From local path (for development)
pi install ./extensions/sandbox

# Or test without installing
pi -e ./extensions/sandbox
```
