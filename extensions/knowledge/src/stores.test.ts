import { randomUUID } from "node:crypto";
import { readdir, rename, access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import { createKnowledgeService } from "./service.js";
import { StoreRegistry } from "./store-registry.js";
import { storesRevision } from "./stores-config.js";
import { Stores } from "./stores.js";
import {
  hostApi,
  toolContext,
  operatorContext,
  afterTest,
  useTestTempDirs,
  defaultOrder,
} from "./test-support.js";

const tempDirs = useTestTempDirs();

// Every scenario starts from an empty Knowledge state root: stores exist only
// once an agent uses one, exactly as on a fresh install.
async function fixture(options = {}) {
  const base = tempDirs.make("knowledge-stores-");

  const services: any = [];
  const host = hostApi(base, {
    agents: ["main", "research", "ops"],
    policy: { operatorRead: true, writesEnabled: true },
    ...options,
    extra: { registerService: (s: any) => services.push(s) },
  });
  const service = createKnowledgeService(host.api);
  afterTest(() => services.forEach((s: any) => s.stop()));
  const admin = operatorContext(host.api, ["operator.admin"]),
    reader = operatorContext(host.api, ["operator.read"]);
  const as = (agent: any) => toolContext(host.api, agent);
  const save = (agent: any, title: any) =>
    service.save_page(
      { requestId: randomUUID(), title, type: "note", body: `${title} body.` },
      as(agent),
    );
  const titles = async (agent: any) =>
    (await service.records({}, as(agent))).records.map((r) => r.title).toSorted(defaultOrder);
  const snapshot = () => service.stores_snapshot({}, admin);
  const change = async (agent: any, requested: any, expectedRevision: any) => {
    const input = {
      requestId: randomUUID(),
      expectedRevision: expectedRevision ?? (await snapshot()).revision,
      agent,
      change: requested,
    };
    expect(Check(contract.operations.stores_change.input, input)).toBeTruthy();
    const result = await service.stores_change(input, admin);
    expect(
      Check(contract.operations.stores_change.output, result),
      JSON.stringify(result),
    ).toBeTruthy();
    return { input, result };
  };
  const storesDir = () => readdir(path.join(host.stateRoot, "stores")).catch(() => []);
  return { ...host, base, service, admin, reader, as, save, titles, snapshot, change, storesDir };
}
const entry = (snapshot: any, binding: any) =>
  snapshot.stores.find((s: any) => s.binding === binding);

it("two unassigned agents get separate stores on first use and cannot read each other", async () => {
  const f = await fixture();
  await f.save("main", "Main private");
  await f.save("research", "Research private");
  expect(await f.titles("main")).toStrictEqual(["Main private"]);
  expect(await f.titles("research")).toStrictEqual(["Research private"]);
  expect((await f.storesDir()).length).toBe(2);
});

it("passive discovery never creates storage", async () => {
  const f = await fixture();
  const snap = await f.snapshot();
  expect(Check(contract.operations.stores_snapshot.output, snap)).toBeTruthy();
  expect(snap.agents.map((a) => [a.id, a.binding])).toStrictEqual([
    ["main", "agent:main"],
    ["research", "agent:research"],
    ["ops", "agent:ops"],
  ]);
  expect(snap.stores.every((s) => s.state === "unprovisioned")).toBeTruthy();
  const status = await f.service.status({}, f.reader);
  expect(status.store).toBe("unprovisioned");
  expect(
    (
      (await f.service.agent_query(
        { agent: "research", operation: "records", input: {} },
        f.reader,
      )) as any
    ).total,
  ).toBe(0);
  expect(
    (
      (await f.service.agent_query(
        { agent: "research", operation: "status", input: {} },
        f.reader,
      )) as any
    ).store,
  ).toBe("unprovisioned");
  expect(await f.storesDir()).toStrictEqual([]);
});

it("concurrent first uses converge on one store identity", async () => {
  const f = await fixture();
  await Promise.all([f.save("main", "One"), f.save("main", "Two"), f.save("main", "Three")]);
  expect((await f.storesDir()).length).toBe(1);
  expect(await f.titles("main")).toStrictEqual(["One", "Three", "Two"]);
});

it.each([
  ["before any file work", false],
  ["after creating its manifest and database files", true],
])("initialization interrupted %s resumes the same identity", async (_point, filesCreated) => {
  const f = await fixture();
  // Simulate a crash after the reservation committed.
  const reserve = new StoreRegistry(f.stateRoot);
  reserve["tx"](() => {
    reserve["db"]
      .prepare("INSERT INTO stores VALUES (?,?,?,?,'initializing',?)")
      .run(
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
        path.join(f.stateRoot, "stores", "11111111-1111-4111-8111-111111111111", "vault"),
        path.join(f.stateRoot, "stores", "11111111-1111-4111-8111-111111111111", "state.sqlite"),
        new Date().toISOString(),
      );
    reserve["db"]
      .prepare(
        "INSERT INTO bindings(binding,vault_id) VALUES ('agent:main','11111111-1111-4111-8111-111111111111')",
      )
      .run();
  });
  reserve.close();
  if (filesCreated) {
    // Exclusive creates succeeded, then the process died before writing either file.
    const dir = path.join(f.stateRoot, "stores", "11111111-1111-4111-8111-111111111111");
    await mkdir(path.join(dir, "vault", "private"), { recursive: true });
    await writeFile(path.join(dir, "vault", "vault.json"), "");
    await writeFile(path.join(dir, "state.sqlite"), "");
  }
  await f.save("main", "After crash");
  expect(await f.storesDir()).toStrictEqual(["11111111-1111-4111-8111-111111111111"]);
  expect((await f.service.status({}, f.as("main"))).vault).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
});

it("a provisioned store that disappears is unavailable, never recreated empty", async () => {
  const f = await fixture();
  await f.save("main", "Kept");
  const [dir] = await f.storesDir();
  await rename(path.join(f.stateRoot, "stores", dir as any), path.join(f.base, "moved-away"));
  const fresh = createKnowledgeService(f.api);
  await expect(
    fresh.save_page(
      { requestId: randomUUID(), title: "Must not land", type: "note", body: "x" },
      f.as("main"),
    ),
  ).rejects.toThrow(/identity|unavailable/);
  expect(entry(await fresh.stores_snapshot({}, f.admin), "agent:main").state).toBe("unavailable");
  expect(await f.storesDir()).toStrictEqual([]);
});

it("a missing registry beside existing stores requires recovery", async () => {
  const f = await fixture();
  await f.save("main", "Kept");
  await rename(path.join(f.stateRoot, "registry.sqlite"), path.join(f.base, "registry.bak"));
  const fresh = createKnowledgeService(f.api);
  await expect(
    fresh.save_page({ requestId: randomUUID(), title: "x", type: "note", body: "x" }, f.as("main")),
  ).rejects.toThrow(/registry/);
  const snap = await fresh.stores_snapshot({}, f.admin);
  expect(snap.canChange).toBe(false);
  expect(snap.issues[0]).toMatch(/registry/);
});

it("share existing: same identity and records; members read and update through one store", async () => {
  const f = await fixture();
  await f.save("main", "Before sharing");
  const before = await f.service.status({}, f.as("main"));
  const { result } = await (f.change as any)("main", {
    kind: "share_existing",
    label: "Personal",
    agents: ["research"],
  });
  expect(result.outcome, result.message).toBe("applied");
  const shared = entry(result.snapshot, "named:personal");
  expect(shared.members).toStrictEqual(["main", "research"]);
  expect(shared.label).toBe("Personal");
  expect(
    entry(result.snapshot, "agent:main"),
    "the original isolated binding moved to the named store",
  ).toBe(undefined);
  expect((await f.service.status({}, f.as("research"))).vault).toBe(before.vault);
  expect(await f.titles("research")).toStrictEqual(["Before sharing"]);
  await f.save("research", "Research addition");
  expect(await f.titles("main")).toStrictEqual(["Before sharing", "Research addition"]);
  // Writer attribution follows the publishing agent, not the viewer.
  const records = (await f.service.records({}, f.as("main"))).records;
  expect(records.find((r) => r.title === "Research addition")!.writtenByAgentId).toBe("research");
  expect(records.find((r) => r.title === "Before sharing")!.writtenByAgentId).toBe("main");
  // Configuration holds membership; nothing wrote an agent path.
  expect(f.host.config.plugins.entries.knowledge.config.stores).toStrictEqual({
    personal: { label: "Personal", agents: ["main", "research"] },
  });
  expect((await f.storesDir()).length).toBe(1);
});

it("use own after sharing: joiner resumes its old store; originating sharer gets a fresh lazy default", async () => {
  const f = await fixture();
  await f.save("main", "Shared seed");
  await f.save("research", "Research own");
  expect(
    (
      await (f.change as any)("main", {
        kind: "share_existing",
        label: "Team",
        agents: ["research"],
      })
    ).result.outcome,
  ).toBe("applied");
  expect(await f.titles("research")).toStrictEqual(["Shared seed"]);
  const back = await (f.change as any)("research", { kind: "use_own" });
  expect(back.result.outcome, back.result.message).toBe("applied");
  expect(await f.titles("research")).toStrictEqual(["Research own"]);
  const own = await (f.change as any)("main", { kind: "use_own" });
  expect(own.result.outcome).toBe("applied");
  expect(entry(own.result.snapshot, "agent:main").state).toBe("unprovisioned");
  // Zero members: the named store is retained with its data and stays assignable.
  const team = entry(own.result.snapshot, "named:team");
  expect(team.members).toStrictEqual([]);
  expect(team.state).toBe("ready");
  expect(await f.titles("main")).toStrictEqual([]);
  expect(
    (await (f.change as any)("ops", { kind: "use_named", store: "team" })).result.outcome,
  ).toBe("applied");
  expect(await f.titles("ops")).toStrictEqual(["Shared seed"]);
});

it("switching named stores leaves one assignment and the former store untouched", async () => {
  const f = await fixture();
  await f.save("main", "Alpha");
  await f.save("ops", "Beta");
  await (f.change as any)("main", { kind: "share_existing", label: "A", agents: ["research"] });
  const b = await (f.change as any)("ops", {
    kind: "share_existing",
    label: "B",
    agents: ["main"],
  });
  expect(b.result.outcome, b.result.message).toBe("applied");
  const stores = f.host.config.plugins.entries.knowledge.config.stores;
  expect((stores as any).a.agents).toStrictEqual(["research"]);
  expect((stores as any).b.agents).toStrictEqual(["ops", "main"]);
  expect(await f.titles("main")).toStrictEqual(["Beta"]);
  expect(await f.titles("research")).toStrictEqual(["Alpha"]);
});

it("validation, stale revisions and non-admin callers never partially apply", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  const stale = (await f.snapshot()).revision;
  expect(
    (
      await (f.change as any)("research", {
        kind: "share_existing",
        label: "Nope",
        agents: ["main"],
      })
    ).result.outcome,
    "unprovisioned source",
  ).toBe("invalid");
  expect(
    (await (f.change as any)("main", { kind: "use_named", store: "missing" })).result.outcome,
  ).toBe("invalid");
  expect((await (f.change as any)("main", { kind: "use_own" })).result.outcome).toBe("invalid");
  expect(
    (await (f.change as any)("main", { kind: "share_existing", label: "Team", agents: ["ghost"] }))
      .result.outcome,
  ).toBe("invalid");
  expect(
    (
      await (f.change as any)("main", {
        kind: "share_existing",
        label: "Team",
        agents: ["research"],
      })
    ).result.outcome,
  ).toBe("applied");
  expect((await f.change("ops", { kind: "use_named", store: "team" }, stale)).result.outcome).toBe(
    "conflict",
  );
  const denied = await f.service.stores_change(
    {
      requestId: randomUUID(),
      expectedRevision: (await f.snapshot()).revision,
      agent: "ops",
      change: { kind: "use_named", store: "team" },
    },
    operatorContext(f.api, ["operator.write"]),
  );
  expect(denied.outcome).toBe("forbidden");
  expect((await f.service.stores_snapshot({}, f.reader)).canChange).toBe(false);
  await expect(f.service.stores_snapshot({}, f.as("main"))).rejects.toThrow(/operators/);
  expect((Object.keys as any)(f.host.config.plugins.entries.knowledge.config.stores)).toStrictEqual(
    ["team"],
  );
});

