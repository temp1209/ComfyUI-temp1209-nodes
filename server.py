import os
import re

from aiohttp import web
from server import PromptServer

import folder_paths

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
