# easy-sync diagnostics

Open **Settings → easy-sync**. The **Last error** field shows the latest failure, including its underlying cause. The plugin writes errors to the Obsidian developer console with the `[easy-sync]` prefix even when debug logging is off.

Turn on **Debug logging** in the same settings panel to see connection, reconciliation, and outbox events. Open Obsidian's developer tools and filter the console by `[easy-sync]`. Turn the switch off after collecting the needed events. A rebuild or restart is not required to change the log level.

Structured events contain bucket names, stage names, and operation counts or types. They omit passwords, secret keys, file contents, and full NATS connection options. URL credentials and query parameters in error messages are removed. Review logs before sharing them because text returned by external services can vary. Console logs are not stored in the vault.

If synchronization fails, copy the `[easy-sync]` lines around `plugin.connect_failed`, `nats.bucket.status`, `reconcile.failed`, or `outbox.publish_failed`. The `stage` field on `reconcile.failed` identifies the failed step. Also include NATS server errors from the same time interval when available.
