/**
 * model-set — the editor patch.
 *
 * dsh ships no per-model extension seat: `settings.models.provider-card` adds an
 * area beside a provider card, never a control inside a model row, and the
 * official `DeepSeekModelsEditor` renders exactly `id`/`name`/`contextWindow`/
 * `maxTokens`. So the fields that belong on a model entry are put where they
 * belong by patching that editor's own bundle: two controls appended to each
 * row's disclosure, next to the two capacity fields.
 *
 * The patch is deliberately tiny, because the official editor already does the
 * hard part:
 *
 *   - `update(index, key, value)` writes any key into the draft, and `undefined`
 *     deletes it, so the declarations ride the editor's own draft and are
 *     persisted by its own save path — this plugin stores nothing itself.
 *   - `DeepSeekModelDraft` is `Record<string, unknown>` and is explicitly kept
 *     open so hidden fields survive an edit, so no official code needs changing
 *     for the extra keys to round-trip.
 *
 * Both insertion points are unique strings in the shipped bundle, so the patch
 * is a two-step literal replacement that either fully applies or refuses and
 * leaves the file untouched. `revert` reverses the same two literals, so it does
 * not depend on the backup surviving an upgrade.
 *
 * @module model-set/patch
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** Package whose browser bundle renders the model catalog. */
export const TARGET_PACKAGE = "@deepseek-ai/dsh-client-ui-settings-models";

/** The bundle within that package. */
export const TARGET_RELATIVE = "lib/client.js";

/** Presence of this string means the patch is applied. */
export const MARKER = "model-set:per-model-declarations";

/** Environment override, mainly for tests and unusual layouts. */
export const BUNDLE_ENV = "MODEL_SET_CLIENT_BUNDLE";

/** The two capacity fields of one row's disclosure — where the new fields go. */
const ANCHOR_CHILDREN =
	'children: [capacityField(model, index, "contextWindow", props.defaultContextWindow), capacityField(model, index, "maxTokens", props.defaultMaxTokens)]';

/** The row-field renderer; the new renderers are declared beside it. */
const ANCHOR_DEFINITION = "const capacityField = (model, index, field, fallback) =>";

/** Appended to the disclosure's children. */
const CHILDREN_TAIL = ", modelSetEfforts(model, index), modelSetModalities(model, index)]";

const CHILDREN_PATCHED = ANCHOR_CHILDREN.slice(0, -1) + CHILDREN_TAIL;

/**
 * The renderers, verbatim as they land in the bundle. `String.raw` keeps the
 * escape sequences (`\u4e00`) literal for the target file, and the fragment
 * deliberately uses no backticks or `${` so nothing here can interpolate.
 *
 * Everything it touches is already in scope at the insertion point: `props` and
 * `update` from the component body, and `react_jsx_runtime` plus
 * `ModelsSection_module_css_default` from the module.
 */
