import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { KeyValueStorage } from "../../packages/client-core/preferences";
// The web preview keeps credentials in memory only. No localStorage fallback.
const webCredentials = new Map<string, string>();
export const credentialVault: KeyValueStorage = {
  getItem: (key) =>
    Platform.OS === "web"
      ? Promise.resolve(webCredentials.get(key) ?? null)
      : SecureStore.getItemAsync(key),
  setItem: async (key, value) => {
    if (Platform.OS === "web") {
      if (value === "null") webCredentials.delete(key);
      else webCredentials.set(key, value);
      return;
    }
    if (value === "null") await SecureStore.deleteItemAsync(key);
    else
      await SecureStore.setItemAsync(key, value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
  },
};
