import React, {
  createContext,
  useContext,
  useState,
  type PropsWithChildren,
} from "react";
import {
  Switch,
  Text as NativeText,
  TextInput,
  View,
  Pressable,
  StyleSheet,
  ActivityIndicator,
  Platform,
  type TextProps,
  type TextInputProps,
  type ViewProps,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Svg, {
  Path,
  Defs,
  LinearGradient as SvgGradient,
  Stop,
} from "react-native-svg";
import Pencil from "lucide-react-native/icons/pencil";
import Search from "lucide-react-native/icons/search";
import Send from "lucide-react-native/icons/send";
import Play from "lucide-react-native/icons/play";
import Pause from "lucide-react-native/icons/pause";
import Volume2 from "lucide-react-native/icons/volume-2";
import Settings from "lucide-react-native/icons/settings";
import Mail from "lucide-react-native/icons/mail";
import Phone from "lucide-react-native/icons/phone";
import X from "lucide-react-native/icons/x";
import ChevronRight from "lucide-react-native/icons/chevron-right";
import Plus from "lucide-react-native/icons/plus";
import RefreshCw from "lucide-react-native/icons/refresh-cw";
import Info from "lucide-react-native/icons/info";
import MessageCircle from "lucide-react-native/icons/message-circle";
import Calendar from "lucide-react-native/icons/calendar";
import Check from "lucide-react-native/icons/check";
import CircleCheck from "lucide-react-native/icons/circle-check";
import Ellipsis from "lucide-react-native/icons/ellipsis";
import ArrowUp from "lucide-react-native/icons/arrow-up";
import Square from "lucide-react-native/icons/square";
import Mic from "lucide-react-native/icons/mic";
import Clock from "lucide-react-native/icons/clock";
import History from "lucide-react-native/icons/rotate-ccw-clock";
import Pin from "lucide-react-native/icons/pin";
import User from "lucide-react-native/icons/user";
import Link from "lucide-react-native/icons/link";
import Menu from "lucide-react-native/icons/menu";
import ChevronLeft from "lucide-react-native/icons/chevron-left";
import SquarePen from "lucide-react-native/icons/square-pen";
import Zap from "lucide-react-native/icons/zap";
import Bell from "lucide-react-native/icons/bell";
import Globe from "lucide-react-native/icons/globe";
import Server from "lucide-react-native/icons/server";
import LogOut from "lucide-react-native/icons/log-out";
import Trash from "lucide-react-native/icons/trash";
import Upload from "lucide-react-native/icons/upload";
import Sparkles from "lucide-react-native/icons/sparkles";
import FileText from "lucide-react-native/icons/file-text";
import Quote from "lucide-react-native/icons/quote";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import AudioLines from "lucide-react-native/icons/audio-lines";
import Smartphone from "lucide-react-native/icons/smartphone";
import Circle from "lucide-react-native/icons/circle";
import Archive from "lucide-react-native/icons/archive";
import ArchiveRestore from "lucide-react-native/icons/archive-restore";
import { tokens as t } from "../design-tokens";
import { Entrance, MotionPressable } from "./motion";
export const ui = StyleSheet.create({
  // A pill: the text composer and the voice composer share this box.
  composerFrame: {
    padding: 5,
    borderRadius: 27,
    borderWidth: 1,
    borderColor: t.color.border,
    backgroundColor: t.color.surface,
    ...t.elevation.card,
  },
  stack: { gap: t.spacing.stackGap },
  row: { flexDirection: "row", alignItems: "center", gap: t.spacing.inlineGap },
  surface: {
    backgroundColor: t.color.surface,
    borderRadius: t.radius.card,
    padding: t.spacing.cardPadding,
    borderWidth: 1,
    borderColor: t.color.border,
    gap: t.spacing.md,
    ...t.elevation.card,
  },
  input: {
    backgroundColor: t.color.fill,
    borderWidth: 1,
    borderColor: t.color.fill,
    borderRadius: t.radius.control,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    minHeight: t.control.minHeight,
    color: t.color.text.primary,
    ...t.typography.body,
    ...(Platform.OS === "web"
      ? { outlineStyle: "solid", outlineWidth: 0 }
      : {}),
  },
  button: {
    minHeight: t.control.large,
    borderRadius: t.radius.pill,
    paddingVertical: t.spacing.sm,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: t.spacing.sm,
  },
  buttonSmall: {
    minHeight: t.control.small,
    paddingVertical: t.spacing.xs,
    paddingHorizontal: 14,
    gap: 6,
  },
  notice: {
    paddingVertical: 10,
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.control,
    backgroundColor: t.color.fill,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
  },
  group: {
    backgroundColor: t.color.surface,
    borderRadius: t.radius.group,
    borderWidth: 1,
    borderColor: t.color.border,
    overflow: "hidden",
  },
  /** A full-width hairline above a row (legacy; ListRow insets its own). */
  listItem: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.color.hairline,
  },
  listRow: {
    minHeight: t.control.row,
    paddingHorizontal: t.spacing.lg,
    paddingVertical: t.spacing.md,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  separator: {
    position: "absolute",
    top: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: t.color.border,
    pointerEvents: "none",
  },
  listBlock: { padding: t.spacing.lg, gap: t.spacing.md },
  segmented: {
    flexDirection: "row",
    padding: 3,
    gap: 2,
    borderRadius: t.radius.control,
    backgroundColor: t.color.fill,
  },
  segment: {
    minHeight: 32,
    minWidth: 44,
    paddingHorizontal: t.spacing.md,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
  },
});
export function Text({
  role = "body",
  tone = "primary",
  style,
  ...props
}: Omit<TextProps, "role"> & {
  role?: keyof typeof t.typography;
  tone?: keyof typeof t.color.text;
}) {
  return (
    <NativeText
      {...props}
      style={[
        t.typography[role],
        { color: t.color.text[tone], includeFontPadding: false },
        style,
      ]}
    />
  );
}
export function Surface(props: ViewProps) {
  return <View {...props} style={[ui.surface, props.style]} />;
}
export function Stack(props: ViewProps) {
  return <View {...props} style={[ui.stack, props.style]} />;
}
export function Row(props: ViewProps) {
  return <View {...props} style={[ui.row, props.style]} />;
}
export function Field({ label, ...props }: TextInputProps & { label: string }) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      <Text role="section" tone="secondary">
        {label}
      </Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.color.text.secondary}
        {...props}
        onFocus={(event) => {
          setFocused(true);
          props.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          props.onBlur?.(event);
        }}
        style={[
          ui.input,
          props.style,
          focused && {
            borderColor: t.color.action.primary,
            backgroundColor: t.color.surface,
          },
        ]}
      />
    </View>
  );
}
export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";
const buttonColors: Record<
  ButtonVariant,
  { fill: string; pressed: string; content: string }
