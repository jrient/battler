// blue-turtle: defensive formation bot. Holds line with knights, protects ranged backline,
// focus-fires with archers/mages, heals strategically. Defends when under pressure.

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

function stepAway(from, threat, maxSteps) {
  const dx0 = from[0] - threat[0];
  const dy0 = from[1] - threat[1];
  if (dx0 === 0 && dy0 === 0) return from;
  let left = maxSteps;
  const dxMag = Math.min(Math.abs(dx0), left);
  const dx = Math.sign(dx0) * dxMag;
  left -= dxMag;
  const dyMag = Math.min(Math.abs(dy0), left);
  const dy = Math.sign(dy0) * dyMag;
  return [from[0] + dx, from[1] + dy];
}

export function decideTurn(ctx) {
  const actions = [];
  let ap = ctx.myAP;
  if (ctx.enemyUnits.length === 0) return actions;

  const ranged = ctx.myUnits.filter(u => u.type === "archer" || u.type === "mage" || u.type === "priest");
  const frontLine = ctx.myUnits.filter(u => u.type === "knight" || u.type === "spear");

  // Sort enemies: closest threat to our ranged units first
  const threats = [...ctx.enemyUnits].sort((a, b) => {
    const da = ranged.length ? Math.min(...ranged.map(r => manhattan(r.pos, a.pos))) : manhattan(a.pos, [15, 6]);
    const db = ranged.length ? Math.min(...ranged.map(r => manhattan(r.pos, b.pos))) : manhattan(b.pos, [15, 6]);
    return da - db;
  });

  // Wounded enemies for focus fire
  const woundedFirst = [...ctx.enemyUnits].sort((a, b) => a.hp - b.hp);

  // Average front line position for formation reference
  const avgFrontX = frontLine.length
    ? frontLine.reduce((s, u) => s + u.pos[0], 0) / frontLine.length
    : 3;

  for (const u of ctx.myUnits) {
    if (ap < 1) break;
    const range = RANGE[u.type];
    const moveRange = MOVE[u.type];

    // Priest: heal most wounded ally (prioritize front line if equally damaged)
    if (u.type === "priest" && ap >= 2 && (u.cooldowns.heal || 0) === 0) {
      const wounded = ctx.myUnits
        .filter(a => a.id !== u.id && a.hp < a.maxHp * 0.7)
        .sort((a, b) => {
          const pctA = a.hp / a.maxHp;
          const pctB = b.hp / b.maxHp;
          if (Math.abs(pctA - pctB) > 0.1) return pctA - pctB;
          // Prefer healing frontline
          const aFront = a.type === "knight" || a.type === "spear" ? 0 : 1;
          const bFront = b.type === "knight" || b.type === "spear" ? 0 : 1;
          return aFront - bFront;
        });
      const reachable = wounded.find(a => manhattan(u.pos, a.pos) <= RANGE.priest);
      if (reachable) {
        actions.push({ unitId: u.id, action: "skill", skill: "heal", target: reachable.id });
        ap -= 2;
        continue;
      }
    }

    // Mage: fireball dense enemy clusters
    if (u.type === "mage" && ap >= 3 && (u.cooldowns.fireball || 0) === 0) {
      for (const e of threats) {
        const nearby = ctx.enemyUnits.filter(o =>
          Math.max(Math.abs(o.pos[0] - e.pos[0]), Math.abs(o.pos[1] - e.pos[1])) <= 1
        );
        if (nearby.length >= 2 && manhattan(u.pos, e.pos) <= RANGE.mage) {
          actions.push({ unitId: u.id, action: "skill", skill: "fireball", target: e.pos });
          ap -= 3;
          break;
        }
      }
      if (ap < 3) continue; // fireball was cast
    }

    // Attack: focus fire lowest-HP enemy in range
    const target = woundedFirst.find(e => manhattan(u.pos, e.pos) <= range);
    if (target) {
      actions.push({ unitId: u.id, action: "attack", targetUnitId: target.id });
      ap -= 1;
      continue;
    }

    // Movement
    if (u.type === "knight" || u.type === "spear") {
      // Frontline: hold position near avgFrontX, engage enemies that come close
      const closestEnemy = threats[0];
      if (!closestEnemy) continue;
      const enemyDist = manhattan(u.pos, closestEnemy.pos);

      // If enemy is close, engage
      if (enemyDist <= range + moveRange) {
        const steps = Math.min(moveRange, Math.max(1, enemyDist - range + 1));
        const dest = stepToward(u.pos, closestEnemy.pos, steps);
        if (dest[0] !== u.pos[0] || dest[1] !== u.pos[1]) {
          actions.push({ unitId: u.id, action: "move", target: dest });
          ap -= 1;
          continue;
        }
      }

      // Hold defensive position
      actions.push({ unitId: u.id, action: "defend" });
    } else {
      // Ranged: stay behind front line, attack from safe distance
      const nearestEnemy = ctx.enemyUnits.reduce((best, e) => {
        const d = manhattan(u.pos, e.pos);
        return d < best.d ? { e, d } : best;
      }, { e: null, d: Infinity });

      // Retreat only if melee enemy is adjacent (distance 1)
      if (nearestEnemy.e) {
        const enemyType = nearestEnemy.e.type;
        const enemyRange = RANGE[enemyType] || 1;
        if (nearestEnemy.d <= enemyRange) {
          const dest = stepAway(u.pos, nearestEnemy.e.pos, moveRange);
          if (dest[0] !== u.pos[0] || dest[1] !== u.pos[1]) {
            actions.push({ unitId: u.id, action: "move", target: dest });
            ap -= 1;
            continue;
          }
        }
      }

      // Move to optimal range: close enough to attack, behind frontline
      if (threats[0]) {
        const dist = manhattan(u.pos, threats[0].pos);
        if (dist > range + 1) {
          const dest = stepToward(u.pos, threats[0].pos, moveRange);
          // Don't move past the front line
          if (dest[0] <= avgFrontX + 1 && (dest[0] !== u.pos[0] || dest[1] !== u.pos[1])) {
            actions.push({ unitId: u.id, action: "move", target: dest });
            ap -= 1;
            continue;
          }
        }
      }

      // Nothing to do — defend
      actions.push({ unitId: u.id, action: "defend" });
    }
  }

  // Blue turtle buys: balanced defense, prioritize frontline and healers
  const money = ctx.myMoney || 0;
  const melee = ctx.myUnits.filter(u => u.type === "knight" || u.type === "spear").length;
  const hasPriest = ctx.myUnits.some(u => u.type === "priest");
  const hasMage = ctx.myUnits.some(u => u.type === "mage");

  let buyOrder;
  if (!hasPriest) {
    buyOrder = ["priest", "knight", "archer", "spear", "mage"];
  } else if (!hasMage) {
    buyOrder = ["mage", "knight", "archer", "spear", "priest"];
  } else if (melee < 3) {
    buyOrder = ["knight", "spear", "priest", "archer", "mage"];
  } else {
    buyOrder = ["priest", "archer", "knight", "mage", "spear"];
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
