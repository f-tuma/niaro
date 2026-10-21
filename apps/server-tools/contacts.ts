import { z } from "zod";
import { CrmContactSchema } from "../../packages/protocol";
import type { TestPerson } from "../fixture-server/twenty";
import { ToolRegistry } from "./registry";

export type ContactDirectory = {
  list(signal?: AbortSignal): Promise<TestPerson[]>;
  scan?(
    signal?: AbortSignal,
  ): Promise<{ contacts: TestPerson[]; complete: boolean }>;
};
export const VerifiedContactSchema = CrmContactSchema.extend({ id: z.uuid() });
export const ContactLookupSchema = z
  .strictObject({
    contacts: z.array(VerifiedContactSchema).max(20),
    complete: z.boolean(),
  })
  .refine(
    (value) =>
      new Set(value.contacts.map((c) => c.id)).size === value.contacts.length,
  );
export type ContactLookup = z.infer<typeof ContactLookupSchema>;
const SearchSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(160).optional(),
    id: z.uuid().optional(),
  })
  .refine((value) => Number(!!value.name) + Number(!!value.id) === 1);
const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/^test\s+/, "");

export function createContactTools(directory?: ContactDirectory) {
  const registry = new ToolRegistry();
  if (!directory) return registry;
  const read = async (signal: AbortSignal): Promise<ContactLookup> => {
    const scanned = directory.scan ? await directory.scan(signal) : undefined;
    const records = scanned?.contacts ?? (await directory.list(signal));
    return ContactLookupSchema.parse({
      complete: scanned?.complete ?? records.length < 20,
      contacts: records
        .filter((p) => p.name.firstName.startsWith("TEST"))
        .map((p) => ({
          id: p.id,
          name: `${p.name.firstName} ${p.name.lastName}`.trim().slice(0, 160),
          ...(p.email ? { email: p.email } : {}),
          ...(p.phone ? { phone: p.phone } : {}),
          ...(p.jobTitle ? { jobTitle: p.jobTitle } : {}),
        })),
    });
  };
  registry.register("crm.contacts.list", {
    description: {
      en: "List TEST contacts from the configured CRM.",
      cs: "Načíst TEST kontakty z připojeného CRM.",
    },
    permission: "contacts.read.test",
    input: z.strictObject({}),
    output: ContactLookupSchema,
    execute: (_, context) => read(context.signal),
  });
  registry.register("crm.contacts.search", {
    description: {
      en: "Find a TEST contact by name or verified ID.",
      cs: "Vyhledat TEST kontakt podle jména nebo ověřeného ID.",
    },
    permission: "contacts.read.test",
    input: SearchSchema,
    output: ContactLookupSchema,
    execute: async (query, context) => {
      const result = await read(context.signal);
      const words = query.name ? normalize(query.name).split(/\s+/) : [];
      const contacts = result.contacts.filter((contact) =>
        query.id
          ? contact.id === query.id
          : words.every((word) =>
              normalize(contact.name).split(/\s+/).includes(word),
            ),
      );
      // An ID is unique; a name cannot be called unique in a truncated directory.
      return {
        contacts,
        complete: result.complete || (!!query.id && contacts.length === 1),
      };
    },
  });
  return registry;
}
