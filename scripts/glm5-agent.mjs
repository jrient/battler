#!/usr/bin/env node
// GLM-5 Agent Loop for AgentClash
// Reads battle reports, generates strategy code, simulates, iterates.

import fs from "fs";

const AC_BASE = process.env.AC_BASE || "https://battler.al.jrient.cn";
const AC_KEY = process.env.AC_KEY;
const LLM_BASE = process.env.LLM_BASE || "https://coding.dashscope.aliyuncs.com/v1";
const LLM_KEY = process.env.LLM_KEY;
const LLM_MODEL = process.env.LLM_MODEL || "glm-5";
const MAX_ITERATIONS = parseInt(process.env.MAX_ITERATIONS || "8", 10);
const SIM_COOLDOWN_MS = 2500;

if (!AC_KEY || !LLM_KEY) {
  console.error("Set AC_KEY and LLM_KEY env vars");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${AC_KEY}`,
  "Content-Type": "application/json",
};

async function api(method, path, body) {
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${AC_BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw { status: res.status, ...data };
  return data;
}

async function llmChat(systemPrompt, userPrompt) {
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LLM_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 4096,
    }),
  });
  const data = await res.json();
  if (data.error) throw data.error;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("No content in LLM response");
  return content;
}

function extractCode(text) {
  // Try to find code in ```js ... ``` or ```javascript ... ``` blocks
  const match = text.match(/```(?:js|javascript)?\s*\n([\s\S]*?)```/);
  if (match) return match[1].trim();
  // Fallback: look for export function decideTurn
  const start = text.indexOf("export function decideTurn");
  if (start === -1) return null;
  let depth = 0;
  let i = start;
  let foundOpen = false;
  for (; i < text.length; i++) {
    if (text[i] === "{") { depth++; foundOpen = true; }
    if (text[i] === "}") depth--;
    if (foundOpen && depth === 0) break;
  }
  // Also grab helper functions before decideTurn
  const before = text.substring(0, start).trim();
  const main = text.substring(start, i + 1).trim();
  return before ? `${before}\n\n${main}` : main;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getCurrentCode() {
  try {
    const store = JSON.parse(fs.readFileSync("./data/store.json", "utf-8"));
    const cmd = Object.values(store.commanders)[0];
    return cmd?.code || "";
  } catch {
    return "";
  }
}

function getBaselineCode() {
  try {
    return fs.readFileSync("./scripts/smart-tactician.js", "utf-8");
  } catch {
    return "";
  }
}

async function run() {
  console.log("=== GLM-5 AgentClash Loop ===");
  console.log(`Server: ${AC_BASE}`);
  console.log(`LLM: ${LLM_MODEL} @ ${LLM_BASE}`);
  console.log(`Max iterations: ${MAX_ITERATIONS}`);
  console.log();

  // Step 0: Read AGENT_GUIDE and bot code as context
  const agentGuide = fs.readFileSync("./AGENT_GUIDE.md", "utf-8");
  let botCode = "";
  try {
    botCode = fs.readFileSync("./src/bots/red-charger.js", "utf-8");
  } catch {}

  const systemPrompt = `You are an expert AI game strategist playing AgentClash, a turn-based tactical battle game.
Your task is to write a JavaScript function called decideTurn(ctx) that controls your army each turn.

KEY RULES:
- You write a single JS function: export function decideTurn(ctx) { ... return actions; }
- Each turn you have 5 AP (action points). Actions: move(1AP), attack(1AP), skill(2-3AP), defend(0AP)
- Each unit can only perform ONE action per turn
- Board is 8x6, fully visible, 10 turns max
- Victory: eliminate all enemy units or have higher remaining HP

UNIT STATS (memorize these):
| Unit | HP | ATK | Range | Move | Cost | Special |
|------|-----|-----|-------|------|------|---------|
| knight | 100 | 20 | 1 | 3 | 30 | Takes half damage |
| spear | 60 | 25 | 2 | 2 | 20 | Pierce: hits target + unit behind |
| archer | 40 | 18 | 4 | 2 | 25 | Long range |
| mage | 35 | 30 | 3 | 1 | 35 | fireball skill: 3AP, AoE radius 1, 25 dmg |
| priest | 50 | 8 | 2 | 2 | 25 | heal skill: 2AP, +25 HP to ally |

CRITICAL:
- Use ctx.rng() not Math.random()
- Unit positions are ARRAYS: u.pos[0] = x, u.pos[1] = y. NEVER use u.x or u.y!
- Movement target format: [x, y] array, NOT {x, y} object
- Movement target must be within move range (manhattan distance)
- Attack target must be within attack range
- Check cooldowns before using skills
- Total AP of all actions must not exceed 5
- Return an array of action objects
- Synchronous function only (no async/await)

Respond with ONLY the code inside a \`\`\`js block. No explanations outside the code block.`;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`\n--- Iteration ${i + 1}/${MAX_ITERATIONS} ---`);

    try {
      // 1. Get current commander state
      const cmdr = await api("GET", "/api/commander");
      console.log(
        `Current: v${cmdr.currentVersion}, Rank: ${cmdr.rank?.tier || "?"} ${cmdr.rank?.division || ""} (${cmdr.rank?.score || "?"} pts)`
      );

      // 2. Check recent matches for losses
      let battleContext = "";
      if (cmdr.recentMatches?.length > 0) {
        const losses = cmdr.recentMatches.filter((m) => m.result === "loss");
        if (losses.length > 0) {
          console.log(`Found ${losses.length} recent loss(es), reading reports...`);
          for (const loss of losses.slice(0, 2)) {
            try {
              const report = await api("GET", `/api/matches/${loss.matchId}/agent.json`);
              const events = (report.events || []).slice(0, 20).join("\n");
              battleContext += `\n\nRECENT LOSS vs ${loss.opponent || "bot"}:\nResult: ${report.result}\nMy Army: ${JSON.stringify(report.myArmy)}\nEnemy Army: ${JSON.stringify(report.enemyArmy)}\nKey Events:\n${events}\nSummary: ${JSON.stringify(report.summary)}`;
            } catch (e) {
              console.log("  Could not read match report:", e.message || e);
            }
          }
        }
      }

      // 3. Build prompt for LLM
      let userPrompt = "";
      if (i === 0) {
        // First iteration: start from baseline code with bot reference
        const currentCode = getBaselineCode();
        userPrompt = `Here is the current working strategy code. Copy it EXACTLY and apply ONE tiny change:\n\n\`\`\`js\n${currentCode}\n\`\`\`\n\nPick ONE of these changes (they are just number/condition tweaks, not structural changes):\n\nA) Change THREAT priority: mage:10 → mage:12, archer:7 → archer:9\nB) Change priest heal threshold: maxHp * 0.7 → maxHp * 0.5\nC) Change archer: add "prefer lowest-HP enemy in range" before falling back to highest-threat\nD) Change mage fireball: also cast on single enemy if that enemy has <= 15 HP\nE) Change knight: on turn 1, always move toward center instead of toward specific enemy\n\nCopy the ENTIRE code above, apply your chosen change (just modify 1-2 lines), and output the full code.\n\nOutput ONLY the complete code in a \`\`\`js block.`;
      } else {
        // Later iterations: improve based on battle reports
        const currentCode = getBaselineCode();
        userPrompt = `Here is your current strategy code. Copy it EXACTLY and apply ONE tiny change:\n\n\`\`\`js\n${currentCode}\n\`\`\`\n${battleContext}\n\nBased on the battle reports, pick ONE tiny number/condition change:\n\nA) If mage dies early: change mage movement to stay 1 step further from enemies\nB) If archers ineffective: change archer to skip attacking knights, only attack mage/archer/priest\nC) If priest wastes heals: change heal threshold from 0.7 to 0.4\nD) If units too slow: increase knight move priority on turns 1-2\nE) If losing by strength: change spear to prefer targets with allies behind for pierce bonus\n\nCopy the ENTIRE code above, modify 1-2 lines for your chosen change, output the full code.\n\nOutput ONLY the complete code in a \`\`\`js block.`;
      }

      // 4. Generate code with LLM
      console.log("Generating strategy with GLM-5...");
      const llmResponse = await llmChat(systemPrompt, userPrompt);
      const newCode = extractCode(llmResponse);

      if (!newCode || !newCode.includes("decideTurn")) {
        console.log("LLM did not produce valid code, skipping iteration.");
        console.log("Raw response:", llmResponse.substring(0, 200));
        continue;
      }

      console.log(`Generated code (${newCode.length} chars)`);

      // 5. Save old code BEFORE publishing, then publish new code for testing
      let publishedVersion = null;
      const oldCode = getCurrentCode(); // read BEFORE publishing
      try {
        const pubResult = await api("POST", "/api/commander/code", {
          code: newCode,
          submittedBy: "GLM-5",
          changelog: `iter${i + 1}: testing...`,
        });
        publishedVersion = pubResult.version;
        console.log(`Published test version v${publishedVersion}`);
      } catch (e) {
        if (e.error === "syntax_error") {
          console.log("Syntax error in generated code:", e.message);
          continue;
        }
        throw e;
      }

      // 6. Validate with FIXED seeds for deterministic comparison
      const SEEDS = [42, 100, 200, 300, 400, 500, 600, 700, 800, 900];
      const MIN_WINS = 7; // baseline is 6/10, need to beat it
      let simWins = 0;
      let simLosses = 0;
      for (let s = 0; s < SEEDS.length; s++) {
        console.log(`Simulating vs red-charger (seed=${SEEDS[s]}, ${s + 1}/${SEEDS.length})...`);
        try {
          const sim = await api("POST", "/api/commander/simulate", { opponent: "red-charger", seed: SEEDS[s] });
          if (sim.result === "win") simWins++; else simLosses++;
          console.log(`  ${sim.result} (${sim.summary?.totalTurns || "?"}t, my=${sim.summary?.myUnitsRemaining} enemy=${sim.summary?.enemyUnitsRemaining})`);
        } catch (e) {
          if (e.status === 429) {
            console.log("  Rate limited, waiting...");
            await sleep(SIM_COOLDOWN_MS);
            s--; // retry this seed
            continue;
          }
          throw e;
        }
        if (s < SEEDS.length - 1) await sleep(SIM_COOLDOWN_MS);
      }
      const simWin = simWins >= MIN_WINS;
      console.log(`Sim results: ${simWins}W/${simLosses}L (need ${MIN_WINS}/${SEEDS.length} to keep, baseline=6/10)`);

      // 7. If not good enough, rollback to baseline code
      if (simWin) {
        console.log(`v${publishedVersion} PASSES — keeping new code!`);
      } else {
        console.log(`v${publishedVersion} FAILS — rolling back to baseline...`);
        const baselineCode = getBaselineCode();
        console.log(`Baseline code length: ${baselineCode.length}`);
        if (!baselineCode) {
          console.log("ERROR: baseline code is empty! Manual revert needed.");
        } else {
          try {
            const rollback = await api("POST", "/api/commander/code", {
              code: baselineCode,
              submittedBy: "smart-tactician",
              changelog: `rollback: iter${i + 1} failed (${simWins}/${SEEDS.length})`,
            });
            console.log(`Rolled back to v${rollback.version}`);
          } catch (e) {
            console.log("Rollback error:", JSON.stringify(e));
          }
        }
      }

      // Cooldown before next iteration
      await sleep(SIM_COOLDOWN_MS);
    } catch (err) {
      console.error("Iteration error:", err.message || err);
      await sleep(3000);
    }
  }

  // Final status
  console.log("\n=== Final Status ===");
  try {
    const final = await api("GET", "/api/commander");
    console.log(
      `Version: ${final.currentVersion}, Rank: ${final.rank?.tier} ${final.rank?.division} (${final.rank?.score} pts)`
    );
    console.log(`W/L: ${final.rank?.effectiveWins || 0}/${final.rank?.effectiveLosses || 0}`);
  } catch {}
}

run().catch(console.error);
