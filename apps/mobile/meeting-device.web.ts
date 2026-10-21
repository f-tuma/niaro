/** Meeting capture uses the native disk recorder; the web client can review server artifacts. */
export function useMeetingDevice(_identity: string): {
  capture:
    | import("../../packages/client-core/meeting-capture").MeetingCapture
    | null;
  durationMillis: number;
  elapsed(): number;
  pickAudio(): Promise<{
    uri: string;
    name: string;
    size: number | null;
  } | null>;
} {
  return {
    capture: null,
    durationMillis: 0,
    elapsed: () => 0,
    pickAudio: async () => null,
  };
}
