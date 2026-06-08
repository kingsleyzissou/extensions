# pi-container-sandbox

Personal pi extension that runs `read`, `write`, `edit`, `bash`, and `user_bash` inside a Podman sandbox.

- Host project cwd is mounted read-write at `/workspace`
- Agent runs as non-root `pi` user
- No host `$HOME`, SSH keys, cloud creds, browser state, or container socket
- Resource limits via size tiers
- Optional reusable named containers
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

After `/sandbox update`, restart pi. Existing containers keep using the old image.

## Flags

| Flag                                                                                   | Purpose                                        |
| -------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `--no-container`, `--noc`                                                              | Disable sandbox                                |
| `--container-size xs\|sm\|md\|lg\|xlg\|xxlg`                                           | Resource tier (`sm` default)                   |
| `--sandbox-name <name>`                                                                | Reattach/reuse named container                 |
| `--sandbox-persist`                                                                    | Keep reusable container running after pi exits |
| `--sandbox-cache <volume>`                                                             | Mount volume at `/cache`                       |
| `--container-image <ref>`                                                              | Override image ref                             |
| `--no-container-net`                                                                   | Disable container networking                   |
| `--container-keep`                                                                     | Keep one-off container after exit              |
| `--container-allow-paths <paths>`                                                      | Comma-separated session read allowlist         |
| `--container-memory`, `--container-cpus`, `--container-swap`, `--container-pids-limit` | Override tier resources                        |

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
