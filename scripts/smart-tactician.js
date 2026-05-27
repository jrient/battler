// Smart tactician: prioritize threats, use skills wisely, protect fragile units
// Counters red-charger: focuses mage first, avoids clustering vs fireball, uses own mage AOE

const RANGE = { knight: 1, spear: 2, archer: 4, mage: 3, priest: 2 };
const MOVE = { knight: 3, spear: 2, archer: 2, mage: 1, priest: 2 };
const THREAT = { mage: 10, archer: 7, priest: 6, spear: 4, knight: 3 };

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

function stepAway(from, enemy, maxSteps) {
  const dx0 = from[0] - enemy[0];
  const dy0 = from[1] - enemy[1];
  if (dx0 === 0 && dy0 === 0) return [from[0], from[1]];
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
    if (count > bestCount) {
      bestCount = count;
      best = e.pos;
    }
  }
  return { pos: best, count: bestCount };
}

export function decideTurn(ctx) {
  const actions = [];
  let ap = ctx.myAP;
  if (ctx.enemyUnits.length === 0) return actions;

  const targetsByThreat = [...ctx.enemyUnits].sort(
    (a, b) => (THREAT[b.type] || 0) - (THREAT[a.type] || 0)
  );

  // Find nearest enemy melee unit (knight/spear) for retreat logic
  const meleeEnemies = ctx.enemyUnits.filter(e => e.type === "knight" || e.type === "spear");

  for (const u of ctx.myUnits) {
    if (ap < 1) break;

    const range = RANGE[u.type] || 1;
    const move = MOVE[u.type] || 1;

    // MAGE: use fireball on clusters of 2+ enemies, else attack highest threat
    if (u.type === "mage") {
      if (ap >= 3 && (u.cooldowns.fireball || 0) === 0) {
        const cluster = densestCell(ctx.enemyUnits, 1);
        if (cluster.count >= 2 && cluster.pos) {
          const dist = manhattan(u.pos, cluster.pos);
          if (dist <= range) {
            actions.push({ unitId: u.id, action: "skill", skill: "fireball", target: cluster.pos });
            ap -= 3;
            continue;
          }
        }
      }
      // Attack highest-threat in range (prefer mage > archer > priest)
      const inRange = targetsByThreat.filter(e => manhattan(u.pos, e.pos) <= range);
      if (inRange.length > 0) {
        actions.push({ unitId: u.id, action: "attack", targetUnitId: inRange[0].id });
        ap -= 1;
        continue;
      }
      // Move toward highest threat but stay safe
      const goal = targetsByThreat[0];
      const dest = stepToward(u.pos, goal.pos, move);
      actions.push({ unitId: u.id, action: "move", target: dest });
      ap -= 1;
      continue;
    }

    // PRIEST: heal wounded allies, else attack
    if (u.type === "priest") {
      if (ap >= 2 && (u.cooldowns.heal || 0) === 0) {
        const wounded = ctx.myUnits
          .filter(a => a.id !== u.id && a.hp < a.maxHp * 0.7)
          .sort((a, b) => a.hp - b.hp);
        const inRangeHeal = wounded.find(a => manhattan(u.pos, a.pos) <= range);
        if (inRangeHeal) {
          actions.push({ unitId: u.id, action: "skill", skill: "heal", target: inRangeHeal.id });
          ap -= 2;
          continue;
        }
      }
      // Attack in range
      const inRange = targetsByThreat.filter(e => manhattan(u.pos, e.pos) <= range);
      if (inRange.length > 0) {
        actions.push({ unitId: u.id, action: "attack", targetUnitId: inRange[0].id });
        ap -= 1;
        continue;
      }
      // Move toward goal
      const goal = targetsByThreat[0];
      actions.push({ unitId: u.id, action: "move", target: stepToward(u.pos, goal.pos, move) });
      ap -= 1;
      continue;
    }

    // ARCHER: stay at range, attack highest threat, retreat if melee too close
    if (u.type === "archer") {
      const nearestMelee = meleeEnemies.reduce((best, e) => {
        const d = manhattan(u.pos, e.pos);
        return d < (best ? manhattan(u.pos, best.pos) : 999) ? e : best;
      }, null);
      const meleeDist = nearestMelee ? manhattan(u.pos, nearestMelee.pos) : 99;

      // Attack highest threat in range
      const inRange = targetsByThreat.filter(e => manhattan(u.pos, e.pos) <= range);
      if (inRange.length > 0) {
        actions.push({ unitId: u.id, action: "attack", targetUnitId: inRange[0].id });
        ap -= 1;
        // Also retreat if melee is close (next action)
        if (meleeDist <= 2 && ap >= 1) {
          const retreat = stepAway(u.pos, nearestMelee.pos, move);
          actions.push({ unitId: u.id, action: "move", target: retreat });
          // Note: this will be truncated since same unit can't act twice, so we skip
        }
        continue;
      }
      // Move toward highest threat
      const goal = targetsByThreat[0];
      actions.push({ unitId: u.id, action: "move", target: stepToward(u.pos, goal.pos, move) });
      ap -= 1;
      continue;
    }

    // SPEAR: attack from range 2, prefer targets behind which there are other enemies (pierce)
    if (u.type === "spear") {
      const inRange = targetsByThreat.filter(e => manhattan(u.pos, e.pos) <= range);
      if (inRange.length > 0) {
        // Prefer targets that have another enemy behind them (pierce bonus)
        let best = inRange[0];
        for (const e of inRange) {
          const dx = Math.sign(e.pos[0] - u.pos[0]);
          const dy = Math.sign(e.pos[1] - u.pos[1]);
          const behindPos = [e.pos[0] + dx, e.pos[1] + dy];
          const hasPierceTarget = ctx.enemyUnits.some(
            other => other.id !== e.id && other.pos[0] === behindPos[0] && other.pos[1] === behindPos[1]
          );
          if (hasPierceTarget) { best = e; break; }
        }
        actions.push({ unitId: u.id, action: "attack", targetUnitId: best.id });
        ap -= 1;
        continue;
      }
      const goal = targetsByThreat[0];
      actions.push({ unitId: u.id, action: "move", target: stepToward(u.pos, goal.pos, move) });
      ap -= 1;
      continue;
    }

    // KNIGHT: tank and engage, protect fragile units by engaging melee threats
    if (u.type === "knight") {
      // Prioritize engaging enemies that threaten our mage/priest
      const fragileAllies = ctx.myUnits.filter(a => a.type === "mage" || a.type === "priest");
      let goal = targetsByThreat[0];
      for (const ally of fragileAllies) {
        const threat = ctx.enemyUnits
          .filter(e => manhattan(ally.pos, e.pos) <= RANGE[e.type])
          .sort((a, b) => manhattan(ally.pos, a.pos) - manhattan(ally.pos, b.pos))[0];
        if (threat) {
          goal = threat;
          break;
        }
      }
      const inRange = ctx.enemyUnits.filter(e => manhattan(u.pos, e.pos) <= range);
      if (inRange.length > 0) {
        // Attack the one closest to our fragile units
        let best = inRange[0];
        for (const ally of fragileAllies) {
          const closest = inRange.reduce((b, e) =>
            manhattan(ally.pos, e.pos) < manhattan(ally.pos, b.pos) ? e : b, inRange[0]);
          best = closest;
          break;
        }
        actions.push({ unitId: u.id, action: "attack", targetUnitId: best.id });
        ap -= 1;
        continue;
      }
      actions.push({ unitId: u.id, action: "move", target: stepToward(u.pos, goal.pos, move) });
      ap -= 1;
      continue;
    }

    // Fallback: generic attack or move
    const inRange = targetsByThreat.filter(e => manhattan(u.pos, e.pos) <= range);
    if (inRange.length > 0) {
      actions.push({ unitId: u.id, action: "attack", targetUnitId: inRange[0].id });
    } else {
      const goal = targetsByThreat[0];
      actions.push({ unitId: u.id, action: "move", target: stepToward(u.pos, goal.pos, move) });
    }
    ap -= 1;
  }

  return actions;
}
