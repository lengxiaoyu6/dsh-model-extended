/**
 * dsh-model-extended — the editor patch.
 *
 * dsh ships no per-model extension seat: `settings.models.provider-card` adds an
 * area beside a provider card, never a control inside a model row. The official
 * `DeepSeekModelsEditor` and `ModelListEditor` both render only
 * `id`/`name`/`contextWindow`/`maxTokens`. So the fields that belong on a model
 * entry are put where they belong by patching both editors' shared bundle.
 *
 * The patch is deliberately small. Both editors' draft types are
 * `Record<string, unknown>` (explicitly kept open so hidden fields survive
 * edits), and their write paths (`update(i,k,v)` and `patch(i,{k:v})`) both
 * accept arbitrary keys — so the declarations ride each editor's own draft and
 * are persisted by its own save path. This plugin stores nothing itself.
 *
 * Five insertion points (all unique strings in the shipped bundle) produce five
 * literal replacements that either fully apply or refuse and leave the file
 * untouched. `revert` reverses the same five, so it does not depend on the
 * backup surviving an upgrade.
 *
 * @module dsh-model-extended/patch
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Package whose browser bundle renders the model catalog. */
export const TARGET_PACKAGE = "@deepseek-ai/dsh-client-ui-settings-models";

/** The bundle within that package. */
export const TARGET_RELATIVE = "lib/client.js";

/** Presence of this string means the patch is applied. */
export const MARKER = "dsh-model-extended:per-model-declarations";

/** Environment override, mainly for tests and unusual layouts. */
export const BUNDLE_ENV = "DSH_MODEL_EXTENDED_CLIENT_BUNDLE";

// ──────────────────────────────────────────────────────────────────────────────
// DeepSeekModelsEditor anchors and injections
// ──────────────────────────────────────────────────────────────────────────────

/** The two capacity fields of one row's disclosure — where the new fields go. */
const DS_ANCHOR_CHILDREN =
	'children: [capacityField(model, index, "contextWindow", props.defaultContextWindow), capacityField(model, index, "maxTokens", props.defaultMaxTokens)]';

/** The row-field renderer; the new renderers are declared beside it. */
const DS_ANCHOR_DEFINITION = "const capacityField = (model, index, field, fallback) =>";

/** Appended to the disclosure's children. */
const DS_CHILDREN_TAIL = ", modelSetEfforts(model, index), modelSetModalities(model, index)]";

const DS_CHILDREN_PATCHED = DS_ANCHOR_CHILDREN.slice(0, -1) + DS_CHILDREN_TAIL;

// ──────────────────────────────────────────────────────────────────────────────
// ModelListEditor anchors and injections
// ──────────────────────────────────────────────────────────────────────────────

/** The capacity-hint constant — the new renderers are declared before it. */
const ML_ANCHOR_DEFINITION = "const CAPACITY_HINT = {";

/** The maxTokens editCapacity closure + the children array close. Unique. */
const ML_ANCHOR_CHILDREN =
	'editCapacity(index, "maxTokens", event.target.value);\n' +
	'\t\t\t\t\t\t\t\t\t}\n' +
	'\t\t\t\t\t\t\t\t})]\n' +
	'\t\t\t\t\t\t\t})]';

const ML_CHILDREN_TAIL =
	'editCapacity(index, "maxTokens", event.target.value);\n' +
	'\t\t\t\t\t\t\t\t\t}\n' +
	'\t\t\t\t\t\t\t\t})]\n' +
	'\t\t\t\t\t\t\t}), mlModelSetEfforts(model, index), mlModelSetModalities(model, index)]';

// ──────────────────────────────────────────────────────────────────────────────
// Shared helpers — injected once at module scope between the two editor regions
// ──────────────────────────────────────────────────────────────────────────────

/** The boundary between the DeepSeek and ModelList regions; helpers go here. */
const SHARED_ANCHOR =
	"\t\t//#endregion\n" +
	"\t\t//#region lib/types/client/ModelListEditor.js";

/**
 * Helpers used by both editors' injected renderers. Verbatim `String.raw` keeps
 * the escape sequences literal in the target file. Everything referenced is in
 * module scope: `react_jsx_runtime` and `ModelsSection_module_css_default`.
 */
const SHARED_BLOCK = String.raw`/* dsh-model-extended:per-model-declarations */
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
		const __msCopy = (t) => /[\u4e00-\u9fa5]/.test((t("contextWindow") || "") + (t("modelContextWindow") || "")) ? {
			input: "\u652f\u6301\u7684\u8f93\u5165",
			efforts: "\u601d\u8003\u5f3a\u5ea6\u8303\u56f4",
			none: "\u4e0d\u652f\u6301\u601d\u8003",
			def: "\u9ed8\u8ba4\u6863\u4f4d",
			auto: "\u8ddf\u968f\u9002\u914d\u5668",
			off: "\u5173\u95ed",
			low: "\u4f4e",
			high: "\u9ad8",
			max: "\u6700\u9ad8",
			text: "\u6587\u672c",
			image: "\u56fe\u50cf"
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
		`;

const SHARED_INSERTED = SHARED_BLOCK + SHARED_ANCHOR;

