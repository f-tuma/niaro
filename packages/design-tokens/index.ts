// Mobile companion: graphite canvas, quiet neutral surfaces, cobalt actions.
// Grouped screens (settings) may sit on `grouped`; everything else is `background`.
export const tokens = {
  color: {
    /** The app canvas matches the web graphite theme. */
    background: "#141518",
    /** A light neutral canvas for grouped/settings screens, under white groups. */
    grouped: "#111214",
    /** Cards, groups and sheets. */
    surface: "#1D1F23",
    surfaceRaised: "#27292F",
    /** Quiet neutral fill: tonal buttons, chips, inputs, icon wells. */
    fill: "#24262B",
    fillPressed: "#32353C",
    border: "#35373E",
    glass: "rgba(29,31,35,0.92)",
    scrim: "rgba(0,0,0,0.56)",
    /** A light veil for in-place menus: focus without blacking out the page. */
    scrimSoft: "rgba(0,0,0,0.28)",
    hairline: "rgba(255,255,255,0.09)",
    pressed: "rgba(255,255,255,0.06)",
    text: {
      primary: "#F4F4F6",
      secondary: "#A3A7B2",
      disabled: "#777D8B",
      inverse: "#FFFFFF",
    },
    action: {
      primary: "#4563DE",
      link: "#9AAFFF",
      pressed: "#4263DE",
      disabled: "#30333B",
      danger: "#FF8B91",
      dangerSoft: "#382327",
      dangerPressed: "#4A292F",
    },
    pet: {
      bodyLight: "#5B537D",
      bodyDeep: "#333042",
      rim: "#C1BCE7",
      face: "#120F1A",
      highlight: "#FFFFFF",
      eyeRim: "rgba(255,255,255,0.27)",
      shadow: "#000000",
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
      softBlue: "#252F4A",
      cyan: "#C8EAF7",
      lilac: "#E9E3F4",
    },
    status: {
      warning: "#EDBC73",
      needsInput: "#9AAFFF",
      running: "#B1A3FF",
      success: "#88D4AD",
      error: "#FF8B91",
      unknown: "#A3A7B2",
    },
    /** Pill and tile backgrounds paired with the status text colour above. */
    statusSoft: {
      warning: "#362D20",
      needsInput: "#252F4A",
      running: "#2C2742",
      success: "#20352D",
      error: "#382327",
      unknown: "#292B30",
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
      blue: { background: "#252F4A", foreground: "#9AAFFF" },
      violet: { background: "#302943", foreground: "#B1A3FF" },
      teal: { background: "#203735", foreground: "#82CFC4" },
      amber: { background: "#362D20", foreground: "#EDBC73" },
      rose: { background: "#382327", foreground: "#FF8B91" },
    },
    /**
     * Chart series in this fixed order (identity, never rank), checked for
     * colour-blind separation on white. Ink stays text tokens beside them.
     */
    chart: [
      "#5475F5",
      "#EB6834",
      "#1BAF7A",
      "#EDA100",
      "#E87BA4",
      "#008300",
      "#6250D6",
      "#E34948",
    ],
  },
  typography: {
    /** Mobile navigation and sheets share one readable title hierarchy. */
    headerTitle: {
      fontSize: 20,
      lineHeight: 28,
      fontWeight: "600",
      letterSpacing: -0.3,
    },
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
    body: { fontSize: 16, lineHeight: 24, fontWeight: "400" },
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
    /** Header, composer and sheet actions share softly squared corners. */
    action: 14,
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
      boxShadow: "0 2px 6px rgba(0,0,0,0.12)",
    },
    drawer: { boxShadow: "8px 0 32px rgba(0,0,0,0.28)" },
    floating: { boxShadow: "0 8px 24px rgba(0,0,0,0.28)" },
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
