// Plugin SDK runtime API guardrail tests cover runtime API export safety and boundaries.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import { afterAll, describe, expect, it } from "vitest";
import { createNativeTypeScriptParser } from "../../../scripts/lib/native-typescript.mts";
import { contractPluginPath, getBundledPluginRoots } from "./test-helpers/bundled-plugin-roots.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function runtimeApiPluginFile(pluginId: string): string {
  return contractPluginPath({ rootDir: ROOT_DIR, pluginId, relativePath: "runtime-api.ts" });
}

const UNGUARDED_RUNTIME_API_PLUGIN_IDS = [
  "a2a",
  "acpx",
  "browser",
  "canvas",
  "cloudflare",
  "copilot-proxy",
  "google",
  "lmstudio",
  "memory-core",
  "ollama",
  "qa-channel",
  "qa-lab",
  "tokenjuice",
  "workboard",
  "zai",
] as const;

const RUNTIME_API_EXPORT_GUARDS: Record<string, readonly string[]> = {
  [contractPluginPath({ rootDir: ROOT_DIR, pluginId: "facetime", relativePath: "runtime-api.ts" })]:
    ['export { createFaceTimeRuntime, type FaceTimeRuntime } from "./src/runtime.js";'],
  [contractPluginPath({
    rootDir: ROOT_DIR,
    pluginId: "diagnostics-otel",
    relativePath: "runtime-api.ts",
  })]: [
    'export { createDiagnosticsOtelService } from "./src/service.js";',
    'export type { OpenClawPluginServiceContext } from "./api.js";',
  ],
  [contractPluginPath({ rootDir: ROOT_DIR, pluginId: "imessage", relativePath: "runtime-api.ts" })]:
    [
      'export { imessageMessageActions } from "./src/actions.js";',
      'export { setIMessageRuntime } from "./src/runtime.js";',
    ],

} as const;

function collectRuntimeApiFiles(): string[] {
  return [...getBundledPluginRoots().entries()]
    .filter(([, rootDir]) => existsSync(resolve(rootDir, "runtime-api.ts")))
    .map(([pluginId]) =>
      contractPluginPath({
        rootDir: ROOT_DIR,
        pluginId,
        relativePath: "runtime-api.ts",
      }),
    );
}

const parser = createNativeTypeScriptParser();
afterAll(() => parser.close());

function readExportStatements(path: string): string[] {
  const sourceText = readFileSync(resolve(ROOT_DIR, "..", path), "utf8");
  const sourceFile = parser.parseSourceFile(path, sourceText);

  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement)) {
      const isExported = statement.forEachChild((child) =>
        child.kind === ts.SyntaxKind.ExportKeyword ? true : undefined,
      );
      if (!isExported) {
        return [];
      }
      return [statement.getText(sourceFile).replaceAll(/\s+/g, " ").trim()];
    }

    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
      return [statement.getText(sourceFile).replaceAll(/\s+/g, " ").trim()];
    }

    if (!statement.exportClause) {
      const prefix = statement.isTypeOnly ? "export type *" : "export *";
      return [`${prefix} from ${moduleSpecifier.getText(sourceFile)};`];
    }

    if (!ts.isNamedExports(statement.exportClause)) {
      return [statement.getText(sourceFile).replaceAll(/\s+/g, " ").trim()];
    }

    const specifiers = statement.exportClause.elements.map((element) => {
      const imported = element.propertyName?.text;
      const exported = element.name.text;
      const alias = imported ? `${imported} as ${exported}` : exported;
      return element.isTypeOnly ? `type ${alias}` : alias;
    });
    const exportPrefix = statement.isTypeOnly ? "export type" : "export";
    return [
      `${exportPrefix} { ${specifiers.join(", ")} } from ${moduleSpecifier.getText(sourceFile)};`,
    ];
  });
}

describe("runtime api guardrails", () => {
  it("keeps runtime api surfaces classified and guarded exports pinned", () => {
    const runtimeApiFiles = collectRuntimeApiFiles();
    const expectedRuntimeApiFiles = [
      ...Object.keys(RUNTIME_API_EXPORT_GUARDS),
      ...UNGUARDED_RUNTIME_API_PLUGIN_IDS.map(runtimeApiPluginFile),
    ].toSorted();
    expect(runtimeApiFiles.toSorted()).toEqual(expectedRuntimeApiFiles);

    for (const file of Object.keys(RUNTIME_API_EXPORT_GUARDS).toSorted()) {
      expect(readExportStatements(file), `${file} runtime api exports changed`).toEqual(
        RUNTIME_API_EXPORT_GUARDS[file],
      );
    }
  });

  it("keeps bundled runtime api barrels off their own branded sdk facades", () => {
    for (const [pluginId, rootDir] of getBundledPluginRoots().entries()) {
      const path = resolve(rootDir, "runtime-api.ts");
      if (!existsSync(path)) {
        continue;
      }
      const source = readFileSync(path, "utf8");
      expect(
        source,
        `${pluginId} runtime api should use generic sdk subpaths or local exports`,
      ).not.toContain(`"openclaw/plugin-sdk/${pluginId}"`);
      expect(
        source,
        `${pluginId} runtime api should use generic sdk subpaths or local exports`,
      ).not.toContain(`'openclaw/plugin-sdk/${pluginId}'`);
    }
  });

  it("keeps QA runner registration on narrow plugin facades", () => {
    const qaRunnerApiFiles: string[] = [];

    for (const [pluginId, rootDir] of getBundledPluginRoots().entries()) {
      const runtimeApiPath = resolve(rootDir, "runtime-api.ts");
      if (existsSync(runtimeApiPath)) {
        expect(
          readFileSync(runtimeApiPath, "utf8"),
          `${pluginId} runtime api must not own QA discovery`,
        ).not.toContain("qaRunnerCliRegistrations");
      }

      const qaRunnerApiPath = resolve(rootDir, "qa-runner-api.ts");
      if (existsSync(qaRunnerApiPath)) {
        qaRunnerApiFiles.push(qaRunnerApiPath);
      }
    }

    for (const file of qaRunnerApiFiles) {
      const exports = readExportStatements(file);
      expect(exports).toHaveLength(1);
      expect(exports[0]).toMatch(/^export const qaRunnerCliRegistrations = \[/u);
    }
  });

  it("keeps the composed hook-runner registry internal", () => {
    const pluginRuntime = readFileSync(resolve(ROOT_DIR, "plugin-sdk/plugin-runtime.ts"), "utf8");
    const hookRunnerGlobal = readFileSync(
      resolve(ROOT_DIR, "plugins/hook-runner-global.ts"),
      "utf8",
    );
    const hookRegistryTypes = readFileSync(
      resolve(ROOT_DIR, "plugins/hook-registry.types.ts"),
      "utf8",
    );

    expect(pluginRuntime).toContain(
      'export { getGlobalHookRunner } from "../plugins/hook-runner-global.js";',
    );
    expect(hookRunnerGlobal).not.toContain("getGlobalHookRunnerRegistry");
    expect(hookRegistryTypes).not.toContain("trustedToolPolicies");
  });

});
