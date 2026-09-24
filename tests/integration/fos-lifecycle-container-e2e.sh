#!/usr/bin/env bash
set -euo pipefail

if [[ "${FOS_LIFECYCLE_CONTAINER_E2E:-}" != "1" ]]; then
  echo "Set FOS_LIFECYCLE_CONTAINER_E2E=1 to run disposable-container CLI lifecycle checks." >&2
  exit 2
fi

target="${FOS_E2E_SSH_TARGET:-root@83.217.194.115}"
key="${FOS_E2E_SSH_KEY:-$HOME/.ssh/tw}"
image="docker.io/library/node:22-alpine@sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34"
bundle="$(mktemp -d "${TMPDIR:-/tmp}/fos-lifecycle-e2e.XXXXXX")"
container_name="fos-lifecycle-e2e-$$"
trap 'rm -rf -- "$bundle"' EXIT
chmod 700 "$bundle"
cp packages/server-cli/dist/main.js "$bundle/main.js"
cp packages/server-cli/dist/admin-worker.js "$bundle/admin-worker.js"
cp tests/integration/fos-lifecycle-container.mjs "$bundle/lifecycle-e2e.mjs"

remote_command="set -eu
podman run --rm --pull=never --network=none --security-opt=no-new-privileges --cap-drop=ALL --name $container_name -i --entrypoint sh $image -eu -c '
  mkdir -p /tmp/fos-lifecycle-e2e
  tar -xzf - -C /tmp/fos-lifecycle-e2e
  cd /tmp/fos-lifecycle-e2e
  node --version
  node lifecycle-e2e.mjs
'
if podman container exists $container_name; then
  echo 'disposable lifecycle container remained after exit' >&2
  exit 1
fi"

tar -C "$bundle" -czf - . | rtk proxy ssh -i "$key" "$target" "$remote_command"
