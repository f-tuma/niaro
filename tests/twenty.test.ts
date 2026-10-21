import { TwentyTestDirectory } from "../apps/fixture-server/twenty";
const config = {
  baseUrl: "https://crm.example.test",
  apiKey: "fake-key-not-real",
  expiresAt: "2099-01-01T00:00:00Z",
};
test("Twenty adapter only performs bounded GET requests and strips non-TEST records and unused private fields", async () => {
  const data = {
    data: {
      people: [
        {
          id: "bfdcd207-4745-4bf1-a732-be096058ab6f",
          name: { firstName: "TEST Agent", lastName: "Client" },
          emails: {
            primaryEmail: "test.agent@example.test",
            additionalEmails: ["ignored@example.test"],
          },
          phones: {
            primaryPhoneCallingCode: "+1",
            primaryPhoneNumber: "202 555 0147",
            additionalPhones: [{ number: "ignored" }],
          },
          jobTitle: "  Designer  ",
          city: "not in the result",
        },
        {
          id: "bfdcd207-4745-4bf1-a732-be096058ab60",
          name: { firstName: "Real", lastName: "Person" },
        },
      ],
    },
  };
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () => {
      let read = false;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: async () =>
              read
                ? { done: true }
                : ((read = true),
                  { done: false, value: Buffer.from(JSON.stringify(data)) }),
            cancel: async () => {},
          }),
        },
      } as Response;
    },
  );
  const result = await new TwentyTestDirectory(config, transport).list();
  expect(result).toHaveLength(1);
  expect(result[0]).not.toHaveProperty("emails");
  expect(result[0]).toEqual({
    id: "bfdcd207-4745-4bf1-a732-be096058ab6f",
    name: { firstName: "TEST Agent", lastName: "Client" },
    jobTitle: "Designer",
    email: "test.agent@example.test",
    phone: "+1 202 555 0147",
  });
  const [url, options] = transport.mock.calls[0]!;
  expect(String(url)).toContain("name.firstName%5Blike%5D");
  expect(new URL(String(url)).origin).toBe(config.baseUrl);
  expect(options).toMatchObject({ method: "GET", redirect: "error" });
  expect(options!.body).toBeUndefined();
  Object.assign(data.data.people[0]!, {
    emails: { primaryEmail: "invalid address" },
    phones: { primaryPhoneNumber: "javascript:evil" },
    jobTitle: "",
  });
  const invalid = await new TwentyTestDirectory(config, transport).list();
  expect(invalid[0]).not.toHaveProperty("email");
  expect(invalid[0]).not.toHaveProperty("phone");
  expect(invalid[0]).not.toHaveProperty("jobTitle");
  Object.assign(data.data.people[0]!, {
    emails: null,
    phones: {
      primaryPhoneCallingCode: "+1",
      primaryPhoneNumber: "+1 202 555 0147",
    },
  });
  const alreadyInternational = await new TwentyTestDirectory(
    config,
    transport,
  ).list();
  expect(alreadyInternational[0]!.phone).toBe("+1 202 555 0147");
  Object.assign(data.data.people[0]!, { phones: null });
  expect(
    (await new TwentyTestDirectory(config, transport).list())[0],
  ).not.toHaveProperty("phone");
});
test("expired CRM access never sends a request, and remote errors do not expose secrets", async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () => {
      throw Error(config.apiKey);
    },
  );
  await expect(
    new TwentyTestDirectory(config, transport, () =>
      Date.parse(config.expiresAt),
    ).list(),
  ).rejects.toThrow("twenty_expired");
  expect(transport).not.toHaveBeenCalled();
  await expect(
    new TwentyTestDirectory(config, transport).list(),
  ).rejects.toThrow("twenty_unavailable");
});
