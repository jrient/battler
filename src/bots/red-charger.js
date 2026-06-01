// red-charger — aggressive combined-arms blitz. Unlike a pure kiter, it buys a
// melee spearhead (knights + spears) behind a screen of archers and DRIVES
// forward to break the enemy line at close range. It exploits ctx.isFirstMover:
// as the FIRST mover it presses the tempo (archers advance into range, melee
// charge the center); as the SECOND mover it reacts — collapsing its charge onto
// whichever enemy unit overextended toward it this round.
//
// Doctrine (16x12 / AP-10 / buy-economy board):
//  - Archers (range 4) screen and soften; the melee wedge then closes to finish.
//  - Attacks are free and one-per-unit, so we converge the whole army on ONE
//    target (local superiority) and finish low-HP / high-threat enemies first.

const COST   = { knight:5, spear:3, archer:3, mage:4, priest:4, engineer:2 };
const RANGE  = { knight:1, spear:2, archer:3, mage:3, priest:2, engineer:1 };
const MOVE   = { knight:3, spear:3, archer:2, mage:1, priest:2, engineer:2 };
const ATK    = { knight:20, spear:25, archer:18, mage:30, priest:10, engineer:12 };
const THREAT = { mage:10, archer:9, spear:7, priest:6, engineer:4, knight:2 };

