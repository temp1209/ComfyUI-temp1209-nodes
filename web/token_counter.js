// Live CLIP token counter under prompt textareas in App Mode (and Nodes 2.0,
// which renders widgets with the same Vue component). Existing counters
// either need a graph run (CLIPTokenCounter-style nodes) or hook the legacy
// Litegraph widget (ComfyUI-RyuuNoodles), so neither shows up in App Mode.
//
// Tokenization happens server-side (/temp1209/tokenize, see server.py) with
// ComfyUI's own SDXL tokenizer. The chunking mirrors whichever encode node
// the prompt ends up in (found by following the graph's links downstream):
// core CLIPTextEncode cuts hard at 75 tokens, possibly mid-tag; the
// clip-with-break node does the same within each BREAK part; our Smart Chunk
// node (chunking.py) splits at commas like A1111. Click the badge for a
// per-chunk breakdown with any tag straddling a boundary highlighted.
//
// Legacy Graph-mode textareas (Nodes 2.0 off) are intentionally skipped:
// they're absolutely positioned over the canvas, so an in-flow badge would
// land in the wrong place.

const CHUNK = 75;
const DEBOUNCE_MS = 250;
const RECHECK_MS = 1000;
const NEAR_BOUNDARY = 5;
const PROMPT_NODE_TYPES = /CLIPTextEncode|DPRandomGenerator|DPCombinatorialGenerator|Prompt|StringMultiline/i;

const ENCODER_MODES = [
	[/^Temp1209CLIPTextEncodeSmartChunk$/, "smart"],
	[/CLIPTextEncodeWithBreak$/, "break"],
	[/CLIPTextEncode/, "standard"],
];
const MODE_LABEL = { standard: "標準", break: "BREAK", smart: "Smart" };
const MAX_HOPS = 8;

const attached = new Map(); // textarea -> { badge, lastKey, timer, data }

const style = document.createElement("style");
style.textContent = `
.t1209-tok-badge { font: 11px/1.4 ui-monospace, monospace; color: var(--p-text-muted-color, #999);
	text-align: right; padding: 2px 4px 0; cursor: pointer; user-select: none; }
.t1209-tok-badge:hover { text-decoration: underline; }
.t1209-tok-badge.near { color: #e0a040; }
.t1209-tok-pop { position: fixed; z-index: 10000; max-width: 560px; max-height: 60vh; overflow: auto;
	background: var(--comfy-menu-bg, #222); color: var(--fg-color, #ddd); border: 1px solid #555;
	border-radius: 8px; padding: 10px 12px; font: 12px/1.5 ui-monospace, monospace; box-shadow: 0 4px 16px #0008; }
.t1209-tok-pop h4 { margin: 8px 0 2px; font-size: 12px; color: #9ab; }
.t1209-tok-pop h4:first-child { margin-top: 0; }
.t1209-tok-pop .split { background: #a5402a; color: #fff; border-radius: 3px; padding: 0 2px; }
.t1209-tok-pop .note { color: #e0a040; margin-bottom: 6px; }
`;
document.head.appendChild(style);

function nodeOf(ta) {
	const grid = ta.closest("[data-widgets-grid-node-id]");
	return grid && window.app?.graph?.getNodeById?.(Number(grid.dataset.widgetsGridNodeId));
}

// Breadth-first downstream from the textarea's node to the nearest encode
// node; its type decides how chunks are cut. Falls back to core behaviour.
function detectMode(node) {
	const graph = window.app?.graph;
	if (!node || !graph) return "standard";
	const getLink = (id) => graph.getLink?.(id) ?? (graph.links instanceof Map ? graph.links.get(id) : graph.links?.[id]);
	const seen = new Set([node.id]);
	let frontier = [node];
	for (let hop = 0; hop <= MAX_HOPS && frontier.length; hop++) {
		const next = [];
		for (const n of frontier) {
			for (const [re, mode] of ENCODER_MODES) if (re.test(n.type)) return mode;
			for (const out of n.outputs ?? []) {
				for (const id of out.links ?? []) {
					const target = graph.getNodeById(getLink(id)?.target_id);
					if (target && !seen.has(target.id)) {
						seen.add(target.id);
						next.push(target);
					}
				}
			}
		}
		frontier = next;
	}
	return "standard";
}

function isPromptTextarea(ta) {
	if (!ta.closest(".lg-node-widget")) return false;
	const node = nodeOf(ta);
	// Nodes inside subgraphs aren't reachable by id from the root graph -
	// show the counter anyway rather than silently dropping it.
	return !node || PROMPT_NODE_TYPES.test(node.type);
}

const detok = (t) => t.replace(/<\/w>/g, " ");
const isComma = (tok) => tok && /^,(<\/w>)?$/.test(tok.t);

// A tag straddles boundary i if the chunk doesn't end on a comma and the
// next doesn't start with one. Returns [startIdx in chunk i, endIdx in chunk i+1).
function straddle(chunks, i) {
	const a = chunks[i], b = chunks[i + 1];
	if (!b?.length || isComma(a[a.length - 1]) || isComma(b[0])) return null;
	let s = a.length - 1;
	while (s > 0 && !isComma(a[s - 1])) s--;
	let e = 0;
	while (e < b.length && !isComma(b[e])) e++;
	return [s, e];
}

