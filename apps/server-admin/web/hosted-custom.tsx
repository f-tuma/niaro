import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, Trash2, TriangleAlert, Upload } from "lucide-react";
import type { z } from "zod";
import {
  HostedDefinition,
  HostedPackageInfo,
  type HostedServer,
} from "../../../packages/protocol/hosted";
import { useAdmin } from "./context";
import { api, ApiError } from "./lib/api";
import { sourceLabel, useHostedCommand } from "./hosted-page";
import { Disclosure } from "@admin/components/console/disclosure";
import { DetailList, SubmitButton } from "@admin/components/console/forms";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Textarea } from "@admin/components/ui/textarea";
import { Checkbox } from "@admin/components/ui/checkbox";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@admin/components/ui/field";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@admin/components/ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@admin/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@admin/components/ui/sheet";

const en = {
  add: "Add server",
  addNamed: "Add",
  custom: "Add custom server",
  docker: "Runs isolated in the Docker sandbox.",
  process: "Runs as a confined process of this server.",
  format: "Format",
  form: "Form",
  json: "Definition JSON",
  upload: "Upload",
  source: "Source",
  npm: "npm package",
  image: "Docker image",
  needsDocker: "Images need Docker, which this server doesn't have.",
  name: "Name",
  package: "Package",
  version: "Version",
  latest: "Latest if empty",
  lookup: "Look up",
  publisher: "Publisher",
  license: "License",
  published: "Published",
  integrity: "Integrity",
  scripts: "Install scripts never run here; it may not work.",
  bin: "Executable",
  imageRef: "Image",
  imageHint: "Pinned by digest, e.g. ghcr.io/org/server@sha256:…",
  port: "Port in the container",
  args: "Arguments",
  argsHint: "One per line. {port} is the listening port.",
  env: "Environment variables",
  envName: "Name",
  envValue: "Value",
  secret: "Secret",
  addEnv: "Add variable",
  removeEnv: "Remove variable",
  advanced: "Advanced",
  memory: "Memory (MB)",
  path: "MCP path",
  secrets: "Secrets",
  stored: "Stored, leave empty to keep",
  secretsHint: "Saving restarts the server.",
  save: "Save changes",
  cancel: "Cancel",
  unknown: "The package or version was not found.",
  invalid: "Check the definition",
  notJson: "Not a definition file.",
  jsonKept:
    "The JSON is not a complete definition; the form shows what could be read.",
  exists: "This server is already running for the organization.",
  limit: "The server limit has been reached.",
  error: "The request failed. Try again.",
};
const cs: typeof en = {
  add: "Přidat server",
  addNamed: "Přidat",
  custom: "Přidat vlastní server",
  docker: "Běží izolovaně v Docker sandboxu.",
  process: "Běží jako omezený proces tohoto serveru.",
  format: "Formát",
  form: "Formulář",
  json: "JSON definice",
  upload: "Nahrát",
  source: "Zdroj",
  npm: "npm balíček",
  image: "Docker image",
  needsDocker: "Image potřebuje Docker, který tento server nemá.",
  name: "Název",
  package: "Balíček",
  version: "Verze",
  latest: "Nejnovější, když je prázdné",
  lookup: "Načíst",
  publisher: "Vydavatel",
  license: "Licence",
  published: "Vydáno",
  integrity: "Otisk",
  scripts: "Instalační skripty se tu nespustí; nemusí fungovat.",
  bin: "Spustitelný soubor",
  imageRef: "Image",
  imageHint: "Pevně podle digestu, např. ghcr.io/org/server@sha256:…",
  port: "Port v kontejneru",
  args: "Argumenty",
  argsHint: "Jeden na řádek. {port} je port pro naslouchání.",
  env: "Proměnné prostředí",
  envName: "Název",
  envValue: "Hodnota",
  secret: "Tajné",
  addEnv: "Přidat proměnnou",
  removeEnv: "Odebrat proměnnou",
  advanced: "Pokročilé",
  memory: "Paměť (MB)",
  path: "Cesta MCP",
  secrets: "Tajné hodnoty",
  stored: "Uloženo, prázdné nech beze změny",
  secretsHint: "Uložení server restartuje.",
  save: "Uložit změny",
  cancel: "Zrušit",
  unknown: "Balíček nebo verze nebyla nalezena.",
  invalid: "Zkontroluj definici",
  notJson: "Tohle není soubor s definicí.",
  jsonKept: "JSON není úplná definice; formulář ukazuje, co z něj šlo přečíst.",
  exists: "Tento server pro organizaci už běží.",
  limit: "Byl dosažen limit počtu serverů.",
  error: "Požadavek selhal. Zkus to znovu.",
};
type Copy = typeof en;
type Env = { name: string; value: string; secret: boolean };
export type AddChoice =
  | "custom"
  | { builtin: { id: string; definition: HostedDefinition } };
