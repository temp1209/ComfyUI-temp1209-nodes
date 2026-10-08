// Tag autocomplete that works in any <textarea>, regardless of which
// widget-rendering system owns it (Litegraph/Graph mode, or the Vue
// "App Mode" / Nodes 2.0 widgets that neither ComfyUI-Custom-Scripts nor
// ComfyUI-Autocomplete-Plus can hook into, since both patch the legacy
// ComfyWidgets.STRING widget factory).
//
// Rather than maintaining a separate tag dataset, this reuses the data
// ComfyUI-Autocomplete-Plus (fork: temp1209/ComfyUI-Autocomplete-Plus)
// already loads - tags, aliases (incl. the added Japanese/romaji readings),
// the FlexSearch index, and the tag co-occurrence map - via its exported
// `autoCompleteData` singleton. ES modules are cached per URL, so importing
// the same module path here shares the same in-memory data that extension
// populates, with no separate fetch/parse of our own.
//
// Shows automatically as you type, like that extension's own popup - but
// backs off whenever that extension's popup (#autocomplete-plus-root) is
// visible, so the two never appear stacked on the same textarea. Ctrl+Space
// still force-opens it on demand.

import { autoCompleteData, getEnabledTagSourceInPriorityOrder } from "../ComfyUI-Autocomplete-Plus/js/data.js";
import { isRomaji, toHiragana } from "../ComfyUI-Autocomplete-Plus/js/thirdparty/wanakana.esm.js";

const MAX_RESULTS = 30;
const MAX_RELATED = 8;
const MIN_CHARS = 2;
const INPUT_DEBOUNCE_MS = 120;
const DATA_READY_POLL_MS = 200;
const DATA_READY_TIMEOUT_MS = 15000;

function kataToHira(str) {
	return str.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
function hiraToKata(str) {
	return str.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
}

async function waitForAnySourceReady() {
	const deadline = Date.now() + DATA_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const sources = getEnabledTagSourceInPriorityOrder();
		if (sources.some((s) => autoCompleteData[s]?.initialized)) return true;
		await new Promise((r) => setTimeout(r, DATA_READY_POLL_MS));
	}
	return false;
}

function buildQueryVariations(partialTag) {
	const variations = new Set([partialTag, partialTag.toLowerCase()]);
	const kata = hiraToKata(partialTag);
	if (kata !== partialTag) variations.add(kata);
	const hira = kataToHira(partialTag);
	if (hira !== partialTag) variations.add(hira);
	if (isRomaji(partialTag)) {
		const romajiHira = toHiragana(partialTag);
		if (romajiHira !== partialTag) variations.add(romajiHira);
	}
	return variations;
}

function searchTags(partialTag) {
	const queryVariations = buildQueryVariations(partialTag);
	const results = [];
	const seenIds = new Set();

	for (const source of getEnabledTagSourceInPriorityOrder()) {
		const data = autoCompleteData[source];
		if (!data?.flexSearchDocument) continue;

		for (const query of queryVariations) {
			const hits = data.flexSearchDocument.search(query, {
				field: ["tag", "alias"],
				limit: Math.min(MAX_RESULTS * 5, 300),
				merge: true,
				suggest: false,
				cache: true,
			});
			for (const hit of hits || []) {
				const key = `${source}:${hit.id}`;
				if (seenIds.has(key)) continue;
				seenIds.add(key);
				const tagData = data.sortedTags[hit.id];
				if (tagData) results.push(tagData);
			}
		}
	}

	results.sort((a, b) => b.count - a.count);
	return results.slice(0, MAX_RESULTS);
}

const WILDCARD_LIST_TTL_MS = 10000;
let wildcardListCache = null;
let wildcardListFetchedAt = 0;

// Wildcard names, unlike the tag dataset above, live behind our own
// /temp1209/wildcards route (see server.py) and can change any time the user
// edits them in the sidebar tab (web/wildcard_editor.js) - so this is
// re-fetched periodically rather than loaded once, but still cached briefly
// to avoid a request on every keystroke.
async function getWildcardNames() {
	const now = Date.now();
	if (wildcardListCache && now - wildcardListFetchedAt < WILDCARD_LIST_TTL_MS) return wildcardListCache;
	try {
		const res = await fetch("/temp1209/wildcards");
		if (res.ok) {
			wildcardListCache = (await res.json()).map((path) => path.replace(/\.txt$/, ""));
			wildcardListFetchedAt = now;
		}
	} catch {
		// keep serving the stale cache (or empty list) on network hiccups
	}
	return wildcardListCache || [];
}

function searchWildcards(partialName, names) {
	const query = partialName.toLowerCase();
	return names
		.filter((name) => name.toLowerCase().includes(query))
		.sort((a, b) => a.length - b.length || a.localeCompare(b))
		.slice(0, MAX_RESULTS)
		.map((name) => ({ tag: `__${name}__`, alias: [] }));
}

