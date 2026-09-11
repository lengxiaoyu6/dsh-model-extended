/**
 * dsh-model-extended — host half.
 *
 * Two jobs, one goal: let a dsh model entry state its own reasoning-effort range
 * and accepted input modalities, and make that statement mean something.
 *
 * 1. **The fields.** dsh ships no seat inside a model row, so `patch.js` puts two
 *    controls into the official editor's own row disclosure. Once patched, the
 *    declarations ride the editor's normal draft and are saved by its normal save
 *    path — this plugin stores nothing itself.
 *
 * 2. **The effect.** `ctx.llm` resolves exact-model metadata by calling the
 *    registered adapter's `resolveModel` (`LlmRuntime.resolveModelInfoFor` →
 *    `registration.adapter.resolveModel`), and that same call is what validates a
 *    requested effort before provider I/O. So the adapter instance's `resolveModel`
 *    and `listModels` are wrapped to overlay the declarations — one seam covering
 *    both the model selector and the request validator, with no adapter cloned.
 *
 * Only an explicit declaration changes anything: a model with no declaration
 * reaches the caller exactly as its adapter produced it.
 *
 * @module dsh-model-extended
 */

import * as patch from "./patch.js";

export const name = "dsh-model-extended";

/** `llm` is what the overlay needs; the rest is reached optionally. */
export const inject = ["llm"];

/**
 * Adapter-owned effort levels this plugin knows how to describe. The vocabulary
 * is the DeepSeek adapter's own (`off | low | high | max`); an id outside it is
 * dropped rather than forwarded, because `LlmRuntime.normalizeModelInfo`
 * refuses metadata the surface cannot render.
 */
const EFFORT_LEVELS = {
	off: { id: "off", name: "Off", description: "Use for simple tasks that do not need reasoning." },
	low: { id: "low", name: "Low", description: "Prefer for routine or latency-sensitive tasks." },
	high: { id: "high", name: "High", description: "The default balance for most tasks." },
	max: { id: "max", name: "Max", description: "Reserve for the hardest quality-first tasks." },
};

/** Adapter-preferred display order. */
const EFFORT_ORDER = ["off", "low", "high", "max"];

/** The modality vocabulary `dsh-llm` declares. */
const MODALITIES = ["text", "image"];

/** Settings namespace whose model rows carry the declarations, unless config narrows it. */
const DEFAULT_NAMESPACES = ["llm-deepseek"];

/** Field names — the same ones the patched editor writes. */
const FIELD_EFFORTS = "reasoningEfforts";
const FIELD_DEFAULT_EFFORT = "defaultReasoningEffort";
const FIELD_MODALITIES = "inputModalities";

const log = (ctx, ...args) => {
	try {
		ctx.logger?.info?.("[dsh-model-extended]", ...args);
	} catch {
		/* logging must never break configuration resolution */
	}
};

/**
 * Read a declared effort range into a deduplicated, canonically ordered id list.
 * @param value - the stored `reasoningEfforts` field.
 * @returns declared ids in display order; empty when nothing usable was declared.
 */
function normalizeEfforts(value) {
	if (!Array.isArray(value)) return [];
	const seen = new Set();
	for (const raw of value) {
		const id = typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
		if (id !== undefined && Object.hasOwn(EFFORT_LEVELS, id)) seen.add(id);
	}
	return EFFORT_ORDER.filter((id) => seen.has(id));
}

/**
 * Whether a stored value explicitly declares "this model cannot reason".
 * `false` and `null` both mean it: the field is present and denies the capability
 * rather than leaving it unstated.
 * @param value - the stored `reasoningEfforts` field.
 * @returns whether reasoning is explicitly denied.
 */
function deniesReasoning(value) {
	return value === false || value === null;
}

/**
 * Read a declared modality list, filtered to the adapter's own vocabulary.
 * @param value - the stored `inputModalities` field.
 * @returns declared modalities in canonical order, or undefined when none were declared.
 */
function normalizeModalities(value) {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set();
	for (const raw of value) {
		const id = typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
		if (id !== undefined && MODALITIES.includes(id)) seen.add(id);
	}
	if (seen.size === 0) return undefined;
	return MODALITIES.filter((id) => seen.has(id));
}

