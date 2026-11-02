/**
 * Agent instructions written as Goal, Steps, Never and Done when. The
 * headings stay in English in the stored text (the designer writes them so),
 * and the apps show them under translated labels. It is a writing
 * convention, not a schema: any other text stays valid free text.
 */
export type AgentInstructionParts = {
  goal: string;
  steps: string[];
  never: string[];
  doneWhen: string;
};
const HEADINGS = [
  ["goal", "Goal:"],
  ["steps", "Steps:"],
  ["never", "Never:"],
  ["doneWhen", "Done when:"],
] as const;
type Section = (typeof HEADINGS)[number][0];

export const emptyAgentInstructions = (): AgentInstructionParts => ({
  goal: "",
  steps: [],
  never: [],
  doneWhen: "",
});

/** The four parts, or null when the text is not in this shape. Empty text is
 * an empty shape, so a new agent starts with the four fields. */
export function parseAgentInstructions(
  text: string,
): AgentInstructionParts | null {
  const parts = emptyAgentInstructions();
  if (!text.trim()) return parts;
  let section: Section | null = null;
  let order = -1;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const heading = HEADINGS.findIndex(([, label]) =>
      line.toLowerCase().startsWith(label.toLowerCase()),
    );
    if (heading >= 0) {
      // Each heading once, in this order.
      if (heading <= order) return null;
      order = heading;
      section = HEADINGS[heading]![0];
      const rest = line.slice(HEADINGS[heading]![1].length).trim();
      if (rest) add(parts, section, rest, true);
      continue;
    }
    if (!line) continue;
    // Text before the first heading is free text.
    if (!section) return null;
    add(parts, section, line, false);
  }
  return section ? parts : null;
}
function add(
  parts: AgentInstructionParts,
  section: Section,
  line: string,
  sameLine: boolean,
) {
  if (section === "goal" || section === "doneWhen") {
    parts[section] = parts[section] ? `${parts[section]} ${line}` : line;
    return;
  }
  const item = line.replace(/^(?:\d+[.)]|[-*•])\s*/, "");
  const marked = item !== line || sameLine;
  const list = parts[section];
  // An unmarked line continues the item above it.
  if (!marked && list.length) list[list.length - 1] += ` ${item}`;
  else if (item) list.push(item);
}

/** The stored text: headings on their own lines, numbered steps, dashed
 * never-items. Empty sections are left out. */
export function formatAgentInstructions(parts: AgentInstructionParts) {
  const steps = parts.steps.map((s) => s.trim()).filter(Boolean);
  const never = parts.never.map((s) => s.trim()).filter(Boolean);
  const lines: string[] = [];
  if (parts.goal.trim()) lines.push(`Goal: ${parts.goal.trim()}`);
  if (steps.length)
    lines.push("Steps:", ...steps.map((s, i) => `${i + 1}. ${s}`));
  if (never.length) lines.push("Never:", ...never.map((s) => `- ${s}`));
  if (parts.doneWhen.trim()) lines.push(`Done when: ${parts.doneWhen.trim()}`);
  return lines.join("\n");
}
