/**
 * Immutable Docker Hub manifest-list digests, verified for the linux/amd64
 * platform on 2026-09-22. The source URLs are retained for re-verification.
 */
export const imageLock = {
  caddy: {
    tag: "2.11.4",
    digest: "sha256:df7f1c2fb114453b951de51a98efc010db1655a92c2e86be6706714e2417a78d",
    source: "https://hub.docker.com/layers/library/caddy/2.11.4/images/sha256-51c1b116f8f4f6fda9de99f516961a77fa8500d30de0c00b65600d2be4ff82e7",
  },
  nats: {
    tag: "2.15.0",
    digest: "sha256:c0d27f3054601a99055aa5ec897b0a55bf1869ae50f454e659acfbbea11d2ab7",
    source: "https://hub.docker.com/layers/library/nats/2.15.0-linux/images/sha256-fdae708d900cb150ce13f203359719bdd9cefd3dbbbc32a4c6224b23ea3e0b2c",
  },
  natsBox: {
    tag: "0.19.7",
    digest: "sha256:ffce8bd103383f179f8c7f11cf645726acf5d17280706c530c3b342dbe16334c",
    source: "https://hub.docker.com/r/natsio/nats-box/tags",
  },
  nodeAdmin: {
    tag: "22.22.0-alpine",
    digest: "sha256:e4bf2a82ad0a4037d28035ae71529873c069b13eb0455466ae0bc13363826e34",
    source: "https://hub.docker.com/_/node",
  },
} as const;
