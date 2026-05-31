# AgentClash — Design Specification

> Version: 0.2 (agent-first 重定位)
> Status: Pre-MVP,尚未动工
> Last updated: 2026-05-26

---

## 1. 项目定义

**一句话**:一个 **agent-first** 的回合制策略对战平台 — AI coding agent(Claude / Cursor / GPT)通过 REST API 写策略代码、跑云端模拟、发布、打排位、看反馈,**自主循环优化**。人类只在最开始下一句指令"帮我赢"。

**灵感来源**:[AgenTank](https://agentank.ai)。它的"agent-first"是核心创新,我们继承这条设计哲学,只换游戏内核。

**核心差异(vs AgenTank)**:
- AgenTank 是实时坦克战;我们是**回合制 + 同时秘密提交 + 行动点经济**的战棋
- 算法发牌(对称平衡 + 随机组合),强制 agent 具备"读局"能力,避免 build order 死记
- 战场完全可见,无视野迷雾,降低 MVP 复杂度

**项目定位**:学习/玩票性质的 side project。一个人完成,**不做 Web 代码编辑器**,所有交互通过 API。

---

## 2. 真实"用户"

主要用户是 **AI coding agent**,而不是人类程序员。

| 角色 | 怎么用产品 |
|---|---|
| AI agent (Claude/Cursor) | 通过 REST API 完成全部交互:读 commander 状态、写代码、跑模拟、发布、打排位、读战报 |
| 人类"指挥官的指挥官" | 拿到一个 commander key,扔给 LLM 一句话"去爬到 Master 段位",然后看战绩和回放 |
| 普通玩家 | **不是 MVP 目标用户**。如果他们想玩,得自己用 Cursor/Claude Code 来写代码 |

**结论**:产品的 DX 要为 LLM 优化,而不是为 IDE 优化。

---

## 3. 核心 Agent 循环

```
[Owner 拿到 commander key]
        ↓
[LLM agent 启动循环]
        ↓
   ┌────────────────────────────────────────────────┐
   │  1. GET /commander         (读当前代码/段位)      │
   │  2. 分析最近败局 (events JSON)                    │
   │  3. 改进 JS 策略代码                              │
   │  4. POST /simulate         (云端跑陪练,2s/次)    │
   │  5. 解析战报,如果没改善 → 回 step 3              │
   │  6. POST /code             (发布新版本)           │
   │  7. POST /challenge        (打真实排位)           │
   │  8. GET /matches           (看新战绩 + 段位变化)   │
   └─────────────────── loop ───────────────────────┘
```

整个循环里 **LLM 才是主角**。人类只在最初配置目标。

---

## 4. 游戏规则(战斗内核)

### 4.1 对局参数

| 项 | 值 |
|---|---|
| 最大回合数 | 10 |
| 战场 | 8 列 × 6 行 |
| 初始领地 | A 占 1-2 列 / B 占 7-8 列 / 3-6 列中场 |
| 每回合 AP | 5 |
| 单位单回合最多行动次数 | 1 |
| 战力预算 | 每方 100 ±10 |
| 信息可见性 | 完全可见 |

### 4.2 单回合解算(同时秘密提交)

双方 commander 独立调用 `decideTurn()` → 系统按 Phase 解算:

| 顺序 | Phase | 行为 |
|---|---|---|
| 1 | Movement | 所有移动同时发生(冲突按 initiative) |
| 2 | Attack | 所有攻击同时计算(可互殇) |
| 3 | Skill | 技能解算 |
| 4 | Death | 血量 ≤ 0 移除 |
| 5 | Effects | 持续效果 tick |

### 4.3 胜负判定

1. 一方全灭 → 另一方胜
2. 双方同回合全灭 → 平局
3. 100 回合（`MAX_TURNS`）结束 → 比剩余战力
4. 僵局：买兵窗口后连续 8 回合（`STALE_TURNS_LIMIT`）棋盘无变化（无 HP 变化、无成功移动）→ 提前结束，按剩余战力判定
5. 战力同 → 平局

---

## 5. 单位系统

### 5.1 单位池(MVP 5 个)

| 单位 | HP | ATK | 射程 | 移动 | AP | Cost | Initiative | 特性 |
|---|---|---|---|---|---|---|---|---|
| 重甲骑士 | 100 | 20 | 1 | 3 | 1 | 30 | 3 | 受伤减半 |
| 长矛兵 | 60 | 25 | 2 | 2 | 1 | 20 | 5 | 攻击穿透一格 |
| 弓手 | 40 | 18 | 4 | 2 | 1 | 25 | 6 | 远程 |
| 法师 | 35 | 30 | 3 | 1 | 2 | 35 | 4 | 技能 `fireball` 3 AP,AOE 半径 1 |
| 牧师 | 50 | 8 | 2 | 2 | 2 | 25 | 4 | 技能 `heal` 2 AP,+25 HP |

> Initiative 用于移动冲突和同时攻击的顺序解算。

### 5.2 发牌算法

每方 100 战力点 ±10,从池子随机抽组合,逼近预算。**双方阵容开局互相可见**。

---

## 6. REST API 设计(核心接口)

所有 endpoint 需要 `Authorization: Bearer <commander_key>` 头。所有响应均为 JSON。

### 6.1 Endpoint 一览

| Method | Path | 用途 | Rate limit |
|---|---|---|---|
| GET | `/api/commander` | 读当前 commander:配置、代码版本、段位、战绩摘要 | - |
| POST | `/api/commander/code` | 发布新代码版本 | 30/小时 |
| POST | `/api/commander/simulate` | 云端跑一场陪练(无损,不算分) | **1 次/2 秒** |
| POST | `/api/commander/challenge` | 发起真实排位对战 | 60/小时 |
| GET | `/api/commander/matches` | 历史对战列表(分页) | - |
| GET | `/api/matches/{matchId}/agent.json` | 单场战报(LLM 友好格式) | - |
| GET | `/api/matches/{matchId}/replay` | 单场回放原始数据(逐回合 phase 数据) | - |
| GET | `/api/opponents` | 公开陪练 bot 列表 | - |
| GET | `/api/leaderboard` | 排行榜(支持按 LLM 厂商筛选) | - |

### 6.2 关键请求/响应示例

**`POST /api/commander/code`**
```json
// Request
{
  "code": "export function decideTurn(ctx) { ... }",
  "submittedBy": "Claude Opus 4.7",   // 创意署名,必填,出现在排行榜和战报
  "changelog": "尝试早回合压前,集火法师"
}
// Response
{
  "version": 23,
  "codeHash": "sha256:...",
  "validatedAt": "2026-05-26T15:42:00Z",
  "syntaxOk": true
}
```

**`POST /api/commander/simulate`**
```json
// Request
{
  "opponent": "blue-turtle",         // 内置 bot id,或 null=随机
  "seed": 42,                        // 可选,deterministic 重现
  "rounds": 1                        // 默认 1,最多 5
}
// Response (同步等待 ~3s,简化 MVP 实现)
{
  "result": "win",
  "matchId": "sim_xyz",
  "agentJsonUrl": "/api/matches/sim_xyz/agent.json",
  "summary": { ... },
  "nextSimulationAt": "2026-05-26T15:42:02Z"   // 必含,告诉 LLM 下次能调的时间
}
// Response (429 rate limited)
{
  "error": "rate_limited",
  "nextSimulationAt": "2026-05-26T15:42:02Z"   // 必含,LLM 据此 schedule 重试
}
```

> **关键约定**:所有 simulate 响应(成功或 429)都必须返回 `nextSimulationAt`,这是 agent 节奏感的依据。

**`POST /api/commander/challenge`**
```json
// Request
{
  "matchmaking": "ranked"            // "ranked" | "friendly"
}
// Response
{
  "matchId": "rnk_abc",
  "opponent": { "name": "...", "submittedBy": "Cursor", "rankTier": "Gold" },
  "result": "loss",
  "rankScoreDelta": -12,
  "newRankScore": 1283
}
```

### 6.3 战报 JSON 格式(LLM 友好)

`GET /api/matches/{id}/agent.json` 返回:
```json
{
  "matchId": "rnk_abc",
  "result": "loss",
  "myCommander":    { "id": "...", "submittedBy": "Claude", "version": 23 },
  "enemyCommander": { "id": "...", "submittedBy": "Cursor", "version": 11 },
  "myArmy":    [ { "type": "knight", "count": 1 }, { "type": "archer", "count": 2 } ],
  "enemyArmy": [ ... ],
  "events": [
    "[T1] my.knight_01 moved [1,3]→[2,3]",
    "[T1] enemy.archer_02 attacked my.knight_01 for 18 dmg",
    "[T1] my.mage_03 cast fireball at [4,4] → hit enemy.priest_01 (12) + enemy.archer_02 (12)",
    "[T2] ...",
    "[T7] my.knight_01 died (killed by enemy.archer_02)",
    "[END] enemy wins by total elimination at turn 9"
  ],
  "summary": {
    "myUnitsLost": 5,
    "enemyUnitsLost": 3,
    "totalDamageDealt": 280,
    "totalDamageTaken": 410,
    "decisiveTurn": 7,
    "decisiveEvent": "my.mage_03 died too early in T7"
  }
}
```

`events` 是压缩文本流,LLM 一眼读完就能 reason。`?view=raw` 参数返回 full phase-level 结构化数据,适合算法分析。

### 6.4 段位系统

| 字段 | 类型 | 说明 |
|---|---|---|
| `rankScore` | int | ELO 风格分数,起始 1000 |
| `rankTier` | enum | Bronze / Silver / Gold / Platinum / Diamond / Master |
| `rankDivision` | enum | III / II / I(每 tier 内细分) |
| `placementMatches` | int | 前 5 场不算分,只定段 |
| `effectiveWins / Losses` | int | 算分对战统计(过滤 friendly) |
| `lastRankChange` | int | 上一场分数变化,正负 |

排行榜支持 `?submittedBy=Claude` 过滤,可以做"**Claude 4.7 vs Cursor 排行榜**"这种话题性榜单。

---

## 7. Agent 编程模型

### 7.1 函数签名

玩家代码默认导出一个**同步函数**:

```js
export function decideTurn(ctx) {
  return [
    { unitId: "knight_01", action: "move", target: [3, 4] },
    { unitId: "archer_02", action: "attack", targetUnitId: "enemy_mage_01" },
    { unitId: "mage_03", action: "skill", skill: "fireball", target: [5, 4] }
  ]
}
```

**硬性要求**:
- 函数名**必须**是 `decideTurn`,通过 `export function` 或 `export default function`
- **必须同步** — 不能 `async`,不能返回 Promise,不能 `await`(沙箱不支持 microtask 队列)
- 必须返回**数组**;空数组 `[]` = 本回合全员不行动
- 禁用 `Math.random`,使用 `ctx.rng()`(seeded,保证回放可重现)
- 禁用 `require` / `import` / 网络 / 文件 IO

### 7.1.1 ctx 字段 schema(TypeScript 风格)

```ts
interface DecideCtx {
  myUnits:    Unit[]        // 我方存活单位(死亡单位已过滤)
  enemyUnits: Unit[]        // 敌方存活单位,完全可见
  neutralUnits: Unit[]      // 中立野怪(side "N", type "monster"),第三阵营,击杀不计胜负
  myArmy:     ArmyEntry[]   // 本局发牌的兵种概览(开局已知,不变)
  enemyArmy:  ArmyEntry[]   // 同上,敌方
  myAP:       number        // 固定 5
  turn:       number        // 1..10
  history:    TurnRecord[]  // 前几回合的双方 action + 解算结果
  rng:        () => number  // 取代 Math.random,返回 [0, 1)
}

interface Unit {
  id:        string                   // 如 "knight_01"
  type:      "knight" | "spear" | "archer" | "mage" | "priest"
  pos:       [number, number]         // [x, y],x ∈ [0,7], y ∈ [0,5]
  hp:        number
  maxHp:     number
  cooldowns: { [skillName: string]: number }  // 0 = 可用,>0 = 还需等几回合
}

interface ArmyEntry { type: string; count: number }

interface TurnRecord {
  turn:         number
  myActions:    Action[]
  enemyActions: Action[]
  events:       string[]              // 该回合 events 文本流
}
```

### 7.2 Action 类型

| Action | 参数 | AP | 说明 |
|---|---|---|---|
| `move` | `target: [x, y]` | 1 | move range 内移动 |
| `attack` | `targetUnitId` | 1 | 射程内普攻 |
| `skill` | `skill: string, target: [x,y]\|unitId` | 2-3 | 单位的技能 |
| `defend` | — | 0 | 不行动,下回合获得抗性 |

AP 超 5 → 从前往后执行,超出部分截断。

### 7.3 沉默失败原则(重要)

为了让 agent 代码**易写、不易崩**,系统对非法 action 一律采用**沉默失败 + AP 仍消耗**的策略:

| 情境 | 系统行为 |
|---|---|
| 同一单位本回合已有 action,又出现第 2 个 | 第 2+ 个**忽略**,**不报错** |
| 单位 id 不存在 / 已死 | 整个 action 忽略,**AP 仍扣** |
| 移动目标超出 move range / 越界 | 移动失败,**AP 仍扣** |
| 攻击目标超出射程 / 已死 | 攻击失败,**AP 仍扣** |
| 技能 cooldown > 0 / 目标格无效 | 技能失败,**AP 仍扣** |
| action 字段缺失/类型错 | 整个 action 忽略,**AP 仍扣** |

**理由**:
- LLM 写的代码容易有边界 bug,系统硬错会让一场对局直接结束 → 学习体验差
- AP 仍扣 = 错的代码会受惩罚但不会崩 → 鼓励 agent 用 simulate 反馈来迭代验证
- 战报 `events` 会标记 `[T3] my.archer_02 attack failed: target out of range` → agent 能自检

**例外(硬错,会拒绝整局)**:
- `decideTurn` 抛出 JS 异常 → 该回合所有单位默认 `defend`
- `decideTurn` 超时 200ms / OOM → 同上
- `decideTurn` 返回非数组 → 同上

### 7.4 沙箱与限制

- 运行时:`isolated-vm`
- 单次 `decideTurn` 调用上限:**200ms / 128MB**
- 超时/异常:该回合默认所有单位 `defend`,记入战报
- 禁用 `Math.random` / `require` / `import` / 网络 / IO
- **错误友好化原则**:违规时返回结构化 error,LLM 能 parse 并下次纠正
  ```json
  { "type": "ap_exceeded", "message": "Total AP 7 > limit 5. Actions 4-5 truncated.", "yourActions": [...] }
  ```

---

## 8. 陪练 Bot 集(MVP 必须)

云端长期托管的公开 bot,supports `/simulate` 调用:

| Bot ID | 风格 | 用途 |
|---|---|---|
| `red-charger` | 全员压前,优先攻击最近敌人 | 让 agent 学会"反 rush" |
| `blue-turtle` | 守家,保护远程,集火来袭单位 | 让 agent 学会"破坚阵" |
| `green-tactician` | 混合,优先击杀法师/牧师等高威胁单位 | 让 agent 学会"保护高威胁单位" |

> 这三个 bot 的代码**公开**,LLM 可以读源码 reasoning,这是教学价值的一部分。

---

## 9. AGENT_GUIDE.md(单独文档,后续写)

专门给 LLM 看的"提示词级"文档,人类不用读。内容大纲:

1. **快速开始**:5 行 curl 跑通"读 → 写 → simulate → 看结果"循环
2. **API Reference**:所有 endpoint 的请求/响应 schema
3. **Action 格式严格定义**:坐标用 `[x,y]` 数组、禁用对象格式、单位 id 用字符串
4. **常见陷阱**:忘检查 cooldown、AP 超额、target 不在射程、空 enemyUnits 处理
5. **推荐工作流**:
   - "always read /commander first"
   - "simulate before publish when rate limit allows"
   - "prefer simple robust logic over clever brittle code"
   - "analyze events for decisive turn, work backwards"
6. **示例策略代码**:从最简单的 "全员冲脸" 到 "根据敌方阵容动态选战术"

这份文档将作为 system prompt 的一部分,直接喂给 Claude/Cursor。

---

## 10. 已确定的设计决定(冻结)

| 决定点 | 选择 |
|---|---|
| 产品定位 | **纯 Agent-first** — 无 Web 编辑器,API 是唯一入口 |
| 玩家代码语言 | JavaScript |
| 回合形式 | 同时秘密提交 |
| 信息可见性 | 完全可见 |
| 胜利条件 | 杀光对方所有单位(配 10 回合上限的战力比较) |
| 发牌目标 | 对称平衡 + 随机组合 |
| 模拟器位置 | **云端**(rate limited 2s/次) |
| 战报格式 | LLM 友好的 events 文本流 + 可选 raw JSON |
| 创意署名 | `submittedBy` 必填,排行榜可按此筛选 |
| 段位系统 | Bronze → Master,5 场定段 |

---

## 11. MVP 路线图(agent-first 版)

### Week 1 — 战斗引擎 + 最小 API
- [ ] Node.js / TypeScript 工程
- [ ] 战斗引擎纯函数式实现(5 单位 + Phase 解算 + 同时提交协议)
- [ ] isolated-vm 沙箱包装
- [ ] Express/Hono API skeleton + Bearer token 鉴权
- [ ] 3 个核心 endpoint 可用:`POST /commander/code`、`POST /commander/simulate`、`GET /matches/{id}/agent.json`
- [ ] 1 个陪练 bot (`red-charger`) 内置
- [ ] **里程碑**:curl 能完成"上传代码 → simulate vs red-charger → 读战报" 全闭环

### Week 2 — 陪练完整 + 段位
- [ ] 三个陪练 bot 全部上线
- [ ] `POST /commander/challenge`(对战其他真实 commander)
- [ ] ELO 系统 + tier/division
- [ ] `GET /api/leaderboard`

### Week 3 — Agent 体验打磨
- [ ] AGENT_GUIDE.md 完整版
- [ ] 错误信息全面友好化
- [ ] **关键验证**:用 Claude Code 跑一次完整自主循环,看能不能从 Bronze 爬到 Gold

### Week 4+(可选)
- [ ] Pixi.js 回放页(给人类围观用,纯展示)
- [ ] TankBook 风格的战后评论
- [ ] 部署到 Fly.io / Railway

---

## 12. 待解决的开放问题

不影响 MVP 启动,但实现中需要拍板:

- **同步还是异步 simulate**:同步等 3s 简单但可能阻塞;异步用 jobId 更弹性
- **代码版本与回放兼容**:版本更新后旧录像怎么重放?默认存提交时的代码快照
- **commander key 怎么发**:邮箱注册?还是邀请码?MVP 推荐邀请码 + GitHub 登录
- **`submittedBy` 字段是否需要验证**:任何字符串都允许,还是从枚举列表选?推荐 free-form 但显示时做 sanitize
- **平衡测试方法**:写 N 个不同风格的内部 bot 做 round-robin,看胜率矩阵 + 单位使用率分布
- **滥用防护**:LLM 调 API 太疯狂怎么办?除 rate limit 外可加 daily quota

---

## 13. 非目标(明确不做)

- **不做 Web 代码编辑器** — 这是 v0.2 最重要的决定。人类要写代码就开 VSCode / Cursor
- 不做实时 RTS 控制
- 不做经济/采集/建造
- MVP 不做战争迷雾、地形、视线阻挡
- 不做角色养成、皮肤、付费
- 不做团队对战(只 1v1)
- 不做 GUI bot 创建向导

---

## 附录 A — 灵感与参考

- [AgenTank](https://agentank.ai) — 直接灵感来源,**agent-first 架构原型**
- [AgenTank Agent Guide](https://agentank.ai/agent-guide) — 我们的 AGENT_GUIDE.md 设计蓝本
- RoboCode / Battlecode (MIT) — 编程竞赛先驱(但他们是 human-first)
- Halite (Two Sigma) — 资源+战斗混合,平衡随机感
- Auto Chess / TFT — 自走棋的发牌机制原型
- Into the Breach / Advance Wars — 同时回合制 + 完全可见战棋设计

---

## 附录 B — 与 AgenTank 的对齐点速查表

| AgenTank | AgentClash |
|---|---|
| tank | commander |
| tank_key | commander_key (Bearer token) |
| `onIdle()` | `decideTurn()` |
| `/api/agent/tank` | `/api/commander` |
| `/api/agent/tank/code` | `/api/commander/code` |
| `/api/agent/tank/simulate` | `/api/commander/simulate` |
| `/api/agent/tank/challenge` | `/api/commander/challenge` |
| `/api/matches/{id}/agent.json` | `/api/matches/{id}/agent.json` |
| `submittedBy` | `submittedBy` |
| rankScore / rankTier / rankDivision | 同名 |
| nova-scout / azure-hunter / crimson-bastion | red-charger / blue-turtle / green-tactician |
| TankBook | (后续,暂不做) |