const INSERTED_BLOCK = String.raw`/* model-set:per-model-declarations */
		const __msEffortIds = ["off", "low", "high", "max"];
		const __msModalityIds = ["text", "image"];
		const __msRowStyle = {
			display: "flex",
			flexWrap: "wrap",
			gap: "6px",
			alignItems: "center"
		};
		const __msSelectStyle = {
			fontFamily: "inherit",
			fontSize: "13px",
			height: "32px",
			width: "auto",
			minWidth: "128px",
			cursor: "pointer"
		};
		/** Copy follows the page's own language, detected from an official label. */
		const __msCopy = (t) => /[\u4e00-\u9fa5]/.test(t("contextWindow") || "") ? {
			input: "支持的输入",
			efforts: "思考强度范围",
			none: "不支持思考",
			def: "默认档位",
			auto: "跟随适配器",
			off: "关闭",
			low: "低",
			high: "高",
			max: "最高",
			text: "文本",
			image: "图像"
		} : {
			input: "Accepted input",
			efforts: "Reasoning efforts",
			none: "No reasoning",
			def: "Default effort",
			auto: "Adapter default",
			off: "Off",
			low: "Low",
			high: "High",
			max: "Max",
			text: "Text",
			image: "Image"
		};
		/** One toggle chip, styled with the page's own theme aliases. */
		const __msChip = (label, on, disabled, onClick) => (0, react_jsx_runtime.jsx)("button", {
			type: "button",
			disabled: disabled,
			"aria-pressed": on,
			onClick: onClick,
			style: {
				boxSizing: "border-box",
				height: "32px",
				padding: "0 12px",
				fontFamily: "inherit",
				fontSize: "13px",
				borderRadius: "8px",
				cursor: disabled ? "not-allowed" : "pointer",
				border: "0.5px solid " + (on ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-border-l4)"),
				background: on ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
				color: on ? "var(--dsw-alias-brand-primary)" : "var(--dsw-alias-label-secondary)",
				fontWeight: on ? "600" : "400",
				opacity: disabled ? "0.45" : "1"
			},
			children: label
		});
		/** One labelled field inside a row's disclosure. */
		const __msField = (label, control) => (0, react_jsx_runtime.jsxs)("div", {
			className: ModelsSection_module_css_default["modelField"],
			children: [(0, react_jsx_runtime.jsx)("span", {
				className: ModelsSection_module_css_default["modelFieldLabel"],
				children: label
			}), control]
		});
		/** The reasoning-effort range of one row: which levels it offers, and its default. */
		const modelSetEfforts = (model, index) => {
			const copy = __msCopy(props.t);
			const raw = model["reasoningEfforts"];
			const denied = raw === false;
			const list = Array.isArray(raw) ? __msEffortIds.filter((id) => raw.indexOf(id) >= 0) : [];
			const toggle = (id) => {
				const next = list.indexOf(id) >= 0 ? list.filter((x) => x !== id) : __msEffortIds.filter((x) => x === id || list.indexOf(x) >= 0);
				update(index, "reasoningEfforts", next.length === 0 ? void 0 : next);
			};
			const stored = model["defaultReasoningEffort"];
			const chosen = typeof stored === "string" && list.indexOf(stored) >= 0 ? stored : "";
			const chips = __msEffortIds.map((id) => __msChip(copy[id], !denied && list.indexOf(id) >= 0, props.disabled || denied, () => toggle(id)));
			chips.push(__msChip(copy.none, denied, props.disabled, () => update(index, "reasoningEfforts", denied ? void 0 : false)));
			const control = (0, react_jsx_runtime.jsxs)("div", {
				style: __msRowStyle,
				children: [...chips, list.length === 0 ? null : (0, react_jsx_runtime.jsxs)("select", {
					className: ModelsSection_module_css_default["input"],
					style: __msSelectStyle,
					disabled: props.disabled,
					value: chosen,
					"aria-label": copy.def + " " + String(index + 1),
					onChange: (event) => update(index, "defaultReasoningEffort", event.target.value === "" ? void 0 : event.target.value),
					children: [(0, react_jsx_runtime.jsx)("option", {
						value: "",
						children: copy.auto
					}), ...list.map((id) => (0, react_jsx_runtime.jsx)("option", {
						value: id,
						children: copy[id]
					}))]
				})]
			});
			return __msField(copy.efforts, control);
		};
		/** The accepted request modalities of one row. */
		const modelSetModalities = (model, index) => {
			const copy = __msCopy(props.t);
			const raw = model["inputModalities"];
			const list = Array.isArray(raw) ? __msModalityIds.filter((id) => raw.indexOf(id) >= 0) : [];
			const toggle = (id) => {
				const next = list.indexOf(id) >= 0 ? list.filter((x) => x !== id) : __msModalityIds.filter((x) => x === id || list.indexOf(x) >= 0);
				update(index, "inputModalities", next.length === 0 ? void 0 : next);
			};
			const control = (0, react_jsx_runtime.jsx)("div", {
				style: __msRowStyle,
				children: __msModalityIds.map((id) => __msChip(copy[id], list.indexOf(id) >= 0, props.disabled, () => toggle(id)))
			});
			return __msField(copy.input, control);
		};
		`;

/** Insertion = the renderers, then the official anchor they sit beside. */
const INSERTED = INSERTED_BLOCK + ANCHOR_DEFINITION;

/**
 * Walk up from a path until a manifest naming `@deepseek-ai/dsh` is found.
 * `process.argv[1]` inside a running dsh is the launcher, so this reaches the
 * installed package without hardcoding an install layout.
 * @returns the dsh package root, or undefined outside a dsh process.
 */
