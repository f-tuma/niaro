import { Directory, File, Paths } from "expo-file-system";
import { getDocumentAsync } from "expo-document-picker";
import {
  launchCameraAsync,
  launchImageLibraryAsync,
  requestCameraPermissionsAsync,
} from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { digest, CryptoDigestAlgorithm, randomUUID } from "expo-crypto";
import { isAvailableAsync, shareAsync } from "expo-sharing";
import {
  checkedSelection,
  rasterDimensions,
} from "../../packages/client-core/attachment-files";
import { AttachmentClientError } from "../../packages/client-core/attachment-transport";
import type { AttachmentCandidate } from "../../packages/client-core/attachment-device";
export async function attachmentDigest(bytes: Uint8Array) {
  const result = await digest(CryptoDigestAlgorithm.SHA256, bytes.slice());
  return Array.from(new Uint8Array(result), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
const ownedDelete = (uri: string) => {
  // Only cache copies made by system pickers/manipulation or this adapter, never a library/content URI.
  const cache = Paths.cache.uri.replace(/\/$/, "") + "/";
  if (
    !uri.startsWith(cache) ||
    !/^(?:ImagePicker|DocumentPicker|ImageManipulator|NiaroAttachments)\//.test(
      uri.slice(cache.length),
    )
  )
    return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {}
};
export async function pickAttachment(
  kind: "camera" | "photos" | "file",
  maxBytes: number,
  signal: AbortSignal,
): Promise<AttachmentCandidate | null> {
  let uri: string | undefined;
  let filename = "photo.jpg",
    declared = "image/jpeg";
  if (kind === "file") {
    const result = await getDocumentAsync({
      copyToCacheDirectory: true,
      multiple: false,
    });
    if (result.canceled) return null;
    const asset = result.assets[0]!;
    uri = asset.uri;
    filename = asset.name;
    declared = asset.mimeType ?? "application/octet-stream";
  } else {
    if (kind === "camera" && !(await requestCameraPermissionsAsync()).granted)
      throw new AttachmentClientError("attachment_permission");
    if (signal.aborted) return null;
    const options = {
      mediaTypes: ["images"] as const,
      allowsEditing: false,
      quality: 1,
      exif: false,
      base64: false,
    };
    const result =
      kind === "camera"
        ? await launchCameraAsync({ ...options, mediaTypes: ["images"] })
        : await launchImageLibraryAsync({ ...options, mediaTypes: ["images"] });
    if (result.canceled) return null;
    const asset = result.assets[0]!;
    uri = asset.uri;
    filename = asset.fileName ?? "photo.jpg";
    declared = asset.mimeType ?? "image/jpeg";
  }
  const owned = new Set<string>([uri]);
  let released = false;
  const release = () => {
    released = true;
    owned.forEach(ownedDelete);
    owned.clear();
  };
  try {
    const file = new File(uri);
    if (signal.aborted || !file.exists || !file.size || file.size > maxBytes)
      throw new AttachmentClientError("attachment_too_large");
    const bytes = await file.bytes();
    if (signal.aborted) throw new AttachmentClientError("attachment_stale");
    const selection = checkedSelection(
      filename,
      declared.toLowerCase(),
      bytes,
      release,
    );
    let raster: AttachmentCandidate["raster"];
    if (selection.mediaType.startsWith("image/")) {
      if (!rasterDimensions(bytes, selection.mediaType))
        throw new AttachmentClientError("attachment_type_unsupported");
      raster = {
        uri,
        mediaType: selection.mediaType as NonNullable<
          typeof raster
        >["mediaType"],
      };
    }
    return {
      selection,
      raster,
      release,
      confirm: async (rotation) => {
        if (signal.aborted || released)
          throw new AttachmentClientError("attachment_stale");
        if (!rotation || !raster) return selection;
        // Expo's decoder honors source EXIF orientation once. Rotate its decoded pixels only after confirmation.
        const context = ImageManipulator.manipulate(uri!);
        context.rotate(rotation);
        const image = await context.renderAsync();
        try {
          const result = await image.saveAsync({
            format: SaveFormat.PNG,
            compress: 1,
          });
          owned.add(result.uri);
          if (signal.aborted || released) {
            ownedDelete(result.uri);
            throw new AttachmentClientError("attachment_stale");
          }
          const rotated = new File(result.uri);
          if (!rotated.size || rotated.size > maxBytes)
            throw new AttachmentClientError("attachment_too_large");
          const rotatedBytes = await rotated.bytes();
          if (signal.aborted || released)
            throw new AttachmentClientError("attachment_stale");
          return checkedSelection(
            filename.replace(/\.[^.]*$/, "") + ".png",
            "image/png",
            rotatedBytes,
            release,
          );
        } finally {
          image.release();
          context.release();
        }
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
export async function saveAttachment(bytes: Uint8Array, filename: string) {
  if (!(await isAvailableAsync()))
    throw new AttachmentClientError("attachment_unavailable");
  const directory = new Directory(Paths.cache, "NiaroAttachments");
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, `${randomUUID()}-${filename}`);
  try {
    file.create();
    file.write(bytes);
    await shareAsync(file.uri, { mimeType: "application/octet-stream" });
  } finally {
    ownedDelete(file.uri);
  }
}
