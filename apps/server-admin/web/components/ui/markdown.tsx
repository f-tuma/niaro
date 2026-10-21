import { useMemo, type ReactNode } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type { RootContent } from "mdast";

/** React escapes all text. HTML is literal and images never fetch remote content. */
export function Markdown({ text }: { text: string }) {
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
        return (
          <pre key={key}>
            <code>{node.value}</code>
          </pre>
        );
      case "heading":
        return (
          <p key={key} className="font-semibold">
            {children}
          </p>
        );
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
      case "table":
        return (
          <div key={key} className="overflow-x-auto">
            <table>
              <tbody>{children}</tbody>
            </table>
          </div>
        );
      case "tableRow":
        return <tr key={key}>{children}</tr>;
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
      className="min-w-0 space-y-3 break-words text-sm [&_a]:text-primary [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_code]:font-mono [&_code]:text-xs [&_li]:mb-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_td]:border [&_td]:p-2 [&_ul]:list-disc [&_ul]:pl-5"
    >
      {tree.children.map((node, i) => render(node, i))}
    </div>
  );
}
