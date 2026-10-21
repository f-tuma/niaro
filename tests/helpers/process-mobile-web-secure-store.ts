// The actual web credential vault is memory-only. Native SecureStore must not
// accidentally become a fake persistent web credential vault in this test.
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = "TEST-native-only";
export const getItemAsync = async () => {
  throw Error("TEST native SecureStore outside browser acceptance");
};
export const setItemAsync = getItemAsync;
export const deleteItemAsync = getItemAsync;
