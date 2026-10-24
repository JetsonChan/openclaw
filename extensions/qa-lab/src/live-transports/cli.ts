import { listQaRunnerCliContributions } from "openclaw/plugin-sdk/qa-runner-runtime";
import type { LiveTransportQaCliRegistration } from "./shared/live-transport-cli.js";

function createQaRunnerCliRegistration(
  runner: ReturnType<typeof listQaRunnerCliContributions>[number],
): LiveTransportQaCliRegistration {
  if (runner.status === "available") {
    return runner.registration;
  }
  return {
    commandName: runner.commandName,
    register(qa) {
      qa.command(runner.commandName)
        .description(runner.description ?? `Run the ${runner.commandName} live QA lane`)
        .action(() => {
          throw new Error(
            `QA runner "${runner.commandName}" is installed but not active. Enable or allow plugin "${runner.pluginId}" in your OpenClaw config, then try again.`,
          );
        });
    },
  };
}

export function listLiveTransportQaCliRegistrations(): readonly LiveTransportQaCliRegistration[] {
  return listQaRunnerCliContributions().map(createQaRunnerCliRegistration);
}

export function listLiveTransportQaAdapterFactories() {
  return listLiveTransportQaCliRegistrations().flatMap((registration) =>
    registration.adapterFactory ? [registration.adapterFactory] : [],
  );
}
