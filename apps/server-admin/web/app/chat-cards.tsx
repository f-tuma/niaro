import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  Bot,
  Calendar,
  Check,
  ChevronRight,
  Clock,
  Info,
  Link as LinkIcon,
  ListTodo,
  Mail,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Pause,
  Pencil,
  Phone,
  Play,
  Plus,
  PlugZap,
  RefreshCw,
  Search,
  Send,
  Settings,
  Speaker,
  Square,
  TriangleAlert,
  User,
  Volume2,
  Workflow,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@admin/components/ui/button";
import { Badge } from "@admin/components/ui/badge";
import { Checkbox } from "@admin/components/ui/checkbox";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "@admin/components/ui/field";
import { Spinner } from "@admin/components/ui/spinner";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@admin/components/ui/card";
import { Alert, AlertDescription } from "@admin/components/ui/alert";
import { Progress } from "@admin/components/ui/progress";
import { Separator } from "@admin/components/ui/separator";
import { Markdown } from "@admin/components/ui/markdown";
import { StatusBadge, type Tone } from "@admin/components/console/status";
import { EntityIcon, initials } from "@admin/components/console/entity-icon";
import { CodeBlock, Disclosure } from "@admin/components/console/disclosure";
import type { ClientSession } from "../../../../packages/client-core/session";
import {
  ConnectionFlow,
  type ConnectionPlatform,
  type ConnectionState,
} from "../../../../packages/client-core/service-connection-flow";
import type { CrmContact } from "../../../../packages/protocol";
import {
  CardDocumentSchema,
  type CardDocument,
  type CardNode,
} from "../../../../packages/protocol/card-document";
import { displayLink } from "../../../../packages/protocol/display-link";
import type { ProcessOfferResult } from "../../../../packages/protocol/process-offer";
import type {
  ProcessProposalResult,
  ProcessProposalStatus,
} from "../../../../packages/protocol/process-proposal";
import type { ServicePresentation } from "../../../../packages/protocol/service-presentation";
import type { ServiceResult } from "../../../../packages/protocol/service-result";
import type { ServiceConnectionCard as ConnectionResult } from "../../../../packages/protocol/service-oauth";
import {
  displayFields,
  formatInstant,
  formatRange,
  type DisplayField,
} from "../../../../packages/ui-catalog/field-format";
import {
  actionIcon,
  completeServiceActionReview,
  serviceActionDisplay,
  type ServiceActionReviewFrame,
} from "../../../../packages/ui-catalog/service-action-display";
import { useChatCopy } from "./chat-copy";
import {
  RememberApproval,
  rememberApproval,
  type RememberTarget,
} from "./approval-remember";
import { useApp } from "./context";

const cardIcons: Record<string, LucideIcon> = {
  check: Check,
  chevron: ChevronRight,
  close: X,
  clock: Clock,
  calendar: Calendar,
  person: User,
  mail: Mail,
  phone: Phone,
  info: Info,
  link: LinkIcon,
  edit: Pencil,
  search: Search,
  send: Send,
  mic: Mic,
  stop: Square,
  play: Play,
  pause: Pause,
  volume: Volume2,
  settings: Settings,
  plus: Plus,
  refresh: RefreshCw,
  chat: MessageSquare,
  tasks: ListTodo,
  more: MoreHorizontal,
  arrow: ArrowRight,
  speaker: Speaker,
  bolt: Zap,
};
export function CardIcon({ name }: { name: string }) {
  const Icon = cardIcons[name] ?? Info;
  return <Icon aria-hidden="true" />;
}

