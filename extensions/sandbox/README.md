# pi-container-sandbox

Personal pi extension that runs `read`, `write`, `edit`, `bash`, and `user_bash` in Apple Containers on macOS and Podman on Linux.

## Requirements

- macOS 26 or later on Apple silicon, Apple Container CLI (`container`), and services started with `container system start`
- Linux with Podman available to the current user

Both runtimes run the same Linux sandbox image; Apple Containers runs it in a lightweight VM.

- One persistent container per bare repo by default; the bare root and child worktrees are mounted read-write at `/workspace`.
- Each Pi session starts in its active worktree; `/sandbox worktree [name]` lists or switches worktrees without restarting the container.
- Non-bare projects get a persistent container keyed by their working directory.
- The agent runs as the non-root `pi` user, with all Linux capabilities dropped.
- No host `$HOME`, SSH keys, cloud credentials, browser state, or container socket are mounted.
- Size tiers enforce CPU and memory limits on both runtimes; Podman also enforces PID, swap, and disk limits.

Apple Containers does not expose controls equivalent to `no-new-privileges`, PID limits, swap limits, or disk limits. With `--no-container-net`, Podman uses a fully disconnected network; Apple Containers uses a host-only network without NAT, which is not fully disconnected.

## Quick start

```bash
# macOS only; Linux does not need this
container system start
```

Then on macOS or Linux:

```bash
bun install
bun run build
pi -e ./index.ts
```

## Commands

All UI commands live under `/sandbox`:

```text
/sandbox                 Show status
/sandbox status          Show container, image, digest, and update info
/sandbox worktree        List worktrees; add a name to switch active worktree
/sandbox doctor          Verify core tools in the running container
/sandbox update          Pull configured image; restart pi to use it
/sandbox config          Show .pi/agent/sandbox.json
/sandbox pin <tag>       Pin this project to an image tag
/sandbox unpin           Follow latest again
/sandbox allow <path>    Session-allow external host read path
/sandbox paths           List persisted external path approvals
/sandbox paths revoke <path>
```

No `/sandbox-*` aliases are registered.

## Image version/update flow

Default image: `pi-sandbox:latest`.

Per-project config lives at `.pi/agent/sandbox.json`:

```json
{
  "image": "pi-sandbox",
  "tag": "latest",
  "pinned": false,
  "lastDigest": null,
  "lastCheckedAt": null,
  "git": {
    "user": {
      "name": "Your Name",
      "email": "you@example.com"
    }
  }
}
```

The `git` field is optional. When set, the sandbox configures
`git config --global user.name` and `user.email` inside the container
so commits are authored correctly. If omitted, it auto-detects these values
from the host's Git config.

```text
/sandbox status
/sandbox update
/sandbox pin v1.2.3
/sandbox unpin
```

After `/sandbox update`, an existing persistent container continues using its original image. To use the new image, remove the container shown by `/sandbox status` (`container stop <name>` then `container delete <name>` on macOS, or `podman rm -f <name>` on Linux), then start Pi again.

## Flags

| Flag                                         | Purpose                                                              |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `--no-container`, `--noc`                    | Disable sandboxing                                                   |
| `--container-size xs\|sm\|md\|lg\|xlg\|xxlg` | Resource tier (`md` default); Podman also limits PID, swap, and disk |
| `--sandbox-name <name>`                      | Override repo-scoped container name                                  |
| `--sandbox-persist`                          | Force persistence if config opts out (on by default)                 |
| `--sandbox-cache <volume>`                   | Mount a volume at `/cache`                                           |
| `--container-image <ref>`                    | Override image reference                                             |
| `--no-container-net`                         | Podman: disconnected; Apple Containers: host-only without NAT        |
| `--container-keep`                           | Keep a non-persistent container after exit                           |
| `--container-allow-paths <paths>`            | Session read-path allowlist                                          |
| `--container-memory <limit>`                 | Override tier memory                                                 |
| `--container-cpus <count>`                   | Override tier CPU allocation                                         |
| `--container-pids-limit <n>`                 | Podman process limit (default 512; unsupported on macOS)             |
| `--container-swap <limit>`                   | Podman swap limit; unsupported on macOS                              |

## Image contents

Fedora 44 minimal (`registry.fedoraproject.org/fedora-minimal:44`) with common agent tools:

- shell/core: `bash`, coreutils, `git`, `curl`, `jq`, `ripgrep`, `fd`, `bat`, `eza`, `yq`, `ast-grep`
- runtimes: `bun`, `node`, `npm`, `uv`, Python 3.13
- browser: `chromium`

Run `/sandbox doctor` after image changes. It checks that the important binaries execute and prints `ldd` for `node`.

## Build

```bash
bun run build

# Directly on macOS:
container build -t pi-sandbox:latest -f containers/Containerfile containers

# Directly on Linux:
podman build -t pi-sandbox:latest -f containers/Containerfile containers
```

Most CLI tools (`bat`, `fd`, `eza`, `ripgrep`, `yq`, `jq`) are installed directly from Fedora repos via `dnf5`. Only ast-grep, uv, bun, and Node.js are downloaded with SHA256 verification. The Containerfile smoke-tests `node --version` and `npm --version` during build so missing shared libraries fail the build, not your session.

## Acknowledgements

This extension is adapted from [pi-container-sandbox](https://github.com/TheGreatAxios/pi-extensions/tree/main/pi-container-sandbox) by [Sawyer Cutler](https://github.com/TheGreatAxios) to use Apple Containers on macOS and Podman on Linux.
