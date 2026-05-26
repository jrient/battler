// red-charger: aggressive bot that rushes forward and focuses nearest threats.
// Public reference bot. LLM agents may read this code for inspiration.

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
    (a, b) => (THREAT[b.type] || 0) - (THREAT[a.type] || 0),
  );

  for (const u of ctx.myUnits) {
    if (ap < 1) break;

    // Mage: try fireball on a cluster of 2+
    if (u.type === "mage" && ap >= 3 && (u.cooldowns.fireball || 0) === 0) {
      const cluster = densestCell(ctx.enemyUnits, 1);
      if (cluster.count >= 2 && cluster.pos) {
        const dist = manhattan(u.pos, cluster.pos);
        if (dist <= RANGE.mage) {
          actions.push({ unitId: u.id, action: "skill", skill: "fireball", target: cluster.pos });
          ap -= 3;
          continue;
        }
      }
    }

    // Priest: heal lowest-hp wounded ally within range
    if (u.type === "priest" && ap >= 2 && (u.cooldowns.heal || 0) === 0) {
      const wounded = ctx.myUnits
        .filter((a) => a.id !== u.id && a.hp < a.maxHp * 0.6)
        .sort((a, b) => a.hp - b.hp);
      const reachable = wounded.find((a) => manhattan(u.pos, a.pos) <= RANGE.priest);
      if (reachable) {
        actions.push({ unitId: u.id, action: "skill", skill: "heal", target: reachable.id });
        ap -= 2;
        continue;
      }
    }

    // Default: attack highest-threat reachable, else move toward it
    const range = RANGE[u.type] || 1;
    const inRange = targetsByThreat.find((e) => manhattan(u.pos, e.pos) <= range);
    if (inRange) {
      actions.push({ unitId: u.id, action: "attack", targetUnitId: inRange.id });
      ap -= 1;
      continue;
    }
    const goal = targetsByThreat[0];
    const dest = stepToward(u.pos, goal.pos, MOVE[u.type] || 1);
    actions.push({ unitId: u.id, action: "move", target: dest });
    ap -= 1;
  }

  return actions;
}
