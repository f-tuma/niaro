import { useState, type ReactNode } from "react";
import { Image } from "lucide-react";
import { Button } from "@admin/components/ui/button";
import type { HubDocNode } from "../../../../../packages/protocol/hub";
import type { WidgetLanguage } from "./types";

/**
 * A message body as the server's sanitized tree, rendered as React elements
 * (never HTML): links open in a new tab without the referrer, images load
 * only once the person asks, and every node is one of the allowed tags.
 */
const text = {
  cs: { showImages: "Zobrazit obrázky", image: "Obrázek" },
  en: { showImages: "Show images", image: "Image" },
};

const hasImages = (nodes: HubDocNode[]): boolean =>
  nodes.some(
    (node) =>
      node.t === "el" &&
      (node.tag === "img" || (!!node.children && hasImages(node.children))),
  );

function Node({
  node,
  images,
  language,
}: {
  node: HubDocNode;
  images: boolean;
  language: WidgetLanguage;
}) {
  if (node.t === "text") return node.v;
  const children = node.children?.map((child, index) => (
    <Node key={index} node={child} images={images} language={language} />
  ));
  switch (node.tag) {
    case "p":
      return <p className="my-2">{children}</p>;
    case "br":
      return <br />;
    case "hr":
      return <hr className="my-3 border-t" />;
    case "a":
      return (
        <a
          href={node.href}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2 break-words"
        >
          {children}
        </a>
      );
    case "strong":
      return <strong className="font-semibold">{children}</strong>;
    case "em":
      return <em>{children}</em>;
    case "u":
      return <u>{children}</u>;
    case "s":
      return <s>{children}</s>;
    case "ul":
      return <ul className="my-2 list-disc pl-5">{children}</ul>;
    case "ol":
      return <ol className="my-2 list-decimal pl-5">{children}</ol>;
    case "li":
      return <li>{children}</li>;
    case "blockquote":
      return (
        <blockquote className="my-2 border-l-2 pl-3 text-muted-foreground">
          {children}
        </blockquote>
      );
    case "h1":
    case "h2":
    case "h3":
      return <p className="my-2 text-base font-medium">{children}</p>;
    case "h4":
    case "h5":
    case "h6":
      return <p className="my-2 font-medium">{children}</p>;
    case "pre":
      return (
        <pre className="my-2 overflow-x-auto rounded-md bg-muted p-2 text-xs whitespace-pre">
          {children}
        </pre>
      );
    case "code":
      return (
        <code className="rounded-sm bg-muted px-1 text-xs">{children}</code>
      );
    case "table":
      return (
        <div className="my-2 overflow-x-auto">
          <table className="text-sm">{children}</table>
        </div>
      );
    case "thead":
      return <thead>{children}</thead>;
    case "tbody":
      return <tbody>{children}</tbody>;
    case "tr":
      return <tr>{children}</tr>;
    case "td":
      return (
        <td
          className="border-b px-2 py-1 align-top"
          colSpan={node.colspan}
          rowSpan={node.rowspan}
        >
          {children}
        </td>
      );
    case "th":
      return (
        <th
          className="border-b px-2 py-1 text-left align-top font-medium"
          colSpan={node.colspan}
          rowSpan={node.rowspan}
        >
          {children}
        </th>
      );
    case "img":
      return images ? (
        <img
          src={node.src}
          alt={node.alt ?? ""}
          loading="lazy"
          referrerPolicy="no-referrer"
          className="my-2 h-auto max-w-full rounded-md"
          data-testid="email-doc-image"
        />
      ) : (
        <span
          className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground"
          data-testid="email-doc-image"
          data-loaded={false}
        >
          <Image aria-hidden="true" className="size-3" />
          {node.alt || text[language].image}
        </span>
      );
    case "div":
      return <div className="min-w-0">{children}</div>;
    case "span":
      return <span>{children}</span>;
  }
}

/** The body; the choice to show its images lives with this message only. */
export function EmailDoc({
  doc,
  language,
}: {
  doc: HubDocNode[];
  language: WidgetLanguage;
}): ReactNode {
  const [images, setImages] = useState(false);
  const pictures = hasImages(doc);
  return (
    <div className="flex min-w-0 flex-col text-sm" data-testid="email-doc">
      {pictures && !images && (
        <Button
          variant="outline"
          size="xs"
          className="mb-2 self-start"
          data-testid="email-doc-images"
          onClick={() => setImages(true)}
        >
          <Image data-icon="inline-start" aria-hidden="true" />
          {text[language].showImages}
        </Button>
      )}
      <div className="min-w-0 break-words">
        {doc.map((node, index) => (
          <Node key={index} node={node} images={images} language={language} />
        ))}
      </div>
    </div>
  );
}

const URL_IN_TEXT = /<?(https?:\/\/[^\s<>"']+)>?/g;
/**
 * Plain text with its web links clickable. A text body from Microsoft Graph
 * writes a link as "Label<https://…>": the address becomes the link, the
 * label stays as it is. Only http(s) addresses turn into links.
 */
export function LinkedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const href = match[1]!.replace(/[.,;:)]+$/, "");
    parts.push(
      <a
        key={index}
        href={href}
        target="_blank"
        rel="noreferrer"
        className="break-all text-primary underline underline-offset-2"
      >
        {href}
      </a>,
    );
    last = index + match[0].length - (match[1]!.length - href.length);
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}
