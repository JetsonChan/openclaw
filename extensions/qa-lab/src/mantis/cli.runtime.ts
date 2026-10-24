import {
  runMantisDesktopBrowserSmoke,
  type MantisDesktopBrowserSmokeOptions,
} from "./desktop-browser-smoke.runtime.js";
import {
  runMantisVisualDriver,
  runMantisVisualTask,
  type MantisVisualDriverOptions,
  type MantisVisualTaskOptions,
} from "./visual-task.runtime.js";

function reportMantisArtifacts(
  label: string,
  result: {
    status: "pass" | "fail";
    reportPath: string;
    summaryPath: string;
    screenshotPath?: string;
    videoPath?: string;
  },
) {
  process.stdout.write(`${label} report: ${result.reportPath}\n`);
  process.stdout.write(`${label} summary: ${result.summaryPath}\n`);
  if (result.screenshotPath) {
    process.stdout.write(`${label} screenshot: ${result.screenshotPath}\n`);
  }
  if (result.videoPath) {
    process.stdout.write(`${label} video: ${result.videoPath}\n`);
  }
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runMantisDesktopBrowserSmokeCommand(opts: MantisDesktopBrowserSmokeOptions) {
  reportMantisArtifacts("Mantis desktop browser", await runMantisDesktopBrowserSmoke(opts));
}

export async function runMantisVisualDriverCommand(opts: MantisVisualDriverOptions) {
  const result = await runMantisVisualDriver(opts);
  process.stdout.write(`Mantis visual driver result: ${result.status}\n`);
  process.stdout.write(`Mantis visual driver screenshot: ${result.screenshotPath}\n`);
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runMantisVisualTaskCommand(opts: MantisVisualTaskOptions) {
  reportMantisArtifacts("Mantis visual task", await runMantisVisualTask(opts));
}
