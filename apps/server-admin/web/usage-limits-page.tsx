import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import {
  InferenceBudgetPolicySchema,
  type InferenceBudgetSettings,
  type InferencePrice,
} from "../../../packages/protocol/inference-budget";
import { ModelDiscoveryResponse } from "../../../packages/protocol/service-catalog";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { Input } from "@admin/components/ui/input";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import { Spinner } from "@admin/components/ui/spinner";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@admin/components/ui/input-group";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@admin/components/ui/table";
import { Empty, EmptyHeader, EmptyTitle } from "@admin/components/ui/empty";
import { PageHeader, Section } from "@admin/components/console/page";
import { SettingRow, SettingRows } from "@admin/components/console/setting-row";
import { SaveBar } from "@admin/components/console/forms";
import { api } from "./lib/api";
import { useAdmin } from "./context";
import {
  useCatalog,
  CatalogBoundary,
  type CatalogState,
} from "./catalog-shared";
import { usageSaveStatus, useUsageCopy } from "./usage-copy";

// Generous per-call ceilings: the request ceiling bounds the serialized request
// size (tool schemas and design context included), the reply ceiling caps max_tokens.
const DEFAULT_MAX_INPUT = 200_000;
const DEFAULT_MAX_OUTPUT = 8_000;

/**
 * Integer USD millionths per million tokens, shown as dollars per million.
 * Prices use the locale's decimal mark but no grouping, so they parse back.
 */
const dollars = (micros: number, language?: string) =>
  language
    ? (micros / 1_000_000).toLocaleString(language, {
        maximumFractionDigits: 6,
        useGrouping: false,
      })
    : String(micros / 1_000_000);
const micros = (text: string) => {
  const value = Number(text.replace(",", "."));
  return text.trim() && Number.isFinite(value) && value >= 0
    ? Math.round(value * 1_000_000)
    : null;
};
/** A call reserves its own request size (at least 2 048 tokens) plus the
 * full max reply, so only the smallest call has to fit a run. */
const MIN_CALL_INPUT = 2048;
const smallestCall = (price: InferencePrice) => {
  const input = Math.min(price.maxInputTokens, MIN_CALL_INPUT);
  return {
    tokens: input + price.maxOutputTokens,
    cost: Math.ceil(
      (input * price.inputMicrosPerMillion +
        price.maxOutputTokens * price.outputMicrosPerMillion) /
        1_000_000,
    ),
  };
};

export function UsageLimitsPage() {
  const state = useCatalog();
  const copy = useUsageCopy();
  // Managers get the header from `UsageLimits`, with the mode switch in it.
  const managed = !!state.query.data?.canManage;
  return (
    <>
      {!managed && <PageHeader title={copy.title} />}
      <CatalogBoundary state={state}>
        {state.query.data &&
          (state.query.data.canManage ? (
            <UsageLimits state={state} />
          ) : (
            <Alert>
              <AlertDescription>{copy.readOnly}</AlertDescription>
            </Alert>
          ))}
      </CatalogBoundary>
    </>
  );
}

