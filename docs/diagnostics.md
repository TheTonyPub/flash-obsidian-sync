# easy-sync diagnostics

Open **Settings → easy-sync**. The **Last error** field shows the latest failure, including its underlying cause. The plugin writes errors to the Obsidian developer console with the `[flash-sync]` prefix even when debug logging is off.

Turn on **Debug logging** in the same settings panel to see connection, reconciliation, and outbox events. Open Obsidian's developer tools and filter the console by `[flash-sync]`. Turn the switch off after collecting the needed events. A rebuild or restart is not required to change the log level.

Structured events contain bucket names, stage names, and operation counts or types. They omit passwords, secret keys, file contents, and full NATS connection options. URL credentials and query parameters in error messages are removed. Review logs before sharing them because text returned by external services can vary. Console logs are not stored in the vault.

If synchronization fails, copy the `[flash-sync]` lines around `plugin.connect_failed`, `nats.bucket.status`, `reconcile.failed`, or `outbox.publish_failed`. The `stage` field on `reconcile.failed` identifies the failed step. Also include NATS server errors from the same time interval when available.

Reconciliation events include `discoveryMode`, `initialEntryCount`, `snapshotComplete`, and phase/total durations. A `fallbackReasonClass` is present when the primary snapshot path cannot complete; it contains only a failure stage and broad error class, not an error message. These are debug events and do not include note contents or credentials.

## Compare discovery timings

Run the benchmark only against a disposable NATS test server. It creates a uniquely named bucket, seeds 144 synthetic 1 KiB values by default, measures three rounds of primary snapshot and legacy list discovery over the same data, and destroys the bucket afterward. Output contains counts and timing samples only; it has no speedup threshold.

```sh
NATS_TEST_URL=nats://127.0.0.1:4222 npm run benchmark:kv-discovery
```

Set `KV_BENCHMARK_RECORDS` or `KV_BENCHMARK_RUNS` to adjust the fixture size or number of rounds. This command does not start or configure a NATS server.
