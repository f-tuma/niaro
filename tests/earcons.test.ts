import {
  earconLength,
  playEarcon,
  type Earcon,
} from "../packages/audio/earcons";

function context() {
  const events: { node: string; call: string; args: number[] }[] = [];
  const param = (node: string) => ({
    setValueAtTime: (...args: number[]) =>
      events.push({ node, call: "set", args }),
    linearRampToValueAtTime: (...args: number[]) =>
      events.push({ node, call: "linear", args }),
    exponentialRampToValueAtTime: (...args: number[]) =>
      events.push({ node, call: "exponential", args }),
  });
  let count = 0;
  return {
    events,
    currentTime: 5,
    destination: {},
    createOscillator: () => {
      const node = `osc${count++}`;
      return {
        type: "",
        frequency: param(node),
        connect: () => {},
        start: (at = 0) => events.push({ node, call: "start", args: [at] }),
        stop: (at = 0) => events.push({ node, call: "stop", args: [at] }),
      };
    },
    createGain: () => ({ gain: param(`gain${count}`), connect: () => {} }),
  };
}

test.each(["listen", "sent", "reply", "done", "error"] as Earcon[])(
  "%s is quiet, short and click-free",
  (kind) => {
    const ctx = context();
    const length = playEarcon(ctx, kind);
    expect(length).toBe(earconLength(kind));
    expect(length).toBeLessThan(0.2);
    const peaks = ctx.events
      .filter((e) => e.call === "linear")
      .map((e) => e.args[0]!);
    expect(Math.max(...peaks)).toBeLessThanOrEqual(0.12);
    // Every note starts from near silence and fades back to it.
    const gains = ctx.events.filter((e) => e.node.startsWith("gain"));
    expect(
      gains.filter((e) => e.call === "set").every((e) => e.args[0]! <= 0.001),
    ).toBe(true);
    expect(
      gains
        .filter((e) => e.call === "exponential")
        .every((e) => e.args[0]! <= 0.001),
    ).toBe(true);
    // Scheduled from the context clock, never in the past.
    expect(
      ctx.events
        .filter((e) => e.call === "start")
        .every((e) => e.args[0]! >= 5),
    ).toBe(true);
  },
);
