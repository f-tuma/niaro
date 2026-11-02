import { pairingLink } from "../apps/mobile/pairing-link";

const code = "0123456789abcdef0123456789abcdef";
const link = (address: string, value = code) =>
  `niaro://pair?address=${encodeURIComponent(address)}&code=${value}`;

test("a pairing link from the account page names its server and code", () => {
  expect(pairingLink(link("https://niaro.example/v1/ws_1"))).toEqual({
    address: "https://niaro.example/v1/ws_1",
    host: "niaro.example",
    code,
  });
});

test.each([
  ["another scheme", `https://pair?address=x&code=${code}`],
  ["a sign-in callback", "niaro://auth?code=abc&state=def"],
  ["no workspace path", link("https://niaro.example/")],
  ["a path beyond the workspace", link("https://niaro.example/v1/ws/x")],
  ["a short code", link("https://niaro.example/v1/ws", "abc")],
  ["a broken escape", `niaro://pair?address=%E0%A4%A&code=${code}`],
  ["nothing", null],
])("%s is ignored", (_name, url) => {
  expect(pairingLink(url)).toBeNull();
});