/**
 * Apply one model's declaration over the adapter-produced metadata.
 *
 * The result must satisfy `LlmRuntime.normalizeModelInfo`: a returned
 * `reasoning.efforts` is non-empty with unique non-empty ids, and any
 * `defaultEffort` is one of them. An undeclared or unusable declaration leaves
 * the field untouched, so the adapter keeps owning its own default behavior.
 *
 * @param info - metadata exactly as the wrapped adapter returned it.
 * @param entry - the declaration-carrying settings entry, when one exists.
 * @returns the metadata a caller should see.
 */
function applyDeclaration(info, entry) {
	if (entry === undefined || info === null || typeof info !== "object") return info;
	const next = { ...info };

	const modalities = normalizeModalities(entry[FIELD_MODALITIES]);
	if (modalities !== undefined) next[FIELD_MODALITIES] = modalities;

	if (deniesReasoning(entry[FIELD_EFFORTS])) {
		// Present-but-denied: omitting `reasoning` is how the seam says the
		// capability is unavailable, which leaves only the provider's default.
		delete next.reasoning;
		return next;
	}

	const ids = normalizeEfforts(entry[FIELD_EFFORTS]);
	if (ids.length === 0) return next;

	const declaredDefault = entry[FIELD_DEFAULT_EFFORT];
	const defaultEffort = ids.includes(declaredDefault) ? declaredDefault : undefined;
	next.reasoning = {
		efforts: ids.map((id) => ({ ...EFFORT_LEVELS[id] })),
		...(defaultEffort === undefined ? {} : { defaultEffort }),
	};
	return next;
}

/**
 * Wrap one adapter instance so its exact-model metadata carries the declarations
 * stored for its routes. Installation is idempotent, because the topology event
 * fires on every registration change.
 *
 * @param ctx - plugin context, used for diagnostics only.
 * @param adapter - the live adapter instance behind one or more routes.
 * @param resolveEntry - `(provider, modelId) => entry | undefined` declaration lookup.
 * @returns nothing.
 */
function wrapAdapter(ctx, adapter, resolveEntry) {
	if (adapter === null || typeof adapter !== "object" || adapter.__dshModelExtendedWrapped === true) return;
	const originalResolve = adapter.resolveModel;
	const originalList = adapter.listModels;
	let wrapped = false;

	if (typeof originalResolve === "function") {
		adapter.resolveModel = async function resolveModel(provider, model, signal) {
			const info = await originalResolve.call(this, provider, model, signal);
			try {
				return applyDeclaration(info, resolveEntry(provider, model));
			} catch (error) {
				log(ctx, "declaration overlay failed; keeping adapter metadata", String(error));
				return info;
			}
		};
		wrapped = true;
	}

	if (typeof originalList === "function") {
		adapter.listModels = async function listModels(provider) {
			const list = await originalList.call(this, provider);
			if (!Array.isArray(list)) return list;
			try {
				return list.map((info) => applyDeclaration(info, resolveEntry(provider, info?.id)));
			} catch (error) {
				log(ctx, "catalog overlay failed; keeping adapter metadata", String(error));
				return list;
			}
		};
		wrapped = true;
	}

	if (wrapped) adapter.__dshModelExtendedWrapped = true;
}

/**
 * Read one namespace's declared model entries right now. Schemastery preserves
 * unknown keys, so this plugin's own fields arrive exactly as the patched
 * editor stored them.
 *
 * @param ctx - plugin context.
 * @param ns - settings namespace to read.
 * @returns model id → its declaration-carrying entry; empty when there is none.
 */
function declaredModels(ctx, ns) {
	const byId = new Map();
	const settings = ctx.get("settings");
	if (settings === undefined) return byId;
	let value;
	try {
		value = settings.get(ns);
	} catch {
		return byId;
	}
	const models = value?.models;
	if (!Array.isArray(models)) return byId;
	for (const model of models) {
		if (model !== null && typeof model === "object" && typeof model.id === "string") byId.set(model.id, model);
	}
	return byId;
}

/**
 * The settings namespace configuring one provider route, taken from the
 * adapter's own directory declaration so no provider id is hardcoded here.
 *
 * @param ctx - plugin context.
 * @param provider - provider route id.
 * @returns the namespace, or undefined when the route declares none.
 */
