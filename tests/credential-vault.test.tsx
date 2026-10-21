import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { credentialVault } from "../apps/mobile/credential-vault";
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  getItemAsync: jest.fn(async () => "encrypted-store-value"),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
test("native credentials use the device-only keychain and deletion API", async () => {
  jest.replaceProperty(Platform, "OS", "android");
  await credentialVault.setItem("credential-test", "synthetic-token");
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
    "credential-test",
    "synthetic-token",
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
  );
  expect(await credentialVault.getItem("credential-test")).toBe(
    "encrypted-store-value",
  );
  await credentialVault.setItem("credential-test", "null");
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("credential-test");
});
test("a native keystore error propagates without a plaintext fallback", async () => {
  jest.replaceProperty(Platform, "OS", "android");
  jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(Error("locked"));
  await expect(
    credentialVault.setItem("credential-test", "synthetic-token"),
  ).rejects.toThrow("locked");
});
test("web credentials remain in memory and never call native storage", async () => {
  jest.replaceProperty(Platform, "OS", "web");
  await credentialVault.setItem("web-test", "synthetic-token");
  expect(await credentialVault.getItem("web-test")).toBe("synthetic-token");
  await credentialVault.setItem("web-test", "null");
  expect(await credentialVault.getItem("web-test")).toBeNull();
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
});
