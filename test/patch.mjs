// dsh-model-extended patch verification.
//
// The editor patch edits a shipped file, so two things must hold: the edit is
// exactly reversible, and the code it injects actually renders the right control
// for the right declaration. The second half is tested by evaluating the injected
// block against fake JSX/React primitives and inspecting the element tree it
// produces — the real component body, not a paraphrase of it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { apply, revert, status, anchors, MARKER, locateBundle, unpatchSource } from "../lib/patch.js";

let failures = 0;
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  → ${detail}`}`);
	if (!ok) failures++;
};

const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// --- a stand-in bundle carrying the real anchors, so this test owns its file ---
// The plugin locates the bundle wherever dsh is installed; the tests use the
// same resolution instead of hardcoding a layout.
const REAL_BUNDLE = locateBundle();
if (REAL_BUNDLE === undefined) {
	console.error("dsh installation not found, so there is no real Models editor bundle to patch.");
	console.error("Install dsh, or point the lookup at one:");
	console.error("  DSH_MODEL_EXTENDED_CLIENT_BUNDLE=/path/to/.../dsh-client-ui-settings-models/lib/client.js");
	process.exit(1);
}
const locatedSource = fs.readFileSync(REAL_BUNDLE, "utf8");
// The plugin may well be installed and active right now — that is its normal
// state on a machine where it is in use — in which case the shipped bundle is
// already patched and its anchors are gone. Normalise back to the upstream text
// first, so the sandbox always starts from the shape dsh actually ships.
/** The upstream text of the located bundle, however it currently looks. */
function upstreamSource(file, text) {
	const backup = file + ".dsh-model-extended.bak";
	if (!text.includes(MARKER)) return text;
	const reverted = unpatchSource(text);
	// A patch written by an older version reverses to a different literal, so
	// the backup taken before the first-ever patch is the fallback.
	if (!reverted.includes(MARKER)) return reverted;
	return fs.existsSync(backup) ? fs.readFileSync(backup, "utf8") : reverted;
}
const realSource = upstreamSource(REAL_BUNDLE, locatedSource);
const hasAllAnchors = realSource.includes(anchors.DS_ANCHOR_CHILDREN)
	&& realSource.includes(anchors.DS_ANCHOR_DEFINITION)
	&& realSource.includes(anchors.ML_ANCHOR_CHILDREN)
	&& realSource.includes(anchors.ML_ANCHOR_DEFINITION)
	&& realSource.includes(anchors.SHARED_ANCHOR);
