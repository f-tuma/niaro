import { useCallback, useMemo, useState } from "react";
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
 * button puts a follow-up in the composer for the person to send, a link
 * opens a checked web address, and nothing else runs.
 */
export function GeneratedUi({
  program,
  streaming = false,
  disabled = false,
  onFollowUp,
}: {
  /** An admitted program, or while streaming the raw reply so far. */
  program: string;
  streaming?: boolean;
  /** A read-only chat: shown, never acted on. */
  disabled?: boolean;
  onFollowUp: (text: string) => void;
}) {
  const { language } = useChatCopy();
  const [fields] = useState(() => new Map<string, FollowUpField>());
  // A partial reply is drawn as it grows; a finished one passes the same
  // admission as on the server first.
  const source = useMemo(() => {
    if (streaming) return splitReply(program).program ?? program;
    const checked = checkProgram(program);
    return checked.ok ? checked.program : null;
  }, [program, streaming]);
  const scope = useMemo(() => ({ disabled, fields }), [disabled, fields]);
  const onAction = useCallback(
    (event: ActionEvent) => {
      if (disabled) return;
      if (event.type === BuiltinActionType.ContinueConversation) {
        // Hidden context is never sent: only what the person can read.
        const text = followUpMessage({
          message: event.humanFriendlyMessage,
          formName: event.formName,
          formState: event.formState,
          fields,
          language,
        });
        if (text) onFollowUp(text);
      } else if (event.type === BuiltinActionType.OpenUrl) {
        const href = safeUrl(event.params.url);
        if (href) window.open(href, "_blank", "noopener,noreferrer");
      }
    },
    [disabled, fields, language, onFollowUp],
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