function relatedTagsFor(tagName) {
	const related = [];
	for (const source of getEnabledTagSourceInPriorityOrder()) {
		const data = autoCompleteData[source];
		const pairs = data?.cooccurrenceMap?.get(tagName);
		if (!pairs) continue;
		for (const [otherTag, count] of pairs) {
			related.push({ tag: otherTag, count });
		}
	}
	related.sort((a, b) => b.count - a.count);
	return related.slice(0, MAX_RELATED);
}

const MIRROR_PROPS = [
	"boxSizing", "width", "height", "overflowX", "overflowY",
	"borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle",
	"paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
	"fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "lineHeight", "fontFamily",
	"textAlign", "textTransform", "textIndent", "letterSpacing", "tabSize",
];

// Textareas have no native API for "where on screen is character N" - only
// the whole element's bounding rect. That's fine for the short, roughly
// one-line widgets this was first built against, but breaks down for a tall
// multi-line textarea (e.g. the wildcard editor's sidebar tab): anchoring to
// the element's own top/bottom corners can land the dropdown far from the
// caret, even off past the top of the viewport. This mirrors the textarea's
// text into an offscreen div (same font/box metrics) up to the caret, then
// reads the resulting span's offset - the standard caret-coordinates trick.
function getCaretCoordinates(el, position) {
	const div = document.createElement("div");
	const style = div.style;
	const computed = window.getComputedStyle(el);

	style.position = "absolute";
	style.visibility = "hidden";
	style.whiteSpace = "pre-wrap";
	style.wordWrap = "break-word";
	for (const prop of MIRROR_PROPS) style[prop] = computed[prop];

	document.body.appendChild(div);
	div.textContent = el.value.slice(0, position);
	const span = document.createElement("span");
	span.textContent = el.value.slice(position) || ".";
	div.appendChild(span);

	const elRect = el.getBoundingClientRect();
	const coords = {
		left: elRect.left + span.offsetLeft - el.scrollLeft,
		top: elRect.top + span.offsetTop - el.scrollTop,
		bottom: elRect.top + span.offsetTop + span.offsetHeight - el.scrollTop,
	};

	document.body.removeChild(div);
	return coords;
}

function getCurrentToken(el) {
	const value = el.value;
	const cursor = el.selectionStart;
	let start = cursor;
	while (start > 0 && value[start - 1] !== "," && value[start - 1] !== "\n") start--;
	while (start < cursor && value[start] === " ") start++;
	return { start, end: cursor, text: value.slice(start, cursor) };
}

function insertCompletion(el, token, tag) {
	const before = el.value.slice(0, token.start);
	const after = el.value.slice(token.end);
	const insertion = tag + ", ";
	el.value = before + insertion + after;
	const pos = before.length + insertion.length;
	el.setSelectionRange(pos, pos);
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.focus();
}

class Dropdown {
	constructor(el, token, matches, related, onPick) {
		this.el = el;
		this.token = token;
		this.matches = matches;
		this.related = related;
		this.onPick = onPick;
		this.selectedIndex = 0;
		this.caret = getCaretCoordinates(el, token.end);

		this.root = document.createElement("div");
		this.root.className = "temp1209-autocomplete";
		Object.assign(this.root.style, {
			position: "fixed",
			zIndex: 10000,
			background: "#1a1a1a",
			border: "1px solid #444",
			borderRadius: "4px",
			maxHeight: "320px",
			overflowY: "auto",
			font: "13px monospace",
			color: "#ddd",
			boxShadow: "0 4px 12px rgba(0,0,0,0.5)",
		});

		this.items = matches.map((tagData) => this.buildRow(tagData, false));

		if (related.length) {
			const header = document.createElement("div");
			header.textContent = "Related";
			Object.assign(header.style, {
				padding: "3px 8px",
				fontSize: "11px",
				color: "#888",
				borderTop: "1px solid #333",
			});
			this.root.appendChild(header);
			for (const r of related) {
				this.items.push(this.buildRow(r, true));
			}
		}

		this.updateSelection();
		this.position();
		document.body.appendChild(this.root);
	}

	buildRow(tagData, isRelated) {
		const item = document.createElement("div");
		const alias = !isRelated && tagData.alias?.length ? `  (${tagData.alias[0]})` : "";
		item.textContent = tagData.tag + alias;
		Object.assign(item.style, {
			padding: "4px 8px",
			cursor: "pointer",
			whiteSpace: "nowrap",
		});
		item.addEventListener("mousedown", (e) => {
			e.preventDefault();
			this.onPick(tagData.tag);
		});
		this.root.appendChild(item);
		return item;
	}