> = {
  // The one filled action of a view.
  primary: {
    fill: t.color.action.primary,
    pressed: t.color.action.pressed,
    content: t.color.text.inverse,
  },
  // Tonal neutral: the companion of a primary, or a lone secondary action.
  secondary: {
    fill: t.color.fill,
    pressed: t.color.fillPressed,
    content: t.color.text.primary,
  },
  // Plain text: Cancel, Not now, Show more.
  quiet: {
    fill: "transparent",
    pressed: t.color.pressed,
    content: t.color.action.primary,
  },
  // Destructive, tonal red.
  danger: {
    fill: t.color.action.dangerSoft,
    pressed: t.color.action.dangerPressed,
    content: t.color.action.danger,
  },
};
/**
 * A pill button. `large` (52) is the screen's or sheet's one action; `small`
 * (36) sits at the end of a row or inside a card.
 */
export function Button({
  label,
  onPress,
  disabled,
  loading,
  variant = "primary",
  size = "large",
  icon,
  style,
}: {
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: ButtonVariant;
  size?: "large" | "small";
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  const inactive = disabled || loading;
  const colors = buttonColors[variant];
  const small = size === "small";
  // A disabled plain button stays plain; filled ones grey out.
  const content = inactive ? t.color.text.disabled : colors.content;
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      aria-disabled={!!inactive}
      aria-busy={!!loading}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        ui.button,
        small && ui.buttonSmall,
        style,
        {
          backgroundColor:
            inactive && variant !== "quiet"
              ? t.color.action.disabled
              : pressed
                ? colors.pressed
                : colors.fill,
        },
      ]}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={
            variant === "primary" ? t.color.text.secondary : colors.content
          }
        />
      ) : icon ? (
        <Icon name={icon} size={small ? 16 : 20} color={content} />
      ) : null}
      <Text
        role={small ? "label" : "button"}
        style={{ flexShrink: 1, textAlign: "center", color: content }}
      >
        {label}
      </Text>
    </MotionPressable>
  );
}
/** One quiet inline message; errors turn red, nothing turns blue. */
export function Notice({
  children,
  error = false,
  icon,
}: PropsWithChildren<{ error?: boolean; icon?: IconName }>) {
  const color = error ? t.color.status.error : t.color.text.secondary;
  return (
    <View
      accessibilityRole={error ? "alert" : undefined}
      accessibilityLiveRegion="polite"
      style={[
        ui.notice,
        error ? { backgroundColor: t.color.action.dangerSoft } : null,
      ]}
    >
      <View style={{ marginTop: 1 }}>
        <Icon
          name={icon ?? (error ? "alert" : "info")}
          size={16}
          color={color}
        />
      </View>
      <Text
        role="caption"
        style={{
          flex: 1,
          minWidth: 0,
          color: error ? t.color.status.error : t.color.text.primary,
        }}
      >
        {children}
      </Text>
    </View>
  );
}
export function ActionToast({
  message,
  description = message,
  actionLabel,
  onAction,
}: {
  message: string;
  description?: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <Row
      testID="action-toast"
      style={{
        minHeight: 52,
        paddingLeft: t.spacing.md,
        paddingRight: t.spacing.xs,
        borderRadius: t.radius.control,
        backgroundColor: t.color.action.dangerSoft,
      }}
    >
      <Icon name="alert" size={18} color={t.color.status.error} />
      <Text
        role="caption"
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        accessibilityLabel={description}
        numberOfLines={1}
        style={{ flex: 1, color: t.color.status.error }}
      >
        {message}
      </Text>
      <MotionPressable
        accessibilityRole="button"
        accessibilityLabel={actionLabel}
        onPress={onAction}
        style={({ pressed }) => ({
          minHeight: t.control.minHeight,
          paddingHorizontal: t.spacing.sm,
          justifyContent: "center",
          borderRadius: t.radius.control,
          backgroundColor: pressed
            ? t.color.action.dangerPressed
            : "transparent",
        })}
      >
        <Text role="label" style={{ color: t.color.text.primary }}>
          {actionLabel}
        </Text>
      </MotionPressable>
    </Row>
  );
}
export function Badge({
  label,
  success = false,
}: {
  label: string;
  success?: boolean;
}) {
  return (
    <Row>
      <Icon
        name={success ? "check" : "clock"}
        size={16}
        color={success ? t.color.status.success : t.color.action.primary}
      />
      <Text
        role="caption"
        style={{
          color: success ? t.color.status.success : t.color.action.primary,
        }}
      >
        {label}
      </Text>
    </Row>
  );
}
// Lucide (ISC), one module per glyph so the bundle carries only these.
const icons = {
  edit: Pencil,
  search: Search,
  send: Send,
  play: Play,
  pause: Pause,
  volume: Volume2,
  settings: Settings,
  mail: Mail,
  phone: Phone,
  close: X,
  chevron: ChevronRight,
  plus: Plus,
  refresh: RefreshCw,
  info: Info,
  chat: MessageCircle,
  calendar: Calendar,
  check: Check,
  tasks: CircleCheck,
  more: Ellipsis,
  arrow: ArrowUp,
  speaker: Volume2,
  stop: Square,
  mic: Mic,
  clock: Clock,
  history: History,
  pin: Pin,
  person: User,
  link: Link,
  menu: Menu,
  back: ChevronLeft,
  compose: SquarePen,
  bolt: Zap,
  bell: Bell,
  globe: Globe,
  server: Server,
  logout: LogOut,
  trash: Trash,
  upload: Upload,
  sparkle: Sparkles,
  transcript: FileText,
  quote: Quote,
  alert: TriangleAlert,
  waveform: AudioLines,
  device: Smartphone,
  record: Circle,
  archive: Archive,
  restore: ArchiveRestore,
} as const;
export type IconName = keyof typeof icons;
export function Icon({
  name,
  size = 22,
  color = t.color.text.primary,
}: {
  name: IconName;
  size?: number;
  color?: string;
}) {
  const Glyph = icons[name];
  return <Glyph size={size} color={color} strokeWidth={1.75} aria-hidden />;
}
export function BrandMark() {
  return (
    <Svg width={30} height={30} viewBox="0 0 30 30" aria-hidden>
      <Defs>
        <SvgGradient id="brand" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={t.color.text.primary} />
          <Stop offset="1" stopColor={t.color.text.secondary} />
        </SvgGradient>
      </Defs>
      <Path
        d="M14 2C-2 2-2 28 12 28ZM18 2C34 4 34 28 16 28Z"
        fill="url(#brand)"
      />
    </Svg>
  );
}
export function IdleWave({ height = 210 }: { height?: number }) {
  return (
    <Svg
      width="100%"
      height={height}
      viewBox="0 0 393 210"
      preserveAspectRatio={height === 210 ? undefined : "none"}
      aria-hidden
    >
      <Defs>
        <SvgGradient id="waveFill" x1="0" y1="0" x2="1" y2="0.65">
          <Stop offset="0" stopColor={t.color.wave.mist} stopOpacity={0.2} />
          <Stop
            offset={0.3}
            stopColor={t.color.wave.violet}
            stopOpacity={0.8}
          />
          <Stop
            offset={0.56}
            stopColor={t.color.wave.cyan}
            stopOpacity={0.85}
          />
          <Stop
            offset={0.78}
            stopColor={t.color.wave.lilac}
            stopOpacity={0.6}
          />
          <Stop offset="1" stopColor={t.color.wave.edge} stopOpacity={0.1} />
        </SvgGradient>
        <SvgGradient id="waveLine">
          <Stop offset="0" stopColor={t.color.wave.line} stopOpacity={0} />
          <Stop offset={0.45} stopColor={t.color.wave.blue} stopOpacity={0.5} />
          <Stop
            offset={0.7}
            stopColor={t.color.wave.highlight}
            stopOpacity={0.6}
          />
          <Stop offset="1" stopColor={t.color.wave.line} stopOpacity={0} />
        </SvgGradient>
      </Defs>
      <Path
        d="M0 107C37 79 46 43 81 79S125 0 175 20 215 113 258 105 302 72 339 94 365 115 393 91L393 137C349 106 322 178 276 167S221 76 178 95 125 163 88 139 40 77 0 118Z"
        fill="url(#waveFill)"
      />
      {Array.from({ length: 30 }, (_, i) => (
        <Path
          key={i}
          d={`M0 ${107 + i * 0.32} C48 ${62 + i * 1.7} 62 ${142 + i * 0.35} 100 ${125 - i * 0.8} S166 ${17 + i * 1.6} 194 ${78 + i * 0.58} 225 ${166 + i * 0.7} 270 ${161 - i * 0.6} 340 ${107 + i * 0.4} 393 ${103 + i * 0.7}`}
          fill="none"
          stroke="url(#waveLine)"
          strokeWidth={0.8}
        />
      ))}
      <Path
        d="M0 110C44 63 62 161 109 122S177 27 203 96 239 177 290 146 350 109 393 128"
        fill="none"
        stroke={t.color.text.inverse}
        strokeOpacity={0.85}
        strokeWidth={1.3}
      />
    </Svg>
  );
}

