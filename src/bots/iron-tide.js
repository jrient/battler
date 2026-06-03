// iron-tide — 钢铁洪流 (Iron Tide). A COMBINED-ARMS phalanx, not a swarm. The
// board is full of ranged walls (blue-turtle, red-charger, green-tactician all
// lean archer/mage), and the losing answer is a crowd of individuals charging in
// and dying piecemeal. Instead this fields a cohesive block that rolls forward as
// ONE body and only commits when assembled:
//   front rank  — knights (HALVE incoming damage → ~200 effective HP) form the
//                 wall and soak the firing line;
//   mid ranks   — archers + mages tuck behind and fire range-3 OVER the wall (no
//                 line-of-sight blocking here), so the block deals damage the
//                 WHOLE approach; mage SPLASH is what cracks a healer deathball —
//                 it spreads damage faster than enemy priests can patch it;
//   rear rank   — priests selectively heal the wall (double value on a
//                 damage-halving knight).
//
// Doctrine (16x12 / AP-10 / buy-economy board):
//  - COHESION OVER SPEED. The wall only creeps forward when the body is assembled
//    and never steps past its own rank line — lone chargers just feed the enemy.
//    (Verified: faster movement AND aggressive "push to contact" both LOWERED the
//    winrate; the patient line wins the attrition trade.)
//  - AP is the scarce resource (10 moves for ~30 units): spend it on whoever is
//    MOST out of formation so stragglers / fresh buys re-form before the line
//    advances. Units already in place cost nothing.
//  - FOCUS-FIRE to KILL, priests first. Spread damage is wasted (enemy priests
//    heal it back), so pile every free attack onto ONE target — enemy PRIESTS,
//    then MAGES, then the most-wounded — until it dies, then move to the next.

const COST   = { knight:5, spear:3, archer:3, mage:4, priest:4, engineer:2 };
const RANGE  = { knight:1, spear:2, archer:3, mage:3, priest:2, engineer:1 };
const MOVE   = { knight:3, spear:3, archer:2, mage:1, priest:2, engineer:3 };
const ATK    = { knight:20, spear:25, archer:18, mage:30, priest:10, engineer:12 };
const THREAT = { mage:14, priest:9, archer:7, spear:6, engineer:4, knight:2 };

// Even combined-arms split: a knight wall, equal archer + mage bodies for
// range-3 output (mages add the splash that breaks healer balls), and priests to
// keep the wall up. Mass matters — a tiny block cannot out-damage enemy healing
// (a 9-unit build tested at 0%); this 30-unit mix is the most balanced of the
// configs tried (≈38/45/38 vs red/blue/green), with no exploitable weakness.
const TARGET = { knight: 8, archer: 8, mage: 8, priest: 6 };

// Rank offset behind the wall line (tiles toward our own side).
const RANKOFF = { knight:0, archer:1, mage:1, spear:1, priest:2, engineer:0 };

function mhd(a,b){ return Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]); }
function cheb(a,b){ return Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1])); }

function doBuy(ctx, actions) {
  let money = ctx.myMoney || 0;
  const counts = {};
  for (const u of ctx.myArmy) counts[u.type] = (counts[u.type]||0) + (u.count||0);
  let guard = 0;
  while (money >= 3 && guard++ < 200) {
    let pick = null, bestDeficit = -Infinity;
    for (const t of Object.keys(TARGET)) {
      if (TARGET[t] <= 0 || COST[t] > money) continue;
      const deficit = (TARGET[t] - (counts[t]||0)) / TARGET[t];
      if (deficit > bestDeficit) { bestDeficit = deficit; pick = t; }
    }
    if (!pick) break;
    if (bestDeficit <= 0) {
      // Quota met: dump leftover gold into more archers (cheap sustained damage).
      let cheap = null;
      for (const t of Object.keys(TARGET)) if (TARGET[t] > 0 && COST[t] <= money && (cheap===null || COST[t] < COST[cheap])) cheap = t;
      if (!cheap) break;
      pick = cheap;
    }
    actions.push({ action:"buy", unitType: pick });
    counts[pick] = (counts[pick]||0) + 1;
    money -= COST[pick];
  }
}

