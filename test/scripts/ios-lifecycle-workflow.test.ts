import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveIosSimulatorTestSelection } from "../../scripts/lib/ci-ios-smoke-plan.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("iOS simulator owner selection", () => {
  it.each([
    ["apps/ios/Sources/Voice/TalkModeManager.swift", true, true],
    ["apps/ios/Sources/Onboarding/OnboardingWizardView.swift", true, true],
    ["apps/ios/Sources/FutureFeature/NewService.swift", true, true],
    ["apps/ios/WatchApp/Sources/WatchInboxView.swift", true, false],
    ["apps/ios/ActivityWidget/OpenClawLiveActivity.swift", true, false],
    ["apps/ios/Tests/TalkModeConfigParsingTests.swift", true, false],
    ["apps/ios/Tests/Fixtures/managed-document-message.json", true, false],
    ["apps/ios/Tests/CloudflareAccessTestTokens.swift", false, true],
    ["apps/ios/Tests/CloudflareAccessBrowserPresenterTests.swift", false, true],
    ["apps/ios/Tests/GatewayIngressActivationTests.swift", false, true],
    ["apps/ios/Tests/GatewayIngressWireTests.swift", false, true],
    ["apps/ios/Tests/GatewayIngressLoginPreparationTests.swift", false, true],
    ["apps/ios/Tests/GatewayOperatorFleetTests.swift", false, true],
    ["scripts/ios-access-restart-proof.py", false, true],
    ["apps/ios/Tests/GatewayAccessRestartTests.swift", false, true],
    ["apps/ios/Tests/IOSMediaArtifactLoaderTests.swift", true, true],
    ["apps/ios/Tests/OpenClawTypographyTests.swift", true, true],
    ["apps/ios/Tests/ChatSendHydrationTests.swift", false, true],
    ["apps/ios/Tests/RootTabsNavigationTests.swift", false, false],
    ["apps/shared/OpenClawKit/Tests/OpenClawKitTests/ChatViewModelTests.swift", false, false],
    ["apps/shared/OpenClawKit/Sources/OpenClawNativeState/NativeState.swift", true, true],
    ["apps/macos/Tests/OpenClawIPCTests/GatewayWebSocketTestSupport.swift", true, true],
    ["apps/macos/Tests/OpenClawIPCTests/DashboardHTTPFixture.swift", true, true],
    ["apps/macos/Tests/OpenClawIPCTests/AsyncTestGate.swift", true, true],
    ["apps/macos/Tests/OpenClawIPCTests/TestWait.swift", true, true],
    ["apps/swabble/Sources/SwabbleKit/Speech.swift", true, true],
    ["apps/swabble/Sources/swabble/main.swift", false, false],
    ["apps/ios/fastlane/Fastfile", false, false],
    ...[
      "apps/ios/project.yml",
      "apps/ios/Config/Signing.xcconfig",
      "apps/ios/Sources/Fonts/Inter[opsz,wght].ttf",
      "apps/ios/Tests/Info.plist",
      "apps/shared/OpenClawKit/Package.swift",
      "apps/swabble/Package.resolved",
      "apps/shared/OpenClawKit/Sources/OpenClawChatUI/Resources/Mermaid/index.html",
      "scripts/lib/swift-toolchain.sh",
      "scripts/ios-simulator-prepare.sh",
      "scripts/ios-generate-test-tls-identity.sh",
      "scripts/ci-xcodebuild.py",
      "scripts/lib/ci-ios-smoke-plan.mjs",
      ".github/workflows/ci.yml",
      "pnpm-lock.yaml",
    ].map((file) => [file, true, true] as const),
  ] as const)(
    "selects the actual runtime, test, and resource owners for %s",
    (file, voice, lifecycle) => {
      const selected = resolveIosSimulatorTestSelection([file]);
      expect(selected.voice.selected).toBe(voice);
      expect(selected.lifecycle.selected).toBe(lifecycle);
      for (const group of [selected.voice, selected.lifecycle]) {
        expect(group.reasons.some((reason: string) => reason.includes(file))).toBe(group.selected);
      }
    },
  );

  it.each([
    { changedPaths: null, enabled: true },
    { changedPaths: ["../apps/ios/Tests/ChatTypingFocusTests.swift"], enabled: true },
    { changedPaths: ["/unknown"], enabled: true },
    { changedPaths: ["invalid\npath"], enabled: true },
    { changedPaths: null, enabled: false },
  ])("falls back to full coverage only for admitted jobs: %j", ({ changedPaths, enabled }) => {
    const selected = resolveIosSimulatorTestSelection(changedPaths, {
      enabled,
      forceFull: !enabled,
    });
    expect(selected.mode).toBe(enabled ? "full" : "not-selected");
    expect(selected.voice.selected).toBe(enabled);
    expect(selected.lifecycle.selected).toBe(enabled);
  });
});

