// hermes: threat-priority tactical bot. Archer-heavy DPS with spear screen.
// Collision-aware movement, focus-fire low-HP, compact for 16x12 board.

const COST  = { knight:5, spear:3, archer:3, mage:4, priest:4 };
const RANGE = { knight:1, spear:2, archer:4, mage:3, priest:2 };
const MOVE  = { knight:2, spear:3, archer:2, mage:1, priest:1 };
const PRIORITY  = { priest:1, mage:2, archer:3, spear:4, knight:5 };

function dist(a, b) { return Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]); }

function stepToward(from, to, max) {
  let left = max;
  const dxM = Math.min(Math.abs(to[0]-from[0]), left);
  const dx = Math.sign(to[0]-from[0]) * dxM; left -= dxM;
  const dyM = Math.min(Math.abs(to[1]-from[1]), left);
  const dy = Math.sign(to[1]-from[1]) * dyM;
  return [from[0]+dx, from[1]+dy];
}

export function decideTurn(ctx) {
  if (!ctx.enemyUnits.length) {
    const actions = []; let m = ctx.myMoney || 0;
    while (m >= COST.spear) { actions.push({ action:"buy", unitType:"spear" }); m -= COST.spear; }
    while (m >= COST.archer) { actions.push({ action:"buy", unitType:"archer" }); m -= COST.archer; }
    return actions;
  }

  const actions = [];
  let money = ctx.myMoney || 0;

  const c = {};
  for (const u of ctx.myUnits) c[u.type] = (c[u.type]||0) + 1;
  const totalArcher = (c.archer||0) + actions.filter(a=>a.action==="buy"&&a.unitType==="archer").length;
  const totalSpear = (c.spear||0) + actions.filter(a=>a.action==="buy"&&a.unitType==="spear").length;

  // One priest + one mage for utility
  if (!c.priest && money >= COST.priest) { actions.push({ action:"buy", unitType:"priest" }); money -= COST.priest; }
  if (!c.mage && money >= COST.mage) { actions.push({ action:"buy", unitType:"mage" }); money -= COST.mage; }

  // Archer-heavy DPS with ~25% spear screen
  while (money >= COST.archer) {
    if (totalSpear * 3 < totalArcher + 2 && money >= COST.spear) {
      actions.push({ action:"buy", unitType:"spear" }); money -= COST.spear;
    } else {
      actions.push({ action:"buy", unitType:"archer" }); money -= COST.archer;
    }
  }

  // Occupancy for collision-aware movement
  const occupied = new Set();
  for (const u of ctx.myUnits) occupied.add(u.pos.join(","));
  for (const e of ctx.enemyUnits) occupied.add(e.pos.join(","));
  const futureOcc = new Set(occupied);

  // Melee first so they claim positions before ranged
  const sorted = [...ctx.myUnits].sort((a,b) => {
    const order = { knight:0, spear:1, priest:2, archer:3, mage:4 };
    return (order[a.type]||0) - (order[b.type]||0);
  });

  const byPrio = [...ctx.enemyUnits].sort((a,b) => PRIORITY[a.type]-PRIORITY[b.type]);
  let ap = ctx.myAP;

  // Mage fireball on 3+ clusters (free, no AP)
  for (const u of sorted) {
    if (u.type !== "mage" || (u.cooldowns.fireball||0) > 0) continue;
    let best = null, bestN = 0;
    for (const e of ctx.enemyUnits) {
      const n = ctx.enemyUnits.filter(o => Math.max(Math.abs(o.pos[0]-e.pos[0]), Math.abs(o.pos[1]-e.pos[1])) <= 1).length;
      if (n > bestN) { bestN = n; best = e.pos; }
    }
    if (bestN >= 3 && best && dist(u.pos, best) <= RANGE.mage) {
      actions.push({ unitId:u.id, action:"skill", skill:"fireball", target:best });
    }
  }

  // Priest heal (free, no AP)
  for (const u of sorted) {
    if (u.type !== "priest" || (u.cooldowns.heal||0) > 0) continue;
    const w = ctx.myUnits
      .filter(a => a.id !== u.id && a.hp < a.maxHp * 0.5)
      .sort((a,b) => a.hp - b.hp);
    const t = w.find(a => dist(u.pos, a.pos) <= RANGE.priest);
    if (t) { actions.push({ unitId:u.id, action:"skill", skill:"heal", target:t.id }); }
  }

  // Operate: attack (free), collision-aware move
  for (const u of sorted) {
    const inRange = ctx.enemyUnits.filter(e => dist(u.pos, e.pos) <= RANGE[u.type]);
    if (inRange.length > 0) {
      inRange.sort((a,b) => { const p = PRIORITY[a.type]-PRIORITY[b.type]; return p !== 0 ? p : a.hp-b.hp; });
      actions.push({ unitId:u.id, action:"attack", targetUnitId:inRange[0].id });
      continue;
    }

    if (ap < 1) continue;
    const nearest = byPrio[0];
    if (!nearest) continue;

    const mv = MOVE[u.type];
    let bestMove = null, bestDist = dist(u.pos, nearest.pos);
    for (let dx = -mv; dx <= mv; dx++) {
      for (let dy = -mv; dy <= mv; dy++) {
        const d = Math.abs(dx) + Math.abs(dy);
        if (d === 0 || d > mv) continue;
        const nx = u.pos[0]+dx, ny = u.pos[1]+dy;
        if (nx < 0 || nx > 15 || ny < 0 || ny > 11) continue;
        if (futureOcc.has(nx+","+ny)) continue;
        const nd = dist([nx,ny], nearest.pos);
        if (nd < bestDist) { bestDist = nd; bestMove = [nx,ny]; }
      }
    }
    if (bestMove) {
      actions.push({ unitId:u.id, action:"move", target:bestMove });
      ap--;
      futureOcc.add(bestMove.join(","));
    }
  }

  return actions;
}
