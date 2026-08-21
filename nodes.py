import datetime
import hashlib
import os

import numpy as np
import torch
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import folder_paths

KEY_POSITIVE = "temp1209_positive"
KEY_NEGATIVE = "temp1209_negative"
KEY_SEED = "temp1209_seed"


class SaveImageWithPrompt:
    """Same as the built-in Save Image, but also embeds the positive/negative
    prompt text and seed into the PNG under dedicated keys, independent of
    the standard ComfyUI prompt/workflow metadata (which can be too complex
    to parse back out reliably for workflows with many custom nodes)."""

    def __init__(self):
        self.output_dir = folder_paths.get_output_directory()
        self.type = "output"
        self.compress_level = 4

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE",),
                "positive": ("STRING", {"multiline": True, "default": ""}),
                "negative": ("STRING", {"multiline": True, "default": ""}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
                "filename_prefix": ("STRING", {"default": "ComfyUI"}),
            },
        }

    RETURN_TYPES = ()
    FUNCTION = "save_images"
    OUTPUT_NODE = True
    CATEGORY = "temp1209-nodes"

    def save_images(self, images, positive, negative, seed, filename_prefix="ComfyUI"):
        full_output_folder, filename, counter, subfolder, filename_prefix = (
            folder_paths.get_save_image_path(
                filename_prefix, self.output_dir, images[0].shape[1], images[0].shape[0]
            )
        )
        results = []
        for batch_number, image in enumerate(images):
            i = 255.0 * image.cpu().numpy()
            img = Image.fromarray(np.clip(i, 0, 255).astype(np.uint8))

            metadata = PngInfo()
            metadata.add_text(KEY_POSITIVE, positive)
            metadata.add_text(KEY_NEGATIVE, negative)
            metadata.add_text(KEY_SEED, str(seed))

            filename_with_batch_num = filename.replace("%batch_num%", str(batch_number))
            file = f"{filename_with_batch_num}_{counter:05}_.png"
            img.save(
                os.path.join(full_output_folder, file),
                pnginfo=metadata,
                compress_level=self.compress_level,
            )
            results.append({"filename": file, "subfolder": subfolder, "type": self.type})
            counter += 1

        return {"ui": {"images": results}}


class LoadPromptFromImage:
    """Reads the positive/negative prompt text and seed embedded by
    Save Image With Prompt back out. Does not attempt to parse the full
    ComfyUI workflow/prompt metadata."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": (
                    "COMBO",
                    {
                        "image_upload": True,
                        "image_folder": "output",
                        "remote": {
                            # Core's /internal/files/output only scans the top-level
                            # output folder (no subfolders), so it can't see images
                            # saved into date subfolders. Use our own recursive route.
                            "route": "/temp1209/files/output",
                            "refresh_button": True,
                            "control_after_refresh": "first",
                        },
                    },
                ),
            },
        }

    RETURN_TYPES = ("IMAGE", "STRING", "STRING", "INT")
    RETURN_NAMES = ("image", "positive", "negative", "seed")
    FUNCTION = "load_prompt"
    CATEGORY = "temp1209-nodes"

    @classmethod
    def VALIDATE_INPUTS(cls, image):
        if not folder_paths.exists_annotated_filepath(image):
            return "Invalid image file: {}".format(image)
        return True

    def load_prompt(self, image):
        image_path = folder_paths.get_annotated_filepath(image)
        img = Image.open(image_path)

        positive = img.info.get(KEY_POSITIVE, "")
        negative = img.info.get(KEY_NEGATIVE, "")
        seed_str = img.info.get(KEY_SEED, "0")
        try:
            seed = int(seed_str)
        except ValueError:
            seed = 0

        rgb = img.convert("RGB")
        image_tensor = np.array(rgb).astype(np.float32) / 255.0
        image_tensor = torch.from_numpy(image_tensor)[None,]

        return (image_tensor, positive, negative, seed)


class DateFolderName:
    """Outputs today's date as YYYY-MM-DD, for use as a subfolder segment in
    a filename_prefix (e.g. via StringConcatenate). Hours before
    `boundary_hour` still count as the previous day, so a session that runs
    past midnight keeps saving into the day it started on."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "boundary_hour": ("INT", {"default": 5, "min": 0, "max": 23}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("date",)
    FUNCTION = "get_date"
    CATEGORY = "temp1209-nodes"

    @classmethod
    def IS_CHANGED(cls, boundary_hour):
        # No real inputs to key off of, so force re-evaluation every run -
        # otherwise ComfyUI's result cache would freeze the date at whatever
        # it was the first time this node ran with these widget values.
        return hashlib.sha256(str(datetime.datetime.now()).encode()).hexdigest()

    def get_date(self, boundary_hour=5):
        now = datetime.datetime.now()
        effective_date = now.date()
        if now.hour < boundary_hour:
            effective_date -= datetime.timedelta(days=1)
        return (effective_date.strftime("%Y-%m-%d"),)


class SmartStringConcatenate:
    """Same 3 inputs as the built-in StringConcatenate (string_a, string_b,
    delimiter), but drops the delimiter instead of leaving it dangling when
    one side is empty - e.g. ("", "ComfyUI", "-") gives "ComfyUI" instead of
    "-ComfyUI"."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "string_a": ("STRING", {"multiline": True, "default": ""}),
                "string_b": ("STRING", {"multiline": True, "default": ""}),
                "delimiter": ("STRING", {"default": ""}),
            },
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "concat"
    CATEGORY = "temp1209-nodes"

    def concat(self, string_a, string_b, delimiter=""):
        if not string_a:
            return (string_b,)
        if not string_b:
            return (string_a,)
        return (f"{string_a}{delimiter}{string_b}",)


NODE_CLASS_MAPPINGS = {
    "Temp1209SaveImageWithPrompt": SaveImageWithPrompt,
    "Temp1209LoadPromptFromImage": LoadPromptFromImage,
    "Temp1209DateFolderName": DateFolderName,
    "Temp1209SmartStringConcatenate": SmartStringConcatenate,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Temp1209SaveImageWithPrompt": "Save Image With Prompt (temp1209)",
    "Temp1209LoadPromptFromImage": "Load Prompt From Image (temp1209)",
    "Temp1209DateFolderName": "Date Folder Name (temp1209)",
    "Temp1209SmartStringConcatenate": "Smart String Concatenate (temp1209)",
}
