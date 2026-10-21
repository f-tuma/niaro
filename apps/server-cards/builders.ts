import {
  type CardAction,
  type CardDocument,
  type CardNode,
} from "../../packages/protocol/card-document";
import { composeCard } from "./composer";

type NodeInput<T = CardNode> = T extends CardNode ? Omit<T, "id"> : never;
type CardHeader = Pick<
  CardDocument,
  "id" | "revision" | "title" | "subtitle" | "icon"
>;

/** Typed authoring convenience; build still validates the complete graph. */
export class CardBuilder {
  private nodes: CardNode[] = [];
  private roots: string[] = [];
  private actions: CardAction[] = [];

  constructor(private readonly header: CardHeader) {}

  /** Child nodes use root:false and are attached to a container by their ID. */
  add(input: NodeInput, { root = true }: { root?: boolean } = {}): string {
    const id = `node-${this.nodes.length + 1}`;
    this.nodes.push({ ...input, id } as CardNode);
    if (root) this.roots.push(id);
    return id;
  }

  action(action: CardAction, { root = true }: { root?: boolean } = {}): string {
    this.actions.push(action);
    return this.add({ type: "button", actionId: action.id }, { root });
  }

  build(): CardDocument {
    const { id, revision, ...content } = this.header;
    return composeCard(
      {
        ...content,
        nodes: this.nodes,
        root: this.roots,
        actions: this.actions,
      },
      { id, revision },
    );
  }
}
