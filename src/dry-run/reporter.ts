import type { NormalizedWoning } from "../woningen/types.js";
import { isEligible } from "../woningen/filter.js";
import { logger } from "../utils/logger.js";
import type { ScanSummary } from "../scanner/scanSummary.js";

function yesNo(value: boolean): "YES" | "NO" {
  return value ? "YES" : "NO";
}

export function reportNewWoningen(
  woningen: NormalizedWoning[],
  firstDetectedAt = "Unknown",
): void {
  for (const woning of woningen) {
    logger.info(`NEW: #${woning.id}`);
    console.log(`First detected: ${firstDetectedAt}`);
    const houseNumber = [woning.houseNumber, woning.houseNumberAddition].filter(Boolean).join("");
    console.log(`Address: ${[woning.street, houseNumber].filter(Boolean).join(" ") || "Unknown"}`);
    console.log(`City: ${woning.city ?? "Unknown"}`);
    console.log(`Model: ${woning.modelCode ?? "Unknown"}`);
    console.log(`Passend: ${yesNo(woning.isPassend)}`);
    console.log(`Can react: ${yesNo(woning.kanReageren)}`);

    if (isEligible(woning)) {
      console.log("\nNEW ELIGIBLE");
      console.log("DRY RUN → WOULD REACT\n");
    } else {
      console.log("\nNEW BUT NOT ELIGIBLE");
      console.log("SKIP\n");
    }
  }
}

function metric(label: string, value: number | string): void {
  console.log(`${label.padEnd(25, ".")} ${value}`);
}

export function reportSummary(summary: ScanSummary): void {
  logger.info("SCAN COMPLETE");
  console.log("");
  metric("Checked ", summary.checked);
  metric("New ", summary.newCount);
  metric("Eligible ", summary.eligible);
  metric("Not eligible ", summary.notEligible);
  console.log("");
  metric("Live attempts ", summary.liveAttempts);
  metric("Confirmed reactions ", summary.confirmedReactions);
  metric("Failed ", summary.failed);
  metric("Unknown ", summary.unknown);
  metric("Aborted ", summary.aborted);
  if (summary.dryRunPrepared > 0) metric("Dry-run prepared ", summary.dryRunPrepared);
  console.log("");
  metric("Dedup skipped ", summary.dedupSkipped);
  metric("Circuit blocked ", summary.circuitBlocked);
  metric("Run-limit blocked ", summary.runLimitBlocked);
  console.log("");
  metric("This scan attempts ", summary.liveAttempts);
  metric("Run live attempts ", `${summary.runLiveAttempts}/${summary.maxLiveAttempts}`);
  metric("Circuit ", summary.circuitOpen ? "OPEN" : "CLOSED");
  if (summary.circuitReason) metric("Circuit reason ", summary.circuitReason);
}
