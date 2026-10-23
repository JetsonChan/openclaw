/**
 * Session binding contract registry fixtures.
 *
 * Builds bundled channel binding contract entries and hermetic plugin-state stores.
 */
import { expect } from "vitest";
import type { OpenClawConfig } from "../../../../config/config.js";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "../../../../infra/outbound/session-binding-service.js";
import type { SessionBindingCapabilities } from "../../../../infra/outbound/session-binding.types.js";
import { setActivePluginRegistry } from "../../../../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../../../test-utils/channel-plugins.js";
import { getChannelPlugin } from "../../registry.js";
import type { ChannelPlugin } from "../../types.public.js";
import {
  sessionBindingContractChannelIds,
  type SessionBindingContractChannelId,
} from "./manifest.js";
import { importBundledChannelContractArtifact } from "./runtime-artifacts.js";

type SessionBindingContractEntry = {
  id: string;
  expectedCapabilities: SessionBindingCapabilities;
  getCapabilities: () => SessionBindingCapabilities | Promise<SessionBindingCapabilities>;
  bindAndResolve: () => Promise<SessionBindingRecord>;
  unbindAndVerify: (binding: SessionBindingRecord) => Promise<void>;
  cleanup: () => Promise<void> | void;
  preload?: () => Promise<void> | void;
  beforeEach?: () => Promise<void> | void;
};
const contractApiPromises = new Map<string, Promise<Record<string, unknown>>>();

async function createContractChannelConversationBindingManager(params: {
  channelId: Parameters<typeof getChannelPlugin>[0];
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<{ stop: () => void | Promise<void> } | null> {
  const createManager = getChannelPlugin(params.channelId)?.conversationBindings?.createManager;
  return createManager
    ? await createManager({ cfg: params.cfg, accountId: params.accountId })
    : null;
}

async function getContractApi<T extends Record<string, unknown>>(
  pluginId: string,
  artifact = "session-binding-contract-api",
): Promise<T> {
  const cacheKey = `${pluginId}:${artifact}`;
  const existing = contractApiPromises.get(cacheKey);
  if (existing) {
    return (await existing) as T;
  }
  const next = importBundledChannelContractArtifact<T>(pluginId, artifact);
  contractApiPromises.set(cacheKey, next);
  return await next;
}

function expectResolvedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
  metadata?: Record<string, unknown>;
}) {
  expect(
    getSessionBindingService().resolveByConversation({
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
    }),
  )?.toMatchObject({
    targetSessionKey: params.targetSessionKey,
    ...(params.metadata ? { metadata: params.metadata } : {}),
  });
}

async function unbindAndExpectClearedSessionBinding(binding: SessionBindingRecord) {
  const service = getSessionBindingService();
  const removed = await service.unbind({
    bindingId: binding.bindingId,
    reason: "contract-test",
  });
  expect(removed.map((entry) => entry.bindingId)).toContain(binding.bindingId);
  expect(service.resolveByConversation(binding.conversation)).toBeNull();
}

function expectClearedSessionBinding(params: {
  channel: string;
  accountId: string;
  conversationId: string;
}) {
  expect(
    getSessionBindingService().resolveByConversation({
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
    }),
  ).toBeNull();
}

const baseSessionBindingCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

type ChannelConversationBindingManagerFactory = NonNullable<
  NonNullable<ChannelPlugin["conversationBindings"]>["createManager"]
>;
type ChannelConversationBindingManager = Awaited<
  ReturnType<ChannelConversationBindingManagerFactory>
>;
let imessageSessionBindingManager: ChannelConversationBindingManager | null = null;

type IMessageContractApi = {
  imessagePlugin: ChannelPlugin;
};

async function getIMessageContractApi() {
  return await getContractApi<IMessageContractApi>("imessage", "channel-plugin-api");
}

async function stopIMessageSessionBindingManager() {
  await imessageSessionBindingManager?.stop();
  imessageSessionBindingManager = null;
}

async function prepareIMessageSessionBindingContract() {
  await stopIMessageSessionBindingManager();
  const { imessagePlugin } = await getIMessageContractApi();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "imessage",
        plugin: imessagePlugin,
        source: "test",
      },
    ]),
  );
}

