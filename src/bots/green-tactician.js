// green-tactician — threat-priority tactician. A balanced archer line backed by an
// unusually heavy mage wing for splash. It advances to a MODERATE engagement line
// (not a blitz, not a turtle), reads the enemy cluster, and focuses fire to FINISH
// the highest-threat target it can kill each volley. It uses ctx.isFirstMover to
// choose its aim point: as the FIRST mover it pre-aims at the enemy's backline DPS
// (mages/archers/priests) before they can reposition; as the SECOND mover it pivots
// onto the densest enemy cluster the enemy just formed, maximizing splash.
//
// Doctrine (16x12 / AP-10 / buy-economy board):
//  - Range-4 archers + range-3 mages converge for local superiority and finish
//    low-HP / high-threat enemies first so enemy DPS collapses fastest.

const COST   = { knight:5, spear:3, archer:3, mage:4, priest:4, engineer:2 };
const RANGE  = { knight:1, spear:2, archer:3, mage:3, priest:2, engineer:1 };
const MOVE   = { knight:3, spear:3, archer:2, mage:1, priest:2, engineer:2 };
const ATK    = { knight:20, spear:25, archer:18, mage:30, priest:10, engineer:12 };
const THREAT = { mage:10, archer:9, spear:7, priest:6, engineer:4, knight:2 };

// Heavier mage wing than the others — splash is this bot's signature.
const TARGET = { archer: 26, mage: 6 };
// Moderate posture: advance only until an enemy is within ENGAGE tiles, then hold
// the range edge (neither charge nor turtle).
const ENGAGE = 6;

function mhd(a,b){ return Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]); }
function cheb(a,b){ return Math.max(Math.abs(a[0]-b[0]), Math.abs(a[1]-b[1])); }

function doBuy(ctx, actions) {
  let money = ctx.myMoney || 0;
  const counts = {};
  for (const u of ctx.myArmy) counts[u.type] = (counts[u.type]||0) + (u.count||0);
  let guard = 0;
  while (money >= 2 && guard++ < 200) {
    let pick = null, bestDeficit = -Infinity;
    for (const t of Object.keys(TARGET)) {
      if (TARGET[t] <= 0 || COST[t] > money) continue;
      const deficit = (TARGET[t] - (counts[t]||0)) / TARGET[t];
      if (deficit > bestDeficit) { bestDeficit = deficit; pick = t; }
    }
    if (!pick || bestDeficit <= 0) {
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

  const minDistToMy = (e) => { let nd=Infinity; for (const u of my){ const d=mhd(u.pos,e.pos); if(d<nd)nd=d; } return nd; };

  // Aim point depends on turn order:
  //  - First mover: the highest-THREAT enemy (pre-empt their DPS), tie-broken by
  //    proximity so we don't chase an unreachable straggler.
  //  - Second mover: the densest enemy cluster (best splash) the enemy just formed.
  let anchor, abest = -Infinity;
  if (ctx.isFirstMover) {
    for (const e of en) {
      const s = THREAT[e.type]*100 - minDistToMy(e);
      if (s > abest) { abest = s; anchor = e; }
    }
  } else {
    for (const e of en) {
      let n=0; for (const o of en) if (cheb(o.pos,e.pos)<=1) n++;
      const s = n*100 - minDistToMy(e)*0.1;
      if (s > abest) { abest = s; anchor = e; }
    }
  }
  const ex = anchor.pos[0], ey = anchor.pos[1];

  const predHP = {};
  for (const e of en) predHP[e.id] = e.hp;

  const occ = new Set();
  for (const u of my) occ.add(u.pos[0]+","+u.pos[1]);
  for (const e of en) occ.add(e.pos[0]+","+e.pos[1]);

  const ORDER = { knight:0, spear:1, engineer:2, archer:3, mage:4, priest:5 };
  const units = [...my].sort((a,b)=> (ORDER[a.type]||9)-(ORDER[b.type]||9));
  let ap = ctx.myAP;

  function pickTarget(u) {
    const r = RANGE[u.type];
    const inRange = en.filter(e => predHP[e.id] > 0 && mhd(u.pos, e.pos) <= r);
    if (!inRange.length) return null;
    if (u.type === "mage") {
      let best=null, bs=-1;
      for (const e of inRange) {
        let n=0; for (const o of en) if (predHP[o.id]>0 && o.id!==e.id && cheb(o.pos,e.pos)<=1) n++;
        const score = n*100 + (predHP[e.id] <= ATK.mage ? 50 : 0) - predHP[e.id]*0.01;
        if (score>bs){bs=score;best=e;}
      }
      return best;
    }
    // Archers: finish a killable target (highest threat we can kill), else SNIPE
    // the highest-threat enemy in range (this bot weights threat harder than HP).
    let finishBest=null, fbs=-Infinity, threatBest=null, tbs=-Infinity;
    for (const e of inRange) {
      const hp = predHP[e.id];
      if (hp <= ATK[u.type]) { const s = THREAT[e.type]*1000 - hp; if (s > fbs) { fbs = s; finishBest = e; } }
      const ts = THREAT[e.type]*20 - hp*5;
      if (ts > tbs) { tbs = ts; threatBest = e; }
    }
    return finishBest || threatBest;
  }

  function pressEdge(u) {
    // Advance toward the anchor only while an enemy is within ENGAGE; otherwise
    // hold the range edge (max distance among in-range cells).
    const r = RANGE[u.type], mv = MOVE[u.type];
    let curNear = Infinity;
    for (const e of en) { if (predHP[e.id]<=0) continue; const d=mhd(u.pos,e.pos); if(d<curNear)curNear=d; }
    let edgeBest=null, edgeNear=-1, advBest=null, advBd=Infinity;
    for (let dx=-mv; dx<=mv; dx++) for (let dy=-mv; dy<=mv; dy++) {
      const dd=Math.abs(dx)+Math.abs(dy); if (dd>mv) continue;
      const nx=u.pos[0]+dx, ny=u.pos[1]+dy;
      if (nx<0||nx>15||ny<0||ny>11) continue;
      if ((dx!==0||dy!==0) && occ.has(nx+","+ny)) continue;
      let near=Infinity, cnt=0;
      for (const e of en){ if(predHP[e.id]<=0) continue; const d=mhd([nx,ny],e.pos); if(d<near)near=d; if(d<=r)cnt++; }
      if (cnt>0) { if (near>edgeNear){edgeNear=near; edgeBest=[nx,ny];} }
      const toAnchor = mhd([nx,ny],[ex,ey]);
      if (toAnchor<advBd){advBd=toAnchor; advBest=[nx,ny];}
    }
    const dest = edgeBest || (curNear <= ENGAGE ? advBest : null);
    if (dest && (dest[0]!==u.pos[0]||dest[1]!==u.pos[1])) {
      occ.delete(u.pos[0]+","+u.pos[1]); occ.add(dest[0]+","+dest[1]);
      actions.push({unitId:u.id,action:"move",target:dest}); return true;
    }
    return false;
  }

  for (const u of units) {
    const tgt = pickTarget(u);
    if (tgt) {
      actions.push({unitId:u.id,action:"attack",targetUnitId:tgt.id});
      predHP[tgt.id] -= ATK[u.type];
      if (u.type==="mage") for (const o of en) if (o.id!==tgt.id && predHP[o.id]>0 && cheb(o.pos,tgt.pos)<=1) predHP[o.id]-=Math.floor(ATK.mage/2);
      continue;
    }
    if (ap < 1) continue;
    if (pressEdge(u)) ap--;
  }

  return actions;
}
