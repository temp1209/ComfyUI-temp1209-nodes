from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS
from . import server  # noqa: F401  (registers /temp1209/files/output + the view-subfolder middleware)

try:
    from . import local_extras  # noqa: F401  (optional, machine-specific; not in the public repo)
except ImportError:
    pass

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