// Combined-arms army: an archer screen plus a real melee wedge to break the line.
const TARGET = { archer: 18, spear: 9, knight: 3, mage: 1 };

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
      // Quota met: pour the second-mover bonus / leftover into more spears.
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

  // Anchor = the enemy our whole army converges on.
  //  - First mover (we set the tempo): the enemy nearest our centroid — press the
  //    center and roll up the line.
  //  - Second mover (we react): the enemy that pushed CLOSEST to any of our units
  //    this round — punish the overextension before it can pull back.
  let anchor, ad = Infinity;
  if (ctx.isFirstMover) {
    let mx=0, myy=0;
    for (const u of my) { mx += u.pos[0]; myy += u.pos[1]; }
    mx /= my.length; myy /= my.length;
    for (const e of en) { const d = mhd([mx,myy], e.pos); if (d < ad) { ad = d; anchor = e; } }
  } else {
    for (const e of en) {
      let nd = Infinity;
      for (const u of my) { const d = mhd(u.pos, e.pos); if (d < nd) nd = d; }
      if (nd < ad) { ad = nd; anchor = e; }
    }
  }
  const ex = anchor.pos[0], ey = anchor.pos[1];

  // As first mover we accept some return fire to keep pressing; as second mover we
  // hold the range edge (the enemy already moved and can't punish us back).
  const press = !!ctx.isFirstMover;

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
    if (u.type === "spear") {
      let best=null, bs=-1;
      for (const e of inRange) {
        const dx=Math.sign(e.pos[0]-u.pos[0]), dy=Math.sign(e.pos[1]-u.pos[1]);
        const hasBehind = en.some(o=>predHP[o.id]>0 && o.pos[0]===e.pos[0]+dx && o.pos[1]===e.pos[1]+dy);
        const score = (hasBehind?100:0) + THREAT[e.type]*5 - predHP[e.id]*0.1 + (predHP[e.id]<=ATK.spear?40:0);
        if (score>bs){bs=score;best=e;}
      }
      return best;
    }
    let finishBest=null, fbs=-Infinity, lowBest=null, lbs=Infinity;
    for (const e of inRange) {
      const hp = predHP[e.id];
      if (hp <= ATK[u.type]) { const s = THREAT[e.type]*1000 - hp; if (s > fbs) { fbs = s; finishBest = e; } }
      const ls = hp*10 - THREAT[e.type];
      if (ls < lbs) { lbs = ls; lowBest = e; }
    }
    return finishBest || lowBest;
  }

  function moveToward(u, gx, gy) {
    const mv = MOVE[u.type];
    let bx=u.pos[0], by=u.pos[1], bd=mhd(u.pos,[gx,gy]), found=false;
    for (let dx=-mv; dx<=mv; dx++) for (let dy=-mv; dy<=mv; dy++) {
      const d=Math.abs(dx)+Math.abs(dy); if (d===0||d>mv) continue;
      const nx=u.pos[0]+dx, ny=u.pos[1]+dy;
      if (nx<0||nx>15||ny<0||ny>11) continue;
      if (occ.has(nx+","+ny)) continue;
      const nd=mhd([nx,ny],[gx,gy]);
      if (nd<bd){bd=nd;bx=nx;by=ny;found=true;}
    }
    if (found){ occ.delete(u.pos[0]+","+u.pos[1]); occ.add(bx+","+by); actions.push({unitId:u.id,action:"move",target:[bx,by]}); return true; }
    return false;
  }

  // Priests heal first (attacking an ally heals it).
  const acted = new Set();
  for (const u of units) {
    if (u.type !== "priest") continue;
    const r = RANGE.priest;
    const wounded = my.filter(a=>a.id!==u.id && a.hp < a.maxHp*0.9 && mhd(u.pos,a.pos)<=r)
      .sort((a,b)=>{ const va=a.type==="knight"?0:1, vb=b.type==="knight"?0:1; return va!==vb?va-vb:a.hp/a.maxHp-b.hp/b.maxHp; });
    if (wounded.length) { actions.push({unitId:u.id,action:"attack",targetUnitId:wounded[0].id}); acted.add(u.id); }
  }

  for (const u of units) {
    if (acted.has(u.id)) continue;
    const tgt = pickTarget(u);
    if (tgt) {
      actions.push({unitId:u.id,action:"attack",targetUnitId:tgt.id});
      predHP[tgt.id] -= ATK[u.type];
      if (u.type==="mage") for (const o of en) if (o.id!==tgt.id && predHP[o.id]>0 && cheb(o.pos,tgt.pos)<=1) predHP[o.id]-=Math.floor(ATK.mage/2);
      if (u.type==="spear") { const dx=Math.sign(tgt.pos[0]-u.pos[0]), dy=Math.sign(tgt.pos[1]-u.pos[1]); for (const o of en) if (o.id!==tgt.id && predHP[o.id]>0 && o.pos[0]===tgt.pos[0]+dx && o.pos[1]===tgt.pos[1]+dy) predHP[o.id]-=Math.floor(ATK.spear/2); }
      acted.add(u.id);
      continue;
    }
    if (ap < 1) continue;
    const r = RANGE[u.type], mv = MOVE[u.type];
    if (u.type === "archer" || u.type === "mage") {
      // Ranged screen. Step to a cell that brings an enemy into range; hold the
      // range EDGE when reacting (max distance), but when pressing (first mover)
      // close to the nearest in-range cell to apply pressure ahead of the wedge.
      let edgeBest=null, edgeNear=-1, closeBest=null, closeNear=Infinity, advBest=null, advNear=Infinity;
      for (let dx=-mv; dx<=mv; dx++) for (let dy=-mv; dy<=mv; dy++) {
        const dd=Math.abs(dx)+Math.abs(dy); if (dd>mv) continue;
        const nx=u.pos[0]+dx, ny=u.pos[1]+dy;
        if (nx<0||nx>15||ny<0||ny>11) continue;
        if ((dx!==0||dy!==0) && occ.has(nx+","+ny)) continue;
        let near=Infinity, cnt=0;
        for (const e of en){ if(predHP[e.id]<=0) continue; const d=mhd([nx,ny],e.pos); if(d<near)near=d; if(d<=r)cnt++; }
        if (cnt>0) {
          if (near>edgeNear){edgeNear=near; edgeBest=[nx,ny];}
          if (near<closeNear){closeNear=near; closeBest=[nx,ny];}
        } else if (near<advNear){advNear=near; advBest=[nx,ny];}
      }
      const inRangeDest = press ? closeBest : edgeBest;
      const dest = inRangeDest || advBest; // ENGAGE=always: keep advancing
      if (dest && (dest[0]!==u.pos[0]||dest[1]!==u.pos[1])) {
        occ.delete(u.pos[0]+","+u.pos[1]); occ.add(dest[0]+","+dest[1]);
        actions.push({unitId:u.id,action:"move",target:dest}); ap--;
      }
    } else {
      // Melee wedge: charge the anchor relentlessly.
      if (moveToward(u, ex, ey)) ap--;
    }
  }

  return actions;
}