function runRestartProof(mode = "ready", format = 1) {
  const root = tempDirs.make("openclaw-access-restart-");
  const result = spawnSync(
    "python3",
    [
      "-B",
      "-c",
      String.raw`
import contextlib, datetime, importlib.util, io, json, os, pathlib, plistlib, subprocess, sys
helper, root, mode, format = sys.argv[1:]
format = int(format)
root = pathlib.Path(root)
os.chdir(root)
spec = importlib.util.spec_from_file_location("restart_proof", helper)
proof = importlib.util.module_from_spec(spec)
spec.loader.exec_module(proof)
products = root / "Build Products"
app = products / "Debug-iphonesimulator/OpenClaw.app"
tests = app / "PlugIns/OpenClawTests.xctest"
data = root / "app data"
data.mkdir()
for bundle, identifier in [(app, "test.openclaw.app"), (tests, "test.openclaw.tests")]:
    bundle.mkdir(parents=True, exist_ok=True)
    (bundle / "fixture").write_bytes(b"unchanged executable")
    (bundle / "Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "fixture", "CFBundleIdentifier": identifier}))
target = {"BlueprintName": "OpenClawTests", "TestHostPath": "__TESTROOT__/Debug-iphonesimulator/OpenClaw.app",
     "TestBundlePath": "__TESTHOST__/PlugIns/OpenClawTests.xctest", "UITargetAppPath": "unused",
     "OnlyTestIdentifiers": ["OldSelection"], "SkipTestIdentifiers": ["AnotherSelection"],
     "TestingEnvironmentVariables": {"DYLD_FRAMEWORK_PATH": "__TESTROOT__/Debug-iphonesimulator"}}
document = {"OpenClawTests": target, "OpenClawLogicTests": {"BlueprintName": "OpenClawLogicTests"}}
if format == 2:
    document = {"TestConfigurations": [{"Name": "Default", "IsEnabled": True, "TestTargets": [
        {"BlueprintName": "OpenClawLogicTests"}, target]}]}
if format != 0:
    document["__xctestrun_metadata__"] = {"FormatVersion": format}
(products / "OpenClaw_iphonesimulator.xctestrun").write_bytes(plistlib.dumps(document))
commands, runs, boot_timeouts = [], [], []
booted = True
receipt = None
source = "a" * 40
def run(args, capture=False, env=None, timeout=None):
    global booted, receipt
    commands.append(args)
    if args[0] == "git":
        return source
    if "-showBuildSettings" in args:
        return json.dumps([{"target": "OpenClaw", "buildSettings": {
            "BUILD_DIR": str(products), "TARGET_BUILD_DIR": str(app.parent), "FULL_PRODUCT_NAME": app.name}}])
    if "test-without-building" in args:
        booted = mode == "already-booted"
        config = plistlib.loads(pathlib.Path(args[args.index("-xctestrun") + 1]).read_bytes())
        runs.append({"config": config, "environment": {key: value for key, value in env.items()
            if key.startswith("TEST_RUNNER_OPENCLAW_ACCESS_RESTART_")}})
        nonce = env["TEST_RUNNER_OPENCLAW_ACCESS_RESTART_NONCE"]
        receipt = data / "Library/Application Support" / ("access-restart-" + nonce + ".plist")
        if mode != "missing-handoff":
            receipt.parent.mkdir(parents=True)
            handoff = {"phase": "verified", "nonce": nonce, "source": source, "simulator": "simulator-fixture",
                "installation": proof.installation_identity(app, tests, data), "seedPID": 2147483647,
                "verifyPID": 2147483646, "seedProcessExited": True,
                "expiresAt": datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None) + datetime.timedelta(hours=1)}
            if mode == "seed-only": handoff["phase"] = "seeded"
            if mode == "same-pid": handoff["verifyPID"] = handoff["seedPID"]
            if mode == "unconfirmed-exit": handoff["seedProcessExited"] = False
            if mode == "wrong-source": handoff["source"] = "b" * 40
            if mode == "wrong-nonce": handoff["nonce"] = "foreign"
            if mode == "wrong-receipt-device": handoff["simulator"] = "another-device"
            if mode == "expired-control": handoff["expiresAt"] = datetime.datetime(2000, 1, 1)
            if mode == "changed-container": handoff["installation"]["container"]["inode"] += 1
            receipt.write_bytes(plistlib.dumps(handoff))
        if mode == "changed-binary": (app / "fixture").write_bytes(b"replacement executable")
        if mode == "changed-test-binary": (tests / "fixture").write_bytes(b"replacement test executable")
        if mode == "reinstalled-same-bytes":
            executable = tests / "fixture"
            replacement = tests / "replacement"
            replacement.write_bytes(executable.read_bytes())
            replacement.replace(executable)
        if mode == "xcodebuild-failed": raise subprocess.CalledProcessError(65, args)
    if "xcresulttool" in args:
        device = {"deviceId": "simulator-fixture", "deviceName": "iPhone"}
        configuration = {"configurationId": "1", "configurationName": "Default"}
        if "summary" in args:
            count = 0 if mode == "zero-tests" else (2 if mode == "execution-count" else 1)
            device_run = {"device": {**device}, "testPlanConfiguration": {**configuration},
                "passedTests": 2, "failedTests": 0, "skippedTests": 0, "expectedFailures": 0}
            if mode == "wrong-summary-device": device_run["device"]["deviceId"] = "foreign"
            if mode == "wrong-summary-configuration": device_run["testPlanConfiguration"]["configurationId"] = "foreign"
            return json.dumps({"result": "Passed", "totalTestCount": count, "passedTests": count,
                "failedTests": 0, "skippedTests": 1 if mode == "skipped" else 0,
                "expectedFailures": 0, "testFailures": [],
                "devicesAndConfigurations": [device_run] * (2 if mode == "extra-summary-device" else 1)})
        identifier = "GatewayAccessRestartTests/testAcknowledgedSignOutSurvivesProcessRestart()"
        repetitions = [{"nodeType": "Repetition", "nodeIdentifier": str(index),
            "name": f"Repetition {index}", "result": "Passed"} for index in (1, 2)]
        if mode == "one-repetition": repetitions.pop()
        if mode == "extra-repetition": repetitions.append({**repetitions[0], "nodeIdentifier": "3", "name": "Repetition 3"})
        if mode == "duplicate-repetition": repetitions[1] = repetitions[0]
        if mode == "missing-repetition-id": repetitions[1].pop("nodeIdentifier")
        if mode == "failed-repetition": repetitions[1]["result"] = "Failed"
        if mode == "skipped-repetition": repetitions[1]["result"] = "Skipped"
        if mode == "unknown-result-shape": repetitions = []
        if mode in ("explicit-case-runs", "extra-case-run"):
            for repetition in repetitions:
                repetition["children"] = [{"nodeType": "Test Case Run", "name": "Execution", "result": "Passed"}]
        if mode == "extra-case-run": repetitions[1]["children"].append(repetitions[1]["children"][0])
        if mode == "unscoped-execution": repetitions.append({"nodeType": "Test Case Run", "name": "Extra", "result": "Passed"})
        if mode == "wrapped-repetition": repetitions = [{"nodeType": "Device", "nodeIdentifier": device["deviceId"],
            "children": [{"nodeType": "Test Plan Configuration", "nodeIdentifier": "1", "children": repetitions}]}]
        if mode == "nested-repetition": repetitions[0]["children"] = [{**repetitions[1]}]
        if "test-details" in args:
            assert args[-2:] == ["--test-id", identifier]
            if mode == "wrong-device": device["deviceId"] = "another-device"
            if mode == "wrong-configuration": configuration["configurationId"] = "foreign"
            return json.dumps({"testIdentifier": "WrongCase" if mode == "wrong-details-case" else identifier,
                "testResult": "Passed", "arguments": ["unexpected"] if mode == "parameterized-case" else [],
                "devices": [device], "testPlanConfigurations": [configuration] * (2 if mode == "extra-configuration" else 1),
                "testRuns": repetitions})
        identifier = "WrongCase" if mode == "wrong-case" else identifier
        if mode == "tree-repetition-mismatch": repetitions[1]["nodeIdentifier"] = "foreign"
        case = {"nodeType": "Test Case", "nodeIdentifier": identifier, "result": "Passed", "children": repetitions}
        bundle = {"nodeType": "Unit test bundle", "name": "WrongBundle" if mode == "wrong-bundle" else "OpenClawTests",
            "children": [{"nodeType": "Test Suite", "name": "GatewayAccessRestartTests",
                "children": [case] * (2 if mode == "extra-case" else 1)}]}
        if mode == "wrong-tree-device": device["deviceId"] = "foreign"
        if mode == "wrong-tree-configuration": configuration["configurationId"] = "foreign"
        return json.dumps({"testNodes": [{"nodeType": "Test Plan", "name": "OpenClaw", "children": [bundle]}],
            "devices": [device], "testPlanConfigurations": [configuration]})
    if "bootstatus" in args:
        assert args == ["xcrun", "simctl", "bootstatus", "simulator-fixture", "-b"]
        boot_timeouts.append(timeout)
        if mode == "boot-failed": raise RuntimeError("simulator boot failed")
        booted = True
    if "get_app_container" in args:
        if not booted:
            raise RuntimeError("Unable to lookup in current state: Shutdown")
        return str(app if args[-1] == "app" else data)
    return ""
proof.run = run
proof.process_exists = lambda pid: mode == "live-seed"
error = None
with contextlib.redirect_stdout(io.StringIO()):
    try:
        proof.main("simulator-fixture")
    except Exception as failure:
        error = str(failure)
print(json.dumps({"error": error, "commands": commands, "runs": runs, "bootTimeouts": boot_timeouts,
    "receiptRetained": receipt is not None and receipt.exists()}))
`,
      path.resolve("scripts/ios-access-restart-proof.py"),
      root,
      mode,
      String(format),
    ],
    { encoding: "utf8", timeout: 5_000 },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as {
    error: string | null;
    commands: string[][];
    bootTimeouts: number[];
    receiptRetained: boolean;
    runs: {
      environment: Record<string, string>;
      config: {
        OpenClawTests?: Record<string, unknown>;
        OpenClawLogicTests?: Record<string, unknown>;
        TestConfigurations?: { TestTargets: Record<string, unknown>[] }[];
        __xctestrun_metadata__?: { FormatVersion: number };
      };
    }[];
  };
}

describe("iOS Access process restart proof", () => {
  it.each([0, 1, 2])("preserves format %s for two fixed process repetitions", (format) => {
    const { error, commands, runs, bootTimeouts, receiptRetained } = runRestartProof(
      "ready",
      format,
    );
    expect(error).toBeNull();
    expect(runs).toHaveLength(1);
    expect(bootTimeouts).toEqual([120]);
    expect(receiptRetained).toBe(false);
    const { config, environment } = runs[0]!;
    expect(config["__xctestrun_metadata__"]?.FormatVersion).toBe(format || undefined);
    expect(config).not.toHaveProperty("OpenClawLogicTests");
    const targets =
      format === 2 ? config.TestConfigurations![0]!.TestTargets : [config.OpenClawTests!];
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      BlueprintName: "OpenClawTests",
      TestHostPath: "__TESTROOT__/Debug-iphonesimulator/OpenClaw.app",
      TestBundlePath: "__TESTHOST__/PlugIns/OpenClawTests.xctest",
      UITargetAppPath: "unused",
      TestingEnvironmentVariables: { DYLD_FRAMEWORK_PATH: "__TESTROOT__/Debug-iphonesimulator" },
    });
    for (const key of ["OnlyTestIdentifiers", "SkipTestIdentifiers", "UseDestinationArtifacts"]) {
      expect(targets[0]).not.toHaveProperty(key);
    }
    expect(environment.TEST_RUNNER_OPENCLAW_ACCESS_RESTART_DEVICE).toBe("simulator-fixture");
    expect(environment).not.toHaveProperty("TEST_RUNNER_OPENCLAW_ACCESS_RESTART_PHASE");
    const invocations = commands.filter((args) => args.includes("test-without-building"));
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toEqual(
      expect.arrayContaining([
        "-test-iterations",
        "2",
        "-test-repetition-relaunch-enabled",
        "YES",
        "-parallel-testing-enabled",
        "NO",
        "platform=iOS Simulator,id=simulator-fixture",
        "-only-testing:OpenClawTests/GatewayAccessRestartTests/testAcknowledgedSignOutSurvivesProcessRestart",
      ]),
    );
    expect(commands.filter((args) => args.includes("build-for-testing"))).toHaveLength(1);
    for (const operation of [
      "install",
      "uninstall",
      "erase",
      "terminate",
      "-retry-tests-on-failure",
      "-run-tests-until-failure",
    ]) {
      expect(commands.some((args) => args.includes(operation))).toBe(false);
    }
  });

  it.each(["already-booted", "execution-count"])(
    "accepts %s with two explicit passing repetitions and a verified handoff",
    (mode) => {
      const { error, bootTimeouts, receiptRetained } = runRestartProof(mode);
      expect(error).toBeNull();
      expect(bootTimeouts).toEqual([120]);
      expect(receiptRetained).toBe(false);
    },
  );

  it("rejects xcodebuild failure even when the result records and final receipt would pass", () => {
    const { error, commands, receiptRetained } = runRestartProof("xcodebuild-failed");
    expect(error).toContain("exit status 65");
    expect(commands.some((args) => args.includes("xcresulttool"))).toBe(false);
    expect(commands.some((args) => args.includes("get_app_container"))).toBe(false);
    expect(receiptRetained).toBe(true);
  });

  it("stops before container inspection if readiness fails", () => {
    const { error, commands, receiptRetained } = runRestartProof("boot-failed");
    expect(error).toBe("simulator boot failed");
    expect(commands.at(-1)).toEqual(["xcrun", "simctl", "bootstatus", "simulator-fixture", "-b"]);
    expect(receiptRetained).toBe(true);
  });

  it("rejects an unknown generated format before a test process starts", () => {
    const { error, runs } = runRestartProof("ready", 3);
    expect(error).toBe("Unsupported generated test run format");
    expect(runs).toEqual([]);
  });

  it.each([
    "zero-tests",
    "skipped",
    "wrong-case",
    "extra-case",
    "wrong-device",
    "extra-configuration",
    "wrong-details-case",
    "parameterized-case",
    "wrong-bundle",
    "wrong-summary-device",
    "wrong-summary-configuration",
    "extra-summary-device",
    "wrong-tree-device",
    "wrong-tree-configuration",
    "wrong-configuration",
    "one-repetition",
    "extra-repetition",
    "duplicate-repetition",
    "failed-repetition",
    "skipped-repetition",
    "unknown-result-shape",
    "extra-case-run",
    "unscoped-execution",
    "explicit-case-runs",
    "nested-repetition",
    "missing-repetition-id",
    "tree-repetition-mismatch",
    "wrapped-repetition",
    "missing-handoff",
    "seed-only",
    "same-pid",
    "live-seed",
    "unconfirmed-exit",
    "wrong-source",
    "wrong-nonce",
    "wrong-receipt-device",
    "expired-control",
    "changed-container",
    "changed-binary",
    "changed-test-binary",
    "reinstalled-same-bytes",
  ])("rejects %s without claiming restart proof", (mode) => {
    const { error, runs, receiptRetained } = runRestartProof(mode);
    expect(error).toBeTruthy();
    expect(runs).toHaveLength(1);
    expect(receiptRetained).toBe(mode !== "missing-handoff");
  });
});
