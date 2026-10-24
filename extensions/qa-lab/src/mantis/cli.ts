import type { Command } from "commander";
import type { MantisDesktopBrowserSmokeOptions } from "./desktop-browser-smoke.runtime.js";
import type { MantisVisualDriverOptions, MantisVisualTaskOptions } from "./visual-task.runtime.js";

type MantisDesktopBrowserSmokeCommanderOptions = Omit<
  MantisDesktopBrowserSmokeOptions,
  "commandRunner" | "env" | "now" | "videoDurationSeconds"
> & {
  class?: string;
  videoDuration?: string;
};

type MantisVisualTaskCommanderOptions = Omit<
  MantisVisualTaskOptions,
  "commandRunner" | "env" | "now" | "settleMs" | "visionTimeoutMs"
> & {
  class?: string;
  settleMs?: string;
  visionTimeoutMs?: string;
};

type MantisVisualDriverCommanderOptions = Omit<
  MantisVisualDriverOptions,
  "commandRunner" | "env" | "settleMs" | "visionTimeoutMs"
> & {
  settleMs?: string;
  visionTimeoutMs?: string;
};

function parseOptionalInteger(value: string | undefined, label: string) {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== value || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

export function registerMantisCli(qa: Command) {
  const mantis = qa
    .command("mantis")
    .description("Run Mantis browser and visual verification flows");

  mantis
    .command("desktop-browser-smoke")
    .description(
      "Lease or reuse a Crabbox desktop, open a visible browser, and capture VNC desktop screenshot/video artifacts",
    )
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Mantis desktop browser artifact directory")
    .option("--browser-url <url>", "URL to open in the visible browser")
    .option(
      "--browser-profile-archive-env <name>",
      "Env var containing a base64 .tgz Chrome profile archive to restore before launch",
    )
    .option(
      "--browser-profile-dir <remote-path>",
      "Remote Chrome user-data-dir path to reuse for browser login state",
    )
    .option("--html-file <path>", "Repo-local HTML file to render in the visible browser")
    .option("--crabbox-bin <path>", "Crabbox binary path")
    .option("--provider <provider>", "Crabbox provider")
    .option("--machine-class <class>", "Crabbox machine class")
    .option("--class <class>", "Alias for --machine-class")
    .option("--lease-id <id>", "Reuse an existing Crabbox lease")
    .option("--idle-timeout <duration>", "Crabbox idle timeout")
    .option("--ttl <duration>", "Crabbox maximum lease lifetime")
    .option("--video-duration <seconds>", "Visible desktop recording duration in seconds")
    .option("--keep-lease", "Keep a lease created by this run after a passing smoke")
    .action(async (opts: MantisDesktopBrowserSmokeCommanderOptions) => {
      const { class: machineClassAlias, videoDuration, ...options } = opts;
      const videoDurationSeconds = parseOptionalInteger(videoDuration, "--video-duration");
      const runtime = await import("./cli.runtime.js");
      await runtime.runMantisDesktopBrowserSmokeCommand({
        ...options,
        machineClass: options.machineClass ?? machineClassAlias,
        videoDurationSeconds,
      });
    });

  mantis
    .command("visual-task")
    .description(
      "Lease or reuse a Crabbox desktop, drive visible browser UI, record MP4, screenshot it, and optionally run image-understanding assertions",
    )
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Mantis visual-task artifact directory")
    .option("--crabbox-bin <path>", "Crabbox binary path")
    .option("--provider <provider>", "Crabbox provider")
    .option("--machine-class <class>", "Crabbox machine class")
    .option("--class <class>", "Alias for --machine-class")
    .option("--lease-id <id>", "Reuse an existing Crabbox lease")
    .option("--idle-timeout <duration>", "Crabbox idle timeout")
    .option("--ttl <duration>", "Crabbox maximum lease lifetime")
    .option("--keep-lease", "Keep a lease created by this run after a passing task")
    .option("--browser-url <url>", "URL to open in the visible browser")
    .option("--duration <duration>", "Desktop recording duration")
    .option("--settle-ms <ms>", "Milliseconds to wait after launch before screenshot")
    .option("--vision-mode <mode>", "Vision mode: image-describe or metadata")
    .option("--vision-prompt <text>", "Prompt for image understanding")
    .option("--vision-model <provider/model>", "Image-capable provider/model ref")
    .option("--vision-timeout-ms <ms>", "Image understanding timeout in milliseconds")
    .option("--expect-text <text>", "Case-insensitive text expected in the vision output")
    .action(async (opts: MantisVisualTaskCommanderOptions) => {
      const { class: machineClassAlias, ...options } = opts;
      const settleMs = parseOptionalInteger(opts.settleMs, "--settle-ms");
      const visionTimeoutMs = parseOptionalInteger(opts.visionTimeoutMs, "--vision-timeout-ms");
      const runtime = await import("./cli.runtime.js");
      await runtime.runMantisVisualTaskCommand({
        ...options,
        machineClass: options.machineClass ?? machineClassAlias,
        settleMs,
        visionTimeoutMs,
      });
    });

  mantis
    .command("visual-driver")
    .description(
      "Driver half for Mantis visual-task; launched by Crabbox record --while, then opens browser, screenshots, and runs vision",
    )
    .option("--repo-root <path>", "Repository root to target when running from a neutral cwd")
    .option("--output-dir <path>", "Mantis visual-task artifact directory")
    .option("--crabbox-bin <path>", "Crabbox binary path")
    .option("--provider <provider>", "Crabbox provider")
    .option("--lease-id <id>", "Crabbox lease id")
    .option("--browser-url <url>", "URL to open in the visible browser")
    .option("--settle-ms <ms>", "Milliseconds to wait after launch before screenshot")
    .option("--vision-mode <mode>", "Vision mode: image-describe or metadata")
    .option("--vision-prompt <text>", "Prompt for image understanding")
    .option("--vision-model <provider/model>", "Image-capable provider/model ref")
    .option("--vision-timeout-ms <ms>", "Image understanding timeout in milliseconds")
    .option("--expect-text <text>", "Case-insensitive text expected in the vision output")
    .action(async (opts: MantisVisualDriverCommanderOptions) => {
      const settleMs = parseOptionalInteger(opts.settleMs, "--settle-ms");
      const visionTimeoutMs = parseOptionalInteger(opts.visionTimeoutMs, "--vision-timeout-ms");
      const runtime = await import("./cli.runtime.js");
      await runtime.runMantisVisualDriverCommand({ ...opts, settleMs, visionTimeoutMs });
    });
}
