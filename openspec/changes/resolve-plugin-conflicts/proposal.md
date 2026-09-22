## Why

The plugin preserves conflicting versions, but its settings only open the copies. After a user merges the content, there is no supported way to mark a conflict resolved; the persisted conflict record keeps `CONFLICT` visible across restarts.

## What Changes

- Add a per-conflict **Resolve** action beside **Open copy**, with a clear confirmation that the user has reviewed the original and copy.
- Mark only the selected conflict record resolved and refresh status; never discard either note or its pending work as a side effect.
- Keep the conflict copy available until the user explicitly handles it; do not silently delete or overwrite note content.
- Cover persistence across restart and multiple independent conflicts, including resolving one copy without clearing the others.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `conflict-resolution`: Add user-confirmed resolution of a preserved conflict copy and accurate unresolved-conflict status.

## Impact

Plugin settings UI, local conflict records, status calculation, and tests. No server deployment, NATS configuration, or automatic content deletion. Exit condition: after a user safely merges one copy and selects **Resolve**, that conflict disappears from the list and stays resolved after restart while other conflicts remain.
