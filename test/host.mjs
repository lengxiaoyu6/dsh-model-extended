// dsh-model-extended host-half verification: drives the wrapper against a fake LlmRuntime
// shaped like the real one (adapters Map + listConfigurableProviders + settings).
// Every scenario gets its own context, so one case can never steer another.
import { apply, name, inject } from "../lib/index.js";
import { locateBundle, unpatchSource } from "../lib/patch.js";

// The plugin patches the installed Models editor bundle on apply(). Tests must
// never touch that installation, so every apply() below is redirected to a
// throwaway copy. test/patch.mjs owns the real apply/revert behaviour.
import fsGuard from "node:fs";
import osGuard from "node:os";
import pathGuard from "node:path";
const SANDBOX_DIR = fsGuard.mkdtempSync(pathGuard.join(osGuard.tmpdir(), "dsh-model-extended-sandbox-"));
const SANDBOX_BUNDLE = pathGuard.join(SANDBOX_DIR, "client.js");
// Sandboxes are scratch space; drop them when the run ends.
process.on("exit", () => {
	try {
		fsGuard.rmSync(SANDBOX_DIR, { recursive: true, force: true });
	} catch {
		/* /tmp cleanup is best effort */
	}
});
const REAL_BUNDLE = locateBundle();
if (REAL_BUNDLE === undefined) {
	// No dsh here: point the patch at a path that cannot exist, so it no-ops
	// instead of reaching for a real installation.
	process.env.DSH_MODEL_EXTENDED_CLIENT_BUNDLE = pathGuard.join(SANDBOX_DIR, "absent.js");
} else {
	// This plugin may be active on this machine, in which case the live bundle
	// already carries the patch; normalise to the upstream text either way.
	const located = fsGuard.readFileSync(REAL_BUNDLE, "utf8");
	fsGuard.writeFileSync(SANDBOX_BUNDLE, located.includes("dsh-model-extended:per-model-declarations") ? unpatchSource(located) : located);
	process.env.DSH_MODEL_EXTENDED_CLIENT_BUNDLE = SANDBOX_BUNDLE;
}

let failures = 0;
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  → ${detail}`}`);
	if (!ok) failures++;
};

/** The registry holds `{adapter, provider, retryPolicy}` per route, not the adapter. */
const reg = (adapter, provider) => ({ adapter, provider: { id: provider }, retryPolicy: undefined });

const REASONING_EFFORTS = [
	{ id: "off", name: "Off", description: "Use for simple tasks that do not need reasoning." },
	{ id: "low", name: "Low" },
	{ id: "high", name: "High" },
	{ id: "max", name: "Max" },
];

/** The real adapter's behavior: one global four-level answer, whatever the model. */
function makeAdapter(models) {
	return {
		resolveModelCalls: 0,
		async resolveModel(provider, model) {
			this.resolveModelCalls++;
			const configured = models.find((m) => m.id === model);
			return {
				provider,
				id: model,
				name: configured?.name ?? model,
				inputModalities: configured?.inputModalities ?? ["text"],
				context: { contextWindow: configured?.contextWindow ?? 1000000 },
				defaultMaxTokens: configured?.maxTokens ?? 256000,
				reasoning: { efforts: REASONING_EFFORTS.map((e) => ({ ...e })), defaultEffort: "high" },
			};
		},
		async listModels(provider) {
			return models.map((m) => ({
				provider,
				id: m.id,
				name: m.name ?? m.id,
				inputModalities: m.inputModalities ?? ["text"],
			}));
		},
	};
}

/** One isolated host: adapter, settings document, and its own topology listeners. */
function makeHost(models, providers, document) {
	const adapter = makeAdapter(models);
	const writes = [];
	const listeners = new Map();
	// A live document: the settings UI rewrites it while the plugin is loaded.
	const doc = document ?? { models: models.map((m) => ({ ...m })) };
	const settings = {
		writable: true,
		get: (ns) => (ns === "llm-deepseek" ? { baseURL: "https://api.oaiapis.com/v1", models: doc.models } : undefined),
		update: async (ns, patch) => { writes.push({ ns, patch }); },
	};
	const ctx = {
		logger: { info() {}, error() {} },
		inject(services, fn) { if (!services.includes("webServer")) fn({}); },
		on(event, fn) { listeners.set(event, fn); },
		effect: (fn) => fn(),
		get: (service) => (service === "settings" ? settings : undefined),
		llm: {
			adapters: new Map([["deepseek-official", reg(adapter, "deepseek-official")]]),
			listConfigurableProviders: () => providers ?? [{ provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] }],
		},
	};
	apply(ctx, { enabled: true, namespaces: ["llm-deepseek"] });
	return { ctx, adapter, settings, writes, listeners, models, providers, doc };
}

