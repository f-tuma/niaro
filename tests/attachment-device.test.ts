import { attachmentDigest } from "../apps/mobile/attachment-device";
jest.mock("expo-file-system", () => ({
  File: class {},
  Directory: class {},
  Paths: {},
}));
jest.mock("expo-document-picker", () => ({}));
jest.mock("expo-image-picker", () => ({}));
jest.mock("expo-image-manipulator", () => ({}));
jest.mock("expo-sharing", () => ({}));
jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digest: jest.fn(async (_algorithm: string, input: unknown) => {
    // SDK57 Android bridge rejects detached ArrayBuffers; this reproduced the actual native failure.
    if (!(input instanceof Uint8Array))
      throw Error("TEST Native byte view required");
    return new Uint8Array(32).buffer;
  }),
}));
test("native attachment SHA uses the supported byte-view SDK boundary", async () => {
  expect(await attachmentDigest(new Uint8Array([1, 2, 3]))).toBe(
    "00".repeat(32),
  );
});