/** Optional explanation, separate from visible consent/effect information. */
export function Disclosure({
  label,
  children,
  onToggle,
}: PropsWithChildren<{
  label: string;
  onToggle?: (expanded: boolean) => void;
}>) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View>
      <MotionPressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        onPress={() => {
          onToggle?.(!expanded);
          setExpanded(!expanded);
        }}
        style={{
          minHeight: t.control.minHeight,
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <Icon name="info" size={18} color={t.color.text.secondary} />
        <Text role="caption" tone="secondary" style={{ flex: 1 }}>
          {label}
        </Text>
        <View style={{ transform: [{ rotate: expanded ? "90deg" : "0deg" }] }}>
          <Icon name="chevron" size={15} color={t.color.text.secondary} />
        </View>
      </MotionPressable>
      {expanded ? (
        <Entrance distance={3}>
          <View style={{ paddingTop: 4, paddingBottom: 12, gap: 8 }}>
            {children}
          </View>
        </Entrance>
      ) : null}
    </View>
  );
}
export function DetailRow({
  icon,
  label,
  children,
}: PropsWithChildren<{ icon: IconName; label: string }>) {
  return (
    <Row style={{ alignItems: "flex-start", gap: 12 }}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: t.radius.small,
          backgroundColor: t.color.fill,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name={icon} size={18} color={t.color.text.secondary} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text role="caption" tone="secondary">
          {label}
        </Text>
        {children}
      </View>
    </Row>
  );
}

