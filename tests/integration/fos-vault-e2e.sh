#!/usr/bin/env bash
set -euo pipefail

if [[ "${FOS_VAULT_E2E:-}" != "1" ]]; then
  echo "Set FOS_VAULT_E2E=1 to create and revoke a disposable vault user." >&2
  exit 2
fi

fos_bin="${FOS_BIN:-fos}"
vault_id="e2e_$(date -u +%Y%m%d%H%M%S)_$$"
work="$(mktemp -d /tmp/fos-vault-e2e.XXXXXX)"
chmod 700 "$work"
vault_input="$work/vault-input"
old_vault_input="$work/old-vault-input"
user_exists=0
bucket_created=0

cleanup() {
  if (( user_exists )); then
    if "$fos_bin" vault revoke --vault-id "$vault_id" >/dev/null 2>&1; then
      user_exists=0
    else
      echo "warning: failed to revoke disposable vault user $vault_id" >&2
    fi
  fi
  if (( bucket_created )); then
    echo "disposable test bucket retained for manual cleanup: $vault_id" >&2
  fi
  rm -rf -- "$work"
}
trap cleanup EXIT

"$fos_bin" vault list >"$work/list.json"
"$fos_bin" vault create --vault-id "$vault_id" >"$work/create.json"
bucket_created=1
"$fos_bin" vault list >"$work/list-after-create.json"
"$fos_bin" vault inspect --vault-id "$vault_id" >"$work/inspect.json"

read_vault_password() {
  python3 - "$1" "$vault_input" <<'PY'
from pathlib import Path
import sys

source, target = map(Path, sys.argv[1:])
password = next((line.split(": ", 1)[1] for line in source.read_text().splitlines()
                 if line.startswith("Vault password: ")), None)
if not password:
    raise SystemExit("vault password missing from protected handoff")
target.write_text(password)
target.chmod(0o600)
PY
}

"$fos_bin" vault add --vault-id "$vault_id" --keep --secrets-output "$work/add.handoff"
user_exists=1
read_vault_password "$work/add.handoff"
cp -- "$vault_input" "$old_vault_input"
chmod 600 "$old_vault_input"
"$fos_bin" vault verify --vault-id "$vault_id" --vault-input "$vault_input" >"$work/verify-add.json"
"$fos_bin" vault verify --vault-id "$vault_id" --vault-input "$vault_input" --cross-vault-id test >"$work/verify-cross.json"

"$fos_bin" vault rotate --vault-id "$vault_id" --keep --secrets-output "$work/rotate.handoff"
read_vault_password "$work/rotate.handoff"
"$fos_bin" vault verify --vault-id "$vault_id" --vault-input "$vault_input" >"$work/verify-rotate.json"
if "$fos_bin" vault verify --vault-id "$vault_id" --vault-input "$old_vault_input" >"$work/old-auth.out" 2>&1; then
  echo "rotated vault credential unexpectedly remained valid" >&2
  exit 1
fi
grep -qx "fos: VAULT_AUTH_REQUIRED" "$work/old-auth.out"

"$fos_bin" import --vault-id "$vault_id" --secrets-output "$work/import.handoff"
test -s "$work/import.handoff"
"$fos_bin" vault revoke --vault-id "$vault_id"
user_exists=0

if "$fos_bin" vault verify --vault-id "$vault_id" --vault-input "$vault_input" >"$work/revoked.out" 2>&1; then
  echo "revoked vault credential unexpectedly authenticated" >&2
  exit 1
fi
grep -qx "fos: VAULT_AUTH_REQUIRED" "$work/revoked.out"

python3 - "$vault_id" "$work" <<'PY'
from pathlib import Path
import json
import sys

vault_id, work = sys.argv[1], Path(sys.argv[2])
created = json.loads((work / "create.json").read_text())
listed = json.loads((work / "list-after-create.json").read_text())
inspected = json.loads((work / "inspect.json").read_text())
assert created["created"] and created["bucket"]["vaultId"] == vault_id
assert any(item["vaultId"] == vault_id for item in listed)
assert inspected["vaultId"] == vault_id
for name in ("verify-add.json", "verify-rotate.json"):
    result = json.loads((work / name).read_text())
    assert result["verified"] and result["ownBucket"]
cross = json.loads((work / "verify-cross.json").read_text())
assert cross["verified"] and cross["crossBucket"] == "denied"
assert (work / "import.handoff").stat().st_mode & 0o777 == 0o600
assert isinstance(json.loads((work / "list.json").read_text()), list)
print("fos vault E2E passed: bare list, create, inspect, add, verify, cross-vault denial, rotate, import, revoke, old/revoked-auth denial")
PY
