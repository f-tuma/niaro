import { useId } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Input } from "@admin/components/ui/input";
import { Switch } from "@admin/components/ui/switch";
import { Field, FieldLabel, FieldGroup } from "@admin/components/ui/field";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@admin/components/ui/select";
import {
  ProcessKey,
  type ProcessData,
} from "../../../packages/protocol/service-processes";
import type { EditorCopy } from "./process-editor-copy";

const emptyObject = (): ProcessData => ({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});
function ofType(type: ProcessData["type"]): ProcessData {
  if (type === "object") return emptyObject();
  if (type === "array") return { type, items: { type: "string" } };
  return { type };
}
type Props = {
  label: string;
  value: ProcessData;
  disabled: boolean;
  copy: EditorCopy;
  drafts: Record<string, string>;
  onDraft(key: string, text: string | null): void;
  onChange(value: ProcessData): void;
};

/** Edits the same closed, bounded schema that execution validates. No inferred remote contract. */
export function ProcessSchemaFields(props: Props) {
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-3 rounded-lg border p-3"
      disabled={props.disabled}
    >
      <legend className="px-1 text-sm font-medium">{props.label}</legend>
      <SchemaValue {...props} path="root" depth={0} />
    </fieldset>
  );
}
function SchemaValue({
  value,
  copy,
  disabled,
  drafts,
  onDraft,
  onChange,
  path,
  depth,
}: Props & { path: string; depth: number }) {
  const id = useId();
  const types = [
    "string",
    "number",
    "integer",
    "boolean",
    "null",
    ...(depth < 6 ? ["object", "array"] : []),
  ] as ProcessData["type"][];
  const clearDrafts = () => {
    for (const key of Object.keys(drafts))
      if (key.startsWith(path + "/")) onDraft(key, null);
  };
  const removeRowDrafts = (index: number) => {
    const shifted: [string, string][] = [];
    for (const [key, text] of Object.entries(drafts)) {
      const names = key.startsWith(`${path}/name/`);
      const prefix = names ? `${path}/name/` : `${path}/`;
      if (!key.startsWith(prefix)) continue;
      const match = /^(\d+)(\/.*)?$/.exec(key.slice(prefix.length));
      if (!match || Number(match[1]) < index) continue;
      onDraft(key, null);
      if (Number(match[1]) > index)
        shifted.push([
          `${prefix}${Number(match[1]) - 1}${match[2] ?? ""}`,
          text,
        ]);
    }
    for (const [key, text] of shifted) onDraft(key, text);
  };
  return (
    <FieldGroup>
      {depth > 0 && (
        <Field>
          <FieldLabel htmlFor={id}>{copy.literalType}</FieldLabel>
          <Select
            value={value.type}
            disabled={disabled}
            onValueChange={(type) => {
              clearDrafts();
              onChange(ofType(type as ProcessData["type"]));
            }}
          >
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {types.map((type) => (
                  <SelectItem key={type} value={type}>
                    {copy[type]}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      )}
      {value.type === "object" && (
        <>
          {!Object.keys(value.properties).length && (
            <p className="text-sm text-muted-foreground">{copy.noFields}</p>
          )}
          {Object.entries(value.properties).map(([name, child], index) => {
            const nameKey = `${path}/name/${index}`;
            const proposed = drafts[nameKey] ?? name;
            const valid =
              ProcessKey.safeParse(proposed).success &&
              (proposed === name || !Object.hasOwn(value.properties, proposed));
            return (
              <div
                key={index}
                className="flex flex-col gap-3 rounded-md border p-3"
              >
                <Field>
                  <FieldLabel htmlFor={`${id}-${index}`}>
                    {copy.fieldName}
                  </FieldLabel>
                  <div className="flex gap-2">
                    <Input
                      id={`${id}-${index}`}
                      value={proposed}
                      maxLength={64}
                      disabled={disabled}
                      aria-invalid={!valid}
                      onChange={(e) =>
                        onDraft(
                          nameKey,
                          e.target.value === name ? null : e.target.value,
                        )
                      }
                    />
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled || proposed === name || !valid}
                      onClick={() => {
                        const properties = Object.fromEntries(
                          Object.entries(value.properties).map(([key, v]) => [
                            key === name ? proposed : key,
                            v,
                          ]),
                        );
                        onChange({
                          ...value,
                          properties,
                          required: value.required.map((key) =>
                            key === name ? proposed : key,
                          ),
                        });
                        onDraft(nameKey, null);
                      }}
                    >
                      {copy.renameField}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`${copy.removeField}: ${name}`}
                      disabled={disabled}
                      onClick={() => {
                        const properties = { ...value.properties };
                        delete properties[name];
                        removeRowDrafts(index);
                        onChange({
                          ...value,
                          properties,
                          required: value.required.filter(
                            (key) => key !== name,
                          ),
                        });
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                  {!valid && (
                    <p role="alert" className="text-sm text-destructive">
                      {copy.fieldNameInvalid}
                    </p>
                  )}
                </Field>
                <Field orientation="horizontal">
                  <Switch
                    id={`${id}-required-${index}`}
                    checked={value.required.includes(name)}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      onChange({
                        ...value,
                        required: checked
                          ? [...value.required, name]
                          : value.required.filter((key) => key !== name),
                      })
                    }
                  />
                  <FieldLabel htmlFor={`${id}-required-${index}`}>
                    {copy.required}
                  </FieldLabel>
                </Field>
                <SchemaValue
                  label={name}
                  value={child}
                  copy={copy}
                  disabled={disabled}
                  drafts={drafts}
                  onDraft={onDraft}
                  path={`${path}/${index}`}
                  depth={depth + 1}
                  onChange={(schema) =>
                    onChange({
                      ...value,
                      properties: { ...value.properties, [name]: schema },
                    })
                  }
                />
              </div>
            );
          })}
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || Object.keys(value.properties).length >= 40}
            onClick={() => {
              let index = 1;
              while (Object.hasOwn(value.properties, `field_${index}`)) index++;
              const name = `field_${index}`;
              onChange({
                ...value,
                properties: { ...value.properties, [name]: { type: "string" } },
                required: [...value.required, name],
              });
            }}
          >
            <Plus aria-hidden="true" data-icon="inline-start" />
            {copy.addField}
          </Button>
        </>
      )}
      {value.type === "array" && (
        <div className="rounded-md border p-3">
          <p className="mb-3 text-sm font-medium">{copy.arrayItem}</p>
          <SchemaValue
            label={copy.arrayItem}
            value={value.items}
            copy={copy}
            disabled={disabled}
            drafts={drafts}
            onDraft={onDraft}
            path={`${path}/items`}
            depth={depth + 1}
            onChange={(items) => onChange({ ...value, items })}
          />
        </div>
      )}
    </FieldGroup>
  );
}
