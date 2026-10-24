import { describe, expect, it } from "vitest";
import { detectChangedScope, shouldRunNativeI18n } from "../../scripts/ci-changed-scope.mjs";
import { isNativeGeneratedOnlyChange } from "../../scripts/lib/ci-native-generated-scope.mjs";

describe("native protocol generation scope", () => {
  it.each(["packages/gateway-protocol/src/schema/frames.ts", "scripts/protocol-gen-swift.ts"])(
    "builds native consumers when only %s changes",
    (file) => {
      expect(detectChangedScope([file])).toMatchObject({
        runMacos: true,
        runIosBuild: true,
        runAndroid: true,
      });
    },
  );
});

describe("generated native locale scope", () => {
  it.each<{ paths: string[] | null; generated: boolean }>([
    { paths: ["apps/.i18n/native/de.json"], generated: true },
    { paths: ["apps/ios/Resources/Localizable.xcstrings"], generated: true },
    {
      paths: [
        "apps/android/app/src/main/res/values-de/strings.xml",
        "apps/android/app/src/main/res/values/strings.xml",
      ],
      generated: true,
    },
    { paths: null, generated: false },
    { paths: [], generated: false },
    { paths: ["apps/android/app/src/main/res/values/strings.xml"], generated: false },
    { paths: ["apps/.i18n/native/de.json", "apps/ios/Sources/Example.swift"], generated: false },
  ])(
    "classifies generated-only diffs and retains their verifier ($paths)",
    ({ paths, generated }) => {
      expect(isNativeGeneratedOnlyChange(paths)).toBe(generated);
      if (generated && paths) {
        expect(shouldRunNativeI18n(paths)).toBe(true);
        const scope = detectChangedScope(paths);
        expect(scope.runNode || scope.runIosBuild || scope.runAndroid).toBe(true);
      }
    },
  );
});
