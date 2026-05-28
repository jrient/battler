// AgentClash i18n loader — vanilla, no build step
// Usage:
//   <html data-lang="zh">
//   <span data-i18n="nav.home">主页</span>
//   <input data-i18n-attr="placeholder:replay.input.placeholder">
//   <span data-i18n="replay.turn.label" data-i18n-vars='{"current":1,"total":10}'>
// JS:
//   await window.i18nReady;
//   t('nav.home')
//   t('replay.turn.label', { current: 3, total: 10 })

(function () {
  const SUPPORTED = ["zh", "en"];

  function detectLang() {
    const m = location.pathname.match(/^\/(zh|en)(\/|$)/);
    if (m) return m[1];
    const cookie = document.cookie.split(";").map(s => s.trim()).find(s => s.startsWith("lang="));
    if (cookie) {
      const v = cookie.slice(5);
      if (SUPPORTED.includes(v)) return v;
    }
    const accept = (navigator.language || "zh").toLowerCase();
    return accept.startsWith("en") ? "en" : "zh";
  }

  const lang = detectLang();
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  document.documentElement.dataset.lang = lang;

  let dict = {};

  function interpolate(s, vars) {
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
  }

  function t(key, vars) {
    const raw = dict[key];
    if (raw == null) return key;
    return interpolate(raw, vars);
  }

  function applyDom(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.dataset.i18n;
      const vars = el.dataset.i18nVars ? safeJson(el.dataset.i18nVars) : null;
      const text = t(key, vars);
      if (text !== key) el.textContent = text;
    });
    scope.querySelectorAll("[data-i18n-attr]").forEach((el) => {
      const spec = el.dataset.i18nAttr;
      const vars = el.dataset.i18nVars ? safeJson(el.dataset.i18nVars) : null;
      spec.split(",").forEach((pair) => {
        const [attr, key] = pair.split(":").map(s => s.trim());
        if (!attr || !key) return;
        const text = t(key, vars);
        if (text !== key) el.setAttribute(attr, text);
      });
    });
  }

  function safeJson(s) {
    try { return JSON.parse(s); } catch { return null; }
  }

  function wireLangToggle() {
    const other = lang === "zh" ? "en" : "zh";
    document.querySelectorAll("[data-lang-toggle]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        document.cookie = `lang=${other};path=/;max-age=31536000;samesite=lax`;
        const newPath = location.pathname.replace(/^\/(zh|en)/, `/${other}`);
        const target = newPath === location.pathname ? `/${other}${location.pathname}` : newPath;
        location.assign(target + location.search + location.hash);
      });
    });
  }

  window.i18n = { lang, t, applyDom };
  window.t = t;

  window.i18nReady = fetch(`/i18n/${lang}.json`)
    .then((r) => r.json())
    .then((json) => {
      dict = json;
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => { applyDom(); wireLangToggle(); });
      } else {
        applyDom();
        wireLangToggle();
      }
      return dict;
    })
    .catch((err) => {
      console.error("[i18n] failed to load dictionary", err);
      return {};
    });
})();
