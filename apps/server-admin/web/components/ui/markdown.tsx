import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { AlignType, RootContent, TableRow } from "mdast";
import { Check, Copy } from "lucide-react";
import { cn } from "cn";
import { Button } from "@admin/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@admin/components/ui/tooltip";
import { useToast } from "@admin/components/ui/toast";

/** The labels of a code block's copy action; without them code has none. */
export type MarkdownCodeCopy = { copy: string; copied: string };

const headingTags = ["h2", "h3", "h4", "h5", "h6"] as const;
const alignClass = (align: AlignType | undefined) =>
  align === "center"
    ? "text-center"
    : align === "right"
      ? "text-right"
      : "text-left";

/**
 * React escapes all text. HTML is literal and images never fetch remote
 * content. `size="chat"` is the chat transcript's reading size (14 px with
 * a 22 px line height, apps/server-admin/DESIGN.md); everything else keeps
 * console density.
 */
export function Markdown({
  text,
  size = "default",
  codeCopy,
}: {
  text: string;
  size?: "default" | "chat";
  codeCopy?: MarkdownCodeCopy;
}) {
  const tree = useMemo(
    () =>
      fromMarkdown(text, {
        extensions: [gfm()],
        mdastExtensions: [gfmFromMarkdown()],
      }),
    [text],
  );
  const definitions = new Map(
    tree.children
      .filter((n) => n.type === "definition")
      .map((n) => [n.identifier, n.url]),
  );
  function safeUrl(url: string | undefined) {
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return ["https:", "http:", "mailto:", "tel:"].includes(parsed.protocol)
        ? parsed.href
        : null;
    } catch {
      return null;
    }
  }
  function row(node: TableRow, key: number, align: AlignType[], head: boolean) {
    return (
      <tr key={key}>
        {node.children.map((cell, i) => {
          const children = cell.children.map((child, j) =>
            render(child as RootContent, j),
          );
          return head ? (
            <th key={i} scope="col" className={alignClass(align[i])}>
              {children}
            </th>
          ) : (
            <td key={i} className={alignClass(align[i])}>
              {children}
            </td>
          );
        })}
      </tr>
    );
  }
  function render(node: RootContent, key: number): ReactNode {
    const children =
      "children" in node
        ? node.children.map((child, i) => render(child as RootContent, i))
        : null;
    switch (node.type) {
      case "text":
        return node.value;
      case "paragraph":
        return <p key={key}>{children}</p>;
      case "strong":
        return <strong key={key}>{children}</strong>;
      case "emphasis":
        return <em key={key}>{children}</em>;
      case "delete":
        return <del key={key}>{children}</del>;
      case "inlineCode":
        return <code key={key}>{node.value}</code>;
      case "code":
        return <CodeBlock key={key} value={node.value} labels={codeCopy} />;
      case "heading": {
        // The page's title is its only h1: "#" is a section of the answer.
        const Heading = headingTags[Math.min(node.depth, 5) - 1]!;
        return (
          <Heading key={key} data-depth={node.depth}>
            {children}
          </Heading>
        );
      }
      case "blockquote":
        return <blockquote key={key}>{children}</blockquote>;
      case "list":
        return node.ordered ? (
          <ol key={key} start={node.start ?? 1}>
            {children}
          </ol>
        ) : (
          <ul key={key}>{children}</ul>
        );
      case "listItem":
        return <li key={key}>{children}</li>;
      case "link":
      case "linkReference": {
        const href = safeUrl(
          node.type === "link" ? node.url : definitions.get(node.identifier),
        );
        return href ? (
          <a key={key} href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ) : (
          <span key={key}>{children}</span>
        );
      }
      case "html":
        return <span key={key}>{node.value}</span>;
      case "image":
      case "imageReference":
        return <span key={key}>{node.alt}</span>;
      case "break":
        return <br key={key} />;
      case "thematicBreak":
        return <hr key={key} />;
      case "table": {
        // The first row names the columns.
        const [head, ...body] = node.children;
        const align = node.align ?? [];
        return (
          <div key={key} className="overflow-x-auto">
            <table>
              {head && <thead>{row(head, 0, align, true)}</thead>}
              {body.length > 0 && (
                <tbody>{body.map((r, i) => row(r, i, align, false))}</tbody>
              )}
            </table>
          </div>
        );
      }
      case "tableRow":
        return row(node, key, [], false);
      case "tableCell":
        return <td key={key}>{children}</td>;
      case "definition":
        return null;
      default:
        return children;
    }
  }
  return (
    <div
      data-slot="markdown"
      data-size={size}
      className={cn(
        "min-w-0 space-y-3 break-words text-sm [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:font-mono [&_code]:text-xs [&_li]:mb-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_table]:border-collapse [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:bg-muted [&_th]:p-2 [&_th]:font-medium [&_ul]:list-disc [&_ul]:pl-5",
        // Headings: section title, then label (at chat size both read at
        // the body's 14 px, set apart by weight); 12 px more above unless first.
        "[&_:is(h2,h3,h4)]:text-md [&_:is(h2,h3,h4,h5,h6)]:font-semibold data-[size=default]:[&_:is(h5,h6)]:text-sm [&>:is(h2,h3,h4,h5,h6):not(:first-child)]:pt-3",
        "data-[size=chat]:text-md data-[size=chat]:leading-chat",
      )}
    >
      {tree.children.map((node, i) => render(node, i))}
    </div>
  );
}

/**
 * A code block; with labels, a copy action in its top right corner that
 * also raises the app's "Copied" toast.
 */
function CodeBlock({
  value,
  labels,
}: {
  value: string;
  labels?: MarkdownCodeCopy;
}) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!labels)
    return (
      <pre>
        <code>{value}</code>
      </pre>
    );
  const label = copied ? labels.copied : labels.copy;
  return (
    <div data-slot="markdown-code" className="relative">
      <pre className="pr-10">
        <code>{value}</code>
      </pre>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="absolute top-2 right-2"
            aria-label={label}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(value)
                .then(() => {
                  setCopied(true);
                  toast?.copied();
                })
                .catch(() => {});
            }}
          >
            {copied ? (
              <Check aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </div>
  );
}
