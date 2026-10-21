import { RE2JS } from "re2js";

/** A compatible ASCII syntax subset, matched as Unicode by a non-backtracking engine. */
export function compilePattern(pattern: string, maxProgramSize = 4096) {
  if (pattern.length > 512 || /[^\x20-\x7e]/.test(pattern))
    throw new Error("pattern_unsupported");
  let normalized = "",
    inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      const escaped = pattern[++i];
      // Deliberately exclude dialect-specific escapes, lookarounds and backreferences.
      if (!escaped || !"\\^$.*+?()[]{}|/-dDwW".includes(escaped))
        throw new Error("pattern_unsupported");
      normalized += `\\${escaped}`;
    } else if (char === "[") {
      if (inClass) throw new Error("pattern_unsupported");
      inClass = true;
      normalized += char;
    } else if (char === "]") {
      if (!inClass) throw new Error("pattern_unsupported");
      inClass = false;
      normalized += char;
    } else if (!inClass && char === ".") {
      // RE2's bare dot has different line-terminator semantics from ECMAScript.
      normalized += "[^\\n\\r\\x{2028}\\x{2029}]";
    } else if (!inClass && char === "(" && pattern[i + 1] === "?") {
      if (pattern[i + 2] !== ":") throw new Error("pattern_unsupported");
      normalized += "(?:";
      i += 2;
    } else if (!inClass && char === "{") {
      const repetition = /^\{\d+(?:,\d*)?\}/.exec(pattern.slice(i));
      if (repetition) {
        // RE2 treats leading-zero bounds as literals; ECMAScript treats them as decimals.
        normalized += repetition[0].replace(/\d+/g, (digits) =>
          String(Number(digits)),
        );
        i += repetition[0].length - 1;
      } else {
        if (/\d/.test(pattern[i + 1] ?? ""))
          throw new Error("pattern_unsupported");
        // Some API exporters emit legacy JS literal braces, e.g. ^{{[^{}]+}}$.
        normalized += "\\{";
      }
    } else if (!inClass && char === "}") normalized += "\\}";
    else normalized += char;
  }
  if (inClass) throw new Error("pattern_unsupported");
  checkExpansion(normalized, maxProgramSize);
  const expression = RE2JS.compile(normalized);
  if (expression.programSize() > maxProgramSize)
    throw new Error("pattern_unsupported");
  return expression;
}

/** Bound repetition expansion before compilation allocates its instruction graph. */
function checkExpansion(pattern: string, limit: number) {
  const stack = [{ total: 16, last: 0 }];
  const add = (cost: number, replace = false) => {
    const frame = stack.at(-1)!;
    frame.total += cost - (replace ? frame.last : 0);
    frame.last = cost;
    if (frame.total > limit) throw new Error("pattern_unsupported");
  };
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "\\") {
      i++;
      add(2);
    } else if (char === "[") {
      for (i++; i < pattern.length && pattern[i] !== "]"; i++)
        if (pattern[i] === "\\") i++;
      add(2);
    } else if (char === "(") {
      if (stack.length >= 64) throw new Error("pattern_unsupported");
      stack.push({ total: 4, last: 0 });
      if (pattern.slice(i, i + 3) === "(?:") i += 2;
    } else if (char === ")") {
      if (stack.length === 1) throw new Error("pattern_unsupported");
      add(stack.pop()!.total);
    } else if (char === "{") {
      const match = /^\{(\d+)(?:,(\d*))?\}/.exec(pattern.slice(i));
      if (!match) throw new Error("pattern_unsupported");
      const upper = Number(match[2] || match[1]);
      if (upper > 1000) throw new Error("pattern_unsupported");
      add(stack.at(-1)!.last * Math.max(1, upper) + 2, true);
      i += match[0].length - 1;
    } else if ("*+?".includes(char)) add(stack.at(-1)!.last + 2, true);
    else add(2);
  }
  if (stack.length !== 1) throw new Error("pattern_unsupported");
}
