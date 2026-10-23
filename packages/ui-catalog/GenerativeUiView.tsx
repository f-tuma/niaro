import React, { Component, Fragment, type PropsWithChildren } from "react";
import { StyleSheet, View } from "react-native";
import type { ElementNode } from "@openuidev/lang-core";
import type { Language } from "../protocol";
import { tokens as t } from "../design-tokens";
import { Text } from "../ui";
import { GENERATIVE_UI_VIEWS } from "./generative-ui-components";
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
export function GenerativeUiView({
  program,
  streaming = false,
  disabled = false,
  language,
  onFollowUp,
  onOpenUrl,
}: GenerativeUiViewProps) {
  const { root, runtime } = useGenerativeUi({
    program,
    streaming,
    disabled,
    language,
    onFollowUp,
    onOpenUrl,
  });
  if (!root) return null;
  return (
    <RuntimeContext.Provider value={runtime}>
      <RenderNodeContext.Provider value={renderNode}>
        <View testID="generative-ui" style={styles.root}>
          <RenderNode node={root} />
        </View>
      </RenderNodeContext.Provider>
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
  // Names outside the shared library are dropped.
  const Renderer = Object.prototype.hasOwnProperty.call(
    GENERATIVE_UI_VIEWS,
    node.typeName,
  )
    ? GENERATIVE_UI_VIEWS[node.typeName as keyof typeof GENERATIVE_UI_VIEWS]
    : undefined;
  if (!Renderer) return null;
  return (
    <ElementBoundary>
      <Renderer props={node.props} />
    </ElementBoundary>
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
});
