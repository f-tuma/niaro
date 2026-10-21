import { Linking } from "react-native";
import { displayLink } from "../protocol/display-link";

/** Opens the person's own dialer or mail app; nothing is called or sent automatically. */
export function openContact(kind: "phone" | "email", value: string) {
  const link = displayLink(value, kind);
  if (link) void Linking.openURL(link.href).catch(() => {});
}
