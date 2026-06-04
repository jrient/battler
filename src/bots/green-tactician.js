// Phalanx-Reaper v2 — LOS-aware focus-fire combined-arms agent for AgentClash.
//
// CRITICAL engine fact (confirmed from a LIVE match report, NOT in the stale repo
// engine): the live engine has LINE OF SIGHT. A ranged attack (range>1) is
// blocked if any living unit sits strictly between attacker and target. So a
// dense ball self-blocks: only units with a clear lane actually fire. This agent
//  - never assigns a blocked shot (canHit checks LOS),
//  - slides ranged units laterally to a cell that HAS a firing lane,
//  - advances as a cohesive block so it isn't chewed up piecemeal,
//  - concentrates fire to KILL (minimal overkill), priests/mages first,
//  - DEFENDS any unit that can neither shoot nor usefully move (halves incoming).
// Splash/pierce are AoE off the primary target and do NOT need their own LOS.

const COST   = { knight:5, spear:3, archer:3, mage:4, priest:4, engineer:2 };
const RANGE  = { knight:1, spear:2, archer:3, mage:3, priest:2, engineer:1 };
const MOVE   = { knight:3, spear:3, archer:2, mage:1, priest:2, engineer:3 };
const ATK    = { knight:20, spear:25, archer:18, mage:30, priest:10, engineer:12 };
const THREAT = { mage:12, priest:11, archer:8, spear:7, engineer:4, knight:2, monster:0 };
const KEEP   = { knight:5, mage:4, spear:3, archer:3, priest:2, engineer:1 };

const W = 16, H = 12;
const mhd  = (a,b)=> Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]);
const cheb = (a,b)=> Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1]));
const key  = (p)=> p[0]+","+p[1];
const dmgVs = (att, tt)=> tt==="knight" ? Math.floor(ATK[att]/2) : ATK[att];
const splashVs = (tt)=> tt==="knight" ? Math.floor(Math.floor(ATK.mage/2)/2) : Math.floor(ATK.mage/2);

// Bresenham LOS: true if no blocker (other than the moving unit `exKey`) sits
// strictly between (ax,ay) and (bx,by). Endpoints are never tested.
function losClear(ax, ay, bx, by, blockers, exKey) {
  let x0 = ax, y0 = ay;
  const dx = Math.abs(bx-ax), dy = Math.abs(by-ay);
  const sx = ax<bx?1:-1, sy = ay<by?1:-1;
  let err = dx - dy;
  for (;;) {
    const e2 = 2*err;
    if (e2 > -dy) { err -= dy; x0 += sx; }
    if (e2 < dx)  { err += dx; y0 += sy; }
    if (x0===bx && y0===by) return true;
    const k = x0+","+y0;
    if (k !== exKey && blockers.has(k)) return false;
  }
}

function scoreHit(e, dmg, predHP) {
  const hp = predHP[e.id];
  if (hp <= 0) return 0;
  const kill = dmg >= hp;
  return (kill ? 500 + (THREAT[e.type]||1)*50 : 0) + Math.min(dmg, hp) + (THREAT[e.type]||1);
}