check("the shipped editor text carries all five anchors", hasAllAnchors);
if (!hasAllAnchors) {
	console.log("\nCannot continue without the real anchors.");
	process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-model-extended-patch-"));
const sandbox = path.join(dir, "client.js");
fs.writeFileSync(sandbox, realSource);
process.env.DSH_MODEL_EXTENDED_CLIENT_BUNDLE = sandbox;

const pristine = sha(sandbox);

// --- apply ------------------------------------------------------------------
const first = apply();
check("apply reports applied", first.ok === true && first.action === "applied", JSON.stringify(first));
check("marker lands in the file", fs.readFileSync(sandbox, "utf8").includes(MARKER));
check("a backup is taken", fs.existsSync(sandbox + ".dsh-model-extended.bak"));
check("backup is byte-identical to the original", sha(sandbox + ".dsh-model-extended.bak") === pristine);
check("status reports patched", status().patched === true);

const patched = fs.readFileSync(sandbox, "utf8");
check("DeepSeek row fields are wired into the disclosure", patched.includes("modelSetEfforts(model, index), modelSetModalities(model, index)"));
check("ModelList row fields are wired into the disclosure", patched.includes("mlModelSetEfforts(model, index), mlModelSetModalities(model, index)"));
check("injected block is present exactly once", patched.split(MARKER).length - 1 === 1, String(patched.split(MARKER).length - 1));
check("the DeepSeek disclosure anchor is consumed", !patched.includes(anchors.DS_ANCHOR_CHILDREN));
check("the ModelList disclosure anchor is consumed", !patched.includes(anchors.ML_ANCHOR_CHILDREN));

// --- the renderers land in the scope that owns their free variables ---------
// Each renderer closes over locals of the editor function it belongs to:
// `props`/`update` for DeepSeekModelsEditor, `t`/`disabled`/`patch` for
// ModelListEditor. Injecting at module scope compiles perfectly and then throws
// `t is not defined` the first time the editor renders, so the position of the
// declaration — not just its presence — is what these assert.
const at = (needle) => patched.indexOf(needle);
check("DS renderers sit inside DeepSeekModelsEditor", at("const modelSetEfforts = (model, index)") > at("function DeepSeekModelsEditor(props) {"));
check("DS renderers sit after the official update()", at("const modelSetEfforts = (model, index)") > at("const update = (index, key, value) =>"));
check("ML renderers sit inside ModelListEditor", at("const mlModelSetEfforts = (model, index)") > at("function ModelListEditor(props) {"));
check("ML renderers sit after the row patcher they call", at("const mlModelSetEfforts = (model, index)") > at("const patch = (index, next) =>"));
// A tight upper bound: they must precede the next function-body declaration, so
// they cannot have escaped the const block into some later scope.
check("ML renderers sit before the fetch action", at("const mlModelSetEfforts = (model, index)") < at("const fetchModels = async () => {"));

// --- idempotence ------------------------------------------------------------
const second = apply();
check("a second apply is a no-op", second.ok === true && second.action === "already", JSON.stringify(second));
check("file unchanged by the second apply", sha(sandbox) === sha(sandbox));

// --- syntax of the patched bundle -------------------------------------------
const { execFileSync } = await import("node:child_process");
let syntaxOk = true;
let syntaxDetail = "";
try {
	execFileSync(process.execPath, ["--check", sandbox], { stdio: "pipe" });
} catch (error) {
	syntaxOk = false;
	syntaxDetail = String(error.stderr ?? error).slice(0, 200);
}
check("the patched bundle is still valid JavaScript", syntaxOk, syntaxDetail);

// --- behaviour of the injected renderers ------------------------------------
// A miniature jsx runtime: enough structure to inspect what was rendered.
const element = (type, props) => ({ type, props });
const jsxRuntime = {
	jsx: (type, props) => element(type, props),
	jsxs: (type, props) => element(type, props),
};

/** Depth-first walk over a rendered element tree. */
function walk(node, visit) {
	if (node === null || node === undefined || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const child of node) walk(child, visit);
		return;
	}
	visit(node);
	if (node.props) {
		walk(node.props.children, visit);
	}
}

/** Every button in a tree, as `{label, on, disabled, onClick}`. */
function buttonsOf(tree) {
	const found = [];
	walk(tree, (node) => {
		if (node.type === "button") {
			found.push({
				label: node.props.children,
				on: node.props["aria-pressed"] === true,
				disabled: node.props.disabled === true,
				onClick: node.props.onClick,
			});
		}
	});
	return found;
}

/**
 * The default-effort selector of one rendered field, or null when the field
 * renders none. A field is `__msField(label, control)`, so the control is the
 * second child and the selector is its last child (null when no range is set).
 */
function selectOf(field) {
	const control = field.props.children[1];
	const kids = control.props.children;
	const last = kids[kids.length - 1];
	return last !== null && last !== undefined && last.type === "select" ? last : null;
}

/** Run the injected blocks the way the bundle's module scope would. */
function makeDsRenderers() {
	const shared = anchors.SHARED_BLOCK;
	const ds = anchors.DS_RENDERERS;
	const factory = new Function(
		"react_jsx_runtime",
		"ModelsSection_module_css_default",
		"props",
		"update",
		`${shared}
		 ${ds}
		 return { modelSetEfforts, modelSetModalities };`,
	);
	return (props, update) => factory(jsxRuntime, {}, props, update);
}

function makeMlRenderers() {
	const shared = anchors.SHARED_BLOCK;
	const ml = anchors.ML_RENDERERS;
	const factory = new Function(
		"react_jsx_runtime",
		"ModelsSection_module_css_default",
		"patch",
		"disabled",
		"t",
		`${shared}
		 ${ml}
		 return { mlModelSetEfforts, mlModelSetModalities };`,
	);
	return (patch, disabled, t) => factory(jsxRuntime, {}, patch, disabled, t);
}

