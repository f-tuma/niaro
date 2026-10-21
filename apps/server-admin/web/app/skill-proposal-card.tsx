import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Sparkles } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import { Badge } from "@admin/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@admin/components/ui/card";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Markdown } from "@admin/components/ui/markdown";
import { Spinner } from "@admin/components/ui/spinner";
import { EntityIcon } from "@admin/components/console/entity-icon";
import { Disclosure } from "@admin/components/console/disclosure";
import type { ClientSession } from "../../../../packages/client-core/session";
import type {
  SkillProposalResult,
  SkillProposalStatus,
} from "../../../../packages/protocol/skills";
import { useChatCopy } from "./chat-copy";

/**
 * A skill the assistant drafted in chat. Nothing is saved until the person
 * chooses Save (personal) or, as an administrator, Save for the company;
 * saving again returns the same skill.
 */
export function SkillProposalView({
  session,
  proposal,
  disabled,
}: {
  session: ClientSession;
  proposal: SkillProposalResult;
  disabled: boolean;
}) {
  const { tr } = useChatCopy();
  const [status, setStatus] = useState<SkillProposalStatus | null>(null);
  const [busy, setBusy] = useState<"personal" | "workspace" | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    // Whether it was saved earlier (another tab, a reload); unknown keeps the buttons.
    session
      .readSkillProposal(proposal.proposalId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setStatus(value);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [session, proposal.proposalId]);
  async function save(target: "personal" | "workspace") {
    setBusy(target);
    setFailed(false);
    try {
      setStatus(await session.acceptSkillProposal(proposal.proposalId, target));
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  }
  const saved = status?.status === "saved" ? status : null;
  return (
    <Card size="sm" data-testid="skill-proposal">
      <CardHeader>
        <div className="flex items-center gap-3">
          <EntityIcon size="md">
            <Sparkles aria-hidden="true" />
          </EntityIcon>
          <div className="flex min-w-0 flex-col gap-0.5">
            <CardTitle>{proposal.name}</CardTitle>
            <CardDescription>{tr("skillProposalTitle")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground">{proposal.description}</p>
          {proposal.preview && (
            <Disclosure title={tr("skillProposalInstructions")}>
              <Markdown text={proposal.preview} />
            </Disclosure>
          )}
          {proposal.files.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {proposal.files.map((file) => (
                <Badge key={file} variant="outline">
                  {file}
                </Badge>
              ))}
            </div>
          )}
          {failed && (
            <Alert variant="destructive">
              <AlertDescription>{tr("skillProposalFailed")}</AlertDescription>
            </Alert>
          )}
        </div>
      </CardContent>
      <CardFooter>
        {saved ? (
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" className="flex items-center gap-1.5 text-sm">
              <Check aria-hidden="true" />
              {tr(
                saved.target === "workspace"
                  ? "skillProposalSavedWorkspace"
                  : "skillProposalSaved",
              )}
            </span>
            {saved.skillId && (
              <Button variant="ghost" size="sm" asChild>
                <Link to="/skills/$skillId" params={{ skillId: saved.skillId }}>
                  {tr("skillProposalOpen")}
                </Link>
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={disabled || !!busy}
              onClick={() => void save("personal")}
            >
              {busy === "personal" && <Spinner data-icon="inline-start" />}
              {tr("skillProposalSave")}
            </Button>
            {proposal.workspaceAllowed && (
              <Button
                variant="outline"
                disabled={disabled || !!busy}
                onClick={() => void save("workspace")}
              >
                {busy === "workspace" && <Spinner data-icon="inline-start" />}
                {tr("skillProposalSaveWorkspace")}
              </Button>
            )}
          </div>
        )}
      </CardFooter>
    </Card>
  );
}
