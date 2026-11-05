import { useState } from "react";
import { FlaskConical } from "lucide-react";
import {
  ModelTestResponse,
  type CatalogModel,
  type ModelTestResult,
} from "../../../packages/protocol/service-catalog";
import { Button } from "@admin/components/ui/button";
import { Badge } from "@admin/components/ui/badge";
import { Spinner } from "@admin/components/ui/spinner";
import { FieldDescription } from "@admin/components/ui/field";
import { api } from "./lib/api";
import { catalogIssue, type CatalogState } from "./catalog-shared";
import { useProviderCopy } from "./provider-copy";

/** Declared capabilities a test result can set. */
export type TestedCapabilities = Partial<
  Pick<CatalogModel, "tools" | "imageInput" | "audioInput" | "audioOutput">
>;
/** What the results say to declare: only answers, never a failed or skipped test. */
export function testedCapabilities(
  results: ModelTestResult["results"],
): TestedCapabilities {
  const declared: TestedCapabilities = {};
  for (const result of results)
    if (
      (result.status === "supported" || result.status === "unsupported") &&
      (result.capability === "tools" ||
        result.capability === "imageInput" ||
        result.capability === "audioInput" ||
        result.capability === "audioOutput")
    )
      declared[result.capability] = result.status === "supported";
  return declared;
}

/**
 * The administrator's capability test of a saved model: it sends a few
 * small requests through the server and shows what the provider answered.
 * "Use these results" sets the form's switches; saving stays with the form.
 */
export function ModelCapabilityTest({
  state,
  model,
  onApply,
}: {
  state: CatalogState;
  model: CatalogModel;
  onApply: (declared: TestedCapabilities) => void;
}) {
  const text = useProviderCopy();
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ModelTestResult["results"] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = ModelTestResponse.parse(
        await api("identity/catalog/models/test", {
          ...state.target,
          modelId: model.id,
          revision: model.revision,
        }),
      );
      setResults(response.results);
    } catch (failure) {
      setResults(null);
      setError(catalogIssue(failure, state.copy));
    } finally {
      setBusy(false);
    }
  }
  const declared = results ? testedCapabilities(results) : {};
  return (
    <div className="flex flex-col gap-3" data-testid="model-capability-test">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy || state.busy}
          onClick={() => void run()}
        >
          {busy ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <FlaskConical data-icon="inline-start" aria-hidden="true" />
          )}
          {busy ? text.testRunning : text.testCapabilities}
        </Button>
        {results && Object.keys(declared).length > 0 && (
          <Button
            type="button"
            variant="ghost"
            disabled={busy || state.busy}
            onClick={() => onApply(declared)}
          >
            {text.applyResults}
          </Button>
        )}
      </div>
      <FieldDescription>{text.testHint}</FieldDescription>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {results &&
        (results.length ? (
          <ul className="flex flex-col divide-y rounded-md border">
            {results.map((result) => (
              <li
                key={result.capability}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
              >
                <span>{text.probes[result.capability]}</span>
                <Badge
                  variant={
                    result.status === "supported"
                      ? "secondary"
                      : result.status === "failed"
                        ? "destructive"
                        : "outline"
                  }
                  title={result.error}
                >
                  {text.testStatus[result.status]}
                </Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{text.testNothing}</p>
        ))}
    </div>
  );
}