export function dshPackageRoot() {
	const entry = process.argv[1];
	if (typeof entry !== "string" || entry.length === 0) return undefined;
	let dir;
	try {
		dir = path.dirname(fs.realpathSync(entry));
	} catch {
		return undefined;
	}
	for (let depth = 0; depth < 8; depth++) {
		const manifest = path.join(dir, "package.json");
		if (fs.existsSync(manifest)) {
			try {
				if (JSON.parse(fs.readFileSync(manifest, "utf8")).name === "@deepseek-ai/dsh") return dir;
			} catch {
				/* an unreadable manifest is not the one being looked for */
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/**
 * Locate the bundle to patch: an explicit override first, then the copy the
 * running dsh resolves as its own dependency, then the conventional layout.
 * @returns the absolute bundle path, or undefined when nothing was found.
 */
export function locateBundle() {
	const candidates = [];
	const override = process.env[BUNDLE_ENV];
	if (typeof override === "string" && override.length > 0) candidates.push(override);
	const root = dshPackageRoot();
	if (root !== undefined) {
		try {
			const require = createRequire(path.join(root, "package.json"));
			candidates.push(path.join(path.dirname(require.resolve(TARGET_PACKAGE + "/package.json")), TARGET_RELATIVE));
		} catch {
			/* fall through to the conventional location */
		}
		candidates.push(path.join(root, "node_modules", TARGET_PACKAGE, TARGET_RELATIVE));
	}
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Path of the safety copy taken before the first patch. */
export function backupPath(bundle) {
	return bundle + ".model-set.bak";
}

/**
 * Inspect the patch without changing anything.
 * @returns where the bundle is, whether it is patched, and whether a backup exists.
 */
export function status() {
	const bundle = locateBundle();
	if (bundle === undefined) return { found: false, patched: false, backedUp: false };
	let source = "";
	try {
		source = fs.readFileSync(bundle, "utf8");
	} catch {
		return { found: false, patched: false, backedUp: false };
	}
	return {
		found: true,
		bundle,
		patched: source.includes(MARKER),
		// A bundle that lost the anchor cannot be patched, which happens when dsh
		// ships an editor whose row markup changed.
		anchorPresent: source.includes(ANCHOR_CHILDREN) && source.includes(ANCHOR_DEFINITION),
		backedUp: fs.existsSync(backupPath(bundle)),
	};
}

/**
 * Apply the patch. Idempotent: an already-patched bundle is reported as such
 * without being rewritten. A bundle missing either anchor is left untouched and
 * reported, so a changed upstream editor degrades to "no fields" instead of a
 * broken page.
 *
 * @returns the outcome, with the bundle path when one was found.
 */
export function apply() {
	const state = status();
	if (state.found !== true) return { ok: false, action: "not-found" };
	if (state.patched) return { ok: true, action: "already", bundle: state.bundle };
	if (state.anchorPresent !== true) return { ok: false, action: "anchor-not-found", bundle: state.bundle };

	let source;
	try {
		source = fs.readFileSync(state.bundle, "utf8");
	} catch (error) {
		return { ok: false, action: "read-failed", bundle: state.bundle, error: String(error) };
	}

	const next = source
		.replace(ANCHOR_CHILDREN, CHILDREN_PATCHED)
		.replace(ANCHOR_DEFINITION, INSERTED);
	if (next === source) return { ok: false, action: "anchor-not-found", bundle: state.bundle };

	const backup = backupPath(state.bundle);
	if (!fs.existsSync(backup)) {
		try {
			fs.copyFileSync(state.bundle, backup);
		} catch (error) {
			return { ok: false, action: "backup-failed", bundle: state.bundle, error: String(error) };
		}
	}

	try {
		fs.writeFileSync(state.bundle, next);
	} catch (error) {
		return { ok: false, action: "write-failed", bundle: state.bundle, error: String(error) };
	}
	return { ok: true, action: "applied", bundle: state.bundle, bundleBytes: next.length };
}

/**
 * Remove the patch. Reversal trades the same two literals back, which is why it
 * works even when the backup was replaced by an upgrade: the injected block goes
 * back to the anchor it was inserted before, and the disclosure goes back to the
 * two official fields. `INSERTED` ends with that anchor, so restoring it — not
 * deleting it — is what keeps the official `capacityField` definition alive.
 *
 * @returns the outcome, with the bundle path when one was found.
 */
export function revert() {
	const state = status();
	if (state.found !== true) return { ok: false, action: "not-found" };
	if (!state.patched) return { ok: true, action: "already-clean", bundle: state.bundle };

	let source;
	try {
		source = fs.readFileSync(state.bundle, "utf8");
	} catch (error) {
		return { ok: false, action: "read-failed", bundle: state.bundle, error: String(error) };
	}
	const next = source.replace(INSERTED, ANCHOR_DEFINITION).replace(CHILDREN_PATCHED, ANCHOR_CHILDREN);
	if (next === source) return { ok: false, action: "anchor-not-found", bundle: state.bundle };
	try {
		fs.writeFileSync(state.bundle, next);
	} catch (error) {
		return { ok: false, action: "write-failed", bundle: state.bundle, error: String(error) };
	}
	return { ok: true, action: "reverted", bundle: state.bundle };
}

/** The two literal strings this patch trades, exposed for its own tests. */
export const anchors = { ANCHOR_CHILDREN, ANCHOR_DEFINITION, CHILDREN_PATCHED, INSERTED, INSERTED_BLOCK };
