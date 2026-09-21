import { loadReactionJournal, REACTION_JOURNAL_PATH } from "../state/reactionJournal.js";

const HELP = `Usage:
  npm run reaction-journal -- inspect <dwellingId>

Read-only inspection of data/reaction-journal.jsonl.`;

async function main(): Promise<void> {
  const action = process.argv[2];
  const dwellingId = process.argv[3]?.trim();
  if (action === "--help" || action === "-h") return void console.log(HELP);
  if (action !== "inspect" || !dwellingId || !/^\d+$/.test(dwellingId) || process.argv.length > 4) {
    throw new Error(HELP);
  }
  const events = (await loadReactionJournal(REACTION_JOURNAL_PATH))
    .filter((event) => event.dwellingId === dwellingId);
  console.log(`REACTION JOURNAL — #${dwellingId}`);
  if (events.length === 0) console.log("No journal entries.");
  for (const event of events) console.log(JSON.stringify(event));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
