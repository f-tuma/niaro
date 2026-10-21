/**
 * A chat's title as people scan it: the topic of its first message without
 * greetings or polite openers, cut at a word. Display only; the server's
 * stored title stays as it is.
 */
const openers = [
  // Czech
  "ahoj",
  "čau",
  "čus",
  "dobrý den",
  "dobré ráno",
  "dobrý večer",
  "prosím tě",
  "prosímtě",
  "prosím",
  "hele",
  "můžeš mi",
  "můžeš",
  "mohl bys mi",
  "mohla bys mi",
  "mohl bys",
  "mohla bys",
  "potřebuju",
  "potřebuji",
  "chtěl bych",
  "chtěla bych",
  "řekni mi",
  // English
  "hi",
  "hello",
  "hey",
  "please",
  "can you please",
  "could you please",
  "can you",
  "could you",
  "would you",
  "i need you to",
  "i want you to",
  "i'd like you to",
  "tell me",
].sort((a, b) => b.length - a.length);
export function conversationTitle(raw: string, max = 42) {
  let text = raw.replace(/\s+/g, " ").trim();
  // Openers first ("Hi! Could you…"), then the first sentence names the topic.
  let changed = true;
  while (changed) {
    changed = false;
    const lower = text.toLocaleLowerCase();
    for (const opener of openers)
      if (
        lower.startsWith(opener) &&
        /^[\s,.!?:;-]|^$/.test(text.slice(opener.length))
      ) {
        text = text.slice(opener.length).replace(/^[\s,.!?:;-]+/, "");
        changed = true;
        break;
      }
  }
  const end = text.search(/[.!?](\s|$)/);
  if (end > 0) text = text.slice(0, end);
  if (!text) return raw.trim().slice(0, max);
  if (text.length > max) {
    const cut = text.lastIndexOf(" ", max - 1);
    text = `${text.slice(0, cut > max / 2 ? cut : max - 1).replace(/[,;:\s]+$/, "")}…`;
  }
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}
