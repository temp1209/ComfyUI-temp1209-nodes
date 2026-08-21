# ComfyUI-temp1209-nodes

Personal custom nodes and server-side helpers for ComfyUI, built up incrementally rather than designed upfront. Shared here as-is in case any piece is useful to someone else — expect a few personal-machine assumptions (see "Notes" below).

## Nodes

- **Save Image With Prompt** (`Temp1209SaveImageWithPrompt`) — Same as the built-in Save Image, but also embeds the positive/negative prompt text and seed into the PNG under dedicated text chunks (`temp1209_positive`, `temp1209_negative`, `temp1209_seed`), independent of ComfyUI's own `prompt`/`workflow` metadata (which can be too complex to parse back out reliably for workflows with many custom nodes).
- **Load Prompt From Image** (`Temp1209LoadPromptFromImage`) — Reads the positive/negative prompt and seed back out of a PNG saved by the node above. Does not attempt to parse the full ComfyUI workflow metadata, so it works even for very complex graphs.
- **Date Folder Name** (`Temp1209DateFolderName`) — Outputs today's date as `YYYY-MM-DD`, for use as a subfolder segment in a `filename_prefix` (e.g. via the core `StringConcatenate` node). Takes a `boundary_hour` input (default 5) — hours before that still count as the previous day, so a session that runs past midnight keeps saving into the day it started on.
- **Smart String Concatenate** (`Temp1209SmartStringConcatenate`) — Same `string_a` / `string_b` / `delimiter` inputs as the core `StringConcatenate`, but drops the delimiter instead of leaving it dangling when one side is empty (e.g. `("", "ComfyUI", "-")` gives `"ComfyUI"` instead of `"-ComfyUI"`).

## Server-side additions (`server.py`)

- **`GET /temp1209/files/output`** — Same response shape as ComfyUI core's `/internal/files/output`, but also looks inside `YYYY-MM-DD` date subfolders (core's route only lists the top-level output folder). Bounded to the most recent 7 date folders so it stays fast regardless of how much history has piled up.
- **View subfolder middleware** — Workaround for a ComfyUI frontend bug ([Comfy-Org/ComfyUI_frontend#12437](https://github.com/Comfy-Org/ComfyUI_frontend/issues/12437), fix pending in [#12438](https://github.com/Comfy-Org/ComfyUI_frontend/pull/12438)): the Assets picker builds thumbnail URLs by putting a subfolder-prefixed combo value straight into the `filename` query param instead of splitting it into `filename` + `subfolder`, so core's `/view` handler 404s on anything living in a subfolder. This middleware splits it before the request reaches core's handler. Safe to remove once the upstream fix lands.

## Notes

- `server.py` also registers a `/temp1209/launch_mosaic_tool` route that shells out to a separate personal tool at a hardcoded path — irrelevant to anyone else, left in only because it doesn't hurt to have an unreachable-for-you route sitting there. Delete that block if you don't want it.
- No install script / `requirements.txt` beyond what ComfyUI itself already provides (Pillow, numpy, aiohttp) — nothing extra to install.

## Adding a new node

1. Define the class in `nodes.py` (or a new module imported from there)
2. Register it in `NODE_CLASS_MAPPINGS` / `NODE_DISPLAY_NAME_MAPPINGS`
3. Restart the ComfyUI server, then hard-reload the browser tab (`Ctrl+Shift+R`) to pick up any new frontend JS

## License

MIT — see [LICENSE](LICENSE).