it("a concurrent config edit inside the write is a conflict, not an overwrite", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  const original = f.api.runtime.config.mutateConfigFile;
  f.api.runtime.config.mutateConfigFile = async (params) => {
    f.host.config = structuredClone(f.host.config);
    f.host.config.plugins.entries.knowledge.config.stores = { other: { agents: ["ops"] } };
    return original(params);
  };
  const { result } = await (f.change as any)("main", {
    kind: "share_existing",
    label: "Team",
    agents: ["research"],
  });
  expect(result.outcome).toBe("conflict");
  expect(f.host.config.plugins.entries.knowledge.config.stores).toStrictEqual({
    other: { agents: ["ops"] },
  });
});

it("repeated request IDs replay the outcome; reuse for another change is rejected", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  const { input, result } = await (f.change as any)("main", {
    kind: "share_existing",
    label: "Team",
    agents: ["research"],
  });
  expect(result.outcome).toBe("applied");
  expect((await f.service.stores_change(input, f.admin)).outcome).toBe("applied");
  expect(
    (await f.service.stores_change({ ...input, change: { kind: "use_own" } }, f.admin)).outcome,
  ).toBe("invalid");
  expect(
    (await f.service.stores_change_status({ requestId: input.requestId }, f.admin)).outcome,
  ).toBe("applied");
  expect((await f.service.stores_change_status({ requestId: randomUUID() }, f.admin)).outcome).toBe(
    "not-applied",
  );
});

