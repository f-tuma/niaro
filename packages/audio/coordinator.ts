export type AudioMode = "voice" | "recording" | "playback";
/** Device operations remain in adapters. Merely rendering never acquires audio. */
export class AudioSessionCoordinator {
  private owner: AudioMode | null = null;
  acquire(mode: AudioMode) {
    if (this.owner) throw new Error("audio_busy");
    this.owner = mode;
  }
  release(mode: AudioMode) {
    if (this.owner === mode) this.owner = null;
  }
  current() {
    return this.owner;
  }
}
