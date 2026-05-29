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
    o: "#15151f", O: "#0b0b12",
    a: "#f6cda3", b: "#d39a6f", c: "#ffe6c8",       // skin
    h: "#5a3a20", H: "#3c2613", j: "#7e5733",        // hair
    m: "#e3e8f0", n: "#9aa2b4", N: "#5b6273",        // metal
    w: "#9c6b3a", W: "#6e4a26",                      // wood
    g: "#ffd34d", G: "#bd8c1c",                      // gold
    e: "#f3f5fa", E: "#ccd3e0",                      // white robe
    k: "#2a2e3a", K: "#181b24",                      // dark cloth
    y: "#9be8ff", Y: "#3fb6e8",                      // magic
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
      const W = 22, H = 26, g = makeGrid(W, H);
      // hair / head
      rect(g, 6, 2, 9, 4, "h");
      rect(g, 7, 2, 5, 1, "j");
      rect(g, 6, 5, 9, 6, "a");
      rect(g, 6, 5, 9, 1, "h");
      px(g, 7, 5, "h"); px(g, 13, 5, "h");
      px(g, 8, 7, "O"); px(g, 12, 7, "O");      // eyes
      px(g, 7, 8, "c");                          // cheek highlight
      rect(g, 7, 9, 7, 1, "b");                  // lower-face shadow
      rect(g, 8, 11, 5, 1, "b");                 // neck
      // torso + armor
      rect(g, 5, 12, 11, 6, "2");
      rect(g, 5, 12, 3, 2, "1");                 // pauldrons
      rect(g, 13, 12, 3, 2, "1");
      rect(g, 5, 15, 11, 3, "3");                // lower torso shade
      rect(g, 9, 13, 3, 3, "g");                 // chest emblem
      px(g, 10, 14, "G");
      rect(g, 6, 18, 9, 1, "3");                 // belt
      px(g, 10, 18, "g");                        // buckle
      rect(g, 5, 13, 1, 4, "2"); px(g, 5, 17, "a");   // left arm + hand
      rect(g, 16, 12, 1, 3, "2");                // right upper arm (raised)
      // legs + boots
      rect(g, 7, 19, 3, 5, "3"); rect(g, 12, 19, 3, 5, "3");
      rect(g, 7, 23, 3, 1, "K"); rect(g, 12, 23, 3, 1, "K");
      // shield (left, front)
      rect(g, 1, 13, 4, 7, "2");
      rect(g, 1, 13, 4, 1, "g");                 // top trim
      rect(g, 1, 19, 4, 1, "G");                 // bottom shade
      rect(g, 2, 15, 2, 2, "m"); px(g, 2, 16, "n"); // boss
      // sword (raised, right hand)
      rect(g, 16, 2, 2, 11, "m");
      rect(g, 17, 2, 1, 11, "n");                // shaded edge
      px(g, 16, 1, "m");                         // tip
      rect(g, 15, 13, 4, 1, "g");                // crossguard
      px(g, 16, 14, "W"); px(g, 17, 14, "W");    // grip
      rect(g, 16, 15, 2, 1, "a");                // hand
      return { w: W, h: H, g };
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

  const cache = {};
  window.unitSpriteURL = function (type, side) {
    const s = (side || "A").toLowerCase();
    const key = type + "_" + s;
    if (cache[key]) return cache[key];
    const team = TEAM[s] || TEAM.a;
    const url = DETAIL[type] ? gridToURL(DETAIL[type]().g, team) : legacyURL(type, team);
    cache[key] = url;
    return url;
  };
})();