it("a crash between the config write and registry settlement reconciles to one outcome", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  const original = f.api.runtime.config.mutateConfigFile;
  // The write persists, then the process "dies" before the registry settles.
  f.api.runtime.config.mutateConfigFile = async (params) => {
    await original(params);
    throw new Error("process died");
  };
  const { input, result } = await (f.change as any)("main", {
    kind: "share_existing",
    label: "Team",
    agents: ["research"],
  });
  f.api.runtime.config.mutateConfigFile = original;
  expect(result.outcome, "the persisted write is recognized as applied").toBe("applied");
  const restarted = createKnowledgeService(f.api);
  expect(
    (await restarted.stores_change_status({ requestId: input.requestId }, f.admin)).outcome,
  ).toBe("applied");
  expect((await restarted.records({}, f.as("research"))).records.map((r) => r.title)).toStrictEqual(
    ["Seed"],
  );
});

it("a journaled change whose write never landed settles as not applied after restart", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  // Reads (which abort inside mutate) still work; any write fails before persisting.
  f.api.runtime.config.mutateConfigFile = async ({ mutate }) => {
    await mutate(structuredClone(f.host.config) as any, {} as any);
    throw new Error("disk full");
  };
  const { input, result } = await (f.change as any)("main", {
    kind: "share_existing",
    label: "Team",
    agents: ["research"],
  });
  expect(result.outcome, result.message).toBe("not-applied");
  expect(
    (await f.service.stores_change_status({ requestId: input.requestId }, f.admin)).outcome,
  ).toBe("not-applied");
  expect(await f.titles("research")).toStrictEqual([]);
});

