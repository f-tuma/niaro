import React from "react";
import { StyleSheet } from "react-native";
import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react-native";
import { VoiceSettings } from "../apps/mobile/VoiceSettings";
import { ClientSession } from "../packages/client-core/session";
import { credential } from "./auth-fixtures";
import { translate } from "../packages/i18n";
import {
  OUTPUT_VOICE_PROFILE,
  type OutputVoiceSnapshot,
} from "../packages/protocol/output-voice";
import { voiceCapabilities } from "../packages/protocol/voice";
import {
  SPEECH_PROFILE,
  SPEECH_TEXT_LENGTH,
} from "../packages/protocol/speech";
jest.mock("expo-crypto", () => ({
  randomUUID: () => "93ff8b48-19a7-469b-a9a3-8a9b2d9fecbd",
}));
const snapshot = (): OutputVoiceSnapshot => ({
  profile: OUTPUT_VOICE_PROFILE,
  scope: credential().scope,
  revision: 0,
  catalogueRevision: "a".repeat(64),
  availability: "selectable",
  route: { identity: "b".repeat(64), model: "Reader", method: "reader" },
  serverDefault: { label: "Cedar" },
  options: [{ optionId: `ov_${"c".repeat(64)}`, label: "Echo" }],
  saved: null,
  effective: {
    choice: { kind: "server-default" },
    label: "Cedar",
    reason: "server-default",
  },
});
const response = (value: unknown, status = 200) =>
  ({
    status,
    ok: status === 200,
    text: async () => JSON.stringify(value),
  }) as Response;
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function setup(value = snapshot()) {
  const requests: { url: string; init?: RequestInit }[] = [];
  let current = value;
  const transport = jest.fn(
    async (
      url: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/voice"))
        return response(voiceCapabilities(false));
      if (String(url).endsWith("voice/speech"))
        return response({
          profile: SPEECH_PROFILE,
          enabled: false,
          model: null,
          processing: "cloud",
          maxTextLength: SPEECH_TEXT_LENGTH,
        });
      if (String(url).includes("output-settings")) return response(current);
      throw Error(`Unexpected ${url}`);
    },
  );
  const session = new ClientSession(
    "https://fixture/v1/a",
    { getItem: async () => null, setItem: async () => {} },
    credential(),
    transport,
  );
  const toggled = jest.fn();
  const element = (s = session) => (
    <VoiceSettings
      session={s}
      language="en"
      spokenReplies
      onSpokenReplies={toggled}
    />
  );
  return {
    session,
    transport,
    requests,
    toggled,
    element,
    set: (v: OutputVoiceSnapshot) => {
      current = v;
    },
  };
}
afterEach(() => jest.restoreAllMocks());
describe.each(["en", "cs"] as const)(
  "%s acknowledged voice summary",
  (language) => {
    test.each(["selectable", "server-default-only", "long-choice"] as const)(
      "%s keeps the full current voice naturally wrapping at normal font scale",
      async (state) => {
        const native =
          jest.requireActual<typeof import("react-native")>("react-native");
        jest.spyOn(native, "useWindowDimensions").mockReturnValue({
          width: 390,
          height: 844,
          scale: 1,
          fontScale: 1,
        });
        const tr = translate(language);
        const value = snapshot();
        if (state === "server-default-only") {
          value.availability = state;
          value.options = [];
        } else if (state === "long-choice") {
          const option = value.options[0]!;
          option.label =
            "TEST calm narration with a clear warm tone and an intentionally long voice label";
          value.saved = {
            choice: { kind: "catalogue", optionId: option.optionId },
            label: option.label,
          };
          value.effective = {
            choice: value.saved.choice,
            label: option.label,
            reason: "selected",
          };
        }
        const currentLabel =
          state === "long-choice"
            ? value.effective.label
            : `${tr("outputVoiceDefault")} (Cedar)`;
        const h = setup(value);
        try {
          render(
            <VoiceSettings
              session={h.session}
              language={language}
              spokenReplies
              onSpokenReplies={h.toggled}
            />,
          );
          await act(flush);
          const current = screen.getByText(currentLabel);
          expect(current.props.numberOfLines).toBeUndefined();
          expect(StyleSheet.flatten(current.props.style)).not.toMatchObject({
            maxWidth: "45%",
          });
          expect(screen.getAllByText(currentLabel)).toHaveLength(1);
          expect(screen.getByText(tr("outputVoice"))).toBeTruthy();
          if (state === "server-default-only") {
            expect(screen.getByText(tr("outputVoiceDefaultOnly"))).toBeTruthy();
            expect(
              screen.queryByRole("button", {
                name: new RegExp(`^${tr("outputVoice")}(?:,|$)`),
              }),
            ).toBeNull();
          } else {
            expect(
              screen.getByRole("button", {
                name: `${tr("outputVoice")}, ${currentLabel}`,
              }).props.accessibilityState.disabled,
            ).toBe(false);
          }
          expect(posts(h)).toHaveLength(0);
          expect(h.toggled).not.toHaveBeenCalled();
        } finally {
          h.session.stop();
        }
      },
    );
  },
);
test.each(["en", "cs"] as const)(
  "%s successful owned retry clears the recovered load error",
  async (language) => {
    const h = setup({
      ...snapshot(),
      availability: "server-default-only",
      options: [],
    });
    const tr = translate(language);
    const transport = h.transport.getMockImplementation()!;
    let reads = 0;
    h.transport.mockImplementation((url, init) => {
      if (String(url).includes("output-settings") && ++reads === 1) {
        h.requests.push({ url: String(url), init });
        return Promise.reject(Error("TEST temporary network failure"));
      }
      return transport(url, init);
    });
    try {
      render(
        <VoiceSettings
          session={h.session}
          language={language}
          spokenReplies
          onSpokenReplies={h.toggled}
        />,
      );
      await act(flush);
      expect(screen.getByText(tr("outputVoiceLoadFailed"))).toBeTruthy();
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", { name: tr("outputVoiceRefresh") }),
        );
        await flush();
      });
      expect(reads).toBe(2);
      expect(
        screen.getByText(`${tr("outputVoiceDefault")} (Cedar)`),
      ).toBeTruthy();
      expect(posts(h)).toHaveLength(0);
      expect(h.toggled).not.toHaveBeenCalled();
      expect(screen.queryAllByText(tr("outputVoiceLoadFailed"))).toHaveLength(
        0,
      );
      expect(
        screen.queryByRole("button", { name: tr("outputVoiceRefresh") }),
      ).toBeNull();
    } finally {
      h.session.stop();
    }
  },
);
test.each(["en", "cs"] as const)(
  "%s passive picker read shows loading with disabled acknowledged options, never saving",
  async (language) => {
    const h = setup();
    const tr = translate(language);
    let finish: ((value: Response) => void) | undefined;
    try {
      render(
        <VoiceSettings
          session={h.session}
          language={language}
          spokenReplies
          onSpokenReplies={h.toggled}
        />,
      );
      await act(flush);
      h.transport.mockImplementationOnce((url, init) => {
        h.requests.push({ url: String(url), init });
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      await act(async () => {
        fireEvent.press(
          screen.getByRole("button", {
            name: new RegExp(`^${tr("outputVoice")}, `),
          }),
        );
        await flush();
      });
      const sheet = within(screen.getByTestId("detail-sheet"));
      expect(
        h.requests.filter((request) => request.url.includes("output-settings")),
      ).toHaveLength(2);
      expect(posts(h)).toHaveLength(0);
      expect(
        sheet.getByRole("button", {
          name: `${tr("outputVoiceDefault")} (Cedar)`,
        }).props.accessibilityState,
      ).toMatchObject({ selected: true, disabled: true });
      expect(
        sheet.getByRole("button", { name: "Echo" }).props.accessibilityState,
      ).toMatchObject({ selected: false, disabled: true });
      fireEvent.press(sheet.getByRole("button", { name: "Echo" }));
      expect(posts(h)).toHaveLength(0);
      expect(sheet.queryAllByText(tr("outputVoiceSaving"))).toHaveLength(0);
      expect(
        sheet.getByText(tr("outputVoiceLoading")).props.accessibilityRole,
      ).not.toBe("alert");
      await act(async () => {
        finish!(response(snapshot()));
        await flush();
      });
      expect(sheet.queryAllByText(tr("outputVoiceLoading"))).toHaveLength(0);
      expect(
        sheet.getByRole("button", { name: "Echo" }).props.accessibilityState
          .disabled,
      ).toBe(false);
      expect(h.toggled).not.toHaveBeenCalled();
    } finally {
      h.session.stop();
      await act(async () => {
        finish?.(response(snapshot()));
        await flush();
      });
    }
  },
);
test("both disabled still mount supported unavailable corrupt intent Reset with zero provider calls", async () => {
  const h = setup({
    ...snapshot(),
    revision: 3,
    availability: "speech-unavailable",
    route: null,
    serverDefault: null,
    options: [],
    effective: {
      choice: { kind: "server-default" },
      label: "",
      reason: "speech-unavailable",
    },
  });
  render(h.element());
  await act(flush);
  expect(screen.getByText("Output voice")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Reset" })).toBeTruthy();
  expect(
    h.requests.every((r) =>
      /\/voice(?:$|\/(?:speech|output-settings))/.test(r.url),
    ),
  ).toBe(true);
  h.transport.mockImplementationOnce(async (url, init) => {
    h.requests.push({ url: String(url), init });
    return response({
      ...snapshot(),
      revision: 4,
      availability: "speech-unavailable",
      route: null,
      serverDefault: null,
      options: [],
      saved: { choice: { kind: "server-default" }, label: "" },
      effective: {
        choice: { kind: "server-default" },
        label: "",
        reason: "speech-unavailable",
      },
    });
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Reset" }));
    await flush();
  });
  expect(posts(h)).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
  expect(h.toggled).not.toHaveBeenCalled();
  h.session.stop();
});
function selected(value = snapshot(), revision = 1): OutputVoiceSnapshot {
  const option = value.options[0]!;
  return {
    ...value,
    revision,
    saved: {
      choice: { kind: "catalogue", optionId: option.optionId },
      label: option.label,
    },
    effective: {
      choice: { kind: "catalogue", optionId: option.optionId },
      label: option.label,
      reason: "selected",
    },
  };
}
const posts = (h: ReturnType<typeof setup>) =>
  h.requests.filter((r) => r.init?.method === "POST");
async function open(h: ReturnType<typeof setup>) {
  render(h.element());
  await act(flush);
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: /^Output voice(?:,|$)/ }),
    );
    await flush();
  });
}
test("different option taps send exactly one POST, retain acknowledged selection, disable choices and close only on ACK", async () => {
  const h = setup();
  await open(h);
  let finish!: (value: Response) => void;
  h.transport.mockImplementationOnce(async (url, init) => {
    h.requests.push({ url: String(url), init });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Echo" }));
    await flush();
  });
  expect(posts(h)).toHaveLength(1);
  expect(screen.getByTestId("detail-sheet")).toBeTruthy();
  expect(
    within(screen.getByTestId("detail-sheet")).getByRole("button", {
      name: "Server default (Cedar)",
    }).props.accessibilityState,
  ).toMatchObject({ selected: true, disabled: true });
  expect(
    screen.getByRole("button", { name: "Echo" }).props.accessibilityState
      .selected,
  ).toBe(false);
  fireEvent.press(screen.getByRole("button", { name: "Echo" }));
  expect(posts(h)).toHaveLength(1);
  await act(async () => {
    finish(response(selected()));
    await flush();
  });
  expect(screen.queryByTestId("detail-sheet")).toBeNull();
  expect(screen.getByText("Echo")).toBeTruthy();
  expect(h.toggled).not.toHaveBeenCalled();
  h.session.stop();
});
test("same acknowledged default/catalogue intent is a no-op", async () => {
  for (const value of [snapshot(), selected()]) {
    const h = setup(value);
    const view = render(h.element());
    await act(flush);
    await act(async () => {
      fireEvent.press(
        screen.getByRole("button", { name: /^Output voice(?:,|$)/ }),
      );
      await flush();
    });
    await act(async () => {
      fireEvent.press(
        within(screen.getByTestId("detail-sheet")).getByRole("button", {
          name: value.saved ? "Echo" : "Server default (Cedar)",
        }),
      );
      await flush();
    });
    expect(posts(h)).toHaveLength(0);
    h.session.stop();
    view.unmount();
  }
});
test.each(["stale", "corrupt"])(
  "Reset clears %s saved intent even with default already effective",
  async (kind) => {
    const value = {
      ...snapshot(),
      revision: 3,
      availability: "server-default-only" as const,
      options: [],
      saved:
        kind === "stale"
          ? {
              choice: {
                kind: "catalogue" as const,
                optionId: `ov_${"d".repeat(64)}`,
              },
              label: "Old",
            }
          : null,
      effective: {
        ...snapshot().effective,
        reason: "saved-choice-unavailable" as const,
      },
    };
    const h = setup(value);
    render(h.element());
    await act(flush);
    expect(
      screen.queryByRole("button", { name: /^Output voice(?:,|$)/ }),
    ).toBeNull();
    h.transport.mockImplementationOnce(async (url, init) => {
      h.requests.push({ url: String(url), init });
      return response({
        ...value,
        revision: 4,
        saved: { choice: { kind: "server-default" }, label: "" },
        effective: snapshot().effective,
      });
    });
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Reset" }));
      await flush();
    });
    expect(posts(h)).toHaveLength(1);
    expect(JSON.parse(posts(h)[0]!.init!.body as string).choice).toEqual({
      kind: "server-default",
    });
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    h.session.stop();
  },
);
test("known refusal keeps the sheet and prior selection with contextual error", async () => {
  const h = setup();
  await open(h);
  h.transport.mockImplementationOnce(async (url, init) => {
    h.requests.push({ url: String(url), init });
    return response({ error: "invalid_payload" }, 400);
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Echo" }));
    await flush();
  });
  expect(screen.getByTestId("detail-sheet")).toBeTruthy();
  expect(
    within(screen.getByTestId("detail-sheet")).getByRole("button", {
      name: "Server default (Cedar)",
    }).props.accessibilityState.selected,
  ).toBe(true);
  expect(
    screen.getAllByText("Couldn't save your voice. Try again.").length,
  ).toBeGreaterThan(0);
  expect(posts(h)).toHaveLength(1);
  h.session.stop();
});
test("unknown save GETs first; deliberate Retry reuses exact request/body and never replays automatically", async () => {
  const h = setup();
  await open(h);
  h.transport.mockImplementationOnce(async (url, init) => {
    h.requests.push({ url: String(url), init });
    throw Error("lost response");
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Echo" }));
    await flush();
  });
  expect(posts(h)).toHaveLength(1);
  expect(h.requests.at(-1)!.init?.method).not.toBe("POST");
  const before = posts(h)[0]!.init!.body;
  h.set(selected());
  await act(async () => {
    fireEvent.press(
      screen.getAllByRole("button", { name: "Retry save" }).at(-1)!,
    );
    await flush();
  });
  expect(posts(h)).toHaveLength(2);
  expect(posts(h)[1]!.init!.body).toBe(before);
  expect(screen.queryByTestId("detail-sheet")).toBeNull();
  h.session.stop();
});
test.each([
  "output_voice_conflict",
  "output_voice_catalogue_changed",
  "output_voice_choice_unavailable",
])("%s refetches and requires new explicit choice", async (error) => {
  const h = setup();
  await open(h);
  h.transport.mockImplementationOnce(async (url, init) => {
    h.requests.push({ url: String(url), init });
    return response({ error }, error.endsWith("unavailable") ? 422 : 409);
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Echo" }));
    await flush();
  });
  expect(posts(h)).toHaveLength(1);
  expect(h.requests.at(-1)!.init?.method).not.toBe("POST");
  expect(
    screen.getAllByText("Voice settings changed. Choose again.").length,
  ).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
  h.session.stop();
});
function touch(y: number, timestamp: number) {
  return {
    nativeEvent: {
      timestamp,
      touches: [{ pageX: 10, pageY: y }],
      changedTouches: [{ pageX: 10, pageY: y }],
    },
  };
}
test.each(["scrim", "back", "swipe"])(
  "real sheet %s dismissal invalidates ownership before exit; ignored-abort ACK cannot apply",
  async (method) => {
    const motion = jest.requireActual<typeof import("../packages/ui/motion")>(
      "../packages/ui/motion",
    );
    jest.spyOn(motion, "useReducedMotion").mockReturnValue(false);
    const { Animated, Modal } =
      jest.requireActual<typeof import("react-native")>("react-native");
    const animations: {
      target: number;
      callback?: (result: { finished: boolean }) => void;
    }[] = [];
    jest.spyOn(Animated, "timing").mockImplementation((_value, config) => {
      const entry = {
        target: Number(config.toValue),
        callback: undefined as
          | ((result: { finished: boolean }) => void)
          | undefined,
      };
      animations.push(entry);
      return {
        start: (callback) => {
          entry.callback = callback;
        },
        stop: jest.fn(),
        reset: jest.fn(),
      };
    });
    const h = setup();
    await open(h);
    let finish!: (value: Response) => void;
    h.transport.mockImplementationOnce(async (url, init) => {
      h.requests.push({ url: String(url), init });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    // Keep the real ClientSession contract, but deliberately ignore the UI cancellation port.
    const original = h.session.saveOutputVoiceSettings.bind(h.session);
    jest
      .spyOn(h.session, "saveOutputVoiceSettings")
      .mockImplementation((update) =>
        original(update, new AbortController().signal),
      );
    await act(async () => {
      fireEvent.press(screen.getByRole("button", { name: "Echo" }));
      await flush();
    });
    const view = screen;
    act(() => {
      if (method === "scrim")
        fireEvent(
          view.getByTestId("detail-sheet-scrim", {
            includeHiddenElements: true,
          }),
          "responderRelease",
        );
      if (method === "back")
        fireEvent(view.UNSAFE_getByType(Modal), "requestClose");
      if (method === "swipe") {
        const header = view.getByTestId("detail-sheet-header");
        header.props.onStartShouldSetResponderCapture(touch(0, 1));
        header.props.onResponderMove(touch(100, 100));
        header.props.onResponderRelease(touch(100, 110));
      }
    });
    expect(view.getByTestId("detail-sheet")).toBeTruthy();
    const receivedSignal = jest.mocked(h.session.saveOutputVoiceSettings).mock
      .calls[0]![1];
    expect(receivedSignal.aborted).toBe(true);
    await act(async () => {
      finish(response(selected()));
      await flush();
    });
    expect(view.getByTestId("detail-sheet")).toBeTruthy();
    expect(
      within(view.getByTestId("detail-sheet")).getByRole("button", {
        name: "Server default (Cedar)",
      }).props.accessibilityState,
    ).toMatchObject({ selected: true, disabled: true });
    await act(async () => {
      animations
        .findLast((a) => a.target === 0)!
        .callback?.({ finished: true });
      await flush();
    });
    expect(view.queryByTestId("detail-sheet")).toBeNull();
    h.set(selected());
    await act(async () => {
      fireEvent.press(
        view.getByRole("button", { name: /^Output voice(?:,|$)/ }),
      );
      await flush();
    });
    expect(
      within(view.getByTestId("detail-sheet")).getByRole("button", {
        name: "Echo",
      }).props.accessibilityState.selected,
    ).toBe(true);
    h.session.stop();
  },
);
test.each(["same-identity", "foreign-scope"])(
  "new Session %s discards late old GET even when client port ignores abort",
  async (kind) => {
    const old = setup(),
      next = setup(selected());
    let finish!: (value: OutputVoiceSnapshot) => void;
    jest.spyOn(old.session, "outputVoiceSettings").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(old.element());
    await act(flush);
    view.rerender(next.element());
    await act(flush);
    await act(async () => {
      finish(
        kind === "foreign-scope"
          ? {
              ...snapshot(),
              scope: { ...snapshot().scope, workspaceId: "foreign" },
            }
          : snapshot(),
      );
      await flush();
    });
    expect(screen.getByText("Echo")).toBeTruthy();
    expect(screen.queryByText("Server default (Cedar)")).toBeNull();
    old.session.stop();
    next.session.stop();
  },
);
test("background aborts pending ownership, hides the sheet and passively reconciles on foreground", async () => {
  const { AppState } =
    jest.requireActual<typeof import("react-native")>("react-native");
  let change!: (state: import("react-native").AppStateStatus) => void;
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_type, listener) => {
      change = listener;
      return { remove: jest.fn() };
    });
  const h = setup();
  await open(h);
  let finish!: (value: Response) => void;
  h.transport.mockImplementationOnce(async (url, init) => {
    h.requests.push({ url: String(url), init });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Echo" }));
    await flush();
  });
  act(() => change("background"));
  await act(async () => {
    finish(response(selected()));
    await flush();
  });
  expect(screen.queryByTestId("detail-sheet")).toBeNull();
  expect(screen.queryByText("Echo")).toBeNull();
  h.set(selected());
  await act(async () => {
    change("active");
    await flush();
  });
  expect(screen.getByText("Echo")).toBeTruthy();
  expect(posts(h)).toHaveLength(1);
  h.session.stop();
});
test.each(["en", "cs"] as const)(
  "%s accessible default-only row has no inert picker or redundant Reset",
  async (language) => {
    const h = setup({
      ...snapshot(),
      availability: "server-default-only",
      options: [],
    });
    render(
      <VoiceSettings
        session={h.session}
        language={language}
        spokenReplies
        onSpokenReplies={h.toggled}
      />,
    );
    await act(flush);
    expect(
      screen.getByText(
        language === "en"
          ? "Server default (Cedar)"
          : "Výchozí na serveru (Cedar)",
      ),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: new RegExp(`^${translate(language)("outputVoice")}(?:,|$)`),
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: language === "en" ? "Reset" : "Obnovit výchozí",
      }),
    ).toBeNull();
    h.session.stop();
  },
);
test("unsupported sidecar is omitted; failed read remains contextual and retryable", async () => {
  const h = setup();
  h.transport.mockImplementation(async (url) =>
    String(url).includes("output-settings")
      ? response({}, 404)
      : String(url).endsWith("/voice")
        ? response(voiceCapabilities(false))
        : response({
            profile: SPEECH_PROFILE,
            enabled: false,
            model: null,
            processing: "cloud",
            maxTextLength: SPEECH_TEXT_LENGTH,
          }),
  );
  const view = render(h.element());
  await act(flush);
  expect(screen.queryByText("Output voice")).toBeNull();
  view.unmount();
  const next = setup();
  jest
    .spyOn(next.session, "outputVoiceSettings")
    .mockRejectedValue(Error("network"));
  render(next.element());
  await act(flush);
  expect(screen.getByText("Couldn't load your voice. Try again.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  h.session.stop();
  next.session.stop();
});
test("same-identity Session replacement discards ignored-abort old save and clears old sheet", async () => {
  const h = setup();
  const view = render(h.element());
  await act(flush);
  await act(async () => {
    fireEvent.press(
      screen.getByRole("button", { name: /^Output voice(?:,|$)/ }),
    );
    await flush();
  });
  let finish!: (value: OutputVoiceSnapshot) => void;
  jest.spyOn(h.session, "saveOutputVoiceSettings").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Echo" }));
    await flush();
  });
  const next = setup();
  view.rerender(next.element());
  await act(flush);
  await act(async () => {
    finish(selected());
    await flush();
  });
  expect(screen.queryByTestId("detail-sheet")).toBeNull();
  expect(screen.queryByText("Echo")).toBeNull();
  expect(screen.getByText("Server default (Cedar)")).toBeTruthy();
  h.session.stop();
  next.session.stop();
});
test("real sheet dismissal-start notifies once before exit and blocks late entrance readiness", () => {
  const motion = jest.requireActual<typeof import("../packages/ui/motion")>(
    "../packages/ui/motion",
  );
  jest.spyOn(motion, "useReducedMotion").mockReturnValue(false);
  const { Animated, Modal, Text } =
    jest.requireActual<typeof import("react-native")>("react-native");
  const callbacks: ((result: { finished: boolean }) => void)[] = [];
  jest.spyOn(Animated, "timing").mockImplementation(() => ({
    start: (callback) => {
      if (callback) callbacks.push(callback);
    },
    stop: jest.fn(),
    reset: jest.fn(),
  }));
  const { DetailSheet } = jest.requireActual<
    typeof import("../apps/mobile/ScreenChrome")
  >("../apps/mobile/ScreenChrome");
  const dismiss = jest.fn(),
    close = jest.fn(),
    shown = jest.fn();
  const view = render(
    <DetailSheet
      title="Test"
      language="en"
      onShown={shown}
      onDismissRequested={dismiss}
      onClose={close}
    >
      <Text>Body</Text>
    </DetailSheet>,
  );
  fireEvent(view.UNSAFE_getByType(Modal), "show");
  fireEvent(view.UNSAFE_getByType(Modal), "requestClose");
  fireEvent(view.UNSAFE_getByType(Modal), "requestClose");
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  act(() => callbacks[0]!({ finished: true }));
  expect(shown).not.toHaveBeenCalled();
  act(() => callbacks[1]!({ finished: true }));
  expect(close).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(dismiss).toHaveBeenCalledTimes(1);
  const programmatic = render(
    <DetailSheet
      title="Test"
      language="en"
      onDismissRequested={dismiss}
      onClose={close}
    >
      <Text>Body</Text>
    </DetailSheet>,
  );
  programmatic.unmount();
  expect(dismiss).toHaveBeenCalledTimes(1);
});
test("output-voice-only ACK preserves already playing ReplySpeech and starts no preview", async () => {
  const { ReplySpeech } = jest.requireActual<
    typeof import("../packages/client-core/speech")
  >("../packages/client-core/speech");
  const synthesize = jest.fn(async () => ({
    mimeType: "audio/wav" as const,
    base64: "AAAA",
  }));
  const playback = { start: jest.fn(async () => {}), stop: jest.fn() };
  const reply = new ReplySpeech(synthesize, playback);
  await reply.play("chat", "message", "en", "request");
  expect(reply.getSnapshot().phase).toBe("playing");
  const stops = playback.stop.mock.calls.length;
  const h = setup();
  await open(h);
  h.set(selected());
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Echo" }));
    await flush();
  });
  expect(reply.getSnapshot().phase).toBe("playing");
  expect(playback.stop).toHaveBeenCalledTimes(stops);
  expect(synthesize).toHaveBeenCalledTimes(1);
  expect(playback.start).toHaveBeenCalledTimes(1);
  expect(posts(h)).toHaveLength(1);
  h.session.stop();
  reply.stop();
});
test("stopping the actual ClientSession during a held save clears its editor ownership", async () => {
  const h = setup();
  await open(h);
  let finish!: (value: Response) => void;
  h.transport.mockImplementationOnce(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => {
    fireEvent.press(screen.getByRole("button", { name: "Echo" }));
    await flush();
  });
  await act(async () => {
    h.session.stop();
    finish(response(selected()));
    await flush();
  });
  expect(screen.queryByTestId("detail-sheet")).toBeNull();
  expect(screen.queryByText("Echo")).toBeNull();
  expect(screen.queryByText("Server default (Cedar)")).toBeNull();
});
