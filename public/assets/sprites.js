// AgentClash unit sprites — pixel-art figures drawn in code (no image assets).
// Exposes window.unitSpriteURL(type, side) -> data URL, cached per type+side.
//
// Detailed units are authored on a grid of single-char codes, then an outline
// is auto-generated (any empty pixel touching a filled one) and the whole thing
// is tinted per team and rasterized to a canvas. Units not yet redrawn fall
// back to the older flat builders so nothing renders blank.
(function () {
  // Shaded palette. Team colors (1 = highlight, 2 = base, 3 = shadow) are
  // substituted per side at render time.
  const PAL = {
    o: "#2a2433", O: "#141019",                      // soft outline / deep
    a: "#fbd6ad", b: "#e3ad81", c: "#fff0db",        // skin
    h: "#7a4a26", H: "#583113", j: "#9c6a38",        // brown hair
    u: "#3f5f93", U: "#2a3f63", "6": "#6b8bc0",      // blue hair
    t: "#4f7a3f", T: "#36562b", "7": "#6fa05a",      // green hair
    v: "#8a4f9f", V: "#5f3673", "8": "#ab73c0",      // purple hair
    z: "#dde2ee", Z: "#a9b0c2", "9": "#ffffff",      // silver hair
    r: "#dd7a38", R: "#a85524", "5": "#f0a05a",      // ginger hair
    m: "#e7ecf4", n: "#9aa2b4", N: "#5b6273",        // metal
    w: "#9c6b3a", W: "#6e4a26",                      // wood
    g: "#ffd54d", G: "#bd8c1c",                      // gold
    e: "#f5f7fc", E: "#cdd4e2",                      // white cloth
    k: "#33384a", K: "#1c2030",                      // dark cloth
    y: "#aef0ff", Y: "#46b6e8",                      // magic
    i: "#6f9bd6", I: "#3f5f93",                      // eye iris
    p: "#ff9ec4", P: "#e06a9b",                      // blush / pink accent
  };
  const TEAM = {
    a: { "1": "#8fbdf2", "2": "#4f86c6", "3": "#2f5586" },
    b: { "1": "#f29a9a", "2": "#cf5a5a", "3": "#7e3030" },
  };

  function makeGrid(w, h) {
    const g = new Array(h);
    for (let y = 0; y < h; y++) g[y] = new Array(w).fill(null);
    return g;
  }
  function rect(g, x, y, w, h, ch) {
    for (let j = y; j < y + h; j++)
      for (let i = x; i < x + w; i++)
        if (g[j] && i >= 0 && i < g[0].length && j >= 0) g[j][i] = ch;
  }
  function px(g, x, y, ch) { if (g[y] && x >= 0 && x < g[0].length) g[y][x] = ch; }
  function ell(g, cx, cy, rx, ry, ch) {
    const H = g.length, W = g[0].length;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) g[y][x] = ch;
      }
  }
  // Big anime eye: 3 wide x 4 tall at (ex,ey); white + iris + pupil + highlight.
  function eye(g, ex, ey, iris) {
    rect(g, ex, ey, 3, 4, "e");
    rect(g, ex, ey + 2, 3, 2, iris);
    px(g, ex + 1, ey + 2, "O"); px(g, ex + 1, ey + 3, "O");
    px(g, ex + 2, ey + 1, "c");
  }
  // Cute chibi base: big round head, big eyes, small team-clothed body.
  // hb/hs/hh = hair base/shadow/highlight palette codes.
  function chibiBase(hb, hs, hh) {
    const g = makeGrid(24, 28);
    ell(g, 11.5, 7.5, 7, 7, hb);
    ell(g, 11.5, 9, 5.6, 5.6, "a");
    ell(g, 11.5, 5.5, 6.5, 4, hb);
    rect(g, 7, 3, 4, 1, hh); rect(g, 13, 3, 4, 1, hh);
    rect(g, 7, 6, 10, 1, hb); px(g, 8, 7, hb); px(g, 15, 7, hb);
    px(g, 6, 9, hs); px(g, 17, 9, hs); px(g, 6, 10, hs); px(g, 17, 10, hs);
    eye(g, 8, 8, "i"); eye(g, 13, 8, "i");
    px(g, 9, 12, "b"); rect(g, 11, 13, 2, 1, "b");
    px(g, 7, 11, "p"); px(g, 16, 11, "p");
    rect(g, 8, 15, 8, 7, "2");
    rect(g, 8, 15, 8, 1, "1");
    rect(g, 8, 20, 8, 2, "3");
    rect(g, 9, 22, 2, 4, "k"); rect(g, 13, 22, 2, 4, "k");
    rect(g, 9, 26, 3, 1, "K"); rect(g, 13, 26, 3, 1, "K");
    return g;
  }

  // Add an outline code 'o' to every empty cell 8-adjacent to a filled,
  // non-outline cell. This gives clean silhouettes without hand-drawing borders.
  function autoOutline(g) {
    const H = g.length, W = g[0].length;
    const out = g.map((r) => r.slice());
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (g[y][x] !== null) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const ny = y + dy, nx = x + dx;
            if (ny < 0 || nx < 0 || ny >= H || nx >= W) continue;
            const c = g[ny][nx];
            if (c !== null && c !== "o" && c !== "O") { near = true; break; }
          }
        if (near) out[y][x] = "o";
      }
    return out;
  }

  // ---- Detailed, hand-authored units (grid of codes, facing right) ----
  const DETAIL = {
    knight() {
      const g = chibiBase("h", "H", "j");        // brown hair
      // gold circlet
      rect(g, 7, 5, 10, 1, "g"); px(g, 11, 5, "G");
      // armor details
      rect(g, 8, 15, 2, 2, "1"); rect(g, 14, 15, 2, 2, "1"); // pauldrons
      rect(g, 11, 17, 2, 2, "g"); px(g, 12, 18, "G");        // chest emblem
      rect(g, 8, 21, 8, 1, "3"); px(g, 11, 21, "g");          // belt + buckle
      // left arm + kite shield
      rect(g, 7, 16, 1, 4, "2"); px(g, 7, 20, "a");
      rect(g, 3, 15, 4, 6, "2");
      rect(g, 3, 15, 4, 1, "g"); rect(g, 3, 20, 4, 1, "G");
      rect(g, 4, 17, 2, 2, "m"); px(g, 4, 18, "n");
      // right arm + raised sword
      rect(g, 16, 16, 1, 3, "2"); px(g, 17, 18, "a");
      rect(g, 18, 5, 2, 13, "m"); rect(g, 19, 5, 1, 13, "n");
      px(g, 18, 4, "m");
      rect(g, 17, 18, 4, 1, "g");
      px(g, 18, 19, "W");
      return { w: 24, h: 28, g };
    },
  };

  function colorOf(ch, team) {
    if (ch === null || ch === undefined) return null;
    return team[ch] || PAL[ch] || null;
  }
  function gridToURL(grid, team) {
    const og = autoOutline(grid);
    const H = og.length, W = og[0].length;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const cx = cv.getContext("2d");
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = colorOf(og[y][x], team);
        if (!c) continue;
        cx.fillStyle = c;
        cx.fillRect(x, y, 1, 1);
      }
    return cv.toDataURL();
  }

  // ---- Legacy flat builders (16x18) for units not yet redrawn ----
  const LPX = {
    o: "#15151f", k: "#3a3f4b", m: "#c6ccd8", w: "#8a5a2b",
    s: "#f2c9a0", h: "#46321f", a: "#ffcf4a", g: "#7fe6ff", W: "#eef0f4",
  };
  function lr(cx, x, y, w, h, c) { if (!c) return; cx.fillStyle = c; cx.fillRect(x, y, w, h); }
  function lbase(cx, P, p, opts) {
    opts = opts || {};
    if (opts.hair !== null) {
      const hair = LPX.h;
      lr(cx, 6, 2, 4, 2, hair); lr(cx, 5, 3, 1, 2, hair); lr(cx, 10, 3, 1, 2, hair);
    }
    lr(cx, 6, 4, 4, 3, LPX.s); lr(cx, 8, 5, 1, 1, LPX.o); lr(cx, 7, 7, 2, 1, LPX.s);
    lr(cx, 5, 8, 6, 3, P); lr(cx, 4, 8, 1, 3, P); lr(cx, 11, 8, 1, 3, P);
    lr(cx, 4, 11, 1, 1, LPX.s); lr(cx, 11, 11, 1, 1, LPX.s);
    lr(cx, 5, 11, 6, 1, p); lr(cx, 5, 12, 2, 3, p); lr(cx, 9, 12, 2, 3, p);
    lr(cx, 5, 15, 2, 1, LPX.o); lr(cx, 9, 15, 2, 1, LPX.o);
  }
  const LEGACY = {
    spear(cx, P, p) {
      lbase(cx, P, p);
      lr(cx, 12, 3, 1, 9, LPX.w); lr(cx, 12, 0, 1, 1, LPX.m); lr(cx, 11, 1, 3, 2, LPX.m);
    },
    archer(cx, P, p) {
      lbase(cx, P, p);
      lr(cx, 13, 3, 1, 8, LPX.w); lr(cx, 12, 3, 1, 1, LPX.w); lr(cx, 12, 10, 1, 1, LPX.w);
      lr(cx, 12, 4, 1, 6, LPX.k); lr(cx, 9, 6, 4, 1, LPX.w); lr(cx, 13, 6, 1, 1, LPX.m);
    },
    mage(cx, P, p) {
      lbase(cx, P, p, { hair: null });
      lr(cx, 8, 0, 1, 1, P); lr(cx, 7, 1, 3, 1, P); lr(cx, 6, 2, 5, 1, P); lr(cx, 5, 3, 6, 1, p);
      lr(cx, 12, 4, 1, 8, LPX.w); lr(cx, 11, 2, 3, 2, LPX.g); lr(cx, 12, 1, 1, 1, LPX.g);
    },
    priest(cx, P, p) {
      lr(cx, 6, 4, 4, 3, LPX.s); lr(cx, 8, 5, 1, 1, LPX.o);
      lr(cx, 5, 2, 6, 2, P); lr(cx, 5, 4, 1, 3, P); lr(cx, 10, 4, 1, 3, P);
      lr(cx, 7, 7, 2, 1, LPX.s);
      lr(cx, 5, 8, 6, 3, LPX.W); lr(cx, 4, 8, 1, 3, LPX.W); lr(cx, 11, 8, 1, 3, LPX.W);
      lr(cx, 5, 8, 6, 1, p);
      lr(cx, 8, 9, 1, 3, LPX.a); lr(cx, 7, 10, 3, 1, LPX.a);
      lr(cx, 4, 11, 8, 4, LPX.W); lr(cx, 4, 14, 8, 1, p);
      lr(cx, 13, 3, 1, 9, LPX.w); lr(cx, 13, 1, 1, 2, LPX.a); lr(cx, 12, 2, 3, 1, LPX.a);
    },
    engineer(cx, P, p) {
      lbase(cx, P, p, { hair: null });
      lr(cx, 6, 2, 4, 1, LPX.k); lr(cx, 5, 3, 5, 1, LPX.k); lr(cx, 10, 3, 2, 1, LPX.k);
      lr(cx, 11, 5, 1, 6, LPX.m); lr(cx, 10, 4, 3, 2, LPX.m); lr(cx, 11, 4, 1, 1, LPX.o);
    },
  };
  function legacyURL(type, team) {
    const cv = document.createElement("canvas");
    cv.width = 16; cv.height = 18;
    const cx = cv.getContext("2d");
    (LEGACY[type] || LEGACY.spear)(cx, team["2"], team["3"]);
    return cv.toDataURL();
  }

  // Raster image assets (user-provided art). Take precedence over code-drawn
  // sprites. Shared by both teams for now — team is conveyed by the board's
  // footprint color and the side-B horizontal flip.
  const IMG = {
    knight: "/assets/units/knight.png?v=1",
  };

  const cache = {};
  window.unitSpriteURL = function (type, side) {
    if (IMG[type]) return IMG[type];
    const s = (side || "A").toLowerCase();
    const key = type + "_" + s;
    if (cache[key]) return cache[key];
    const team = TEAM[s] || TEAM.a;
    const url = DETAIL[type] ? gridToURL(DETAIL[type]().g, team) : legacyURL(type, team);
    cache[key] = url;
    return url;
  };
})();
