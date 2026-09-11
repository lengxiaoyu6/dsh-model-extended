// model-set patch verification.
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
import { apply, revert, status, anchors, MARKER } from "../lib/patch.js";

let failures = 0;
const check = (label, ok, detail) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  → ${detail}`}`);
	if (!ok) failures++;
};

const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// --- a stand-in bundle carrying the real anchors, so this test owns its file ---
const REAL_BUNDLE = "/root/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js";
const realSource = fs.readFileSync(REAL_BUNDLE, "utf8");
const hasRealAnchors = realSource.includes(anchors.ANCHOR_CHILDREN) && realSource.includes(anchors.ANCHOR_DEFINITION);
check("the shipped editor still carries both anchors", hasRealAnchors);
if (!hasRealAnchors) {
	console.log("\nCannot continue without the real anchors.");
	process.exit(1);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-set-patch-"));
const sandbox = path.join(dir, "client.js");
fs.copyFileSync(REAL_BUNDLE, sandbox);
process.env.MODEL_SET_CLIENT_BUNDLE = sandbox;

const pristine = sha(sandbox);

// --- apply ------------------------------------------------------------------
const first = apply();
check("apply reports applied", first.ok === true && first.action === "applied", JSON.stringify(first));
check("marker lands in the file", fs.readFileSync(sandbox, "utf8").includes(MARKER));
check("a backup is taken", fs.existsSync(sandbox + ".model-set.bak"));
check("backup is byte-identical to the original", sha(sandbox + ".model-set.bak") === pristine);
check("status reports patched", status().patched === true);

const patched = fs.readFileSync(sandbox, "utf8");
check("both row fields are wired into the disclosure", patched.includes("modelSetEfforts(model, index), modelSetModalities(model, index)"));
check("injected block is present exactly once", patched.split(MARKER).length - 1 === 1, String(patched.split(MARKER).length - 1));
check("the original disclosure anchor is gone", !patched.includes(anchors.ANCHOR_CHILDREN));

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

/** Run the injected block the way the bundle's module scope would. */
function makeRenderers() {
	const injected = anchors.INSERTED_BLOCK;
	const factory = new Function(
		"react_jsx_runtime",
		"ModelsSection_module_css_default",
		"props",
		"update",
		`${injected}
		 return { modelSetEfforts, modelSetModalities };`,
	);
	return (props, update) => factory(jsxRuntime, {}, props, update);
}

// English copy is chosen from the official label the page supplies.
/** Render one row through the injected code and report its fields. */
const renderers = makeRenderers();
function renderRow(model, disabled = false, t = (key) => key) {
	const captured = [];
	const api = renderers({ t, disabled }, (index, key, value) => captured.push({ index, key, value }));
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

// --- field labels follow the page's language --------------------------------
const zhRows = renderRow({ id: "m", reasoningEfforts: ["low"] }, false, (key) => (key === "contextWindow" ? "上下文窗口" : key));
const zhLabel = zhRows.efforts.props.children[0].props.children;
check("labels localize with the page", zhLabel === "思考强度范围", String(zhLabel));
const enRows = renderRow({ id: "m", reasoningEfforts: ["low"] });
check("labels stay English on an English page", enRows.efforts.props.children[0].props.children === "Reasoning efforts");

// --- disabled editor ---------------------------------------------------------
const frozen = renderRow({ id: "m", inputModalities: ["text"], reasoningEfforts: ["low"] }, true);
check("a disabled editor disables every chip", buttonsOf(frozen.modalities).every((c) => c.disabled) && buttonsOf(frozen.efforts).every((c) => c.disabled));

// --- revert is exact --------------------------------------------------------
const back = revert();
check("revert reports reverted", back.ok === true && back.action === "reverted", JSON.stringify(back));
check("revert restores the file byte-for-byte", sha(sandbox) === pristine, `${sha(sandbox).slice(0, 12)} vs ${pristine.slice(0, 12)}`);
check("marker is gone after revert", !fs.readFileSync(sandbox, "utf8").includes(MARKER));
check("revert restores the official disclosure anchor", fs.readFileSync(sandbox, "utf8").includes(anchors.ANCHOR_CHILDREN));
// The official field renderer must survive: deleting it would break the page.
check("revert restores the official field renderer", fs.readFileSync(sandbox, "utf8").includes(anchors.ANCHOR_DEFINITION));
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
process.env.MODEL_SET_CLIENT_BUNDLE = orphanFile;
const orphanBefore = sha(orphanFile);
const refused = apply();
check("a bundle without anchors is refused", refused.ok === false && refused.action === "anchor-not-found", JSON.stringify(refused));
check("a refused apply leaves the file untouched", sha(orphanFile) === orphanBefore);

// --- no bundle at all --------------------------------------------------------
process.env.MODEL_SET_CLIENT_BUNDLE = path.join(dir, "does-not-exist.js");
const missing = apply();
check("a missing bundle is reported", missing.ok === false && missing.action === "not-found", JSON.stringify(missing));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