function summary(data) {
	const n = data.chunks.length || 1;
	const last = data.chunks[data.chunks.length - 1]?.length ?? 0;
	const left = CHUNK - last;
	const splits = data.chunks.slice(0, -1).filter((_, i) => straddle(data.chunks, i)).length;
	let s = `${data.unresolved ? "≈" : ""}${data.total} tok · ${n}チャンク · 区切りまで残り${left} · ${MODE_LABEL[data.mode] ?? data.mode}`;
	if (splits) s += ` · ⚠途中分割${splits}`;
	return { text: s, near: left <= NEAR_BOUNDARY || splits > 0 };
}

function esc(s) {
	return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

let pop = null;
function closePop() {
	pop?.remove();
	pop = null;
}

function openPop(badge, data) {
	closePop();
	pop = document.createElement("div");
	pop.className = "t1209-tok-pop";
	let html = "";
	if (data.unresolved)
		html += `<div class="note">{a|b} や複数候補のワイルドカードは未展開のまま数えています（実際の数は生成ごとに変わります）</div>`;
	html += `<div>区切り方：${
		{ standard: "標準（75トークンで機械的に切る）", break: "BREAK（BREAKで切り、各部分の中は75トークンで機械的に切る）", smart: "Smart Chunk（カンマ位置で切る）" }[data.mode] ?? data.mode
	}</div>`;
	if (data.hasBreak && data.mode === "standard")
		html += `<div class="note">このプロンプトの先は標準のCLIPTextEncodeで、BREAKを解釈しません（"break"という単語として数えています）</div>`;
	data.chunks.forEach((c, i) => {
		const tail = i > 0 ? straddle(data.chunks, i - 1) : null;
		const head = straddle(data.chunks, i);
		html += `<h4>チャンク${i + 1}（${c.length}/${CHUNK}）</h4><div>`;
		c.forEach((tok, j) => {
			const inSplit = (tail && j < tail[1]) || (head && j >= head[0]);
			html += inSplit ? `<span class="split">${esc(detok(tok.t))}</span>` : esc(detok(tok.t));
		});
		html += "</div>";
	});
	pop.innerHTML = html;
	document.body.appendChild(pop);
	const r = badge.getBoundingClientRect();
	const pr = pop.getBoundingClientRect();
	pop.style.left = `${Math.max(8, Math.min(r.right - pr.width, innerWidth - pr.width - 8))}px`;
	pop.style.top = r.bottom + pr.height + 8 < innerHeight ? `${r.bottom + 4}px` : `${Math.max(8, r.top - pr.height - 4)}px`;
}

document.addEventListener("mousedown", (e) => {
	if (pop && !pop.contains(e.target) && !e.target.classList?.contains("t1209-tok-badge")) closePop();
});
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape") closePop();
});

const cacheKey = (mode, text) => JSON.stringify([mode, text]);

async function count(ta) {
	const st = attached.get(ta);
	if (!st) return;
	const text = ta.value;
	const mode = detectMode(nodeOf(ta));
	const key = cacheKey(mode, text);
	st.lastKey = key;
	try {
		const res = await fetch("/temp1209/tokenize", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text, mode }),
		});
		if (!res.ok || st.lastKey !== key) return;
		st.data = await res.json();
		const { text: label, near } = summary(st.data);
		st.badge.textContent = label;
		st.badge.classList.toggle("near", near);
	} catch {
		st.badge.textContent = "tok: 取得失敗";
	}
}

function schedule(ta) {
	const st = attached.get(ta);
	clearTimeout(st.timer);
	st.timer = setTimeout(() => count(ta), DEBOUNCE_MS);
}

function ensureBadge(ta) {
	let st = attached.get(ta);
	if (st && st.badge.isConnected) return;
	const badge = st?.badge ?? document.createElement("div");
	badge.className = "t1209-tok-badge";
	badge.title = "クリックでチャンクごとの内訳";
	badge.addEventListener("click", () => {
		const s = attached.get(ta);
		if (pop) closePop();
		else if (s?.data) openPop(badge, s.data);
	});
	ta.parentElement.appendChild(badge);
	if (!st) {
		st = { badge, lastKey: null, timer: null, data: null };
		attached.set(ta, st);
		ta.addEventListener("input", () => schedule(ta));
		count(ta);
	}
}

function scan() {
	for (const ta of document.querySelectorAll(".lg-node-widget textarea")) {
		if (ta.offsetParent && isPromptTextarea(ta)) ensureBadge(ta);
	}
	for (const [ta, st] of attached) {
		if (!ta.isConnected) {
			st.badge.remove();
			attached.delete(ta);
		} else if (cacheKey(detectMode(nodeOf(ta)), ta.value) !== st.lastKey) {
			// Programmatic changes (workflow load, autocomplete insert, rewiring) don't fire input.
			schedule(ta);
		}
	}
}

let scanQueued = false;
new MutationObserver(() => {
	if (scanQueued) return;
	scanQueued = true;
	requestAnimationFrame(() => {
		scanQueued = false;
		scan();
	});
}).observe(document.body, { childList: true, subtree: true });
setInterval(scan, RECHECK_MS);
