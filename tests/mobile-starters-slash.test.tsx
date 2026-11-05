import React, { useRef, useState } from "react";
import { TextInput } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { Home } from "../apps/mobile/ScreenChrome";
import {
  MobileMentionSuggestions,
  useMobileComposerMentions,
} from "../apps/mobile/MobileMentions";
import { useMobileChatSetup } from "../apps/mobile/chat-setup";
import { Text } from "../packages/ui";
import type { ClientSession } from "../packages/client-core/session";
import type { MentionDirectory } from "../packages/protocol/mentions";

jest.mock("../packages/ui/PetView", () => {
  const React = jest.requireActual("react");
  const { View } = jest.requireActual("react-native");
  return {
    PetView: (props: { testID?: string }) =>
      React.createElement(View, { testID: props.testID }),
  };
});

const home = (
  starters: readonly string[] | undefined,
  onStarter = jest.fn(),
  onMeeting = jest.fn(),
  startersDisabled = false,
) => (
  <Home
    language="cs"
    connected
    busy={false}
    starters={starters}
    onStarter={onStarter}
    startersDisabled={startersDisabled}
    onMeeting={onMeeting}
    onTasks={() => {}}
    onConnect={() => {}}
  />
);

test("the workspace's starters replace 'Plan a meeting' on the phone and send at once", () => {
  const onStarter = jest.fn();
  const onMeeting = jest.fn();
  const { rerender } = render(
    home(["Shrň moje schůzky", "Co čeká na schválení?"], onStarter, onMeeting),
  );
  expect(screen.queryByLabelText("Naplánovat schůzku")).toBeNull();
  fireEvent.press(screen.getByLabelText("Co čeká na schválení?"));
  expect(onStarter).toHaveBeenCalledWith("Co čeká na schválení?");
  expect(onMeeting).not.toHaveBeenCalled();
  // While a message cannot be sent, starters wait.
  rerender(home(["Shrň moje schůzky"], onStarter, onMeeting, true));
  expect(
    screen.getByLabelText("Shrň moje schůzky").props.accessibilityState,
  ).toMatchObject({ disabled: true });
  // Without starters the phone keeps its own shortcut.
  rerender(home([], onStarter, onMeeting));
  fireEvent.press(screen.getByLabelText("Naplánovat schůzku"));
  expect(onMeeting).toHaveBeenCalledTimes(1);
  rerender(home(undefined, onStarter, onMeeting));
  expect(screen.getByLabelText("Naplánovat schůzku")).toBeTruthy();
});

test("starters are read for the signed-in identity only", async () => {
  let resolve!: (value: unknown) => void;
  const session = {
    identityKey: "TEST-A",
    readChatSetup: jest.fn(
      () => new Promise((r) => (resolve = r as typeof resolve)),
    ),
  } as unknown as ClientSession;
  function Probe() {
    const setup = useMobileChatSetup(session, true);
    return <Text testID="starters">{setup?.starters.join("|") ?? "none"}</Text>;
  }
  render(<Probe />);
  expect(screen.getByTestId("starters").props.children).toBe("none");
  await act(async () => {
    resolve({
      profile: "workspace-instructions/1",
      workspaceId: "ws-1",
      instructions: null,
      starters: ["Co mám dnes?"],
    });
    await Promise.resolve();
  });
  expect(screen.getByTestId("starters").props.children).toBe("Co mám dnes?");
});

const directory: MentionDirectory = {
  profile: "agent-mentions/1",
  items: [
    { kind: "service", id: "svc-crm", name: "CRM" },
    { kind: "process", id: "proc-onboard", name: "Onboarding klienta" },
    { kind: "skill", id: "skill-offer", name: "Nabídky", personal: true },
  ],
};
function Composer({ session }: { session: ClientSession }) {
  const draft = useRef("");
  const [text, setText] = useState("");
  const mentions = useMobileComposerMentions({
    session,
    online: true,
    conversationId: "conv-1",
    context: undefined,
    enabled: true,
    read: () => ({
      identityKey: session.identityKey,
      conversationId: "conv-1",
      revision: 0,
      text: draft.current,
    }),
    onChange: (next) => {
      draft.current = next;
      setText(next);
    },
    onFocus: () => {},
  });
  return (
    <>
      <TextInput testID="draft" value={text} onChangeText={mentions.type} />
      <MobileMentionSuggestions
        items={mentions.items}
        slash={mentions.slash}
        language="cs"
        onPick={mentions.pick}
      />
      <Text testID="payload">{JSON.stringify(mentions.payload(text))}</Text>
    </>
  );
}

test("'/' at the start of the phone composer offers skills and processes; a pick tags it", async () => {
  const session = {
    identityKey: "TEST-A",
    readMentions: jest.fn(async () => directory),
  } as unknown as ClientSession;
  render(<Composer session={session} />);
  await act(async () => {});
  fireEvent.changeText(screen.getByTestId("draft"), "/");
  const list = screen.getByTestId("slash-suggestions");
  expect(list.props.accessibilityLabel).toBe("Skilly a procesy");
  expect(screen.getByLabelText("Nabídky, Dovednost")).toBeTruthy();
  expect(screen.getByLabelText("Onboarding klienta, Proces")).toBeTruthy();
  // Services stay with "@".
  expect(screen.queryByLabelText("CRM, Propojení")).toBeNull();
  fireEvent.changeText(screen.getByTestId("draft"), "/nab");
  expect(screen.queryByLabelText("Onboarding klienta, Proces")).toBeNull();
  fireEvent.press(screen.getByLabelText("Nabídky, Dovednost"));
  expect(screen.getByTestId("draft").props.value).toBe("@Nabídky ");
  expect(screen.queryByTestId("slash-suggestions")).toBeNull();
  fireEvent.changeText(screen.getByTestId("draft"), "@Nabídky pro Acme");
  expect(JSON.parse(screen.getByTestId("payload").props.children)).toEqual([
    { kind: "skill", id: "skill-offer" },
  ]);
  // "/" in the middle of a sentence is text; "@" still lists everything.
  fireEvent.changeText(screen.getByTestId("draft"), "a /n");
  expect(screen.queryByTestId("slash-suggestions")).toBeNull();
  fireEvent.changeText(screen.getByTestId("draft"), "a @");
  expect(screen.getByLabelText("CRM, Propojení")).toBeTruthy();
});
