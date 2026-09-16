import type { NormalizedWoning } from "../woningen/types.js";
import { isEligible } from "../woningen/filter.js";
import { logger } from "../utils/logger.js";

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

export function reportSummary(checked: number, newCount: number): void {
  logger.info("SCAN COMPLETE");
  console.log(`${checked} checked`);
  console.log(`${newCount} new`);
  console.log("0 reactions sent");
}
