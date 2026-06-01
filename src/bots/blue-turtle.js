// blue-turtle — disciplined defensive wall. It does NOT chase: it buys archers +
// mages behind a knight screen and a pair of priests, then HOLDS its own half and
// lets the enemy's AP-throttled advance impale itself on concentrated, no-overkill
// fire. It exploits ctx.isFirstMover defensively: as the SECOND mover it can react,
// so it kites units backward out of any enemy that closed in this round; as the
// FIRST mover (blind to the enemy's reply) it simply holds the line and stays safe.
//
// Doctrine (16x12 / AP-10 / buy-economy board):
//  - Archers (range 4) out-reach everything; never advancing means we always fire
//    from max range while the enemy eats AP closing the gap.
//  - Knights screen the firing line; priests keep the wall standing.

const COST   = { knight:5, spear:3, archer:3, mage:4, priest:4, engineer:2 };
const RANGE  = { knight:1, spear:2, archer:3, mage:3, priest:2, engineer:1 };
const MOVE   = { knight:2, spear:3, archer:2, mage:1, priest:1, engineer:2 };
const ATK    = { knight:20, spear:25, archer:18, mage:30, priest:10, engineer:12 };
const THREAT = { mage:10, archer:9, spear:7, priest:6, engineer:4, knight:2 };

// Defensive composition: archer wall, splash, a knight screen, two priests.
const TARGET = { archer: 24, mage: 2, knight: 3, priest: 2 };

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

  // Infer our side from our army's average x → the midfield line we hold at.
  let sumx = 0; for (const u of my) sumx += u.pos[0];
  const left = (sumx / my.length) < 8;
  const holdLimit = left ? 7 : 8;            // don't advance past midfield
  const inOwnHalf = (x) => left ? x <= holdLimit : x >= holdLimit;

  // Only the second mover can safely react (the enemy has already committed).
  const canReact = !ctx.isFirstMover;

  const predHP = {};
  for (const e of en) predHP[e.id] = e.hp;

  const occ = new Set();
  for (const u of my) occ.add(u.pos[0]+","+u.pos[1]);
  for (const e of en) occ.add(e.pos[0]+","+e.pos[1]);

  const ORDER = { knight:0, spear:1, engineer:2, archer:3, mage:4, priest:5 };
  const units = [...my].sort((a,b)=> (ORDER[a.type]||9)-(ORDER[b.type]||9));
  let ap = ctx.myAP;

  // Anchor for the knight screen: enemy nearest our line (block the spearhead).
  let anchor, ad = Infinity;
  for (const e of en) {
    let nd = Infinity;
    for (const u of my) { const d = mhd(u.pos, e.pos); if (d < nd) nd = d; }
    if (nd < ad) { ad = nd; anchor = e; }
  }

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

  // Priests heal first.
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
      acted.add(u.id);
      continue;
    }
    if (ap < 1) continue;
    const r = RANGE[u.type], mv = MOVE[u.type];

    if (u.type === "archer" || u.type === "mage") {
      // Defensive kite. Never advance to seek the enemy — hold the range edge
      // INSIDE our own half. If we move second and an enemy has closed to our
      // firing distance, step back to keep them at arm's length.
      let curNear = Infinity;
      for (const e of en) { if (predHP[e.id]<=0) continue; const d = mhd(u.pos, e.pos); if (d < curNear) curNear = d; }
      const threatened = canReact && curNear <= r;

      let dest = null;
      if (threatened) {
        // Retreat: maximize distance to the nearest enemy, staying in our half.
        let bd = curNear;
        for (let dx=-mv; dx<=mv; dx++) for (let dy=-mv; dy<=mv; dy++) {
          const dd=Math.abs(dx)+Math.abs(dy); if (dd===0||dd>mv) continue;
          const nx=u.pos[0]+dx, ny=u.pos[1]+dy;
          if (nx<0||nx>15||ny<0||ny>11) continue;
          if (occ.has(nx+","+ny) || !inOwnHalf(nx)) continue;
          let near=Infinity; for (const e of en){ if(predHP[e.id]<=0) continue; const d=mhd([nx,ny],e.pos); if(d<near)near=d; }
          if (near>bd){bd=near; dest=[nx,ny];}
        }
      } else {
        // Hold the range edge within our half. If nothing is in range, STAY PUT.
        let edgeNear=-1;
        for (let dx=-mv; dx<=mv; dx++) for (let dy=-mv; dy<=mv; dy++) {
          const dd=Math.abs(dx)+Math.abs(dy); if (dd>mv) continue;
          const nx=u.pos[0]+dx, ny=u.pos[1]+dy;
          if (nx<0||nx>15||ny<0||ny>11) continue;
          if ((dx!==0||dy!==0) && (occ.has(nx+","+ny) || !inOwnHalf(nx))) continue;
          let near=Infinity, cnt=0;
          for (const e of en){ if(predHP[e.id]<=0) continue; const d=mhd([nx,ny],e.pos); if(d<near)near=d; if(d<=r)cnt++; }
          if (cnt>0 && near>edgeNear){edgeNear=near; dest=[nx,ny];}
        }
      }
      if (dest && (dest[0]!==u.pos[0]||dest[1]!==u.pos[1])) {
        occ.delete(u.pos[0]+","+u.pos[1]); occ.add(dest[0]+","+dest[1]);
        actions.push({unitId:u.id,action:"move",target:dest}); ap--;
      }
    } else {
      // Knight/spear screen: form the wall at the hold line in front of the
      // threatened sector — never charge out past our own half.
      const gx = holdLimit, gy = anchor.pos[1];
      if (moveToward(u, gx, gy)) ap--;
    }
  }

  return actions;
}
