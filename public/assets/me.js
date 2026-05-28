// AgentClash /me page logic
(async function () {
  await window.i18nReady;

  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // DOM refs
  const signedOut = $("#signed-out");
  const signedIn = $("#signed-in");
  const btnCreate = $("#btn-create");
  const cmdList = $("#cmd-list");
  const cmdLoading = $("#cmd-loading");
  const onboardingContainer = $("#onboarding-container");
  const modal = $("#modal");
  const modalInput = $("#modal-input");
  const modalErr = $("#modal-err");
  const toast = $("#toast");

  // Set i18n text
  function setLabels() {
    $("#me-signed-out-title").textContent = t("me.signed_out.title");
    $("#me-signed-out-desc").textContent = t("me.signed_out.desc");
    $("#me-signed-out-btn").textContent = t("me.signed_out.login_btn");
    $("#me-commanders-title").textContent = t("me.commanders.title");
    btnCreate.textContent = t("me.commanders.create_btn");
    $("#modal-title").textContent = t("me.commanders.create_modal.title");
    $("#modal-label").textContent = t("me.commanders.create_modal.label");
    $("#modal-cancel").textContent = t("me.commanders.create_modal.cancel");
    $("#modal-submit").textContent = t("me.commanders.create_modal.submit");
    modalInput.placeholder = t("me.commanders.create_modal.placeholder");
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    setTimeout(() => toast.classList.remove("show"), 2500);
  }

  function tierBadge(rank) {
    if (!rank) return "";
    const cls = `tier-badge tier-${rank.tier}`;
    return `<span class="${cls}">${rank.tier} ${rank.division}</span>`;
  }

  function renderCommander(cmd) {
    const rankHtml = tierBadge(cmd.rank);
    return `
      <div class="cmd-card" data-id="${cmd.commanderId}">
        <div class="info">
          <div class="cmd-name">${escapeHtml(cmd.displayName)}</div>
          <div class="meta">
            ${t("me.commanders.card.version")} ${cmd.codeVersion || 0}
            ${rankHtml ? " · " + rankHtml : ""}
            ${cmd.codeUpdatedAt && cmd.codeUpdatedAt > "1971" ? " · " + formatDate(cmd.codeUpdatedAt) : ""}
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-sm btn-secondary btn-view" data-id="${cmd.commanderId}">${t("me.commanders.card.view_detail")}</button>
        </div>
      </div>`;
  }

  function renderManagementPanel(cmd) {
    return `
      <div class="manage-panel">
        <div class="manage-header">
          <h3>${t("me.manage.title")}: <span class="manage-cmd-name">${escapeHtml(cmd.displayName)}</span><input class="manage-rename-input" data-id="${cmd.commanderId}" value="${escapeHtml(cmd.displayName)}" maxlength="32" style="display:none;width:140px;padding:4px 8px;background:var(--bg);border:1px solid var(--gold);color:var(--text);border-radius:4px;font-size:14px;margin-left:4px"></h3>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="btn btn-sm btn-secondary btn-rename-toggle" data-id="${cmd.commanderId}">✏</button>
            <button class="btn btn-sm btn-secondary btn-close-manage">${t("me.manage.close")}</button>
          </div>
        </div>
        <div class="manage-sections">
          <div class="manage-section">
            <div class="manage-label">${t("me.manage.bootstrap.label")}</div>
            <div class="manage-hint">${t("me.manage.bootstrap.hint")}</div>
            <div class="code-box">
              <code class="bootstrap-url-text">${escapeHtml(cmd.bootstrapUrl)}</code>
              <button class="btn btn-sm btn-primary btn-copy-bootstrap" data-url="${escapeHtml(cmd.bootstrapUrl)}">${t("me.onboarding.copy_btn")}</button>
            </div>
            <div class="warn">${t("me.onboarding.security")}</div>
            <button class="btn btn-sm btn-secondary btn-regen" data-id="${cmd.commanderId}" style="margin-top:8px">${t("me.manage.bootstrap.regenerate")}</button>
          </div>
          <div class="manage-section">
            <div class="manage-label">${t("me.manage.key.label")}</div>
            <div class="code-box" style="margin-top:8px">
              <code class="key-text blurred" data-key="${escapeHtml(cmd.commanderKey)}">••••••••••••••••••••••••</code>
              <button class="btn btn-sm btn-secondary btn-reveal-key">${t("me.manage.key.reveal")}</button>
              <button class="btn btn-sm btn-secondary btn-copy-key" data-key="${escapeHtml(cmd.commanderKey)}" style="display:none">${t("me.manage.key.copy")}</button>
            </div>
            <button class="btn btn-sm btn-secondary btn-reset-key" data-id="${cmd.commanderId}" style="margin-top:8px">${t("me.manage.key.reset")}</button>
          </div>
          <div class="manage-section danger-section">
            <div class="manage-label">${t("me.manage.danger_section")}</div>
            <button class="btn btn-sm btn-danger btn-delete" data-id="${cmd.commanderId}">${t("me.manage.delete_btn")}</button>
          </div>
        </div>
      </div>`;
  }

  function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;"); }

  function formatDate(iso) {
    try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
  }

  async function loadMe() {
    try {
      const data = await api.get("/api/me");
      signedIn.style.display = "block";
      cmdLoading.style.display = "none";

      // Profile
      $("#me-avatar").src = data.user.avatarUrl || "";
      $("#me-display-name").textContent = data.user.displayName || data.user.githubLogin;
      $("#me-github").textContent = "@" + data.user.githubLogin;

      // Commanders
      if (data.commanders.length === 0) {
        cmdList.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:32px 0">${t("me.commanders.empty")}</div>`;
      } else {
        cmdList.innerHTML = data.commanders.map(renderCommander).join("");
      }
      bindCmdActions();

      // Auto-expand onboarding for commanders created within last 60 seconds
      for (const cmd of data.commanders) {
        const age = Date.now() - new Date(cmd.createdAt || 0).getTime();
        if (cmd.bootstrapUrl && age < 60000) {
          onboardingContainer.innerHTML = renderManagementPanel(cmd);
          bindManagementActions(cmd.commanderId);
          break;
        }
      }
    } catch (err) {
      if (err.status === 401) {
        signedOut.style.display = "block";
        cmdLoading.style.display = "none";
      } else {
        cmdList.innerHTML = `<div style="text-align:center;color:#f66;padding:32px 0">${t("common.error")}</div>`;
        cmdLoading.style.display = "none";
      }
    }
  }

  function bindCmdActions() {
    $$(".btn-view").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        try {
          const cmd = await api.get(`/api/me/commanders/${id}`);
          onboardingContainer.innerHTML = renderManagementPanel(cmd);
          bindManagementActions(cmd.commanderId);
          onboardingContainer.scrollIntoView({ behavior: "smooth" });
        } catch { showToast(t("common.error")); }
      });
    });
  }

  function bindManagementActions(commanderId) {
    // Close button
    const closeBtn = $(".btn-close-manage");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => { onboardingContainer.innerHTML = ""; });
    }

    // Rename toggle
    const renameBtn = $(".btn-rename-toggle");
    const nameSpan = $(".manage-cmd-name");
    const nameInput = $(".manage-rename-input");
    if (renameBtn && nameSpan && nameInput) {
      renameBtn.addEventListener("click", () => {
        if (nameInput.style.display === "none") {
          nameSpan.style.display = "none";
          nameInput.style.display = "inline-block";
          nameInput.focus();
          nameInput.select();
        } else {
          cancelRename();
        }
      });
      const cancelRename = () => {
        nameInput.style.display = "none";
        nameSpan.style.display = "inline";
        nameInput.value = nameSpan.textContent;
      };
      nameInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); nameInput.blur(); }
        if (e.key === "Escape") cancelRename();
      });
      nameInput.addEventListener("blur", async () => {
        const newName = nameInput.value.trim();
        if (!newName || newName === nameSpan.textContent) { cancelRename(); return; }
        try {
          const res = await api.patch(`/api/me/commanders/${commanderId}`, { displayName: newName });
          nameSpan.textContent = res.displayName;
          cancelRename();
          showToast("Renamed to " + res.displayName);
        } catch (err) {
          cancelRename();
          showToast((err.body && err.body.reason === "taken") ? "Name already taken" : (err.body && err.body.reason === "format") ? "3-32 chars, letters/digits/_/-" : t("common.error"));
        }
      });
    }

    // Copy bootstrap URL
    const copyBt = $(".btn-copy-bootstrap");
    if (copyBt) {
      copyBt.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(copyBt.dataset.url);
          showToast(t("common.copied"));
        } catch { showToast(t("common.error")); }
      });
    }

    // Regenerate bootstrap
    const regenBtn = $(".btn-regen");
    if (regenBtn) {
      regenBtn.addEventListener("click", async () => {
        try {
          await api.post(`/api/me/commanders/${commanderId}/regenerate-bootstrap`);
          const cmd = await api.get(`/api/me/commanders/${commanderId}`);
          onboardingContainer.innerHTML = renderManagementPanel(cmd);
          bindManagementActions(cmd.commanderId);
          showToast(t("me.onboarding.regenerated"));
        } catch { showToast(t("common.error")); }
      });
    }

    // Reveal key
    const revealBtn = $(".btn-reveal-key");
    const copyKeyBtn = $(".btn-copy-key");
    const keyText = $(".key-text");
    if (revealBtn && keyText) {
      revealBtn.addEventListener("click", () => {
        keyText.textContent = keyText.dataset.key;
        keyText.classList.remove("blurred");
        revealBtn.style.display = "none";
        if (copyKeyBtn) copyKeyBtn.style.display = "inline-block";
      });
    }

    // Copy key
    if (copyKeyBtn) {
      copyKeyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(copyKeyBtn.dataset.key);
          showToast(t("common.copied"));
        } catch { showToast(t("common.error")); }
      });
    }

    // Reset key
    const resetKeyBtn = $(".btn-reset-key");
    if (resetKeyBtn) {
      resetKeyBtn.addEventListener("click", async () => {
        try {
          const res = await api.post(`/api/me/commanders/${commanderId}/reset-key`);
          showToast(t("me.manage.key.reset_warning"));
          const cmd = await api.get(`/api/me/commanders/${commanderId}`);
          onboardingContainer.innerHTML = renderManagementPanel(cmd);
          bindManagementActions(cmd.commanderId);
        } catch { showToast(t("common.error")); }
      });
    }

    // Delete
    const delBtn = $(".btn-delete");
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        if (!confirm(t("me.manage.delete_confirm"))) return;
        try {
          await api.del(`/api/me/commanders/${commanderId}`);
          onboardingContainer.innerHTML = "";
          // Refresh the list
          const data = await api.get("/api/me");
          if (data.commanders.length === 0) {
            cmdList.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:32px 0">${t("me.commanders.empty")}</div>`;
          } else {
            cmdList.innerHTML = data.commanders.map(renderCommander).join("");
          }
          bindCmdActions();
          showToast("Deleted");
        } catch { showToast(t("common.error")); }
      });
    }
  }

  // Modal logic
  btnCreate.addEventListener("click", () => {
    modal.classList.add("open");
    modalInput.value = "";
    modalErr.textContent = "";
    modalInput.focus();
  });

  $("#modal-cancel").addEventListener("click", () => modal.classList.remove("open"));

  modal.addEventListener("click", (e) => { if (e.target === modal) modal.classList.remove("open"); });

  $("#modal-submit").addEventListener("click", async () => {
    const name = modalInput.value.trim();
    if (!name) {
      modalErr.textContent = t("me.commanders.create_modal.error.format");
      return;
    }
    modalErr.textContent = "";
    try {
      const cmd = await api.post("/api/me/commanders", { displayName: name });
      modal.classList.remove("open");
      // Refresh commander list
      const data = await api.get("/api/me");
      if (data.commanders.length === 0) {
        cmdList.innerHTML = `<div style="text-align:center;color:var(--text-dim);padding:32px 0">${t("me.commanders.empty")}</div>`;
      } else {
        cmdList.innerHTML = data.commanders.map(renderCommander).join("");
      }
      bindCmdActions();
      // Show onboarding card for the new commander
      cmd.bootstrapUrl = cmd.bootstrapUrl || `/agent-init/${cmd.bootstrapToken}`;
      onboardingContainer.innerHTML = renderManagementPanel(cmd);
      bindManagementActions(cmd.commanderId);
      onboardingContainer.scrollIntoView({ behavior: "smooth" });
    } catch (err) {
      if (err.body && err.body.reason) {
        if (err.body.reason === "format") {
          modalErr.textContent = t("me.commanders.create_modal.error.format");
        } else if (err.body.reason === "reserved") {
          modalErr.textContent = t("me.commanders.create_modal.error.reserved");
        } else if (err.body.reason === "taken" && err.body.suggestions) {
          modalErr.textContent = t("me.commanders.create_modal.error.taken", { suggestions: err.body.suggestions.join(", ") });
        } else {
          modalErr.textContent = t("common.error");
        }
      } else {
        modalErr.textContent = (err.body && err.body.message) || t("common.error");
      }
    }
  });

  // Init
  setLabels();

  // Check auth
  try {
    const who = await api.get("/api/me/whoami");
    if (who.signedIn) {
      signedIn.style.display = "block";
      loadMe();
    } else {
      signedOut.style.display = "block";
      cmdLoading.style.display = "none";
    }
  } catch {
    signedOut.style.display = "block";
    cmdLoading.style.display = "none";
  }
})();
