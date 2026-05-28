// red-charger: aggressive rush bot. Closes distance fast, focuses fire on wounded enemies.
// Knows when to defend rather than suicide-charge into superior numbers.

const RANGE = { knight: 1, spear: 2, archer: 4, mage: 3, priest: 2 };
const MOVE = { knight: 2, spear: 3, archer: 2, mage: 1, priest: 1 };
const COST = { knight: 5, spear: 3, archer: 3, mage: 4, priest: 4 };

function manhattan(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
}

function stepToward(from, to, maxSteps) {
  const dx0 = to[0] - from[0];
  const dy0 = to[1] - from[1];
  let left = maxSteps;
  const dxMag = Math.min(Math.abs(dx0), left);
  const dx = Math.sign(dx0) * dxMag;
  left -= dxMag;
  const dyMag = Math.min(Math.abs(dy0), left);
  const dy = Math.sign(dy0) * dyMag;
  return [from[0] + dx, from[1] + dy];
}

function densestCell(enemies, radius) {
  let best = null;
  let bestCount = 0;
  for (const e of enemies) {
    let count = 0;
    for (const other of enemies) {
      const d = Math.max(Math.abs(other.pos[0] - e.pos[0]), Math.abs(other.pos[1] - e.pos[1]));
      if (d <= radius) count++;
    }
    if (count > bestCount) { bestCount = count; best = e.pos; }
  }
  return { pos: best, count: bestCount };
}

function countNearby(allies, unit, dist) {
  return allies.filter(a => a.id !== unit.id && manhattan(a.pos, unit.pos) <= dist).length;
}

export function decideTurn(ctx) {
  const actions = [];
  let ap = ctx.myAP;
  if (ctx.enemyUnits.length === 0) return actions;

  // Sort enemies: lowest HP first for focus fire
  const woundedFirst = [...ctx.enemyUnits].sort((a, b) => a.hp - b.hp);

  // Find average enemy position for formation reference
  const avgEnemyX = ctx.enemyUnits.reduce((s, e) => s + e.pos[0], 0) / ctx.enemyUnits.length;

  for (const u of ctx.myUnits) {
    if (ap < 1) break;
    const range = RANGE[u.type];
    const moveRange = MOVE[u.type];

    // Mage: fireball on cluster of 2+ enemies
    if (u.type === "mage" && ap >= 3 && (u.cooldowns.fireball || 0) === 0) {
      const cluster = densestCell(ctx.enemyUnits, 1);
      if (cluster.count >= 2 && cluster.pos && manhattan(u.pos, cluster.pos) <= RANGE.mage) {
        actions.push({ unitId: u.id, action: "skill", skill: "fireball", target: cluster.pos });
        ap -= 3;
        continue;
      }
    }

    // Priest: heal lowest-HP wounded ally
    if (u.type === "priest" && ap >= 2 && (u.cooldowns.heal || 0) === 0) {
      const wounded = ctx.myUnits
        .filter(a => a.id !== u.id && a.hp < a.maxHp * 0.6)
        .sort((a, b) => a.hp - b.hp);
      const reachable = wounded.find(a => manhattan(u.pos, a.pos) <= RANGE.priest);
      if (reachable) {
        actions.push({ unitId: u.id, action: "skill", skill: "heal", target: reachable.id });
        ap -= 2;
        continue;
      }
    }

    // Attack: focus fire on lowest-HP enemy in range (secure kills)
    const target = woundedFirst.find(e => manhattan(u.pos, e.pos) <= range);
    if (target) {
      actions.push({ unitId: u.id, action: "attack", targetUnitId: target.id });
      ap -= 1;
      continue;
    }

    // Movement: aggressive but don't outrun support
    const goal = woundedFirst[0];
    if (!goal) continue;

    const distToGoal = manhattan(u.pos, goal.pos);

    // Melee (knight/spear): rush forward, but defend if isolated ahead
    if (u.type === "knight" || u.type === "spear") {
      const alliesNearby = countNearby(ctx.myUnits, u, 3);
      const enemiesNearby = ctx.enemyUnits.filter(e => manhattan(u.pos, e.pos) <= range + 2).length;

      // If we'd be outnumbered after moving, defend and wait for support
      if (distToGoal > range && alliesNearby === 0 && enemiesNearby >= 2) {
        actions.push({ unitId: u.id, action: "defend" });
        continue;
      }

      // Move just enough to engage next turn
      const steps = Math.min(moveRange, Math.max(1, distToGoal - range + 1));
      const dest = stepToward(u.pos, goal.pos, steps);
      if (dest[0] !== u.pos[0] || dest[1] !== u.pos[1]) {
        actions.push({ unitId: u.id, action: "move", target: dest });
        ap -= 1;
        continue;
      }
    }

    // Ranged (archer/mage): advance but stay behind melee line
    const advanceLimit = avgEnemyX - 3; // don't cross into enemy territory
    const steps = Math.min(moveRange, Math.max(1, distToGoal - range + 1));
    const dest = stepToward(u.pos, goal.pos, steps);
    if ((dest[0] !== u.pos[0] || dest[1] !== u.pos[1]) && dest[0] <= advanceLimit + 1) {
      actions.push({ unitId: u.id, action: "move", target: dest });
      ap -= 1;
      continue;
    }

    // Nothing useful to do — defend
    actions.push({ unitId: u.id, action: "defend" });
  }

  // Red charger buys: aggressive, but balance front line
  const money = ctx.myMoney || 0;
  const melee = ctx.myUnits.filter(u => u.type === "knight" || u.type === "spear").length;
  const ranged = ctx.myUnits.filter(u => u.type === "archer" || u.type === "mage").length;
  const hasPriest = ctx.myUnits.some(u => u.type === "priest");

  let buyOrder;
  if (!hasPriest) {
    buyOrder = ["priest", "mage", "knight", "archer", "spear"];
  } else if (melee <= ranged / 2) {
    buyOrder = ["knight", "spear", "mage", "archer", "priest"];
  } else {
    buyOrder = ["mage", "knight", "archer", "spear", "priest"];
  }

  let moneyLeft = money;
  for (const t of buyOrder) {
    while (moneyLeft >= COST[t]) {
      actions.push({ action: "buy", unitType: t });
      moneyLeft -= COST[t];
    }
  }

  return actions;
}