function UsageLimits({ state }: { state: CatalogState }) {
  const copy = useUsageCopy();
  const { data, language } = useAdmin();
  const client = useQueryClient();
  const key = [
    "admin",
    "budget",
    data.authentication.principalId,
    state.target.organizationId,
    state.target.workspaceId,
  ];
  const policy = useQuery({
    queryKey: key,
    queryFn: async ({ signal }) =>
      InferenceBudgetPolicySchema.parse(
        await api(
          `identity/catalog/budget?${new URLSearchParams(state.target)}`,
          undefined,
          signal,
        ),
      ),
  });
  const [draft, setDraft] = useState<InferenceBudgetSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [filling, setFilling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (policy.isPending)
    return (
      <>
        <PageHeader title={copy.title} />
        <Skeleton className="h-64 w-full" />
      </>
    );
  if (policy.isError)
    return (
      <>
        <PageHeader title={copy.title} />
        <Alert variant="destructive">
          <AlertDescription>{copy.loadFailed}</AlertDescription>
          <AlertAction>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void policy.refetch()}
            >
              {copy.retry}
            </Button>
          </AlertAction>
        </Alert>
      </>
    );
  const saved = policy.data.settings;
  const settings = draft ?? saved;
  const catalog = state.query.data!;
  // Only models the assistant can run with tools, or decision models, are priced.
  const models = catalog.models.filter(
    (m) =>
      m.enabled &&
      (m.kind === "decision" ||
        ((m.kind === "chat" || m.kind === "router") && m.tools)) &&
      catalog.providers.find((p) => p.id === m.providerId)?.enabled !== false,
  );
  const providerRevision = (providerId: string) =>
    catalog.providers.find((p) => p.id === providerId)?.revision ?? 1;
  const priceOf = (modelId: string) =>
    settings.prices.find((p) => p.modelId === modelId);
  const update = (next: Partial<InferenceBudgetSettings>) => {
    setNotice(null);
    setDraft({ ...settings, ...next });
  };
  const setPrice = (
    model: (typeof models)[number],
    patch: Partial<InferencePrice> | null,
  ) => {
    const others = settings.prices.filter((p) => p.modelId !== model.id);
    if (!patch) return update({ prices: others });
    const current = priceOf(model.id);
    update({
      prices: [
        ...others,
        {
          modelId: model.id,
          modelRevision: model.revision,
          providerRevision: providerRevision(model.providerId),
          maxInputTokens: DEFAULT_MAX_INPUT,
          maxOutputTokens: DEFAULT_MAX_OUTPUT,
          inputMicrosPerMillion: 0,
          outputMicrosPerMillion: 0,
          ...current,
          ...patch,
        },
      ],
    });
  };
  const tooLarge = (price: InferencePrice) => {
    const call = smallestCall(price);
    return (
      call.tokens > settings.maxTokens || call.cost > settings.maxCostMicros
    );
  };
  // Prices pinned to an older model or provider revision are stale; saving refreshes them.
  const stale = settings.prices.filter((price) => {
    const model = models.find((m) => m.id === price.modelId);
    return (
      !model ||
      model.revision !== price.modelRevision ||
      providerRevision(model.providerId) !== price.providerRevision
    );
  });
  const invalid =
    settings.prices.some(
      (p) => p.maxInputTokens < 2048 || p.maxOutputTokens < 1,
    ) ||
    (settings.mode === "enforce" && settings.prices.some(tooLarge));
  async function fill() {
    setFilling(true);
    setNotice(null);
    setError(null);
    try {
      const providers = [...new Set(models.map((m) => m.providerId))];
      let filled = 0;
      let next = settings.prices;
      for (const providerId of providers) {
        const provider = catalog.providers.find((p) => p.id === providerId);
        if (!provider) continue;
        const listed = ModelDiscoveryResponse.parse(
          await api("identity/catalog/models", {
            ...state.target,
            providerId,
            revision: provider.revision,
          }),
        ).models;
        for (const model of models.filter((m) => m.providerId === providerId)) {
          const pricing = listed.find((m) => m.model === model.model)?.pricing;
          if (!pricing) continue;
          const current = next.find((p) => p.modelId === model.id);
          next = [
            ...next.filter((p) => p.modelId !== model.id),
            {
              modelId: model.id,
              modelRevision: model.revision,
              providerRevision: provider.revision,
              maxInputTokens: current?.maxInputTokens ?? DEFAULT_MAX_INPUT,
              maxOutputTokens: current?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
              ...pricing,
            },
          ];
          filled++;
        }
      }
      setDraft({ ...settings, prices: next });
      setNotice(copy.filled(filled));
    } catch {
      setError(copy.fillFailed);
    } finally {
      setFilling(false);
    }
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      // Drop prices for removed models and re-pin current revisions.
      const prices = settings.prices.flatMap((price) => {
        const model = models.find((m) => m.id === price.modelId);
        return model
          ? [
              {
                ...price,
                modelRevision: model.revision,
                providerRevision: providerRevision(model.providerId),
              },
            ]
          : [];
      });
      const result = InferenceBudgetPolicySchema.parse(
        await api("identity/catalog/budget", {
          ...state.target,
          revision: policy.data!.revision,
          settings: { ...settings, prices },
        }),
      );
      client.setQueryData(key, result);
      await client.invalidateQueries({ queryKey: ["admin", "audit"] });
      setDraft(null);
      setNotice(null);
    } catch {
      setError(copy.saveFailed);
    } finally {
      setBusy(false);
    }
  }
  const unpricedInEnforce =
    settings.mode === "enforce" && models.some((m) => !priceOf(m.id));
  return (
    <>
      <PageHeader title={copy.title} />
      <SettingRows>
        <SettingRow
          label={copy.mode}
          labelId="usage-mode"
          meta={
            settings.mode === "observe" ? copy.designerNeedsEnforce : undefined
          }
        >
          <ToggleGroup
            type="single"
            variant="outline"
            aria-labelledby="usage-mode"
            value={settings.mode}
            disabled={busy}
            onValueChange={(mode) => {
              if (mode === "observe" || mode === "enforce") update({ mode });
            }}
          >
            <ToggleGroupItem value="observe">{copy.observe}</ToggleGroupItem>
            <ToggleGroupItem value="enforce">{copy.enforce}</ToggleGroupItem>
          </ToggleGroup>
        </SettingRow>
        <SettingRow label={copy.maxTokens} htmlFor="usage-tokens">
          <GroupedNumberInput
            id="usage-tokens"
            className="w-36"
            min={1}
            max={10_000_000}
            disabled={busy}
            value={settings.maxTokens}
            onCommit={(maxTokens) => update({ maxTokens })}
          />
        </SettingRow>
        <SettingRow label={copy.maxCost} htmlFor="usage-cost">
          <InputGroup className="w-36">
            <InputGroupAddon>
              <InputGroupText>$</InputGroupText>
            </InputGroupAddon>
            <InputGroupInput
              id="usage-cost"
              type="number"
              min={0.000001}
              max={1000}
              step={0.5}
              disabled={busy}
              value={dollars(settings.maxCostMicros)}
              onChange={(e) => {
                const value = micros(e.target.value);
                if (value && value <= 1_000_000_000)
                  update({ maxCostMicros: value });
              }}
            />
          </InputGroup>
        </SettingRow>
      </SettingRows>
      <Section
        title={copy.prices}
        count={models.length}
        actions={
          models.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || filling}
              onClick={() => void fill()}
            >
              {filling ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Download data-icon="inline-start" aria-hidden="true" />
              )}
              {copy.fillPrices}
            </Button>
          )
        }
      >
        {notice && (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {unpricedInEnforce && (
          <Alert>
            <AlertDescription>{copy.enforceNeedsPrices}</AlertDescription>
          </Alert>
        )}
        {models.length ? (
          <Card variant="flush">
            <Table aria-label={copy.prices}>
              <TableHeader>
                <TableRow>
                  <TableHead>{copy.model}</TableHead>
                  <TableHead className="w-28 sm:w-36">
                    {copy.input} ({copy.priceUnit})
                  </TableHead>
                  <TableHead className="w-28 sm:w-36">
                    {copy.output} ({copy.priceUnit})
                  </TableHead>
                  <TableHead className="hidden w-36 xl:table-cell">
                    {copy.maxInput}
                  </TableHead>
                  <TableHead className="hidden w-36 xl:table-cell">
                    {copy.maxOutput}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((model) => {
                  const price = priceOf(model.id);
                  const over =
                    !!price && settings.mode === "enforce" && tooLarge(price);
                  return (
                    <TableRow key={model.id}>
                      <TableCell className="max-w-0">
                        <div className="flex min-w-0 flex-col">
                          <span className="truncate">{model.name}</span>
                          <span className="truncate font-mono text-xs text-muted-foreground">
                            {model.model}
                          </span>
                          {over && (
                            <span className="text-xs text-destructive">
                              {copy.exceedsRun}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      {(
                        [
                          "inputMicrosPerMillion",
                          "outputMicrosPerMillion",
                        ] as const
                      ).map((field) => (
                        <TableCell key={field}>
                          <InputGroup>
                            <InputGroupInput
                              aria-label={`${model.name}: ${field === "inputMicrosPerMillion" ? copy.input : copy.output} (${copy.pricesMeta})`}
                              inputMode="decimal"
                              placeholder={copy.noPrice}
                              disabled={busy}
                              defaultValue={
                                price ? dollars(price[field], language) : ""
                              }
                              key={`${field}/${price?.[field] ?? "none"}`}
                              onBlur={(e) => {
                                const value = micros(e.target.value);
                                if (!e.target.value.trim()) {
                                  const other =
                                    field === "inputMicrosPerMillion"
                                      ? "outputMicrosPerMillion"
                                      : "inputMicrosPerMillion";
                                  if (!price?.[other]) setPrice(model, null);
                                  else setPrice(model, { [field]: 0 });
                                } else if (
                                  value !== null &&
                                  value <= 1_000_000_000
                                )
                                  setPrice(model, { [field]: value });
                              }}
                            />
                          </InputGroup>
                        </TableCell>
                      ))}
                      {(["maxInputTokens", "maxOutputTokens"] as const).map(
                        (field) => (
                          <TableCell
                            key={field}
                            className="hidden xl:table-cell"
                          >
                            <GroupedNumberInput
                              aria-label={`${model.name}: ${field === "maxInputTokens" ? copy.maxInput : copy.maxOutput}`}
                              disabled={busy || !price}
                              value={price?.[field]}
                              min={field === "maxInputTokens" ? 2048 : 1}
                              max={
                                field === "maxInputTokens" ? 1_000_000 : 128_000
                              }
                              onCommit={(value) =>
                                setPrice(model, { [field]: value })
                              }
                            />
                          </TableCell>
                        ),
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <Empty variant="outline">
            <EmptyHeader>
              <EmptyTitle>{copy.noModels}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        )}
      </Section>
      {(draft !== null || busy || stale.length > 0 || error) && (
        <SaveBar
          status={usageSaveStatus(copy, {
            error,
            edited: draft !== null,
            stale: stale.length,
          })}
          tone={error ? "error" : "muted"}
        >
          <Button
            variant="ghost"
            disabled={busy || draft === null}
            onClick={() => {
              setDraft(null);
              setError(null);
              setNotice(null);
            }}
          >
            {copy.discardChanges}
          </Button>
          <Button disabled={busy || invalid} onClick={() => void save()}>
            {busy && <Spinner data-icon="inline-start" />}
            {copy.save}
          </Button>
        </SaveBar>
      )}
    </>
  );
}

/**
 * A whole-number field shown with the locale's thousands separators
 * ("1 000 000"). It edits the plain number while focused and commits a valid
 * value on blur.
 */
function GroupedNumberInput({
  value,
  min,
  max,
  onCommit,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "value" | "onChange" | "type"> & {
  value: number | undefined;
  min: number;
  max: number;
  onCommit: (value: number) => void;
}) {
  const { language } = useAdmin();
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Input
      {...props}
      inputMode="numeric"
      value={
        editing ?? (value === undefined ? "" : value.toLocaleString(language))
      }
      onFocus={() => setEditing(value === undefined ? "" : String(value))}
      onChange={(e) => setEditing(e.target.value)}
      onBlur={() => {
        const next = Number((editing ?? "").replace(/[^\d]/g, ""));
        if (editing?.trim() && next >= min && next <= max) onCommit(next);
        setEditing(null);
      }}
    />
  );
}
