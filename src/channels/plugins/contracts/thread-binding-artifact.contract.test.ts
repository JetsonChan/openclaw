// Retained-channel thread-binding artifact inventory.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getBundledChannelThreadBindingArtifactAsync,
  listBundledChannelPluginIds,
} from "./test-helpers/bundled-channel-plugin-loader.js";

describe("bundled channel thread-binding artifact parity", () => {
  const artifactPlacements = new Map<string, unknown>();

  beforeAll(async () => {
    for (const id of listBundledChannelPluginIds()) {
      const artifact = await getBundledChannelThreadBindingArtifactAsync(id);
      if (artifact) {
        artifactPlacements.set(id, artifact.defaultTopLevelPlacement);
      }
    }
  });

  it("keeps the artifact table in sync with bundled channels that ship one", () => {
    // Retained channels do not ship this retired-channel artifact.
    expect([...artifactPlacements.keys()].toSorted()).toEqual([]);
  });
});
