// Only native audio, haptics and browser SSO are outside this RN-web HTTP QA.
export const feedback = () => {};
export const touch = () => {};
export const setFeedbackEnabled = () => {};
export const loginProof = () => {
  throw Error("TEST browser SSO outside process HTTP QA");
};
export const authorizeApp = loginProof;
export const createVoiceCapture = () => {
  throw Error("TEST native voice capture outside process HTTP QA");
};
export const useReplySpeech = () => ({
  player: { stop() {}, waitForReply() {} },
  state: { phase: "idle" },
  enabled: false,
});
