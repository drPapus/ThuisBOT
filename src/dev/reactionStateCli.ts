import {
  findReactionRecord,
  loadReactionState,
  REACTION_STATE_PATH,
  removeReactionRecord,
  saveReactionState,
} from "../state/reactionState.js";

const HELP = `DEV ONLY — automatic reaction dedup state

Usage:
  npm run reaction-state -- inspect <dwellingId>
  npm run reaction-state -- reset <dwellingId>

This command only accesses data/reaction-state.json.
It never accesses known-woningen.json, authentication state, or Thuispoort.`;

async function main(): Promise<void> {
  const action = process.argv[2];
  const dwellingId = process.argv[3]?.trim();
  if (action === "--help" || action === "-h") {
    console.log(HELP);
    return;
  }
  if (!dwellingId || !/^\d+$/.test(dwellingId) || process.argv.length > 4) {
    throw new Error(HELP);
  }

  console.log("DEV ONLY — automatic reaction dedup state");
  const state = await loadReactionState(REACTION_STATE_PATH);
  const record = findReactionRecord(state, dwellingId);
  if (action === "inspect") {
    console.log(record ? JSON.stringify(record, null, 2) : `No record for #${dwellingId}`);
    return;
  }
  if (action === "reset") {
    if (!record) {
      console.log(`No record for #${dwellingId}; nothing changed.`);
      return;
    }
    await saveReactionState(removeReactionRecord(state, dwellingId), REACTION_STATE_PATH);
    console.log(`Reset automatic reaction state for #${dwellingId} only.`);
    console.log("known-woningen.json and authentication state were not modified.");
    return;
  }
  throw new Error(HELP);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
