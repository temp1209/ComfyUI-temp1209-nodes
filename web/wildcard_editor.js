// Sidebar tab for editing the __name__ wildcard .txt files that
// comfyui-dynamicprompts resolves (custom_nodes/comfyui-dynamicprompts/wildcards/,
// see server.py's /temp1209/wildcards* routes). That extension has no GUI of
// its own for this - files could only be edited by opening them on disk -
// so this adds a simple list + textarea editor inside ComfyUI itself.

import { app } from "../../scripts/app.js";

const API_BASE = "/temp1209/wildcards";

async function listFiles() {
	const res = await fetch(API_BASE);
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}

async function loadFile(path) {
	const res = await fetch(`${API_BASE}/file?path=${encodeURIComponent(path)}`);
	if (!res.ok) throw new Error(await res.text());
	return res.json();
}

async function saveFile(path, content) {
	const res = await fetch(`${API_BASE}/file`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path, content }),
	});
	if (!res.ok) throw new Error(await res.text());
}

async function deleteFile(path) {
	const res = await fetch(`${API_BASE}/file?path=${encodeURIComponent(path)}`, { method: "DELETE" });
	if (!res.ok) throw new Error(await res.text());
}

function buildPanel(root) {
	root.innerHTML = "";
	Object.assign(root.style, {
		display: "flex",
		flexDirection: "column",
		height: "100%",
		font: "12px sans-serif",
		color: "var(--fg-color, #ddd)",
	});

	const toolbar = document.createElement("div");
	Object.assign(toolbar.style, { display: "flex", gap: "4px", padding: "6px", flexShrink: "0" });

	const newNameInput = document.createElement("input");
	newNameInput.placeholder = "新規ファイル名 (例: characters/foo.txt)";
	Object.assign(newNameInput.style, { flex: "1", minWidth: "0" });

	const newBtn = document.createElement("button");
	newBtn.textContent = "作成";

	const refreshBtn = document.createElement("button");
	refreshBtn.textContent = "更新";

	toolbar.append(newNameInput, newBtn, refreshBtn);

	const body = document.createElement("div");
	Object.assign(body.style, { display: "flex", flex: "1", minHeight: "0" });

	const list = document.createElement("div");
	Object.assign(list.style, {
		width: "160px",
		overflowY: "auto",
		borderRight: "1px solid #444",
		flexShrink: "0",
	});

	const editorPane = document.createElement("div");
	Object.assign(editorPane.style, { flex: "1", display: "flex", flexDirection: "column", minWidth: "0" });

	const pathLabel = document.createElement("div");
	Object.assign(pathLabel.style, {
		padding: "4px 6px",
		fontWeight: "bold",
		borderBottom: "1px solid #333",
		flexShrink: "0",
	});
	pathLabel.textContent = "ファイルを選択してください";

	const textarea = document.createElement("textarea");
	Object.assign(textarea.style, {
		flex: "1",
		resize: "none",
		font: "12px monospace",
		background: "var(--comfy-input-bg, #1a1a1a)",
		color: "inherit",
		border: "none",
		padding: "6px",
		boxSizing: "border-box",
	});
	textarea.disabled = true;

	const editorToolbar = document.createElement("div");
	Object.assign(editorToolbar.style, { display: "flex", gap: "4px", padding: "4px 6px", flexShrink: "0" });
	const saveBtn = document.createElement("button");
	saveBtn.textContent = "保存 (Ctrl+S)";
	saveBtn.disabled = true;
	const deleteBtn = document.createElement("button");
	deleteBtn.textContent = "削除";
	deleteBtn.disabled = true;
	const statusSpan = document.createElement("span");
	Object.assign(statusSpan.style, { marginLeft: "auto", opacity: "0.7", alignSelf: "center" });
	editorToolbar.append(saveBtn, deleteBtn, statusSpan);

	editorPane.append(pathLabel, textarea, editorToolbar);
	body.append(list, editorPane);
	root.append(toolbar, body);

	let currentPath = null;
	let dirty = false;

	function setStatus(text) {
		statusSpan.textContent = text;
	}

	function markDirty() {
		dirty = true;
		saveBtn.disabled = false;
		setStatus("未保存の変更があります");
	}

	async function refreshList() {
		const files = await listFiles();
		list.innerHTML = "";
		for (const path of files) {
			const item = document.createElement("div");
			item.textContent = path;
			Object.assign(item.style, {
				padding: "4px 8px",
				cursor: "pointer",
				whiteSpace: "nowrap",
				background: path === currentPath ? "var(--comfy-menu-bg, #333)" : "",
			});
			item.addEventListener("click", () => selectFile(path));
			list.appendChild(item);
		}
	}

	async function selectFile(path) {
		if (dirty && !confirm("保存されていない変更があります。破棄して切り替えますか?")) return;
		try {
			const data = await loadFile(path);
			currentPath = path;
			dirty = false;
			textarea.value = data.content;
			textarea.disabled = false;
			saveBtn.disabled = true;
			deleteBtn.disabled = false;
			pathLabel.textContent = path;
			setStatus("");
			await refreshList();
		} catch (e) {
			alert("読み込みに失敗しました: " + e.message);
		}
	}

	async function doSave() {
		if (!currentPath) return;
		try {
			await saveFile(currentPath, textarea.value);
			dirty = false;
			saveBtn.disabled = true;
			setStatus("保存しました");
		} catch (e) {
			alert("保存に失敗しました: " + e.message);
		}
	}

	textarea.addEventListener("input", markDirty);
	textarea.addEventListener("keydown", (e) => {
		if ((e.ctrlKey || e.metaKey) && e.key === "s") {
			e.preventDefault();
			doSave();
		}
	});
	saveBtn.addEventListener("click", doSave);

	deleteBtn.addEventListener("click", async () => {
		if (!currentPath) return;
		if (!confirm(`${currentPath} を削除しますか?`)) return;
		try {
			await deleteFile(currentPath);
			currentPath = null;
			dirty = false;
			textarea.value = "";
			textarea.disabled = true;
			saveBtn.disabled = true;
			deleteBtn.disabled = true;
			pathLabel.textContent = "ファイルを選択してください";
			setStatus("");
			await refreshList();
		} catch (e) {
			alert("削除に失敗しました: " + e.message);
		}
	});

	newBtn.addEventListener("click", async () => {
		let name = newNameInput.value.trim();
		if (!name) return;
		if (!name.endsWith(".txt")) name += ".txt";
		try {
			await saveFile(name, "");
			newNameInput.value = "";
			await selectFile(name);
		} catch (e) {
			alert("作成に失敗しました: " + e.message);
		}
	});

	refreshBtn.addEventListener("click", () => refreshList());

	refreshList();
}

app.registerExtension({
	name: "Temp1209.WildcardEditor",
	async setup() {
		app.extensionManager.registerSidebarTab({
			id: "temp1209-wildcard-editor",
			title: "ワイルドカード",
			icon: "pi pi-list",
			tooltip: "ワイルドカード (__name__) ファイルの編集",
			type: "custom",
			render: (el) => buildPanel(el),
		});
	},
});
