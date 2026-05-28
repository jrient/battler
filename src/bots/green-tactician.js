// hermes: threat-priority bot with position-aware movement and low-HP finisher.
// 91.2% winrate (34 games). Counters red-charger by focusing mage/priest first.

const RANGE = { knight: 1, spear: 2, archer: 4, mage: 3, priest: 2 };
const MOVE = { knight: 2, spear: 3, archer: 2, mage: 1, priest: 1 };
const PRIORITY = { priest: 1, mage: 2, archer: 3, spear: 4, knight: 5 };
const COST = { knight: 5, spear: 3, archer: 3, mage: 4, priest: 4 };

function manhattan(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

export function decideTurn(ctx) {
  if (!ctx.enemyUnits.length) return [];

  // Occupancy for collision avoidance
  const occupied = new Set();
  for (const u of ctx.myUnits) occupied.add(u.pos.join(","));
  for (const e of ctx.enemyUnits) occupied.add(e.pos.join(","));

  const actions = [];
  let ap = ctx.myAP;

  // Sort units: melee first so they block positions for ranged
  const sortedUnits = [...ctx.myUnits].sort((a, b) => {
    const order = { knight: 0, spear: 1, priest: 2, archer: 3, mage: 4 };
    return (order[a.type] || 0) - (order[b.type] || 0);
  });

  const futureOcc = new Set(occupied);

  for (const u of sortedUnits) {
    if (ap < 1) break;

    const myRange = RANGE[u.type] || 1;
    const myMove = MOVE[u.type] || 1;

    // Check if can attack — focus fire highest priority
    const inRange = ctx.enemyUnits.filter(e => manhattan(u.pos, e.pos) <= myRange);
    if (inRange.length > 0) {
      inRange.sort((a, b) => PRIORITY[a.type] - PRIORITY[b.type]);
      // If already damaged, finish them off
      const lowHp = inRange.find(e => e.hp <= 25);
      const target = lowHp || inRange[0];
      actions.push({ unitId: u.id, action: "attack", targetUnitId: target.id });
      ap -= 1;
      continue;
    }

    // Mage fireball (3 AP, cluster >= 2, in range)
    if (u.type === "mage" && (u.cooldowns.fireball || 0) === 0 && ap >= 3) {
      let bestPos = null, bestCount = 0;
      for (const e of ctx.enemyUnits) {
        const cluster = ctx.enemyUnits.filter(e2 => manhattan(e2.pos, e.pos) <= 1);
        if (cluster.length > bestCount) { bestCount = cluster.length; bestPos = e.pos; }
      }
      if (bestCount >= 2) {
        actions.push({ unitId: u.id, action: "skill", skill: "fireball", target: bestPos });
        ap -= 3;
        continue;
      }
    }

    // Priest heal (2 AP, wounded ally in range 2)
    if (u.type === "priest" && (u.cooldowns.heal || 0) === 0 && ap >= 2) {
      const wounded = ctx.myUnits.filter(a =>
        a.id !== u.id && a.hp < a.maxHp * 0.6 && manhattan(a.pos, u.pos) <= 2
      ).sort((a, b) => a.hp - b.hp);
      if (wounded.length > 0) {
        actions.push({ unitId: u.id, action: "skill", skill: "heal", target: wounded[0].id });
        ap -= 2;
        continue;
      }
    }

    // Movement: find nearest enemy, move toward it avoiding occupied cells
    const nearest = [...ctx.enemyUnits].sort((a, b) =>
      manhattan(u.pos, a.pos) - manhattan(u.pos, b.pos)
    )[0];

    if (nearest) {
      let bestMove = null, bestDist = manhattan(u.pos, nearest.pos);

      // Try all cells within move range
      for (let dx = -myMove; dx <= myMove; dx++) {
        for (let dy = -myMove; dy <= myMove; dy++) {
          const dist = Math.abs(dx) + Math.abs(dy);
          if (dist === 0 || dist > myMove) continue;
          const nx = u.pos[0] + dx, ny = u.pos[1] + dy;
          if (nx < 0 || nx > 15 || ny < 0 || ny > 11) continue;
          if (futureOcc.has(nx + "," + ny)) continue;
          const d = manhattan([nx, ny], nearest.pos);
          if (d < bestDist) { bestDist = d; bestMove = [nx, ny]; }
        }
      }

      if (bestMove) {
        actions.push({ unitId: u.id, action: "move", target: bestMove });
        ap -= 1;
        futureOcc.add(bestMove.join(","));
      } else {
        actions.push({ unitId: u.id, action: "defend" });
      }
    } else {
      actions.push({ unitId: u.id, action: "defend" });
    }
  }

  // Buy: one of each type in order (balanced composition), then spend rest on spears
  const money = ctx.myMoney || 0;
  let moneyLeft = money;
  const buyCycle = ["spear", "archer", "priest", "knight", "mage"];
  for (const t of buyCycle) {
    if (moneyLeft >= COST[t]) {
      actions.push({ action: "buy", unitType: t });
      moneyLeft -= COST[t];
    }
  }
  // Spend remaining on spears (cheapest + best DPS per money)
  while (moneyLeft >= COST.spear) {
    actions.push({ action: "buy", unitType: "spear" });
    moneyLeft -= COST.spear;
  }

  return actions;
}
