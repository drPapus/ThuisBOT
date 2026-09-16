import type { NormalizedWoning } from "../woningen/types.js";
import { logger } from "../utils/logger.js";

function yesNo(value: boolean): "YES" | "NO" {
  return value ? "YES" : "NO";
}

export function reportEligible(woningen: NormalizedWoning[]): void {
  for (const woning of woningen) {
    logger.info(`NEW: #${woning.id}`);
    const houseNumber = [woning.houseNumber, woning.houseNumberAddition].filter(Boolean).join("");
    console.log(`Address: ${[woning.street, houseNumber].filter(Boolean).join(" ") || "Unknown"}`);
    console.log(`City: ${woning.city ?? "Unknown"}`);
    console.log(`Model: ${woning.modelCode ?? "Unknown"}`);
    console.log(`Passend: ${yesNo(woning.isPassend)}`);
    console.log(`Can react: ${yesNo(woning.kanReageren)}`);
    console.log("\nDRY RUN → WOULD REACT\n");
  }
}

export function reportSummary(checked: number, eligible: number): void {
  console.log("SCAN COMPLETE\n");
  console.log(`${checked} checked`);
  console.log(`${eligible} eligible`);
  console.log("0 reactions sent");
}
