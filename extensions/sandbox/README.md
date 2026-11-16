# pi-container-sandbox

Personal pi extension that runs `read`, `write`, `edit`, `bash`, and `user_bash` inside a Podman sandbox.

- One persistent container per bare repo by default; the bare root and all child worktrees are mounted read-write at `/workspace` (the bare root is also mounted at its host path so Git worktree pointers resolve)
- Each Pi session starts in its active worktree; `/sandbox worktree [name]` lists or switches worktrees without restarting the container
- Non-bare projects get a persistent container keyed by their working directory
- Agent runs as non-root `pi` user
- No host `$HOME`, SSH keys, cloud creds, browser state, or container socket
- Resource limits via size tiers
- One command namespace: `/sandbox ...`

## Quick start

```bash
cd pi-container-sandbox
bun install
bun run build
pi -e ./index.ts
```

## Commands

All UI commands live under `/sandbox`:

```text
/sandbox                 Show status
/sandbox status          Show status, image, digest/update info
/sandbox worktree        List worktrees; add a name to switch active worktree
/sandbox doctor          Verify core tools in the running container
/sandbox update          Pull configured sandbox image; restart pi to use it
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
so commits are authored correctly. If omitted, the extension
auto-detects from the host's `git config`.

Use:

```text
/sandbox status   # current container + local/last-seen digest info
/sandbox update   # podman pull configured image
/sandbox pin v1.2.3
/sandbox unpin
```

After `/sandbox update`, an existing persistent container continues using its original image. To use the new image, run `podman rm -f <container-name>` with the name shown by `/sandbox status`, then start Pi again.

## Flags

| Flag                                          | Purpose                                              |
| --------------------------------------------- | ---------------------------------------------------- |
| `--no-container`, `--noc`                     | Disable sandbox                                      |
| `--container-size xs\|sm\|md\|lg\|xlg\|xxlg`  | Resource tier (`sm` default)                         |
| `--sandbox-name <name>`                       | Override repo-scoped container name                  |
| `--sandbox-persist`                           | Force persistence if config opts out (on by default) |
| `--sandbox-cache <volume>`                    | Mount volume at `/cache`                             |
| `--container-image <ref>`                     | Override image ref                                   |
| `--no-container-net`                          | Disable container networking                         |
| `--container-keep`                            | Keep non-persistent container running after exit     |
| `--container-allow-paths <paths>`             | Session read-path allowlist                          |
| `--container-memory` / `--container-cpus`     | Override tier memory/CPU                             |
| `--container-swap` / `--container-pids-limit` | Override tier swap/PID limit                         |

## Image contents

Fedora 44 minimal (`registry.fedoraproject.org/fedora-minimal:44`) with common agent tools:

- shell/core: `bash`, coreutils, `git`, `curl`, `jq`, `ripgrep`, `fd`, `bat`, `eza`, `yq`, `ast-grep`
- runtimes: `bun`, `node`, `npm`, `uv`, Python 3.13
- browser: `chromium`

Run `/sandbox doctor` after image changes. It checks that the important binaries execute and prints `ldd` for `node`.

## Build/publish

```bash
bun run build-image
# or directly:
podman build -t pi-sandbox:latest -f containers/Containerfile containers
```

Most CLI tools (bat, fd, eza, ripgrep, yq, jq) are installed directly from Fedora repos via `dnf5`. Only ast-grep, uv, bun, and Node.js are downloaded from GitHub with SHA256 verification. The Containerfile smoke-tests `node --version` and `npm --version` during build so missing shared libs fail the build, not your session.

## Acknowledgements

This extension is a fork of [pi-container-sandbox](https://github.com/TheGreatAxios/pi-extensions/tree/main/pi-container-sandbox) by [Sawyer Cutler](https://github.com/TheGreatAxios), adapted to use Podman instead of Docker.