const resolve = (host, model) => host.adapter.resolveModel("deepseek-official", model);

// ---------------------------------------------------------------- declared range
const main = makeHost([
	{
		id: "deepseek-v4.1-flash",
		name: "DeepSeek-V41-Flash",
		contextWindow: 1000000,
		inputModalities: ["text", "image"],
		reasoningEfforts: ["low", "high"],
		defaultReasoningEffort: "high",
	},
	{ id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", contextWindow: 1000000 },
	{ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", reasoningEfforts: false },
	{ id: "deepseek-v4-vision", name: "Vision", inputModalities: ["text", "image", "audio"], reasoningEfforts: ["banana", "max"] },
]);

const flash = await resolve(main, "deepseek-v4.1-flash");
check("declared effort range wins", JSON.stringify(flash.reasoning.efforts.map((e) => e.id)) === '["low","high"]', JSON.stringify(flash.reasoning.efforts.map((e) => e.id)));
check("declared default effort survives", flash.reasoning.defaultEffort === "high", String(flash.reasoning.defaultEffort));
check("declared modalities win", JSON.stringify(flash.inputModalities) === '["text","image"]', JSON.stringify(flash.inputModalities));
check("effort descriptions are carried", typeof flash.reasoning.efforts[0].description === "string");

// ------------------------------------------------------------- undeclared model
const pro = await resolve(main, "deepseek-v4-pro");
check("undeclared model keeps all four levels", JSON.stringify(pro.reasoning.efforts.map((e) => e.id)) === '["off","low","high","max"]');
check("undeclared model keeps adapter modalities", JSON.stringify(pro.inputModalities) === '["text"]');

// ------------------------------------------------------------ explicit denial
const denied = await resolve(main, "deepseek-v4-flash");
check("denied reasoning omits the field", denied.reasoning === undefined);
check("denied reasoning keeps identity", denied.id === "deepseek-v4-flash" && denied.provider === "deepseek-official");

// -------------------------------------------------- hostile declaration values
const hostile = await resolve(main, "deepseek-v4-vision");
check("unknown effort ids dropped", JSON.stringify(hostile.reasoning.efforts.map((e) => e.id)) === '["max"]', JSON.stringify(hostile.reasoning.efforts.map((e) => e.id)));
check("unknown modalities dropped", JSON.stringify(hostile.inputModalities) === '["text","image"]', JSON.stringify(hostile.inputModalities));

// ------------------------------------- default outside the declared range drops
const bogus = makeHost([{ id: "m1", reasoningEfforts: ["low"], defaultReasoningEffort: "max" }]);
const out = await resolve(bogus, "m1");
check("out-of-range default is dropped", out.reasoning.defaultEffort === undefined, String(out.reasoning.defaultEffort));
check("declared range still applies", JSON.stringify(out.reasoning.efforts.map((e) => e.id)) === '["low"]');

// ------------------------------------------------ discovery surfaces are covered
const listed = await main.adapter.listModels("deepseek-official");
const listedFlash = listed.find((m) => m.id === "deepseek-v4.1-flash");
check("listModels carries declarations", listedFlash?.reasoning?.efforts?.length === 2, JSON.stringify(listedFlash?.reasoning?.efforts?.map((e) => e.id)));

// --------------------------------------- idempotence under repeated topology events
main.listeners.get("llm/adapters-updated")?.();
main.listeners.get("llm/adapters-updated")?.();
const twice = await resolve(main, "deepseek-v4-pro");
check("repeated resync does not double-wrap", twice.reasoning.efforts.length === 4 && main.adapter.__dshModelExtendedWrapped === true);

// ------------------- a declaration written while the plugin runs takes effect at once
// The settings UI writes declarations into a namespace the plugin is already
// reading. Nothing re-registers an adapter when that happens, so a resolver that
// captured its declarations at wrap time would keep serving the stale answer.
const liveDoc = { models: [{ id: "m-live", name: "Live" }] };
const live = makeHost([{ id: "m-live", name: "Live" }], undefined, liveDoc);
const liveBefore = await resolve(live, "m-live");
check("no declaration yet -> the adapter's full range shows", liveBefore.reasoning.efforts.length === 4, JSON.stringify(liveBefore.reasoning.efforts.map((e) => e.id)));

liveDoc.models = [{ id: "m-live", name: "Live", reasoningEfforts: ["low"], inputModalities: ["text", "image"] }];
const liveAfter = await resolve(live, "m-live");
check("a range saved while running applies with no restart", JSON.stringify(liveAfter.reasoning.efforts.map((e) => e.id)) === '["low"]', JSON.stringify(liveAfter.reasoning.efforts.map((e) => e.id)));
check("a modality saved while running applies too", JSON.stringify(liveAfter.inputModalities) === '["text","image"]', JSON.stringify(liveAfter.inputModalities));

liveDoc.models = [{ id: "m-live", name: "Live", reasoningEfforts: false }];
const liveDenied = await resolve(live, "m-live");
check("denial saved while running applies too", liveDenied.reasoning === undefined);

liveDoc.models = [{ id: "m-live", name: "Live" }];
const liveCleared = await resolve(live, "m-live");
check("clearing a declaration while running restores the adapter default", liveCleared.reasoning.efforts.length === 4, JSON.stringify(liveCleared.reasoning.efforts.map((e) => e.id)));

// The selector renders from the session controller's catalog, which builds its
// entries with `listModels` for identity and `resolveModelInfo` for reasoning.
// Both views must agree with the live declaration.
liveDoc.models = [{ id: "m-live", name: "Live", reasoningEfforts: ["low", "max"] }];
const listedLive = (await live.adapter.listModels("deepseek-official")).find((m) => m.id === "m-live");
check("listModels reflects a live declaration", JSON.stringify(listedLive?.reasoning?.efforts?.map((e) => e.id)) === '["low","max"]', JSON.stringify(listedLive?.reasoning?.efforts?.map((e) => e.id)));
const resolvedLive = await resolve(live, "m-live");
check("resolveModel agrees with listModels", JSON.stringify(resolvedLive.reasoning.efforts.map((e) => e.id)) === '["low","max"]', JSON.stringify(resolvedLive.reasoning.efforts.map((e) => e.id)));

// ------------------------------------------- an adapter registered later is caught
const lateModels = [{ id: "late-model", name: "Late", reasoningEfforts: ["off"] }];
const lateHost = makeHost(lateModels, [
	{ provider: "deepseek-official", settingsNs: "llm-deepseek", settingsPath: [] },
	{ provider: "late-provider", settingsNs: "llm-deepseek", settingsPath: [] },
]);
const late = makeAdapter(lateModels);
lateHost.ctx.llm.adapters.set("late-provider", late);
lateHost.listeners.get("llm/adapters-updated")?.();
check("late-registered adapter is wrapped", late.__dshModelExtendedWrapped === true);
const lateOut = await late.resolveModel("late-provider", "late-model");
check("late adapter's declaration applies", JSON.stringify(lateOut.reasoning.efforts.map((e) => e.id)) === '["off"]');

// ------------------------- a route with no settings namespace is left completely alone
const orphan = makeAdapter([{ id: "late-model", reasoningEfforts: ["off"] }]);
const orphanHost = makeHost([{ id: "late-model", reasoningEfforts: ["off"] }]);
orphanHost.ctx.llm.adapters.clear();
orphanHost.ctx.llm.adapters.set("pi-ai-orphan", reg(orphan, "pi-ai-orphan"));
orphanHost.listeners.get("llm/adapters-updated")?.();
const orphanOut = await orphan.resolveModel("pi-ai-orphan", "late-model");
check("route without a settings namespace keeps adapter metadata", orphanOut.reasoning.efforts.length === 4, JSON.stringify(orphanOut.reasoning.efforts.map((e) => e.id)));

// ------------------------------------------------ disabled plugin changes nothing
const dAdapter = makeAdapter([{ id: "m2", reasoningEfforts: ["low"] }]);
const dListeners = new Map();
const dCtx = {
	logger: { info() {}, error() {} },
	inject() {},
	on(event, fn) { dListeners.set(event, fn); },
	effect: (fn) => fn(),
	get: () => undefined,
	llm: {
		adapters: new Map([["deepseek-official", reg(dAdapter, "deepseek-official")]]),
		listConfigurableProviders: () => [{ provider: "deepseek-official", settingsNs: "llm-deepseek", settingsPath: [] }],
	},
};
apply(dCtx, { enabled: false });
const dOut = await dAdapter.resolveModel("deepseek-official", "m2");
check("disabled plugin does not wrap", dAdapter.__dshModelExtendedWrapped === undefined);
check("disabled plugin leaves metadata alone", dOut.reasoning.efforts.length === 4);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}  (name=${name}, inject=${JSON.stringify(inject)})`);
process.exit(failures === 0 ? 0 : 1);
