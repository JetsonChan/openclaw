// Retained-channel gateway-auth artifact inventory.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getBundledChannelGatewayAuthArtifactAsync,
  listBundledChannelPluginIds,
} from "./test-helpers/bundled-channel-plugin-loader.js";

describe("bundled channel gateway-auth artifact parity", () => {
  const artifactResolvers = new Map<string, unknown>();

  beforeAll(async () => {
    for (const id of listBundledChannelPluginIds()) {
      const artifact = await getBundledChannelGatewayAuthArtifactAsync(id);
      if (artifact) {
        artifactResolvers.set(id, artifact.resolveGatewayAuthBypassPaths);
      }
    }
  });

  it("keeps the artifact table in sync with bundled channels that ship one", () => {
    // Retained channels do not ship this retired-channel artifact.
    expect([...artifactResolvers.keys()].toSorted()).toEqual([]);
  });
});
