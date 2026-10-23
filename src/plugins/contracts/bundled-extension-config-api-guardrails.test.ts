// Bundled extension config API guardrail tests cover config API usage in bundled extensions.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(SRC_ROOT, "..");

const BUNDLED_EXTENSION_CONFIG_IMPORT_GUARDS = [
  {
    path: "extensions/imessage/src/config-schema.ts",
    allowedSpecifier: "openclaw/plugin-sdk/channel-config-schema",
    forbiddenSpecifier: "openclaw/plugin-sdk/bundled-channel-config-schema",
  },
] as const;

describe("bundled extension config api guardrails", () => {
  for (const entry of BUNDLED_EXTENSION_CONFIG_IMPORT_GUARDS) {
    it(`keeps ${entry.path} on its owned config-schema seam`, () => {
      const source = readFileSync(resolve(REPO_ROOT, entry.path), "utf8");
      expect(source).toContain(entry.allowedSpecifier);
      expect(source).not.toContain(entry.forbiddenSpecifier);
    });
  }
});
