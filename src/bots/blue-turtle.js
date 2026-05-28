// blue-turtle: defensive formation. Knights tank the front, spears+archers
// form a kill zone behind them, priests heal, mages AOE.

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

function stepAway(from, threat, max) {
  const dx0 = from[0] - threat[0];
  const dy0 = from[1] - threat[1];
  if (dx0 === 0 && dy0 === 0) return from;
  let left = max;
  const dxM = Math.min(Math.abs(dx0), left);
  const dx = Math.sign(dx0) * dxM; left -= dxM;
  const dyM = Math.min(Math.abs(dy0), left);
  const dy = Math.sign(dy0) * dyM;
  return [from[0]+dx, from[1]+dy];
}

export function decideTurn(ctx) {
  const actions = [];

  // ── Buy: balanced composition, knights + spears frontline, ranged back ──
  let money = ctx.myMoney || 0;
  const counts = {};
  for (const u of ctx.myUnits) counts[u.type] = (counts[u.type]||0) + 1;
  const melee = (counts.knight||0) + (counts.spear||0);
  const ranged = (counts.archer||0) + (counts.mage||0);

  // Ensure at least 1 priest, then balance melee/ranged
  if (!counts.priest && money >= COST.priest) {
    actions.push({ action:"buy", unitType:"priest" }); money -= COST.priest;
  }
  // Keep ~1:1 melee:ranged ratio
  while (money >= COST.spear) {
    if (melee + actions.filter(a=>a.action==="buy"&&(a.unitType==="knight"||a.unitType==="spear")).length
        <= ranged + actions.filter(a=>a.action==="buy"&&(a.unitType==="archer"||a.unitType==="mage")).length) {
      if (money >= COST.knight) { actions.push({ action:"buy", unitType:"knight" }); money -= COST.knight; }
      else if (money >= COST.spear) { actions.push({ action:"buy", unitType:"spear" }); money -= COST.spear; }
      else break;
    } else {
      if (money >= COST.mage) { actions.push({ action:"buy", unitType:"mage" }); money -= COST.mage; }
      else { actions.push({ action:"buy", unitType:"archer" }); money -= COST.archer; }
    }
  }

  if (!ctx.enemyUnits.length) return actions;

  // Find average enemy X to define "our line"
  const avgEnemyX = ctx.enemyUnits.reduce((s,e) => s + e.pos[0], 0) / ctx.enemyUnits.length;
  const frontX = ctx.myUnits
    .filter(u => u.type === "knight" || u.type === "spear")
    .reduce((s,u) => s + u.pos[0], 0) / (melee || 1);

  // Enemies sorted by proximity to our units
  const threats = [...ctx.enemyUnits].sort((a,b) => {
    const da = Math.min(...ctx.myUnits.map(u => dist(u.pos, a.pos)));
    const db = Math.min(...ctx.myUnits.map(u => dist(u.pos, b.pos)));
    return da - db;
  });
  const woundedFirst = [...ctx.enemyUnits].sort((a,b) => a.hp - b.hp);

  let ap = ctx.myAP;

  // Priests heal most wounded
  for (const u of ctx.myUnits) {
    if (u.type !== "priest" || ap < 1) continue;
    if ((u.cooldowns.heal||0) > 0) continue;
    const w = ctx.myUnits
      .filter(a => a.id !== u.id && a.hp < a.maxHp * 0.5)
      .sort((a,b) => a.hp/a.maxHp - b.hp/b.maxHp);
    const t = w.find(a => dist(u.pos, a.pos) <= RANGE.priest);
    if (t) { actions.push({ unitId:u.id, action:"skill", skill:"heal", target:t.id }); continue; }
  }

  // Mages fireball clusters of 3+
  for (const u of ctx.myUnits) {
    if (u.type !== "mage" || ap < 1) continue;
    if ((u.cooldowns.fireball||0) > 0) continue;
    for (const e of threats) {
      const n = ctx.enemyUnits.filter(o =>
        Math.max(Math.abs(o.pos[0]-e.pos[0]), Math.abs(o.pos[1]-e.pos[1])) <= 1
      ).length;
      if (n >= 3 && dist(u.pos, e.pos) <= RANGE.mage) {
        actions.push({ unitId:u.id, action:"skill", skill:"fireball", target:e.pos });
        break;
      }
    }
  }

  // Operate units: attack if possible, otherwise move with formation awareness
  for (const u of ctx.myUnits) {
    const hit = woundedFirst.find(e => dist(u.pos, e.pos) <= RANGE[u.type]);
    if (hit) { actions.push({ unitId:u.id, action:"attack", targetUnitId:hit.id }); continue; }
    if (ap < 1) continue;

    const goal = threats[0];
    if (!goal) continue;

    if (u.type === "knight" || u.type === "spear") {
      // Frontline: advance toward nearest threat
      const dest = stepToward(u.pos, goal.pos, MOVE[u.type]);
      if (dest[0] !== u.pos[0] || dest[1] !== u.pos[1]) {
        actions.push({ unitId:u.id, action:"move", target:dest });
        ap--;
        continue;
      }
    } else {
      // Ranged: stay behind front line, retreat if enemy is close
      const nearestEnemy = threats[0];
      const enemyDist = dist(u.pos, nearestEnemy.pos);
      if (enemyDist <= 1) {
        const away = stepAway(u.pos, nearestEnemy.pos, MOVE[u.type]);
        if (away[0] !== u.pos[0] || away[1] !== u.pos[1]) {
          actions.push({ unitId:u.id, action:"move", target:away });
          ap--;
          continue;
        }
      }
      // Advance slowly toward engagement range
      if (enemyDist > RANGE[u.type] + 1) {
        const dest = stepToward(u.pos, goal.pos, Math.min(MOVE[u.type], enemyDist - RANGE[u.type]));
        if (dest[0] !== u.pos[0] || dest[1] !== u.pos[1] && dest[0] <= frontX + 2) {
          actions.push({ unitId:u.id, action:"move", target:dest });
          ap--;
        }
      }
    }
  }

  return actions;
}
