// One-click "Hires fix this" on the App Mode result view. Looks up the run
// that produced the displayed image (/temp1209/hires_rerun, see server.py),
// gets back that exact prompt with the "Hire Fix" boolean switched on, and
// queues it - same seeds, same resolved wildcards - so the result is what
// that image would have been with hires on, without touching the workflow's
// own Hire Fix toggle or re-picking anything.
//
// App Mode only lists results of jobs it has mapped to the open workflow
// (execution store's jobIdToSessionWorkflowPath, filled when the frontend
// itself queues). A job posted straight to /api/prompt isn't in that map, so
// registerWithAppMode() adds it - otherwise the result would only show up in
// the queue/assets panel. That store is frontend-internal (checked against
// comfyui-frontend-package 1.49.6); if it changes, the job still runs and
// only the App Mode display is lost.

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const PANEL = '[data-testid="linear-center-panel"]';
const RESET_MS = 2500;

const style = document.createElement("style");
style.textContent = `
.t1209-hires-btn { position: absolute; top: 12px; right: 12px; z-index: 20; padding: 6px 12px;
	border-radius: 8px; border: 1px solid #fff3; background: #000a; color: #fff; font-size: 13px;
	cursor: pointer; backdrop-filter: blur(4px); }
.t1209-hires-btn:hover:not(:disabled) { background: #2563ebcc; }
.t1209-hires-btn:disabled { opacity: .7; cursor: default; }
`;
document.head.appendChild(style);

function currentImage(panel) {
	const img = panel.querySelector("img.object-contain");
	if (!img?.src) return null;
	const url = new URL(img.src, location.href);
	if (!/\/view$/.test(url.pathname) || (url.searchParams.get("type") ?? "output") !== "output") return null;
	return { filename: url.searchParams.get("filename"), subfolder: url.searchParams.get("subfolder") ?? "" };
}

function piniaStore(id) {
	const pinia = document.querySelector("#vue-app")?.__vue_app__?.config?.globalProperties?.$pinia;
	return pinia?._s?.get(id);
}

function registerWithAppMode(promptId) {
	try {
		const path = piniaStore("workflow")?.activeWorkflow?.path;
		const execution = piniaStore("execution");
		if (path && typeof execution?.ensureSessionWorkflowPath === "function") {
			execution.ensureSessionWorkflowPath(promptId, path);
			return true;
		}
	} catch (e) {
		console.warn("[temp1209] couldn't register hires job with App Mode", e);
	}
	return false;
}

function notify(severity, detail) {
	const toast = app.extensionManager?.toast;
	if (toast?.add) toast.add({ severity, summary: "Hires fix", detail, life: 4000 });
}

async function run(btn, target) {
	btn.disabled = true;
	btn.textContent = "送信中…";
	try {
		const res = await fetch("/temp1209/hires_rerun", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(target),
		});
		const data = await res.json();
		if (!res.ok) throw new Error(data.error ?? res.statusText);
		const q = await fetch("/api/prompt", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt: data.prompt, extra_data: data.extra_data, client_id: api.clientId }),
		});
		const queued = await q.json().catch(() => ({}));
		if (!q.ok) throw new Error(queued.error?.message ?? `キューへの追加に失敗しました（${q.status}）`);
		const shown = queued.prompt_id && registerWithAppMode(queued.prompt_id);
		btn.textContent = "✓ キューに追加";
		notify("success", `${target.filename} をHires fixで再生成します${shown ? "" : "（結果はキュー／アセット欄に出ます）"}`);
	} catch (e) {
		btn.textContent = "✕ 失敗";
		notify("error", e.message);
	}
	setTimeout(() => {
		btn.disabled = false;
		btn.textContent = "✨ Hires fix";
	}, RESET_MS);
}

function sync() {
	const panel = document.querySelector(PANEL);
	if (!panel) return;
	let btn = panel.querySelector(".t1209-hires-btn");
	const target = currentImage(panel);
	if (!target) {
		btn?.remove();
		return;
	}
	if (!btn) {
		btn = document.createElement("button");
		btn.className = "t1209-hires-btn";
		btn.textContent = "✨ Hires fix";
		btn.title = "この画像をHires fixありで再生成（seed・プロンプトはそのまま）";
		// Re-read the target at click time - the panel swaps images in place.
		btn.addEventListener("click", () => {
			const t = currentImage(panel);
			if (t) run(btn, t);
		});
		panel.appendChild(btn);
	}
}

// Coalesce bursts of mutations. setTimeout rather than requestAnimationFrame:
// rAF doesn't fire while the tab isn't painting (background/hidden), which
// would leave the button missing until something forced a repaint.
let queued = false;
new MutationObserver(() => {
	if (queued) return;
	queued = true;
	setTimeout(() => {
		queued = false;
		sync();
	}, 50);
}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
