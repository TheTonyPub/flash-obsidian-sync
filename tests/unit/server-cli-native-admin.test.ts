import { describe, expect, it } from "vitest";
import { createNativeVaultAdminAdapter } from "../../packages/server-cli/src/native-admin.js";

describe("fos native NATS administration", () => {
  it("rejects a different administrator secret before opening a native connection", async () => {
    const admin = createNativeVaultAdminAdapter({ username: "fos-admin", password: "secret" });
    await expect(admin.authenticate({ username: "fos-admin", password: "wrong" })).resolves.toBe(false);
  });
});
