import { useId, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronRight,
  FilePlus,
  FileText,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Card } from "@admin/components/ui/card";
import { Input } from "@admin/components/ui/input";
import { Textarea } from "@admin/components/ui/textarea";
import { Switch } from "@admin/components/ui/switch";
import { Markdown } from "@admin/components/ui/markdown";
import {
  Alert,
  AlertAction,
  AlertDescription,
} from "@admin/components/ui/alert";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@admin/components/ui/field";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@admin/components/ui/tabs";
import {
  DropdownMenuItem,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@admin/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@admin/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@admin/components/ui/item";
import { PageHeader, Section } from "@admin/components/console/page";
import { SettingRow, SettingRows } from "@admin/components/console/setting-row";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { StatusBadge, StatusDot } from "@admin/components/console/status";
import { CodeBlock, Disclosure } from "@admin/components/console/disclosure";
import {
  ConfirmAction,
  MoreActions,
  SaveBar,
  SubmitButton,
} from "@admin/components/console/forms";
import {
  SKILLS_PROFILE,
  SKILL_LIMITS,
  SkillContentSchema,
  SkillFileSchema,
  SkillListSchema,
  SkillSchema,
  utf8Length,
  type Skill,
  type SkillContent,
  type SkillSummary,
} from "../../../packages/protocol/skills";
import { api, ApiError } from "./lib/api";
import type { SkillsCopy } from "./skills-copy";

/** The workspace a skills page works in. */
export type SkillTarget = { organizationId: string; workspaceId: string };
export const skillsKey = (target: SkillTarget) =>
  ["skills", target.organizationId, target.workspaceId] as const;

export function useSkillList(target: SkillTarget, enabled = true) {
  return useQuery({
    queryKey: [...skillsKey(target), "list"],
    queryFn: async ({ signal }) =>
      SkillListSchema.parse(await api("identity/skills/list", target, signal)),
    enabled,
    retry: false,
  });
}
export function useSkill(target: SkillTarget, id: string | null) {
  return useQuery({
    queryKey: [...skillsKey(target), "skill", id],
    queryFn: async ({ signal }) =>
      SkillSchema.parse(
        await api("identity/skills/get", { ...target, id }, signal),
      ),
    enabled: !!id,
    retry: false,
  });
}
export function skillError(error: unknown, copy: SkillsCopy): string {
  if (error instanceof ApiError) {
    if (error.code === "skill_name_taken") return copy.nameTaken;
    if (error.code === "skill_conflict") return copy.conflict;
    if (error.code === "skill_forbidden") return copy.forbidden;
    if (error.code === "skill_limit") return copy.limit;
    if (error.code === "skill_not_found") return copy.notFound;
    if (error.code === "identity_account_required") return copy.accountRequired;
    if (error.status === 400 || error.status === 413) return copy.invalid;
  }
  return copy.saveFailed;
}

/** A list of skills; a row opens the skill. */
export function SkillRows({
  skills,
  copy,
  onOpen,
}: {
  skills: SkillSummary[];
  copy: SkillsCopy;
  onOpen: (skill: SkillSummary) => void;
}) {
  return (
    <Card variant="list">
      {skills.map((skill) => (
        <Item key={skill.id} asChild variant="row" size="row">
          <button
            type="button"
            className="text-left"
            onClick={() => onOpen(skill)}
          >
            <ItemMedia>
              <EntityIcon size="sm" tone="muted">
                <Sparkles />
              </EntityIcon>
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{skill.name}</ItemTitle>
              <ItemDescription>{skill.description}</ItemDescription>
            </ItemContent>
            <ItemActions>
              {!skill.enabled && (
                <StatusDot tone="neutral" size="sm">
                  {copy.off}
                </StatusDot>
              )}
              <ChevronRight aria-hidden="true" />
            </ItemActions>
          </button>
        </Item>
      ))}
    </Card>
  );
}

export function SkillsEmpty({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <Empty variant="outline">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Sparkles aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {hint && <EmptyDescription>{hint}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function SkillsLoadFailed({
  copy,
  onRetry,
  message,
}: {
  copy: SkillsCopy;
  onRetry: () => void;
  message?: string;
}) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{message ?? copy.loadFailed}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {copy.retry}
        </Button>
      </AlertAction>
    </Alert>
  );
}

type Draft = { content: SkillContent; enabled: boolean };
const emptyDraft = (): Draft => ({
  content: { name: "", description: "", instructions: "", files: [] },
  enabled: true,
});
const fromSkill = (skill?: Skill): Draft =>
  skill
    ? {
        content: {
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
          files: skill.files,
        },
        enabled: skill.enabled,
      }
    : emptyDraft();
const kilobytes = (bytes: number) =>
  (Math.ceil((bytes / 1024) * 10) / 10).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  });

