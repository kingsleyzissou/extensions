#!/usr/bin/env bash

set -euo pipefail

case "$(uname -s)" in
  Darwin)
    if ! command -v container >/dev/null 2>&1; then
      echo 'Apple Container CLI is required; install it before building the sandbox image.' >&2
      exit 1
    fi
    container build -t pi-sandbox:latest -f containers/Containerfile containers
    ;;
  Linux)
    if ! command -v podman >/dev/null 2>&1; then
      echo 'Podman is required; install it before building the sandbox image.' >&2
      exit 1
    fi
    podman build -t pi-sandbox:latest -f containers/Containerfile containers
    ;;
  *)
    echo 'Sandbox image builds are supported on macOS (Apple Containers) and Linux (Podman).' >&2
    exit 1
    ;;
esac
