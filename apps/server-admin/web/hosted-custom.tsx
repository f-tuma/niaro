import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, Trash2, TriangleAlert } from "lucide-react";
import {
  HostedDefinitionInput,
  HostedPackageInfo,
} from "../../../packages/protocol/hosted";
import { useAdmin } from "./context";
import { api, ApiError } from "./lib/api";
import { useHostedCommand } from "./hosted-page";
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
  add: "Add custom server",
  description: "Runs isolated in the Docker sandbox.",
  source: "Source",
  npm: "npm package",
  image: "Docker image",
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
  install: "Add server",
  cancel: "Cancel",
  unknown: "The package or version was not found.",
  invalid: "Check the fields: exact version, image digest and {port}.",
  error: "The request failed. Try again.",
};
const cs: typeof en = {
  add: "Přidat vlastní server",
  description: "Běží izolovaně v Docker sandboxu.",
  source: "Zdroj",
  npm: "npm balíček",
  image: "Docker image",
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
  install: "Přidat server",
  cancel: "Zrušit",
  unknown: "Balíček nebo verze nebyla nalezena.",
  invalid: "Zkontroluj pole: přesnou verzi, digest image a {port}.",
  error: "Požadavek selhal. Zkus to znovu.",
};
type Env = { name: string; value: string; secret: boolean };

export function CustomServer({ organizationId }: { organizationId: string }) {
  const copy = useAdmin().language === "cs" ? cs : en;
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus data-icon="inline-start" aria-hidden="true" />
        {copy.add}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent size="lg">
          {open && (
            <CustomForm
              key="form"
              copy={copy}
              organizationId={organizationId}
              done={() => setOpen(false)}
            />
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
function CustomForm({
  copy,
  organizationId,
  done,
}: {
  copy: typeof en;
  organizationId: string;
  done: () => void;
}) {
  const command = useHostedCommand(organizationId);
  const [source, setSource] = useState<"npm" | "image">("npm");
  const [name, setName] = useState("");
  const [pkg, setPkg] = useState("");
  const [version, setVersion] = useState("");
  const [bin, setBin] = useState<string | undefined>();
  const [image, setImage] = useState("");
  const [port, setPort] = useState("8080");
  const [args, setArgs] = useState("--port\n{port}");
  const [env, setEnv] = useState<Env[]>([]);
  const [invalid, setInvalid] = useState(false);
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
  const lines = args
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean);
  function submit() {
    setInvalid(false);
    const variables = env
      .filter((e) => e.name.trim())
      .map((e) => ({
        name: e.name.trim(),
        secret: e.secret,
        ...(e.value ? { value: e.value } : {}),
      }));
    const definition = HostedDefinitionInput.safeParse(
      source === "npm"
        ? {
            source,
            package: pkg.trim(),
            version: version.trim(),
            ...(bin ? { bin } : {}),
            args: lines,
            env: variables,
          }
        : {
            source,
            image: image.trim(),
            port: Number(port),
            args: lines,
            env: variables,
          },
    );
    if (!definition.success || !name.trim()) {
      setInvalid(true);
      return;
    }
    command.mutate(
      {
        type: "createCustom",
        name: name.trim(),
        definition: definition.data,
      },
      { onSuccess: done },
    );
  }
  const failure = invalid
    ? copy.invalid
    : lookup.error instanceof ApiError &&
        lookup.error.code === "hosted_package_unknown"
      ? copy.unknown
      : lookup.error || command.error
        ? copy.error
        : null;
  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <SheetHeader>
        <SheetTitle>{copy.add}</SheetTitle>
        <SheetDescription>{copy.description}</SheetDescription>
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
              <ToggleGroupItem value="image">{copy.image}</ToggleGroupItem>
            </ToggleGroup>
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
                <FieldLabel htmlFor="custom-image">{copy.imageRef}</FieldLabel>
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
                          i === index ? { ...v, secret: checked === true } : v,
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
        </FieldGroup>
      </fieldset>
      <SheetFooter>
        <Button type="button" variant="ghost" onClick={done}>
          {copy.cancel}
        </Button>
        <SubmitButton
          pending={command.isPending}
          disabled={
            source === "npm"
              ? !info || (info.bins.length > 1 && !bin)
              : !image.trim()
          }
        >
          {copy.install}
        </SubmitButton>
      </SheetFooter>
    </form>
  );
}
