// Smoke-test sample agent: minimal greedy rusher.
// Each unit attacks nearest enemy in range, else moves toward it.

export function decideTurn(ctx) {
  const RANGE = { knight: 1, spear: 2, archer: 4, mage: 3, priest: 2 };
  const MOVE = { knight: 3, spear: 2, archer: 2, mage: 1, priest: 2 };

  const actions = [];
  let ap = ctx.myAP;
  if (ctx.enemyUnits.length === 0) return actions;

  function manhattan(a, b) {
    return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
  }

  for (const u of ctx.myUnits) {
    if (ap < 1) break;

    let nearest = ctx.enemyUnits[0];
    let bestD = manhattan(u.pos, nearest.pos);
    for (const e of ctx.enemyUnits) {
      const d = manhattan(u.pos, e.pos);
      if (d < bestD) { bestD = d; nearest = e; }
    }

    const r = RANGE[u.type] || 1;
    if (bestD <= r) {
      actions.push({ unitId: u.id, action: "attack", targetUnitId: nearest.id });
      ap -= 1;
      continue;
    }

    const mr = MOVE[u.type] || 1;
    const dx0 = nearest.pos[0] - u.pos[0];
    const dy0 = nearest.pos[1] - u.pos[1];
    let left = mr;
    const dxMag = Math.min(Math.abs(dx0), left);
    const dx = Math.sign(dx0) * dxMag;
    left -= dxMag;
    const dyMag = Math.min(Math.abs(dy0), left);
    const dy = Math.sign(dy0) * dyMag;
    actions.push({ unitId: u.id, action: "move", target: [u.pos[0] + dx, u.pos[1] + dy] });
    ap -= 1;
  }

  return actions;
}
