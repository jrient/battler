// red-charger: spear-heavy rush (cheap, move 3). Buys 1 mage + 1 priest
// then floods spears, archers and cheap engineers. Attacks free; moves
// spear frontline forward. Mage splash and priest heal are passives.

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

export function decideTurn(ctx) {
  const actions = [];
  let money = ctx.myMoney || 0;

  // Count current composition
  const c = {};
  for (const u of ctx.myUnits) c[u.type] = (c[u.type]||0) + 1;

  // One mage (splash), one priest (heal), then spear+archer flood, engineers fill scraps
  if (!c.mage && money >= COST.mage) { actions.push({ action:"buy", unitType:"mage" }); money -= COST.mage; }
  if (!c.priest && money >= COST.priest) { actions.push({ action:"buy", unitType:"priest" }); money -= COST.priest; }
  while (money >= COST.spear) { actions.push({ action:"buy", unitType:"spear" }); money -= COST.spear; }
  while (money >= COST.archer) { actions.push({ action:"buy", unitType:"archer" }); money -= COST.archer; }
  while (money >= COST.engineer) { actions.push({ action:"buy", unitType:"engineer" }); money -= COST.engineer; }

  if (!ctx.enemyUnits.length) return actions;

  const targets = [...ctx.enemyUnits].sort((a,b) => a.hp - b.hp);
  let ap = ctx.myAP;

  // Priest heals the most wounded ally by attacking it (heal is a passive)
  const healed = new Set();
  for (const u of ctx.myUnits) {
    if (u.type !== "priest") continue;
    const w = ctx.myUnits
      .filter(a => a.id !== u.id && a.hp < a.maxHp * 0.5)
      .sort((a,b) => a.hp - b.hp);
    const t = w.find(a => dist(u.pos, a.pos) <= RANGE.priest);
    if (t) { actions.push({ unitId:u.id, action:"attack", targetUnitId:t.id }); healed.add(u.id); }
  }

  // Attack with all units (free), move melee forward with AP. Mage splash hits
  // clustered enemies automatically — just target the nearest/weakest.
  for (const u of ctx.myUnits) {
    if (healed.has(u.id)) continue;
    const hit = targets.find(e => dist(u.pos, e.pos) <= RANGE[u.type]);
    if (hit) { actions.push({ unitId:u.id, action:"attack", targetUnitId:hit.id }); continue; }
    // Ranged don't need to move unless AP is spare and enemy is far
    if (u.type === "archer" || u.type === "mage" || u.type === "priest") continue;
    // Melee: move toward nearest enemy
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
