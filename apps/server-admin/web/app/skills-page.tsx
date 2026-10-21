import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Skeleton } from "@admin/components/ui/skeleton";
import { PageHeader, Section } from "@admin/components/console/page";
import {
  SkillEditor,
  SkillRows,
  SkillsEmpty,
  SkillsLoadFailed,
  skillsKey,
  useSkill,
  useSkillList,
} from "../skill-editor";
import { skillsCopy } from "../skills-copy";
import { useApp } from "./context";
import { useAppCopy } from "./copy";
import { MenuPage } from "./menu-page";

/** `/skills/new` creates a personal skill, `/skills/new-company` a company one (admins). */
const NEW = { personal: "new", workspace: "new-company" } as const;

function useTarget() {
  const { workspace } = useApp();
  return {
    organizationId: workspace.organizationId,
    workspaceId: workspace.workspaceId,
  };
}

/** "Mine" (the person's own) and "Company" skills. */
export function SkillsPage() {
  const { language, isAdmin } = useApp();
  const appCopy = useAppCopy();
  const copy = skillsCopy[language];
  const target = useTarget();
  const navigate = useNavigate();
  const list = useSkillList(target);
  const open = (id: string) =>
    void navigate({ to: "/skills/$skillId", params: { skillId: id } });
  const create = (owner: "personal" | "workspace") => (
    <Button
      variant={owner === "workspace" ? "outline" : "default"}
      size={owner === "workspace" ? "sm" : "default"}
      asChild
    >
      <Link to="/skills/$skillId" params={{ skillId: NEW[owner] }}>
        <Plus data-icon="inline-start" aria-hidden="true" />
        {copy.add}
      </Link>
    </Button>
  );
  return (
    <MenuPage>
      <PageHeader
        title={appCopy.skills}
        actions={list.data?.personal.length ? create("personal") : undefined}
      />
      {list.isError ? (
        <SkillsLoadFailed copy={copy} onRetry={() => void list.refetch()} />
      ) : list.isPending ? (
        <div role="status" aria-label={appCopy.loading}>
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <>
          <Section
            id="skills-mine"
            title={copy.mine}
            count={list.data.personal.length || undefined}
          >
            {list.data.personal.length ? (
              <SkillRows
                skills={list.data.personal}
                copy={copy}
                onOpen={(skill) => open(skill.id)}
              />
            ) : (
              <SkillsEmpty
                title={copy.emptyMine}
                hint={copy.emptyMineHint}
                action={create("personal")}
              />
            )}
          </Section>
          {(list.data.workspace.length > 0 || isAdmin) && (
            <Section
              id="skills-company"
              title={copy.company}
              count={list.data.workspace.length || undefined}
              actions={
                list.data.canManageWorkspace && list.data.workspace.length
                  ? create("workspace")
                  : undefined
              }
            >
              {list.data.workspace.length ? (
                <SkillRows
                  skills={list.data.workspace}
                  copy={copy}
                  onOpen={(skill) => open(skill.id)}
                />
              ) : (
                <SkillsEmpty
                  title={copy.emptyCompany}
                  hint={copy.emptyCompanyHint}
                  action={
                    list.data.canManageWorkspace
                      ? create("workspace")
                      : undefined
                  }
                />
              )}
            </Section>
          )}
        </>
      )}
    </MenuPage>
  );
}

/** One skill, or a new one: editable by its owner and, for company skills, administrators. */
export function SkillPage() {
  const { language, isAdmin } = useApp();
  const copy = skillsCopy[language];
  const target = useTarget();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { skillId } = useParams({ strict: false }) as { skillId?: string };
  const owner =
    skillId === NEW.workspace && isAdmin
      ? "workspace"
      : skillId === NEW.personal
        ? "personal"
        : null;
  const skill = useSkill(target, owner ? null : (skillId ?? null));
  // Phones only, like `PageHeader`'s back link; the sidebar serves a desktop.
  const back = (
    <Button
      variant="ghost"
      size="sm"
      asChild
      className="-ml-2 self-start md:hidden"
    >
      <Link to="/skills">
        <ArrowLeft data-icon="inline-start" aria-hidden="true" />
        {copy.back}
      </Link>
    </Button>
  );
  const refresh = () =>
    client.invalidateQueries({ queryKey: skillsKey(target) });
  return (
    <MenuPage>
      {!owner && skill.isError ? (
        <>
          {back}
          <SkillsLoadFailed
            copy={copy}
            message={copy.notFound}
            onRetry={() => void skill.refetch()}
          />
        </>
      ) : !owner && skill.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <SkillEditor
          key={skill.data ? `${skill.data.id}:${skill.data.revision}` : skillId}
          target={target}
          copy={copy}
          skill={owner ? undefined : skill.data}
          owner={owner ?? "personal"}
          readOnly={skill.data?.owner.type === "workspace" && !isAdmin}
          back={back}
          onSaved={(saved) => {
            client.setQueryData(
              [...skillsKey(target), "skill", saved.id],
              saved,
            );
            void refresh();
            if (owner)
              void navigate({
                to: "/skills/$skillId",
                params: { skillId: saved.id },
                replace: true,
              });
          }}
          onArchived={() => {
            void refresh();
            void navigate({ to: "/skills" });
          }}
        />
      )}
    </MenuPage>
  );
}
