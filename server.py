import copy
import os
import re

from aiohttp import web
from server import PromptServer

import folder_paths

from .chunking import flatten, rechunk, split_break

DATE_FOLDER_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
RECENT_DATE_FOLDERS = 7


@web.middleware
async def fix_view_subfolder_middleware(request: web.Request, handler):
    """Workaround for a ComfyUI frontend bug (Comfy-Org/ComfyUI_frontend#12437,
    fix pending in #12438): the Assets picker builds thumbnail URLs by putting
    a subfolder-prefixed combo value straight into the `filename` query param
    instead of splitting it into filename+subfolder, so core's /view handler
    404s on anything living in a subfolder (e.g. our date-folder output
    layout). Split it ourselves before the request reaches core's handler.
    Remove this once #12438 lands upstream."""
    if request.path in ("/view", "/api/view"):
        filename = request.query.get("filename", "")
        if "/" in filename and "subfolder" not in request.query:
            subfolder, _sep, name = filename.rpartition("/")
            new_query = dict(request.query)
            new_query["filename"] = name
            new_query["subfolder"] = subfolder
            request = request.clone(rel_url=request.rel_url.with_query(new_query))
    return await handler(request)


PromptServer.instance.app.middlewares.append(fix_view_subfolder_middleware)


@PromptServer.instance.routes.get("/temp1209/files/output")
async def list_output_files_recursive(request):
    """Same response shape as core's /internal/files/output, but also looks
    inside the YYYY-MM-DD date subfolders Save Image With Prompt saves into
    (the core route only os.scandir()s the top level, so it can't see those
    at all). Bounded to the most recent RECENT_DATE_FOLDERS date folders so
    this stays fast as history piles up - this node is for pulling the
    prompt back off something you just generated, not archive browsing.
    Other subfolders (e.g. video/, Animation/) aren't walked; older files
    can still be loaded by typing their path into the node directly."""
    directory = folder_paths.get_output_directory()
    entries = []

    def add_file(full_path, rel_path):
        try:
            mtime = os.path.getmtime(full_path)
        except OSError:
            return
        entries.append((mtime, rel_path))

    try:
        top_entries = list(os.scandir(directory))
    except FileNotFoundError:
        top_entries = []

    for entry in top_entries:
        if entry.is_file() and not entry.name.startswith('.'):
            add_file(entry.path, entry.name)

    date_dirs = sorted(
        (e.name for e in top_entries if e.is_dir() and DATE_FOLDER_RE.match(e.name)),
        reverse=True,
    )[:RECENT_DATE_FOLDERS]

    for date_dir in date_dirs:
        date_dir_path = os.path.join(directory, date_dir)
        for name in os.listdir(date_dir_path):
            full_path = os.path.join(date_dir_path, name)
            if os.path.isfile(full_path) and not name.startswith('.'):
                add_file(full_path, f"{date_dir}/{name}")

    entries.sort(key=lambda e: -e[0])
    return web.json_response([f"{rel} [output]" for _mtime, rel in entries])


# --- Wildcard editor -------------------------------------------------------
# GUI for editing the __name__ wildcard .txt files that comfyui-dynamicprompts
# resolves (sibling custom_nodes install, not this repo). Its own web
# extension has no editing UI - files could only be edited by opening them
# directly on disk - so this exposes list/read/write/delete over HTTP for a
# sidebar tab (see web/wildcard_editor.js) to drive.
WILDCARDS_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "comfyui-dynamicprompts", "wildcards")
)


def _resolve_wildcard_path(rel_path):
    """Resolve rel_path under WILDCARDS_DIR, raising ValueError if it would
    escape that directory (path traversal via "../")."""
    if not rel_path:
        raise ValueError("empty path")
    full_path = os.path.normpath(os.path.join(WILDCARDS_DIR, rel_path))
    if os.path.commonpath([full_path, WILDCARDS_DIR]) != WILDCARDS_DIR:
        raise ValueError("path escapes wildcards directory")
    return full_path


