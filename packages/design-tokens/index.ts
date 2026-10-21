// White canvas, neutral greys, near-black text and one confident blue.
// Grouped screens (settings) may sit on `grouped`; everything else is `background`.
export const tokens = {
  color: {
    /** The app canvas: plain white. */
    background: "#FFFFFF",
    /** A light neutral canvas for grouped/settings screens, under white groups. */
    grouped: "#F5F6F8",
    /** Cards, groups and sheets. */
    surface: "#FFFFFF",
    surfaceRaised: "#FFFFFF",
    /** Quiet neutral fill: tonal buttons, chips, inputs, icon wells. */
    fill: "#F2F3F5",
    fillPressed: "#E7E9EC",
    border: "#E4E6EA",
    glass: "rgba(255,255,255,0.72)",
    scrim: "rgba(12,14,18,0.32)",
    /** A light veil for in-place menus: focus without blacking out the page. */
    scrimSoft: "rgba(12,14,18,0.12)",
    hairline: "rgba(12,14,18,0.09)",
    pressed: "rgba(12,14,18,0.05)",
    text: {
      primary: "#111317",
      secondary: "#6B7079",
      disabled: "#A3A8B0",
      inverse: "#FFFFFF",
    },
    action: {
      primary: "#2F5BE7",
      pressed: "#2349C4",
      disabled: "#EEF0F3",
      danger: "#D42F3A",
      dangerSoft: "#FDEDEE",
      dangerPressed: "#FADBDD",
    },
    wave: {
      mist: "#D4F4FC",
      violet: "#AAA9FF",
      cyan: "#8EDAF8",
      lilac: "#BDB5FA",
      edge: "#D4E8FC",
      line: "#C7EDF9",
      blue: "#7C9DF5",
      highlight: "#C8C2FF",
    },
    accent: {
      blue: "#5C85F7",
      /** Tonal primary: selected rows, pressable chips, user bubbles. */
      softBlue: "#EBF0FE",
      cyan: "#C8EAF7",
      lilac: "#E9E3F4",
    },
    status: {
      warning: "#A65A00",
      needsInput: "#2F5BE7",
      running: "#5A55C8",
      success: "#16794C",
      error: "#D42F3A",
      unknown: "#6B7079",
    },
    /** Pill and tile backgrounds paired with the status text colour above. */
    statusSoft: {
      warning: "#FDF1E1",
      needsInput: "#EBF0FE",
      running: "#EFEEFB",
      success: "#E6F4EC",
      error: "#FDEDEE",
      unknown: "#F1F2F4",
    },
    /** Live microphone capture only; never a generic error or brand colour. */
    record: "#E5484D",
    /** The voice lens: the one shape that means "talk" or "record". */
    /** Glass runs via → to; the back liquid is `from`, the lit front `surface`. */
    lens: {
      voice: {
        from: "#5C85F7",
        via: "#345CD0",
        to: "#5A4CC8",
        surface: "#8FB0FF",
      },
      record: {
        from: "#FF8A7A",
        via: "#E5484D",
        to: "#C2185B",
        surface: "#FFB3A6",
      },
      /** Resting, not broken: the brand liquid, softened. */
      idle: {
        from: "#AFC1F7",
        via: "#8EA4EC",
        to: "#A79CE6",
        surface: "#D3DDFB",
      },
    },
    /** Icon tiles that tell destinations apart at a glance. */
    tile: {
      blue: { background: "#E8EEFE", foreground: "#2F5BE7" },
      violet: { background: "#ECE8FF", foreground: "#5A4CC8" },
      teal: { background: "#DCF2EF", foreground: "#14776C" },
      amber: { background: "#FBEFD9", foreground: "#93560A" },
      rose: { background: "#FDE8EA", foreground: "#C42A35" },
    },
  },
  typography: {
    /** Tab-root screen titles, left-aligned (iOS/Bolt large title). */
    largeTitle: {
      fontSize: 30,
      lineHeight: 36,
      fontWeight: "700",
      letterSpacing: -0.6,
    },
    title: {
      fontSize: 22,
      lineHeight: 28,
      fontWeight: "700",
      letterSpacing: -0.3,
    },
    /** Centred hero headlines (home, onboarding). */
    screenTitle: {
      fontSize: 28,
      lineHeight: 34,
      fontWeight: "700",
      letterSpacing: -0.5,
    },
    /** Sheet titles. */
    sheetTitle: {
      fontSize: 20,
      lineHeight: 26,
      fontWeight: "700",
      letterSpacing: -0.3,
    },
    /** Card titles and compact (nested) top bar titles. */
    cardTitle: {
      fontSize: 17,
      lineHeight: 24,
      fontWeight: "600",
      letterSpacing: -0.2,
    },
    /** The title of an object in a list (meeting, task, run). */
    rowTitle: { fontSize: 16, lineHeight: 22, fontWeight: "600" },
    /** A settings/action row label. */
    rowLabel: { fontSize: 16, lineHeight: 22, fontWeight: "500" },
    body: { fontSize: 15, lineHeight: 22, fontWeight: "400" },
    /** Large button text. */
    button: { fontSize: 15, lineHeight: 20, fontWeight: "600" },
    label: { fontSize: 14, lineHeight: 20, fontWeight: "600" },
    /** Group headings: sentence case, muted. */
    section: { fontSize: 13, lineHeight: 18, fontWeight: "600" },
    /** One line of meta under a row title. */
    meta: { fontSize: 13, lineHeight: 18, fontWeight: "400" },
    caption: { fontSize: 13, lineHeight: 18, fontWeight: "400" },
    /** Status pills and tiny counters. */
    overline: {
      fontSize: 12,
      lineHeight: 16,
      fontWeight: "600",
      letterSpacing: 0.1,
    },
  },
  spacing: {
    xxs: 2,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    screenGutter: 20,
    cardPadding: 16,
    stackGap: 12,
    inlineGap: 8,
    /** Space between groups/sections on a screen. */
    section: 28,
    xl: 24,
    xxl: 32,
    hero: 40,
  },
  radius: {
    /** Small controls inside rows: icon wells, small buttons, segments. */
    small: 8,
    /** Inputs, notices, segmented tracks. */
    control: 12,
    /** Inset grouped lists. */
    group: 16,
    card: 16,
    sheet: 24,
    floating: 24,
    pill: 999,
  },
  control: {
    minHeight: 48,
    /** The one primary action of a screen or sheet. */
    large: 52,
    small: 36,
    /** List rows: one line / with a meta line. */
    row: 56,
    rowTall: 68,
  },
  elevation: {
    card: {
      boxShadow: "0 1px 2px rgba(12,14,18,0.04), 0 2px 8px rgba(12,14,18,0.04)",
    },
    drawer: { boxShadow: "8px 0 32px rgba(12,14,18,0.12)" },
    floating: { boxShadow: "0 8px 24px rgba(12,14,18,0.12)" },
    sheet: { boxShadow: "0 -8px 32px rgba(12,14,18,0.10)" },
  },
  motion: {
    feedback: 110,
    stateTransition: 220,
    sheetEnter: 280,
    sheetExit: 160,
    pressScale: 0.975,
  },
} as const;
