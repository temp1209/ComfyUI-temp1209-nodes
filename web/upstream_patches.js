import { app } from "../../scripts/app.js";

// Collected CSS/behavior patches for known-but-unmerged ComfyUI/ComfyUI_frontend
// upstream bugs. Add a new block below when we hit one with a known one-line
// fix that isn't merged yet; delete the block once the upstream fix ships.
const CSS_PATCHES = `
/* --- App Mode: bottom result thumbnail bar pushes right panel off-screen ---
 * https://github.com/Comfy-Org/ComfyUI_frontend/issues/14908 (+ dup #15132, #15133)
 * Root cause: the <Splitter> in LinearView.vue is missing min-w-0, so once the
 * thumbnail bar grows enough to need a scrollbar, the flex item's default
 * min-width:auto stops it from shrinking and it pushes the right parameter
 * panel off-screen.
 * Fix PR (open, unmerged as of 2026-08-23): https://github.com/Comfy-Org/ComfyUI_frontend/pull/15433
 * Safe to delete this block once that PR (or equivalent) merges.
 */
nav.side-tool-bar-container + .p-splitter {
    min-width: 0 !important;
}
`;

app.registerExtension({
    name: "Temp1209.UpstreamPatches",
    async setup() {
        const style = document.createElement("style");
        style.id = "temp1209-upstream-patches";
        style.textContent = CSS_PATCHES;
        document.head.appendChild(style);
    },
});
