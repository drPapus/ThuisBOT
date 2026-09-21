import { inspectReactionSafety } from "../reaction/reactionSafety.js";

async function main(): Promise<void> {
  if (process.argv.slice(2).length !== 1 || process.argv[2] !== "status") {
    throw new Error("Usage: npm run reaction-safety -- status");
  }
  const status = await inspectReactionSafety();
  console.log("LIVE SAFETY STATUS\n");
  console.log(`Circuit ............ ${status.circuitOpen ? "OPEN" : "CLOSED"}`);
  if (status.reason) console.log(`Reason ............. ${status.reason}`);
  if (status.dwellingId) console.log(`Dwelling ........... ${status.dwellingId}`);
  console.log(`Unresolved submits . ${status.unresolvedSubmits}`);
  console.log(`UNKNOWN records .... ${status.unknownRecords}`);
  console.log(`SUBMITTING records . ${status.submittingRecords}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
