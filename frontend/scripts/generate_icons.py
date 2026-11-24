from __future__ import annotations

import io
import sys
from pathlib import Path


FRONTEND_ROOT = Path(__file__).resolve().parent.parent
ICONS_DIRECTORY = FRONTEND_ROOT / "public" / "icons"
SOURCE_SVG = ICONS_DIRECTORY / "app-icon.svg"

ICON_OUTPUTS = (
    ("icon-192.png", 192),
    ("icon-512.png", 512),
    ("apple-touch-icon.png", 180),
)


def generate_icons() -> None:
    """Generate PNG application icons from the canonical SVG artwork."""
    try:
        import cairosvg
        from PIL import Image
    except ImportError as exc:
        raise RuntimeError(
            "Icon generation requires the Python packages "
            "'CairoSVG' and 'Pillow'."
        ) from exc

    if not SOURCE_SVG.is_file():
        raise FileNotFoundError(
            f"Application icon source was not found: {SOURCE_SVG}"
        )

    svg_content = SOURCE_SVG.read_bytes()

    if not svg_content.strip():
        raise ValueError("Application icon SVG source is empty.")

    ICONS_DIRECTORY.mkdir(parents=True, exist_ok=True)

    for filename, size in ICON_OUTPUTS:
        png_bytes = cairosvg.svg2png(
            bytestring=svg_content,
            output_width=size,
            output_height=size,
        )

        with Image.open(io.BytesIO(png_bytes)) as rendered_image:
            icon = rendered_image.convert("RGBA")

            if icon.size != (size, size):
                raise ValueError(
                    f"Unexpected dimensions for {filename}: "
                    f"{icon.size}; expected {(size, size)}."
                )

            output_path = ICONS_DIRECTORY / filename
            icon.save(
                output_path,
                format="PNG",
                optimize=True,
            )

        print(f"Generated: {output_path.relative_to(FRONTEND_ROOT)}")

    print("Application icon generation completed successfully.")


def main() -> int:
    try:
        generate_icons()
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"Icon generation failed: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())