/**
 * An inset grouped list (iOS style): a white rounded block whose rows
 * separate themselves with hairlines inset to the text.
 */
/** Rows draw separators only inside a Group; a lone row stands clean. */
const InGroup = createContext(false);
export function Group({
  title,
  trailing,
  children,
  testID,
}: PropsWithChildren<{
  title?: string;
  /** A small action beside the title, e.g. "See all". */
  trailing?: React.ReactNode;
  testID?: string;
}>) {
  return (
    <View testID={testID} style={{ gap: t.spacing.sm }}>
      {title ? <SectionLabel trailing={trailing}>{title}</SectionLabel> : null}
      <View style={ui.group}>
        {/* The first row's top hairline is clipped by the group edge. */}
        <View style={{ marginTop: -StyleSheet.hairlineWidth }}>
          <InGroup.Provider value>{children}</InGroup.Provider>
        </View>
      </View>
    </View>
  );
}
/** Free content inside a Group, such as a form, aligned with its rows. */
export function ListBlock({
  children,
  continued = false,
}: PropsWithChildren<{
  /** Continues the row above (e.g. expanded details), aligned to its label. */
  continued?: boolean;
}>) {
  const grouped = useContext(InGroup);
  return (
    <View
      style={
        continued
          ? [ui.listBlock, { paddingTop: 0, paddingLeft: 52, gap: 4 }]
          : ui.listBlock
      }
    >
      {continued || !grouped ? null : (
        <View style={[ui.separator, { left: t.spacing.lg }]} />
      )}
      {children}
    </View>
  );
}
const ROW_ICON = 22;
/**
 * One row of a Group: leading icon or avatar, a title, one meta line, then a
 * value, a custom trailing element and/or a chevron.
 */