it("host publication lag after a save is not mistaken for an external edit", async () => {
  const f = await fixture({ lag: true });
  await f.save("main", "Seed");
  expect(
    (
      await (f.change as any)("main", {
        kind: "share_existing",
        label: "Team",
        agents: ["research"],
      })
    ).result.outcome,
  ).toBe("applied");
  // config.current() still shows the previous section until the host publishes.
  expect(await f.titles("research")).toStrictEqual(["Seed"]);
  f.publish();
  expect(await f.titles("research")).toStrictEqual(["Seed"]);
});

it("external configuration edits apply in-process; invalid membership makes affected agents unavailable", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  await (f.change as any)("main", { kind: "share_existing", label: "Team", agents: ["research"] });
  f.host.config = structuredClone(f.host.config);
  (f.host.config.plugins.entries.knowledge.config.stores as any).team.agents.push("ops");
  expect(await f.titles("ops")).toStrictEqual(["Seed"]);
  f.host.config = structuredClone(f.host.config);
  (f.host.config.plugins.entries.knowledge.config.stores as any).other = { agents: ["ops"] };
  await expect(f.titles("ops")).rejects.toThrow(/assignment is invalid/);
  const snap = await f.snapshot();
  expect(snap.agents.find((a) => a.id === "ops")!.issue).toMatch(/more than one store/);
  expect(await f.titles("main")).toStrictEqual(["Seed"]);
});

it("the cutover fences old-assignment access before applying and after", async () => {
  const f = await fixture();
  await f.save("research", "Research own");
  const stores = new Stores(f.api, { operatorRead: true, writesEnabled: true } as any, () => {});
  afterTest(() => stores.stop());
  const principal = () => ({ agentId: "research", scope: { visibility: "private" } });
  const opened = await stores.open(principal as any, { provision: false });
  expect(opened.kind).toBe("ready");
  (opened as any).access.assertCurrent();
  let fencedDuringApply;
  f.host.config = structuredClone(f.host.config);
  f.host.config.plugins.entries.knowledge.config.stores = { team: { agents: ["research"] } };
  await stores.cutover(["research"], async () => {
    try {
      (opened as any).access.assertCurrent();
      fencedDuringApply = false;
    } catch {
      fencedDuringApply = true;
    }
    await stores.registry.call(
      "reconcile",
      JSON.stringify({ team: { agents: ["research"] } }),
      storesRevision({ team: { agents: ["research"] } }),
    );
  });
  expect(fencedDuringApply, "queued or in-flight work fails while the change applies").toBe(true);
  expect(
    () => (opened as any).access.assertCurrent(),
    "old-assignment access never resumes",
  ).toThrow(/assignment changed/);
  const next = await stores.open(principal as any, { provision: false });
  expect(next.kind, "the new assignment resolves to the named store").toBe("unprovisioned");
});

