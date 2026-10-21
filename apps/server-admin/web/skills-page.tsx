import { useEffect } from "react";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Skeleton } from "@admin/components/ui/skeleton";
import { PageHeader } from "@admin/components/console/page";
import { useAdmin } from "./context";
import { useConsoleScope } from "./console-scope";
import {
  SkillEditor,
  SkillRows,
  SkillsEmpty,
  SkillsLoadFailed,
  skillsKey,
  useSkill,
  useSkillList,
  type SkillTarget,
} from "./skill-editor";
import { skillsCopy } from "./skills-copy";

/** The workspace chosen in the console; null until it is known. */
function useSkillTarget(): SkillTarget | null {
  const scope = useConsoleScope();
  return scope.ready
    ? {
        organizationId: scope.organization!.id,
        workspaceId: scope.workspace!.id,
      }
    : null;
}

/** Company skills of the workspace; personal skills stay with their owners. */
export function SkillsAdminPage() {
  const admin = useAdmin();
  const copy = skillsCopy[admin.language];
  const target = useSkillTarget();
  const account = admin.data.authentication.current === "better-auth";
  const list = useSkillList(
    target ?? { organizationId: "", workspaceId: "" },
    !!target && account,
  );
  const navigate = useNavigate();
  const { refetch } = list;
  useEffect(() => {
    if (target && account) void refetch();
  }, [admin.refreshGeneration, target, account, refetch]);
  const create = (
    <Button asChild>
      <Link to="/skills/$skillId" params={{ skillId: "new" }}>
        <Plus data-icon="inline-start" aria-hidden="true" />
        {copy.add}
      </Link>
    </Button>
  );
  const manage = !!list.data?.canManageWorkspace;
  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={copy.skills}
        count={list.data?.workspace.length || undefined}
        actions={manage && list.data?.workspace.length ? create : undefined}
      />
      {!account ? (
        <Alert>
          <AlertDescription>{copy.accountRequired}</AlertDescription>
        </Alert>
      ) : list.isError ? (
        <SkillsLoadFailed copy={copy} onRetry={() => void refetch()} />
      ) : !list.data ? (
        <Skeleton className="h-32" />
      ) : !manage ? (
        <Alert variant="destructive">
          <AlertDescription>{copy.forbidden}</AlertDescription>
        </Alert>
      ) : list.data.workspace.length ? (
        <SkillRows
          skills={list.data.workspace}
          copy={copy}
          onOpen={(skill) =>
            void navigate({
              to: "/skills/$skillId",
              params: { skillId: skill.id },
            })
          }
        />
      ) : (
        <SkillsEmpty title={copy.emptyCompany} action={create} />
      )}
    </div>
  );
}

/** One company skill, or `new`. */
export function SkillAdminPage() {
  const admin = useAdmin();
  const copy = skillsCopy[admin.language];
  const target = useSkillTarget();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { skillId } = useParams({ from: "/skills/$skillId" });
  const isNew = skillId === "new";
  const skill = useSkill(
    target ?? { organizationId: "", workspaceId: "" },
    target && !isNew ? skillId : null,
  );
  if (!target || (!isNew && skill.isPending))
    return <Skeleton className="h-64" />;
  if (!isNew && skill.isError)
    return (
      <SkillsLoadFailed
        copy={copy}
        message={copy.notFound}
        onRetry={() => void skill.refetch()}
      />
    );
  // Personal skills are their owner's alone; the console edits company skills.
  if (skill.data && skill.data.owner.type !== "workspace")
    return (
      <Alert variant="destructive">
        <AlertDescription>{copy.notFound}</AlertDescription>
      </Alert>
    );
  const refresh = () =>
    client.invalidateQueries({ queryKey: skillsKey(target) });
  return (
    <SkillEditor
      key={skill.data ? `${skill.data.id}:${skill.data.revision}` : "new"}
      target={target}
      copy={copy}
      skill={isNew ? undefined : skill.data}
      owner="workspace"
      onSaved={(saved) => {
        client.setQueryData([...skillsKey(target), "skill", saved.id], saved);
        void refresh();
        if (isNew)
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
  );
}
