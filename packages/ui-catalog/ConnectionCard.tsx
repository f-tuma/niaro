import React, { useState } from "react";
import { StyleSheet, View } from "react-native";
import { tokens as t } from "../design-tokens";
import type { AuthSession, Language } from "../protocol";
import { translate, type TranslationKey } from "../i18n";
import {
  Text,
  Field,
  Button,
  Notice,
  Group,
  IconTile,
  Row,
  ListBlock,
  ListRow,
} from "../ui";

function host(address: string | null) {
  if (!address) return "";
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}
export type ConnectionCardProps = {
  language: Language;
  address: string;
  activeAddress: string | null;
  status: "loading" | "signed_out" | "pairing" | "connected" | "expired";
  sessionStatus?: "connecting" | "online" | "offline" | "unauthorized";
  identity: AuthSession | null;
  renewable?: boolean;
  error: TranslationKey | null;
  development: boolean;
  web: boolean;
  onAddress(value: string): void;
  onPair(code: string): void;
  onDisconnect(): void;
  onBrowserSignIn?(): void;
  onOpenBrowser?(): void;
  browserLogin?: {
    userCode: string;
    verificationUri: string;
    expiresAt: string;
  } | null;
};
export function ConnectionCard(p: ConnectionCardProps) {
  const tr = translate(p.language);
  const [configure, setConfigure] = useState(false);
  // Cancel restores the address the app is connected to.
  const [savedAddress, setSavedAddress] = useState(p.address);
  const [details, setDetails] = useState(false);
  const showPairing = !p.identity || configure || p.status === "pairing";
  const busy = p.status === "loading" || p.status === "pairing";
  const dataUnavailable =
    p.sessionStatus === "offline" || p.sessionStatus === "unauthorized";
  const dataLoading = p.sessionStatus === "connecting";
  const connectionColor =
    dataUnavailable || dataLoading
      ? t.color.status.warning
      : t.color.status.success;
  return (
    <Group title={tr("connection")}>
      {p.identity ? (
        <>
          {/* Who this app talks to comes first; everything below acts on it. */}
          <View style={styles.account}>
            <IconTile icon="server" size={44} />
            <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
              <Text role="cardTitle" numberOfLines={1}>
                {host(p.activeAddress)}
              </Text>
              <Row style={{ gap: 6 }}>
                <View
                  style={[styles.online, { backgroundColor: connectionColor }]}
                />
                <Text role="caption" style={{ color: connectionColor }}>
                  {tr(
                    dataUnavailable
                      ? "signedInDataUnavailable"
                      : dataLoading
                        ? "signedInDataLoading"
                        : "connected",
                  )}
                </Text>
              </Row>
            </View>
          </View>
          {/* Scope IDs are for support only; people identify the server by host. */}
          <ListRow
            icon="info"
            label={tr("connectionDetails")}
            expanded={details}
            chevron={false}
            onPress={() => setDetails(!details)}
          />
          {details ? (
            <ListBlock continued>
              <Text role="caption" tone="secondary" selectable>
                {tr("signedInAs")}: {p.identity.scope.userId}
              </Text>
              <Text role="caption" tone="secondary" selectable>
                {tr("scope")}: {p.identity.scope.workspaceId}
              </Text>
              <Text role="caption" tone="secondary">
                {p.renewable
                  ? tr("sessionAutomatic")
                  : `${tr("sessionExpires")}: ${new Date(p.identity.expiresAt).toLocaleString(p.language)}`}
              </Text>
            </ListBlock>
          ) : null}
          <ListRow
            icon="edit"
            label={tr(configure ? "cancel" : "connectionSettings")}
            chevron={!configure}
            onPress={() => {
              if (configure) p.onAddress(savedAddress);
              else setSavedAddress(p.address);
              setConfigure(!configure);
            }}
          />
        </>
      ) : p.status === "expired" ? (
        <ListBlock>
          <Notice error>{tr("auth_expired")}</Notice>
        </ListBlock>
      ) : null}
      {showPairing ? (
        <ListBlock>
          <Field
            label={tr("address")}
            value={p.address}
            onChangeText={(value) => {
              p.onAddress(value);
            }}
            editable={!busy}
            placeholder="https://server.example"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          {p.development || p.web ? (
            <Text role="meta" tone="secondary">
              {[
                p.development ? tr("insecureHint") : null,
                p.web ? tr("webSessionHint") : null,
              ]
                .filter(Boolean)
                .join(" ")}
            </Text>
          ) : null}
          <Button
            label={tr("browserSignIn")}
            loading={busy}
            disabled={busy || !p.address.trim() || !p.onBrowserSignIn}
            onPress={p.onBrowserSignIn ?? (() => {})}
          />
          {p.error &&
          !(p.status === "expired" && p.error === "auth_expired") ? (
            <Notice error>{tr(p.error)}</Notice>
          ) : null}
        </ListBlock>
      ) : p.error ? (
        <ListBlock>
          <Notice error>{tr(p.error)}</Notice>
        </ListBlock>
      ) : null}
      {p.status === "pairing" ? (
        <ListRow
          label={tr("cancel")}
          chevron={false}
          onPress={p.onDisconnect}
        />
      ) : p.identity ? (
        <ListRow
          icon="logout"
          label={tr("signOut")}
          danger
          onPress={p.onDisconnect}
        />
      ) : null}
    </Group>
  );
}
const styles = StyleSheet.create({
  account: {
    padding: t.spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: t.spacing.md,
  },
  online: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: t.color.status.success,
  },
});
