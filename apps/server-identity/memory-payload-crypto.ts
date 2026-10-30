import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { z } from "zod";
import {
  MemoryContentSchema,
  MemorySourceSchema,
  ObservationStatementSchema,
} from "../../packages/protocol/memory";

export type MemoryPayloadBinding = {
  id: string;
  organizationId: string;
  workspaceId: string;
  userId: string;
  scope: "private" | "workspace";
  threadId: string;
  resourceId: string;
  createdAt: string;
  expiresAt: string;
};
export const MemoryPayloadSchema = z
  .strictObject({
    content: MemoryContentSchema,
    source: MemorySourceSchema,
    trust: z.enum(["user_assertion", "verified_result", "model_inference"]),
  })
  .superRefine((payload, ctx) => {
    if (
      payload.source.type === "observed" &&
      (payload.trust !== "model_inference" ||
        !ObservationStatementSchema.safeParse(payload.content).success)
    )
      ctx.addIssue({ code: "custom", message: "memory_observation_invalid" });
  });
export type MemoryPayload = z.infer<typeof MemoryPayloadSchema>;
const MAX_BYTES = 32768;
export class MemoryPayloadCrypto {
  private key: Buffer;
  constructor(secret: string) {
    this.key = Buffer.from(
      hkdfSync("sha256", secret, "agent-server", "saved-memory-payload/v1", 32),
    );
  }
  private aad(binding: MemoryPayloadBinding) {
    return Buffer.from(
      JSON.stringify([
        "niaro-saved-memory/1",
        binding.id,
        binding.organizationId,
        binding.workspaceId,
        binding.userId,
        binding.scope,
        binding.threadId,
        binding.resourceId,
        binding.createdAt,
        binding.expiresAt,
      ]),
    );
  }
  seal(payload: MemoryPayload, binding: MemoryPayloadBinding) {
    if (payload.source.type === "observed" && binding.scope !== "private")
      throw Error("memory_observation_scope");
    const body = Buffer.from(
      JSON.stringify(MemoryPayloadSchema.parse(payload)),
    );
    if (body.length > MAX_BYTES) throw Error("memory_payload_limit");
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(this.aad(binding));
    const bytes = Buffer.concat([cipher.update(body), cipher.final()]);
    return [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      bytes.toString("base64url"),
    ].join(".");
  }
  open(ciphertext: string, binding: MemoryPayloadBinding): MemoryPayload {
    if (Buffer.byteLength(ciphertext) > MAX_BYTES * 2)
      throw Error("memory_payload_limit");
    const [version, rawIv, rawTag, rawBody, extra] = ciphertext.split(".");
    if (
      version !== "v1" ||
      !rawIv ||
      !rawTag ||
      !rawBody ||
      extra !== undefined
    )
      throw Error("memory_payload_invalid");
    const iv = Buffer.from(rawIv, "base64url"),
      tag = Buffer.from(rawTag, "base64url");
    if (iv.length !== 12 || tag.length !== 16)
      throw Error("memory_payload_invalid");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv, {
      authTagLength: 16,
    });
    decipher.setAAD(this.aad(binding));
    decipher.setAuthTag(tag);
    const body = Buffer.concat([
      decipher.update(Buffer.from(rawBody, "base64url")),
      decipher.final(),
    ]);
    if (body.length > MAX_BYTES) throw Error("memory_payload_limit");
    const payload = MemoryPayloadSchema.parse(
      JSON.parse(body.toString("utf8")),
    );
    if (payload.source.type === "observed" && binding.scope !== "private")
      throw Error("memory_observation_scope");
    return payload;
  }
}
export const memoryCipherDigest = (ciphertext: string) =>
  createHash("sha256").update(ciphertext).digest("hex");
