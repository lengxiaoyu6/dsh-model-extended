// dsh-model-extended end-to-end: the REAL @deepseek-ai/dsh-llm LlmRuntime, a fake adapter
// shaped like dsh-llm-deepseek, and this plugin's wrapper in between. Proves the
// overlaid metadata survives the runtime's own validation, and that a declared
// range actually gates requested efforts before any provider I/O.
//
// The bare imports below are dsh's own packages, so this file must run from the
// dsh package root. `test/run-all.sh` does that for you.
import { Context } from "@deepseek-ai/cordis";
import { LlmRuntime, LlmAdapter } from "@deepseek-ai/dsh-llm";
import { apply } from "../lib/index.js";

// The plugin patches the installed Models editor bundle on apply(). Tests must
// never touch that installation, so every apply() below is redirected to a
// throwaway copy. test/patch.mjs owns the real apply/revert behaviour.
import fsGuard from "node:fs";
import osGuard from "node:os";
import pathGuard from "node:path";
const REAL_BUNDLE = "/root/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js";
const SANDBOX_DIR = fsGuard.mkdtempSync(pathGuard.join(osGuard.tmpdir(), "dsh-model-extended-sandbox-"));
const SANDBOX_BUNDLE = pathGuard.join(SANDBOX_DIR, "client.js");
if (fsGuard.existsSync(REAL_BUNDLE)) {
	fsGuard.copyFileSync(REAL_BUNDLE, SANDBOX_BUNDLE);
	process.env.DSH_MODEL_EXTENDED_CLIENT_BUNDLE = SANDBOX_BUNDLE;
} else {
	process.env.DSH_MODEL_EXTENDED_CLIENT_BUNDLE = pathGuard.join(SANDBOX_DIR, "absent.js");
}

let failures = 0;
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  → ${detail}`}`);
	if (!ok) failures++;
};

const EFFORTS = [
	{ id: "off", name: "Off", description: "Use for simple tasks that do not need reasoning." },
	{ id: "low", name: "Low" },
	{ id: "high", name: "High" },
	{ id: "max", name: "Max" },
];