// ──────────────────────────────────────────────────────────────────────────────
// DeepSeekModelsEditor renderers — use `update(index, key, value)`
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The DeepSeek-specific renderers. `update` and `props` are in scope at the
 * insertion point (inside `DeepSeekModelsEditor`).
 */
const DS_RENDERERS = String.raw`/** The reasoning-effort range of one row: which levels it offers, and its default. */
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
const DS_INSERTED = DS_RENDERERS + DS_ANCHOR_DEFINITION;

// ──────────────────────────────────────────────────────────────────────────────
// ModelListEditor renderers — use `patch(index, { key: value })`
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The ModelListEditor renderers. `patch`, `disabled`, and `t` are in scope at
 * the insertion point (inside `ModelListEditor`'s function body).
 */
const ML_RENDERERS = String.raw`const mlModelSetEfforts = (model, index) => {
			const copy = __msCopy(t);
			const raw = model["reasoningEfforts"];
			const denied = raw === false;
			const list = Array.isArray(raw) ? __msEffortIds.filter((id) => raw.indexOf(id) >= 0) : [];
			const toggle = (id) => {
				const next = list.indexOf(id) >= 0 ? list.filter((x) => x !== id) : __msEffortIds.filter((x) => x === id || list.indexOf(x) >= 0);
				patch(index, { reasoningEfforts: next.length === 0 ? void 0 : next });
			};
			const stored = model["defaultReasoningEffort"];
			const chosen = typeof stored === "string" && list.indexOf(stored) >= 0 ? stored : "";
			const chips = __msEffortIds.map((id) => __msChip(copy[id], !denied && list.indexOf(id) >= 0, disabled || denied, () => toggle(id)));
			chips.push(__msChip(copy.none, denied, disabled, () => patch(index, { reasoningEfforts: denied ? void 0 : false })));
			const control = (0, react_jsx_runtime.jsxs)("div", {
				style: __msRowStyle,
				children: [...chips, list.length === 0 ? null : (0, react_jsx_runtime.jsxs)("select", {
					className: ModelsSection_module_css_default["input"],
					style: __msSelectStyle,
					disabled: disabled,
					value: chosen,
					"aria-label": copy.def + " " + String(index + 1),
					onChange: (event) => patch(index, { defaultReasoningEffort: event.target.value === "" ? void 0 : event.target.value }),
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
		const mlModelSetModalities = (model, index) => {
			const copy = __msCopy(t);
			const raw = model["inputModalities"];
			const list = Array.isArray(raw) ? __msModalityIds.filter((id) => raw.indexOf(id) >= 0) : [];
			const toggle = (id) => {
				const next = list.indexOf(id) >= 0 ? list.filter((x) => x !== id) : __msModalityIds.filter((x) => x === id || list.indexOf(x) >= 0);
				patch(index, { inputModalities: next.length === 0 ? void 0 : next });
			};
			const control = (0, react_jsx_runtime.jsx)("div", {
				style: __msRowStyle,
				children: __msModalityIds.map((id) => __msChip(copy[id], list.indexOf(id) >= 0, disabled, () => toggle(id)))
			});
			return __msField(copy.input, control);
		};
		`;

const ML_INSERTED = ML_RENDERERS + ML_ANCHOR_DEFINITION;

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
 * Attempt to resolve the target bundle from one base directory, walking up its
 * ancestors. Walking up is what makes this layout-independent: a plugin
 * installed into a profile resolves dsh through that profile's `node_modules`,
 * while a checkout resolves it through whatever global install it was linked to.
 *
 * @param base - directory to start from.
 * @returns the bundle path, or undefined.
 */
function bundleFrom(base) {
	let dir;
	try {
		dir = fs.realpathSync(base);
	} catch {
		return undefined;
	}
	for (let depth = 0; depth < 8; depth++) {
		// Inside dsh's own tree...
		const nested = path.join(dir, "node_modules", "@deepseek-ai", "dsh", "node_modules", TARGET_PACKAGE, TARGET_RELATIVE);
		if (fs.existsSync(nested)) return nested;
		// ...or hoisted to where dsh itself was installed from.
		const hoisted = path.join(dir, "node_modules", TARGET_PACKAGE, TARGET_RELATIVE);
		if (fs.existsSync(hoisted)) return hoisted;
		// ...or reachable through normal resolution (honours exports maps).
		try {
			const require = createRequire(path.join(dir, "package.json"));
			const resolved = path.join(path.dirname(require.resolve(TARGET_PACKAGE + "/package.json")), TARGET_RELATIVE);
			if (fs.existsSync(resolved)) return resolved;
		} catch {
			/* keep walking */
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/**
 * Every place the bundle plausibly lives: the dsh process that loaded this
 * plugin, this plugin's own location, the working directory, and finally the
 * profiles under DSH_HOME. Only consulted when no override is set.
 *
 * @returns candidate bundle paths.
 */
function bundleCandidates() {
	const candidates = [];
	const roots = [];
	const fromProcess = dshPackageRoot();
	if (fromProcess !== undefined) roots.push(fromProcess);
	roots.push(path.dirname(fileURLToPath(import.meta.url)));
	roots.push(process.cwd());

	const home = process.env.DSH_HOME;
	const homeDir = typeof home === "string" && home.length > 0 ? home : path.join(os.homedir(), ".dsh");
	try {
		const profiles = path.join(homeDir, "profiles");
		for (const entry of fs.readdirSync(profiles)) roots.push(path.join(profiles, entry));
	} catch {
		/* no profiles directory is normal outside a dsh install */
	}

	for (const root of roots) {
		const found = bundleFrom(root);
		if (found !== undefined) candidates.push(found);
	}
	return candidates;
}

/**
 * Locate the bundle to patch.
 *
 * An explicit `BUNDLE_ENV` override is exclusive: a caller that names one file
 * means that file, and quietly patching some other installation it discovered
 * instead would be the worst possible reading of the request. Set and missing
 * therefore answers "nothing to patch" rather than falling back.
 *
 * @returns the absolute bundle path, or undefined when nothing was found.
 */
export function locateBundle() {
	const override = process.env[BUNDLE_ENV];
	if (typeof override === "string" && override.length > 0) {
		return fs.existsSync(override) ? override : undefined;
	}
	const candidates = bundleCandidates();
	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Path of the safety copy taken before the first patch. */
export function backupPath(bundle) {
	return bundle + ".dsh-model-extended.bak";
}

/**
 * Write the patch into a bundle's text. Both editors gain their extra fields:
 * shared helpers go between the two region markers at module scope, then each
 * editor gets its own renderers beside its capacity-field definition and its
 * children array extended with the new calls.
 *
 * Pure, so callers (and tests) can reason about the edit without touching disk.
 *
 * @param source - bundle text.
 * @returns the patched text.
 */
export function patchSource(source) {
	return source
		.replace(SHARED_ANCHOR, SHARED_INSERTED)        // shared helpers at module scope
		.replace(DS_ANCHOR_CHILDREN, DS_CHILDREN_PATCHED) // DeepSeek children
		.replace(DS_ANCHOR_DEFINITION, DS_INSERTED)      // DeepSeek renderers
		.replace(ML_ANCHOR_CHILDREN, ML_CHILDREN_TAIL)   // ModelList children
		.replace(ML_ANCHOR_DEFINITION, ML_INSERTED);     // ModelList renderers
}

/**
 * Remove the patch from a bundle's text. Pure counterpart of
 * {@link patchSource}: each injected block goes back to the anchor it was
 * inserted before, so all official definitions survive.
 *
 * @param source - bundle text.
 * @returns the pristine text.
 */
export function unpatchSource(source) {
	return source
		.replace(ML_INSERTED, ML_ANCHOR_DEFINITION)
		.replace(ML_CHILDREN_TAIL, ML_ANCHOR_CHILDREN)
		.replace(DS_INSERTED, DS_ANCHOR_DEFINITION)
		.replace(DS_CHILDREN_PATCHED, DS_ANCHOR_CHILDREN)
		.replace(SHARED_INSERTED, SHARED_ANCHOR);
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
		anchorPresent: source.includes(DS_ANCHOR_CHILDREN)
			&& source.includes(DS_ANCHOR_DEFINITION)
			&& source.includes(ML_ANCHOR_CHILDREN)
			&& source.includes(ML_ANCHOR_DEFINITION)
			&& source.includes(SHARED_ANCHOR),
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

	const next = patchSource(source);
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
	const next = unpatchSource(source);
	if (next === source) {
		// The literal reversal did not match — the bundle may carry an older patch
		// format from a previous plugin version. Fall back to the backup when one
		// exists, since it was taken before the first-ever patch.
		const backup = backupPath(state.bundle);
		if (fs.existsSync(backup)) {
			try {
				fs.copyFileSync(backup, state.bundle);
				return { ok: true, action: "reverted", bundle: state.bundle, note: "restored from backup (old patch format)" };
			} catch (error) {
				return { ok: false, action: "write-failed", bundle: state.bundle, error: String(error) };
			}
		}
		return { ok: false, action: "anchor-not-found", bundle: state.bundle };
	}
	try {
		fs.writeFileSync(state.bundle, next);
	} catch (error) {
		return { ok: false, action: "write-failed", bundle: state.bundle, error: String(error) };
	}
	return { ok: true, action: "reverted", bundle: state.bundle };
}

/** The two literal strings this patch trades, exposed for its own tests. */
export const anchors = {
	// DeepSeek editor
	DS_ANCHOR_CHILDREN, DS_ANCHOR_DEFINITION, DS_CHILDREN_PATCHED, DS_INSERTED, DS_RENDERERS,
	// ModelList editor
	ML_ANCHOR_CHILDREN, ML_ANCHOR_DEFINITION, ML_CHILDREN_TAIL, ML_INSERTED, ML_RENDERERS,
	// Shared
	SHARED_ANCHOR, SHARED_INSERTED, SHARED_BLOCK,
	// Backwards compat for tests that used the old names
	ANCHOR_CHILDREN: DS_ANCHOR_CHILDREN,
	ANCHOR_DEFINITION: DS_ANCHOR_DEFINITION,
};
