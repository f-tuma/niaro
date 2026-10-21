import React, { useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { randomUUID } from "expo-crypto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Button,
  Group,
  Icon,
  ListRow,
  Notice,
  Row,
  Surface,
  Text,
} from "../../packages/ui";
import { tokens as t } from "../../packages/design-tokens";
import type { Language, Scope } from "../../packages/protocol";
import {
  DesignCapabilitiesSchema,
  DesignReceiptSchema,
  DesignTurnSchema,
  OwnedDesignReviewSchema,
  DESIGN_PROFILE,
  WORKSPACE_DESIGN_PROFILE,
  type DesignCapabilities,
  type DesignCapabilityService,
  type DesignTurn,
  type OwnedDesignReview,
  DesignSessionListSchema,
  DesignServiceDraftListSchema,
  type DesignSessionSummary,
  type DesignServiceDraft,
} from "../../packages/protocol/process-design";
import {
  ClientSession,
  ProcessDesignApiError,
} from "../../packages/client-core/session";
import {
  loadMobileDesignPending,
  dispatchMobileDesignCommand,
  isRejectedMobileDesignCommand,
  mobileDesignTurnMatchesPending,
  mobileDesignRecoveryKey,
  type MobileDesignPending,
} from "../../packages/client-core/process-design-mobile";
import { readProcessDesignPages } from "../../packages/client-core/process-design-pages";
import { translate, type TranslationKey } from "../../packages/i18n";
import { MarkdownText } from "../../packages/ui-catalog/MarkdownText";

const targetProfile = (serviceId?: string | null) =>
  serviceId ? DESIGN_PROFILE : WORKSPACE_DESIGN_PROFILE;
const targetQuery = (_scope: Scope, serviceId?: string | null) => ({
  profile: targetProfile(serviceId),
});
const reviewResponse = (raw: unknown, expectedProfile: string) => {
  if (!raw || typeof raw !== "object") throw new Error("response_invalid");
  const value = raw as { profile?: unknown; review?: unknown };
  if (value.profile !== expectedProfile) throw new Error("response_invalid");
  return OwnedDesignReviewSchema.parse(value.review);
};
const turnsResponse = (raw: unknown, expectedProfile: string) => {
  if (!raw || typeof raw !== "object") throw new Error("response_invalid");
  const value = raw as { profile?: unknown; turns?: unknown };
  if (value.profile !== expectedProfile) throw new Error("response_invalid");
  return Array.isArray(value.turns)
    ? value.turns.map((turn) => DesignTurnSchema.parse(turn))
    : (() => {
        throw new Error("response_invalid");
      })();
};
const capabilitiesResponse = (raw: unknown, expectedProfile: string) => {
  if (!raw || typeof raw !== "object") throw new Error("response_invalid");
  if ((raw as { profile?: unknown }).profile !== expectedProfile)
    throw new Error("response_invalid");
  return DesignCapabilitiesSchema.parse(
    (raw as { capabilities?: unknown }).capabilities,
  );
};
async function readAllCapabilities(
  session: ClientSession,
  query: Record<string, string>,
  expectedProfile: string,
): Promise<DesignCapabilities> {
  let snapshot: DesignCapabilities | null = null;
  let after: string | null = null;
  const cursors = new Set<string>();
  const services = new Map<string, DesignCapabilityService>();
  const models = new Map<string, DesignCapabilities["models"][number]>();
  do {
    const page = capabilitiesResponse(
      await session.requestProcessDesign("capabilities", {
        ...query,
        ...(after ? { after } : {}),
      }),
      expectedProfile,
    );
    if (
      snapshot &&
      (snapshot.fingerprint !== page.fingerprint ||
        snapshot.totalItems !== page.totalItems)
    )
      throw new Error("process_design_capabilities_changed");
    snapshot ??= page;
    for (const service of page.services) {
      const prior = services.get(service.id);
      const actions = new Map(
        prior?.actions.map((action) => [action.id, action]),
      );
      for (const action of service.actions) actions.set(action.id, action);
      services.set(service.id, { ...service, actions: [...actions.values()] });
    }
    for (const model of page.models) models.set(model.id, model);
    after = page.nextAfter;
    if (after) {
      if (cursors.has(after) || cursors.size >= page.totalItems)
        throw new Error("process_design_capability_cursor_invalid");
      cursors.add(after);
    }
  } while (after);
  if (!snapshot) throw new Error("response_invalid");
  const total =
    services.size +
    models.size +
    [...services.values()].reduce(
      (sum, service) => sum + service.actions.length,
      0,
    );
  if (total !== snapshot.totalItems)
    throw new Error("process_design_capabilities_incomplete");
  return {
    ...snapshot,
    services: [...services.values()],
    models: [...models.values()],
    nextAfter: null,
  };
}
const mutationResponse = (raw: unknown, expectedProfile: string) => {
  if (!raw || typeof raw !== "object") throw new Error("response_invalid");
  const value = raw as { receipt?: unknown; review?: unknown };
  if ((raw as { profile?: unknown }).profile !== expectedProfile)
    throw new Error("response_invalid");
  return {
    receipt: DesignReceiptSchema.parse(value.receipt),
    review: OwnedDesignReviewSchema.parse(value.review),
  };
};

