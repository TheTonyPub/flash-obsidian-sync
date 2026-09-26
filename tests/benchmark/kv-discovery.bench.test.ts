import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import { NatsKvAdapter } from "../../packages/plugin/src/connection.js";

const serverUrl = process.env.NATS_TEST_URL;
const recordCount = Number(process.env.KV_BENCHMARK_RECORDS ?? 144);
const rounds = Number(process.env.KV_BENCHMARK_RUNS ?? 3);
const valueBytes = 1024;

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  return Math.round(ordered[Math.floor(ordered.length / 2)] * 100) / 100;
}

describe.skipIf(!serverUrl)("KV discovery benchmark", () => {
  it("compares snapshot and legacy list discovery over one seeded vault", async () => {
    if (!Number.isInteger(recordCount) || recordCount < 1) throw new Error("KV_BENCHMARK_RECORDS must be a positive integer");
    if (!Number.isInteger(rounds) || rounds < 1) throw new Error("KV_BENCHMARK_RUNS must be a positive integer");

    const admin = await connect({ servers: serverUrl!, maxReconnectAttempts: 0 });
    let client: Awaited<ReturnType<typeof connect>> | undefined;
    const bucketName = `OBS_BENCH_${randomUUID().replaceAll("-", "").slice(0, 12)}_FILES`;
    let bucket: Awaited<ReturnType<Kvm["create"]>> | undefined;
    try {
      client = await connect({ servers: serverUrl!, maxReconnectAttempts: 0 });
      bucket = await new Kvm(admin).create(bucketName, { history: 10 });
      const adapter = new NatsKvAdapter(bucket, client, 0, undefined, bucketName);
      const payload = new TextEncoder().encode("x".repeat(valueBytes));
      for (let index = 0; index < recordCount; index++) {
        await bucket.put(`f.benchmark-${String(index).padStart(4, "0")}`, payload);
      }

      const primarySamples: number[] = [];
      const legacySamples: number[] = [];
      for (let round = 0; round < rounds; round++) {
        const runPrimary = async (): Promise<void> => {
          const startedAt = performance.now();
          const session = await adapter.openSnapshotSession();
          let count = 0;
          try {
            for await (const _entry of session.snapshot) count++;
            await session.snapshotComplete;
          } finally {
            await session.stop();
          }
          expect(count).toBe(recordCount);
          primarySamples.push(Math.round((performance.now() - startedAt) * 100) / 100);
        };
        const runLegacy = async (): Promise<void> => {
          const startedAt = performance.now();
          const entries = (await adapter.list()).filter((entry) => entry.key.startsWith("f."));
          expect(entries).toHaveLength(recordCount);
          legacySamples.push(Math.round((performance.now() - startedAt) * 100) / 100);
        };
        if (round % 2 === 0) { await runPrimary(); await runLegacy(); }
        else { await runLegacy(); await runPrimary(); }
      }

      console.info("[kv-discovery-benchmark]", JSON.stringify({
        records: recordCount,
        valueBytes,
        rounds,
        primarySnapshotMs: { samples: primarySamples, median: median(primarySamples) },
        legacyListMs: { samples: legacySamples, median: median(legacySamples) },
      }));
    } finally {
      await bucket?.destroy().catch(() => false);
      await client?.close();
      await admin.close();
    }
  }, 120_000);
});
