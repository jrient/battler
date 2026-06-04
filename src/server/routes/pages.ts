/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import type { Context } from "hono";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppType } from "./shared.js";

// ===== Web pages: language-prefixed routing =====
const __pagesDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "public", "pages");
const PAGE_FILES: Record<string, string> = {
  home: "home.html",
  replay: "replay.html",
  me: "me.html",
  matches: "matches.html",
  exciting: "exciting.html",
  arena: "arena.html",
  leaderboard: "leaderboard.html",
  army: "army.html",
  about: "about.html",
  changelog: "changelog.html",
  issues: "issues.html",
  issueDetail: "issue.html",
  stub: "stub.html",
};

const STUB_SECTIONS: readonly string[] = [];

function pickLang(c: Context): "zh" | "en" {
  const cookieHeader = c.req.header("cookie") ?? "";
  const m = cookieHeader.match(/(?:^|;\s*)lang=(zh|en)\b/);
  if (m) return m[1] as "zh" | "en";
  const accept = (c.req.header("accept-language") ?? "").toLowerCase();
  return accept.startsWith("en") ? "en" : "zh";
}

// Page HTML is baked into the image and never changes at runtime, so read each
// file once and serve from memory thereafter.
const pageCache = new Map<string, string>();

function servePage(c: Context, key: keyof typeof PAGE_FILES) {
  const file = PAGE_FILES[key];
  if (!file) return c.notFound();
  let html = pageCache.get(file);
  if (html === undefined) {
    try {
      html = readFileSync(resolve(__pagesDir, file), "utf8");
    } catch {
      return c.text("page not found", 404);
    }
    pageCache.set(file, html);
  }
  return c.html(html);
}

// Language-prefixed pages, driven from one table instead of hand-writing each
// route twice. Each suffix is registered explicitly under /zh and /en — we do
// NOT use a `:lang{zh|en}` regex param: Hono splices custom param regexes into
// a combined matcher where the `zh|en` alternation leaks across segment
// boundaries (e.g. "ag-en-t-init" would match), shadowing unrelated routes.
// The empty suffix covers the bare /zh and /en home routes.
const LANG_PAGES: ReadonlyArray<[suffix: string, page: keyof typeof PAGE_FILES]> = [
  ["", "home"],
  ["/replay/:id", "replay"],
  ["/me", "me"],
  ["/matches", "matches"],
  ["/exciting", "exciting"],
  ["/arena", "arena"],
  ["/leaderboard", "leaderboard"],
  ["/army", "army"],
  ["/about", "about"],
  ["/changelog", "changelog"],
  ["/issues", "issues"],
  ["/issues/:id", "issueDetail"],
];

export function registerPages(app: AppType): void {
  app.get("/", (c) => c.redirect(`/${pickLang(c)}`, 302));

  for (const [suffix, page] of LANG_PAGES) {
    app.get(`/zh${suffix}`, (c) => servePage(c, page));
    app.get(`/en${suffix}`, (c) => servePage(c, page));
  }
  for (const section of STUB_SECTIONS) {
    app.get(`/zh/${section}`, (c) => servePage(c, "stub"));
    app.get(`/en/${section}`, (c) => servePage(c, "stub"));
  }
}
