import { afterEach, expect, it, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { NewSessionRouteData } from "./location.ts";
import "./new-session-page-entry.ts";

const detailImport = vi.hoisted(() => ({
  started: false,
  ready: Promise.withResolvers<void>(),
}));
vi.mock("../chat/components/chat-detail-panel.tsx", async (importOriginal) => {
  detailImport.started = true;
  await detailImport.ready.promise;
  return importOriginal();
});

type NewSessionElement = HTMLElement & {
  data: NewSessionRouteData;
  updateComplete: Promise<boolean>;
};

function routeData(agentId: string): NewSessionRouteData {
  return {
    agentId,
    requestedAgentId: agentId,
    catalogId: "",
    catalogLabel: "",
    startTerminal: false,
  };
}

async function pasteAttachment(page: HTMLElement, text: string) {
  const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message")!;
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", {
    value: { items: [], getData: () => text },
  });
  textarea.dispatchEvent(paste);
  expect(paste.defaultPrevented).toBe(true);
  await waitForSolid(() =>
    expect(
      page.querySelector("openclaw-chat-pasted-text .chat-attachment-file__open"),
    ).not.toBeNull(),
  );
  page.querySelector<HTMLElement>("openclaw-chat-pasted-text .chat-attachment-file__open")!.click();
}

afterEach(async () => {
  detailImport.ready.resolve();
  document.querySelectorAll("openclaw-new-session-page").forEach((element) => element.remove());
  await vi.dynamicImportSettled();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

it("keeps the draft usable during a cold preview and retires the preview before its import settles", async () => {
  const page = document.createElement("openclaw-new-session-page") as NewSessionElement;
  page.data = routeData("research");
  document.body.append(page);
  await page.updateComplete;
  expect(detailImport.started).toBe(false);
  const original = "# Original pasted content\n  preserve indentation 漢字 😀\n".repeat(50);
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>().mockImplementation(async () => new Response(original)),
  );
  await pasteAttachment(page, original);
  await waitForSolid(() => {
    expect(detailImport.started).toBe(true);
    expect(page.querySelector(".new-session-attachment-panel [role='status']")).not.toBeNull();
  });
  const textarea = page.querySelector<HTMLTextAreaElement>(".new-session-page__message")!;
  textarea.value = "Keep typing while the preview loads";
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
  await page.updateComplete;
  expect(page.querySelector(".new-session-page__message")).toBe(textarea);
  expect(textarea.value).toBe("Keep typing while the preview loads");

  window.history.replaceState({}, "", "/new?agent=main");
  page.data = routeData("main");
  await waitForSolid(() => expect(page.querySelector(".new-session-attachment-panel")).toBeNull());
  detailImport.ready.resolve();
  await vi.dynamicImportSettled();
  expect(page.querySelector("openclaw-chat-detail-panel")).toBeNull();

  await pasteAttachment(page, original);
  await waitForSolid(() =>
    expect(page.querySelector("openclaw-chat-detail-panel pre")?.textContent).toBe(original),
  );
});
