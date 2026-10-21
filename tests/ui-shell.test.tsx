import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { Composer, Navigation, Home } from "../apps/mobile/ScreenChrome";
import { WorkItemSummary } from "../packages/ui-catalog/WorkItemSummary";
import { choosePeter, meetingProposal } from "../packages/test-fixtures";
import { translate } from "../packages/i18n";

test.each(["en", "cs"] as const)(
  "%s summary opens details without rendering answer or approval controls",
  (language) => {
    const fixture = choosePeter(language);
    const onOpen = jest.fn();
    render(
      <WorkItemSummary
        {...fixture}
        language={language}
        proposal={meetingProposal()}
        onOpen={onOpen}
      />,
    );
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: translate(language)("approveMeeting"),
      }),
    ).toBeNull();
    fireEvent.press(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  },
);
test.each(["en", "cs"] as const)(
  "%s meeting summary reads current structured parameters, including duration and timezone, without sending anything",
  (language) => {
    const fixture = choosePeter(language);
    const proposal = meetingProposal(language);
    const onOpen = jest.fn();
    const props = {
      ...fixture,
      input: undefined,
      work: { ...fixture.work, status: "waiting_approval" as const },
      language,
      onOpen,
      timeZone: "Europe/Prague",
    };
    const { rerender } = render(
      <WorkItemSummary {...props} proposal={proposal} />,
    );
    expect(screen.getByText("Peter Novák")).toBeTruthy();
    const label = screen.getByRole("button").props.accessibilityLabel;
    expect(label).toContain(language === "cs" ? "14:00" : "2:00");
    expect(label).toMatch(/30\s?min/);
    rerender(
      <WorkItemSummary
        {...props}
        proposal={{
          ...proposal,
          revision: 2,
          parameters: {
            ...proposal.parameters,
            startsAt: "2026-09-30T13:00:00Z",
            endsAt: "2026-09-30T13:45:00Z",
          },
        }}
      />,
    );
    const currentLabel = screen.getByRole("button").props.accessibilityLabel;
    expect(currentLabel).toContain(language === "cs" ? "15:00" : "3:00");
    expect(currentLabel).toMatch(/45\s?min/);
    expect(currentLabel).not.toMatch(/30\s?min/);
    expect(screen.queryByText(proposal.parameters.title)).toBeTruthy();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole("button"));
    expect(onOpen).toHaveBeenCalledTimes(1);
  },
);
test("composer keeps text editable offline but never sends; voice is an explicit separate action", () => {
  const onSend = jest.fn(),
    onVoice = jest.fn(),
    onChange = jest.fn();
  const { rerender } = render(
    <Composer
      language="en"
      value="draft"
      onChange={onChange}
      onSend={onSend}
      onVoice={onVoice}
      disabled
    />,
  );
  fireEvent.press(screen.getByRole("button", { name: "Send" }));
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.changeText(
    screen.getByLabelText("Type a message…"),
    "still editable",
  );
  expect(onChange).toHaveBeenCalledWith("still editable");
  rerender(
    <Composer
      language="en"
      value=""
      onChange={onChange}
      onSend={onSend}
      onVoice={onVoice}
      disabled
    />,
  );
  expect(onVoice).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Voice input" }));
  expect(onVoice).toHaveBeenCalledTimes(1);
  expect(onSend).not.toHaveBeenCalled();
});
test("tab bar navigates only on a tap and shows waiting work", () => {
  const navigate = jest.fn();
  render(
    <Navigation section="chat" onChange={navigate} language="cs" count={3} />,
  );
  expect(navigate).not.toHaveBeenCalled();
  expect(screen.getByText("3")).toBeTruthy();
  expect(
    screen.getByRole("tab", { name: "Chat" }).props.accessibilityState.selected,
  ).toBe(true);
  expect(
    screen.getByRole("tab", { name: "Úlohy" }).props.accessibilityValue,
  ).toEqual({ text: "3" });
  fireEvent.press(screen.getByRole("tab", { name: "Úlohy" }));
  expect(navigate).toHaveBeenCalledWith("tasks");
  fireEvent.press(screen.getByRole("tab", { name: "Schůzky" }));
  expect(navigate).toHaveBeenLastCalledWith("meetings");
  fireEvent.press(screen.getByRole("tab", { name: "Nastavení" }));
  expect(navigate).toHaveBeenLastCalledWith("more");
});
test("composer shows an accessible busy state and cannot send again while waiting for a model", () => {
  const send = jest.fn();
  render(
    <Composer
      language="en"
      value="A request"
      onChange={jest.fn()}
      onSend={send}
      onVoice={jest.fn()}
      disabled={false}
      sending
    />,
  );
  const button = screen.getByRole("button", { name: "Send" });
  expect(button.props.accessibilityState.busy).toBe(true);
  fireEvent.press(button);
  expect(send).not.toHaveBeenCalled();
});
test("without a server, home introduces the assistant and offers only Connect", () => {
  const connect = jest.fn();
  render(
    <Home
      language="en"
      paired={false}
      connected={false}
      busy={false}
      onMeeting={jest.fn()}
      onTasks={jest.fn()}
      onConnect={connect}
    />,
  );
  expect(screen.getByText("Meet your assistant")).toBeTruthy();
  expect(screen.queryByText(/Listening/)).toBeNull();
  // Shortcuts would dead-end without a server, so only Connect is offered.
  expect(screen.getAllByRole("button")).toHaveLength(1);
  fireEvent.press(screen.getByRole("button", { name: "Connect" }));
  expect(connect).toHaveBeenCalledTimes(1);
});
test("offline home keeps local recording and tasks but not server actions", () => {
  const record = jest.fn(),
    meeting = jest.fn(),
    talk = jest.fn();
  render(
    <Home
      language="en"
      connected={false}
      busy={false}
      onTalk={talk}
      onMeeting={meeting}
      onRecord={record}
      onTasks={jest.fn()}
      onConnect={jest.fn()}
    />,
  );
  expect(screen.getByText("Not connected to your server.")).toBeTruthy();
  fireEvent.press(
    screen.getByRole("button", { name: "Talk to the assistant" }),
  );
  fireEvent.press(screen.getByRole("button", { name: "Plan a meeting" }));
  expect(talk).not.toHaveBeenCalled();
  expect(meeting).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", { name: "Record a meeting" }));
  expect(record).toHaveBeenCalledTimes(1);
});
test("connected home leads with waiting work and starts nothing by itself", () => {
  const tasks = jest.fn(),
    meeting = jest.fn(),
    processes = jest.fn(),
    talk = jest.fn();
  const { rerender } = render(
    <Home
      language="en"
      connected
      busy={false}
      count={2}
      onTalk={talk}
      onMeeting={meeting}
      onTasks={tasks}
      onProcesses={processes}
      onConnect={jest.fn()}
    />,
  );
  expect(screen.queryByText(/Listening/)).toBeNull();
  const [orb, first] = screen.getAllByRole("button");
  expect(orb!.props.accessibilityLabel).toBe("Talk to the assistant");
  expect(first!.props.accessibilityLabel).toBe("Waiting for you: 2");
  expect(tasks).not.toHaveBeenCalled();
  expect(meeting).not.toHaveBeenCalled();
  expect(talk).not.toHaveBeenCalled();
  fireEvent.press(first!);
  expect(tasks).toHaveBeenCalledTimes(1);
  fireEvent.press(orb!);
  expect(talk).toHaveBeenCalledTimes(1);
  fireEvent.press(screen.getByRole("button", { name: "Processes" }));
  expect(processes).toHaveBeenCalledTimes(1);
  rerender(
    <Home
      language="en"
      connected
      busy
      voice="unavailable"
      onTalk={talk}
      onMeeting={meeting}
      onTasks={tasks}
      onConnect={jest.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: "Processes" })).toBeNull();
  expect(screen.getByText("Type to get started.")).toBeTruthy();
  fireEvent.press(
    screen.getByRole("button", { name: "Talk to the assistant" }),
  );
  fireEvent.press(screen.getByRole("button", { name: "Plan a meeting" }));
  expect(talk).toHaveBeenCalledTimes(1);
  expect(meeting).not.toHaveBeenCalled();
  rerender(
    <Home
      language="en"
      connected
      busy={false}
      meetingRecording
      onTalk={talk}
      onMeeting={meeting}
      onTasks={tasks}
      onConnect={jest.fn()}
    />,
  );
  expect(screen.getByText("Voice paused while recording.")).toBeTruthy();
  fireEvent.press(
    screen.getByRole("button", { name: "Talk to the assistant" }),
  );
  expect(talk).toHaveBeenCalledTimes(1);
});
test("composer offers voice only where it can work", () => {
  const voice = jest.fn();
  const props = {
    language: "en" as const,
    value: "",
    onChange: jest.fn(),
    onSend: jest.fn(),
    onVoice: voice,
    disabled: false,
  };
  const { rerender } = render(<Composer {...props} voice="hidden" />);
  expect(screen.queryByRole("button", { name: "Voice input" })).toBeNull();
  rerender(<Composer {...props} voice="disabled" />);
  fireEvent.press(screen.getByRole("button", { name: "Voice input" }));
  expect(voice).not.toHaveBeenCalled();
  rerender(<Composer {...props} />);
  fireEvent.press(screen.getByRole("button", { name: "Voice input" }));
  expect(voice).toHaveBeenCalledTimes(1);
});
