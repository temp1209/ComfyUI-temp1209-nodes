# ComfyUI-temp1209-nodes

Personal custom nodes and server-side helpers for ComfyUI, built up incrementally rather than designed upfront. Shared here as-is in case any piece is useful to someone else.

## Nodes

- **Save Image With Prompt** (`Temp1209SaveImageWithPrompt`) — Same as the built-in Save Image, but also embeds the positive/negative prompt text and seed into the PNG under dedicated text chunks (`temp1209_positive`, `temp1209_negative`, `temp1209_seed`), independent of ComfyUI's own `prompt`/`workflow` metadata (which can be too complex to parse back out reliably for workflows with many custom nodes).
- **Load Prompt From Image** (`Temp1209LoadPromptFromImage`) — Reads the positive/negative prompt and seed back out of a PNG saved by the node above. Does not attempt to parse the full ComfyUI workflow metadata, so it works even for very complex graphs.
- **Date Folder Name** (`Temp1209DateFolderName`) — Outputs today's date as `YYYY-MM-DD`, for use as a subfolder segment in a `filename_prefix` (e.g. via the core `StringConcatenate` node). Takes a `boundary_hour` input (default 5) — hours before that still count as the previous day, so a session that runs past midnight keeps saving into the day it started on.
- **Smart String Concatenate** (`Temp1209SmartStringConcatenate`) — Same `string_a` / `string_b` / `delimiter` inputs as the core `StringConcatenate`, but drops the delimiter instead of leaving it dangling when one side is empty (e.g. `("", "ComfyUI", "-")` gives `"ComfyUI"` instead of `"-ComfyUI"`).
- **CLIP Text Encode Smart Chunk** (`Temp1209CLIPTextEncodeSmartChunk`) — Drop-in replacement for core CLIP Text Encode with A1111-style chunking: core ComfyUI cuts prompts every 75 tokens wherever that falls, even mid-tag; this node instead moves the tag in progress whole into the next chunk (backtracking to the last comma within 20 tokens, as A1111 does) and treats `BREAK` as an explicit chunk boundary. Weights, embeddings and escaping still go through ComfyUI's own tokenizer, and prompts under 75 tokens encode identically to the core node. Non-CLIP text encoders (e.g. T5) fall back to core tokenization. Logic lives in `chunking.py`.

## Server-side additions (`server.py`)

- **`GET /temp1209/files/output`** — Same response shape as ComfyUI core's `/internal/files/output`, but also looks inside `YYYY-MM-DD` date subfolders (core's route only lists the top-level output folder). Bounded to the most recent 7 date folders so it stays fast regardless of how much history has piled up.
- **View subfolder middleware** — Workaround for a ComfyUI frontend bug ([Comfy-Org/ComfyUI_frontend#12437](https://github.com/Comfy-Org/ComfyUI_frontend/issues/12437), fix pending in [#12438](https://github.com/Comfy-Org/ComfyUI_frontend/pull/12438)): the Assets picker builds thumbnail URLs by putting a subfolder-prefixed combo value straight into the `filename` query param instead of splitting it into `filename` + `subfolder`, so core's `/view` handler 404s on anything living in a subfolder. This middleware splits it before the request reaches core's handler. Safe to remove once the upstream fix lands.
- **`GET/POST/DELETE /temp1209/wildcards*`** — List/read/write/delete the `__name__` wildcard `.txt` files that [comfyui-dynamicprompts](https://github.com/adieyal/comfyui-dynamicprompts) resolves (a sibling `custom_nodes` install, not this repo), rooted at its `wildcards/` folder. Backs the sidebar tab below; paths are validated to stay inside that folder.
- **`POST /temp1209/tokenize`** — Tokenizes a prompt with ComfyUI's own SDXL tokenizer and returns the 75-token chunks (clip_l; clip_g chunks identically). `__name__` wildcards whose file has a single option are inlined first; anything still random (`{a|b}`, multi-option wildcards) is flagged as `unresolved`. `mode` (`standard` / `break` / `smart`) selects whose chunking to mirror. Backs the token counter below.

## Token counter (`web/token_counter.js`)

- **Live token count under prompt textareas** in App Mode / Nodes 2.0 — e.g. `323 tok · 5チャンク · 区切りまで残り52 · ⚠途中分割2`. The chunking shown follows whichever encode node the prompt flows into (core CLIP Text Encode, clip-with-break's BREAK node, or Smart Chunk above), found by walking the graph downstream. Core ComfyUI cuts hard at 75 tokens, so a tag can end up split across two chunks; click the badge for a per-chunk breakdown with such tags highlighted. Legacy Graph-mode textareas (Nodes 2.0 off) are not covered.

## Hires fix button (`web/hires_button.js`)

- **One-click "✨ Hires fix" on the App Mode result view** — re-queues the run that produced the displayed image with its `Hire Fix` boolean (a `PrimitiveBoolean` titled "Hire Fix") switched on, via `POST /temp1209/hires_rerun`. Seeds, resolved wildcards and LoRAs are taken from that run's history entry, and the hires branch sits behind a lazy switch, so the result matches what the image would have been with hires on from the start. Only works for images generated since the last ComfyUI start (history is in-memory). The job is registered with App Mode's internal execution store so its result shows up in App Mode (frontend-internal API, checked against frontend 1.49.6).

## Sidebar tab (`web/wildcard_editor.js`)

- **Wildcard editor** — Adds a "ワイルドカード" tab to ComfyUI's sidebar for browsing, editing, creating, and deleting the `__name__` wildcard files above, without leaving the app or opening them on disk. Supports subfolders (`__category/name__`).

## Upstream bug workarounds (`web/upstream_patches.js`)

A single collection point for known-but-unmerged ComfyUI/ComfyUI_frontend bugs that have a known one-line (usually CSS) fix. Each patch is documented in-file with the issue link, root cause, and the tracking PR, and is meant to be deleted once the real fix ships upstream. Current patches:

- **App Mode: bottom result thumbnail bar pushes the right parameter panel off-screen** ([#14908](https://github.com/Comfy-Org/ComfyUI_frontend/issues/14908), dup [#15132](https://github.com/Comfy-Org/ComfyUI_frontend/issues/15132)/[#15133](https://github.com/Comfy-Org/ComfyUI_frontend/issues/15133), fix pending in [#15433](https://github.com/Comfy-Org/ComfyUI_frontend/pull/15433)) — adds `min-width: 0` to the App Mode splitter so it stays anchored regardless of how many result thumbnails pile up.

When adding a new one: append a CSS block (or a small JS snippet if CSS won't cover it) with the same doc header format, and note it here too.

## Notes

- No install script / `requirements.txt` beyond what ComfyUI itself already provides (Pillow, numpy, aiohttp) — nothing extra to install.
- `__init__.py` optionally imports a local `local_extras.py` if one exists (`try`/`except ImportError`, silently skipped otherwise) — a place for machine-specific routes/nodes that shouldn't ship in a shared repo like this one.

## Adding a new node

1. Define the class in `nodes.py` (or a new module imported from there)
2. Register it in `NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS`
3. Restart the ComfyUI server, then hard-reload the browser tab (`Ctrl+Shift+R`) to pick up any new frontend JS

## License

MIT — see [LICENSE](LICENSE).
