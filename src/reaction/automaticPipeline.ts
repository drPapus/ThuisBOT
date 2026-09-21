import { prepareFreshReaction } from "./reactOnceFlow.js";
import { reactionEndpointForDisplay } from "./reporter.js";
import { logger } from "../utils/logger.js";
import type { ReactionPreparationDependencies } from "./liveTypes.js";
import type { PreparationFailureReason, PreparedReaction } from "./types.js";

export type AutomaticPreparationResult =
  | { status: "READY"; prepared: PreparedReaction; model?: string }
  | { status: "ABORTED"; reason: PreparationFailureReason; model?: string };

export async function runAutomaticPreparationPipeline(
  dwellingId: string,
  model: string | undefined,
  dependencies: ReactionPreparationDependencies,
  autoSubmit: false,
): Promise<AutomaticPreparationResult> {
  // The automatic pipeline deliberately has no submission dependency or branch.
  if (autoSubmit !== false) throw new Error("AUTO_SUBMIT=true is forbidden in Stage 5.2; ABORT");
  if (!(await dependencies.isPresentInAanbod(dwellingId))) {
    return {
      status: "ABORTED",
      reason: "MISSING_DWELLING_ID",
      ...(model && { model }),
    };
  }
  const result = await prepareFreshReaction(dwellingId, dependencies);
  if (!("ok" in result)) {
    if (result.status !== "PREPARATION_FAILED") {
      return { status: "ABORTED", reason: "UNEXPECTED_REACTION_STATE", ...(model && { model }) };
    }
    return { status: "ABORTED", reason: result.reason, ...(model && { model }) };
  }
  return { status: "READY", prepared: result.prepared, ...(model && { model }) };
}

export function formatAutomaticPreparationReport(result: AutomaticPreparationResult): string {
  if (result.status === "ABORTED") {
    const reason =
      result.reason === "CANNOT_REACT"
        ? "dwelling is no longer reactable"
        : result.reason === "NOT_PASSEND"
          ? "dwelling is no longer passend"
          : result.reason;
    return [
      `PASSEND ......... ${result.reason === "NOT_PASSEND" ? "NO" : "UNKNOWN"}`,
      `CAN REACT ....... ${result.reason === "CANNOT_REACT" ? "NO" : "UNKNOWN"}`,
      "",
      "REACTION ABORTED",
      `Reason: ${reason}`,
      "",
      "No reaction sent.",
    ].join("\n");
  }

  const prepared = result.prepared;
  return [
    `Dwelling ........ ${prepared.dwellingId}`,
    "SESSION ........ VALID",
    "PASSEND ......... YES",
    "CAN REACT ....... YES",
    `MODEL ........... ${result.model ?? "unknown"}`,
    `ASSIGNMENT ...... ${prepared.assignmentId}`,
    `FORM ............ ${prepared.formId}`,
    "HASH ............ FRESH",
    "ACTION .......... add",
    `ENDPOINT ........ ${reactionEndpointForDisplay()}`,
    "",
    "AUTO_SUBMIT ..... OFF",
    "",
    "READY TO REACT",
    `WOULD SUBMIT #${prepared.dwellingId}`,
    "",
    "No reaction sent.",
  ].join("\n");
}

export async function runAndReportAutomaticPreparation(
  dwellingId: string,
  model: string | undefined,
  dependencies: ReactionPreparationDependencies,
  autoSubmit: false,
): Promise<AutomaticPreparationResult> {
  logger.info(`NEW ELIGIBLE: #${dwellingId}`);
  logger.info("Starting reaction pipeline...");
  const result = await runAutomaticPreparationPipeline(
    dwellingId,
    model,
    dependencies,
    autoSubmit,
  );
  console.log(`\n${formatAutomaticPreparationReport(result)}\n`);
  return result;
}