	position() {
		const caret = this.caret;
		const maxWidth = 320;
		this.root.style.left = Math.min(caret.left, window.innerWidth - maxWidth - 4) + "px";
		this.root.style.minWidth = "200px";
		this.root.style.maxWidth = maxWidth + "px";
		const spaceBelow = window.innerHeight - caret.bottom;
		if (spaceBelow > 150 || spaceBelow > caret.top) {
			this.root.style.top = caret.bottom + 2 + "px";
		} else {
			this.root.style.bottom = window.innerHeight - caret.top + 2 + "px";
		}
	}

	updateSelection() {
		this.items.forEach((item, i) => {
			item.style.background = i === this.selectedIndex ? "#3a5" : "";
		});
		this.items[this.selectedIndex]?.scrollIntoView({ block: "nearest" });
	}

	move(delta) {
		this.selectedIndex = (this.selectedIndex + delta + this.items.length) % this.items.length;
		this.updateSelection();
	}

	confirm() {
		this.items[this.selectedIndex]?.dispatchEvent(new MouseEvent("mousedown"));
	}

	destroy() {
		this.root.remove();
	}
}

let activeDropdown = null;
let dataReadyPromise = null;

function closeDropdown() {
	if (activeDropdown) {
		activeDropdown.destroy();
		activeDropdown = null;
	}
}

async function openDropdown(el) {
	const token = getCurrentToken(el);
	if (!token.text) {
		closeDropdown();
		return;
	}

	let matches = [];
	let related = [];

	if (token.text.startsWith("__")) {
		// __name__ wildcard reference (comfyui-dynamicprompts) rather than a
		// tag - search wildcard filenames instead of the tag dataset.
		const partialName = token.text.slice(2).replace(/__$/, "");
		matches = searchWildcards(partialName, await getWildcardNames());
	} else {
		if (!dataReadyPromise) dataReadyPromise = waitForAnySourceReady();
		const ready = await dataReadyPromise;
		if (!ready) return;

		matches = searchTags(token.text);
		const topTag = matches[0]?.tag;
		related = topTag ? relatedTagsFor(topTag).filter((r) => !matches.some((m) => m.tag === r.tag)) : [];
	}

	closeDropdown();
	if (!matches.length && !related.length) return;

	activeDropdown = new Dropdown(el, token, matches, related, (tag) => {
		insertCompletion(el, token, tag);
		closeDropdown();
	});
}

function legacyPopupIsShowing() {
	// ComfyUI-Custom-Scripts' own autocomplete dropdown - back off if it's
	// up so the two never appear stacked on the same textarea.
	const el = document.querySelector(".pysssss-autocomplete");
	return !!el && el.children.length > 0;
}

function forkPopupIsShowing() {
	// ComfyUI-Autocomplete-Plus's own dropdown - same idea, for Graph mode
	// where that extension's own hook already handles this textarea.
	const el = document.getElementById("autocomplete-plus-root");
	return !!el && el.style.display !== "none" && el.querySelector("#autocomplete-plus-list")?.children.length > 0;
}

document.addEventListener(
	"keydown",
	(event) => {
		const el = document.activeElement;
		const isTextInput = el && el.tagName === "TEXTAREA";

		if (event.ctrlKey && event.code === "Space" && isTextInput) {
			event.preventDefault();
			event.stopImmediatePropagation();
			openDropdown(el);
			return;
		}

		if (!activeDropdown) return;

		// Once our dropdown is open, these keys are ours: swallow them so
		// other keydown listeners don't also react to the same keypress.
		if (event.key === "ArrowDown") {
			event.preventDefault();
			event.stopImmediatePropagation();
			activeDropdown.move(1);
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			event.stopImmediatePropagation();
			activeDropdown.move(-1);
		} else if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault();
			event.stopImmediatePropagation();
			activeDropdown.confirm();
		} else if (event.key === "Escape") {
			event.preventDefault();
			event.stopImmediatePropagation();
			closeDropdown();
		}
	},
	true
);

document.addEventListener("mousedown", (event) => {
	if (activeDropdown && !activeDropdown.root.contains(event.target)) {
		closeDropdown();
	}
});

let inputDebounceTimer = null;

document.addEventListener("input", (event) => {
	const el = event.target;
	if (!el || el.tagName !== "TEXTAREA") return;

	clearTimeout(inputDebounceTimer);
	inputDebounceTimer = setTimeout(() => {
		if (legacyPopupIsShowing() || forkPopupIsShowing()) {
			closeDropdown();
			return;
		}
		const token = getCurrentToken(el);
		if (token.text.length < MIN_CHARS) {
			closeDropdown();
			return;
		}
		openDropdown(el);
	}, INPUT_DEBOUNCE_MS);
});
