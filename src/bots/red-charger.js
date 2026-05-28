// red-charger: aggressive rush with spear-heavy frontline (cheap, fast, high DPS).
// Buys a large mobile army and closes distance to engage at full force.

const COST  = { knight:5, spear:3, archer:3, mage:4, priest:4 };
const RANGE = { knight:1, spear:2, archer:4, mage:3, priest:2 };
const MOVE  = { knight:2, spear:3, archer:2, mage:1, priest:1 };

function dist(a, b) { return Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]); }

function stepToward(from, to, max) {
  let left = max;
  const dxM = Math.min(Math.abs(to[0]-from[0]), left);
  const dx = Math.sign(to[0]-from[0]) * dxM; left -= dxM;
  const dyM = Math.min(Math.abs(to[1]-from[1]), left);
  const dy = Math.sign(to[1]-from[1]) * dyM;
  return [from[0]+dx, from[1]+dy];
}

function densestCell(units, radius) {
  let best = null, bestN = 0;
  for (const u of units) {
    let n = 0;
    for (const o of units) {
      if (Math.max(Math.abs(o.pos[0]-u.pos[0]), Math.abs(o.pos[1]-u.pos[1])) <= radius) n++;
    }
    if (n > bestN) { bestN = n; best = u.pos; }
  }
  return { pos: best, count: bestN };
}

export function decideTurn(ctx) {
  const actions = [];

  // ── Buy phase: rush-buy spears then archers ──
  let money = ctx.myMoney || 0;
  // First spear every turn (cheapest melee, move 3)
  while (money >= COST.spear) { actions.push({ action:"buy", unitType:"spear" }); money -= COST.spear; }
  // Remaining goes to archers for ranged support
  while (money >= COST.archer) { actions.push({ action:"buy", unitType:"archer" }); money -= COST.archer; }

  if (!ctx.enemyUnits.length) return actions;

  // Sort enemies: lowest HP first for focus fire
  const targets = [...ctx.enemyUnits].sort((a,b) => a.hp - b.hp);

  // ── Operate units (attacks free, only moves cost AP) ──
  let ap = ctx.myAP;

  // Mages first: fireball dense clusters
  for (const u of ctx.myUnits) {
    if (u.type !== "mage" || ap < 1) continue;
    if ((u.cooldowns.fireball||0) > 0) continue;
    const cluster = densestCell(ctx.enemyUnits, 1);
    if (cluster.count >= 3 && cluster.pos && dist(u.pos, cluster.pos) <= RANGE.mage) {
      actions.push({ unitId:u.id, action:"skill", skill:"fireball", target:cluster.pos });
      continue;
    }
  }

  // Priests: heal most wounded
  for (const u of ctx.myUnits) {
    if (u.type !== "priest" || ap < 1) continue;
    if ((u.cooldowns.heal||0) > 0) continue;
    const wounded = ctx.myUnits
      .filter(a => a.id !== u.id && a.hp < a.maxHp * 0.5)
      .sort((a,b) => a.hp - b.hp);
    const t = wounded.find(a => dist(u.pos, a.pos) <= RANGE.priest);
    if (t) { actions.push({ unitId:u.id, action:"skill", skill:"heal", target:t.id }); continue; }
  }

  // Attack with all units (free), then move leftover AP
  for (const u of ctx.myUnits) {
    const hit = targets.find(e => dist(u.pos, e.pos) <= RANGE[u.type]);
    if (hit) { actions.push({ unitId:u.id, action:"attack", targetUnitId:hit.id }); continue; }
    // Can't attack → move toward nearest enemy
    if (ap < 1) continue;
    const goal = targets[0];
    if (goal) {
      const dest = stepToward(u.pos, goal.pos, MOVE[u.type]);
      if (dest[0] !== u.pos[0] || dest[1] !== u.pos[1]) {
        actions.push({ unitId:u.id, action:"move", target:dest });
        ap--;
      }
    }
  }

  return actions;
}
