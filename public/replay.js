// AgentClash Battle Replay Viewer — Fire Emblem Style

const CELL_SIZE = 48;
const CELL_GAP = 1;
const STEP = CELL_SIZE + CELL_GAP;

const UNIT_ICONS = { knight: "🗡️", spear: "🔱", archer: "🏹", mage: "🔮", priest: "✚", engineer: "🔧" };
const UNIT_NAMES = { knight: "重甲骑士", spear: "长矛兵", archer: "弓手", mage: "法师", priest: "牧师", engineer: "工兵" };
const UNIT_STATS = {
  knight: { hp: 100, atk: 20, range: 1, move: 2, special: "受伤减半" },
  spear: { hp: 60, atk: 25, range: 2, move: 3, special: "穿透" },
  archer: { hp: 40, atk: 18, range: 4, move: 2, special: "远程" },
  mage: { hp: 35, atk: 30, range: 3, move: 1, special: "溅射" },
  priest: { hp: 50, atk: 10, range: 2, move: 1, special: "治疗" },
  engineer: { hp: 40, atk: 12, range: 1, move: 2, special: "—" },
};

// Unit sprites are rendered by the shared module (assets/sprites.js).
const spriteURL = (type, side) => window.unitSpriteURL(type, side);


function phaseLabel(phase) {
  return window.t ? t(`phase.${phase}`) : phase;
}

const PROJECTILE_TYPES = {
  knight: { emoji: "⚔️", speed: 300, trail: "#ffffff" },
  spear: { emoji: "🔱", speed: 350, trail: "#6baed6" },
  archer: { emoji: "➳", speed: 250, trail: "#ffaa44" },
  mage: { emoji: "🔥", speed: 400, trail: "#ff4444", aoe: true },
  priest: { emoji: "✨", speed: 350, trail: "#44ff44" },
  engineer: { emoji: "🔧", speed: 300, trail: "#cccccc" },
};

class ReplayApp {
  constructor(opts = {}) {
    // Embedded mode (e.g. the arena page) reuses the same stage markup/IDs but
    // must NOT rewrite the URL or read a match-id input header.
    this.embedded = !!opts.embedded;
    // Optional callback fired once when autoplay plays through to the end.
    this.onComplete = opts.onComplete || null;
    this.data = null;
    this.coin = null;
    this.playing = false;
    this.speed = 4;
    this.turnIndex = 0;
    this.phaseIndex = -1;
    // The standalone replay page autoplays by default (?autoplay=0 opts out);
    // embedders like the arena pass an explicit opts.autoplay instead.
    this.autoplay = opts.autoplay ?? (this.embedded
      ? false
      : new URLSearchParams(location.search).get("autoplay") !== "0");
    this.unitElements = {};
    this.selectedUnitId = null;
    this.animating = false;
    this.boardEl = document.getElementById("board");
    this.cells = [];
    this.attackLines = [];
    this.init();
  }