@PromptServer.instance.routes.get("/temp1209/wildcards")
async def list_wildcard_files(request):
    """Lists every .txt file under WILDCARDS_DIR recursively, as POSIX-style
    paths relative to it (e.g. "characters/foo.txt") - matching how
    DynamicPrompts addresses subfolders in __category/name__ syntax."""
    entries = []
    for root, _dirs, files in os.walk(WILDCARDS_DIR):
        for name in files:
            if not name.endswith(".txt"):
                continue
            full_path = os.path.join(root, name)
            rel_path = os.path.relpath(full_path, WILDCARDS_DIR).replace(os.sep, "/")
            entries.append(rel_path)
    entries.sort()
    return web.json_response(entries)


@PromptServer.instance.routes.get("/temp1209/wildcards/file")
async def read_wildcard_file(request):
    try:
        full_path = _resolve_wildcard_path(request.query.get("path", ""))
    except ValueError:
        return web.json_response({"error": "invalid path"}, status=400)
    try:
        with open(full_path, "r", encoding="utf-8") as f:
            content = f.read()
    except FileNotFoundError:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response({"content": content})


@PromptServer.instance.routes.post("/temp1209/wildcards/file")
async def write_wildcard_file(request):
    """Writes (creating parent folders and the file itself as needed) - used
    for both saving edits and creating brand-new wildcard files."""
    body = await request.json()
    rel_path = body.get("path", "")
    if not rel_path.endswith(".txt"):
        return web.json_response({"error": "path must end with .txt"}, status=400)
    try:
        full_path = _resolve_wildcard_path(rel_path)
    except ValueError:
        return web.json_response({"error": "invalid path"}, status=400)
    os.makedirs(os.path.dirname(full_path), exist_ok=True)
    with open(full_path, "w", encoding="utf-8", newline="\n") as f:
        f.write(body.get("content", ""))
    return web.json_response({"status": "ok"})


@PromptServer.instance.routes.delete("/temp1209/wildcards/file")
async def delete_wildcard_file(request):
    try:
        full_path = _resolve_wildcard_path(request.query.get("path", ""))
    except ValueError:
        return web.json_response({"error": "invalid path"}, status=400)
    try:
        os.remove(full_path)
    except FileNotFoundError:
        return web.json_response({"error": "not found"}, status=404)
    return web.json_response({"status": "ok"})


# --- Token counter -----------------------------------------------------------
# Backs web/token_counter.js. Tokenizes with ComfyUI's own SDXL tokenizer (the
# same class CLIPTextEncode uses for SDXL/Illustrious checkpoints), so chunk
# boundaries match what actually gets encoded - including ComfyUI's
# behaviour of cutting hard at 75 tokens mid-tag, which differs from A1111's
# comma-aware split. clip_g chunks identically to clip_l, so only clip_l is
# reported.
_WILDCARD_REF = re.compile(r"__([\w\-/]+)__")
_tokenizer = None


def _get_tokenizer():
    global _tokenizer
    if _tokenizer is None:
        from comfy.sdxl_clip import SDXLTokenizer
        _tokenizer = SDXLTokenizer(embedding_directory=folder_paths.get_folder_paths("embeddings"))
    return _tokenizer


def _wildcard_options(name):
    try:
        with open(_resolve_wildcard_path(name + ".txt"), "r", encoding="utf-8") as f:
            return [l.strip() for l in f if l.strip() and not l.lstrip().startswith("#")]
    except (ValueError, OSError):
        return None


def _expand_fixed_wildcards(text):
    """Inlines __name__ references whose file has exactly one option (so
    resolution is deterministic). Returns (text, unresolved) where unresolved
    is True if any random choice ({a|b} or a multi-option wildcard) remains,
    i.e. the count is only approximate."""
    unresolved = False

    def repl(m):
        nonlocal unresolved
        options = _wildcard_options(m.group(1))
        if options is not None and len(options) == 1:
            return options[0]
        unresolved = True
        return m.group(0)

    for _ in range(5):  # nested wildcards, bounded
        expanded = _WILDCARD_REF.sub(repl, text)
        if expanded == text:
            break
        text = expanded
    if re.search(r"\{[^{}]*\|[^{}]*\}", text):
        unresolved = True
    return text, unresolved


