import React, {
  Component,
  Fragment,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  AccessibilityInfo,
  findNodeHandle,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Maximize2 from "lucide-react-native/icons/maximize-2";
import type { ElementNode } from "@openuidev/lang-core";
import type { Language } from "../protocol";
import { tokens as t } from "../design-tokens";
import { Icon, Text } from "../ui";
import { GENERATIVE_UI_VIEWS } from "./generative-ui-components";
import {
  ElementPathContext,
  ElementPathsContext,
  PresentationContext,
  elementPaths,
} from "./generative-ui-presentation";
import {
  isElement,
  RenderNodeContext,
  RuntimeContext,
  useGenerativeUi,
} from "./generative-ui-runtime";

export type GenerativeUiViewProps = {
  /** One OpenUI Lang program; while streaming, the text received so far. */
  program: string;
  streaming?: boolean;
  /** Read-only history: controls are disabled and actions do nothing. */
  disabled?: boolean;
  language: Language;
  /** A follow-up for the person's message box; never sent from here. */
  onFollowUp: (text: string) => void;
  /** Opens a checked http(s) address; the system browser by default. */
  onOpenUrl?: (href: string) => void;
};

/**
 * Generated UI of an assistant answer, drawn with the app's own components.
 * It is presentation only: it fetches nothing and sends nothing.
 */
export function GenerativeUiView(props: GenerativeUiViewProps) {
  // An answer revision gets its own local fields and presentation state.
  // Streaming chunks share a parser; their controls have never been active.
  return (
    <GenerativeUiAnswer
      key={props.streaming ? "streaming" : `answer:${props.program}`}
      {...props}
    />
  );
}

function GenerativeUiAnswer({
  program,
  streaming = false,
  disabled = false,
  language,
  onFollowUp,
  onOpenUrl,
}: GenerativeUiViewProps) {
  const [expanded, setExpanded] = useState(false);
  const [presentation] = useState(() => new Map<string, unknown>());
  const [inlineHeight, setInlineHeight] = useState(0);
  const [initialScrollOffset, setInitialScrollOffset] = useState({
    x: 0,
    y: 0,
  });
  const scrollOffset = useRef({ x: 0, y: 0 });
  const expandControl = useRef<View>(null);
  const closeControl = useRef<View>(null);
  const followUp = useCallback(
    (text: string) => {
      // The existing host callback focuses its composer on the next frame.
      // Close first so that draft is visible, with no request sent here.
      setExpanded(false);
      onFollowUp(text);
    },
    [onFollowUp],
  );
  const { root, runtime } = useGenerativeUi({
    program,
    streaming,
    disabled,
    language,
    onFollowUp: followUp,
    onOpenUrl,
  });
  const paths = useMemo(
    () => (root ? elementPaths(root) : new WeakMap<ElementNode, string>()),
    [root],
  );
  const copy =
    language === "cs"
      ? { expand: "Otevřít naplno", title: "Odpověď", close: "Zpět do chatu" }
      : { expand: "Open full screen", title: "Answer", close: "Back to chat" };
  const focus = (target: View | null) => {
    if (!target) return;
    if (Platform.OS === "web") target.focus();
    else {
      const handle = findNodeHandle(target);
      if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
    }
  };
  const close = () => {
    Keyboard.dismiss();
    setExpanded(false);
    requestAnimationFrame(() => focus(expandControl.current));
  };
  if (!root) return null;
  const body = (
    <View testID="generative-ui" style={styles.root}>
      <RenderNode node={root} />
    </View>
  );
  return (
    <RuntimeContext.Provider value={runtime}>
      <PresentationContext.Provider value={presentation}>
        <ElementPathsContext.Provider value={paths}>
          <RenderNodeContext.Provider value={renderNode}>
            <View style={styles.root}>
              {!streaming ? (
                <View style={styles.toolbar}>
                  <Pressable
                    ref={expandControl}
                    accessibilityRole="button"
                    accessibilityLabel={copy.expand}
                    accessibilityState={{ expanded }}
                    onPress={() => {
                      Keyboard.dismiss();
                      setInitialScrollOffset(scrollOffset.current);
                      setExpanded(true);
                    }}
                    style={({ pressed }) => [
                      styles.expand,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text role="caption" tone="secondary">
                      {copy.expand}
                    </Text>
                    <Maximize2
                      size={16}
                      strokeWidth={1.7}
                      color={t.color.text.secondary}
                    />
                  </Pressable>
                </View>
              ) : null}
              {expanded ? (
                // Keep the parent chat's measured height and scroll position.
                <View style={{ height: inlineHeight }} />
              ) : (
                <View
                  onLayout={(event) => {
                    setInlineHeight(event.nativeEvent.layout.height);
                  }}
                >
                  {body}
                </View>
              )}
              <Modal
                visible={expanded}
                animationType="none"
                presentationStyle="fullScreen"
                onRequestClose={close}
                onShow={() => focus(closeControl.current)}
              >
                {expanded ? (
                  <SafeAreaView style={styles.canvas}>
                    <KeyboardAvoidingView
                      style={styles.flex}
                      behavior={Platform.OS === "ios" ? "padding" : undefined}
                    >
                      <View style={styles.header}>
                        <Text
                          role="cardTitle"
                          accessibilityRole="header"
                          style={styles.title}
                        >
                          {copy.title}
                        </Text>
                        <Pressable
                          ref={closeControl}
                          accessibilityRole="button"
                          accessibilityLabel={copy.close}
                          onPress={close}
                          style={({ pressed }) => [
                            styles.close,
                            pressed && styles.pressed,
                          ]}
                        >
                          <Text role="label">{copy.close}</Text>
                          <Icon name="close" size={20} />
                        </Pressable>
                      </View>
                      <ScrollView
                        testID="generative-ui-expanded"
                        keyboardShouldPersistTaps="handled"
                        keyboardDismissMode="interactive"
                        contentContainerStyle={styles.content}
                        contentOffset={initialScrollOffset}
                        onScroll={(event) => {
                          scrollOffset.current =
                            event.nativeEvent.contentOffset;
                        }}
                        scrollEventThrottle={100}
                      >
                        {body}
                      </ScrollView>
                    </KeyboardAvoidingView>
                  </SafeAreaView>
                ) : null}
              </Modal>
            </View>
          </RenderNodeContext.Provider>
        </ElementPathsContext.Provider>
      </PresentationContext.Provider>
    </RuntimeContext.Provider>
  );
}

/** A prop as content: elements render, plain values stay text. */
function renderNode(value: unknown): React.ReactNode {
  if (value == null || value === false) return null;
  if (typeof value === "string" || typeof value === "number")
    return <Text selectable>{String(value)}</Text>;
  if (Array.isArray(value))
    return value.map((item, index) => (
      <Fragment key={index}>{renderNode(item)}</Fragment>
    ));
  return isElement(value) ? <RenderNode node={value} /> : null;
}

function RenderNode({ node }: { node: ElementNode }) {
  const paths = useContext(ElementPathsContext);
  // Names outside the shared library are dropped.
  const Renderer = Object.prototype.hasOwnProperty.call(
    GENERATIVE_UI_VIEWS,
    node.typeName,
  )
    ? GENERATIVE_UI_VIEWS[node.typeName as keyof typeof GENERATIVE_UI_VIEWS]
    : undefined;
  if (!Renderer) return null;
  return (
    <ElementPathContext.Provider
      value={paths.get(node) ?? node.statementId ?? node.typeName}
    >
      <ElementBoundary>
        <Renderer props={node.props} />
      </ElementBoundary>
    </ElementPathContext.Provider>
  );
}

/**
 * Shows an element's last good render when it fails (as while streaming)
 * and recovers when new props arrive, like react-lang's boundary.
 */
class ElementBoundary extends Component<
  PropsWithChildren,
  { failed: boolean }
> {
  state = { failed: false };
  private last: React.ReactNode = null;
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidMount() {
    if (!this.state.failed) this.last = this.props.children;
  }
  componentDidUpdate(previous: PropsWithChildren) {
    if (!this.state.failed) this.last = this.props.children;
    else if (previous.children !== this.props.children)
      this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? this.last : this.props.children;
  }
}

const styles = StyleSheet.create({
  root: { minWidth: 0, gap: t.spacing.md },
  flex: { flex: 1, minHeight: 0 },
  toolbar: { flexDirection: "row", justifyContent: "flex-end" },
  expand: {
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pressed: { backgroundColor: t.color.pressed },
  canvas: { flex: 1, backgroundColor: t.color.background },
  header: {
    minHeight: 60,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: t.color.border,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  title: { flex: 1, flexShrink: 1 },
  close: {
    minHeight: 44,
    paddingHorizontal: 10,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  content: {
    padding: 20,
    paddingBottom: 40,
    width: "100%",
    maxWidth: 900,
    alignSelf: "center",
  },
});