/** Label/value rows; lists read as their items, links open the person's own app. */
export function FieldList({ fields }: { fields: DisplayField[] }) {
  if (!fields.length) return null;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
      {fields.map((field, index) => (
        <div key={index} className="contents">
          <dt className="text-muted-foreground">{field.label}</dt>
          <dd className="min-w-0 break-words sm:col-span-2">
            <FieldValue value={field.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
/** The value as text, or a link when all of it is an address. */
export function FieldValue({
  value,
  phone,
}: {
  value: string;
  phone?: boolean;
}) {
  const link = displayLink(value, phone ? "phone" : undefined);
  return link ? (
    <a
      href={link.href}
      className="text-primary underline-offset-4 hover:underline"
      {...(link.kind === "url"
        ? { target: "_blank", rel: "noopener noreferrer" }
        : {})}
    >
      {value}
    </a>
  ) : (
    value
  );
}

const serviceTone: Record<ServiceResult["status"], Tone> = {
  awaiting_approval: "info",
  running: "info",
  succeeded: "success",
  failed: "danger",
  unknown: "warning",
  rejected: "neutral",
};
const serviceStatus = {
  awaiting_approval: "serviceAwaiting",
  running: "serviceRunning",
  succeeded: "serviceSucceeded",
  failed: "serviceFailed",
  unknown: "serviceUnknown",
  rejected: "serviceRejected",
} as const;

/**
 * A service action the assistant prepared or ran. Waiting writes show their
 * parameters and the two decisions; everything else is a passive result.
 */
export function ServiceActionView({
  result,
  disabled,
  onDecide,
  reviewFrame,
  embedded = false,
  rememberTarget,
}: {
  result: ServiceResult;
  disabled: boolean;
  /** Resolves whether the server accepted the decision, when the caller knows. */
  onDecide: (approved: boolean) => void | Promise<boolean>;
  reviewFrame?: ServiceActionReviewFrame;
  embedded?: boolean;
  /** Offers "Don't ask next time" for the person's own personal-service changes. */
  rememberTarget?: RememberTarget;
}) {
  const { copy, tr, language } = useChatCopy();
  const incompleteReview =
    !!reviewFrame && !completeServiceActionReview(result, reviewFrame);
  const decisionDisabled = disabled || incompleteReview;
  const { presentation, card, title } = serviceActionDisplay(result);
  const waiting = result.status === "awaiting_approval";
  const [remember, setRemember] = useState(false);
  const [rememberFailed, setRememberFailed] = useState(false);
  if (!card && presentation?.kind === "contacts" && presentation.items.length)
    return (
      <ContactList
        contacts={presentation.items.map((contact) => ({
          name: contact.name,
          ...(contact.subtitle ? { jobTitle: contact.subtitle } : {}),
          ...(contact.email ? { email: contact.email } : {}),
          ...(contact.phone ? { phone: contact.phone } : {}),
        }))}
        hasMore={presentation.hasMore}
      />
    );
  const body = (
    <>
      {waiting && (
        <>
          <FieldList fields={displayFields(result.fields, language)} />
          {(reviewFrame || result.reviewTruncated) && (
            <Disclosure title={copy.fullParameters}>
              <CodeBlock value={result.inputJson} />
            </Disclosure>
          )}
          {incompleteReview && (
            <Alert>
              <AlertDescription>
                {tr("processApprovalUnavailable")}
              </AlertDescription>
            </Alert>
          )}
          {card && (
            <Disclosure title={tr("cardAdditionalContext")}>
              <CardDocumentView document={card} />
            </Disclosure>
          )}
        </>
      )}
      {card && !waiting ? (
        <CardDocumentView document={card} />
      ) : presentation ? (
        <ServiceResultView presentation={presentation} />
      ) : null}
      {rememberFailed && (
        <p role="status" className="text-xs text-destructive">
          {copy.serviceRememberFailed}
        </p>
      )}
    </>
  );
  const decisions = waiting && (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        disabled={decisionDisabled}
        onClick={() => {
          if (decisionDisabled) return;
          const decided = onDecide(true);
          // The approval goes first; only once the server accepted it stop
          // asking for this action. A failed approval saves no rule.
          if (remember && rememberTarget)
            void Promise.resolve(decided)
              .then((accepted) =>
                accepted === true
                  ? rememberApproval(rememberTarget, result.operationId)
                  : undefined,
              )
              .catch(() => setRememberFailed(true));
        }}
      >
        {tr("serviceApprove")}
      </Button>
      <Button
        variant="outline"
        disabled={decisionDisabled}
        onClick={() => {
          if (!decisionDisabled) onDecide(false);
        }}
      >
        {tr("serviceReject")}
      </Button>
      <span className="text-xs text-muted-foreground">
        {tr(
          result.effect === "write"
            ? "serviceWriteEffect"
            : "serviceReadEffect",
        )}
      </span>
      {rememberTarget && result.effect === "write" && (
        <RememberApproval
          target={rememberTarget}
          operationId={result.operationId}
          checked={remember}
          disabled={decisionDisabled}
          onCheckedChange={setRemember}
        />
      )}
    </div>
  );
  const header = (
    <div className="flex min-w-0 items-center gap-3">
      <EntityIcon size="md">
        <CardIcon name={actionIcon(result.title, result.service)} />
      </EntityIcon>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{title}</span>
        <span className="truncate text-xs text-muted-foreground">
          {result.service}
        </span>
      </div>
      {!waiting && (
        <StatusBadge tone={serviceTone[result.status]}>
          {tr(serviceStatus[result.status])}
        </StatusBadge>
      )}
    </div>
  );
  if (embedded)
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {header}
        {body}
        {decisions}
      </div>
    );
  return (
    <Card size="sm" data-testid={`service-action-${result.operationId}`}>
      <CardHeader>{header}</CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">{body}</div>
      </CardContent>
      {decisions && <CardFooter>{decisions}</CardFooter>}
    </Card>
  );
}

/** Found people; a tap only opens the person's own dialer or mail app. */
export function ContactList({
  contacts,
  hasMore,
}: {
  contacts: (Omit<CrmContact, "id"> & { id?: string })[];
  hasMore: boolean;
}) {
  const { tr } = useChatCopy();
  return (
    <div className="flex flex-col gap-2">
      <Card size="sm" variant="list">
        {contacts.map((contact, index) => (
          <div
            key={contact.id ?? index}
            className="flex min-w-0 items-start gap-3 px-3 py-2.5"
          >
            <EntityIcon size="md" tone="muted">
              {initials(contact.name.replace(/^TEST\s+/i, ""))}
            </EntityIcon>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium">{contact.name}</span>
              {contact.jobTitle && (
                <span className="text-xs text-muted-foreground">
                  {contact.jobTitle}
                </span>
              )}
              {(contact.email || contact.phone) && (
                <span className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {contact.phone && (
                    <span className="inline-flex items-center gap-1.5">
                      <Phone
                        aria-label={tr("crmPhone")}
                        className="size-3.5 text-muted-foreground"
                      />
                      <FieldValue value={contact.phone} phone />
                    </span>
                  )}
                  {contact.email && (
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <Mail
                        aria-label={tr("crmEmail")}
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="min-w-0 break-all">
                        <FieldValue value={contact.email} />
                      </span>
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>
        ))}
      </Card>
      {hasMore && (
        <span className="text-xs text-muted-foreground">
          {tr("serviceResultsTruncated")}
        </span>
      )}
    </div>
  );
}

/** Structured, passive service output: events, records, details or text. */
export function ServiceResultView({
  presentation,
}: {
  presentation: ServicePresentation;
}) {
  const { copy, tr, language } = useChatCopy();
  const [expanded, setExpanded] = useState(false);
  const list = (
    items: ReactNode[],
    hasMore: boolean,
    emptyKey:
      | "serviceContactsEmpty"
      | "serviceEventsEmpty"
      | "serviceRecordsEmpty",
  ) =>
    items.length ? (
      <div className="flex flex-col gap-2">
        <ul className="flex flex-col divide-y">
          {items.slice(0, expanded ? items.length : 3).map((item, index) => (
            <li key={index} className="flex min-w-0 flex-col gap-0.5 py-2">
              {item}
            </li>
          ))}
        </ul>
        {items.length > 3 && (
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? copy.showLess : copy.showAll}
          </Button>
        )}
        {hasMore && (
          <span className="text-xs text-muted-foreground">
            {tr("serviceResultsTruncated")}
          </span>
        )}
      </div>
    ) : (
      <span className="text-muted-foreground">{tr(emptyKey)}</span>
    );
  switch (presentation.kind) {
    case "contacts":
      return list(
        presentation.items.map((contact, index) => (
          <ContactList
            key={index}
            contacts={[
              {
                name: contact.name,
                ...(contact.subtitle ? { jobTitle: contact.subtitle } : {}),
                ...(contact.email ? { email: contact.email } : {}),
                ...(contact.phone ? { phone: contact.phone } : {}),
              },
            ]}
            hasMore={false}
          />
        )),
        presentation.hasMore,
        "serviceContactsEmpty",
      );
    case "events":
      return list(
        presentation.items.map((event, index) => (
          <div key={index} className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">{event.title}</span>
            <span>
              {(event.end
                ? formatRange(event.start, event.end, language)
                : undefined) ??
                formatInstant(event.start, language) ??
                event.start}
            </span>
            {event.location && (
              <span className="text-xs text-muted-foreground">
                {event.location}
              </span>
            )}
          </div>
        )),
        presentation.hasMore,
        "serviceEventsEmpty",
      );
    case "records":
      return list(
        presentation.items.map((record, index) => {
          const fields = displayFields(record.fields, language);
          const long =
            record.fields.length > 2 ||
            record.fields.some((field) => field.value.length > 120);
          return (
            <div key={index} className="flex min-w-0 flex-col gap-1">
              <span className="font-medium">{record.title}</span>
              {record.subtitle && (
                <span className="text-xs text-muted-foreground">
                  {record.subtitle}
                </span>
              )}
              {long ? (
                <Disclosure title={copy.details}>
                  <FieldList fields={fields} />
                </Disclosure>
              ) : (
                <FieldList fields={fields} />
              )}
            </div>
          );
        }),
        presentation.hasMore,
        "serviceRecordsEmpty",
      );
    case "detail":
      return (
        <FieldList fields={displayFields(presentation.fields, language)} />
      );
    case "text":
      return (
        <p className="break-words whitespace-pre-wrap">{presentation.text}</p>
      );
  }
}

const badgeTone: Record<Extract<CardNode, { type: "badge" }>["tone"], Tone> = {
  neutral: "neutral",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "danger",
};
/**
 * A validated system card inside its owner's view (a service result, a
 * task's context): passive content only, with no authority to add buttons
 * or questions.
 */
export function CardDocumentView({ document }: { document: CardDocument }) {
  const { tr } = useChatCopy();
  const parsed = useMemo(
    () => CardDocumentSchema.safeParse(document),
    [document],
  );
  if (!parsed.success)
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {tr("cardUnavailable")}
      </p>
    );
  return <CardBody document={parsed.data} />;
}
function CardBody({ document }: { document: CardDocument }) {
  const { language } = useChatCopy();
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const renderNode = (id: string): ReactNode => {
    const node = nodes.get(id);
    if (!node) return null;
    switch (node.type) {
      case "heading":
        return (
          <p key={id} className="font-medium">
            {node.text}
          </p>
        );
      case "text":
        return (
          <p
            key={id}
            data-tone={node.tone ?? "primary"}
            className="break-words whitespace-pre-wrap data-[tone=secondary]:text-muted-foreground"
          >
            {node.text}
          </p>
        );
      case "field":
        return (
          <div key={id} className="flex min-w-0 items-start gap-3">
            {node.icon && (
              <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">
                <CardIcon name={node.icon} />
              </span>
            )}
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">
                {node.label}
              </span>
              <span className="break-words">
                <FieldValue value={node.value} phone={node.icon === "phone"} />
              </span>
            </div>
          </div>
        );
      case "badge":
        return (
          <span key={id}>
            <StatusBadge tone={badgeTone[node.tone]}>{node.label}</StatusBadge>
          </span>
        );
      case "notice":
        return (
          <Alert
            key={id}
            variant={node.tone === "danger" ? "destructive" : "default"}
          >
            {node.tone === "info" ? (
              <Info aria-hidden="true" />
            ) : (
              <TriangleAlert aria-hidden="true" />
            )}
            <AlertDescription>{node.text}</AlertDescription>
          </Alert>
        );
      case "divider":
        return <Separator key={id} />;
      case "section":
        return (
          <section key={id} className="flex min-w-0 flex-col gap-3">
            {node.title && (
              <div className="flex items-center gap-2">
                {node.icon === "person" ? (
                  <EntityIcon size="sm" tone="muted">
                    {initials(node.title)}
                  </EntityIcon>
                ) : node.icon ? (
                  <span className="text-muted-foreground [&_svg]:size-4">
                    <CardIcon name={node.icon} />
                  </span>
                ) : null}
                <h4 className="font-medium">{node.title}</h4>
              </div>
            )}
            {node.children.map(renderNode)}
          </section>
        );
      case "stack":
        return (
          <div key={id} className="flex min-w-0 flex-col gap-3">
            {node.children.map(renderNode)}
          </div>
        );
      case "columns":
        return (
          <div
            key={id}
            className="grid min-w-0 grid-cols-1 gap-3 @md/chat-card:grid-cols-2"
          >
            {node.children.map((child) => (
              <div key={child} className="min-w-0">
                {renderNode(child)}
              </div>
            ))}
          </div>
        );
      case "disclosure":
        return (
          <Disclosure key={id} title={node.label}>
            <div className="flex flex-col gap-3">
              {node.children.map(renderNode)}
            </div>
          </Disclosure>
        );
      case "list":
        return (
          <ul key={id} className="flex flex-col gap-2">
            {node.items.map((item, index) => (
              <li key={index} className="flex min-w-0 items-start gap-2">
                {item.icon && (
                  <span className="mt-0.5 text-primary [&_svg]:size-4">
                    <CardIcon name={item.icon} />
                  </span>
                )}
                <div className="flex min-w-0 flex-col">
                  <span className="font-medium">{item.title}</span>
                  {item.detail && (
                    <span className="break-words text-muted-foreground">
                      {item.detail}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        );
      case "code":
        return (
          <div key={id} className="flex min-w-0 flex-col gap-1">
            {node.label && (
              <span className="text-xs text-muted-foreground">
                {node.label}
              </span>
            )}
            <CodeBlock value={node.text} />
          </div>
        );
      case "progress":
        return (
          <div key={id} className="flex flex-col gap-1.5">
            <div className="flex justify-between gap-2 text-xs">
              <span>{node.label}</span>
              <span className="text-muted-foreground">
                {new Intl.NumberFormat(language, {
                  style: "percent",
                  maximumFractionDigits: 0,
                }).format(node.value / node.total)}
              </span>
            </div>
            <Progress
              value={(node.value / node.total) * 100}
              aria-label={node.label}
            />
          </div>
        );
      // Buttons and questions were a composed card's; a passive one has none.
      case "button":
      case "input":
        return null;
    }
  };
  return (
    <div
      data-testid={`card-${document.id}`}
      className="@container/chat-card flex min-w-0 flex-col gap-3"
    >
      {document.root.map(renderNode)}
    </div>
  );
}
const preview = (value: unknown) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? text.slice(0, 119) + "…" : text;
};

/** A saved process the assistant suggests; choosing it opens the reviewed start flow. */
export function ProcessOfferView({
  offer,
  disabled,
  onReview,
  onDecline,
}: {
  offer: ProcessOfferResult;
  disabled: boolean;
  onReview: () => void;
  onDecline: () => void;
}) {
  const { tr, language } = useChatCopy();
  const fields = displayFields(
    Object.entries(offer.input)
      .slice(0, 6)
      .map(([label, value]) => ({ label, value: preview(value) })),
    language,
  );
  const reason = offer.reason || offer.description;
  return (
    <Card size="sm" data-testid="process-offer">
      <CardHeader>
        <div className="flex items-center gap-3">
          <EntityIcon size="md">
            {offer.kind === "agent" ? (
              <Bot aria-hidden="true" />
            ) : (
              <Workflow aria-hidden="true" />
            )}
          </EntityIcon>
          <div className="flex min-w-0 flex-col gap-0.5">
            <CardTitle>{offer.name}</CardTitle>
            <CardDescription>{tr("processOfferTitle")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {reason && <p className="text-muted-foreground">{reason}</p>}
          <FieldList fields={fields} />
        </div>
      </CardContent>
      <CardFooter>
        <div className="flex flex-wrap gap-2">
          <Button disabled={disabled} onClick={onReview}>
            {tr("processOfferReview")}
          </Button>
          <Button variant="outline" disabled={disabled} onClick={onDecline}>
            {tr("processOfferDecline")}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

/** The provider page opens in a new tab; returning to this tab checks at once. */
const browserPlatform: ConnectionPlatform = {
  open: async (url) => {
    const opened = window.open(url, "_blank");
    if (!opened) throw Error("blocked");
    opened.opener = null;
  },
  onReturn: (listener) => {
    const focus = () => listener();
    window.addEventListener("focus", focus);
    return { remove: () => window.removeEventListener("focus", focus) };
  },
};
const connectionDescriptions = {
  loading: "serviceConnectionChecking",
  disconnected: "serviceConnectionHint",
  starting: "serviceConnectionStarting",
  pending: "serviceConnectionWaiting",
  cancelling: "serviceConnectionCancelling",
  connected: "serviceConnectionConnected",
  expired: "serviceConnectionExpired",
  cancelled: "serviceConnectionCancelled",
  error: "serviceConnectionError",
  unavailable: "serviceConnectionUnavailable",
} as const;

/** Connects a service the request needs; only this card's own attempt continues the request. */
export function ServiceConnectionView({
  session,
  result,
  disabled,
  online,
  onContinue,
}: {
  session: ClientSession;
  result: ConnectionResult;
  disabled: boolean;
  online: boolean;
  onContinue: (text: string) => void;
}) {
  const { tr } = useChatCopy();
  const flow = useRef<ConnectionFlow | null>(null);
  const [view, setView] = useState<{
    owner: ConnectionFlow;
    state: ConnectionState;
  }>();
  const serviceId = result.serviceId;
  const [continued, setContinued] = useState(false);
  const resume = useRef(result.resumeText);
  const continueRequest = useRef(onContinue);
  useEffect(() => {
    resume.current = result.resumeText;
    continueRequest.current = onContinue;
  });
  useEffect(() => {
    if (!online) return;
    const owner = new ConnectionFlow(
      session,
      serviceId,
      (state) => setView({ owner, state }),
      () => {
        if (!resume.current) return;
        setContinued(true);
        continueRequest.current(resume.current);
      },
      browserPlatform,
    );
    flow.current = owner;
    void owner.load();
    return () => {
      owner.dispose();
      flow.current = null;
    };
  }, [session, serviceId, online]);
  const current =
    view?.owner.session === session && view?.owner.serviceId === serviceId;
  const state: ConnectionState =
    current && online ? view.state : { phase: "loading" };
  const act = (action: "start" | "open" | "cancel") => {
    const owner = flow.current;
    if (
      !disabled &&
      online &&
      owner?.session === session &&
      owner.serviceId === serviceId
    )
      void owner[action]();
  };
  const phase = state.phase;
  const off = disabled || !online;
  const pending = phase === "pending" || phase === "cancelling";
  const canConnect = ["disconnected", "expired", "cancelled", "error"].includes(
    phase,
  );
  return (
    <Card size="sm" data-testid="service-connection">
      <CardHeader>
        <div className="flex items-center gap-3">
          <EntityIcon size="md">
            {phase === "connected" ? (
              <Check aria-hidden="true" />
            ) : (
              <PlugZap aria-hidden="true" />
            )}
          </EntityIcon>
          <div className="flex min-w-0 flex-col gap-0.5">
            <CardTitle>{tr("serviceConnectionTitle")}</CardTitle>
            <CardDescription>{result.service}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          <p aria-live="polite" className="text-muted-foreground">
            {tr(connectionDescriptions[phase])}
          </p>
          {pending && (
            <p className="text-xs text-muted-foreground">
              {tr(
                state.openFailed
                  ? "serviceConnectionOpenFailed"
                  : state.cancelFailed
                    ? "serviceConnectionCancelFailed"
                    : state.statusFailed
                      ? "serviceConnectionStatusFailed"
                      : "serviceConnectionOpenHint",
              )}
            </p>
          )}
          {phase === "connected" && result.resumeText && !continued && (
            <p className="break-words">{result.resumeText}</p>
          )}
        </div>
      </CardContent>
      <CardFooter>
        <div className="flex flex-wrap gap-2">
          {pending && (
            <>
              <Button
                disabled={off || phase === "cancelling"}
                onClick={() => act("open")}
              >
                {tr("serviceConnectionOpen")}
              </Button>
              <Button
                variant="ghost"
                disabled={off}
                onClick={() => act("cancel")}
              >
                {tr("cancel")}
              </Button>
            </>
          )}
          {(canConnect || phase === "starting") && (
            <Button
              disabled={off || phase === "starting"}
              onClick={() => act("start")}
            >
              {tr("serviceConnectionConnect")}
            </Button>
          )}
          {phase === "connected" && result.resumeText && !continued && (
            <Button
              disabled={off}
              onClick={() => {
                if (
                  !off &&
                  flow.current?.session === session &&
                  flow.current.serviceId === serviceId &&
                  flow.current.state.phase === "connected" &&
                  result.resumeText
                )
                  onContinue(result.resumeText);
              }}
            >
              {tr("serviceConnectionContinue")}
            </Button>
          )}
        </div>
      </CardFooter>
    </Card>
  );
}

/** Assistant text as markdown. */
export function AssistantText({ text }: { text: string }) {
  return text ? <Markdown text={text} /> : null;
}

/** Where a proposal continues in Processes: its process, else its design. */
function ProposalLink({
  processId,
  sessionId,
  children,
}: {
  processId?: string;
  sessionId: string;
  children: ReactNode;
}) {
  return (
    <Button variant="ghost" size="sm" asChild>
      {processId ? (
        <Link to="/processes/$processId" params={{ processId }}>
          {children}
        </Link>
      ) : (
        <Link to="/processes/design" search={{ sessionId }}>
          {children}
        </Link>
      )}
    </Button>
  );
}

/**
 * A personal process the designer drafted in chat. Nothing is saved until
 * the person presses "Save and turn on": the server then saves, tests and
 * turns it on (and adds it to the overview when ticked) while this card
 * follows the status. Edit opens the same design session in Processes.
 */
export function ProcessProposalView({
  session,
  proposal,
  disabled,
}: {
  session: ClientSession;
  proposal: ProcessProposalResult;
  disabled: boolean;
}) {
  const { copy, language } = useChatCopy();
  const { isAdmin } = useApp();
  const t = copy.proposal;
  const sessionId = proposal.sessionId;
  const [status, setStatus] = useState<ProcessProposalStatus | null>(null);
  const [hub, setHub] = useState(proposal.addToHub);
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const running = status?.state === "running";
  // The saved outcome (after a reload or in another tab), and a running save.
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      session
        .readProcessProposal(sessionId, controller.signal)
        .then((value) => {
          if (controller.signal.aborted) return;
          setStatus(value);
          if (value.state === "running") timer = setTimeout(read, 1500);
        })
        .catch(() => {
          if (!controller.signal.aborted && running)
            timer = setTimeout(read, 3000);
        });
    };
    read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [session, sessionId, running]);
  async function save() {
    if (!sessionId || proposal.revision === null || !proposal.reviewDigest)
      return;
    setSending(true);
    setRefused(null);
    try {
      setStatus(
        await session.acceptProcessProposal(
          {
            sessionId,
            requestId: crypto.randomUUID(),
            revision: proposal.revision,
            reviewDigest: proposal.reviewDigest,
            assumptions: proposal.assumptions.map(({ id, digest }) => ({
              id,
              digest,
            })),
            addToHub: hub && proposal.hubEligible,
          },
          language,
        ),
      );
    } catch (error) {
      setRefused(
        error instanceof Error ? error.message : "process_proposal_failed",
      );
    } finally {
      setSending(false);
    }
  }
  const state = status?.state ?? "open";
  const failure = refused ?? (state === "failed" ? status?.failure : null);
  // Too large a model reservation is fixed in Usage limits.
  const reservation =
    state === "stopped" && status?.gap === "model_reservation_too_large"
      ? status.reservation
      : undefined;
  // Limits can change (sizing, Usage limits), so these stops can be pressed again.
  const retry =
    state === "stopped" &&
    ["model_reservation_too_large", "limits_exceeded"].includes(
      status?.gap ?? "",
    );
  // Turned on before limits were sized: pressing again resizes it.
  const resize = state === "done" && status?.resize === true;
  const settled =
    (state === "done" && !resize) || (state === "stopped" && !retry);
  const gap = state === "stopped" ? t.gaps[status?.gap ?? ""] : undefined;
  const number = (value: number) => value.toLocaleString(language);
  const canSave =
    proposal.status === "ready" && !settled && !running && !sending;
  const phase = {
    saving: t.saving,
    testing: t.testing,
    activating: t.activating,
    hub: t.hubbing,
  };
  const requiredInput = proposal.inputs.some((input) => input.required);
  return (
    <Card size="sm" data-testid="process-proposal">
      <CardHeader>
        <div className="flex items-center gap-3">
          <EntityIcon size="md">
            {proposal.kind === "agent" ? (
              <Bot aria-hidden="true" />
            ) : (
              <Workflow aria-hidden="true" />
            )}
          </EntityIcon>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <CardTitle>{proposal.name}</CardTitle>
            <CardDescription>{t.title}</CardDescription>
          </div>
          <Badge variant="outline">{t.personal}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        {proposal.status === "budget" ? (
          <Alert>
            <AlertDescription>{t.budget}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col gap-3">
            {proposal.description && (
              <p className="text-muted-foreground">{proposal.description}</p>
            )}
            {proposal.steps.length > 0 && (
              <ol aria-label={t.steps} className="flex flex-col gap-1.5">
                {proposal.steps.map((step, index) => (
                  <li key={index} className="flex items-start gap-2 text-sm">
                    <span className="w-4 shrink-0 text-right text-muted-foreground tabular-nums">
                      {index + 1}.
                    </span>
                    {step.type === "action" ? (
                      <span>
                        {step.service} · {step.action}
                        {step.effect === "write" && (
                          <span className="text-muted-foreground">
                            {" "}
                            · {t.write}
                            {step.approval ? ` ${t.approval}` : ""}
                          </span>
                        )}
                      </span>
                    ) : step.type === "agent" ? (
                      <span>
                        <span className="text-muted-foreground">{t.ai}: </span>
                        {step.task}
                      </span>
                    ) : step.type === "branch" ? (
                      <span className="text-muted-foreground">{t.branch}</span>
                    ) : (
                      <span>
                        <span className="text-muted-foreground">
                          {t.result}:{" "}
                        </span>
                        {step.fields.join(", ")}
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {proposal.status === "ready" && (
              <p className="text-sm">
                <span className="text-muted-foreground">{t.inputs}: </span>
                {proposal.inputs.length
                  ? proposal.inputs
                      .map((input) =>
                        input.required
                          ? `${input.key} (${t.required})`
                          : input.key,
                      )
                      .join(", ")
                  : t.noInputs}
              </p>
            )}
            {proposal.services.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 text-sm">
                <span className="text-muted-foreground">{t.services}:</span>
                {proposal.services.map((service) => (
                  <Badge key={service.name} variant="secondary">
                    {service.name}
                    {" · "}
                    {[service.reads && t.reads, service.writes && t.writes]
                      .filter(Boolean)
                      .join(", ")}
                  </Badge>
                ))}
              </div>
            )}
            {proposal.assumptions.length > 0 && (
              <Disclosure
                title={`${t.assumptions} (${proposal.assumptions.length})`}
              >
                <ul className="flex list-disc flex-col gap-1 ps-4 text-sm">
                  {proposal.assumptions.map((assumption) => (
                    <li key={assumption.id}>{assumption.text}</li>
                  ))}
                </ul>
              </Disclosure>
            )}
            {proposal.status === "questions" && (
              <div className="flex flex-col gap-1.5 text-sm">
                {proposal.questions.length > 0 && (
                  <>
                    <span className="text-muted-foreground">
                      {t.questions}:
                    </span>
                    <ul className="flex list-disc flex-col gap-1 ps-4">
                      {proposal.questions.map((question, index) => (
                        <li key={index}>{question}</li>
                      ))}
                    </ul>
                  </>
                )}
                <span className="text-muted-foreground">{t.answerHint}</span>
              </div>
            )}
            {proposal.status === "ready" && !settled && (
              <Field orientation="horizontal">
                <Checkbox
                  id={`proposal-hub-${sessionId}`}
                  checked={hub && proposal.hubEligible}
                  disabled={
                    !proposal.hubEligible || disabled || running || sending
                  }
                  onCheckedChange={(value) => setHub(value === true)}
                />
                <FieldContent>
                  <FieldLabel htmlFor={`proposal-hub-${sessionId}`}>
                    {t.hub}
                  </FieldLabel>
                  {!proposal.hubEligible && (
                    <FieldDescription>
                      {requiredInput ? t.hubInputs : t.hubWrites}
                    </FieldDescription>
                  )}
                </FieldContent>
              </Field>
            )}
          </div>
        )}
      </CardContent>
      {sessionId && (
        <CardFooter>
          <div className="flex flex-col gap-2">
            {(running || sending) && (
              <span
                role="status"
                className="flex items-center gap-1.5 text-sm text-muted-foreground"
              >
                <Spinner data-icon="inline-start" />
                {phase[status?.phase ?? "saving"]}
              </span>
            )}
            {resize && !sending && (
              <span className="text-sm text-muted-foreground">{t.resize}</span>
            )}
            {state === "done" && !sending && (
              <span role="status" className="flex items-center gap-1.5 text-sm">
                <Check aria-hidden="true" />
                {status?.hub === "added" ? `${t.done} · ${t.onHub}` : t.done}
              </span>
            )}
            {state === "done" && status?.hub === "failed" && (
              <span className="text-sm text-muted-foreground">
                {t.hubFailed}
              </span>
            )}
            {state === "stopped" && (
              <span role="status" className="text-sm">
                {typeof gap === "function"
                  ? reservation
                    ? gap(
                        number(reservation.tokens),
                        number(reservation.maxTokens),
                      )
                    : t.stopped
                  : (gap ?? t.stopped)}
              </span>
            )}
            {reservation &&
              (isAdmin ? (
                <Button variant="link" size="sm" className="self-start" asChild>
                  <a href="/admin/usage">{t.usageLimits}</a>
                </Button>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {t.askAdmin}
                </span>
              ))}
            {failure && !running && !sending && (
              <span role="alert" className="text-sm text-destructive">
                {t.failures[failure] ?? t.failed}
              </span>
            )}
            <div className="flex flex-wrap gap-2">
              {canSave && (
                <Button disabled={disabled} onClick={() => void save()}>
                  {t.save}
                </Button>
              )}
              {settled ||
              ((failure || retry || resize) && status?.processId) ? (
                <ProposalLink
                  processId={status?.processId}
                  sessionId={sessionId}
                >
                  {t.open}
                </ProposalLink>
              ) : (
                !running &&
                !sending && (
                  <Button variant="outline" asChild>
                    <Link to="/processes/design" search={{ sessionId }}>
                      {t.edit}
                    </Link>
                  </Button>
                )
              )}
            </div>
          </div>
        </CardFooter>
      )}
    </Card>
  );
}
