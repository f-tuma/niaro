export type PluralForms = { one: string; few?: string; other: string };

/** Picks the plural form for a count; Czech needs one / few (2–4) / other. */
export function plural(language: string, count: number, forms: PluralForms) {
  const rule = new Intl.PluralRules(language).select(count);
  const word =
    rule === "one"
      ? forms.one
      : rule === "few"
        ? (forms.few ?? forms.other)
        : forms.other;
  return `${count.toLocaleString(language)} ${word}`;
}
