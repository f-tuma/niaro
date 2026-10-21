import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { limitedJson } from "./openrouter";
import { CrmContactSchema } from "../../packages/protocol";

const Config = z.strictObject({
  baseUrl: z.url(),
  apiKey: z.string().min(20).max(4096),
  expiresAt: z.iso.datetime(),
});
export type TwentyConfig = z.infer<typeof Config>;
export function loadTwentyConfig(file: string): TwentyConfig {
  try {
    if (statSync(file).mode & 0o077) throw Error();
    const config = Config.parse(JSON.parse(readFileSync(file, "utf8")));
    const url = new URL(config.baseUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw Error();
    return config;
  } catch {
    throw new Error("Invalid or non-private Twenty configuration");
  }
}
const Person = z.object({
  id: z.uuid(),
  name: z.object({ firstName: z.string(), lastName: z.string() }),
  jobTitle: z.string().nullable().optional(),
  emails: z
    .object({ primaryEmail: z.string().nullable().optional() })
    .nullable()
    .optional(),
  phones: z
    .object({
      primaryPhoneNumber: z.string().nullable().optional(),
      primaryPhoneCallingCode: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});
function contactFields(person: z.infer<typeof Person>) {
  const email = CrmContactSchema.shape.email.safeParse(
    person.emails?.primaryEmail?.trim(),
  );
  const number = person.phones?.primaryPhoneNumber?.trim();
  const callingCode = person.phones?.primaryPhoneCallingCode?.trim();
  const prefix =
    callingCode && /^\+?\d{1,4}$/.test(callingCode)
      ? `+${callingCode.replace(/^\+/, "")}`
      : undefined;
  const value =
    number && prefix && !number.startsWith("+") && !number.startsWith("00")
      ? `${prefix} ${number}`
      : number;
  const phone = CrmContactSchema.shape.phone.safeParse(value);
  const jobTitle = person.jobTitle?.trim().slice(0, 160);
  return {
    id: person.id,
    name: person.name,
    ...(jobTitle ? { jobTitle } : {}),
    ...(email.success && email.data ? { email: email.data } : {}),
    ...(phone.success && phone.data ? { phone: phone.data } : {}),
  };
}
export type TestPerson = ReturnType<typeof contactFields>;
/** Runtime adapter is read-only and exposes TEST records only. No arbitrary query, URL or mutation. */
export class TwentyTestDirectory {
  constructor(
    private config: TwentyConfig,
    private transport: typeof fetch = fetch,
    private now = () => Date.now(),
  ) {}
  get adminInfo() {
    return { expiresAt: this.config.expiresAt };
  }
  async list(signal?: AbortSignal): Promise<TestPerson[]> {
    return (await this.scan(signal)).contacts;
  }
  async scan(
    signal?: AbortSignal,
  ): Promise<{ contacts: TestPerson[]; complete: boolean }> {
    if (this.now() >= Date.parse(this.config.expiresAt))
      throw new Error("twenty_expired");
    const url = new URL("/rest/people", this.config.baseUrl);
    url.searchParams.set("filter", 'name.firstName[like]:"TEST%"');
    url.searchParams.set("limit", "20");
    url.searchParams.set("depth", "0");
    try {
      const response = await this.transport(url, {
        method: "GET",
        redirect: "error",
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw Error();
      }
      const result = z
        .object({ data: z.object({ people: z.array(Person).max(20) }) })
        .parse(await limitedJson(response, 1024 * 1024));
      // Defense in depth: remote filtering never grants permission for non-test records.
      return {
        complete: result.data.people.length < 20,
        contacts: result.data.people
          .filter((p) => p.name.firstName.startsWith("TEST"))
          .map(contactFields),
      };
    } catch {
      throw new Error("twenty_unavailable");
    }
  }
}