function useCopy() {
  return useAdmin().language === "cs" ? cs : en;
}
/** A failed command in the sheet's own words. */
function commandFailure(error: unknown, copy: Copy) {
  if (!error) return null;
  const code = error instanceof ApiError ? error.code : undefined;
  return code === "hosted_docker_required"
    ? copy.needsDocker
    : code === "hosted_exists"
      ? copy.exists
      : code === "hosted_limit"
        ? copy.limit
        : code === "hosted_invalid"
          ? copy.invalid
          : copy.error;
}
/** The first problem, by field, e.g. "Check the definition: args: …". */
function issue(error: z.ZodError, copy: Copy) {
  const first = error.issues[0];
  const path = first?.path.join(".");
  return `${copy.invalid}: ${path ? `${path}: ` : ""}${first?.message ?? ""}`;
}
/** Only the declared names, without empty values. */
function filled(names: string[], values: Record<string, string>) {
  return Object.fromEntries(
    names.flatMap((name) => (values[name] ? [[name, values[name]]] : [])),
  );
}

export function AddServerSheet({
  choice,
  organizationId,
  docker,
  onClose,
}: {
  choice: AddChoice | null;
  organizationId: string;
  /** false: the process runtime, where images cannot run. */
  docker: boolean;
  onClose: () => void;
}) {
  const copy = useCopy();
  return (
    <Sheet open={!!choice} onOpenChange={(open) => !open && onClose()}>
      <SheetContent size="lg">
        {choice === "custom" ? (
          <CustomForm
            copy={copy}
            organizationId={organizationId}
            docker={docker}
            done={onClose}
          />
        ) : choice ? (
          <BuiltinForm
            key={choice.builtin.id}
            copy={copy}
            organizationId={organizationId}
            docker={docker}
            builtin={choice.builtin}
            done={onClose}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
function SecretFields({
  copy,
  names,
  values,
  stored = [],
  onChange,
}: {
  copy: Copy;
  names: string[];
  values: Record<string, string>;
  /** Names with a saved value: empty keeps it. */
  stored?: string[];
  onChange: (values: Record<string, string>) => void;
}) {
  if (!names.length) return null;
  return (
    <FieldSet>
      <FieldLegend variant="label">{copy.secrets}</FieldLegend>
      <FieldGroup>
        {names.map((name) => (
          <Field key={name}>
            <FieldLabel htmlFor={`hosted-secret-${name}`}>
              <span className="font-mono">{name}</span>
            </FieldLabel>
            <Input
              id={`hosted-secret-${name}`}
              type="password"
              autoComplete="off"
              maxLength={4096}
              placeholder={stored.includes(name) ? copy.stored : undefined}
              value={values[name] ?? ""}
              onChange={(e) => onChange({ ...values, [name]: e.target.value })}
            />
          </Field>
        ))}
      </FieldGroup>
    </FieldSet>
  );
}
function BuiltinForm({
  copy,
  organizationId,
  docker,
  builtin,
  done,
}: {
  copy: Copy;
  organizationId: string;
  docker: boolean;
  builtin: { id: string; definition: HostedDefinition };
  done: () => void;
}) {
  const command = useHostedCommand(organizationId);
  const [values, setValues] = useState<Record<string, string>>({});
  const definition = builtin.definition;
  const failure = commandFailure(command.error, copy);
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        command.mutate(
          {
            type: "create",
            builtin: builtin.id,
            secrets: filled(definition.secrets, values),
          },
          { onSuccess: done },
        );
      }}
    >
      <SheetHeader>
        <SheetTitle>
          {copy.addNamed} {definition.name}
        </SheetTitle>
        <SheetDescription>
          {docker ? copy.docker : copy.process}
        </SheetDescription>
      </SheetHeader>
      <fieldset
        disabled={command.isPending}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4"
      >
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <DetailList
          items={[
            {
              label: "npm" in definition.source ? copy.package : copy.imageRef,
              value: (
                <span className="font-mono break-all">
                  {sourceLabel(definition)}
                </span>
              ),
            },
            {
              label: copy.args,
              value: (
                <span className="font-mono break-all">
                  {definition.args.join(" ")}
                </span>
              ),
            },
          ]}
        />
        <SecretFields
          copy={copy}
          names={definition.secrets}
          values={values}
          onChange={setValues}
        />
      </fieldset>
      <SheetFooter>
        <Button type="button" variant="ghost" onClick={done}>
          {copy.cancel}
        </Button>
        <SubmitButton pending={command.isPending}>{copy.add}</SubmitButton>
      </SheetFooter>
    </form>
  );
}
function CustomForm({
  copy,
  organizationId,
  docker,
  done,
}: {
  copy: Copy;
  organizationId: string;
  docker: boolean;
  done: () => void;
}) {
  const command = useHostedCommand(organizationId);
  const upload = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [text, setText] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [source, setSource] = useState<"npm" | "image">("npm");
  const [name, setName] = useState("");
  const [pkg, setPkg] = useState("");
  const [version, setVersion] = useState("");
  const [bin, setBin] = useState<string | undefined>();
  const [image, setImage] = useState("");
  const [port, setPort] = useState("8080");
  const [args, setArgs] = useState("--port\n{port}");
  const [env, setEnv] = useState<Env[]>([]);
  const [memory, setMemory] = useState("512");
  const [path, setPath] = useState("/mcp");
  const [invalid, setInvalid] = useState<string | null>(null);
  const lookup = useMutation({
    mutationFn: async () =>
      HostedPackageInfo.parse(
        await api("identity/hosted/resolve", {
          organizationId,
          package: pkg.trim(),
          ...(version.trim() ? { version: version.trim() } : {}),
        }),
      ),
    onSuccess: (info) => {
      setVersion(info.version);
      setBin(info.bins.length === 1 ? info.bins[0] : undefined);
      if (!name.trim()) setName(info.package.split("/").at(-1) ?? info.package);
    },
  });
  const info = lookup.data;
  /** The form as a definition, unvalidated. */
  const fromForm = () => ({
    version: 1,
    name: name.trim(),
    source:
      source === "npm"
        ? {
            npm: pkg.trim(),
            version: version.trim(),
            ...(bin ? { bin } : {}),
          }
        : { image: image.trim(), port: Number(port) },
    args: args
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean),
    env: Object.fromEntries(
      env
        .filter((e) => !e.secret && e.name.trim())
        .map((e) => [e.name.trim(), e.value]),
    ),
    secrets: env
      .filter((e) => e.secret && e.name.trim())
      .map((e) => e.name.trim()),
    memoryMb: Number(memory),
    path: path.trim(),
  });
  const formSecrets = () =>
    Object.fromEntries(
      env
        .filter((e) => e.secret && e.name.trim())
        .map((e) => [e.name.trim(), e.value]),
    );
  const fill = (definition: HostedDefinition) => {
    const s = definition.source;
    setName(definition.name);
    if ("npm" in s) {
      setSource("npm");
      setPkg(s.npm);
      setVersion(s.version);
      setBin(s.bin);
    } else {
      setSource("image");
      setImage(s.image);
      setPort(String(s.port));
    }
    setArgs(definition.args.join("\n"));
    setEnv([
      ...Object.entries(definition.env).map(([n, v]) => ({
        name: n,
        value: v,
        secret: false,
      })),
      ...definition.secrets.map((n) => ({
        name: n,
        value: values[n] ?? "",
        secret: true,
      })),
    ]);
    setMemory(String(definition.memoryMb));
    setPath(definition.path);
  };
  const parsedText = () => {
    try {
      return HostedDefinition.safeParse(JSON.parse(text));
    } catch {
      return undefined;
    }
  };
  const fromText = mode === "json" ? parsedText() : undefined;
  /**
   * What an incomplete or invalid JSON still says, field by field, so the
   * form can take it over; a field that cannot be read keeps its value.
   */
  const fillPartial = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const o = raw as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    if (str(o.name) !== undefined) setName(str(o.name)!);
    const s =
      o.source && typeof o.source === "object" && !Array.isArray(o.source)
        ? (o.source as Record<string, unknown>)
        : undefined;
    if (s && "npm" in s) {
      setSource("npm");
      if (str(s.npm) !== undefined) setPkg(str(s.npm)!);
      if (str(s.version) !== undefined) setVersion(str(s.version)!);
      setBin(str(s.bin));
    } else if (s && "image" in s) {
      setSource("image");
      if (str(s.image) !== undefined) setImage(str(s.image)!);
      if (s.port !== undefined) setPort(String(s.port));
    }
    if (Array.isArray(o.args))
      setArgs(o.args.filter((a) => typeof a === "string").join("\n"));
    const envObject =
      o.env && typeof o.env === "object" && !Array.isArray(o.env)
        ? (o.env as Record<string, unknown>)
        : undefined;
    const secretNames = Array.isArray(o.secrets)
      ? o.secrets.filter((n): n is string => typeof n === "string")
      : undefined;
    if (envObject || secretNames)
      setEnv([
        ...Object.entries(envObject ?? {}).map(([n, v]) => ({
          name: n,
          value: typeof v === "string" ? v : String(v ?? ""),
          secret: false,
        })),
        ...(secretNames ?? []).map((n) => ({
          name: n,
          value: values[n] ?? "",
          secret: true,
        })),
      ]);
    if (o.memoryMb !== undefined) setMemory(String(o.memoryMb));
    if (str(o.path) !== undefined) setPath(str(o.path)!);
  };
  function switchMode(next: "form" | "json") {
    setInvalid(null);
    if (next === mode) return;
    if (next === "json") {
      setText(`${JSON.stringify(fromForm(), null, 2)}\n`);
      setValues(formSecrets());
      setMode("json");
      return;
    }
    // The form always opens: a draft that is not a complete definition yet
    // must not lock the person in the JSON view. What it says is taken over;
    // the first problem is shown so it can be fixed in the form.
    const parsed = parsedText();
    lookup.reset();
    if (parsed?.success) fill(parsed.data);
    else {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        raw = undefined;
      }
      if (raw === undefined) setInvalid(copy.notJson);
      else {
        fillPartial(raw);
        setInvalid(
          parsed
            ? `${copy.jsonKept} ${issue(parsed.error, copy)}`
            : copy.jsonKept,
        );
      }
    }
    setMode("form");
  }
  async function pick(files: FileList | null) {
    const file = files?.[0];
    if (upload.current) upload.current.value = "";
    if (!file) return;
    setInvalid(null);
    if (file.size > 65536) {
      setInvalid(copy.notJson);
      return;
    }
    setText(await file.text());
    setMode("json");
  }
  function submit() {
    setInvalid(null);
    let raw: unknown;
    if (mode === "json") {
      try {
        raw = JSON.parse(text);
      } catch {
        setInvalid(copy.notJson);
        return;
      }
    } else raw = fromForm();
    const parsed = HostedDefinition.safeParse(raw);
    if (!parsed.success) {
      setInvalid(issue(parsed.error, copy));
      return;
    }
    if (!docker && !("npm" in parsed.data.source)) {
      setInvalid(copy.needsDocker);
      return;
    }
    command.mutate(
      {
        type: "createCustom",
        definition: parsed.data,
        secrets: filled(
          parsed.data.secrets,
          mode === "json" ? values : formSecrets(),
        ),
      },
      { onSuccess: done },
    );
  }
  const failure =
    invalid ??
    (lookup.error instanceof ApiError &&
    lookup.error.code === "hosted_package_unknown"
      ? copy.unknown
      : lookup.error
        ? copy.error
        : commandFailure(command.error, copy));
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <SheetHeader>
        <SheetTitle>{copy.custom}</SheetTitle>
        <SheetDescription>
          {docker ? copy.docker : copy.process}
        </SheetDescription>
      </SheetHeader>
      <fieldset
        disabled={command.isPending}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4"
      >
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ToggleGroup
            type="single"
            variant="outline"
            aria-label={copy.format}
            value={mode}
            onValueChange={(value) =>
              value && switchMode(value as "form" | "json")
            }
          >
            <ToggleGroupItem value="form">{copy.form}</ToggleGroupItem>
            <ToggleGroupItem value="json">{copy.json}</ToggleGroupItem>
          </ToggleGroup>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => upload.current?.click()}
          >
            <Upload data-icon="inline-start" aria-hidden="true" />
            {copy.upload}
          </Button>
          <input
            ref={upload}
            type="file"
            hidden
            accept=".json,application/json"
            aria-label={copy.upload}
            onChange={(event) => void pick(event.target.files)}
          />
        </div>
        {mode === "json" ? (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="custom-json">{copy.json}</FieldLabel>
              <Textarea
                id="custom-json"
                mono
                rows={16}
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
              />
            </Field>
            <SecretFields
              copy={copy}
              names={fromText?.success ? fromText.data.secrets : []}
              values={values}
              onChange={setValues}
            />
          </FieldGroup>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel id="custom-source">{copy.source}</FieldLabel>
              <ToggleGroup
                type="single"
                variant="outline"
                aria-labelledby="custom-source"
                value={source}
                onValueChange={(value) =>
                  value && setSource(value as "npm" | "image")
                }
              >
                <ToggleGroupItem value="npm">{copy.npm}</ToggleGroupItem>
                <ToggleGroupItem value="image" disabled={!docker}>
                  {copy.image}
                </ToggleGroupItem>
              </ToggleGroup>
              {!docker && (
                <FieldDescription>{copy.needsDocker}</FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="custom-name">{copy.name}</FieldLabel>
              <Input
                id="custom-name"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            {source === "npm" ? (
              <>
                <div className="grid gap-5 sm:grid-cols-4 sm:items-end">
                  <Field className="sm:col-span-2">
                    <FieldLabel htmlFor="custom-package">
                      {copy.package}
                    </FieldLabel>
                    <Input
                      id="custom-package"
                      mono
                      value={pkg}
                      placeholder="@scope/mcp-server"
                      onChange={(e) => {
                        setPkg(e.target.value);
                        lookup.reset();
                      }}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="custom-version">
                      {copy.version}
                    </FieldLabel>
                    <Input
                      id="custom-version"
                      mono
                      value={version}
                      placeholder={copy.latest}
                      onChange={(e) => {
                        setVersion(e.target.value);
                        lookup.reset();
                      }}
                      spellCheck={false}
                      autoComplete="off"
                    />
                  </Field>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={!pkg.trim() || lookup.isPending}
                    onClick={() => lookup.mutate()}
                  >
                    {copy.lookup}
                  </Button>
                </div>
                {info && (
                  <>
                    {info.description && (
                      <FieldDescription>{info.description}</FieldDescription>
                    )}
                    <DetailList
                      items={[
                        { label: copy.version, value: info.version },
                        ...(info.publisher
                          ? [{ label: copy.publisher, value: info.publisher }]
                          : []),
                        ...(info.license
                          ? [{ label: copy.license, value: info.license }]
                          : []),
                        ...(info.published
                          ? [
                              {
                                label: copy.published,
                                value: new Date(
                                  info.published,
                                ).toLocaleDateString(),
                              },
                            ]
                          : []),
                        {
                          label: copy.integrity,
                          value: (
                            <span className="font-mono break-all">
                              {info.integrity}
                            </span>
                          ),
                        },
                      ]}
                    />
                    {info.hasInstallScripts && (
                      <Alert>
                        <TriangleAlert aria-hidden="true" />
                        <AlertDescription>{copy.scripts}</AlertDescription>
                      </Alert>
                    )}
                    {info.bins.length > 1 && (
                      <Field>
                        <FieldLabel htmlFor="custom-bin">{copy.bin}</FieldLabel>
                        <Select value={bin ?? ""} onValueChange={setBin}>
                          <SelectTrigger id="custom-bin" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {info.bins.map((b) => (
                                <SelectItem key={b} value={b}>
                                  {b}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </Field>
                    )}
                  </>
                )}
              </>
            ) : (
              <div className="grid gap-5 sm:grid-cols-3">
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="custom-image">
                    {copy.imageRef}
                  </FieldLabel>
                  <Input
                    id="custom-image"
                    mono
                    value={image}
                    onChange={(e) => setImage(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <FieldDescription>{copy.imageHint}</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="custom-port">{copy.port}</FieldLabel>
                  <Input
                    id="custom-port"
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                </Field>
              </div>
            )}
            <Field>
              <FieldLabel htmlFor="custom-args">{copy.args}</FieldLabel>
              <Textarea
                id="custom-args"
                mono
                rows={4}
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                spellCheck={false}
              />
              <FieldDescription>{copy.argsHint}</FieldDescription>
            </Field>
            <FieldSet>
              <FieldLegend variant="label">{copy.env}</FieldLegend>
              {env.map((item, index) => (
                <div
                  key={index}
                  className="grid gap-2 sm:grid-cols-6 sm:items-center"
                >
                  <Input
                    mono
                    className="sm:col-span-2"
                    aria-label={copy.envName}
                    placeholder="API_TOKEN"
                    value={item.name}
                    onChange={(e) =>
                      setEnv(
                        env.map((v, i) =>
                          i === index
                            ? { ...v, name: e.target.value.toUpperCase() }
                            : v,
                        ),
                      )
                    }
                  />
                  <Input
                    className="sm:col-span-2"
                    aria-label={copy.envValue}
                    type={item.secret ? "password" : "text"}
                    autoComplete="off"
                    value={item.value}
                    onChange={(e) =>
                      setEnv(
                        env.map((v, i) =>
                          i === index ? { ...v, value: e.target.value } : v,
                        ),
                      )
                    }
                  />
                  <Field orientation="horizontal" className="w-auto">
                    <Checkbox
                      id={`custom-secret-${index}`}
                      checked={item.secret}
                      onCheckedChange={(checked) =>
                        setEnv(
                          env.map((v, i) =>
                            i === index
                              ? { ...v, secret: checked === true }
                              : v,
                          ),
                        )
                      }
                    />
                    <FieldLabel htmlFor={`custom-secret-${index}`}>
                      {copy.secret}
                    </FieldLabel>
                  </Field>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={copy.removeEnv}
                    onClick={() => setEnv(env.filter((_, i) => i !== index))}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={env.length >= 30}
                onClick={() =>
                  setEnv([...env, { name: "", value: "", secret: true }])
                }
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                {copy.addEnv}
              </Button>
            </FieldSet>
            <Disclosure title={copy.advanced}>
              <div className="grid gap-5 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="custom-memory">{copy.memory}</FieldLabel>
                  <Input
                    id="custom-memory"
                    type="number"
                    min={128}
                    max={4096}
                    value={memory}
                    onChange={(e) => setMemory(e.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="custom-path">{copy.path}</FieldLabel>
                  <Input
                    id="custom-path"
                    mono
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </Field>
              </div>
            </Disclosure>
          </FieldGroup>
        )}
      </fieldset>
      <SheetFooter>
        <Button type="button" variant="ghost" onClick={done}>
          {copy.cancel}
        </Button>
        <SubmitButton
          pending={command.isPending}
          disabled={
            mode === "json"
              ? !text.trim()
              : source === "npm"
                ? !pkg.trim() ||
                  !version.trim() ||
                  (!!info && info.bins.length > 1 && !bin)
                : !image.trim()
          }
        >
          {copy.add}
        </SubmitButton>
      </SheetFooter>
    </form>
  );
}

/** New values for a server's declared secrets; an empty field keeps the stored one. */
export function SecretsSheet({
  server,
  organizationId,
  onClose,
}: {
  server: HostedServer | null;
  organizationId: string;
  onClose: () => void;
}) {
  const copy = useCopy();
  return (
    <Sheet open={!!server} onOpenChange={(open) => !open && onClose()}>
      <SheetContent>
        {server && (
          <SecretsForm
            key={server.id}
            copy={copy}
            server={server}
            organizationId={organizationId}
            done={onClose}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
function SecretsForm({
  copy,
  server,
  organizationId,
  done,
}: {
  copy: Copy;
  server: HostedServer;
  organizationId: string;
  done: () => void;
}) {
  const command = useHostedCommand(organizationId);
  const [values, setValues] = useState<Record<string, string>>({});
  const changed = filled(server.definition.secrets, values);
  const failure = commandFailure(command.error, copy);
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        command.mutate(
          {
            type: "secrets",
            id: server.id,
            revision: server.revision,
            secrets: changed,
          },
          { onSuccess: done },
        );
      }}
    >
      <SheetHeader>
        <SheetTitle>{server.definition.name}</SheetTitle>
        <SheetDescription>{copy.secretsHint}</SheetDescription>
      </SheetHeader>
      <fieldset
        disabled={command.isPending}
        className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4"
      >
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <SecretFields
          copy={copy}
          names={server.definition.secrets}
          values={values}
          stored={server.secretsSet}
          onChange={setValues}
        />
      </fieldset>
      <SheetFooter>
        <Button type="button" variant="ghost" onClick={done}>
          {copy.cancel}
        </Button>
        <SubmitButton
          pending={command.isPending}
          disabled={!Object.keys(changed).length}
        >
          {copy.save}
        </SubmitButton>
      </SheetFooter>
    </form>
  );
}
