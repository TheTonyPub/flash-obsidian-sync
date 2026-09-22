import type { HostPlatform } from "./cli.js";

export const nativeCompatibilityLock = {
  cliVersion: "0.1.0",
  platforms: {
    "debian-13-amd64": {
      distribution: "debian",
      release: "13",
      architecture: "amd64",
      packages: [
        { name: "nats-server", version: "2.10.27-1+b2" },
        { name: "caddy", version: "2.6.2-12+deb13u1" },
      ],
    },
    "ubuntu-24.04-amd64": {
      distribution: "ubuntu",
      release: "24.04",
      architecture: "amd64",
      packages: [
        { name: "nats-server", version: "2.10.7-1ubuntu0.3" },
        { name: "caddy", version: "2.6.2-6ubuntu0.24.04.3" },
      ],
    },
    "ubuntu-26.04-amd64": {
      distribution: "ubuntu",
      release: "26.04",
      architecture: "amd64",
      packages: [
        { name: "nats-server", version: "2.10.27-1build1" },
        { name: "caddy", version: "2.6.2-14" },
      ],
    },
  },
} as const;

export type LockedNativePackage = {
  name: "nats-server" | "caddy";
  version: string;
};

export function nativeCompatibilityFor(platform: HostPlatform): readonly LockedNativePackage[] | undefined {
  return Object.values(nativeCompatibilityLock.platforms).find((candidate) => candidate.distribution === platform.distribution
    && candidate.release === platform.release
    && candidate.architecture === platform.architecture)?.packages;
}
