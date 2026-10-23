// Registry contract tests cover the retained channel session-binding surface.
import { describe, expect, it } from "vitest";
import { sessionBindingContractChannelIds } from "./test-helpers/manifest.js";

describe("channel contract registry", () => {
  it("keeps session binding coverage aligned with the retained iMessage adapter", () => {
    expect(sessionBindingContractChannelIds).toEqual(["imessage"]);
  });
});