const MODELS = [
	{ id: "deepseek-v4.1-flash", name: "DeepSeek-V41-Flash", contextWindow: 1000000, maxTokens: 256000, inputModalities: ["text", "image"], reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" },
	{ id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", contextWindow: 1000000 },
	{ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash", reasoningEfforts: false },
];

/** The real adapter's behavior: one global four-level answer for every model. */
class FakeDeepSeekAdapter extends LlmAdapter {
	providerInfo(provider) {
		return { id: provider, name: "DeepSeek" };
	}
	providerRetryPolicy() {
		return undefined;
	}
	imageRequestPricing() {
		return undefined;
	}
	async listModels(provider) {
		return MODELS.map((m) => ({ provider, id: m.id, name: m.name ?? m.id, inputModalities: m.inputModalities ?? ["text"] }));
	}
	async resolveModel(provider, model) {
		const configured = MODELS.find((m) => m.id === model);
		return {
			provider,
			id: model,
			name: configured?.name ?? model,
			inputModalities: configured?.inputModalities ?? ["text"],
			context: { contextWindow: configured?.contextWindow ?? 1000000 },
			defaultMaxTokens: configured?.maxTokens ?? 256000,
			reasoning: { efforts: EFFORTS.map((e) => ({ ...e })), defaultEffort: "high" },
		};
	}
	async *stream() {
		throw new Error("not exercised");
	}
}

// --- real host: cordis context + the real LLM service ---------------------------
const ctx = new Context();
ctx.plugin(LlmRuntime);
await new Promise((resolve) => setTimeout(resolve, 0));
if (ctx.llm === undefined) {
	console.log("FATAL: LlmRuntime did not mount");
	process.exit(1);
}

ctx.llm.registerAdapter(["deepseek-official"], new FakeDeepSeekAdapter());
// The route→namespace declaration the real dsh-llm-deepseek registers. Without
// it the plugin has no way to know which settings section describes this route.
ctx.llm.registerConfigurableProviders([
	{ provider: "deepseek-official", displayName: "DeepSeek", settingsNs: "llm-deepseek", settingsPath: [] },
]);

// the settings seam the plugin reads declarations from
const settings = {
	writable: true,
	get: (ns) => (ns === "llm-deepseek" ? { models: MODELS.map((m) => ({ ...m })) } : undefined),
	async update() {},
};
ctx.get = ((original) => (service) => (service === "settings" ? settings : original.call(ctx, service)))(ctx.get.bind(ctx));
ctx.inject = ((original) => (services, fn) => (services.includes("webServer") ? undefined : original.call(ctx, services, fn)))(ctx.inject.bind(ctx));

// --- the plugin under test -----------------------------------------------------
apply(ctx, { enabled: true, namespaces: ["llm-deepseek"] });

// --- 1. exact-model metadata passes the runtime's own validation ---------------
const info = await ctx.llm.resolveModelInfo("deepseek-official", "deepseek-v4.1-flash");
check("runtime accepts the overlaid metadata", info.id === "deepseek-v4.1-flash");
check("declared range reaches resolveModelInfo", JSON.stringify(info.reasoning.efforts.map((e) => e.id)) === '["low","high"]', JSON.stringify(info.reasoning.efforts.map((e) => e.id)));
check("declared default reaches resolveModelInfo", info.reasoning.defaultEffort === "high", String(info.reasoning.defaultEffort));
check("declared modalities reach resolveModelInfo", JSON.stringify(info.inputModalities) === '["text","image"]', JSON.stringify(info.inputModalities));
check("adapter context survives the overlay", info.context?.contextWindow === 1000000);

const proInfo = await ctx.llm.resolveModelInfo("deepseek-official", "deepseek-v4-pro");
check("undeclared model is untouched by the runtime", JSON.stringify(proInfo.reasoning.efforts.map((e) => e.id)) === '["off","low","high","max"]');

const deniedInfo = await ctx.llm.resolveModelInfo("deepseek-official", "deepseek-v4-flash");
check("denied reasoning yields no reasoning field", deniedInfo.reasoning === undefined);

// --- 2. the declared range gates requested efforts -----------------------------
const inRange = await ctx.llm.resolveCallConfig({ provider: "deepseek-official", model: "deepseek-v4.1-flash", reasoningEffort: "low" });
check("effort inside the declared range is accepted", inRange.reasoningEffort === "low", String(inRange.reasoningEffort));

let refused;
try {
	await ctx.llm.resolveCallConfig({ provider: "deepseek-official", model: "deepseek-v4.1-flash", reasoningEffort: "max" });
} catch (error) {
	refused = error;
}
check("effort outside the declared range is refused before I/O", refused !== undefined, refused === undefined ? "accepted (BAD)" : String(refused.message).slice(0, 90));
check("refusal is a machine-coded LlmError", refused?.code !== undefined, String(refused?.code));

let maxOnPro;
try {
	maxOnPro = await ctx.llm.resolveCallConfig({ provider: "deepseek-official", model: "deepseek-v4-pro", reasoningEffort: "max" });
} catch (error) {
	maxOnPro = `threw: ${error.message}`;
}
check("undeclared model still accepts every level", maxOnPro?.reasoningEffort === "max", typeof maxOnPro === "string" ? maxOnPro : String(maxOnPro?.reasoningEffort));

// --- 3. a denied model refuses every explicit effort ---------------------------
let deniedEffort;
try {
	await ctx.llm.resolveCallConfig({ provider: "deepseek-official", model: "deepseek-v4-flash", reasoningEffort: "low" });
} catch (error) {
	deniedEffort = error;
}
check("denied model refuses an explicit effort", deniedEffort !== undefined, deniedEffort === undefined ? "accepted (BAD)" : String(deniedEffort.message).slice(0, 90));

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
