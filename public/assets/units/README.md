# Unit art — canvas standard

Raster art for replay/roster unit sprites. These override the code-drawn
fallback sprites in `public/assets/sprites.js` (the `IMG` map).

## Canvas spec

| Property      | Value                                                    |
| ------------- | -------------------------------------------------------- |
| Size          | **128 × 128 px** (square, to match the square board cells) |
| Background    | Fully transparent (no checkerboard / matte)              |
| Placement     | Figure **bottom-centered** (feet on the bottom edge)     |
| Style         | Pixel art; rendered with `image-rendering: pixelated`    |
| Fit at render | `background-size: contain`, `background-position: center bottom` |

The fixed canvas + bottom-centered placement is what keeps every unit the same
visual scale: the renderer contain-fits the whole canvas into a square sprite
box, so a unit's apparent size is purely a function of how much of the canvas it
fills. Keep the figure's footprint consistent across unit types.

## Per-team variants

Teams are distinguished by a **colored rim** baked into the art:

- `<unit>_a.png` — side A, **blue** rim
- `<unit>_b.png` — side B, **red** rim

Both variants share the same pose/facing; the renderer flips side B
horizontally (`.sprite.side-b .sprite-fig { transform: scaleX(-1) }`) so the two
sides face each other. A unit with a single shared file (no `_a`/`_b`) is also
supported — set the `IMG` entry to a plain URL string instead of an `{ A, B }`
map.

## Wiring a new asset

1. Export the art to the canvas spec above and drop it in this folder.
2. Add it to `IMG` in `public/assets/sprites.js`, bumping the `?v=` cache-buster.
3. Reload the replay page — `unitSpriteURL(type, side)` picks the right variant.

## Current assets

- `knight_a.png`, `knight_b.png` — knight (重甲骑士), 128×128, blue/red rim.