it("operator proxy is operator-only and validates inner operations", async () => {
  const f = await fixture();
  await f.save("research", "Visible to operator");
  const rows = await f.service.agent_query(
    { agent: "research", operation: "records", input: {} },
    f.reader,
  );
  expect((rows as any).records.map((r: any) => r.title)).toStrictEqual(["Visible to operator"]);
  expect(
    (await f.service.records({}, f.reader)).total,
    "default operator view is the default agent",
  ).toBe(0);
  await expect(
    f.service.agent_query({ agent: "research", operation: "records", input: {} }, f.as("main")),
  ).rejects.toThrow(/operator/);
  await expect(
    f.service.agent_query({ agent: "research", operation: "save_page", input: {} }, f.reader),
  ).rejects.toThrow(/Unknown query/);
  await expect(
    f.service.agent_query({ agent: "research", operation: "stores_snapshot", input: {} }, f.reader),
  ).rejects.toThrow(/Unknown query/);
  await expect(
    f.service.agent_query({ agent: "ghost", operation: "records", input: {} }, f.reader),
  ).rejects.toThrow(/Unknown agent/);
  await expect(
    f.service.agent_query(
      { agent: "research", operation: "records", input: { bogus: 1 } },
      f.reader,
    ),
  ).rejects.toThrow(/Invalid input/);
  await expect(access(path.join(f.stateRoot, "stores", "nothing"))).rejects.toThrow();
});

it("recovery keeps a shared store bound to its data even when other edits conflict", async () => {
  const f = await fixture();
  await f.save("main", "Seed");
  const original = f.api.runtime.config.mutateConfigFile;
  f.api.runtime.config.mutateConfigFile = async (params) => {
    await original(params);
    // Before settlement, someone else edits another part of the stores section.
    f.host.config = structuredClone(f.host.config);
    (f.host.config.plugins.entries.knowledge.config.stores as any).other = { agents: ["ops"] };
    throw new Error("process died");
  };
  const { result } = await (f.change as any)("main", {
    kind: "share_existing",
    label: "Team",
    agents: ["research"],
  });
  f.api.runtime.config.mutateConfigFile = original;
  expect(result.outcome).toBe("conflict");
  expect(
    await (createKnowledgeService(f.api).records({}, f.as("research")) as any).then((r: any) =>
      r.records.map((x: any) => x.title),
    ),
  ).toStrictEqual(["Seed"]);
  expect((await f.storesDir()).length, "no empty replacement store").toBe(1);
});

it("an emptied registry is recovery, never a fresh set of empty stores", async () => {
  const f = await fixture();
  await f.save("main", "Kept");
  await writeFile(path.join(f.stateRoot, "registry.sqlite"), "");
  await expect(createKnowledgeService(f.api).records({}, f.as("main"))).rejects.toThrow(/registry/);
  expect((await f.storesDir()).length).toBe(1);
});

it("operator provider reads never create storage", async () => {
  const f = await fixture();
  let runtime;
  const base = f.api;
  const service = createKnowledgeService({
    ...base,
    registerMemoryCapability(c) {
      runtime = c.providerRuntime;
    },
  });
  const context = {
    authority: { kind: "operator", connId: "x", scopes: ["operator.read"] },
    assertCurrent() {},
  };
  const { provider } = await runtime!.open({ cfg: {}, agentId: "research", context });
  await expect(provider.search({ query: "anything" })).rejects.toThrow(/first authorized use/);
  expect((await provider.health()).status).toBe("ready");
  expect(await f.storesDir()).toStrictEqual([]);
  void service;
});

it("several agents without a default: operators must choose; tools are unaffected", async () => {
  const f = await fixture();
  // No agent entry is marked default, as on installs with several agents.
  for (const agent of f.host.config.agents.list) {
    delete agent.default;
  }
  await f.save("research", "Research note");
  const snap = await f.snapshot();
  expect(snap.defaultAgent).toBe(undefined);
  await expect(f.service.status({}, f.reader)).rejects.toThrow(/choose which agent/);
  expect(
    (
      (await f.service.agent_query(
        { agent: "research", operation: "records", input: {} },
        f.reader,
      )) as any
    ).total,
  ).toBe(1);
  expect((await f.service.status({}, f.as("main"))).store).toBe("unprovisioned");
});