@PromptServer.instance.routes.post("/temp1209/tokenize")
async def tokenize_prompt(request):
    """mode picks whose chunking to mirror: "standard" (core CLIPTextEncode,
    hard cut at 75), "break" (comfyui-clip-with-break: BREAK splits, hard
    cut within each part) or "smart" (our Smart Chunk node, chunking.py)."""
    body = await request.json()
    mode = body.get("mode", "standard")
    text, unresolved = _expand_fixed_wildcards(body.get("text", ""))
    sub = _get_tokenizer().clip_l
    if mode == "smart":
        segments = [flatten(sub.tokenize_with_weights(seg, return_word_ids=True)) for seg in split_break(text)]
        chunks = rechunk(segments)
    else:
        parts = split_break(text) if mode == "break" else [text]
        chunks = [
            [(t, w) for t, w, word_id in batch if word_id != 0]
            for part in parts
            for batch in sub.tokenize_with_weights(part, return_word_ids=True)
        ]
        # ComfyUI appends an empty trailing chunk when content ends exactly on a boundary.
        chunks = [c for i, c in enumerate(chunks) if c or i == 0]
    vocab = sub.tokenizer
    out = [
        [
            {"t": vocab.convert_ids_to_tokens(t) if isinstance(t, int) else "<embedding>", "w": round(float(w), 3)}
            for t, w in chunk
        ]
        for chunk in chunks
    ]
    return web.json_response({
        "total": sum(len(c) for c in out),
        "chunks": out,
        "mode": mode,
        "unresolved": unresolved,
        "hasBreak": bool(re.search(r"BREAK", text)),
    })


# --- Hires fix from a result -------------------------------------------------
# Backs web/hires_button.js. Given an output image, finds the run that produced
# it in ComfyUI's (in-memory) history and returns that exact prompt with the
# "Hire Fix" boolean switched on. Every other value - seeds, the resolved
# wildcard text, LoRAs - stays as it was, and the hires branch sits behind a
# lazy switch, so re-queuing it gives the same image as if hires had been on
# from the start. History doesn't survive a ComfyUI restart, so only images
# generated since the last start can be re-run this way.
_HIRES_TOGGLE_TITLE = re.compile(r"hire\s*s?\s*fix", re.IGNORECASE)


def _find_run(filename, subfolder):
    history = PromptServer.instance.prompt_queue.get_history()
    for item in reversed(list(history.values())):
        for out in item.get("outputs", {}).values():
            for img in out.get("images", []):
                if (img.get("filename") == filename and img.get("subfolder", "") == subfolder
                        and img.get("type", "output") == "output"):
                    return item
    return None


@PromptServer.instance.routes.post("/temp1209/hires_rerun")
async def hires_rerun(request):
    body = await request.json()
    item = _find_run(body.get("filename", ""), body.get("subfolder", ""))
    if item is None:
        return web.json_response(
            {"error": "この画像の生成記録が見つかりません（ComfyUIを再起動する前に生成した画像は使えません）"}, status=404)
    prompt = copy.deepcopy(item["prompt"][2])
    toggles = [n for n in prompt.values()
               if n.get("class_type") == "PrimitiveBoolean" and _HIRES_TOGGLE_TITLE.search(n.get("_meta", {}).get("title", ""))]
    if not toggles:
        return web.json_response({"error": "このワークフローには「Hire Fix」という名前のブール値が見つかりません"}, status=400)
    if all(n["inputs"].get("value") for n in toggles):
        return web.json_response({"error": "この画像はすでにHires fixありで生成されています"}, status=409)
    for n in toggles:
        n["inputs"]["value"] = True
    old_extra = item["prompt"][3] or {}
    extra_data = {k: v for k, v in old_extra.items() if k in ("extra_pnginfo",)}
    return web.json_response({"prompt": prompt, "extra_data": extra_data})
