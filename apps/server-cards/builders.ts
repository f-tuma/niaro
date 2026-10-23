import {
  PassiveCardDocumentSchema,
  type CardDocument,
  type CardNode,
} from "../../packages/protocol/card-document";

type NodeInput<T = CardNode> = T extends CardNode ? Omit<T, "id"> : never;
type CardHeader = Pick<
  CardDocument,
  "id" | "revision" | "title" | "subtitle" | "icon"
>;

/**
 * Typed authoring of the server's own passive cards (service results, work
 * summaries). Build validates the complete graph; cards carry no actions.
 */
export class CardBuilder {
  private nodes: CardNode[] = [];
  private roots: string[] = [];

  constructor(private readonly header: CardHeader) {}

  /** Child nodes use root:false and are attached to a container by their ID. */
  add(input: NodeInput, { root = true }: { root?: boolean } = {}): string {
    const id = `node-${this.nodes.length + 1}`;
    this.nodes.push({ ...input, id } as CardNode);
    if (root) this.roots.push(id);
    return id;
  }

  build(): CardDocument {
    return PassiveCardDocumentSchema.parse({
      ...this.header,
      nodes: this.nodes,
      root: this.roots,
      actions: [],
    });
  }
}
