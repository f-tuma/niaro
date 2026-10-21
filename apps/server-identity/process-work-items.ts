import { prepareProcessOutput, processOutputPreview } from "./process-output";
import { translate } from "../../packages/i18n";
import { createProcessReadWindow } from "./process-read-window";
import {
  WorkItemSchema,
  type Scope,
  type WorkItem,
  type Language,
} from "../../packages/protocol";
import type { ProcessWork } from "../../packages/protocol/process-work";
import type { CatalogContext, CatalogController } from "./catalog-controller";
import type { ProcessStartStore } from "./process-start-store";
import type { ServiceProcessStore } from "./service-processes";
import type { NativeTaskRoot } from "./service-catalog";
import type { AgentMemory } from "./agent-memory";
import { presentServiceAnswer } from "./service-answer";
import { readableName } from "../../packages/protocol/display-name";
import { CardBuilder } from "../server-cards/builders";
import { loopText } from "./loop-redaction";
import type { ProcessQuestionStore } from "./process-question-store";
import { projectProcessApproval } from "./process-approval";

const say = (language: Language, en: string, cs: string) =>
  language === "cs" ? cs : en;

/** Projection only: no native owner, start/resume, inference, or business dispatch. */
export function createProcessTaskProjection(
  controller: CatalogController,
  registry: ServiceProcessStore,
  starts: ProcessStartStore,
  context: CatalogContext,
  scope: Scope,
  organizationId: string,
  memory?: AgentMemory,
  memoryObservation?: () => unknown,
  questions?: ProcessQuestionStore,
) {
  const reads = createProcessReadWindow(
    controller,
    registry,
    starts,
    context,
    scope,
    organizationId,
    memory,
    memoryObservation,
    questions,
  );
  async function projectOne(id: string): Promise<WorkItem | null> {
    const window = await reads.read(id);
    if (!window) return null;
    const fresh = window.value;
    const detailsAvailable = fresh.detailsAvailable;
    const { saved, artifact, journal, receipts } = fresh;
    const admission = saved.receipt;
    if (admission.status !== "admitted") return null;
    const language = saved.command.language;
    let approvalReview = detailsAvailable
      ? projectProcessApproval(
          controller,
          scope,
          organizationId,
          id,
          journal,
          artifact,
          receipts.filter(
            (receipt): receipt is NonNullable<typeof receipt> => !!receipt,
          ),
          language,
          context.epoch(organizationId),
        )
      : journal.status === "waiting" &&
          journal.pending &&
          !("kind" in journal.pending)
        ? { approvalUnavailable: "context" as const }
        : {};
    const receiptSummaries: ProcessWork["receipts"] = receipts.map(
      (receipt) => ({
        operationId: receipt!.id,
        title: detailsAvailable
          ? loopText(receipt!.title, 100) || "Action"
          : say(language, "Action", "Akce"),
        service: detailsAvailable
          ? loopText(receipt!.serviceName, 100) || "Service"
          : say(language, "Service", "Služba"),
        effect: receipt!.effect,
        status: receipt!.status,
        // Succeeded receipts carry the raw service payload; only failure
        // summaries are written for people.
        summary:
          detailsAvailable &&
          (receipt!.status === "failed" || receipt!.status === "unknown")
            ? loopText(
                presentServiceAnswer(receipt!, language).result?.summary,
                600,
              )
            : "",
      }),
    );
    if (approvalReview.approval) {
      const result = approvalReview.approval.result;
      const summary = receiptSummaries.find(
        (receipt) => receipt.operationId === result.operationId,
      );
      if (summary?.title !== result.title || summary.service !== result.service)
        approvalReview = { approvalUnavailable: "identity" };
    }
    const receiptStatus = {
      awaiting_approval: say(
        language,
        "Waiting for approval",
        "Čeká na potvrzení",
      ),
      running: say(language, "Running", "Probíhá"),
      succeeded: say(language, "Completed", "Dokončeno"),
      failed: say(language, "Failed", "Selhalo"),
      unknown: say(language, "Unconfirmed", "Nepotvrzeno"),
      rejected: say(language, "Rejected", "Odmítnuto"),
    };
    const messages = {
      running: say(language, "The process is running.", "Proces probíhá."),
      waiting: say(
        language,
        "An action is waiting for confirmation.",
        "Akce čeká na potvrzení.",
      ),
      succeeded: say(
        language,
        "The process completed.",
        "Proces byl dokončen.",
      ),
      failed: say(
        language,
        "The process could not be completed.",
        "Proces se nepodařilo dokončit.",
      ),
      unknown: say(
        language,
        "The result is not confirmed. A write may already have happened; check the service before retrying.",
        "Výsledek není potvrzený. Zápis již mohl proběhnout; před opakováním ověř stav ve službě.",
      ),
      cancelled: say(
        language,
        "The process was interrupted. Recorded action outcomes remain below.",
        "Proces byl přerušen. Uložené výsledky akcí zůstávají níže.",
      ),
    };
    const status = receiptSummaries.some(
      (receipt) => receipt.status === "unknown",
    )
      ? "unknown"
      : journal.status === "running" && journal.trace.status === "interrupted"
        ? "interrupted"
        : journal.status;
    let explanation =
      status === "interrupted"
        ? say(
            language,
            "The previous run was interrupted. Completion is not confirmed; recorded action outcomes remain below.",
            "Předchozí běh byl přerušen. Dokončení není potvrzené; uložené výsledky akcí zůstávají níže.",
          )
        : messages[status];
    const question =
      detailsAvailable &&
      status === "waiting" &&
      journal.pending &&
      "kind" in journal.pending
        ? journal.pending
        : undefined;
    if (question)
      explanation = say(
        language,
        "The agent needs your answer before it can continue.",
        "Agent potřebuje tvoji odpověď, aby mohl pokračovat.",
      );
    if (journal.failure && detailsAvailable)
      explanation +=
        say(language, " Failure code: ", " Kód chyby: ") +
        loopText(journal.failure.code, 160);
    if (!detailsAvailable)
      explanation += say(
        language,
        " Saved details are unavailable under the current access or context.",
        " Uložené podrobnosti nejsou dostupné s aktuálním přístupem nebo kontextem.",
      );
    if (
      ["failed", "interrupted", "unknown"].includes(status) &&
      receiptSummaries.some(
        (r) => r.effect === "write" && r.status === "succeeded",
      )
    )
      explanation += say(
        language,
        " An earlier write succeeded; this failure does not undo it.",
        " Dřívější zápis se podařil; toto selhání ho nevrací zpět.",
      );
    const output = prepareProcessOutput(fresh, scope);
    const nativeProcess: ProcessWork = {
      kind: "service-process-1",
      startedAt: admission.createdAt,
      provenance: {
        runId: journal.runId,
        processId: journal.processId,
        version: journal.version,
        artifactDigest: journal.artifactDigest,
        actorId: scope.userId,
        conversationId: admission.origin.conversationId,
        commandId: admission.commandId,
        admissionId: admission.receiptId,
      },
      status,
      journalStatus: journal.status,
      detailsAvailable,
      ...(output?.available
        ? { output: output.reference, outputSummary: output.summary }
        : output
          ? { outputUnavailable: output.reason }
          : {}),
      ...approvalReview,
      ...(question
        ? {
            journalRevision: journal.revision,
            question: {
              nodeId: question.nodeId,
              childRunId: question.childRunId,
              toolCallId: question.toolCallId,
              questionId: question.questionId,
              questionRevision: question.questionRevision,
              question: question.question,
            },
          }
        : {}),
      ...(detailsAvailable && fresh.answerHistory.length
        ? { answerHistory: fresh.answerHistory }
        : {}),
      receipts: receiptSummaries,
    };
    const card = new CardBuilder({
      id: `process-${id.slice(0, 32)}`,
      revision: journal.revision,
      title: artifact.definition.name.slice(0, 160),
      icon: "tasks",
    });
    card.add({
      type: "notice",
      tone: ["failed", "unknown", "interrupted"].includes(status)
        ? "warning"
        : "info",
      text: explanation,
    });
    if (question) card.add({ type: "text", text: question.question });
    if (receiptSummaries.length) {
      const children = receiptSummaries.slice(-12).map((receipt) => {
        const text = [
          receipt.service,
          say(
            language,
            receipt.effect === "write" ? "Write" : "Read",
            receipt.effect === "write" ? "Zápis" : "Čtení",
          ),
          receiptStatus[receipt.status],
          receipt.summary,
        ]
          .filter(Boolean)
          .join(" · ");
        const child = card.add({ type: "text", text }, { root: false });
        return card.add(
          {
            type: "section",
            title:
              readableName(receipt.title) || say(language, "Action", "Akce"),
            children: [child],
          },
          { root: false },
        );
      });
      card.add({
        type: "disclosure",
        label: say(
          language,
          `Recorded actions (${receiptSummaries.length})`,
          `Uložené akce (${receiptSummaries.length})`,
        ),
        children,
      });
      if (receiptSummaries.length > 12)
        card.add({
          type: "text",
          tone: "secondary",
          text: say(
            language,
            "Showing the last 12 actions. All recorded statuses are available in the run details.",
            "Zobrazuje se posledních 12 akcí. Všechny uložené stavy jsou v detailu běhu.",
          ),
        });
    }
    if (output?.available) {
      const tr = translate(language);
      card.add({
        type: "text",
        tone: "secondary",
        text: tr("processOutputPreview")
          .replace("{shown}", String(output.summary.shownFields))
          .replace("{total}", String(output.summary.fieldCount)),
      });
      if (output.summary.redacted)
        card.add({
          type: "text",
          tone: "secondary",
          text: tr("processOutputRedacted"),
        });
      if (output.tree.children.length === 0)
        card.add({ type: "text", text: tr("processOutputEmpty") });
      else {
        const children = output.tree.children.slice(0, 8).map((entry) =>
          card.add(
            {
              type: "field",
              label: entry.label,
              value: processOutputPreview(entry.node, language).slice(0, 1000),
            },
            { root: false },
          ),
        );
        card.add({
          type: "disclosure",
          label: tr("processOutputTitle"),
          children,
        });
      }
    }
    return WorkItemSchema.parse({
      id,
      revision: journal.revision,
      conversationId: admission.origin.conversationId,
      title: artifact.definition.name,
      context: explanation,
      card: card.build(),
      status:
        status === "waiting"
          ? question
            ? "waiting_input"
            : journal.pending && "kind" in journal.pending
              ? "waiting_system"
              : "waiting_approval"
          : status === "unknown" || status === "interrupted"
            ? "waiting_system"
            : status,
      inputRequestIds: [],
      actionProposalIds: [],
      operationIds: [],
      demo: false,
      native: {
        runId: id,
        revision: journal.revision,
        process: nativeProcess,
      },
      result: explanation,
      presentation: {
        type: "workflow.progress",
        version: 1,
        variant: "default",
      },
    });
  }
  return {
    observation: memoryObservation,
    roots: reads.roots,
    project: async (roots: NativeTaskRoot[]) =>
      (await Promise.all(roots.map((root) => projectOne(root.id)))).filter(
        (work): work is WorkItem => !!work,
      ),
  };
}
