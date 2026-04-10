/**
 * CLI eval runner — evaluates golden test cases against traces in the database.
 *
 * Usage:
 *   node scripts/eval.mjs [testcase-file] [--limit N] [--agent-id ID]
 *
 * Default testcase file: data/golden-testcases.json
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateBatch,
  formatEvalReport,
} from "../packages/core/dist/index.js";
import { initDatabase, SQLiteMemoryStore } from "../packages/memory/dist/index.js";

const args = process.argv.slice(2);

// Parse args
let testCaseFile = "data/golden-testcases.json";
let limit = 200;
let agentId;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--limit" && args[i + 1]) {
    limit = parseInt(args[++i], 10);
  } else if (args[i] === "--agent-id" && args[i + 1]) {
    agentId = args[++i];
  } else if (!args[i].startsWith("--")) {
    testCaseFile = args[i];
  }
}

// Load test cases
const filePath = resolve(process.cwd(), testCaseFile);
const testCases = JSON.parse(readFileSync(filePath, "utf-8"));

console.log(`Loaded ${testCases.length} test cases from ${filePath}`);

// Open database
const dbPath = resolve(process.cwd(), "data", "agentclaw.db");
const db = initDatabase(dbPath);
const store = new SQLiteMemoryStore(db);

// Fetch traces
const { items: traces, total } = await store.getTraces(limit, 0, agentId);
console.log(`Fetched ${traces.length} traces (total in DB: ${total})`);

if (traces.length === 0) {
  console.log(
    "\nNo traces found. Run some conversations first, then re-run eval.",
  );
  process.exit(0);
}

// Evaluate
const report = evaluateBatch(testCases, traces);

// Print report
console.log(formatEvalReport(report));

// Exit with code 1 if any failures
process.exit(report.failed > 0 ? 1 : 0);
