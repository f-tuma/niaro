import { useCallback, useMemo, useRef, useState } from "react";
import {
  BuiltinActionType,
  Renderer,
  createLibrary,
  type ActionEvent,
  type ComponentRenderer,
} from "@openuidev/react-lang";
import {
  GENERATIVE_UI_COMPONENTS,
  GENERATIVE_UI_GROUPS,
  GENERATIVE_UI_LIBRARY_ID,
  type GenerativeUiComponentName,
} from "../../../../../packages/openui-library/spec";
import {
  checkProgram,
  safeUrl,
  splitReply,
} from "../../../../../packages/openui-library/program";
import {
  followUpMessage,
  followUpScope,
  type FollowUpField,
} from "../../../../../packages/openui-library/follow-up";
import { useChatCopy } from "../chat-copy";
import * as content from "./content";
import * as charts from "./charts";
import * as actions from "./actions";
import { GeneratedUiScopeContext } from "./scope";

const none = () => null;
const views = {
  Stack: content.Stack,
  Row: content.Row,
  Grid: content.Grid,
  Section: content.Section,
  Tabs: content.Tabs,
  Tab: content.Group,
  Accordion: content.Accordion,
  AccordionItem: content.Group,
  Separator: content.Separator,
  Heading: content.Heading,
  Text: content.Text,
  Markdown: content.Markdown,
  Callout: content.Callout,
  Badge: content.Badge,
  Link: content.Link,
  Metric: content.Metric,
  Details: content.Details,
  Detail: content.Detail,
  List: content.List,
  ListItem: content.ListItem,
  Table: content.Table,
  Progress: content.Progress,
  Timeline: content.Timeline,
  TimelineItem: content.TimelineItem,
  BarChart: charts.BarChart,
  LineChart: charts.LineChart,
  PieChart: charts.PieChart,
  // A series is read by its chart.
  Series: none,
  Button: actions.Button,
  Buttons: actions.Buttons,
  Form: actions.Form,
  TextField: actions.TextField,
  Select: actions.Select,
  Checkbox: actions.Checkbox,
  DateField: actions.DateField,
} as Record<GenerativeUiComponentName, ComponentRenderer<never>>;

/** The shared vocabulary (names, props, references) drawn with the console's
 * components. */
export const webGenerativeUiLibrary = createLibrary({
  id: GENERATIVE_UI_LIBRARY_ID,
  root: "Stack",
  components: GENERATIVE_UI_COMPONENTS.map((component) => ({
    ...component,
    component: views[component.name as GenerativeUiComponentName],
  })) as never,
  componentGroups: GENERATIVE_UI_GROUPS,
});

/**
 * The generated part of an assistant answer. It is presentation only: a
 * button sends its follow-up as the person's own message, once; a link
 * opens a checked web address, and nothing else runs.
 */
export function GeneratedUi({
  program,
  streaming = false,
  disabled = false,
  blocked = false,
  onFollowUp,
}: {
  /** An admitted program, or while streaming the raw reply so far. */
  program: string;
  streaming?: boolean;
  /** A read-only chat: shown, never acted on. */
  disabled?: boolean;
  /** A follow-up cannot be sent now; its buttons wait, as Send does. */
  blocked?: boolean;
  /** Sends a follow-up as a message; false when the chat did not take it. */
  onFollowUp: (text: string) => boolean;
}) {
  const { language } = useChatCopy();
  const [fields] = useState(() => new Map<string, FollowUpField>());
  // Marked at once, before the next render, so a second press of the same
  // form or button never sends again.
  const sent = useRef(new Set<string>());
  const [answered, setAnswered] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const pressing = useRef<string | undefined>(undefined);
  const press = useCallback((once: string, run: () => void) => {
    pressing.current = once;
    try {
      run();
    } finally {
      pressing.current = undefined;
    }
  }, []);
  // A partial reply is drawn as it grows; a finished one passes the same
  // admission as on the server first.
  const source = useMemo(() => {
    if (streaming) return splitReply(program).program ?? program;
    const checked = checkProgram(program);
    return checked.ok ? checked.program : null;
  }, [program, streaming]);
  const scope = useMemo(
    () => ({ disabled, blocked, fields, answered, press }),
    [disabled, blocked, fields, answered, press],
  );
  const onAction = useCallback(
    (event: ActionEvent) => {
      if (disabled) return;
      if (event.type === BuiltinActionType.ContinueConversation) {
        // One press sends one message; a form or button answers once.
        const once =
          pressing.current ??
          followUpScope(event.formName, event.humanFriendlyMessage);
        if (blocked || sent.current.has(once)) return;
        // Hidden context is never sent: only what the person can read.
        const text = followUpMessage({
          message: event.humanFriendlyMessage,
          formName: event.formName,
          formState: event.formState,
          fields,
          language,
        });
        // A message the chat did not take leaves the form as it was.
        if (!text || !onFollowUp(text)) return;
        sent.current.add(once);
        setAnswered(new Set(sent.current));
      } else if (event.type === BuiltinActionType.OpenUrl) {
        const href = safeUrl(event.params.url);
        if (href) window.open(href, "_blank", "noopener,noreferrer");
      }
    },
    [disabled, blocked, fields, language, onFollowUp],
  );
  if (!source) return null;
  return (
    <GeneratedUiScopeContext.Provider value={scope}>
      <div data-testid="generated-ui" className="@container/generated min-w-0">
        <Renderer.Root
          response={source}
          library={webGenerativeUiLibrary}
          isStreaming={streaming}
          onAction={onAction}
          onError={ignoreErrors}
          publishObservability={false}
        >
          <Renderer.Content />
        </Renderer.Root>
      </div>
    </GeneratedUiScopeContext.Provider>
  );
}
/** Dropped parts were already reported where the program was admitted. */
const ignoreErrors = () => {};