export function makeDecide(cfg = {}) {
  const TARGET   = cfg.TARGET || { knight:5, archer:14, mage:8, priest:2 };
  const FILL     = cfg.FILL || "archer";
  const EDGE     = cfg.EDGE !== false;     // hold max range when already shooting
  const ADVANCE  = cfg.ADVANCE !== false;  // close the gap when no lane
  const SPREAD   = cfg.SPREAD ?? 1;        // anti-cluster (also limits self-block)
  const ASPREAD  = cfg.ASPREAD ?? 12;      // spread weight while approaching
  const COHESION = cfg.COHESION !== false; // don't outrun the army front
  const LEAD     = cfg.LEAD ?? 2;          // tiles a unit may lead the front by
  const JUNGLE   = cfg.JUNGLE === true;    // one-shot reachable monsters with idle units (opportunistic, no maul)
  const JUNGLE_MOVE = cfg.JUNGLE_MOVE === true; // also send far-from-enemy units to mass on monsters (economy, riskier)
  const JUNGLE_CHIP = cfg.JUNGLE_CHIP === true; // chip a monster over multiple turns (accept the maul) to actually farm it
  const EXPDEF   = cfg.EXPDEF === true;    // exposed ranged unit with no shot defends instead of crawling
  const MONPEN   = cfg.MONPEN ?? 0;        // mage: penalty per monster within splash radius of target (soft-avoid waking the jungle)
  const MONFEAR  = cfg.MONFEAR ?? 0;       // movement: fragile ranged units avoid standing near a monster

  function doBuy(ctx, actions) {
    let money = ctx.myMoney || 0;
    const cheapest = Math.min(...Object.keys(TARGET).map(t=>COST[t]), COST[FILL]);
    if (money < cheapest) return;
    const counts = {};
    for (const u of ctx.myArmy) counts[u.type] = (counts[u.type]||0) + (u.count||0);
    let guard = 0;
    while (guard++ < 400) {
      let pick = null, bestDef = -Infinity;
      for (const t of Object.keys(TARGET)) {
        if (TARGET[t] <= 0 || COST[t] > money) continue;
        const def = (TARGET[t] - (counts[t]||0)) / TARGET[t];
        if (def > bestDef) { bestDef = def; pick = t; }
      }
      if (!pick || bestDef <= 0) {
        // Quota met → spend leftover on FILL only. Never auto-buy engineers (they
        // just feed kills); bank the gold for a real unit next turn instead.
        if (COST[FILL] <= money) pick = FILL;
        else break;
      }
      actions.push({ action: "buy", unitType: pick });
      counts[pick] = (counts[pick]||0) + 1;
      money -= COST[pick];
    }
  }

  return function decideTurn(ctx) {
    const actions = [];
    doBuy(ctx, actions);

    const my  = ctx.myUnits || [];
    const en  = ctx.enemyUnits || [];
    const neu = ctx.neutralUnits || [];
    if (!my.length || !en.length) return actions;

    const predHP = {};
    for (const e of en) predHP[e.id] = e.hp;

    // Blockers for LOS = every living body (friend, foe, monster). Positions are
    // static through the attack phase (deaths resolve after), so this set is
    // valid for all our attacks this half-turn.
    const blockers = new Set();
    for (const u of my)  blockers.add(key(u.pos));
    for (const e of en)  blockers.add(key(e.pos));
    for (const m of neu) blockers.add(key(m.pos));
    const occ = blockers; // same set also gates movement collisions

    const byId = {}; for (const u of my) byId[u.id] = u;
    const acted = new Set();

    const hasLOS = (u, tx, ty) => RANGE[u.type] <= 1 || losClear(u.pos[0], u.pos[1], tx, ty, blockers, key(u.pos));
    const canHit = (u, e) =>
      predHP[e.id] > 0 && mhd(u.pos, e.pos) <= RANGE[u.type] && hasLOS(u, e.pos[0], e.pos[1]);

    // PHASE 1: priests heal the most valuable wounded ally in range+LOS.
    for (const u of my) {
      if (u.type !== "priest") continue;
      let best = null, bs = -Infinity;
      for (const a of my) {
        if (a.id === u.id || a.hp >= a.maxHp * 0.85) continue;
        if (mhd(u.pos, a.pos) > RANGE.priest) continue;
        if (!hasLOS(u, a.pos[0], a.pos[1])) continue;
        const eff = Math.min(20, a.maxHp - a.hp);
        const s = (KEEP[a.type]||1) * 100 + eff;
        if (s > bs) { bs = s; best = a; }
      }
      if (best) { actions.push({unitId:u.id, action:"attack", targetUnitId:best.id}); acted.add(u.id); }
    }

    // PHASE 2: mages fire (splash-max). Splash needs no LOS; primary target does.
    for (const u of my) {
      if (u.type !== "mage" || acted.has(u.id)) continue;
      const inR = en.filter(e => canHit(u, e));
      if (!inR.length) continue;
      let best = null, bs = -Infinity;
      for (const e of inR) {
        let val = scoreHit(e, dmgVs("mage", e.type), predHP);
        for (const o of en) {
          if (o.id === e.id || predHP[o.id] <= 0) continue;
          if (cheb(o.pos, e.pos) <= 1) val += scoreHit(o, splashVs(o.type), predHP);
        }
        // Soft-avoid: splashing within radius 1 of a monster ENRAGES it (then it
        // hunts and mauls this fragile mage). Penalize, but still fire if it's the
        // only / clearly-best target.
        if (MONPEN) for (const m of neu) if (cheb(m.pos, e.pos) <= 1) val -= MONPEN;
        if (val > bs) { bs = val; best = e; }
      }
      if (!best) continue;
      actions.push({unitId:u.id, action:"attack", targetUnitId:best.id}); acted.add(u.id);
      predHP[best.id] -= dmgVs("mage", best.type);
      for (const o of en) {
        if (o.id === best.id || predHP[o.id] <= 0) continue;
        if (cheb(o.pos, best.pos) <= 1) predHP[o.id] -= splashVs(o.type);
      }
    }

    // PHASE 3: coordinated focus-fire — secure kills, minimal overkill.
    const idle = new Set();
    for (const u of my) if (!acted.has(u.id) && u.type !== "mage") idle.add(u.id);

    const enemyOrder = [...en].sort((a,b)=>
      (THREAT[b.type]-THREAT[a.type]) || (predHP[a.id]-predHP[b.id]));
    for (const e of enemyOrder) {
      if (predHP[e.id] <= 0) continue;
      const cands = [...idle].map(id=>byId[id]).filter(u => canHit(u, e));
      if (!cands.length) continue;
      const total = cands.reduce((s,u)=> s + dmgVs(u.type, e.type), 0);
      if (total < predHP[e.id]) continue;
      cands.sort((a,b)=> dmgVs(b.type,e.type) - dmgVs(a.type,e.type));
      let need = predHP[e.id];
      for (const u of cands) {
        if (need <= 0) break;
        actions.push({unitId:u.id, action:"attack", targetUnitId:e.id});
        acted.add(u.id); idle.delete(u.id);
        need -= dmgVs(u.type, e.type);
      }
      predHP[e.id] = need;
    }
    for (const id of [...idle]) {
      const u = byId[id];
      const inR = en.filter(e => canHit(u, e));
      if (!inR.length) continue;
      inR.sort((a,b)=> (THREAT[b.type]-THREAT[a.type]) || (predHP[a.id]-predHP[b.id]));
      const t = inR[0];
      actions.push({unitId:u.id, action:"attack", targetUnitId:t.id});
      acted.add(u.id); idle.delete(u.id);
      predHP[t.id] -= dmgVs(u.type, t.type);
    }

    // JUNGLE: idle units (no enemy to shoot) farm monster bounties (+10 each) to
    // out-economy the foe. Monsters are passive until DAMAGED, so we only commit
    // when reachable idle units can KILL one THIS turn (it dies before the end-of-
    // round maul → zero risk). Concentrate minimal damage; splash finishes extras.
    if (JUNGLE && neu.length) {
      const monHP = {}; for (const m of neu) monHP[m.id] = m.hp;
      for (;;) {
        let best = null, bestHP = Infinity, bestCands = null;
        for (const m of neu) {
          if (monHP[m.id] <= 0) continue;
          const cands = [...idle].map(id=>byId[id]).filter(u =>
            mhd(u.pos, m.pos) <= RANGE[u.type] && hasLOS(u, m.pos[0], m.pos[1]));
          if (!cands.length) continue;
          if (cands.reduce((s,u)=> s + ATK[u.type], 0) < monHP[m.id]) continue; // can't one-shot
          if (monHP[m.id] < bestHP) { bestHP = monHP[m.id]; best = m; bestCands = cands; }
        }
        if (!best) break;
        bestCands.sort((a,b)=> ATK[b.type]-ATK[a.type]); // fewest units to finish
        let need = monHP[best.id];
        for (const u of bestCands) {
          if (need <= 0) break;
          actions.push({unitId:u.id, action:"attack", targetUnitId:best.id});
          acted.add(u.id); idle.delete(u.id);
          need -= ATK[u.type];
        }
        monHP[best.id] = 0;
      }
      // CHIP fallback: if we can't one-shot, still grind the lowest-hp reachable
      // monster with all idle units (accept the maul) so we actually collect
      // bounties over a few turns instead of never jungling at all.
      if (JUNGLE_CHIP) {
        let best = null, bestHP = Infinity;
        for (const m of neu) {
          if (monHP[m.id] <= 0) continue;
          const reach = [...idle].map(id=>byId[id]).some(u => mhd(u.pos,m.pos) <= RANGE[u.type] && hasLOS(u, m.pos[0], m.pos[1]));
          if (reach && monHP[m.id] < bestHP) { bestHP = monHP[m.id]; best = m; }
        }
        if (best) {
          for (const id of [...idle]) {
            const u = byId[id];
            if (mhd(u.pos,best.pos) <= RANGE[u.type] && hasLOS(u, best.pos[0], best.pos[1])) {
              actions.push({unitId:u.id, action:"attack", targetUnitId:best.id});
              acted.add(u.id); idle.delete(u.id);
            }
          }
        }
      }
    }

    // PHASE 4: movement — lane-seeking for ranged, advance for melee, cohesion-capped.
    let mcx = 0, ecx = 0;
    for (const u of my) mcx += u.pos[0];
    for (const e of en) ecx += e.pos[0];
    mcx /= my.length; ecx /= en.length;
    const dir = Math.sign(ecx - mcx) || 1;
    const frontX = (()=>{ const xs = my.map(u=>u.pos[0]).sort((a,b)=>a-b); return xs[Math.floor(xs.length/2)]; })();

    const allyAdj = (c, selfId)=> { let n=0; for (const u of my){ if(u.id===selfId) continue; if(cheb(c,u.pos)<=1) n++; } return n; };
    // Fragile-unit fear of monsters: a mauling monster (move 2 + range 1 = reaches
    // 3 cells/round) shreds a 35-hp mage. Penalize standing within reach of one so
    // mages route around / retreat from the jungle instead of dying in it.
    const monFear = (u, c) => {
      if (!MONFEAR || !neu.length) return 0;
      let nm = Infinity;
      for (const m of neu) { const d = mhd(c, m.pos); if (d < nm) nm = d; }
      return nm <= 3 ? (4 - nm) * MONFEAR : 0;
    };
    function cellScore(u, c, r, selfKey) {
      let nd = Infinity, shots = 0;
      for (const e of en) {
        const d = mhd(c, e.pos);
        if (d < nd) nd = d;
        if (d <= r && (r <= 1 || losClear(c[0], c[1], e.pos[0], e.pos[1], blockers, selfKey))) shots++;
      }
      const spread = allyAdj(c, u.id);
      const ranged = r > 1;
      const fear = ranged ? monFear(u, c) : 0;  // only squishy ranged fear monsters
      if (ranged) {
        if (shots > 0) return 1e6 + shots*2000 + (EDGE ? nd*40 : -nd*40) - spread*SPREAD*30 - fear;
        if (!ADVANCE) return -nd*100 - fear;
        return 5e4 - nd*100 - spread*ASPREAD - fear;
      }
      return 5e4 - nd*100 - spread*(ASPREAD/2);
    }
    function bestCell(u) {
      const mv = MOVE[u.type], r = RANGE[u.type], selfKey = key(u.pos);
      let best = u.pos, bestScore = cellScore(u, u.pos, r, selfKey);
      for (let dx=-mv; dx<=mv; dx++) for (let dy=-mv; dy<=mv; dy++) {
        const d = Math.abs(dx)+Math.abs(dy); if (d===0 || d>mv) continue;
        const nx = u.pos[0]+dx, ny = u.pos[1]+dy;
        if (nx<0||nx>=W||ny<0||ny>=H) continue;
        if (occ.has(nx+","+ny)) continue;
        if (COHESION && dir*(nx - frontX) > LEAD) continue; // don't outrun the block
        const s = cellScore(u, [nx,ny], r, selfKey);
        if (s > bestScore) { bestScore = s; best = [nx,ny]; }
      }
      return best;
    }
    // Move toward the nearest live monster to mass up for a one-shot. Monsters are
    // passive until damaged, so closing in (even adjacent) is safe.
    const nearestMon = (c) => { let bm=null,bd=Infinity; for (const m of neu){ const d=mhd(c,m.pos); if(d<bd){bd=d;bm=m;} } return bm; };
    function jungleCell(u) {
      const mv = MOVE[u.type], r = RANGE[u.type], selfKey = key(u.pos);
      const m = nearestMon(u.pos); if (!m) return u.pos;
      // already in range+LOS → hold (the JUNGLE phase will fire when massed enough)
      let best = u.pos, bestD = mhd(u.pos, m.pos) <= r && hasLOS(u, m.pos[0], m.pos[1]) ? -1 : mhd(u.pos, m.pos);
      for (let dx=-mv; dx<=mv; dx++) for (let dy=-mv; dy<=mv; dy++) {
        const d = Math.abs(dx)+Math.abs(dy); if (d===0 || d>mv) continue;
        const nx = u.pos[0]+dx, ny = u.pos[1]+dy;
        if (nx<0||nx>=W||ny<0||ny>=H || occ.has(nx+","+ny)) continue;
        const inR = mhd([nx,ny], m.pos) <= r && hasLOS(u, m.pos[0], m.pos[1]); // approx LOS from current
        const score = inR ? -1 : mhd([nx,ny], m.pos);
        if (score < bestD) { bestD = score; best = [nx,ny]; }
      }
      return best;
    }

    // Max enemy attack range (for exposure check). Enemy ranged units kite, so a
    // unit sitting within their range eats fire; if it cannot itself shoot, it is
    // better off DEFENDING (free, halves incoming) than crawling forward into more.
    let enMaxR = 1;
    for (const e of en) enMaxR = Math.max(enMaxR, RANGE[e.type] || 1);
    const exposed = (c) => { for (const e of en) if (predHP[e.id] > 0 && mhd(c, e.pos) <= (RANGE[e.type]||1)) return true; return false; };
    const canShootFrom = (u, c) => {
      const r = RANGE[u.type], selfKey = key(u.pos);
      for (const e of en) { if (predHP[e.id] <= 0) continue; if (mhd(c, e.pos) <= r && (r <= 1 || losClear(c[0], c[1], e.pos[0], e.pos[1], blockers, selfKey))) return true; }
      return false;
    };

    // Move units closest to a shot first; the rest defend. Skip already-acted.
    const movers = [...my].filter(u=>!acted.has(u.id));
    movers.sort((a,b)=> {
      const na = Math.min(...en.map(e=>mhd(a.pos,e.pos)));
      const nb = Math.min(...en.map(e=>mhd(b.pos,e.pos)));
      return na - nb;
    });
    let ap = ctx.myAP;
    for (const u of movers) {
      if (ap < 1) break;
      // JUNGLE redirect: if this unit can't reach the enemy fight soon (enemy far)
      // and a monster is closer, go farm it instead of crawling at the enemy.
      let dest;
      const nearEnemy = en.length ? Math.min(...en.map(e=>mhd(u.pos,e.pos))) : Infinity;
      if (JUNGLE_MOVE && neu.length && nearEnemy > RANGE[u.type] + MOVE[u.type] + 3) {
        const m = nearestMon(u.pos);
        if (m && mhd(u.pos, m.pos) < nearEnemy) dest = jungleCell(u);
      }
      if (!dest) dest = bestCell(u);
      const moved = dest[0] !== u.pos[0] || dest[1] !== u.pos[1];
      // EXPOSED-DEFEND: a ranged unit that can't shoot from its destination AND is
      // already exposed to enemy fire should DEFEND (halve incoming) UNLESS the move
      // makes real forward progress toward a shot (closes distance to the nearest
      // enemy). This cuts attrition during the slow MOVE-1 mage crawl into a kiting
      // wall without freezing the advance.
      if (EXPDEF && RANGE[u.type] > 1 && exposed(u.pos) && !canShootFrom(u, dest)) {
        actions.push({unitId:u.id, action:"defend"}); acted.add(u.id);
        continue;
      }
      if (moved) {
        occ.delete(key(u.pos)); occ.add(key(dest));
        actions.push({unitId:u.id, action:"move", target:dest});
        acted.add(u.id); ap--;
      }
    }

    // PHASE 5: everything still idle DEFENDS (free, halves incoming).
    for (const u of my) if (!acted.has(u.id)) actions.push({unitId:u.id, action:"defend"});

    return actions;
  };
}

// Winner: a cohesive MAGE swarm (splash ignores LOS) fronted by a small KNIGHT
// vanguard. Knights (MOVE 3, ~200 effective HP) lead the cohesive block and screen
// enemy archer LOS; mages advance behind under EXPOSED-DEFEND (a mage that can't fire
// and is in enemy range halves incoming instead of crawling into more fire). This
// turns the slow MOVE-1 mage approach — the old weakness vs kiting archer walls
// (green/blue) — into a survivable, splash-heavy roll forward.
export const decideTurn = makeDecide({
  TARGET: { mage:16, knight:6 }, FILL: "mage", COHESION:true, LEAD:5, EXPDEF:true,
  JUNGLE:true, JUNGLE_MOVE:true, JUNGLE_CHIP:true,  // real jungling: idle/far units grind monsters for bounty economy
  MONPEN:100,
});