async function ensureIMessageSessionBindingManager() {
  imessageSessionBindingManager ??= await createContractChannelConversationBindingManager({
    channelId: "imessage",
    cfg: baseSessionBindingCfg,
    accountId: "default",
  });
  if (!imessageSessionBindingManager) {
    throw new Error("iMessage session binding manager is unavailable");
  }
}

type SessionBindingContractFixture = {
  id: SessionBindingContractChannelId;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  targetSessionKey: string;
  expectedBindingId?: string;
  targetKind: SessionBindingRecord["targetKind"];
  label: string;
  metadata?: Record<string, unknown>;
  placements: SessionBindingCapabilities["placements"];
  preload: () => Promise<unknown>;
  beforeEach: () => Promise<void>;
  ensureManager: () => Promise<void>;
  stopManager?: () => Promise<void>;
  restartBindingManager?: () => Promise<void>;
};

function createSessionBindingContractEntry(
  fixture: SessionBindingContractFixture,
): Omit<SessionBindingContractEntry, "id"> {
  const conversation = {
    channel: fixture.id,
    accountId: fixture.accountId,
    conversationId: fixture.conversationId,
    ...(fixture.parentConversationId ? { parentConversationId: fixture.parentConversationId } : {}),
  };

  return {
    preload: async () => {
      await fixture.preload();
    },
    beforeEach: fixture.beforeEach,
    expectedCapabilities: {
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: fixture.placements,
    },
    getCapabilities: async () => {
      await fixture.ensureManager();
      return getSessionBindingService().getCapabilities({
        channel: fixture.id,
        accountId: fixture.accountId,
      });
    },
    bindAndResolve: async () => {
      await fixture.ensureManager();
      const binding = await getSessionBindingService().bind({
        targetSessionKey: fixture.targetSessionKey,
        targetKind: fixture.targetKind,
        conversation,
        placement: "current",
        metadata: { agentId: fixture.id, label: fixture.label, ...fixture.metadata },
      });
      if (fixture.expectedBindingId) {
        expect(binding.bindingId).toBe(fixture.expectedBindingId);
      }
      if (fixture.metadata) {
        expect(binding.metadata).toMatchObject(fixture.metadata);
      }
      expectResolvedSessionBinding({
        ...conversation,
        targetSessionKey: fixture.targetSessionKey,
      });
      if (fixture.restartBindingManager) {
        await fixture.restartBindingManager();
        expectResolvedSessionBinding({
          ...conversation,
          targetSessionKey: fixture.targetSessionKey,
          metadata: fixture.metadata,
        });
      }
      return binding;
    },
    unbindAndVerify: unbindAndExpectClearedSessionBinding,
    cleanup: async () => {
      await fixture.stopManager?.();
      expectClearedSessionBinding(conversation);
    },
  };
}

const sessionBindingContractEntries = {
  imessage: createSessionBindingContractEntry({
    id: "imessage",
    accountId: "default",
    conversationId: "+15555550124",
    targetSessionKey: "agent:imessage:current",
    expectedBindingId: "default:+15555550124",
    targetKind: "session",
    label: "imessage-main",
    metadata: { opaque: { ownerEpoch: 7, capabilities: ["approve", "resume"] } },
    placements: ["current"],
    preload: getIMessageContractApi,
    beforeEach: prepareIMessageSessionBindingContract,
    ensureManager: ensureIMessageSessionBindingManager,
    stopManager: stopIMessageSessionBindingManager,
    restartBindingManager: async () => {
      await stopIMessageSessionBindingManager();
      closeOpenClawStateDatabaseForTest();
      await ensureIMessageSessionBindingManager();
    },
  }),
} satisfies Record<SessionBindingContractChannelId, Omit<SessionBindingContractEntry, "id">>;

let sessionBindingContractRegistryCache: SessionBindingContractEntry[] | undefined;

export function getSessionBindingContractRegistry(): SessionBindingContractEntry[] {
  sessionBindingContractRegistryCache ??= sessionBindingContractChannelIds.map((id) =>
    Object.assign({ id }, sessionBindingContractEntries[id]),
  );
  return sessionBindingContractRegistryCache;
}