// English copy is chosen from the official label the page supplies.
/** Render one row through the injected code and report its fields. */
const dsRenderers = makeDsRenderers();
function renderRow(model, disabled = false, t = (key) => key) {
	const captured = [];
	const api = dsRenderers({ t, disabled }, (index, key, value) => captured.push({ index, key, value }));
	return { efforts: api.modelSetEfforts(model, 3), modalities: api.modelSetModalities(model, 3), captured };
}

// --- effort range: declared --------------------------------------------------
const declared = renderRow({ id: "m", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" });
const declaredChips = buttonsOf(declared.efforts);
check("range renders one chip per level plus the denial chip", declaredChips.length === 5, String(declaredChips.length));
check("declared levels read as pressed", JSON.stringify(declaredChips.slice(0, 4).map((c) => c.on)) === "[false,true,true,false]", JSON.stringify(declaredChips.slice(0, 4).map((c) => c.on)));
check("denial chip is not pressed on a declared range", declaredChips[4].on === false);
const selector = selectOf(declared.efforts);
check("a default selector appears for a declared range", selector !== null);
check("selector offers the adapter default plus each declared level", selector.props.children.length === 3, String(selector.props.children.length));
check("selector shows the stored default", selector.props.value === "high", String(selector.props.value));

// --- effort range: nothing declared -----------------------------------------
const bare = renderRow({ id: "m" });
const bareChips = buttonsOf(bare.efforts);
check("nothing declared leaves every level unpressed", bareChips.slice(0, 4).every((c) => c.on === false));
check("nothing declared shows no selector", selectOf(bare.efforts) === null);

// --- effort range: explicit denial ------------------------------------------
const denied = renderRow({ id: "m", reasoningEfforts: false });
const deniedChips = buttonsOf(denied.efforts);
check("denial presses the denial chip", deniedChips[4].on === true);
check("denial disables every level chip", deniedChips.slice(0, 4).every((c) => c.disabled === true));

// --- effort range: an out-of-vocabulary stored id is ignored -----------------
const junk = renderRow({ id: "m", reasoningEfforts: ["low", "banana", "max"] });
const junkChips = buttonsOf(junk.efforts);
check("unknown stored levels are not offered", JSON.stringify(junkChips.slice(0, 4).map((c) => c.on)) === "[false,true,false,true]", JSON.stringify(junkChips.slice(0, 4).map((c) => c.on)));
const junkSelect = selectOf(junk.efforts);
check("selector lists only known levels", junkSelect.props.children.length === 3, String(junkSelect.props.children.length));

// --- clicking chips writes the draft ----------------------------------------
const click = renderRow({ id: "m", reasoningEfforts: ["low"] });
buttonsOf(click.efforts)[2].onClick(); // turn "high" on
check("clicking an off level adds it in canonical order", JSON.stringify(click.captured[0]) === '{"index":3,"key":"reasoningEfforts","value":["low","high"]}', JSON.stringify(click.captured[0]));

const unclick = renderRow({ id: "m", reasoningEfforts: ["low", "high"] });
buttonsOf(unclick.efforts)[1].onClick(); // turn "low" off
check("clicking an on level removes it", JSON.stringify(unclick.captured[0].value) === '["high"]', JSON.stringify(unclick.captured[0]));

const lastOff = renderRow({ id: "m", reasoningEfforts: ["low"] });
buttonsOf(lastOff.efforts)[1].onClick(); // turn the only level off
check("removing the last level clears the field", lastOff.captured[0].value === undefined, JSON.stringify(lastOff.captured[0]));

const deny = renderRow({ id: "m", reasoningEfforts: ["low"] });
buttonsOf(deny.efforts)[4].onClick();
check("the denial chip stores false", deny.captured[0].value === false, JSON.stringify(deny.captured[0]));

const undeny = renderRow({ id: "m", reasoningEfforts: false });
buttonsOf(undeny.efforts)[4].onClick();
check("un-denying clears the field", undeny.captured[0].value === undefined, JSON.stringify(undeny.captured[0]));

// --- default selector writes the draft --------------------------------------
const pickDefault = renderRow({ id: "m", reasoningEfforts: ["low", "high"] });
selectOf(pickDefault.efforts).props.onChange({ target: { value: "low" } });
check("choosing a default writes it", pickDefault.captured[0].key === "defaultReasoningEffort" && pickDefault.captured[0].value === "low", JSON.stringify(pickDefault.captured[0]));

const autoDefault = renderRow({ id: "m", reasoningEfforts: ["low", "high"], defaultReasoningEffort: "low" });
selectOf(autoDefault.efforts).props.onChange({ target: { value: "" } });
check("choosing the adapter default clears the field", autoDefault.captured[0].value === undefined, JSON.stringify(autoDefault.captured[0]));

// --- modalities --------------------------------------------------------------
const modes = renderRow({ id: "m", inputModalities: ["text", "image"] });
const modChips = buttonsOf(modes.modalities);
check("modalities render one chip each", modChips.length === 2, String(modChips.length));
check("declared modalities read as pressed", modChips.every((c) => c.on === true));
const noModes = renderRow({ id: "m" });
check("undeclared modalities leave every chip unpressed", buttonsOf(noModes.modalities).every((c) => c.on === false));
const imageOnly = renderRow({ id: "m", inputModalities: ["image"] });
check("a single declared modality is respected", JSON.stringify(buttonsOf(imageOnly.modalities).map((c) => c.on)) === "[false,true]");
buttonsOf(imageOnly.modalities)[0].onClick();
check("adding a modality writes it in canonical order", JSON.stringify(imageOnly.captured[0].value) === '["text","image"]', JSON.stringify(imageOnly.captured[0]));
const dropImage = renderRow({ id: "m", inputModalities: ["text", "image"] });
buttonsOf(dropImage.modalities)[1].onClick();
check("removing a modality writes the rest", JSON.stringify(dropImage.captured[0].value) === '["text"]', JSON.stringify(dropImage.captured[0]));
const dropLast = renderRow({ id: "m", inputModalities: ["text"] });
buttonsOf(dropLast.modalities)[0].onClick();
check("removing the last modality clears the field", dropLast.captured[0].value === undefined, JSON.stringify(dropLast.captured[0]));

// --- names come from the ids, and never come out empty ----------------------
// The page's own language does not change these: dsh names levels from their
// ids and the model selector shows those names, so a chip must match the effort
// it selects rather than translate it into a second vocabulary.
const namedRow = renderRow({ id: "m", reasoningEfforts: ["low", "high", "max"] });
const levelChips = buttonsOf(namedRow.efforts).slice(0, 4).map((c) => c.label);
check("level chips are named from their ids", JSON.stringify(levelChips) === '["Off","Low","High","Max"]', JSON.stringify(levelChips));
check("no level chip can render blank", levelChips.every((label) => typeof label === "string" && label.length > 0), JSON.stringify(levelChips));
check("field labels are this plugin's own English wording", namedRow.efforts.props.children[0].props.children === "Reasoning efforts");
// A locale that translates the official labels must not change these names.
const zhNamed = renderRow({ id: "m", reasoningEfforts: ["low"] }, false, (key) => (key === "contextWindow" ? "上下文窗口" : key));
check("a translated page leaves the names alone", JSON.stringify(buttonsOf(zhNamed.efforts).slice(0, 4).map((c) => c.label)) === '["Off","Low","High","Max"]', JSON.stringify(buttonsOf(zhNamed.efforts).slice(0, 4).map((c) => c.label)));

// --- disabled editor ---------------------------------------------------------
const frozen = renderRow({ id: "m", inputModalities: ["text"], reasoningEfforts: ["low"] }, true);
check("a disabled editor disables every chip", buttonsOf(frozen.modalities).every((c) => c.disabled) && buttonsOf(frozen.efforts).every((c) => c.disabled));

// --- ModelListEditor renderers (use `patch`, and pi-ai's own vocabulary) ----
const mlRenderers = makeMlRenderers();
function mlRenderRow(model, disabled = false, t = (key) => key) {
	const captured = [];
	const patchFn = (index, obj) => { for (const [k, v] of Object.entries(obj)) captured.push({ index, key: k, value: v }); };
	const api = mlRenderers(patchFn, disabled, t);
	return { efforts: api.mlModelSetEfforts(model, 3), modalities: api.mlModelSetModalities(model, 3), captured };
}
// pi-ai's levels are a superset of DeepSeek's, and a declared dict marks the
// offered ones. `off` is handled by the writer rather than offered as a chip.
// Chip order is the adapter's escalation order: minimal, low, medium, high,
// xhigh, max, then the denial chip — so index 3 is `high`.
//
// Each assertion renders afresh: the stub does not re-render on click, so a
// second click would otherwise be computed from the original model and quietly
// not reflect the first one.
const piModel = (extra) => ({ id: "m", reasoningEfforts: { off: null, low: "low", high: "high" }, ...extra });

const mlBasic = mlRenderRow(piModel({ input: ["text"] }));
check("ML: six level chips plus the denial chip", buttonsOf(mlBasic.efforts).length === 7, String(buttonsOf(mlBasic.efforts).length));
check("ML: declared dict marks exactly the offered levels on", JSON.stringify(buttonsOf(mlBasic.efforts).map((c) => c.on)) === "[false,true,false,true,false,false,false]", JSON.stringify(buttonsOf(mlBasic.efforts).map((c) => c.on)));
check("ML: modalities read from `input`", JSON.stringify(buttonsOf(mlBasic.modalities).map((c) => c.on)) === "[true,false]");

const addMinimal = mlRenderRow(piModel({}));
buttonsOf(addMinimal.efforts)[0].onClick();
const added = addMinimal.captured[0];
check("ML: adding a level writes pi-ai's dict, not an array", added !== undefined && !Array.isArray(added.value), JSON.stringify(added?.value));
check("ML: the dict carries `off` as null so not-thinking stays selectable", added?.value?.off === null, JSON.stringify(added?.value));
check("ML: the dict spells each offered level with its own name", added?.value?.minimal === "minimal" && added?.value?.low === "low" && added?.value?.high === "high", JSON.stringify(added?.value));
check("ML: the dict omits levels that are not offered", !("max" in (added?.value ?? {})) && !("xhigh" in (added?.value ?? {})), JSON.stringify(added?.value));

const dropHigh = mlRenderRow(piModel({}));
buttonsOf(dropHigh.efforts)[3].onClick();
const dropped = dropHigh.captured[0];
check("ML: toggling a level off drops it from the dict", !("high" in (dropped?.value ?? {})), JSON.stringify(dropped?.value));
check("ML: the levels left on are untouched by the drop", dropped?.value?.low === "low" && dropped?.value?.off === null, JSON.stringify(dropped?.value));

const mlModsRow = mlRenderRow(piModel({ input: ["text"] }));
buttonsOf(mlModsRow.modalities)[1].onClick();
const mlMods = mlModsRow.captured[0];
check("ML: modality writes go to `input`, the field pi-ai declares", mlMods?.key === "input" && JSON.stringify(mlMods.value) === '["text","image"]', JSON.stringify(mlModsRow.captured.map((c) => c.key)));
check("ML: nothing is ever written to a field pi-ai does not declare", !mlBasic.captured.some((c) => c.key === "inputModalities" || c.key === "defaultReasoningEffort") && !mlModsRow.captured.some((c) => c.key === "inputModalities" || c.key === "defaultReasoningEffort"), JSON.stringify(mlModsRow.captured.map((c) => c.key)));

// Clearing every level must delete the field: pi-ai rejects a dict that offers
// nothing beyond `off`, and "no declaration" inherits the installed catalogue.
const mlClear = mlRenderRow({ id: "m", reasoningEfforts: { off: null, low: "low" } });
buttonsOf(mlClear.efforts)[1].onClick();
check("ML: clearing the last level deletes the field instead of writing an empty dict", mlClear.captured[0].value === undefined, JSON.stringify(mlClear.captured[0]));

const mlDenied = mlRenderRow({ id: "m", reasoningEfforts: false });
check("ML: denied model disables level chips", buttonsOf(mlDenied.efforts).slice(0, 6).every((c) => c.disabled));
check("ML: the denial chip reads as pressed on a denied model", buttonsOf(mlDenied.efforts)[6].on === true);
// Pressing it again lifts the denial: the field is cleared, not set to false.
buttonsOf(mlDenied.efforts)[6].onClick();
check("ML: releasing the denial clears the field", mlDenied.captured[0].key === "reasoningEfforts" && mlDenied.captured[0].value === undefined, JSON.stringify(mlDenied.captured[0]));

const mlReasoning = mlRenderRow(piModel({}));
buttonsOf(mlReasoning.efforts)[6].onClick();
check("ML: denying a reasoning model writes false", mlReasoning.captured[0].value === false, JSON.stringify(mlReasoning.captured[0]));

// An array is what the old, wrong writer produced; it must read as undeclared
// rather than crash, so a stale value cannot break the page.
const mlStale = mlRenderRow({ id: "m", reasoningEfforts: ["low", "high"] });
check("ML: a stale array declaration renders as nothing declared", buttonsOf(mlStale.efforts).every((c) => c.on === false), JSON.stringify(buttonsOf(mlStale.efforts).map((c) => c.on)));

// Every pi-ai level is named, including the three DeepSeek's adapter lacks —
// an unlisted one used to render as an empty chip.
const mlNames = mlRenderRow(piModel({}));
const mlLabels = buttonsOf(mlNames.efforts).map((c) => c.label);
check("ML: every pi-ai level chip is named", JSON.stringify(mlLabels.slice(0, 6)) === '["Minimal","Low","Medium","High","Xhigh","Max"]', JSON.stringify(mlLabels.slice(0, 6)));
check("ML: no chip can render blank", mlLabels.every((label) => typeof label === "string" && label.length > 0), JSON.stringify(mlLabels));
check("ML: field labels are this plugin's own English wording", mlNames.efforts.props.children[0].props.children === "Reasoning efforts");

// --- the injected code runs in the real editor scope ------------------------
// The strongest check available without a browser: lift each patched editor out
// of the bundle and render it. Every free variable resolves exactly as the
// module does, so an injection placed in the wrong scope throws here the way it
// threw in the page ("t is not defined") — which a synthetic-scope test cannot
// see, because there the harness supplies those names as parameters.
//
// The shared helpers sit at module scope between the two regions, so each
// editor's code is assembled with them in front: the renderers only run after
// the whole module has evaluated, which is what makes module-scope helpers
// reachable from either editor.
const dsRegionStart = patched.indexOf("//#region lib/types/client/DeepSeekModelsEditor.js");
const sharedMarkerAt = patched.indexOf("/* dsh-model-extended:per-model-declarations */");
const mlRegionStart = patched.indexOf("//#region lib/types/client/ModelListEditor.js");
const storeRegionAt = patched.indexOf("//#region lib/types/client/store.js");
const sharedBlockText = patched.slice(sharedMarkerAt, patched.lastIndexOf("//#endregion", mlRegionStart));
const dsRegionCode = patched.slice(dsRegionStart, sharedMarkerAt) + sharedBlockText;
const mlRegionCode = sharedBlockText + patched.slice(mlRegionStart, patched.lastIndexOf("//#endregion", storeRegionAt));

/** React stand-in: the editors only read state, and row 0 must be expanded. */
const reactStub = {
	useState: (init) => {
		let value = typeof init === "function" ? init() : init;
		// The disclosure is where the injected fields live, so open it.
		if (value instanceof Set) value = new Set([0]);
		return [value, () => {}];
	},
	useRef: (init) => ({ current: init }),
	useMemo: (fn) => fn(),
	useCallback: (fn) => fn,
	useEffect: () => {},
};
const primitivesStub = { Modal: (props) => jsxRuntime.jsx("div", props), Button: (props) => jsxRuntime.jsx("button", props) };

/** Render one editor out of the patched bundle, reporting any scope failure. */
function renderRealEditor(kind) {
	const ds = kind === "ds";
	const code = ds ? dsRegionCode : mlRegionCode;
	const source = ds ? "function DeepSeekModelsEditor(props) {" : "function ModelListEditor(props) {";
	const names = ["react", "react_jsx_runtime", "ModelsSection_module_css_default", "formatCapacity", ...(ds ? ["parseCapacity", "IconPlusOutline16"] : []), "_deepseek_ai_dsh_client_ui_primitives"];
	const args = [reactStub, jsxRuntime, {}, (n) => String(n), ...(ds ? [(t) => Number(t), () => null] : []), primitivesStub];
	let error = "";
	let rendered = null;
	try {
		const factory = new Function(...names, code.replace(source, "function Editor(props) {") + "\n return { Editor };");
		const api = factory(...args);
		const t = (key) => key;
		const models = [{ id: "m", reasoningEfforts: { off: null, low: "low" }, input: ["text"], inputModalities: ["text"] }];
		rendered = api.Editor(ds
			? { models, onChange: () => {}, t, disabled: false, defaultContextWindow: 0, defaultMaxTokens: 0, overridden: true }
			: { models, onChange: () => {}, probe: { settingsNs: "llm-pi-ai" }, operations: {}, t, disabled: false });
	} catch (e) {
		error = String((e && e.message) || e);
	}
	return { rendered, error };
}

for (const [label, kind] of [["DeepSeekModelsEditor", "ds"], ["ModelListEditor", "ml"]]) {
	const { rendered, error } = renderRealEditor(kind);
	check(`${label} renders from the patched bundle with no scope error`, error === "", error);
	const texts = [];
	walk(rendered, (node) => {
		if (typeof node.props?.children === "string") texts.push(node.props.children);
	});
	check(`${label} renders the reasoning-effort field`, texts.includes("Reasoning efforts"), JSON.stringify(texts.slice(0, 8)));
	check(`${label} renders the modality field`, texts.includes("Accepted input"), JSON.stringify(texts.slice(0, 8)));
}

// --- the injected fragments are safe template bodies ------------------------
// They land inside String.raw templates. A backtick or a "${" anywhere in them
// would close the template early and splice the bundle's own text into the
// injected code, which is a corruption no syntax check of patch.js can see.
for (const [name, fragment] of Object.entries({
	SHARED_BLOCK: anchors.SHARED_BLOCK,
	DS_RENDERERS: anchors.DS_RENDERERS,
	ML_RENDERERS: anchors.ML_RENDERERS,
})) {
	check(`${name} carries no backtick`, !fragment.includes("`"));
	check(`${name} carries no interpolation`, !fragment.includes("${"));
}

// --- revert is exact --------------------------------------------------------
const back = revert();
check("revert reports reverted", back.ok === true && back.action === "reverted", JSON.stringify(back));
check("revert restores the file byte-for-byte", sha(sandbox) === pristine, `${sha(sandbox).slice(0, 12)} vs ${pristine.slice(0, 12)}`);
check("marker is gone after revert", !fs.readFileSync(sandbox, "utf8").includes(MARKER));
check("revert restores the DS disclosure anchor", fs.readFileSync(sandbox, "utf8").includes(anchors.DS_ANCHOR_CHILDREN));
// The official field renderers must survive: deleting them would break the page.
check("revert restores the DS field renderer", fs.readFileSync(sandbox, "utf8").includes(anchors.DS_ANCHOR_DEFINITION));
check("revert restores the ML disclosure anchor", fs.readFileSync(sandbox, "utf8").includes(anchors.ML_ANCHOR_CHILDREN));
check("revert restores the ML field definition", fs.readFileSync(sandbox, "utf8").includes(anchors.ML_ANCHOR_DEFINITION));
check("revert restores the shared region boundary", fs.readFileSync(sandbox, "utf8").includes(anchors.SHARED_ANCHOR));
let revertedSyntaxOk = true;
let revertedSyntaxDetail = "";
try {
	execFileSync(process.execPath, ["--check", sandbox], { stdio: "pipe" });
} catch (error) {
	revertedSyntaxOk = false;
	revertedSyntaxDetail = String(error.stderr ?? error).slice(0, 200);
}
check("the reverted bundle is valid JavaScript", revertedSyntaxOk, revertedSyntaxDetail);
check("status reports clean", status().patched === false);
const again = revert();
check("a second revert is a no-op", again.ok === true && again.action === "already-clean", JSON.stringify(again));

// --- a bundle without the anchors is refused, not mangled -------------------
const orphanFile = path.join(dir, "orphan.js");
fs.writeFileSync(orphanFile, "window.__ModuleLoader__.load({});\n");
process.env.DSH_MODEL_EXTENDED_CLIENT_BUNDLE = orphanFile;
const orphanBefore = sha(orphanFile);
const refused = apply();
check("a bundle without anchors is refused", refused.ok === false && refused.action === "anchor-not-found", JSON.stringify(refused));
check("a refused apply leaves the file untouched", sha(orphanFile) === orphanBefore);

// --- no bundle at all --------------------------------------------------------
process.env.DSH_MODEL_EXTENDED_CLIENT_BUNDLE = path.join(dir, "does-not-exist.js");
const missing = apply();
check("a missing bundle is reported", missing.ok === false && missing.action === "not-found", JSON.stringify(missing));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
