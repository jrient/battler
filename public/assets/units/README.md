# Unit art — canvas standard

Raster art for replay/roster unit sprites. These override the code-drawn
fallback sprites in `public/assets/sprites.js` (the `IMG` map).

## Canvas spec

| Property      | Value                                                    |
| ------------- | -------------------------------------------------------- |
| Size          | **128 × 128 px** (square, to match the square board cells) |
| Background    | Fully transparent (no checkerboard / matte)              |
| Placement     | Figure **bottom-anchored, fills the full width** (minimal side margin) |
| Style         | Pixel art; rendered with `image-rendering: pixelated`    |
| Fit at render | `background-size: contain`, `background-position: center bottom` |

The fixed square canvas keeps every unit at a consistent visual scale. Because
the renderer contain-fits the whole canvas into the sprite box, empty canvas
space shrinks the figure — so the figure should **fill the canvas width** and
sit on the bottom edge, leaving only a thin rim margin. (A wide, short figure
will still leave vertical headroom; that is expected.) On the board the sprite
box is larger than a cell (`.sprite` in `replay.css`), so figures stand on the
tile and overflow upward, like a tactics-RPG.

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
