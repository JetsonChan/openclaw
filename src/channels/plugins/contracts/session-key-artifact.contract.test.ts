// Retained-channel session-key artifact inventory.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getBundledChannelSessionKeyArtifactAsync,
  listBundledChannelPluginIds,
} from "./test-helpers/bundled-channel-plugin-loader.js";

describe("bundled channel session-key artifact parity", () => {
  const artifacts = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    for (const id of listBundledChannelPluginIds()) {
      const artifact = await getBundledChannelSessionKeyArtifactAsync(id);
      if (artifact) {
        artifacts.set(id, artifact);
      }
    }
  });

  it("keeps the artifact table in sync with bundled channels that ship one", () => {
    // Retained channels do not ship this retired-channel artifact.
    expect([...artifacts.keys()].toSorted()).toEqual([]);
  });
});
