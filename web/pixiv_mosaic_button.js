import { app } from "../../scripts/app.js";

app.registerExtension({
    name: "Temp1209.PixivMosaicButton",
    async setup() {
        try {
            const { ComfyButton } = await import("../../scripts/ui/components/button.js");
            const { ComfyButtonGroup } = await import("../../scripts/ui/components/buttonGroup.js");

            const button = new ComfyButton({
                icon: "content-cut",
                action: async () => {
                    button.enabled = false;
                    try {
                        const res = await fetch("/temp1209/launch_mosaic_tool", { method: "POST" });
                        const data = await res.json();
                        if (data.status !== "ok") {
                            alert("起動に失敗しました: " + data.message);
                        }
                    } catch (e) {
                        alert("起動リクエストに失敗しました: " + e);
                    } finally {
                        button.enabled = true;
                    }
                },
                tooltip: "Pixiv投稿準備ツールを起動 (temp1209)",
                content: "Pixiv準備",
                classList: "comfyui-button comfyui-menu-mobile-collapse",
            });

            const group = new ComfyButtonGroup(button.element);
            app.menu?.settingsGroup.element.before(group.element);
        } catch (e) {
            console.error("[temp1209-nodes] Failed to add Pixiv Mosaic button", e);
        }
    },
});
