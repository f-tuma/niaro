import type { AttachmentSelection } from "./attachments";
export type AttachmentCandidate = {
  selection: AttachmentSelection;
  raster?: {
    uri: string;
    mediaType: "image/jpeg" | "image/png" | "image/webp";
  };
  /** A user-confirmed pixel edit. The returned identity has not been created/uploaded yet. */
  confirm: (rotation: 0 | 90 | 180 | 270) => Promise<AttachmentSelection>;
  release: () => void;
};