export function ListRow({
  icon,
  leading,
  label,
  description,
  value,
  trailing,
  onPress,
  danger = false,
  disabled = false,
  chevron = !!onPress && !danger,
  selected,
  expanded,
  strong = !!leading,
  accessibilityLabel,
  testID,
  children,
}: PropsWithChildren<{
  icon?: IconName;
  /** An avatar, IconTile or date badge in place of `icon`. */
  leading?: React.ReactNode;
  label: string;
  /** The one meta line under the title. */
  description?: string;
  value?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  danger?: boolean;
  disabled?: boolean;
  chevron?: boolean;
  selected?: boolean;
  /** For a row that shows or hides details below it. */
  expanded?: boolean;
  /** A bold title for an object (meeting, task); settings rows stay medium. */
  strong?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}>) {
  const color = danger ? t.color.action.danger : t.color.text.primary;
  const grouped = useContext(InGroup);
  // The separator starts where the text does, wherever the leading ends.
  const [inset, setInset] = useState<number>(
    t.spacing.lg + (icon && !leading ? ROW_ICON + 14 : 0),
  );
  const lead =
    leading ??
    (icon ? (
      <Icon
        name={icon}
        size={ROW_ICON}
        color={danger ? t.color.action.danger : t.color.text.primary}
      />
    ) : null);
  const content = (
    <>
      {grouped ? <View style={[ui.separator, { left: inset }]} /> : null}
      {/* Rows with free content keep the leading on the title's line. */}
      {lead && children ? (
        <View style={{ alignSelf: "flex-start" }}>{lead}</View>
      ) : (
        lead
      )}
      <View
        style={{ flex: 1, minWidth: 0, gap: 2 }}
        onLayout={(e) => {
          const x = Math.round(e.nativeEvent.layout.x);
          if (x !== inset) setInset(x);
        }}
      >
        <Text role={strong ? "rowTitle" : "rowLabel"} style={{ color }}>
          {label}
        </Text>
        {description ? (
          <Text role="meta" tone="secondary">
            {description}
          </Text>
        ) : null}
        {children}
      </View>
      {value ? (
        <Text
          tone="secondary"
          numberOfLines={1}
          style={{ flexShrink: 1, maxWidth: "45%", textAlign: "right" }}
        >
          {value}
        </Text>
      ) : null}
      {trailing}
      {chevron || expanded !== undefined ? (
        <View
          style={[
            { marginRight: -4 },
            expanded ? { transform: [{ rotate: "90deg" }] } : null,
          ]}
        >
          <Icon name="chevron" size={18} color={t.color.text.disabled} />
        </View>
      ) : null}
    </>
  );
  if (!onPress)
    return (
      <View testID={testID} style={ui.listRow}>
        {content}
      </View>
    );
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled, selected, expanded }}
      aria-expanded={expanded}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        ui.listRow,
        {
          opacity: disabled ? 0.5 : 1,
          backgroundColor: pressed
            ? t.color.pressed
            : selected
              ? t.color.accent.softBlue
              : "transparent",
        },
      ]}
    >
      {content}
    </Pressable>
  );
}
/** A compact choice between a few equal options, e.g. EN / CS. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  accessibilityLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  accessibilityLabel: string;
}) {
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={accessibilityLabel}
      style={ui.segmented}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ checked }}
            aria-checked={checked}
            onPress={() => onChange(option.value)}
            style={[
              ui.segment,
              checked && {
                backgroundColor: t.color.surfaceRaised,
                ...t.elevation.card,
              },
            ]}
          >
            <Text
              role="caption"
              tone={checked ? "primary" : "secondary"}
              style={checked ? { fontWeight: "600" } : undefined}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export type Tone = keyof typeof t.color.tile;
/** A tinted square that names a destination by icon and colour. */
export function IconTile({
  icon,
  tone = "blue",
  size = 40,
}: {
  icon: IconName;
  tone?: Tone;
  size?: number;
}) {
  const colors = t.color.tile[tone];
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.background,
      }}
    >
      <Icon
        name={icon}
        size={Math.round(size * 0.5)}
        color={colors.foreground}
      />
    </View>
  );
}
const tones = Object.keys(t.color.tile) as Tone[];
/** Initials in a stable colour per name; recognisable before it is read. */
export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? "")
    .join("");
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const colors = t.color.tile[tones[Math.abs(hash) % tones.length]!];
  return (
    <View
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.background,
      }}
    >
      <Text
        style={{
          color: colors.foreground,
          fontSize: Math.round(size * 0.42),
          lineHeight: Math.round(size * 0.5),
          fontWeight: "700",
        }}
      >
        {letters || "?"}
      </Text>
    </View>
  );
}
/** A compact fact (who, when, where from); pressable only when it opens something. */
export function Chip({
  icon,
  label,
  leading,
  onPress,
  accessibilityLabel,
}: {
  icon?: IconName;
  label: string;
  leading?: React.ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const color = onPress ? t.color.action.primary : t.color.text.secondary;
  const content = (
    <>
      {leading ?? (icon ? <Icon name={icon} size={14} color={color} /> : null)}
      <Text
        role="meta"
        numberOfLines={1}
        style={{ flexShrink: 1, color, fontWeight: "500" }}
      >
        {label}
      </Text>
    </>
  );
  const style = {
    minHeight: 26,
    maxWidth: "100%" as const,
    paddingLeft: leading ? 3 : icon ? 8 : 10,
    paddingRight: 10,
    borderRadius: t.radius.pill,
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: 5,
  };
  if (!onPress)
    return (
      <View
        accessible={!!accessibilityLabel}
        accessibilityLabel={accessibilityLabel}
        style={[style, { backgroundColor: t.color.fill }]}
      >
        {content}
      </View>
    );
  return (
    <MotionPressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [
        style,
        {
          backgroundColor: pressed
            ? t.color.fillPressed
            : t.color.accent.softBlue,
        },
      ]}
    >
      {content}
    </MotionPressable>
  );
}
export type StatusTone = keyof typeof t.color.statusSoft;
/**
 * The one status component: a dot (or icon/spinner) and a word on a soft
 * tint. Colour only reinforces the word.
 */
