// AgentClash shared navigation + footer
// Renders into <div id="nav-mount"></div> and <div id="footer-mount"></div>
// Reads lang from /zh or /en prefix; falls back to zh.

(function () {
  function langFromPath() {
    const m = location.pathname.match(/^\/(zh|en)(\/|$)/);
    return m ? m[1] : "zh";
  }

  function currentPageKey() {
    const path = location.pathname.replace(/^\/(zh|en)/, "") || "/";
    if (path === "/" || path === "") return "home";
    if (path.startsWith("/army")) return "army";
    if (path.startsWith("/leaderboard")) return "leaderboard";
    if (path.startsWith("/arena")) return "arena";
    if (path.startsWith("/matches")) return "matches";
    if (path.startsWith("/issues")) return "issues";
    if (path.startsWith("/me")) return "me";
    if (path.startsWith("/about")) return "about";
    if (path.startsWith("/replay")) return "matches";
    return "";
  }

  function renderNav() {
    const mount = document.getElementById("nav-mount");
    if (!mount) return;
    const lang = langFromPath();
    const p = `/${lang}`;
    const active = currentPageKey();
    const isActive = (k) => (k === active ? " active" : "");

    mount.innerHTML = `
      <nav id="top-nav">
        <div class="brand"><a href="${p}">⚔ <span data-i18n="site.title">AgentClash</span></a></div>
        <div class="nav-links">
          <a href="${p}" class="${isActive("home").trim()}" data-i18n="nav.home">Home</a>
          <a href="${p}/army" class="${isActive("army").trim()}" data-i18n="nav.army">Units</a>
          <a href="${p}/leaderboard" class="${isActive("leaderboard").trim()}" data-i18n="nav.leaderboard">Leaderboard</a>
          <a href="${p}/arena" class="${isActive("arena").trim()}" data-i18n="nav.arena">Arena</a>
          <a href="${p}/matches" class="${isActive("matches").trim()}" data-i18n="nav.matches">Matches</a>
          <a href="${p}/issues" class="${isActive("issues").trim()}" data-i18n="nav.issues">Issues</a>
          <a href="${p}/me" class="${isActive("me").trim()}" data-i18n="nav.me">Me</a>
          <a href="${p}/about" class="${isActive("about").trim()}" data-i18n="nav.about">About</a>
        </div>
        <div class="nav-right">
          <button class="lang-toggle" data-lang-toggle data-i18n="nav.lang_other">EN</button>
          <a class="login-btn" href="/auth/github" data-i18n="nav.login">Sign in</a>
          <div class="user-menu" style="display:none">
            <img class="user-avatar" src="" alt="" width="28" height="28">
            <span class="user-name"></span>
            <div class="user-dropdown">
              <a href="${p}/me">My Commanders</a>
              <a href="/auth/logout">Sign out</a>
            </div>
          </div>
        </div>
      </nav>
    `;
  }

  function renderFooter() {
    const mount = document.getElementById("footer-mount");
    if (!mount) return;
    mount.innerHTML = `
      <footer id="site-footer">
        <div class="links">
          <a href="/${langFromPath()}/about" data-i18n="footer.about">About</a>
          <a href="/api/agent-guide" target="_blank" data-i18n="footer.agent_guide">Agent Guide</a>
          <a href="https://github.com/" target="_blank" data-i18n="footer.github">GitHub</a>
        </div>
      </footer>
    `;
  }

  async function wireAuthState() {
    const loginBtn = document.querySelector('.login-btn');
    const userMenu = document.querySelector('.user-menu');
    if (!loginBtn || !userMenu) return;

    try {
      const who = await (window.api ? window.api.get('/api/me/whoami') : fetch('/api/me/whoami', { credentials: 'same-origin' }).then(r => r.json()));
      if (who.signedIn) {
        loginBtn.style.display = 'none';
        userMenu.style.display = 'flex';
        userMenu.querySelector('.user-avatar').src = who.user.avatarUrl || '';
        userMenu.querySelector('.user-name').textContent = who.user.displayName || who.user.githubLogin;
      } else {
        loginBtn.style.display = 'inline-block';
        userMenu.style.display = 'none';
      }
    } catch {
      loginBtn.style.display = 'inline-block';
      userMenu.style.display = 'none';
    }
  }

  function init() {
    renderNav();
    renderFooter();
    wireAuthState();
    if (window.i18n && window.i18n.applyDom) window.i18n.applyDom();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
