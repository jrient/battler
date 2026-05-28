// AgentClash Battle Replay Viewer — Fire Emblem Style

const CELL_SIZE = 28;
const CELL_GAP = 1;
const STEP = CELL_SIZE + CELL_GAP;

const UNIT_ICONS = { knight: "🗡️", spear: "🔱", archer: "🏹", mage: "🔮", priest: "✚" };
const UNIT_NAMES = { knight: "重甲骑士", spear: "长矛兵", archer: "弓手", mage: "法师", priest: "牧师" };
const UNIT_STATS = {
  knight: { hp: 100, atk: 20, range: 1, move: 2, special: "受伤减半" },
  spear: { hp: 60, atk: 25, range: 2, move: 3, special: "穿透" },
  archer: { hp: 40, atk: 18, range: 4, move: 2, special: "远程" },
  mage: { hp: 35, atk: 30, range: 3, move: 1, special: "fireball" },
  priest: { hp: 50, atk: 8, range: 2, move: 1, special: "heal" },
};

function phaseLabel(phase) {
  return window.t ? t(`phase.${phase}`) : phase;
}

const PROJECTILE_TYPES = {
  knight: { emoji: "⚔️", speed: 300, trail: "#ffffff" },
  spear: { emoji: "🔱", speed: 350, trail: "#6baed6" },
  archer: { emoji: "➳", speed: 250, trail: "#ffaa44" },
  mage: { emoji: "🔥", speed: 400, trail: "#ff4444", aoe: true },
  priest: { emoji: "✨", speed: 350, trail: "#44ff44" },
};

class ReplayApp {
  constructor() {
    this.data = null;
    this.playing = false;
    this.speed = 2;
    this.turnIndex = 0;
    this.phaseIndex = -1;
    this.unitElements = {};
    this.selectedUnitId = null;
    this.animating = false;
    this.boardEl = document.getElementById("board");
    this.cells = [];
    this.attackLines = [];
    this.init();
  }

  init() {
    document.getElementById("loadBtn").addEventListener("click", () => this.loadMatch());
    document.getElementById("matchIdInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.loadMatch();
    });
    document.getElementById("btnPlay").addEventListener("click", () => this.togglePlay());
    document.getElementById("btnNext").addEventListener("click", () => this.stepForward());
    document.getElementById("btnPrev").addEventListener("click", () => this.stepBackward());
    document.getElementById("btnReset").addEventListener("click", () => this.goToStart());
    document.getElementById("btnEnd").addEventListener("click", () => this.goToEnd());
    document.getElementById("turnSlider").addEventListener("input", (e) => this.onSliderChange(e));
    document.getElementById("speedSelect").addEventListener("change", (e) => {
      this.speed = parseFloat(e.target.value);
    });

    // matchId comes from the URL path /:lang/replay/:id
    const pathMatch = window.location.pathname.match(/^\/(zh|en)\/replay\/([\w-]+)$/);
    if (pathMatch) {
      document.getElementById("matchIdInput").value = pathMatch[2];
      this.loadMatch();
    }