function turnFailureTranslation(code: string | null): TranslationKey {
  switch (code) {
    case "process_design_server_restarted":
      return "processDesignFailureServerRestarted";
    case "process_design_interrupted":
      return "processDesignFailureInterrupted";
    case "process_design_native_unsettled":
      return "processDesignFailureNativeUnsettled";
    case "process_design_publication_denied":
      return "processDesignFailurePublicationDenied";
    case "process_design_model_failed":
      return "processDesignFailureModel";
    default:
      return "processDesignTurnFailed";
  }
}

type Props = {
  session: ClientSession;
  language: Language;
  serviceId?: string | null;
  onServiceChange?: (serviceId: string | null) => void;
};

/** Mobile workspace designer: proposal only, with an explicit inactive-draft save. */
export function ProcessDesign({
  session,
  language,
  serviceId,
  onServiceChange,
}: Props) {
  const tr = translate(language);
  const sessionState = session.getSnapshot();
  const scope = sessionState.store?.scope ?? null;
  const key = scope
    ? mobileDesignRecoveryKey(session.identityKey, scope, serviceId)
    : null;
  const [capabilities, setCapabilities] = useState<DesignCapabilities | null>(
    null,
  );
  const [review, setReview] = useState<OwnedDesignReview | null>(null);
  const [turns, setTurns] = useState<DesignTurn[]>([]);
  const [pending, setPending] = useState<MobileDesignPending | null>(null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [serviceSessions, setServiceSessions] = useState<
    DesignSessionSummary[]
  >([]);
  const [serviceDrafts, setServiceDrafts] = useState<DesignServiceDraft[]>([]);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [snapshotFresh, setSnapshotFresh] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [denied, setDenied] = useState(false);
  const [modelId, setModelId] = useState("");
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saveConfirmation, setSaveConfirmation] = useState(false);
  const [modelChooser, setModelChooser] = useState(false);
  const operationInFlight = useRef(false);

  const query = scope ? targetQuery(scope, serviceId) : null;
  const profile = targetProfile(serviceId);

  async function readSnapshot(sessionIdOverride?: string | null) {
    if (!scope || !query) throw new Error("process_design_unavailable");
    setSnapshotFresh(false);
    const sessionId =
      sessionIdOverride === undefined
        ? (currentSessionId ?? review?.id ?? null)
        : sessionIdOverride;
    const [nextCapabilities, rawReview, rawTurns] = await Promise.all([
      readAllCapabilities(session, query, profile),
      sessionId
        ? session.requestProcessDesign("review", { ...query, sessionId })
        : Promise.resolve(null),
      sessionId
        ? session.requestProcessDesign("turns/list", { ...query, sessionId })
        : Promise.resolve({ profile, turns: [] }),
    ]);
    const nextReview = rawReview ? reviewResponse(rawReview, profile) : null;
    const nextTurns = turnsResponse(rawTurns, profile);
    if (
      nextCapabilities.workspaceId !== scope.workspaceId ||
      (nextReview &&
        (nextReview.workspaceId !== scope.workspaceId ||
          nextReview.id !== sessionId ||
          nextReview.organizationId !== nextCapabilities.organizationId ||
          (nextReview.serviceId ?? null) !== (serviceId ?? null))) ||
      (nextReview &&
        nextReview.capabilityFingerprint !== nextCapabilities.fingerprint) ||
      nextTurns.some(
        (turn) =>
          turn.workspaceId !== scope.workspaceId ||
          turn.organizationId !== nextCapabilities.organizationId ||
          turn.sessionId !== sessionId ||
          (!!nextReview && turn.revision > nextReview.revision),
      )
    )
      throw new Error("process_design_scope_changed");
    setCapabilities(nextCapabilities);
    if (serviceId) {
      const [sessions, drafts] = await Promise.all([
        readProcessDesignPages(
          (after) =>
            session.requestProcessDesign("sessions/list", {
              ...query,
              serviceId,
              ...(after ? { after } : {}),
            }),
          (raw) => {
            const page = DesignSessionListSchema.parse(raw);
            if (
              page.profile !== profile ||
              page.workspaceId !== scope.workspaceId ||
              page.organizationId !== nextCapabilities.organizationId ||
              page.serviceId !== serviceId ||
              page.sessions.some((item) => item.serviceId !== serviceId)
            )
              throw new Error("process_design_scope_changed");
            return { items: page.sessions, nextAfter: page.nextAfter };
          },
        ),
        readProcessDesignPages(
          (after) =>
            session.requestProcessDesign("drafts/list", {
              ...query,
              serviceId,
              ...(after ? { after } : {}),
            }),
          (raw) => {
            const page = DesignServiceDraftListSchema.parse(raw);
            if (
              page.profile !== profile ||
              page.workspaceId !== scope.workspaceId ||
              page.organizationId !== nextCapabilities.organizationId ||
              page.serviceId !== serviceId ||
              page.drafts.some((item) => item.serviceId !== serviceId)
            )
              throw new Error("process_design_scope_changed");
            return { items: page.drafts, nextAfter: page.nextAfter };
          },
        ),
      ]);
      setServiceSessions(sessions);
      setServiceDrafts(drafts);
    } else {
      setServiceSessions([]);
      setServiceDrafts([]);
    }
    setReview(nextReview);
    setTurns(nextTurns);
    setModelId(
      (current) =>
        nextTurns[0]?.model.id ??
        (nextCapabilities.models.some((model) => model.id === current)
          ? current
          : (nextCapabilities.models[0]?.id ?? "")),
    );
    if (nextTurns.length) setModelChooser(false);
    setSaveConfirmation(false);
    setSnapshotFresh(true);
  }

  useEffect(() => {
    let active = true;
    if (!scope || !key) return;
    void (async () => {
      let saved: MobileDesignPending | null;
      let savedSessionId: string | null;
      try {
        saved = await loadMobileDesignPending(
          AsyncStorage,
          key,
          scope.workspaceId,
        );
        savedSessionId = await AsyncStorage.getItem(`${key}:session`);
      } catch {
        if (!active) return;
        setCapabilities(null);
        setReview(null);
        setTurns([]);
        setServiceSessions([]);
        setServiceDrafts([]);
        setPending(null);
        setRecoveryReady(false);
        setSnapshotFresh(false);
        setError("process_design_recovery_unavailable");
        setLoadedKey(key);
        setLoading(false);
        return;
      }
      if (!active) return;
      setPending(saved);
      if (savedSessionId) setCurrentSessionId(savedSessionId);
      setRecoveryReady(true);
      try {
        await readSnapshot(savedSessionId);
      } catch (cause) {
        if (active) {
          setCapabilities(null);
          setReview(null);
          setTurns([]);
          setServiceSessions([]);
          setServiceDrafts([]);
          setSnapshotFresh(false);
          if (cause instanceof ProcessDesignApiError) handleFailure(cause);
          else
            setError(
              cause instanceof Error
                ? cause.message
                : "process_design_unavailable",
            );
        }
      } finally {
        if (active) {
          setLoadedKey(key);
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
    // A new component is mounted for a different authenticated scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function handleFailure(cause: unknown) {
    if (
      cause instanceof ProcessDesignApiError &&
      (cause.status === 401 || cause.status === 403)
    ) {
      setDenied(true);
      setRecoveryReady(false);
      setCapabilities(null);
      setReview(null);
      setTurns([]);
      setServiceSessions([]);
      setServiceDrafts([]);
      setPending(null);
      setCurrentSessionId(null);
      setText("");
      setError("identity_forbidden");
      if (key) {
        void AsyncStorage.removeItem(key).catch(() => undefined);
        void AsyncStorage.removeItem(`${key}:session`).catch(() => undefined);
      }
      return;
    }
    if (isRejectedMobileDesignCommand(cause)) setRejected(true);
    setError(
      cause instanceof Error ? cause.message : "process_design_unavailable",
    );
  }

  async function dispatch(
    command: MobileDesignPending,
    ownsOperationLock = false,
    allowLegacyTurnReplay = false,
  ) {
    if (
      !key ||
      !scope ||
      !recoveryReady ||
      denied ||
      loadedKey !== key ||
      (command.serviceId ?? null) !== (serviceId ?? null)
    )
      return;
    if (!ownsOperationLock && operationInFlight.current) return;
    if (!ownsOperationLock) operationInFlight.current = true;
    setLoading(true);
    setError(null);
    setRejected(false);
    try {
      // Critical safety invariant: no write reaches the server before durable storage.
      const { action, raw } = await dispatchMobileDesignCommand(
        AsyncStorage,
        key,
        command,
        async (saved) => ({
          action: saved.command.action,
          raw: await session.requestProcessDesign(
            saved.command.action,
            saved.command.query,
            saved.command.payload,
          ),
        }),
        setPending,
      );
      if (
        action === "start" ||
        action === "acknowledge" ||
        action === "accept"
      ) {
        const result = mutationResponse(raw, profile);
        const requestId = String(command.command.payload.requestId ?? "");
        const expectedKind = {
          start: "started",
          acknowledge: "acknowledged",
          accept: "accepted",
        }[action];
        if (
          result.receipt.requestId !== requestId ||
          result.receipt.kind !== expectedKind ||
          result.receipt.sessionId !== result.review.id ||
          result.receipt.revision > result.review.revision ||
          (action !== "start" &&
            result.receipt.sessionId !== command.sessionId) ||
          result.receipt.workspaceId !== scope.workspaceId ||
          result.review.workspaceId !== scope.workspaceId ||
          (result.review.serviceId ?? null) !== (serviceId ?? null) ||
          result.receipt.organizationId !== result.review.organizationId ||
          result.review.organizationId !== capabilities?.organizationId ||
          (action === "accept" &&
            result.receipt.processId !== result.review.acceptedProcessId)
        )
          throw new Error("process_design_receipt_invalid");
        setReview(result.review);
        setCurrentSessionId(result.review.id);
        await AsyncStorage.setItem(`${key}:session`, result.review.id);
        if (action === "start") setTurns([]);
      } else if (action === "turn") {
        const value = raw as { profile?: unknown; turn?: unknown };
        if (value.profile !== profile) throw new Error("response_invalid");
        const turn = DesignTurnSchema.parse(value?.turn);
        const payload = command.command.payload;
        if (
          turn.requestId !== payload.requestId ||
          turn.sessionId !== command.sessionId ||
          (turn.requestRevision !== payload.revision &&
            !(allowLegacyTurnReplay && turn.requestRevision === undefined)) ||
          turn.workspaceId !== scope.workspaceId ||
          turn.organizationId !== capabilities?.organizationId ||
          turn.userText !== payload.text ||
          turn.language !== payload.language ||
          turn.model.id !== payload.modelId
        )
          throw new Error("process_design_turn_invalid");
        if (
          turn.status === "running" ||
          (turn.status === "interrupted" && turn.nativeSettled !== true)
        ) {
          setTurns((current) => [
            ...current.filter((item) => item.requestId !== turn.requestId),
            turn,
          ]);
          setText("");
          setError(
            turn.status === "running"
              ? "process_design_turn_running"
              : "process_design_native_unsettled",
          );
          return;
        }
        setCurrentSessionId(turn.sessionId);
        await AsyncStorage.setItem(`${key}:session`, turn.sessionId);
        setTurns((current) => [
          ...current.filter((item) => item.requestId !== turn.requestId),
          turn,
        ]);
      }
      await AsyncStorage.removeItem(key);
      setPending(null);
      setRejected(false);
      setText("");
      await readSnapshot(
        action === "start"
          ? mutationResponse(raw, profile).review.id
          : command.sessionId,
      );
    } catch (cause) {
      handleFailure(cause);
    } finally {
      setLoading(false);
      if (!ownsOperationLock) operationInFlight.current = false;
    }
  }

  async function start(existing?: DesignServiceDraft) {
    if (
      !scope ||
      !query ||
      !capabilities ||
      !snapshotFresh ||
      pending ||
      loading
    )
      return;
    const body = serviceId
      ? {
          requestId: randomUUID(),
          serviceId,
          ...(existing
            ? {
                processId: existing.id,
                ...(existing.latestVersion > 0
                  ? { baselineVersion: existing.latestVersion }
                  : {}),
              }
            : {}),
        }
      : {
          profile,
          requestId: randomUUID(),
          owner: { type: "workspace" as const },
        };
    await dispatch({
      version: 1,
      workspaceId: scope.workspaceId,
      ...(serviceId ? { serviceId } : {}),
      sessionId: null,
      command: { action: "start", query: { ...query }, payload: body },
    });
  }

  async function sendTurn() {
    if (
      !scope ||
      !query ||
      !review ||
      review.acceptedProcessId ||
      !modelId ||
      !selectedModelAvailable ||
      !text.trim() ||
      pending ||
      !snapshotFresh
    )
      return;
    const body = {
      sessionId: review.id,
      requestId: randomUUID(),
      revision: review.revision,
      modelId,
      text: text.trim(),
      language,
    };
    await dispatch({
      version: 1,
      workspaceId: scope.workspaceId,
      ...(serviceId ? { serviceId } : {}),
      sessionId: review.id,
      ...(serviceId ? { serviceId } : {}),
      command: {
        action: "turn",
        query: { ...query, sessionId: review.id },
        payload: body,
      },
    });
  }

  async function retryPending() {
    if (
      !pending ||
      (!review && pending.sessionId) ||
      !scope ||
      !query ||
      !recoveryReady ||
      !capabilities ||
      (pending.sessionId && (!review || !snapshotFresh)) ||
      denied
    )
      return;
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      // Reload current server state before an explicit retry; do not auto-replay on mount.
      await readSnapshot(pending.sessionId);
      if (pending.command.action === "turn") {
        const history = turnsResponse(
          await session.requestProcessDesign("turns/list", {
            ...query,
            sessionId: pending.sessionId!,
          }),
          profile,
        );
        const requestId = pending.command.payload.requestId;
        const recorded = history.find((turn) => turn.requestId === requestId);
        if (recorded) {
          if (recorded.requestRevision === undefined) {
            // Older rows do not echo the admitted revision. Let the server
            // compare the exact persisted payload digest on idempotent replay.
            await dispatch(pending, true, true);
            return;
          }
          if (
            !capabilities ||
            !mobileDesignTurnMatchesPending(pending, recorded, {
              organizationId: capabilities.organizationId,
              workspaceId: scope.workspaceId,
            })
          )
            throw new Error("process_design_turn_binding_mismatch");
          setTurns(history);
          if (recorded.status === "running") {
            setError("process_design_turn_running");
            return;
          }
          if (
            recorded.status === "interrupted" &&
            recorded.nativeSettled !== true
          ) {
            setError("process_design_native_unsettled");
            return;
          }
          // The turn may have changed the proposal while the second list read
          // was in flight. Refresh its review before declaring recovery done.
          await readSnapshot(pending.sessionId);
          await AsyncStorage.removeItem(key!);
          setPending(null);
          setRejected(false);
          return;
        }
      }
      await dispatch(pending, true);
    } catch (cause) {
      handleFailure(cause);
    } finally {
      setLoading(false);
      operationInFlight.current = false;
    }
  }

  async function acknowledgeAssumptions() {
    if (!scope || !query || !review || pending || !snapshotFresh) return;
    const body = {
      sessionId: review.id,
      requestId: randomUUID(),
      revision: review.revision,
      assumptions: review.assumptions
        .filter((item) => !item.acknowledged)
        .map(({ id, digest }) => ({ id, digest })),
    };
    await dispatch({
      version: 1,
      workspaceId: scope.workspaceId,
      ...(serviceId ? { serviceId } : {}),
      sessionId: review.id,
      command: {
        action: "acknowledge",
        query: { ...query, sessionId: review.id },
        payload: body,
      },
    });
  }

  async function confirmSave() {
    if (
      !scope ||
      !query ||
      !review ||
      review.changesTruncated ||
      !capabilities ||
      !saveConfirmation ||
      pending ||
      !recoveryReady ||
      !snapshotFresh ||
      denied
    )
      return;
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      // The confirmation is tied to the latest read digest and revision.
      const latest = reviewResponse(
        await session.requestProcessDesign("review", {
          ...query,
          sessionId: review.id,
        }),
        profile,
      );
      if (
        latest.id !== review.id ||
        latest.workspaceId !== scope.workspaceId ||
        latest.organizationId !== capabilities?.organizationId ||
        (latest.serviceId ?? null) !== (serviceId ?? null) ||
        latest.capabilityFingerprint !== capabilities.fingerprint ||
        latest.revision !== review.revision ||
        latest.reviewDigest !== review.reviewDigest
      ) {
        setReview(latest);
        setSaveConfirmation(false);
        setError("process_design_snapshot_changed");
        return;
      }
      const payload = {
        sessionId: latest.id,
        requestId: randomUUID(),
        revision: latest.revision,
        reviewDigest: latest.reviewDigest,
      };
      await dispatch(
        {
          version: 1,
          workspaceId: scope.workspaceId,
          ...(serviceId ? { serviceId } : {}),
          sessionId: latest.id,
          command: {
            action: "accept",
            query: { ...query, sessionId: latest.id },
            payload,
          },
        },
        true,
      );
    } catch (cause) {
      handleFailure(cause);
    } finally {
      setLoading(false);
      operationInFlight.current = false;
    }
  }

  async function clearRejected() {
    if (!pending || !key || !rejected || !recoveryReady) return;
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setLoading(true);
    try {
      await AsyncStorage.removeItem(key);
      setPending(null);
      setRejected(false);
      await readSnapshot(currentSessionId);
    } catch (cause) {
      handleFailure(cause);
    } finally {
      setLoading(false);
      operationInFlight.current = false;
    }
  }

  async function refresh() {
    if (!recoveryReady || denied) return;
    if (operationInFlight.current) return;
    operationInFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      await readSnapshot(currentSessionId);
    } catch (cause) {
      handleFailure(cause);
    } finally {
      setLoading(false);
      operationInFlight.current = false;
    }
  }

  async function openSession(sessionId: string) {
    if (!key || !recoveryReady || loading || pending) return;
    setCurrentSessionId(sessionId);
    await AsyncStorage.setItem(`${key}:session`, sessionId);
    setLoading(true);
    try {
      await readSnapshot(sessionId);
    } catch (cause) {
      handleFailure(cause);
    } finally {
      setLoading(false);
    }
  }

  async function beginNewDesign() {
    if (!key || loading || pending) return;
    await AsyncStorage.removeItem(`${key}:session`);
    setCurrentSessionId(null);
    setReview(null);
    setTurns([]);
    setText("");
    setSaveConfirmation(false);
    setSnapshotFresh(true);
  }

  const blocked =
    !review || review.blockers.length > 0 || !review.validation.valid;
  const modelPinned = turns.length > 0;
  const pinnedModel = turns[0]?.model;
  const selectedModel = capabilities?.models.find(
    (item) => item.id === modelId,
  );
  const selectedModelAvailable =
    !!selectedModel &&
    (!modelPinned ||
      turns.every(
        (turn) =>
          turn.model.id === selectedModel.id &&
          turn.model.revision === selectedModel.revision &&
          turn.model.providerId === selectedModel.providerId &&
          turn.model.providerRevision === selectedModel.providerRevision,
      ));
  const canSave =
    !blocked &&
    !review?.changesTruncated &&
    !review?.acceptedProcessId &&
    !pending &&
    !loading &&
    snapshotFresh &&
    recoveryReady &&
    !denied &&
    loadedKey === key;
  const visibleError = error
    ? error === "identity_forbidden"
      ? tr("processDesignAccessLost")
      : error === "process_design_recovery_unavailable"
        ? tr("processDesignRecoveryUnavailable")
        : error === "process_design_history_limit"
          ? tr("processDesignHistoryLimit")
          : error === "process_design_turn_running"
            ? tr("processDesignTurnRunning")
            : error === "process_design_native_unsettled"
              ? tr("processDesignFailureNativeUnsettled")
              : error === "process_design_snapshot_changed"
                ? tr("processDesignSnapshotChanged")
                : tr("processDesignRequestFailed")
    : null;

  return (
    <ScrollView
      contentContainerStyle={styles.stack}
      keyboardShouldPersistTaps="handled"
      testID="process-design-mobile"
    >
      <Text tone="secondary">
        {serviceId ? tr("processDesignServiceIntro") : tr("processDesignIntro")}
      </Text>
      {capabilities?.services.length ? (
        <Group title={tr("processDesignTarget")}>
          <ListRow
            icon="server"
            label={tr("processDesignWorkspaceTarget")}
            selected={!serviceId}
            chevron={false}
            trailing={!serviceId ? <Selected /> : undefined}
            onPress={() => onServiceChange?.(null)}
          />
          {capabilities.services.map((service) => (
            <ListRow
              key={service.id}
              icon="link"
              label={service.name}
              selected={service.id === serviceId}
              chevron={false}
              trailing={service.id === serviceId ? <Selected /> : undefined}
              onPress={() => onServiceChange?.(service.id)}
            />
          ))}
        </Group>
      ) : null}
      {error ? <Notice error>{visibleError}</Notice> : null}
      {recoveryReady && !denied && !snapshotFresh && !loading ? (
        <Button
          variant="secondary"
          label={tr("processDesignRefresh")}
          onPress={() => void refresh()}
        />
      ) : null}
      {loadedKey !== key || loading ? (
        <Text role="meta" tone="secondary">
          {tr("processDesignLoading")}
        </Text>
      ) : (
        <>
          {serviceId ? (
            <>
              <Group title={tr("processDesignHistory")}>
                {serviceSessions.length ? (
                  serviceSessions.map((item) => (
                    <ListRow
                      key={item.id}
                      label={`${item.purpose || tr("processDesignUntitledSession")} · ${item.id.slice(0, 8)}`}
                      value={
                        item.acceptedProcessId
                          ? tr("processDesignSessionSaved")
                          : undefined
                      }
                      selected={item.id === currentSessionId}
                      disabled={loading || !!pending}
                      onPress={() => void openSession(item.id)}
                    />
                  ))
                ) : (
                  <ListBlockText>{tr("processDesignNoHistory")}</ListBlockText>
                )}
              </Group>
              <Group title={tr("processDesignSavedServiceProcesses")}>
                {serviceDrafts.length ? (
                  serviceDrafts.map((item) => (
                    <ListRow
                      key={item.id}
                      label={item.name}
                      description={`${tr(item.kind === "agent" ? "processesAgent" : "processesWorkflow")} · v${item.latestVersion}`}
                      value={
                        item.activeVersion
                          ? `${tr("processDesignActiveVersion")} ${item.activeVersion}`
                          : tr("processDesignInactive")
                      }
                      disabled={loading || !!pending}
                      onPress={() => void start(item)}
                    />
                  ))
                ) : (
                  <ListBlockText>
                    {tr("processDesignNoSavedServiceProcesses")}
                  </ListBlockText>
                )}
              </Group>
            </>
          ) : null}
          {pending ? (
            <View style={styles.tight}>
              <Notice>{tr("processDesignRetryHint")}</Notice>
              <Button
                variant="secondary"
                size="small"
                style={styles.start}
                label={tr("processDesignRetry")}
                disabled={
                  loading ||
                  !recoveryReady ||
                  !capabilities ||
                  denied ||
                  (!!pending.sessionId && (!review || !snapshotFresh))
                }
                onPress={() => void retryPending()}
              />
              {rejected ? (
                <Button
                  variant="quiet"
                  size="small"
                  style={styles.start}
                  label={tr("processDesignClearRejected")}
                  disabled={loading}
                  onPress={() => void clearRejected()}
                />
              ) : null}
            </View>
          ) : null}
          {!review ? (
            <Button
              label={tr("processDesignStart")}
              disabled={
                loading ||
                !scope ||
                !!pending ||
                !recoveryReady ||
                !capabilities ||
                !snapshotFresh ||
                denied
              }
              onPress={() => void start()}
            />
          ) : (
            <>
              <View style={styles.card}>
                <Text
                  role="section"
                  tone="secondary"
                  accessibilityRole="header"
                >
                  {tr("processDesignReview")}
                </Text>
                <Text role="sheetTitle" selectable>
                  {review.candidate?.name ?? tr("processDesignNoProposal")}
                </Text>
                <Text tone="secondary" selectable>
                  {review.brief.purpose || tr("processDesignPurposeMissing")}
                </Text>
                {review.brief.inputs.length ? (
                  <View style={styles.stack}>
                    <Text role="caption">{tr("processDesignInputs")}</Text>
                    {review.brief.inputs.map((item, index) => (
                      <Text key={`input-${index}`} selectable>
                        • {item}
                      </Text>
                    ))}
                  </View>
                ) : null}
                {review.brief.outputs.length ? (
                  <View style={styles.stack}>
                    <Text role="caption">{tr("processDesignOutputs")}</Text>
                    {review.brief.outputs.map((item, index) => (
                      <Text key={`output-${index}`} selectable>
                        • {item}
                      </Text>
                    ))}
                  </View>
                ) : null}
                {review.brief.rules.length ? (
                  <View style={styles.stack}>
                    <Text role="caption">{tr("processDesignRules")}</Text>
                    {review.brief.rules.map((item, index) => (
                      <Text key={`rule-${index}`} selectable>
                        • {item}
                      </Text>
                    ))}
                  </View>
                ) : null}
                {review.blockers.map((blocker) => (
                  <Text key={blocker} style={{ color: t.color.status.error }}>
                    • {blocker}
                  </Text>
                ))}
                {review.validation.issues.map((item, index) => (
                  <Text
                    key={`${item.code}-${index}`}
                    style={{ color: t.color.status.error }}
                  >
                    • {item.code} · {item.path}
                  </Text>
                ))}
                {review.changesTruncated ? (
                  <Notice>{tr("processDesignChangesTruncated")}</Notice>
                ) : null}
                {review.assumptions.length ? (
                  <View style={styles.list}>
                    <Text role="caption">{tr("processDesignAssumptions")}</Text>
                    {review.assumptions.map((assumption) => (
                      <Text key={assumption.id} selectable>
                        {assumption.acknowledged ? "✓" : "○"} {assumption.id}:{" "}
                        {review.brief.assumptions.find(
                          (item) => item.id === assumption.id,
                        )?.text ?? ""}
                      </Text>
                    ))}
                    {review.assumptions.some((item) => !item.acknowledged) ? (
                      <Button
                        variant="secondary"
                        size="small"
                        style={styles.start}
                        label={tr("processDesignAcknowledge")}
                        disabled={
                          loading ||
                          !!pending ||
                          !recoveryReady ||
                          !snapshotFresh ||
                          denied
                        }
                        onPress={() => void acknowledgeAssumptions()}
                      />
                    ) : null}
                  </View>
                ) : null}
                {review.candidate ? (
                  <View style={styles.list}>
                    <Text role="caption">
                      {tr("processDesignFullDefinition")}
                    </Text>
                    <Text selectable style={styles.code}>
                      {JSON.stringify(review.candidate, null, 2)}
                    </Text>
                  </View>
                ) : null}
              </View>
              {review.changes.length ? (
                <Surface style={styles.card}>
                  <Text role="label">{tr("processDesignChanges")}</Text>
                  {review.changes.map((change, index) => (
                    <View key={`${change.path}-${index}`} style={styles.change}>
                      <Text selectable>
                        {change.kind} · {change.path}
                      </Text>
                      {change.before ? (
                        <Text tone="secondary" selectable>
                          − {change.before}
                        </Text>
                      ) : null}
                      {change.after ? (
                        <Text selectable>+ {change.after}</Text>
                      ) : null}
                    </View>
                  ))}
                </Surface>
              ) : null}
              {review.baseline ? (
                <View style={styles.list}>
                  <Text role="caption">
                    {tr("processDesignBaselineDefinition")}
                  </Text>
                  <Text selectable style={styles.code}>
                    {JSON.stringify(review.baseline.definition, null, 2)}
                  </Text>
                </View>
              ) : null}
              {turns.map((turn) => (
                <TurnCard key={turn.turnId} turn={turn} language={language} />
              ))}
              <View style={styles.card}>
                <Text role="label" accessibilityRole="header">
                  {tr("processDesignConversation")}
                </Text>
                {modelPinned && !selectedModelAvailable ? (
                  <Notice>
                    {tr("processDesignPinnedModelUnavailable")}{" "}
                    {tr("processDesignModel")}: {modelId}
                    {pinnedModel
                      ? ` · rev ${pinnedModel.revision} · provider ${pinnedModel.providerId} rev ${pinnedModel.providerRevision}`
                      : ""}
                  </Notice>
                ) : null}
                {capabilities?.models.length ? (
                  <>
                    <Pressable
                      disabled={modelPinned}
                      accessibilityState={{ disabled: modelPinned }}
                      onPress={() => {
                        if (!modelPinned)
                          setModelChooser((current) => !current);
                      }}
                      accessibilityRole="button"
                      style={styles.model}
                    >
                      <Text role="meta" tone="secondary">
                        {tr("processDesignModel")}:{" "}
                        {modelPinned
                          ? selectedModelAvailable
                            ? selectedModel?.name
                            : modelId
                          : (selectedModel?.name ??
                            capabilities.models[0]?.name)}
                      </Text>
                    </Pressable>
                    {modelPinned ? (
                      <Text role="meta" tone="secondary">
                        {tr("processDesignModelPinned")}
                      </Text>
                    ) : null}
                    {modelChooser
                      ? capabilities.models.map((item) => (
                          <Pressable
                            key={item.id}
                            style={styles.model}
                            onPress={() => {
                              setModelId(item.id);
                              setModelChooser(false);
                            }}
                          >
                            <Text>
                              {modelId === item.id ? "✓ " : ""}
                              {item.name} ({item.model})
                            </Text>
                          </Pressable>
                        ))
                      : null}
                  </>
                ) : (
                  <Text tone="secondary">{tr("processDesignNoModels")}</Text>
                )}
                <TextInput
                  accessibilityLabel={tr("processDesignPrompt")}
                  multiline
                  maxLength={4000}
                  value={text}
                  onChangeText={setText}
                  placeholder={tr("processDesignPrompt")}
                  editable={
                    !loading &&
                    !pending &&
                    !review.acceptedProcessId &&
                    !!modelId &&
                    selectedModelAvailable &&
                    recoveryReady &&
                    !denied
                  }
                  style={styles.input}
                />
                <Button
                  label={tr("processDesignSend")}
                  disabled={
                    loading ||
                    !!pending ||
                    !!review.acceptedProcessId ||
                    !modelId ||
                    !selectedModelAvailable ||
                    !text.trim() ||
                    !recoveryReady ||
                    !snapshotFresh ||
                    denied
                  }
                  onPress={() => void sendTurn()}
                />
              </View>
              {review.acceptedProcessId ? (
                <Notice>{tr("processDesignSavedInactive")}</Notice>
              ) : null}
              {canSave ? (
                saveConfirmation ? (
                  <View style={styles.stack}>
                    <Notice>{tr("processDesignConfirmSave")}</Notice>
                    <Button
                      label={tr("processDesignSaveInactive")}
                      disabled={
                        loading ||
                        !!pending ||
                        !recoveryReady ||
                        !snapshotFresh ||
                        denied
                      }
                      onPress={() => void confirmSave()}
                    />
                    <Button
                      variant="quiet"
                      label={tr("cancel")}
                      onPress={() => setSaveConfirmation(false)}
                    />
                  </View>
                ) : (
                  <Button
                    variant="secondary"
                    label={tr("processDesignReviewBeforeSave")}
                    onPress={() =>
                      void (async () => {
                        setLoading(true);
                        try {
                          await readSnapshot();
                          setSaveConfirmation(true);
                        } catch (cause) {
                          setError(
                            cause instanceof Error
                              ? cause.message
                              : "process_design_unavailable",
                          );
                        } finally {
                          setLoading(false);
                        }
                      })()
                    }
                  />
                )
              ) : null}
            </>
          )}
          {review ? (
            <Button
              variant="quiet"
              label={tr("processDesignNew")}
              disabled={loading || !!pending}
              onPress={() => void beginNewDesign()}
            />
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

/** The chosen design destination. */
function Selected() {
  return <Icon name="check" size={20} color={t.color.action.primary} />;
}
/** An empty-state line inside a Group. */
function ListBlockText({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.block}>
      <Text tone="secondary">{children}</Text>
    </View>
  );
}

function TurnCard({
  turn,
  language,
}: {
  turn: DesignTurn;
  language: Language;
}) {
  const tr = translate(language);
  return (
    <Surface style={styles.card} testID={`process-design-turn-${turn.turnId}`}>
      <Text role="label" selectable>
        {turn.userText}
      </Text>
      {turn.status === "running" ? (
        <Text tone="secondary">{tr("processDesignTurnRunning")}</Text>
      ) : null}
      {turn.reply ? <MarkdownText text={turn.reply} /> : null}
      {turn.status === "failed" || turn.status === "interrupted" ? (
        <Notice error>
          {turn.status === "interrupted" && turn.nativeSettled !== true
            ? tr("processDesignFailureNativeUnsettled")
            : tr(turnFailureTranslation(turn.failure))}
        </Notice>
      ) : null}
      {turn.toolReceipts.length ? (
        <Row style={{ flexWrap: "wrap", gap: 6 }}>
          {turn.toolReceipts.map((receipt) => (
            <Text key={receipt.toolCallId} role="meta" tone="secondary">
              {receipt.name}
            </Text>
          ))}
        </Row>
      ) : null}
    </Surface>
  );
}

const styles = StyleSheet.create({
  stack: {
    gap: t.spacing.xl,
    paddingHorizontal: t.spacing.screenGutter,
    paddingTop: t.spacing.sm,
    paddingBottom: t.spacing.xl,
  },
  card: { gap: t.spacing.sm },
  tight: { gap: t.spacing.sm },
  list: { gap: t.spacing.xs },
  start: { alignSelf: "flex-start" },
  block: { padding: t.spacing.lg },
  model: { minHeight: 32, justifyContent: "center" },
  code: {
    padding: t.spacing.md,
    borderRadius: t.radius.small,
    backgroundColor: t.color.fill,
    fontFamily: "monospace",
    fontSize: 12,
    lineHeight: 17,
    color: t.color.text.secondary,
  },
  change: {
    gap: t.spacing.xs,
    paddingVertical: t.spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: t.color.border,
  },
  input: {
    minHeight: 92,
    backgroundColor: t.color.fill,
    borderRadius: t.radius.control,
    padding: t.spacing.md,
    color: t.color.text.primary,
    textAlignVertical: "top",
  },
});
