#!/usr/bin/env node
/**
 * Minimal CLI runner for executing an already-created simulation run directly
 * outside the serverless HTTP timeout boundary.
 *
 * Reuses the existing runAllRecovery implementation without duplicating logic.
 *
 * Usage:
 *   node scripts/run-recovery-cli.js <runId>
 */

import 'dotenv/config';
import { runAllRecovery } from '../src/recovery/recoveryRunner.js';

async function main() {
  const runId = process.argv[2]?.trim();

  if (!runId) {
    console.error('Error: runId argument is required.');
    console.error('Usage: node scripts/run-recovery-cli.js <runId>');
    process.exit(1);
  }

  console.log(`[CLI] Starting recovery runner for simulation run: ${runId}`);
  const startTime = Date.now();

  try {
    const result = await runAllRecovery({ runId });
    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log(`[CLI] Recovery execution COMPLETED in ${elapsedSeconds}s.`);
    console.log(JSON.stringify({
      status: 'SUCCESS',
      runId: result.runId,
      processedCount: result.processedCount,
      daysEvaluated: result.daysEvaluated,
      finalDay: result.finalDay,
      terminatedReason: result.terminatedReason,
      elapsedSeconds: Number(elapsedSeconds),
    }, null, 2));

    process.exitCode = 0;
  } catch (err) {
    const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`[CLI] Recovery execution FAILED in ${elapsedSeconds}s: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