export function StatusPill({
  label,
  tone,
  icon,
  busy = false,
  compact = false,
}: {
  label: string;
  tone: StatusTone;
  icon?: IconName;
  busy?: boolean;
  /** Inside a line of meta text; the default matches a Chip's height. */
  compact?: boolean;
}) {
  const color = t.color.status[tone];
  return (
    <View
      style={{
        minHeight: compact ? 20 : 26,
        paddingHorizontal: compact ? 7 : 9,
        borderRadius: t.radius.pill,
        flexDirection: "row",
        alignItems: "center",
        alignSelf: "flex-start",
        gap: 5,
        backgroundColor: t.color.statusSoft[tone],
      }}
    >
      {busy ? (
        <ActivityIndicator
          size="small"
          color={color}
          style={{ width: 12, height: 12, transform: [{ scale: 0.55 }] }}
        />
      ) : icon ? (
        <Icon name={icon} size={12} color={color} />
      ) : (
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: color,
          }}
        />
      )}
      <Text role="overline" numberOfLines={1} style={{ color, flexShrink: 1 }}>
        {label}
      </Text>
    </View>
  );
}
/** Group heading outside a surface: sentence case, muted, aligned with the rows. */
export function SectionLabel({
  children,
  trailing,
}: PropsWithChildren<{ trailing?: React.ReactNode }>) {
  return (
    <Row style={{ paddingHorizontal: t.spacing.xs, minHeight: 20 }}>
      <Text
        role="section"
        tone="secondary"
        accessibilityRole="header"
        style={{ flex: 1 }}
      >
        {children}
      </Text>
      {trailing}
    </Row>
  );
}
/** The one on/off control; web needs its active thumb set explicitly. */
export function Toggle({
  value,
  onChange,
  accessibilityLabel,
  disabled = false,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
  accessibilityLabel: string;
  disabled?: boolean;
}) {
  return (
    <Switch
      value={value}
      onValueChange={onChange}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={disabled ? { disabled } : undefined}
      trackColor={{ false: t.color.fillPressed, true: t.color.action.primary }}
      thumbColor={t.color.surfaceRaised}
      {...(Platform.OS === "web"
        ? { activeThumbColor: t.color.surfaceRaised }
        : {})}
    />
  );
}