    this.buildBoard();
  }

  buildBoard() {
    this.boardEl.innerHTML = "";
    this.cells = [];
    for (let y = 0; y < 18; y++) {
      for (let x = 0; x < 32; x++) {
        const cell = document.createElement("div");
        const isLight = (x + y) % 2 === 0;
        let cls = `cell ${isLight ? "grass-a" : "grass-b"}`;
        if (x <= 3) cls += " spawn-a";
        else if (x >= 28) cls += " spawn-b";
        cell.className = cls;
        cell.dataset.x = x;
        cell.dataset.y = y;
        this.boardEl.appendChild(cell);
        this.cells.push(cell);
      }
    }
  }

  getCell(x, y) {
    if (x < 0 || x >= 32 || y < 0 || y >= 18) return null;
    return this.cells[y * 32 + x];
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

  // Parse skill events for a given turn (heals, etc.)
  parseSkillEvents(turnNum) {
    const turnEvents = this.eventsByTurn?.[turnNum] || [];
    const skills = [];
    for (const ev of turnEvents) {
      if (!ev.includes("[skl]")) continue;
      // Heal pattern
      const hm = ev.match(/\[skl\]\s+(\S+)\s+healed\s+(\S+)\s+for\s+(\d+)/);
      if (hm) {
        const casterId = this.eventToSnapshotId(hm[1]);
        const targetId = this.eventToSnapshotId(hm[2]);
        const amount = parseInt(hm[3]);
        if (casterId && targetId) {
          skills.push({ casterId, targetId, amount, type: "heal" });
        }
      }
      // Fireball pattern
      const fm = ev.match(/\[skl\]\s+(\S+)\s+fireball.*?(\d+)\s+dmg/);
      if (fm) {
        const casterId = this.eventToSnapshotId(fm[1]);
        const dmg = parseInt(fm[2]);
        if (casterId) {
          skills.push({ casterId, dmg, type: "fireball" });
        }
      }
    }
    return skills;
  }

  async loadMatch() {
    await window.i18nReady;
    const matchId = document.getElementById("matchIdInput").value.trim();
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

      // Canonicalize URL: /:lang/replay/:id
      const lang = (window.i18n && window.i18n.lang) || "zh";
      const canonical = `/${lang}/replay/${matchId}`;
      if (window.location.pathname !== canonical) {
        history.replaceState(null, "", canonical);
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

    const summary = document.getElementById("summary-content");
    const result = d.summary;
    const resultBadge = result.myUnitsRemaining > result.enemyUnitsRemaining ? "win" :
      result.myUnitsRemaining < result.enemyUnitsRemaining ? "loss" : "draw";
    const resultText = t(`replay.summary.result_${resultBadge}`);

    summary.innerHTML = `
      <div><span class="result-badge ${resultBadge}">${resultText}</span></div>
      <div>${t("replay.summary.total_turns")}: ${result.totalTurns}</div>
      <div>${t("replay.summary.remaining", { a: result.myUnitsRemaining, b: result.enemyUnitsRemaining })}</div>
      <div>${t("replay.summary.decisive", { turn: result.decisiveTurn })}</div>
    `;

    const slider = document.getElementById("turnSlider");
    slider.max = (d.turnSnapshots?.length || 1) - 1;
    slider.value = 0;
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
      else if (ev.includes("[atk]")) cls = "event-attack";
      else if (ev.includes("[skl]")) cls = "event-skill";
      else if (ev.includes("[die]")) cls = "event-death";
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
    sprite.innerHTML = `<span class="unit-icon">${UNIT_ICONS[u.type]}</span>`;

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

  // Show AOE circle effect (for mage fireball)
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
    icon.className = `sprite side-${unit.side.toLowerCase()}`;
    icon.innerHTML = `<span class="unit-icon">${UNIT_ICONS[unit.type]}</span>`;

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

    for (const u of snapshot) {
      const el = document.createElement("div");
      el.className = `roster-unit side-${u.side.toLowerCase()}${u.hp <= 0 ? " dead" : ""}`;
      el.innerHTML = `${UNIT_ICONS[u.type]}<div class="roster-hp"><div class="roster-hp-fill" style="width:${Math.max(0,u.hp/u.maxHp*100)}%;background:${u.hp/u.maxHp>0.6?"var(--hp-green)":u.hp/u.maxHp>0.3?"var(--hp-yellow)":"var(--hp-red)"}"></div></div>`;
      el.addEventListener("click", () => {
        const current = this.findUnitInSnapshot(u.id);
        if (current) this.selectUnit(current);
      });
      if (u.side === "A") rosterA.appendChild(el);
      else rosterB.appendChild(el);
    }
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
      case "skill": return 1200;
      case "death": return 800;
      case "buy": return 600;
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
    } else if (phase.phase === "skill") {
      this.playSkillEffects(prevSnapshot, phase.units);
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
    const attacks = this.parseAttackEvents(this.turnIndex + 1);
    const prevMap = {};
    for (const u of prevSnapshot) prevMap[u.id] = u;

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
  }

  playSkillEffects(prevSnapshot, currSnapshot) {
    const skills = this.parseSkillEvents(this.turnIndex + 1);
    const prevMap = {};
    for (const u of prevSnapshot) prevMap[u.id] = u;

    skills.forEach((sk, i) => {
      setTimeout(() => {
        const casterPos = this.getUnitCenter(sk.casterId, prevSnapshot);

        if (sk.type === "heal" && sk.targetId) {
          const targetPos = this.getUnitCenter(sk.targetId, prevSnapshot);
          if (casterPos && targetPos) {
            this.animateProjectile(casterPos, targetPos, "priest");
            setTimeout(() => {
              this.showImpact(targetPos.x, targetPos.y, "heal");
              this.showDamageNumber(sk.targetId, sk.amount, "heal");
              this.flashUnit(sk.targetId, "heal-glow", 500);
            }, 350);
          }
        }

        if (sk.type === "fireball" && casterPos) {
          // AOE explosion centered on mage
          this.showAoeEffect(casterPos.x, casterPos.y, 1);
          this.screenShake(4, 200);
        }
      }, i * 300);
    });

    // Also check for HP changes from skills in snapshot comparison
    const prevHp = {};
    for (const u of prevSnapshot) prevHp[u.id] = u.hp;
    for (const u of currSnapshot) {
      const prev = prevHp[u.id];
      if (prev === undefined) continue;
      if (u.hp < prev && u.hp > 0) {
        // Don't double-show if already shown by attack phase
        // This handles skill damage not covered by parsed events
      }
      if (u.hp > prev) {
        this.showDamageNumber(u.id, u.hp - prev, "heal");
        this.flashUnit(u.id, "heal-glow", 500);
      }
      if (u.hp <= 0 && prev > 0) {
        setTimeout(() => this.flashUnit(u.id, "dying", 600), 200);
      }
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  window.replayApp = new ReplayApp();
});
