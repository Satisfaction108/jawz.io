# Image Tools MCP server for Augment Code (stdio or streamable-http)
# Dependencies: mcp[server], pillow, opencv-python, numpy, (optional) pytesseract + Tesseract binary
# Run (stdio/default):   python tools/mcp_image_server.py
# Run (HTTP):            MCP_HTTP=1 python tools/mcp_image_server.py  # then use http://localhost:8974/mcp

from __future__ import annotations

import base64
import io
import os
from typing import Dict, List

import numpy as np
from PIL import Image as PILImage, ImageOps

from mcp.server.fastmcp import FastMCP, Image

try:
    import cv2  # type: ignore
except Exception as e:  # pragma: no cover
    cv2 = None  # QR detection will report helpful error later


mcp = FastMCP(
    name="Image Tools MCP",
    instructions=(
        "Server that provides image scanning/processing tools: info, grayscale, resize, QR detection, and optional OCR."
    ),
)


def _decode_image_to_pil(image_path_or_b64: str) -> PILImage:
    """Load an image from a filesystem path or a base64/data URI into a PIL image."""
    # File path
    if os.path.exists(image_path_or_b64):
        return PILImage.open(image_path_or_b64)

    # data URI or raw base64
    if image_path_or_b64.startswith("data:"):
        _, b64 = image_path_or_b64.split(",", 1)
    else:
        b64 = image_path_or_b64
    data = base64.b64decode(b64)
    return PILImage.open(io.BytesIO(data))


@mcp.tool(title="Image Info", description="Return width/height/mode/format of an image (path or base64)")
def image_info(image: str) -> Dict[str, str | int]:
    im = _decode_image_to_pil(image)
    return {
        "width": im.width,
        "height": im.height,
        "mode": im.mode,
        "format": im.format or "(unknown)",
    }


@mcp.tool(title="Grayscale", description="Convert to grayscale and return PNG image bytes")
def grayscale(image: str) -> Image:
    im = _decode_image_to_pil(image)
    g = ImageOps.grayscale(im)
    buf = io.BytesIO()
    g.save(buf, format="PNG")
    return Image(data=buf.getvalue(), format="png")


@mcp.tool(
    title="Resize",
    description="Resize keeping aspect ratio using thumbnail((max_w,max_h)) and return PNG",
)
def resize(image: str, max_w: int = 1024, max_h: int = 1024) -> Image:
    im = _decode_image_to_pil(image).copy()
    im.thumbnail((int(max_w), int(max_h)))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    return Image(data=buf.getvalue(), format="png")


@mcp.tool(title="Dominant Colors", description="Approximate dominant colors using PIL quantize")
def dominant_colors(image: str, colors: int = 5) -> Dict[str, List[str]]:
    im = _decode_image_to_pil(image).convert("RGB")
    q = im.quantize(colors=max(1, int(colors)), method=PILImage.Quantize.MEDIANCUT)
    palette = q.getpalette()  # flat list of RGB triples
    used = q.getcolors()
    hexes: List[str] = []
    if used and palette:
        # Take top-N used colors
        top = sorted(used, key=lambda t: t[0], reverse=True)[: max(1, int(colors))]
        for _, idx in top:
            r, g, b = palette[idx * 3 : idx * 3 + 3]
            hexes.append(f"#{r:02x}{g:02x}{b:02x}")
    return {"colors": hexes}


@mcp.tool(title="Detect QR", description="Detect and decode QR codes using OpenCV")
def detect_qr(image: str) -> Dict[str, object]:
    if cv2 is None:
        return {
            "error": "OpenCV not available. pip install opencv-python",
            "count": 0,
            "data": [],
        }
    im = _decode_image_to_pil(image).convert("RGB")
    arr = np.array(im)
    detector = cv2.QRCodeDetector()
    data, points, _ = detector.detectAndDecode(arr)
    # OpenCV's QRCodeDetector returns a single string; multi-QR requires detectAndDecodeMulti (newer OpenCV)
    datas: List[str] = []
    if data:
        datas.append(data)
    # Try multi as best-effort if available
    if hasattr(detector, "detectAndDecodeMulti"):
        _, decoded_infos, _, _ = detector.detectAndDecodeMulti(arr)
        for s in decoded_infos or []:
            if s and s not in datas:
                datas.append(s)
    return {"count": len(datas), "data": datas}


@mcp.tool(title="OCR Text (optional)", description="Extract text using pytesseract if available")
def ocr_text(image: str, lang: str = "eng") -> str:
    try:
        import pytesseract  # type: ignore
    except Exception as e:  # pragma: no cover
        return (
            "pytesseract is not installed or Tesseract binary missing: "
            f"{e}. Install with `pip install pytesseract` and system Tesseract."
        )
    im = _decode_image_to_pil(image).convert("L")
    return pytesseract.image_to_string(im, lang=lang)


if __name__ == "__main__":
    # Default: stdio. If MCP_HTTP=1, serve Streamable HTTP on localhost:8974/mcp
    transport = "stdio"
    if os.getenv("MCP_HTTP", "0").lower() in {"1", "true", "yes"}:
        transport = "streamable-http"
        # Configure host/port/path via env if needed
        mcp.settings.host = os.getenv("MCP_HOST", "127.0.0.1")
        mcp.settings.port = int(os.getenv("MCP_PORT", "8974"))
        mcp.settings.streamable_http_path = os.getenv("MCP_PATH", "/mcp")
    mcp.run(transport=transport)