export function decideTurn(ctx) {
  const actions = [];
  if (ctx.turn <= 10 && (ctx.myMoney||0) > 0) doBuy(ctx, actions);

  const my = ctx.myUnits || [];
  const en = ctx.enemyUnits || [];
  if (!my.length || !en.length) return actions;

  let mx=0, myy=0;
  for (const u of my){ mx+=u.pos[0]; myy+=u.pos[1]; }
  mx/=my.length; myy/=my.length;

  const predHP = {};
  for (const e of en) predHP[e.id] = e.hp;

  const occ = new Set();
  for (const u of my) occ.add(u.pos[0]+","+u.pos[1]);
  for (const e of en) occ.add(e.pos[0]+","+e.pos[1]);

  function pickTarget(u) {
    const r = RANGE[u.type];
    const inRange = en.filter(e => predHP[e.id] > 0 && mhd(u.pos, e.pos) <= r);
    if (!inRange.length) return null;
    if (u.type === "mage") {
      let best=null, bs=-1;
      for (const e of inRange) {
        let n=0; for (const o of en) if (predHP[o.id]>0 && o.id!==e.id && cheb(o.pos,e.pos)<=1) n++;
        const score = n*100 + THREAT[e.type]*5 + (predHP[e.id] <= ATK.mage ? 50 : 0) - predHP[e.id]*0.01;
        if (score>bs){bs=score;best=e;}
      }
      return best;
    }
    let finishBest=null, fbs=-Infinity, lowBest=null, lbs=Infinity;
    for (const e of inRange) {
      const hp = predHP[e.id];
      if (hp <= ATK[u.type]) { const s = THREAT[e.type]*1000 - hp; if (s > fbs) { fbs = s; finishBest = e; } }
      const ls = hp*10 - THREAT[e.type]*8;
      if (ls < lbs) { lbs = ls; lowBest = e; }
    }
    return finishBest || lowBest;
  }

  // ===== FORMATION GEOMETRY =====
  let ecx=0, ecy=0; for (const e of en){ ecx+=e.pos[0]; ecy+=e.pos[1]; } ecx/=en.length; ecy/=en.length;
  const dir = Math.sign(ecx - mx) || 1;
  const aimY = Math.round(ecy);

  const allK = my.filter(u=>u.type==="knight");
  let wallX = Math.round(mx);
  if (allK.length){ const xs=allK.map(k=>k.pos[0]).sort((a,b)=>a-b); wallX = xs[Math.floor(xs.length/2)]; }
  const kxs = allK.map(k=>k.pos[0]);
  const xspread = kxs.length ? Math.max(...kxs)-Math.min(...kxs) : 0;
  const assembled = xspread <= 2;
  // Creep the wall forward one tile ONLY when the body is assembled (knights tight
  // in x). Pushing aggressively all the way to melee was tested and collapsed the
  // winrate (3/35/2): the body trickles into the firing line and is slaughtered.
  // The conservative line holds formation and wins the attrition trade instead.
  const inContact = Math.abs(ecx - wallX) <= 1;
  const lineX = inContact ? wallX : (assembled ? wallX + dir : wallX);

  function advance(u, tx, ty) {
    const mv = MOVE[u.type];
    let bx=u.pos[0], by=u.pos[1], bd=mhd(u.pos,[tx,ty]), found=false;
    for (let dx=-mv; dx<=mv; dx++) for (let dy=-mv; dy<=mv; dy++) {
      const d=Math.abs(dx)+Math.abs(dy); if (d===0||d>mv) continue;
      const nx=u.pos[0]+dx, ny=u.pos[1]+dy;
      if (nx<0||nx>15||ny<0||ny>11) continue;
      if (occ.has(nx+","+ny)) continue;
      if (dir>0 && nx > tx) continue;
      if (dir<0 && nx < tx) continue;
      const nd=mhd([nx,ny],[tx,ty]);
      if (nd<bd){ bd=nd; bx=nx; by=ny; found=true; }
    }
    if (found){ occ.delete(u.pos[0]+","+u.pos[1]); occ.add(bx+","+by); actions.push({unitId:u.id,action:"move",target:[bx,by]}); return true; }
    return false;
  }

  // ===== PHASE 1: priests heal (knights first, then wounded archers) =====
  const acted = new Set();
  for (const u of my) {
    if (u.type !== "priest") continue;
    const r = RANGE.priest;
    const wounded = my.filter(a=>a.id!==u.id && a.hp < a.maxHp*0.9 && mhd(u.pos,a.pos)<=r)
      .sort((a,b)=>{ const va=a.type==="knight"?0:1, vb=b.type==="knight"?0:1; return va!==vb?va-vb:a.hp/a.maxHp-b.hp/b.maxHp; });
    if (wounded.length) { actions.push({unitId:u.id,action:"attack",targetUnitId:wounded[0].id}); acted.add(u.id); }
  }

  // ===== PHASE 2: coordinated focus-fire — concentrate to KILL, priests first =====
  // Spread damage is wasted: enemy priests just heal it back. So every free
  // attack piles onto ONE highest-value reachable target until predHP hits 0 —
  // enemy PRIESTS first (kill the healing so our damage finally sticks), then
  // MAGES (splash), then finish the most-wounded high-threat unit. predHP
  // accumulates across our units, so e.g. three archers stack to drop a 50-HP
  // priest in a single turn instead of chipping six enemies for no kills.
  function killTier(t){ return t === "priest" ? 0 : t === "mage" ? 1 : 2; }
  for (const u of my) {
    if (acted.has(u.id)) continue;
    const r = RANGE[u.type];
    const cand = en.filter(e => predHP[e.id] > 0 && mhd(u.pos, e.pos) <= r);
    if (!cand.length) continue;
    let best=null;
    if (u.type === "mage") {
      let bs=-1;
      for (const e of cand) {
        let n=0; for (const o of en) if (predHP[o.id]>0 && o.id!==e.id && cheb(o.pos,e.pos)<=1) n++;
        const score = n*100 + (2-killTier(e.type))*40 + (predHP[e.id] <= ATK.mage ? 50 : 0) - predHP[e.id]*0.05;
        if (score>bs){bs=score;best=e;}
      }
    } else {
      let bk=9, bh=Infinity, bt=-1;
      for (const e of cand) {
        const k=killTier(e.type), hp=predHP[e.id], th=THREAT[e.type];
        if (k<bk || (k===bk && hp<bh) || (k===bk && hp===bh && th>bt)) { bk=k; bh=hp; bt=th; best=e; }
      }
    }
    if (!best) continue;
    actions.push({unitId:u.id,action:"attack",targetUnitId:best.id});
    predHP[best.id] -= ATK[u.type];
    if (u.type==="mage") for (const o of en) if (o.id!==best.id && predHP[o.id]>0 && cheb(o.pos,best.pos)<=1) predHP[o.id]-=Math.floor(ATK.mage/2);
    acted.add(u.id);
  }

  // ===== PHASE 3: formation advance, AP spent on cohesion first =====
  const ORDER = { knight:0, archer:1, mage:2, spear:1, priest:3, engineer:0 };
  const movers = my.filter(u=>!acted.has(u.id)).map(u=>{
    const off = RANKOFF[u.type] ?? 1;
    const tx = lineX - off*dir;
    return { u, tx, ty: aimY, d: mhd(u.pos, [tx, aimY]) };
  }).sort((a,b)=> (b.d - a.d) || ((ORDER[a.u.type]||9)-(ORDER[b.u.type]||9)));
  let ap = ctx.myAP;
  for (const m of movers) {
    if (ap < 1) break;
    if (m.d === 0) continue;
    if (advance(m.u, m.tx, m.ty)) ap--;
  }

  return actions;
}