/**
 * Creating and editing one skill: name, when to use it, Markdown instructions
 * with a preview, small text files and on/off. `readOnly` shows a company
 * skill to someone who may use it but not change it.
 */
export function SkillEditor({
  target,
  copy,
  skill,
  owner,
  readOnly = false,
  back,
  onSaved,
  onArchived,
}: {
  target: SkillTarget;
  copy: SkillsCopy;
  skill?: Skill;
  /** Who a new skill belongs to; ignored for an existing skill. */
  owner: "personal" | "workspace";
  readOnly?: boolean;
  back?: ReactNode;
  onSaved: (skill: Skill) => void;
  onArchived: () => void;
}) {
  const id = useId();
  const upload = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Draft>(() => fromSkill(skill));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const initial = JSON.stringify(fromSkill(skill));
  const dirty = JSON.stringify(draft) !== initial;
  const parsed = SkillContentSchema.safeParse(draft.content);
  const invalid = new Set(
    parsed.success
      ? []
      : parsed.error.issues.map((issue) => String(issue.path[0])),
  );
  const show = (field: string) => checked && invalid.has(field);
  const bytes = utf8Length(draft.content.instructions);
  const company =
    (skill?.owner.type ?? (owner === "workspace" ? "workspace" : "user")) ===
    "workspace";
  const edit = (change: Partial<SkillContent>) =>
    setDraft((current) => ({
      ...current,
      content: { ...current.content, ...change },
    }));
  const editFile = (
    index: number,
    change: Partial<SkillContent["files"][number]>,
  ) =>
    edit({
      files: draft.content.files.map((file, i) =>
        i === index ? { ...file, ...change } : file,
      ),
    });

  async function addUpload(files: FileList | null) {
    const file = files?.[0];
    if (upload.current) upload.current.value = "";
    if (!file) return;
    if (draft.content.files.length >= SKILL_LIMITS.files) {
      setError(copy.filesFull);
      return;
    }
    const value = SkillFileSchema.safeParse({
      name: file.name,
      content: file.size <= SKILL_LIMITS.fileBytes ? await file.text() : "",
    });
    if (!value.success || file.size > SKILL_LIMITS.fileBytes) {
      setError(copy.fileInvalid);
      return;
    }
    setError(null);
    edit({ files: [...draft.content.files, value.data] });
  }
  function addFile() {
    if (draft.content.files.length >= SKILL_LIMITS.files) {
      setError(copy.filesFull);
      return;
    }
    const names = new Set(draft.content.files.map((file) => file.name));
    let n = 1;
    while (names.has(n === 1 ? "poznamky.md" : `poznamky-${n}.md`)) n++;
    edit({
      files: [
        ...draft.content.files,
        { name: n === 1 ? "poznamky.md" : `poznamky-${n}.md`, content: "" },
      ],
    });
  }
  async function submit() {
    setChecked(true);
    if (!parsed.success) {
      setError(copy.invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = SkillSchema.parse(
        await api("identity/skills/command", {
          ...target,
          profile: SKILLS_PROFILE,
          type: "save",
          ...(skill ? { id: skill.id } : { owner }),
          revision: skill?.revision ?? 0,
          content: parsed.data,
          enabled: draft.enabled,
        }),
      );
      setChecked(false);
      onSaved(saved);
    } catch (failure) {
      setError(skillError(failure, copy));
    } finally {
      setBusy(false);
    }
  }
  async function archive() {
    if (!skill) return;
    setBusy(true);
    setError(null);
    try {
      await api("identity/skills/command", {
        ...target,
        profile: SKILLS_PROFILE,
        type: "archive",
        id: skill.id,
        revision: skill.revision,
      });
      onArchived();
    } catch (failure) {
      setError(skillError(failure, copy));
    } finally {
      setBusy(false);
    }
  }

  const header = (
    <PageHeader
      title={skill?.name ?? copy.newSkill}
      media={
        <EntityIcon size="lg">
          <Sparkles />
        </EntityIcon>
      }
      meta={
        skill || company ? (
          <>
            {company && (
              <StatusBadge tone="info">{copy.companyBadge}</StatusBadge>
            )}
            {skill && !skill.enabled && (
              <StatusBadge tone="neutral">{copy.off}</StatusBadge>
            )}
            {readOnly && (
              <StatusBadge tone="neutral">{copy.readOnly}</StatusBadge>
            )}
          </>
        ) : undefined
      }
      actions={
        skill && !readOnly ? (
          <MoreActions label={copy.more}>
            <DropdownMenuItem
              variant="destructive"
              disabled={busy}
              onSelect={() => setConfirm(true)}
            >
              <Trash2 aria-hidden="true" />
              {copy.delete}
            </DropdownMenuItem>
          </MoreActions>
        ) : undefined
      }
    />
  );

  if (readOnly && skill)
    return (
      <div className="flex flex-col gap-8">
        {back}
        {header}
        <p className="text-muted-foreground">{skill.description}</p>
        <Section title={copy.instructions}>
          <Markdown text={skill.instructions} />
        </Section>
        {skill.files.length > 0 && (
          <Section title={copy.files} count={skill.files.length}>
            <div className="flex flex-col gap-2">
              {skill.files.map((file) => (
                <Disclosure key={file.name} title={file.name}>
                  <CodeBlock value={file.content} />
                </Disclosure>
              ))}
            </div>
          </Section>
        )}
      </div>
    );

  return (
    <form
      className="flex flex-col gap-8"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {back}
      {header}
      <FieldGroup>
        <Field data-invalid={show("name")}>
          <FieldLabel htmlFor={`${id}-name`}>{copy.name}</FieldLabel>
          <Input
            id={`${id}-name`}
            value={draft.content.name}
            maxLength={SKILL_LIMITS.name}
            autoComplete="off"
            aria-invalid={show("name")}
            onChange={(event) => edit({ name: event.target.value })}
          />
        </Field>
        <Field data-invalid={show("description")}>
          <FieldLabel htmlFor={`${id}-when`}>{copy.whenToUse}</FieldLabel>
          <Textarea
            id={`${id}-when`}
            value={draft.content.description}
            maxLength={SKILL_LIMITS.description}
            aria-invalid={show("description")}
            onChange={(event) => edit({ description: event.target.value })}
          />
        </Field>
        <Field data-invalid={show("instructions")}>
          <FieldLabel htmlFor={`${id}-instructions`}>
            {copy.instructions}
          </FieldLabel>
          <Tabs defaultValue="edit">
            <div className="border-b">
              <TabsList variant="line">
                <TabsTrigger value="edit">{copy.edit}</TabsTrigger>
                <TabsTrigger value="preview">{copy.preview}</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="edit" className="mt-3">
              <Textarea
                id={`${id}-instructions`}
                value={draft.content.instructions}
                aria-invalid={show("instructions")}
                aria-describedby={`${id}-size`}
                onChange={(event) => edit({ instructions: event.target.value })}
              />
            </TabsContent>
            <TabsContent value="preview" className="mt-3">
              {draft.content.instructions.trim() ? (
                <Markdown text={draft.content.instructions} />
              ) : (
                <p className="text-muted-foreground">{copy.nothingToPreview}</p>
              )}
            </TabsContent>
          </Tabs>
          <FieldDescription id={`${id}-size`}>
            {copy.size
              .replace("{used}", kilobytes(bytes))
              .replace(
                "{limit}",
                String(SKILL_LIMITS.instructionsBytes / 1024),
              )}
          </FieldDescription>
        </Field>
      </FieldGroup>
      <Section
        title={copy.files}
        count={draft.content.files.length || undefined}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={draft.content.files.length >= SKILL_LIMITS.files}
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                {copy.addFile}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={addFile}>
                <FilePlus aria-hidden="true" />
                {copy.newFile}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => upload.current?.click()}>
                <Upload aria-hidden="true" />
                {copy.uploadFile}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      >
        <input
          ref={upload}
          type="file"
          hidden
          accept=".md,.markdown,.txt,.csv,.tsv,.json,.yaml,.yml"
          aria-label={copy.uploadFile}
          onChange={(event) => void addUpload(event.target.files)}
        />
        {draft.content.files.length ? (
          <div className="flex flex-col gap-2">
            {draft.content.files.map((file, index) => (
              <Disclosure
                key={index}
                title={
                  <span className="flex min-w-0 items-center gap-2">
                    <FileText aria-hidden="true" />
                    <span className="truncate">
                      {file.name || copy.fileName}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {kilobytes(utf8Length(file.content))} KB
                    </span>
                  </span>
                }
              >
                <FieldGroup>
                  <Field data-invalid={show("files")}>
                    <FieldLabel htmlFor={`${id}-file-${index}`}>
                      {copy.fileName}
                    </FieldLabel>
                    <div className="flex gap-2">
                      <Input
                        id={`${id}-file-${index}`}
                        value={file.name}
                        maxLength={80}
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={
                          checked &&
                          !SkillFileSchema.shape.name.safeParse(file.name)
                            .success
                        }
                        onChange={(event) =>
                          editFile(index, { name: event.target.value })
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`${copy.removeFile} ${file.name}`}
                        onClick={() =>
                          edit({
                            files: draft.content.files.filter(
                              (_, i) => i !== index,
                            ),
                          })
                        }
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    </div>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor={`${id}-content-${index}`}>
                      {copy.fileContent}
                    </FieldLabel>
                    <Textarea
                      id={`${id}-content-${index}`}
                      mono
                      value={file.content}
                      onChange={(event) =>
                        editFile(index, { content: event.target.value })
                      }
                    />
                  </Field>
                </FieldGroup>
              </Disclosure>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{copy.filesHint}</p>
        )}
        {show("files") && <FieldError>{copy.fileInvalid}</FieldError>}
      </Section>
      <SettingRows>
        <SettingRow label={copy.enabled} htmlFor={`${id}-enabled`}>
          <Switch
            id={`${id}-enabled`}
            checked={draft.enabled}
            onCheckedChange={(enabled) =>
              setDraft((current) => ({ ...current, enabled }))
            }
          />
        </SettingRow>
      </SettingRows>
      {(dirty || !skill || error) && (
        <SaveBar
          status={error ?? (dirty ? copy.unsaved : undefined)}
          tone={error ? "error" : "muted"}
        >
          {skill && dirty && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setDraft(fromSkill(skill));
                setChecked(false);
                setError(null);
              }}
            >
              {copy.discard}
            </Button>
          )}
          <SubmitButton pending={busy} disabled={!dirty && !!skill}>
            {copy.save}
          </SubmitButton>
        </SaveBar>
      )}
      <ConfirmAction
        open={confirm}
        onOpenChange={setConfirm}
        title={copy.deleteTitle}
        description={copy.deleteHint}
        confirmLabel={copy.delete}
        cancelLabel={copy.cancel}
        onConfirm={archive}
      />
    </form>
  );
}