function namespaceForProvider(ctx, provider) {
	try {
		for (const entry of ctx.llm.listConfigurableProviders()) {
			if (entry?.provider === provider && typeof entry.settingsNs === "string") return entry.settingsNs;
		}
	} catch {
		/* a directory read must not disable the overlay */
	}
	return undefined;
}

/**
 * Build the declaration lookup the wrappers call.
 *
 * Everything is read at call time, deliberately. Declarations are edited in the
 * settings UI while this plugin runs, and nothing about such an edit
 * re-registers an adapter or fires `llm/adapters-updated`; the wrapper is
 * installed once per adapter instance. A lookup that captured its namespace
 * contents when it was built would therefore keep answering with the settings it
 * first saw, and the model selector — which reads its efforts through
 * `resolveModelInfo`, via the session controller's catalog — would go on
 * offering levels the user had already removed, until a restart.
 *
 * @param ctx - plugin context.
 * @param namespaces - namespaces whose declarations are honoured.
 * @returns `(provider, modelId) => entry | undefined`.
 */
function buildResolver(ctx, namespaces) {
	const allowed = namespaces.length > 0 ? new Set(namespaces) : null;
	return (provider, modelId) => {
		if (typeof modelId !== "string") return undefined;
		const ns = namespaceForProvider(ctx, provider);
		if (ns === undefined) return undefined;
		// An empty whitelist means "all configurable namespaces".
		if (allowed !== null && !allowed.has(ns)) return undefined;
		return declaredModels(ctx, ns).get(modelId);
	};
}

/**
 * Install the overlay on every registered adapter, and keep doing so as the
 * provider topology changes: adapters register after this plugin loads, and hot
 * reload replaces them.
 *
 * @param ctx - plugin context.
 * @param namespaces - namespaces whose declarations are honoured.
 * @returns nothing.
 */
function installOverlay(ctx, namespaces) {
	const sync = () => {
		const registry = ctx.llm?.adapters;
		if (!(registry instanceof Map)) return;
		const resolveEntry = buildResolver(ctx, namespaces);
		for (const held of registry.values()) {
			// The registry holds each route's registration
			// (`{adapter, provider, retryPolicy}`), not the adapter itself; the
			// adapter is what carries `resolveModel`. Accepting a bare adapter too
			// keeps this working if that shape ever changes.
			wrapAdapter(ctx, held?.adapter ?? held, resolveEntry);
		}
	};
	sync();
	ctx.on("llm/adapters-updated", sync);
}

/**
 * Put the two controls into the official Models editor. Reported rather than
 * thrown: a bundle this plugin cannot patch costs the fields, never the boot.
 *
 * @param ctx - plugin context.
 * @returns nothing.
 */
function installEditorPatch(ctx) {
	try {
		const outcome = patch.apply();
		switch (outcome.action) {
			case "applied":
				log(ctx, "model row fields patched into the Models editor; reload the page to see them");
				break;
			case "already":
				break;
			case "anchor-not-found":
				log(ctx, `Models editor is not patchable in this dsh version (${outcome.bundle}); row fields stay off`);
				break;
			case "not-found":
				log(ctx, "Models editor bundle not found; row fields stay off");
				break;
			default:
				log(ctx, `Models editor patch failed: ${outcome.action} ${outcome.error ?? ""}`);
		}
	} catch (error) {
		log(ctx, "Models editor patch threw; row fields stay off", String(error));
	}
}

/**
 * Plugin entry.
 * @param ctx - host plugin context.
 * @param config - composition entry: `{enabled, namespaces, patchEditor}`.
 * @returns nothing.
 */
export function apply(ctx, config) {
	if (config?.enabled === false) return;

	const declared = Array.isArray(config?.namespaces)
		? config.namespaces.filter((ns) => typeof ns === "string" && ns.length > 0)
		: DEFAULT_NAMESPACES;
	const namespaces = declared.length > 0 ? declared : DEFAULT_NAMESPACES;

	if (config?.patchEditor !== false) installEditorPatch(ctx);
	installOverlay(ctx, namespaces);
	log(ctx, `declaration layer active for: ${namespaces.join(", ")}`);
}