  init() {
    // The match-id input header only exists on the standalone replay page.
    const loadBtn = document.getElementById("loadBtn");
    const matchIdInput = document.getElementById("matchIdInput");
    if (loadBtn) loadBtn.addEventListener("click", () => this.loadMatch());
    if (matchIdInput) matchIdInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.loadMatch();
    });
    document.getElementById("btnPlay").addEventListener("click", () => this.togglePlay());
    document.getElementById("btnNext").addEventListener("click", () => this.stepForward());
    document.getElementById("btnPrev").addEventListener("click", () => this.stepBackward());
    document.getElementById("btnReset").addEventListener("click", () => { this.goToStart(); this.playCoinIntro(); });
    document.getElementById("btnEnd").addEventListener("click", () => this.goToEnd());
    document.getElementById("turnSlider").addEventListener("input", (e) => this.onSliderChange(e));
    document.getElementById("speedSelect").addEventListener("change", (e) => {
      this.speed = parseFloat(e.target.value);
    });

    // matchId comes from the URL path /:lang/replay/:id (standalone page only)
    if (!this.embedded) {
      const pathMatch = window.location.pathname.match(/^\/(zh|en)\/replay\/([\w-]+)$/);
      if (pathMatch) {
        document.getElementById("matchIdInput").value = pathMatch[2];
        this.loadMatch();
      }
    }

    this.buildBoard();
  }

  buildBoard() {
    this.boardEl.innerHTML = "";
    this.cells = [];
    for (let y = 0; y < 12; y++) {
      for (let x = 0; x < 16; x++) {
        const cell = document.createElement("div");
        const isLight = (x + y) % 2 === 0;
        let cls = `cell ${isLight ? "grass-a" : "grass-b"}`;
        if (x <= 3) cls += " spawn-a";
        else if (x >= 12) cls += " spawn-b";
        cell.className = cls;
        cell.dataset.x = x;
        cell.dataset.y = y;
        this.boardEl.appendChild(cell);
        this.cells.push(cell);
      }
    }
  }

  getCell(x, y) {
    if (x < 0 || x >= 16 || y < 0 || y >= 12) return null;
    return this.cells[y * 16 + x];
  }

  // Map event ID (my.archer_1, enemy.mage_1) to snapshot ID (archer_A1, mage_B1)
  eventToSnapshotId(eventId) {
    const m = eventId.match(/^(my|enemy)\.(\w+)_(\d+)$/);
    if (!m) return null;
    const side = m[1] === "my" ? "A" : "B";
    const type = m[2];
    const num = m[3];
    return `${type}_${side}${num}`;
  }

  // Pre-compute events grouped by turn number
  buildEventsByTurn() {
    this.eventsByTurn = {};
    if (!this.data?.events) return;
    let currentTurn = 0;
    for (const ev of this.data.events) {
      const tm = ev.match(/^\[T(\d+)\]/);
      if (tm) currentTurn = parseInt(tm[1]);
      if (!this.eventsByTurn[currentTurn]) this.eventsByTurn[currentTurn] = [];
      this.eventsByTurn[currentTurn].push(ev);
    }
  }

  // Parse attack events for a given turn into attacker→target pairs
  parseAttackEvents(turnNum) {
    const turnEvents = this.eventsByTurn?.[turnNum] || [];
    const attacks = [];
    for (const ev of turnEvents) {
      if (!ev.includes("[atk]")) continue;
      const m = ev.match(/\[atk\]\s+(\S+)\s+attacked\s+(\S+)\s+for\s+(\d+)\s+dmg/);
      if (m) {
        const attackerId = this.eventToSnapshotId(m[1]);
        const targetId = this.eventToSnapshotId(m[2]);
        const dmg = parseInt(m[3]);
        if (attackerId && targetId) {
          attacks.push({ attackerId, targetId, dmg });
        }
      }
    }
    return attacks;
  }

  async loadMatch(idOverride) {
    await window.i18nReady;
    const matchId = (idOverride || document.getElementById("matchIdInput")?.value || "").trim();
    if (!matchId) return;

    document.getElementById("loading").classList.remove("hidden");
    document.getElementById("error").classList.add("hidden");
    document.getElementById("replay").classList.add("hidden");
    document.getElementById("no-snapshots").classList.add("hidden");
    document.getElementById("events-panel").classList.add("hidden");

    try {
      const res = await fetch(`/api/matches/${matchId}/replay`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.data = await res.json();
      this.buildEventsByTurn();
      this.coin = this.parseCoin();

      // Canonicalize URL: /:lang/replay/:id (skip when embedded in another page)
      if (!this.embedded) {
        const lang = (window.i18n && window.i18n.lang) || "zh";
        const canonical = `/${lang}/replay/${matchId}`;
        if (window.location.pathname !== canonical) {
          history.replaceState(null, "", canonical);
        }
      }

      document.getElementById("loading").classList.add("hidden");
      document.getElementById("replay").classList.remove("hidden");
      document.getElementById("events-panel").classList.remove("hidden");

      if (!this.data.turnSnapshots || this.data.turnSnapshots.length === 0) {
        document.getElementById("no-snapshots").classList.remove("hidden");
      }

      this.renderMatchInfo();
      this.renderEvents();
      this.goToStart();
      if (!this.embedded) this.scrollToStage();
      this.playCoinIntro(() => {
        if (this.autoplay) {
          this.speed = 8;
          document.getElementById("speedSelect").value = "8";
          this.togglePlay();
        }
      });
    } catch (err) {
      document.getElementById("loading").classList.add("hidden");
      document.getElementById("error").classList.remove("hidden");
      document.getElementById("error").textContent = `${t("common.error")}: ${err.message}`;
    }
  }

  renderMatchInfo() {
    const d = this.data;
    const pA = d.participantA;
    const pB = d.participantB;
    document.getElementById("sideA-name").textContent = pA.displayName || pA.submittedBy || t("replay.side_a.default");
    document.getElementById("sideB-name").textContent = pB.displayName || pB.submittedBy || t("replay.side_b.default");

    const badgeA = document.getElementById("mover-badge-a");
    const badgeB = document.getElementById("mover-badge-b");
    if (this.coin && badgeA && badgeB) {
      const firstIsA = this.coin.firstSide === "A";
      const firstTxt = t("replay.coin.first");
      const secondTxt = t("replay.coin.second", { bonus: this.coin.bonus });
      badgeA.textContent = firstIsA ? firstTxt : secondTxt;
      badgeB.textContent = firstIsA ? secondTxt : firstTxt;
      badgeA.className = `mover-badge ${firstIsA ? "first" : "second"}`;
      badgeB.className = `mover-badge ${firstIsA ? "second" : "first"}`;
      badgeA.classList.remove("hidden");
      badgeB.classList.remove("hidden");
    } else {
      if (badgeA) badgeA.classList.add("hidden");
      if (badgeB) badgeB.classList.add("hidden");
    }

    const summary = document.getElementById("summary-content");
    const result = d.summary;
    const resultBadge = result.myUnitsRemaining > result.enemyUnitsRemaining ? "win" :
      result.myUnitsRemaining < result.enemyUnitsRemaining ? "loss" : "draw";
    const resultText = t(`replay.summary.result_${resultBadge}`);

    summary.innerHTML = `
      <div class="summary-head">
        <span class="result-badge ${resultBadge}">${resultText}</span>
        <span class="summary-sub">${t("replay.summary.decisive_short", { turn: result.decisiveTurn })}</span>
      </div>
      <div class="summary-grid">
        <div class="sg-row"><span class="sg-k">${t("replay.summary.total_turns")}</span><span class="sg-v">${result.totalTurns}</span></div>
        <div class="sg-row"><span class="sg-k"><i class="dot blue"></i>${t("replay.summary.blue_remaining")}</span><span class="sg-v st-blue">${result.myUnitsRemaining}</span></div>
        <div class="sg-row"><span class="sg-k"><i class="dot red"></i>${t("replay.summary.red_remaining")}</span><span class="sg-v st-red">${result.enemyUnitsRemaining}</span></div>
      </div>
    `;

    const slider = document.getElementById("turnSlider");
    slider.max = (d.turnSnapshots?.length || 1) - 1;
    slider.value = 0;

    this.computeCombatStats();
    this.renderCombatStats();
  }

  // Extract coin-flip result from the [COIN] event (absolute sides: A=blue, B=red).
  // Returns null for matches that predate the coin flip (old simultaneous engine).
  parseCoin() {
    const ev = (this.data?.events || []).find((e) => e.startsWith("[COIN]"));
    if (!ev) return null;
    const m = ev.match(/\[COIN\]\s+(A|B)\s+won the toss.*?\(\+(\d+)\s*gold\)/);
    if (!m) return null;
    return { firstSide: m[1], bonus: Number(m[2]) };
  }

  // Standalone page: bring the battle board into view so the viewer lands on the
  // animation instead of the page header. The nav is static (not sticky), so
  // block:"start" is enough; rAF lets the just-revealed #replay lay out first.
  scrollToStage() {
    const stage = document.getElementById("main-area");
    if (!stage) return;
    requestAnimationFrame(() => {
      try { stage.scrollIntoView({ behavior: "smooth", block: "start" }); }
      catch { stage.scrollIntoView(); }
    });
  }

  // Opening coin-flip flourish: a spinning coin that settles on the toss winner,
  // then a result card. Calls onDone after it dismisses (click or timeout). With
  // no coin data (old match) it dismisses immediately so autoplay still runs.
  playCoinIntro(onDone) {
    const overlay = document.getElementById("coin-intro");
    if (!this.coin || !overlay) { if (onDone) onDone(); return; }

    const nameA = document.getElementById("sideA-name").textContent;
    const nameB = document.getElementById("sideB-name").textContent;
    const firstIsA = this.coin.firstSide === "A";
    const firstName = firstIsA ? nameA : nameB;
    const secondName = firstIsA ? nameB : nameA;
    const firstColor = firstIsA ? "blue" : "red";
    const secondColor = firstIsA ? "red" : "blue";
    const secondTxt = t("replay.coin.second", { bonus: this.coin.bonus });

    overlay.querySelector(".coin-result").innerHTML =
      `<div class="coin-line"><i class="dot ${firstColor}"></i><b>${firstName}</b>&nbsp;${t("replay.coin.first")}</div>` +
      `<div class="coin-line"><i class="dot ${secondColor}"></i><b>${secondName}</b>&nbsp;${secondTxt}</div>` +
      `<div class="coin-hint">${t("replay.coin.hint")}</div>`;

    const coinEl = overlay.querySelector(".coin");
    coinEl.classList.remove("win-blue", "win-red");
    overlay.classList.remove("hidden", "settled");
    overlay.classList.add("flipping");

    clearTimeout(this._coinSettleT);
    clearTimeout(this._coinDismissT);
    let finished = false;

    this._coinSettleT = setTimeout(() => {
      overlay.classList.remove("flipping");
      overlay.classList.add("settled");
      coinEl.classList.add(firstIsA ? "win-blue" : "win-red");
    }, 1050);

    const dismiss = () => {
      if (finished) return;
      finished = true;
      clearTimeout(this._coinSettleT);
      clearTimeout(this._coinDismissT);
      overlay.classList.add("hidden");
      overlay.classList.remove("flipping", "settled");
      overlay.onclick = null;
      if (onDone) onDone();
    };
    this._coinDismissT = setTimeout(dismiss, 3000);
    overlay.onclick = dismiss;
  }

  // Tally total damage dealt and HP healed across the whole match,
  // grouped by side (A = blue / my, B = red / enemy) and unit type.
  computeCombatStats() {
    const stats = { A: {}, B: {} };
    const add = (id, key, amount) => {
      const m = id.match(/^(my|enemy)\.(\w+)_\d+$/);
      if (!m) return;
      const side = m[1] === "my" ? "A" : "B";
      const bucket = (stats[side][m[2]] ||= { dmg: 0, heal: 0 });
      bucket[key] += amount;
    };
    for (const ev of (this.data?.events || [])) {
      let m;
      if ((m = ev.match(/\[atk\]\s+(\S+)\s+attacked\s+\S+\s+for\s+(\d+)\s+dmg/))) add(m[1], "dmg", +m[2]);
      else if ((m = ev.match(/\[atk\]\s+(\S+)\s+pierce hit\s+\S+\s+for\s+(\d+)\s+dmg/))) add(m[1], "dmg", +m[2]);
      else if ((m = ev.match(/\[atk\]\s+(\S+)\s+healed\s+\S+\s+\+(\d+)/))) add(m[1], "heal", +m[2]);
    }
    this.combatStats = stats;
  }

  renderCombatStats() {
    const el = document.getElementById("stats-content");
    if (!el || !this.combatStats) return;
    const order = ["knight", "spear", "archer", "mage", "priest", "engineer"];

    const renderCol = (side, dotClass) => {
      const s = this.combatStats[side];
      const totDmg = order.reduce((a, tp) => a + (s[tp]?.dmg || 0), 0);
      const rows = order.filter(tp => s[tp] && (s[tp].dmg || s[tp].heal)).map(tp => {
        const b = s[tp];
        const dmg = b.dmg ? `<span class="st-dmg">${b.dmg}</span>` : "";
        const heal = b.heal ? `<span class="st-heal">${b.heal}</span>` : "";
        return `<div class="stat-row" title="${UNIT_NAMES[tp]}">
          <span class="stat-ico" style="background-image:url('${spriteURL(tp, side)}')"></span>
          <span class="stat-vals">${dmg}${heal}</span>
        </div>`;
      }).join("") || `<div class="stat-empty">—</div>`;
      return `<div class="stats-col">
        <div class="stats-col-head"><span class="dot ${dotClass}"></span><span class="st-dmg">${totDmg}</span></div>
        ${rows}
      </div>`;
    };

    el.innerHTML = `<div class="stats-cols">${renderCol("A", "blue")}${renderCol("B", "red")}</div>`;
  }

  renderEvents() {
    const list = document.getElementById("events-list");
    list.innerHTML = "";
    if (!this.data.events) return;

    this.eventElements = [];
    for (const ev of this.data.events) {
      const div = document.createElement("div");
      let cls = "";
      if (ev.includes("[mov]")) cls = "event-move";
      else if (ev.includes("[atk]")) cls = ev.includes("healed") ? "event-skill" : "event-attack";
      else if (ev.includes("[die]")) cls = "event-death";
      else if (ev.includes("[mon]")) cls = "event-monster";
      else if (ev.includes("[buy]")) cls = "event-recruit";
      else if (ev.includes("[END]")) cls = "event-end";
      div.className = cls;
      div.textContent = ev;
      list.appendChild(div);
      this.eventElements.push(div);
    }
  }

  highlightCurrentEvents() {
    if (!this.eventElements) return;
    const turnTag = `[T${this.turnIndex + 1}]`;
    for (const el of this.eventElements) {
      const isCurrent = el.textContent.includes(turnTag);
      el.classList.toggle("event-current", isCurrent);
    }
    const current = this.eventElements.find(el => el.classList.contains("event-current"));
    if (current) {
      const list = document.getElementById("events-list");
      const listRect = list.getBoundingClientRect();
      const elRect = current.getBoundingClientRect();
      if (elRect.top < listRect.top || elRect.bottom > listRect.bottom) {
        list.scrollTop = current.offsetTop - list.offsetTop - list.clientHeight / 3;
      }
    }
  }

  getCurrentSnapshot() {
    if (!this.data?.turnSnapshots?.length) return null;
    const ts = this.data.turnSnapshots[this.turnIndex];
    if (!ts) return null;
    if (this.phaseIndex < 0) return ts.start;
    return ts.phases[this.phaseIndex]?.units || ts.start;
  }

  findUnitInSnapshot(unitId) {
    const snapshot = this.getCurrentSnapshot();
    if (!snapshot) return null;
    return snapshot.find(u => u.id === unitId) || null;
  }

  // Get unit center position in pixels
  getUnitCenter(unitId, snapshot) {
    const u = snapshot?.find(u => u.id === unitId);
    if (!u) return null;
    return {
      x: u.pos[0] * STEP + CELL_SIZE / 2,
      y: u.pos[1] * STEP + CELL_SIZE / 2
    };
  }

  createUnitEl(u) {
    const el = document.createElement("div");
    el.className = `unit${u.hp <= 0 ? " dead" : ""}${u.defending ? " defending" : ""}`;
    el.style.transform = `translate(${u.pos[0] * STEP}px, ${u.pos[1] * STEP}px)`;
    el.dataset.unitId = u.id;
    el.dataset.unitType = u.type;

    const sprite = document.createElement("div");
    sprite.className = `sprite side-${u.side.toLowerCase()}`;
    sprite.innerHTML = `<div class="sprite-fig" style="background-image:url('${spriteURL(u.type, u.side)}')"></div>`;

    const hpBar = document.createElement("div");
    hpBar.className = "hp-bar";
    const hpFill = document.createElement("div");
    const hpPct = Math.max(0, u.hp / u.maxHp * 100);
    hpFill.className = `hp-fill ${hpPct > 60 ? "hp-high" : hpPct > 30 ? "hp-mid" : "hp-low"}`;
    hpFill.style.width = `${hpPct}%`;
    hpBar.appendChild(hpFill);

    el.appendChild(sprite);
    el.appendChild(hpBar);

    el.addEventListener("click", () => {
      const current = this.findUnitInSnapshot(u.id);
      if (current) this.selectUnit(current);
    });
    return el;
  }

  renderUnits(snapshot) {
    if (!snapshot) return;

    Object.values(this.unitElements).forEach(el => el.remove());
    this.unitElements = {};

    for (const u of snapshot) {
      const el = this.createUnitEl(u);
      this.boardEl.appendChild(el);
      this.unitElements[u.id] = el;
    }

    this.updateSelectedHighlight();
    this.renderRoster(snapshot);
  }

  updateUnitPositions(newSnapshot) {
    if (!newSnapshot) return;

    for (const u of newSnapshot) {
      let el = this.unitElements[u.id];
      if (!el) {
        el = this.createUnitEl(u);
        this.boardEl.appendChild(el);
        this.unitElements[u.id] = el;
      }

      el.style.transform = `translate(${u.pos[0] * STEP}px, ${u.pos[1] * STEP}px)`;

      const hpFill = el.querySelector(".hp-fill");
      if (hpFill) {
        const hpPct = Math.max(0, u.hp / u.maxHp * 100);
        hpFill.className = `hp-fill ${hpPct > 60 ? "hp-high" : hpPct > 30 ? "hp-mid" : "hp-low"}`;
        hpFill.style.width = `${hpPct}%`;
      }

      el.classList.toggle("dead", u.hp <= 0);
      el.classList.toggle("defending", !!u.defending);
    }
  }

  updateSelectedHighlight() {
    for (const [id, el] of Object.entries(this.unitElements)) {
      el.classList.toggle("selected", id === this.selectedUnitId);
    }
  }

  showDamageNumber(unitId, amount, type = "damage") {
    const el = this.unitElements[unitId];
    if (!el) return;
    const dmg = document.createElement("div");
    dmg.className = `damage-number ${type}`;
    dmg.textContent = type === "heal" ? `+${amount}` : `-${amount}`;
    dmg.style.left = `${parseInt(el.style.transform.match(/\((\d+)/)?.[1] || "0") + 20}px`;
    dmg.style.top = `${parseInt(el.style.transform.match(/,\s*(\d+)/)?.[1] || "0")}px`;
    this.boardEl.appendChild(dmg);
    setTimeout(() => dmg.remove(), 1000);
  }

  flashUnit(unitId, effectClass, duration = 300) {
    const el = this.unitElements[unitId];
    if (!el) return;
    el.classList.add(effectClass);
    setTimeout(() => el.classList.remove(effectClass), duration);
  }

  // Draw attack line from attacker to target
  drawAttackLine(from, to, type = "attack") {
    const line = document.createElement("div");
    line.className = `attack-line ${type}`;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;

    line.style.width = `${length}px`;
    line.style.left = `${from.x}px`;
    line.style.top = `${from.y}px`;
    line.style.transform = `rotate(${angle}deg)`;
    line.style.transformOrigin = "0 50%";

    this.boardEl.appendChild(line);
    setTimeout(() => line.remove(), 400);
  }

  // Animate projectile from attacker to target
  animateProjectile(from, to, unitType) {
    const proj = PROJECTILE_TYPES[unitType] || PROJECTILE_TYPES.knight;
    const el = document.createElement("div");
    el.className = "projectile";
    el.textContent = proj.emoji;

    const dx = to.x - from.x;
    const dy = to.y - from.y;

    el.style.left = `${from.x}px`;
    el.style.top = `${from.y}px`;

    // Use CSS animation with custom properties
    el.style.setProperty("--dx", `${dx}px`);
    el.style.setProperty("--dy", `${dy}px`);
    el.style.setProperty("--trail", proj.trail);
    el.style.animationDuration = `${proj.speed}ms`;

    this.boardEl.appendChild(el);
    setTimeout(() => el.remove(), proj.speed + 100);

    // Draw trail line
    this.drawAttackLine(from, to, proj.aoe ? "aoe" : "normal");

    return proj.speed;
  }

  // Screen shake effect for heavy hits
  screenShake(intensity = 3, duration = 200) {
    const container = document.getElementById("board-container");
    container.classList.add("shaking");
    container.style.setProperty("--shake-intensity", `${intensity}px`);
    setTimeout(() => container.classList.remove("shaking"), duration);
  }

  // Show explosion/impact effect at position
  showImpact(x, y, type = "normal") {
    const el = document.createElement("div");
    el.className = `impact-effect ${type}`;
    el.style.left = `${x - 20}px`;
    el.style.top = `${y - 20}px`;
    this.boardEl.appendChild(el);
    setTimeout(() => el.remove(), 500);
  }

  // Show AOE circle effect (for mage splash)
  showAoeEffect(x, y, radius = 2) {
    const el = document.createElement("div");
    el.className = "aoe-effect";
    el.style.left = `${x - radius * STEP}px`;
    el.style.top = `${y - radius * STEP}px`;
    el.style.width = `${(radius * 2 + 1) * STEP}px`;
    el.style.height = `${(radius * 2 + 1) * STEP}px`;
    this.boardEl.appendChild(el);
    setTimeout(() => el.remove(), 600);
  }

  clearEffects() {
    this.boardEl.querySelectorAll(".attack-line, .projectile, .impact-effect, .aoe-effect").forEach(el => el.remove());
  }

  selectUnit(unit) {
    this.selectedUnitId = unit.id;
    this.updateSelectedHighlight();

    const detail = document.getElementById("unit-detail");
    detail.classList.remove("hidden");

    const icon = document.getElementById("detail-icon");
    icon.className = `sprite detail-sprite side-${unit.side.toLowerCase()}`;
    icon.innerHTML = `<div class="sprite-fig" style="background-image:url('${spriteURL(unit.type, unit.side)}')"></div>`;

    const sideLabel = unit.side === "A" ? "蓝" : "红";
    document.getElementById("detail-name").textContent = `${UNIT_NAMES[unit.type]} (${sideLabel})`;
    document.getElementById("detail-type").textContent = unit.id;

    const hpPct = Math.max(0, unit.hp / unit.maxHp * 100);
    const hpFill = document.getElementById("detail-hp-fill");
    hpFill.className = hpPct > 60 ? "hp-high" : hpPct > 30 ? "hp-mid" : "hp-low";
    hpFill.style.width = `${hpPct}%`;

    const stats = UNIT_STATS[unit.type];
    document.getElementById("detail-stats").innerHTML = `
      <span>HP: ${Math.max(0,unit.hp)}/${unit.maxHp}</span>
      <span>ATK: ${stats.atk}</span>
      <span>射程: ${stats.range}</span>
      <span>移动: ${stats.move}</span>
      <span>特性: ${stats.special}</span>
      <span>${unit.defending ? "🛡️ 防御中" : ""}</span>
    `;
  }

  renderRoster(snapshot) {
    const rosterA = document.getElementById("roster-a");
    const rosterB = document.getElementById("roster-b");
    rosterA.innerHTML = "";
    rosterB.innerHTML = "";

    let aliveA = 0, aliveB = 0;
    for (const u of snapshot) {
      // Neutral monsters (side "N") belong to no player — keep them off both rosters.
      if (u.side !== "A" && u.side !== "B") continue;
      const el = document.createElement("div");
      el.className = `roster-unit side-${u.side.toLowerCase()}${u.hp <= 0 ? " dead" : ""}`;
      el.innerHTML = `<div class="roster-fig" style="background-image:url('${spriteURL(u.type, u.side)}')"></div><div class="roster-hp"><div class="roster-hp-fill" style="width:${Math.max(0,u.hp/u.maxHp*100)}%;background:${u.hp/u.maxHp>0.6?"var(--hp-green)":u.hp/u.maxHp>0.3?"var(--hp-yellow)":"var(--hp-red)"}"></div></div>`;
      el.addEventListener("click", () => {
        const current = this.findUnitInSnapshot(u.id);
        if (current) this.selectUnit(current);
      });
      if (u.side === "A") { rosterA.appendChild(el); if (u.hp > 0) aliveA++; }
      else { rosterB.appendChild(el); if (u.hp > 0) aliveB++; }
    }
    document.getElementById("roster-label-a").textContent = `⚔ A · ${aliveA}/${rosterA.children.length}`;
    document.getElementById("roster-label-b").textContent = `🛡 B · ${aliveB}/${rosterB.children.length}`;
  }

  updateUI() {
    const ts = this.data?.turnSnapshots;
    const total = ts?.length || 0;
    document.getElementById("turn-label").textContent = t("replay.turn.label", { current: this.turnIndex + 1, total });

    const phaseKey = ts?.[this.turnIndex]?.phases[this.phaseIndex]?.phase;
    const phaseName = this.phaseIndex < 0 ? t("phase.initial") : (phaseKey ? phaseLabel(phaseKey) : "—");
    document.getElementById("phase-label").textContent = phaseName;

    document.getElementById("turnSlider").value = this.turnIndex;
    document.getElementById("btnPlay").textContent = this.playing ? "⏸️" : "▶️";
    this.highlightCurrentEvents();
  }

  togglePlay() {
    this.playing = !this.playing;
    this.updateUI();
    if (this.playing) this.playLoop();
  }

  async playLoop() {
    while (this.playing) {
      const advanced = this.stepForward();
      if (!advanced) {
        this.playing = false;
        this.updateUI();
        // Fired once when autoplay reaches the natural end (not on manual pause).
        if (typeof this.onComplete === "function") { const cb = this.onComplete; this.onComplete = null; cb(); }
        break;
      }
      const delay = this.getPhaseDelay();
      await new Promise(r => setTimeout(r, delay / this.speed));
    }
  }

  getPhaseDelay() {
    if (this.phaseIndex < 0) return 500;
    const ts = this.data.turnSnapshots[this.turnIndex];
    const phase = ts?.phases[this.phaseIndex]?.phase;
    switch (phase) {
      case "defend": return 600;
      case "move": return 800;
      case "attack": return 1500;
      case "death": return 800;
      case "buy": return 600;
      case "monster": return 1000;
      default: return 600;
    }
  }

  stepForward() {
    if (!this.data?.turnSnapshots?.length) return false;
    const ts = this.data.turnSnapshots[this.turnIndex];

    this.clearEffects();

    if (this.phaseIndex < ts.phases.length - 1) {
      this.phaseIndex++;
    } else if (this.turnIndex < this.data.turnSnapshots.length - 1) {
      this.turnIndex++;
      this.phaseIndex = -1;
    } else {
      return false;
    }

    const snapshot = this.getCurrentSnapshot();
    this.updateUnitPositions(snapshot);
    this.playPhaseEffects();
    this.renderRoster(snapshot);
    this.updateUI();
    return true;
  }

  stepBackward() {
    if (!this.data?.turnSnapshots?.length) return;

    this.clearEffects();

    if (this.phaseIndex > -1) {
      this.phaseIndex--;
    } else if (this.turnIndex > 0) {
      this.turnIndex--;
      const ts = this.data.turnSnapshots[this.turnIndex];
      this.phaseIndex = ts.phases.length - 1;
    } else {
      return;
    }

    const snapshot = this.getCurrentSnapshot();
    this.updateUnitPositions(snapshot);
    this.renderRoster(snapshot);
    this.updateUI();
  }

  goToStart() {
    this.turnIndex = 0;
    this.phaseIndex = -1;
    this.playing = false;
    this.clearEffects();
    const snapshot = this.getCurrentSnapshot();
    this.renderUnits(snapshot);
    this.updateUI();
  }

  goToEnd() {
    if (!this.data?.turnSnapshots?.length) return;
    this.playing = false;
    this.clearEffects();
    this.turnIndex = this.data.turnSnapshots.length - 1;
    const ts = this.data.turnSnapshots[this.turnIndex];
    this.phaseIndex = ts.phases.length - 1;
    const snapshot = this.getCurrentSnapshot();
    this.updateUnitPositions(snapshot);
    this.renderRoster(snapshot);
    this.updateUI();
  }

  onSliderChange(e) {
    this.turnIndex = parseInt(e.target.value);
    this.phaseIndex = -1;
    this.playing = false;
    this.clearEffects();
    const snapshot = this.getCurrentSnapshot();
    this.renderUnits(snapshot);
    this.updateUI();
  }

  playPhaseEffects() {
    if (this.phaseIndex < 0) return;
    const ts = this.data.turnSnapshots[this.turnIndex];
    const phase = ts.phases[this.phaseIndex];
    const prevSnapshot = this.phaseIndex === 0 ? ts.start : ts.phases[this.phaseIndex - 1]?.units;
    if (!prevSnapshot) return;

    const prevHp = {};
    const prevPos = {};
    const unitTypes = {};
    for (const u of prevSnapshot) {
      prevHp[u.id] = u.hp;
      prevPos[u.id] = u.pos;
      unitTypes[u.id] = u.type;
    }

    if (phase.phase === "attack") {
      this.playAttackEffects(prevSnapshot, phase.units);
    } else {
      // Generic HP change effects for defend/death phases
      for (const u of phase.units) {
        const prev = prevHp[u.id];
        if (prev === undefined) continue;
        if (u.hp < prev && u.hp > 0) {
          this.showDamageNumber(u.id, prev - u.hp, "damage");
          this.flashUnit(u.id, "attack-flash", 300);
        }
        if (u.hp <= 0 && prev > 0) {
          setTimeout(() => this.flashUnit(u.id, "dying", 600), 200);
        }
      }
    }
  }

  playAttackEffects(prevSnapshot, currSnapshot) {
    // A round contains two attack phases (first mover, then second mover), but
    // parseAttackEvents returns every [atk] line for the whole round. Scope to
    // THIS phase by keeping only attacks whose target actually lost HP between
    // this phase's prev and curr snapshots. First and second movers hit disjoint
    // sides, so this cleanly separates the two attack phases (and avoids
    // re-rendering the same projectiles twice per round).
    const hpBefore = {};
    for (const u of prevSnapshot) hpBefore[u.id] = u.hp;
    const hpAfter = {};
    for (const u of currSnapshot) hpAfter[u.id] = u.hp;
    const attacks = this.parseAttackEvents(this.turnIndex + 1).filter((a) => {
      const before = hpBefore[a.targetId];
      const after = hpAfter[a.targetId];
      return before !== undefined && after !== undefined && after < before;
    });

    const prevMap = {};
    for (const u of prevSnapshot) prevMap[u.id] = u;

    // Primary targets get a projectile + damage number below; track them so the
    // HP-diff pass doesn't double-count. Secondary HP changes (mage splash,
    // spear pierce, priest heal) are detected from the snapshot diff instead.
    const shownIds = new Set(attacks.map(a => a.targetId));

    // Stagger attacks: each one 250ms apart
    attacks.forEach((atk, i) => {
      setTimeout(() => {
        const fromPos = this.getUnitCenter(atk.attackerId, prevSnapshot);
        const toPos = this.getUnitCenter(atk.targetId, prevSnapshot);
        if (!fromPos || !toPos) return;

        const attackerType = prevMap[atk.attackerId]?.type || "knight";
        const projTime = this.animateProjectile(fromPos, toPos, attackerType);

        // After projectile hits, show impact + damage
        setTimeout(() => {
          this.showImpact(toPos.x, toPos.y, attackerType === "mage" ? "aoe" : "normal");
          // Mage splash: ring the radius-1 area around the target.
          if (attackerType === "mage") this.showAoeEffect(toPos.x, toPos.y, 1);
          this.showDamageNumber(atk.targetId, atk.dmg, "damage");
          this.flashUnit(atk.targetId, "attack-flash", 300);

          // Screen shake for big hits
          if (atk.dmg >= 25) this.screenShake(atk.dmg >= 30 ? 5 : 3, 150);

          // Check death
          const target = currSnapshot.find(u => u.id === atk.targetId);
          if (target && target.hp <= 0) {
            setTimeout(() => this.flashUnit(atk.targetId, "dying", 600), 150);
          }
        }, projTime);

        // Flash attacker sprite (lunge effect)
        const attackerEl = this.unitElements[atk.attackerId];
        if (attackerEl) {
          attackerEl.classList.add("attacking");
          setTimeout(() => attackerEl.classList.remove("attacking"), 400);
        }
      }, i * 250);
    });

    // Snapshot HP-diff pass for effects not tied to a primary attack:
    // priest heals (HP up) and mage splash / spear pierce (HP down on units
    // that weren't the primary target).
    const prevHp = {};
    for (const u of prevSnapshot) prevHp[u.id] = u.hp;
    for (const u of currSnapshot) {
      if (shownIds.has(u.id)) continue;
      const prev = prevHp[u.id];
      if (prev === undefined) continue;
      if (u.hp > prev) {
        this.showDamageNumber(u.id, u.hp - prev, "heal");
        this.flashUnit(u.id, "heal-glow", 500);
      } else if (u.hp < prev) {
        this.showDamageNumber(u.id, prev - u.hp, "damage");
        this.flashUnit(u.id, "attack-flash", 300);
        if (u.hp <= 0) setTimeout(() => this.flashUnit(u.id, "dying", 600), 200);
      }
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // Auto-init only on the standalone replay page (identified by its match-id
  // input header). Embedders like the arena construct ReplayApp themselves.
  if (document.getElementById("matchIdInput")) {
    window.replayApp = new ReplayApp();
  }
});
