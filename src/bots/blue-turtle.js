// blue-turtle: defensive formation. Knights+spears hold line, archers DPS from
// behind, mages splash, priests heal. Compact formation for 16x12 board.

const COST  = { knight:5, spear:3, archer:3, mage:4, priest:4, engineer:2 };
const RANGE = { knight:1, spear:2, archer:4, mage:3, priest:2, engineer:1 };
const MOVE  = { knight:2, spear:3, archer:2, mage:1, priest:1, engineer:2 };

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
  let money = ctx.myMoney || 0;

  const c = {};
  for (const u of ctx.myUnits) c[u.type] = (c[u.type]||0) + 1;
  const melee = (c.knight||0) + (c.spear||0);
  const ranged = (c.archer||0) + (c.mage||0);

  // One priest + one mage first, then balanced melee/ranged
  if (!c.priest && money >= COST.priest) { actions.push({ action:"buy", unitType:"priest" }); money -= COST.priest; }
  if (!c.mage && money >= COST.mage) { actions.push({ action:"buy", unitType:"mage" }); money -= COST.mage; }

  while (money >= COST.spear) {
    if (melee + actions.filter(a=>a.action==="buy"&&(a.unitType==="knight"||a.unitType==="spear")).length
        <= ranged + actions.filter(a=>a.action==="buy"&&(a.unitType==="archer"||a.unitType==="mage")).length + 1) {
      if (money >= COST.knight) { actions.push({ action:"buy", unitType:"knight" }); money -= COST.knight; }
      else { actions.push({ action:"buy", unitType:"spear" }); money -= COST.spear; }
    } else {
      if (money >= COST.mage) { actions.push({ action:"buy", unitType:"mage" }); money -= COST.mage; }
      else { actions.push({ action:"buy", unitType:"archer" }); money -= COST.archer; }
    }
  }

  if (!ctx.enemyUnits.length) return actions;

  const threats = [...ctx.enemyUnits].sort((a,b) => {
    const da = Math.min(...ctx.myUnits.map(u => dist(u.pos, a.pos)));
    const db = Math.min(...ctx.myUnits.map(u => dist(u.pos, b.pos)));
    return da - db;
  });
  const wounded = [...ctx.enemyUnits].sort((a,b) => a.hp - b.hp);
  const avgFrontX = melee > 0
    ? ctx.myUnits.filter(u=>u.type==="knight"||u.type==="spear").reduce((s,u)=>s+u.pos[0],0) / melee
    : 3;

  let ap = ctx.myAP;

  // Priest heals the lowest-HP% ally by attacking it (heal is a passive)
  const healed = new Set();
  for (const u of ctx.myUnits) {
    if (u.type !== "priest") continue;
    const w = ctx.myUnits
      .filter(a => a.id !== u.id && a.hp < a.maxHp * 0.5)
      .sort((a,b) => a.hp/a.maxHp - b.hp/b.maxHp);
    const t = w.find(a => dist(u.pos, a.pos) <= RANGE.priest);
    if (t) { actions.push({ unitId:u.id, action:"attack", targetUnitId:t.id }); healed.add(u.id); }
  }

  // Operate: attack (free), move conservatively. Mage splash is automatic.
  for (const u of ctx.myUnits) {
    if (healed.has(u.id)) continue;
    const hit = wounded.find(e => dist(u.pos, e.pos) <= RANGE[u.type]);
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
      }
    } else {
      // Ranged: retreat if enemy adjacent, otherwise hold behind front line
      const nearest = threats[0];
      if (dist(u.pos, nearest.pos) <= 1) {
        const away = stepAway(u.pos, nearest.pos, MOVE[u.type]);
        if (away[0] !== u.pos[0] || away[1] !== u.pos[1]) {
          actions.push({ unitId:u.id, action:"move", target:away });
          ap--;
        }
      }
    }
  }

  return actions;
}
