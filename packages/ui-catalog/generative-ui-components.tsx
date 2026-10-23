import React, { createContext, useContext, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { displayFieldIcon, displayLink } from "../protocol/display-link";
import type { GenerativeUiComponentName } from "../openui-library/spec";
import { safeUrl } from "../openui-library/program";
import { tokens as t } from "../design-tokens";
import { translate } from "../i18n";
import {
  Button,
  Disclosure,
  Field,
  Group,
  Icon,
  ListRow,
  Row,
  StatusPill,
  Text,
  Toggle,
  type ButtonVariant,
  type IconName,
  type StatusTone,
} from "../ui";
import { Tabs } from "../ui/Tabs";
import { MotionPressable } from "../ui/motion";
import { MarkdownText } from "./MarkdownText";
import { openContact } from "./contact-link";
import {
  BarChartView,
  LineChartView,
  PieChartView,
} from "./generative-ui-charts";
import {
  elements,
  formatNumber,
  FormNameContext,
  isElement,
  list,
  num,
  str,
  useGenerativeField,
  useRenderNode,
  useRuntime,
  type FieldError,
  type FieldKind,
} from "./generative-ui-runtime";

/** Evaluated props of one element; while streaming any of them may be missing. */
export type GenerativeProps = { props: Record<string, unknown> };
type Renderer = (input: GenerativeProps) => React.ReactNode;

/** A model value as text: numbers in the person's locale, strings as written. */
const shown = (value: unknown, language: string) =>
  typeof value === "number" && Number.isFinite(value)
    ? formatNumber(value, language)
    : (str(value) ?? "");

type Tone = "neutral" | "info" | "success" | "warning" | "danger";
const statusTone: Record<Tone, StatusTone> = {
  neutral: "unknown",
  info: "needsInput",
  success: "success",
  warning: "warning",
  danger: "error",
};
const toneOf = (value: unknown): Tone | undefined =>
  typeof value === "string" && value in statusTone
    ? (value as Tone)
    : undefined;
const toneColor: Record<Tone, string> = {
  neutral: t.color.text.secondary,
  info: t.color.action.primary,
  success: t.color.status.success,
  warning: t.color.status.warning,
  danger: t.color.status.error,
};

const Children: Renderer = ({ props }) => {
  const render = useRenderNode();
  return <View style={styles.stack}>{render(props.children)}</View>;
};

const RowView: Renderer = ({ props }) => {
  const render = useRenderNode();
  return (
    <View style={styles.row}>
      {list(props.children).map((child, index) => (
        <View key={index} style={styles.rowItem}>
          {render(child)}
        </View>
      ))}
    </View>
  );
};

function GridView({ props }: GenerativeProps) {
  const render = useRenderNode();
  const [width, setWidth] = useState(0);
  const children = list(props.children);
  const wanted = Math.min(4, Math.max(2, num(props.columns) ?? 2));
  // One column on a phone, as many as fit (≥ 160 each) on wider screens.
  const columns =
    width < 480 ? 1 : Math.max(1, Math.min(wanted, Math.floor(width / 160)));
  const rows: unknown[][] = [];
  for (let index = 0; index < children.length; index += columns)
    rows.push(children.slice(index, index + columns));
  return (
    <View
      style={styles.stack}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {rows.map((row, index) => (
        <View key={index} style={styles.gridRow}>
          {Array.from({ length: columns }, (_, column) => (
            <View key={column} style={styles.gridCell}>
              {column < row.length ? render(row[column]) : null}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

const SectionView: Renderer = ({ props }) => {
  const render = useRenderNode();
  const title = str(props.title);
  return (
    <View style={styles.section}>
      {title ? (
        <Text role="label" accessibilityRole="header" selectable>
          {title}
        </Text>
      ) : null}
      {render(props.children)}
    </View>
  );
};

function TabsView({ props }: GenerativeProps) {
  const render = useRenderNode();
  const tabs = elements(props.tabs, "Tab");
  const [selected, setSelected] = useState("0");
  if (!tabs.length) return null;
  const index = Math.min(Number(selected), tabs.length - 1);
  return (
    <View style={styles.stack}>
      <Tabs
        options={tabs.map((tab, position) => ({
          id: String(position),
          label: str(tab.props.label) ?? String(position + 1),
        }))}
        value={String(index)}
        onChange={setSelected}
      />
      <View style={styles.stack}>{render(tabs[index]!.props.children)}</View>
    </View>
  );
}

const AccordionItemView: Renderer = ({ props }) => {
  const render = useRenderNode();
  const title = str(props.title);
  if (!title) return null;
  return (
    <Disclosure label={title}>
      <View style={styles.stack}>{render(props.children)}</View>
    </Disclosure>
  );
};
const AccordionView: Renderer = ({ props }) => {
  const render = useRenderNode();
  return <View>{render(elements(props.items, "AccordionItem"))}</View>;
};

const SeparatorView: Renderer = () => <View style={styles.separator} />;

const HeadingView: Renderer = ({ props }) => {
  const text = str(props.text);
  if (!text) return null;
  return (
    <Text
      role={props.size === "l" ? "cardTitle" : "rowTitle"}
      accessibilityRole="header"
      selectable
    >
      {text}
    </Text>
  );
};
const TextView: Renderer = ({ props }) => {
  const text = str(props.text);
  if (!text) return null;
  return (
    <Text
      tone={props.tone === "muted" ? "secondary" : "primary"}
      selectable
      style={styles.shrink}
    >
      {text}
    </Text>
  );
};
const MarkdownView: Renderer = ({ props }) => {
  const text = str(props.text);
  return text ? <MarkdownText text={text} /> : null;
};

const calloutStyle = {
  info: { background: t.color.fill, icon: "info", color: t.color.text.primary },
  success: {
    background: t.color.statusSoft.success,
    icon: "check",
    color: t.color.status.success,
  },
  warning: {
    background: t.color.statusSoft.warning,
    icon: "alert",
    color: t.color.status.warning,
  },
  danger: {
    background: t.color.action.dangerSoft,
    icon: "alert",
    color: t.color.status.error,
  },
} satisfies Record<
  Exclude<Tone, "neutral">,
  { background: string; icon: IconName; color: string }
>;
const CalloutView: Renderer = ({ props }) => {
  const text = str(props.text);
  if (!text) return null;
  const tone =
    props.tone === "success" ||
    props.tone === "warning" ||
    props.tone === "danger"
      ? props.tone
      : "info";
  const look = calloutStyle[tone];
  const title = str(props.title);
  return (
    <View
      accessibilityRole={tone === "danger" ? "alert" : undefined}
      style={[styles.callout, { backgroundColor: look.background }]}
    >
      <View style={styles.calloutIcon}>
        <Icon
          name={look.icon}
          size={16}
          color={tone === "info" ? t.color.text.secondary : look.color}
        />
      </View>
      <View style={styles.content}>
        {title ? (
          <Text role="label" selectable style={{ color: look.color }}>
            {title}
          </Text>
        ) : null}
        <Text role="caption" selectable>
          {text}
        </Text>
      </View>
    </View>
  );
};

const BadgeView: Renderer = ({ props }) => {
  const label = str(props.label);
  if (!label) return null;
  return (
    <View accessible accessibilityLabel={label}>
      <StatusPill
        label={label}
        tone={statusTone[toneOf(props.tone) ?? "neutral"]}
      />
    </View>
  );
};

function LinkView({ props }: GenerativeProps) {
  const runtime = useRuntime();
  const label = str(props.label);
  const href = safeUrl(props.url);
  if (!label) return null;
  if (!href) return <Text selectable>{label}</Text>;
  return (
    <MotionPressable
      accessibilityRole="link"
      accessibilityLabel={label}
      onPress={() => runtime.openUrl(href)}
      style={styles.link}
    >
      <Icon name="link" size={16} color={t.color.action.primary} />
      <Text style={styles.linkText}>{label}</Text>
    </MotionPressable>
  );
}

function MetricView({ props }: GenerativeProps) {
  const { language } = useRuntime();
  const label = str(props.label);
  const value = shown(props.value, language);
  if (!label || !value) return null;
  const unit = str(props.unit);
  const change = str(props.change);
  const tone = toneOf(props.tone);
  return (
    <View
      accessible
      accessibilityLabel={[label, unit ? `${value} ${unit}` : value, change]
        .filter(Boolean)
        .join(", ")}
      style={styles.metric}
    >
      <Text role="meta" tone="secondary">
        {label}
      </Text>
      <View style={styles.metricValue}>
        <Text role="title" style={styles.tabular}>
          {value}
        </Text>
        {unit ? (
          <Text role="caption" tone="secondary">
            {unit}
          </Text>
        ) : null}
      </View>
      {change ? (
        <Text
          role="caption"
          style={[
            styles.tabular,
            { color: tone ? toneColor[tone] : t.color.text.secondary },
          ]}
        >
          {change}
        </Text>
      ) : null}
    </View>
  );
}

function DetailView({ props }: GenerativeProps) {
  const runtime = useRuntime();
  const tr = translate(runtime.language);
  const label = str(props.label);
  const value = shown(props.value, runtime.language);
  if (!label || !value) return null;
  // Only a complete written value becomes a link, never a number.
  const icon =
    typeof props.value === "string"
      ? displayFieldIcon(label, value)
      : undefined;
  const link = icon
    ? displayLink(value, icon === "phone" ? "phone" : undefined)
    : undefined;
  const content = (
    <View style={styles.detail}>
      <Text role="meta" tone="secondary" style={styles.detailLabel}>
        {label}
      </Text>
      <Text
        selectable={!link}
        style={[
          styles.detailValue,
          typeof props.value === "number" && styles.tabular,
          link && styles.linkText,
        ]}
      >
        {value}
      </Text>
    </View>
  );
  if (!link) return content;
  const kind = link.kind;
  return (
    <MotionPressable
      accessibilityRole="link"
      accessibilityLabel={tr(
        kind === "phone"
          ? "contactCall"
          : kind === "email"
            ? "contactWrite"
            : "contactOpen",
      ).replace("{value}", value)}
      onPress={() =>
        kind === "url" ? runtime.openUrl(link.href) : openContact(kind, value)
      }
      style={styles.linkRow}
    >
      {content}
    </MotionPressable>
  );
}
const DetailsView: Renderer = ({ props }) => {
  const render = useRenderNode();
  const rows = elements(props.items, "Detail");
  if (!rows.length) return null;
  return (
    <View style={styles.shrink}>
      {rows.map((row, index) => (
        <View key={index} style={index > 0 && styles.separated}>
          {render(row)}
        </View>
      ))}
    </View>
  );
};

function ListItemView({ props }: GenerativeProps) {
  const render = useRenderNode();
  const runtime = useRuntime();
  const form = useContext(FormNameContext);
  const title = str(props.title);
  if (!title) return null;
  const action = props.action;
  return (
    <ListRow
      label={title}
      description={str(props.detail)}
      value={str(props.meta)}
      trailing={isElement(props.badge) ? render(props.badge) : undefined}
      strong
      disabled={runtime.disabled}
      onPress={
        action === undefined
          ? undefined
          : () => runtime.trigger(title, form, action)
      }
    />
  );
}
const ListView: Renderer = ({ props }) => {
  const render = useRenderNode();
  const rows = elements(props.items, "ListItem");
  return rows.length ? <Group>{render(rows)}</Group> : null;
};

type Sort = { column: number; descending: boolean };
function TableView({ props }: GenerativeProps) {
  const { language } = useRuntime();
  const tr = translate(language);
  const [sort, setSort] = useState<Sort | null>(null);
  const columns = list(props.columns).map((column) => str(column) ?? "");
  const rows = list(props.rows).filter(Array.isArray) as unknown[][];
  if (!columns.length) return null;
  const numeric = columns.map(
    (_, column) =>
      rows.some((row) => typeof row[column] === "number") &&
      rows.every(
        (row) => row[column] == null || typeof row[column] === "number",
      ),
  );
  const widths = columns.map((column, index) => {
    const longest = Math.max(
      column.length,
      ...rows.map((row) => shown(row[index], language).length),
    );
    return Math.min(220, Math.max(72, longest * 8 + 24));
  });
  const ordered = sort
    ? rows
        .map((row, index) => ({ row, index }))
        .sort((a, b) => {
          const left = a.row[sort.column];
          const right = b.row[sort.column];
          // Empty cells stay last either way; ties keep the model's order.
          if (left == null || right == null)
            return left == null ? (right == null ? a.index - b.index : 1) : -1;
          const order =
            typeof left === "number" && typeof right === "number"
              ? left - right
              : String(left).localeCompare(String(right), language, {
                  numeric: true,
                });
          return (sort.descending ? -order : order) || a.index - b.index;
        })
        .map(({ row }) => row)
    : rows;
  const align = (column: number) =>
    numeric[column] ? styles.numeric : undefined;
  return (
    <ScrollView
      horizontal
      contentContainerStyle={styles.tableScroll}
      style={styles.table}
    >
      <View style={styles.tableBody}>
        <View style={[styles.tableRow, styles.tableHeader]}>
          {columns.map((column, index) => {
            const active = sort?.column === index;
            const cellStyle = [
              styles.tableCell,
              { width: widths[index] },
              index === columns.length - 1 && styles.lastCell,
            ];
            const heading = (
              <Text role="label" style={[styles.shrink, align(index)]}>
                {column}
              </Text>
            );
            if (props.sortable !== true)
              return (
                <View key={index} style={cellStyle}>
                  {heading}
                </View>
              );
            return (
              <Pressable
                key={index}
                accessibilityRole="button"
                accessibilityLabel={tr("generativeSortBy").replace(
                  "{column}",
                  column,
                )}
                accessibilityState={{ selected: active }}
                onPress={() =>
                  setSort({
                    column: index,
                    descending: active ? !sort.descending : false,
                  })
                }
                style={({ pressed }) => [
                  cellStyle,
                  styles.sortCell,
                  numeric[index] && styles.sortNumeric,
                  pressed && { backgroundColor: t.color.pressed },
                ]}
              >
                {heading}
                {active ? (
                  <View
                    style={
                      sort.descending
                        ? { transform: [{ rotate: "180deg" }] }
                        : undefined
                    }
                  >
                    <Icon
                      name="arrow"
                      size={14}
                      color={t.color.text.secondary}
                    />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
        {ordered.map((row, rowIndex) => (
          <View key={rowIndex} style={[styles.tableRow, styles.separated]}>
            {columns.map((_, index) => (
              <View
                key={index}
                style={[
                  styles.tableCell,
                  { width: widths[index] },
                  index === columns.length - 1 && styles.lastCell,
                ]}
              >
                <Text
                  selectable
                  style={[
                    styles.shrink,
                    align(index),
                    numeric[index] && styles.tabular,
                  ]}
                >
                  {shown(row[index], language)}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function ProgressView({ props }: GenerativeProps) {
  const { language } = useRuntime();
  const label = str(props.label);
  if (!label) return null;
  const value = num(props.value) ?? 0;
  const max = (num(props.max) ?? 0) > 0 ? num(props.max)! : 100;
  const ratio = Math.min(1, Math.max(0, value / max));
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max, now: value }}
      style={styles.progress}
    >
      <Row style={styles.progressLabels}>
        <Text role="caption" style={styles.content}>
          {label}
        </Text>
        <Text role="caption" tone="secondary" style={styles.tabular}>
          {translate(language)("generativeProgress")
            .replace("{value}", formatNumber(value, language))
            .replace("{max}", formatNumber(max, language))}
        </Text>
      </Row>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${ratio * 100}%` }]} />
      </View>
    </View>
  );
}

function TimelineRow({
  props,
  last = true,
}: GenerativeProps & { last?: boolean }) {
  const title = str(props.title);
  if (!title) return null;
  const time = str(props.time);
  const detail = str(props.detail);
  const tone = toneOf(props.tone);
  return (
    <View style={styles.timelineRow}>
      <View style={styles.rail}>
        <View
          style={[
            styles.dot,
            {
              backgroundColor: tone ? toneColor[tone] : t.color.action.primary,
            },
          ]}
        />
        {last ? null : <View style={styles.railLine} />}
      </View>
      <View style={[styles.content, !last && styles.timelineGap]}>
        {time ? (
          <Text role="meta" tone="secondary" selectable style={styles.tabular}>
            {time}
          </Text>
        ) : null}
        <Text role="label" selectable>
          {title}
        </Text>
        {detail ? (
          <Text role="caption" tone="secondary" selectable>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
const TimelineView: Renderer = ({ props }) => {
  const rows = elements(props.items, "TimelineItem");
  return rows.length ? (
    <View>
      {rows.map((row, index) => (
        <TimelineRow
          key={index}
          props={row.props}
          last={index === rows.length - 1}
        />
      ))}
    </View>
  ) : null;
};

/** Field errors of the enclosing form; set when its follow-up is refused. */
const FormErrorsContext = createContext<{
  errors: Record<string, FieldError>;
  setErrors: (errors: Record<string, FieldError>) => void;
} | null>(null);
const followsUp = (action: unknown) =>
  action &&
  typeof action === "object" &&
  Array.isArray((action as { steps?: unknown }).steps)
    ? (action as { steps: { type: string }[] }).steps.some(
        (step) => step.type === "continue_conversation",
      )
    : !(action as { type?: unknown } | undefined)?.type ||
      (action as { type?: unknown }).type === "continue_conversation";

function ButtonView({ props }: GenerativeProps) {
  const runtime = useRuntime();
  const form = useContext(FormNameContext);
  const formErrors = useContext(FormErrorsContext);
  const label = str(props.label);
  if (!label) return null;
  const variant: ButtonVariant =
    props.variant === "primary" ? "primary" : "secondary";
  return (
    <Button
      label={label}
      variant={variant}
      disabled={runtime.disabled}
      style={styles.button}
      onPress={() => {
        if (runtime.disabled || runtime.streaming) return;
        // A form's answers go into the follow-up only once they are complete.
        if (form !== undefined && formErrors && followsUp(props.action)) {
          const errors = runtime.invalid(form);
          formErrors.setErrors(errors);
          if (Object.keys(errors).length) return;
        }
        runtime.trigger(label, form, props.action);
      }}
    />
  );
}
const ButtonsView: Renderer = ({ props }) => {
  const render = useRenderNode();
  const buttons = elements(props.buttons, "Button");
  const primary = buttons.findIndex(
    (button) => button.props.variant === "primary",
  );
  // At most one primary: the first one asked for.
  return (
    <View style={styles.buttons}>
      {render(
        buttons.map((button, index) => ({
          ...button,
          props: {
            ...button.props,
            variant: index === primary ? "primary" : "secondary",
          },
        })),
      )}
    </View>
  );
};

function FormView({ props }: GenerativeProps) {
  const render = useRenderNode();
  const [errors, setErrors] = useState<Record<string, FieldError>>({});
  const name = str(props.name) ?? "";
  // A lone submit button is the form's primary action.
  const buttons =
    isElement(props.buttons, "Button") && !props.buttons.props.variant
      ? {
          ...props.buttons,
          props: { ...props.buttons.props, variant: "primary" },
        }
      : props.buttons;
  return (
    <FormNameContext.Provider value={name}>
      <FormErrorsContext.Provider value={{ errors, setErrors }}>
        <View style={styles.form}>
          {render(props.fields)}
          {render(buttons)}
        </View>
      </FormErrorsContext.Provider>
    </FormNameContext.Provider>
  );
}

/** A form field's value, its error and the change that clears it. */
function useFormField(props: Record<string, unknown>, kind: FieldKind) {
  const runtime = useRuntime();
  const formErrors = useContext(FormErrorsContext);
  const name = str(props.name) ?? "";
  const label = str(props.label) ?? "";
  const field = useGenerativeField({
    name,
    label,
    kind,
    value: props.value,
    required: props.required === true,
  });
  const error = formErrors?.errors[name];
  return {
    name,
    label,
    value: field.value,
    disabled: runtime.disabled,
    language: runtime.language,
    error,
    change: (value: unknown) => {
      field.setValue(value);
      if (error && formErrors) {
        const { [name]: _cleared, ...rest } = formErrors.errors;
        formErrors.setErrors(rest);
      }
    },
  };
}
function FieldMessage({
  error,
  language,
}: {
  error?: FieldError;
  language: Parameters<typeof translate>[0];
}) {
  if (!error) return null;
  return (
    <Text role="caption" accessibilityRole="alert" style={styles.error}>
      {translate(language)(
        error === "date" ? "generativeDate" : "generativeRequired",
      )}
    </Text>
  );
}

function TextFieldView({ props }: GenerativeProps) {
  const field = useFormField(props, "text");
  if (!field.name || !field.label) return null;
  return (
    <View style={styles.field}>
      <Field
        label={field.label + (props.required === true ? " *" : "")}
        accessibilityLabel={field.label}
        placeholder={str(props.placeholder)}
        value={typeof field.value === "string" ? field.value : ""}
        editable={!field.disabled}
        accessibilityState={{ disabled: field.disabled }}
        aria-required={props.required === true}
        maxLength={2000}
        onChangeText={field.change}
      />
      <FieldMessage error={field.error} language={field.language} />
    </View>
  );
}
function DateFieldView({ props }: GenerativeProps) {
  const field = useFormField(props, "date");
  if (!field.name || !field.label) return null;
  return (
    <View style={styles.field}>
      <Field
        label={field.label + (props.required === true ? " *" : "")}
        accessibilityLabel={field.label}
        placeholder={translate(field.language)("generativeDateFormat")}
        value={typeof field.value === "string" ? field.value : ""}
        editable={!field.disabled}
        accessibilityState={{ disabled: field.disabled }}
        aria-required={props.required === true}
        keyboardType="numbers-and-punctuation"
        maxLength={10}
        onChangeText={field.change}
      />
      <FieldMessage error={field.error} language={field.language} />
    </View>
  );
}
function SelectView({ props }: GenerativeProps) {
  const field = useFormField(props, "select");
  const options = list(props.options).flatMap((option) => {
    const label = str(option);
    return label ? [label] : [];
  });
  if (!field.name || !field.label || !options.length) return null;
  // A few short options sit side by side; longer lists read top to bottom.
  const compact = options.length <= 4 && options.every((o) => o.length <= 18);
  return (
    <View style={styles.field}>
      <Text role="section" tone="secondary">
        {field.label + (props.required === true ? " *" : "")}
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={field.label}
        style={compact ? styles.choices : styles.choiceList}
      >
        {options.map((option) => {
          const checked = field.value === option;
          return (
            <MotionPressable
              key={option}
              accessibilityRole="radio"
              accessibilityLabel={option}
              accessibilityState={{ checked, disabled: field.disabled }}
              aria-checked={checked}
              disabled={field.disabled}
              hitSlop={compact ? 4 : undefined}
              onPress={() => field.change(option)}
              style={[
                compact ? styles.pill : styles.choice,
                checked && styles.choiceSelected,
                field.disabled && styles.inactive,
              ]}
            >
              {checked ? (
                <Icon name="check" size={16} color={t.color.action.primary} />
              ) : null}
              <Text
                role={compact ? "label" : "body"}
                style={[
                  styles.shrink,
                  checked && { color: t.color.action.primary },
                ]}
              >
                {option}
              </Text>
            </MotionPressable>
          );
        })}
      </View>
      <FieldMessage error={field.error} language={field.language} />
    </View>
  );
}
function CheckboxView({ props }: GenerativeProps) {
  const field = useFormField(props, "checkbox");
  if (!field.name || !field.label) return null;
  return (
    <Row style={styles.checkbox}>
      <Text role="label" style={styles.content}>
        {field.label}
      </Text>
      <Toggle
        value={field.value === true}
        onChange={field.change}
        accessibilityLabel={field.label}
        disabled={field.disabled}
      />
    </Row>
  );
}

/** Drawn by its chart; alone it shows nothing. */
const SeriesView: Renderer = () => null;

/** Every component of the shared library, by its name in programs. */
export const GENERATIVE_UI_VIEWS: Record<GenerativeUiComponentName, Renderer> =
  {
    Stack: Children,
    Row: RowView,
    Grid: GridView,
    Section: SectionView,
    Tabs: TabsView,
    Tab: Children,
    Accordion: AccordionView,
    AccordionItem: AccordionItemView,
    Separator: SeparatorView,
    Heading: HeadingView,
    Text: TextView,
    Markdown: MarkdownView,
    Callout: CalloutView,
    Badge: BadgeView,
    Link: LinkView,
    Metric: MetricView,
    Details: DetailsView,
    Detail: DetailView,
    List: ListView,
    ListItem: ListItemView,
    Table: TableView,
    Progress: ProgressView,
    Timeline: TimelineView,
    TimelineItem: TimelineRow,
    BarChart: BarChartView,
    LineChart: LineChartView,
    PieChart: PieChartView,
    Series: SeriesView,
    Button: ButtonView,
    Buttons: ButtonsView,
    Form: FormView,
    TextField: TextFieldView,
    Select: SelectView,
    Checkbox: CheckboxView,
    DateField: DateFieldView,
  };

const styles = StyleSheet.create({
  stack: { minWidth: 0, gap: t.spacing.md },
  content: { flex: 1, minWidth: 0, gap: t.spacing.xxs },
  shrink: { minWidth: 0, flexShrink: 1 },
  tabular: { fontVariant: ["tabular-nums"] },
  row: {
    minWidth: 0,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: t.spacing.md,
  },
  rowItem: { flexGrow: 1, flexBasis: 140, minWidth: 0 },
  gridRow: { flexDirection: "row", gap: t.spacing.md, minWidth: 0 },
  gridCell: { flex: 1, minWidth: 0 },
  section: { minWidth: 0, gap: t.spacing.sm, paddingTop: t.spacing.xs },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: t.color.border,
  },
  callout: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: t.spacing.md,
    borderRadius: t.radius.control,
  },
  calloutIcon: { marginTop: 1 },
  link: {
    minHeight: t.control.minHeight,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  linkText: { color: t.color.action.primary, fontWeight: "500" },
  metric: {
    flexGrow: 1,
    minWidth: 0,
    gap: t.spacing.xxs,
    padding: t.spacing.md,
    borderRadius: t.radius.control,
    backgroundColor: t.color.fill,
  },
  metricValue: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "baseline",
    gap: t.spacing.xs,
  },
  detail: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: t.spacing.md,
    paddingVertical: 10,
    minWidth: 0,
  },
  detailLabel: { width: 96, flexShrink: 0, paddingTop: 2 },
  detailValue: { flex: 1, minWidth: 0, fontWeight: "500" },
  linkRow: { minHeight: t.control.minHeight, justifyContent: "center" },
  separated: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.color.border,
  },
  table: { flexGrow: 0 },
  tableScroll: { minWidth: "100%" },
  tableBody: { flexGrow: 1 },
  tableRow: { flexDirection: "row" },
  tableHeader: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: t.color.border,
  },
  tableCell: {
    paddingVertical: 10,
    paddingHorizontal: t.spacing.sm,
    justifyContent: "center",
  },
  lastCell: { flexGrow: 1 },
  sortCell: {
    minHeight: t.control.minHeight,
    flexDirection: "row",
    alignItems: "center",
    gap: t.spacing.xs,
  },
  sortNumeric: { justifyContent: "flex-end" },
  numeric: { textAlign: "right" },
  progress: { gap: t.spacing.sm },
  progressLabels: { justifyContent: "space-between" },
  track: {
    height: 6,
    backgroundColor: t.color.border,
    borderRadius: t.radius.pill,
    overflow: "hidden",
  },
  fill: { height: 6, backgroundColor: t.color.action.primary },
  timelineRow: { flexDirection: "row", gap: t.spacing.md, minWidth: 0 },
  rail: { width: 10, alignItems: "center", paddingTop: 5 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  railLine: {
    flex: 1,
    width: StyleSheet.hairlineWidth * 2,
    marginTop: t.spacing.xs,
    backgroundColor: t.color.border,
  },
  timelineGap: { paddingBottom: t.spacing.md },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
  button: { alignSelf: "flex-start" },
  form: { minWidth: 0, gap: t.spacing.lg },
  field: { gap: 6 },
  error: { color: t.color.status.error },
  choices: { flexDirection: "row", flexWrap: "wrap", gap: t.spacing.sm },
  choiceList: { gap: t.spacing.sm },
  pill: {
    minHeight: 40,
    paddingHorizontal: t.spacing.lg,
    borderRadius: t.radius.pill,
    borderWidth: 1,
    borderColor: t.color.border,
    backgroundColor: t.color.surfaceRaised,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  choice: {
    minHeight: t.control.minHeight,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    borderWidth: 1,
    borderColor: t.color.border,
    borderRadius: t.radius.control,
    backgroundColor: t.color.surfaceRaised,
    flexDirection: "row",
    alignItems: "center",
    gap: t.spacing.sm,
  },
  choiceSelected: {
    borderColor: t.color.action.primary,
    backgroundColor: t.color.accent.softBlue,
  },
  inactive: { opacity: 0.5 },
  checkbox: { minHeight: t.control.minHeight, justifyContent: "space-between" },
});
