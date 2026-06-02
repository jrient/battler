/**
 * Copyright (c) 2026 AgentClash. All rights reserved.
 * @license UNLICENSED
 */
import { nanoid } from "nanoid";
import { createCommander, listCommanders } from "../server/store.js";

const existing = listCommanders();
if (existing.length > 0) {
  console.log("# existing commanders:");
  for (const c of existing) {
    console.log(`  ${c.id}  (${c.displayName})  key=${c.commanderKey}`);
  }
  console.log("\n# nothing to do.");
  process.exit(0);
}

const id = "cmd_" + nanoid(8);
const key = "ack_" + nanoid(24);
const displayName = process.argv[2] ?? "Dev Commander";

const rec = createCommander({ id, commanderKey: key, displayName });
console.log("# seeded dev commander");
console.log(`  id           = ${rec.id}`);
console.log(`  displayName  = ${rec.displayName}`);
console.log(`  commanderKey = ${rec.commanderKey}`);
console.log("\n# export for curl:");
console.log(`  export AC_KEY=${rec.commanderKey}`);
console.log(`  export AC_BASE=http://localhost:8787`);
