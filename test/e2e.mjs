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

// --- 4. what the custom-provider editor writes passes pi-ai's own schema --------
// The DeepSeek editor's declarations are this plugin's invention, so only this
// plugin can judge them. A pi-ai provider is the opposite: `reasoningEfforts`
// and `input` are that adapter's own config fields, and it validates them
// strictly. The ModelListEditor writes into that schema, so the shape it
// produces is checked against the real thing here — an array of levels looks
// perfectly reasonable and is refused outright.
const { Config: PiAiConfig } = await import("@deepseek-ai/dsh-llm-pi-ai");

/** Exactly the object the ModelListEditor builds for { off, low, high } + text. */
const written = { off: null, low: "low", high: "high" };
const piAiProfile = (reasoningEfforts, input) => ({
	providers: {
		kiro: {
			displayName: "kiro",
			apiKeyEnv: "KIRO_API_KEY",
			api: "anthropic-messages",
			baseURL: "https://example.invalid",
			models: [{ id: "claude-opus-4-6", name: "claude-opus-4-6", reasoningEfforts, input }],
		},
	},
});

let dictAccepted;
try {
	dictAccepted = PiAiConfig(piAiProfile(written, ["text", "image"]));
} catch (error) {
	dictAccepted = undefined;
	console.log(`   dict rejected: ${String(error.message).slice(0, 160)}`);
}
check("pi-ai accepts the dict the editor writes", dictAccepted !== undefined);
check("the stored dict survives as written", JSON.stringify(dictAccepted?.providers?.kiro?.models?.[0]?.reasoningEfforts) === JSON.stringify(written), JSON.stringify(dictAccepted?.providers?.kiro?.models?.[0]?.reasoningEfforts));
check("pi-ai keeps the modality list written to `input`", JSON.stringify(dictAccepted?.providers?.kiro?.models?.[0]?.input) === '["text","image"]', JSON.stringify(dictAccepted?.providers?.kiro?.models?.[0]?.input));

// The guard is real: the array this editor used to write is refused, and
// `inputModalities` — the DeepSeek field name — is not the field pi-ai reads.
let arrayRefused;
try {
	PiAiConfig(piAiProfile(["off", "low", "high", "max"], ["text"]));
} catch (error) {
	arrayRefused = error;
}
check("pi-ai refuses the level array (the bug this guards)", arrayRefused !== undefined, arrayRefused === undefined ? "accepted (BAD)" : String(arrayRefused.message).slice(0, 90));

const wrongField = PiAiConfig(piAiProfile(undefined, undefined));
const wrongFieldModel = wrongField?.providers?.kiro?.models?.[0] ?? {};
// The point is the field *name*: pi-ai reads `input`, so a declaration written
// to `inputModalities` survives parsing as an unknown key and changes nothing.
check("`inputModalities` is not a field pi-ai reads", wrongFieldModel.inputModalities === undefined && "input" in wrongFieldModel, JSON.stringify(Object.keys(wrongFieldModel)));

// `false` is the denial the ModelListEditor writes for a non-reasoning model.
let denialAccepted;
try {
	denialAccepted = PiAiConfig(piAiProfile(false, ["text"]));
} catch (error) {
	denialAccepted = undefined;
	console.log(`   denial rejected: ${String(error.message).slice(0, 160)}`);
}
check("pi-ai accepts false for a non-reasoning model", denialAccepted?.providers?.kiro?.models?.[0]?.reasoningEfforts === false);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
