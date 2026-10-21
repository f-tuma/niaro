import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  HostedPackageInfo,
  HostedServerSchema,
  type HostedDefinitionInput,
  type HostedServer,
  type HostedTemplateId,
} from "../../packages/protocol/hosted";
import {
  DockerSandbox,
  ProcessSandbox,
  type Command,
  type Sandbox,
} from "./sandbox";
import { HOSTED_TEMPLATES } from "./templates";

export class HostedError extends Error {
  constructor(
    readonly code: string,
    readonly status = 400,
  ) {
    super(code);
  }
}
type EnvVar = { name: string; value?: string; secret: boolean };
type Definition =
  | { source: "template"; template: HostedTemplateId }
  | {
      source: "npm";
      package: string;
      version: string;
      bin?: string;
      args: string[];
      env: EnvVar[];
    }
  | {
      source: "image";
      image: string;
      port: number;
      args: string[];
      env: EnvVar[];
    };
type Row = {
  id: string;
  organizationId: string;
  port: number;
  revision: number;
  enabled: boolean;
  name: string;
  /** Secret values are never stored here; they are sealed in the secret column. */
  definition: Definition;
};
type Runtime = {
  status: HostedServer["status"];
  child?: ChildProcess;
  log: string[];
  crashes: number[];
  error?: string;
  timer?: ReturnType<typeof setTimeout>;
  /** Bumped by every start/stop so a late exit or readiness check of an old process is ignored. */
  generation: number;
};
export type Launcher = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;
/** auto: Docker when it answers, otherwise Node processes with the permission model. */
export type HostedRuntime = "auto" | "docker" | "process";
export type HostedOptions = {
  runtime?: HostedRuntime;
  /** Test seams: the sandboxes, the process launcher and the npm command for registry lookups. */
  sandbox?: Sandbox;
  processSandbox?: Sandbox;
  launch?: Launcher;
  npm?: string;
  ports?: { first: number; last: number };
  maxServers?: number;
  readyTimeoutMs?: number;
  /** Operator decision from the server profile; the console cannot change it. */
  allowCustom?: boolean;
};
const LOG_LINES = 200;
const MAX_CRASHES = 5;
const CRASH_WINDOW = 10 * 60 * 1000;
// Tokens never belong in a console log, even if a hosted server prints one.
const secrets = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,
  /(["']?(?:access|refresh|id)_token["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi,
];
export function maskLog(line: string, known: readonly string[] = []) {
  let text = line;
  for (const value of known)
    if (value.length >= 6) text = text.split(value).join("[redacted]");
  return secrets
    .reduce(
      (current, pattern) =>
        current.replace(pattern, (match, prefix?: string) =>
          typeof prefix === "string" && match.startsWith(prefix)
            ? `${prefix}[redacted]`
            : "[redacted]",
        ),
      text,
    )
    .slice(0, 500);
}
const digestFile = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
/** Whether a symbolic link under the directory points outside it. */
export function escapes(dir: string): boolean {
  const root = realpathSync(dir);
  const walk = (current: string): boolean =>
    readdirSync(current, { withFileTypes: true }).some((entry) => {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(path);
        } catch {
          // Dangling: its target could still appear later.
          target = resolve(current, readlinkSync(path));
        }
        return !target.startsWith(root + "/");
      }
      return entry.isDirectory() && walk(path);
    });
  return walk(root);
}

/** Runs MCP servers in a Docker sandbox, supervised: one directory, one container and one
 * loopback port per server. Only templates in code, or custom npm packages and pinned images
 * when the operator allowed them, can run; the console never supplies a command or a shell.
 * Without Docker, templates (never custom servers) run as Node processes instead. */
export class HostedServers {
  private runtimes = new Map<string, Runtime>();
  private installs = new Map<string, Promise<void>>();
  private closing = false;
  private networkReady?: Promise<void>;
  private readonly key: Buffer;
  private readonly docker: Sandbox;
  private readonly processSandbox: Sandbox;
  private readonly mode: HostedRuntime;
  private selected?: Promise<Sandbox | undefined>;
  private chosen?: Sandbox;
  private readonly launch: Launcher;
  private readonly npm: string;
  private readonly ports: { first: number; last: number };
  private readonly maxServers: number;
  private readonly readyTimeoutMs: number;
  readonly allowCustom: boolean;
  constructor(
    private readonly db: DatabaseSync,
    private readonly root: string,
    /** Shared with the integration transport: loopback origins become reachable only while hosted. */
    private readonly trusted: string[],
    secret: string,
    options: HostedOptions = {},
  ) {
    this.key = Buffer.from(
      hkdfSync("sha256", secret, "agent-server", "hosted-servers/v1", 32),
    );
    this.npm = options.npm ?? "npm";
    this.docker = options.sandbox ?? new DockerSandbox();
    this.processSandbox =
      options.processSandbox ?? new ProcessSandbox(process.execPath, this.npm);
    this.mode = options.runtime ?? "auto";
    this.launch = options.launch ?? spawn;
    this.ports = options.ports ?? { first: 39100, last: 39199 };
    this.maxServers = options.maxServers ?? 8;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 60000;
    this.allowCustom = options.allowCustom ?? false;
    db.exec(`CREATE TABLE IF NOT EXISTS agent_hosted_server (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, template TEXT NOT NULL,
      port INTEGER NOT NULL UNIQUE, data TEXT NOT NULL, secret TEXT,
      UNIQUE(organization_id, template)
    ) STRICT;`);
    const columns = db
      .prepare("PRAGMA table_info(agent_hosted_server)")
      .all()
      .map((c) => String(c.name));
    if (!columns.includes("secret"))
      db.exec("ALTER TABLE agent_hosted_server ADD COLUMN secret TEXT");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    for (const row of this.rows()) this.trust(row);
  }
  templates() {
    return Object.values(HOSTED_TEMPLATES).map(
      ({ id, name, version, package: pkg }) => ({
        id,
        name,
        version,
        package: pkg,
      }),
    );
  }
  /** Chosen once; without a usable runtime every hosted server shows as failed. */
  private sandbox() {
    this.selected ??= (async () => {
      const usable = async (sandbox: Sandbox) =>
        (await this.exec(sandbox.probe(), 10000)).code === 0;
      for (const sandbox of [this.docker, this.processSandbox])
        if (
          (this.mode === "auto" || this.mode === sandbox.kind) &&
          (await usable(sandbox))
        )
          return (this.chosen = sandbox);
      return undefined;
    })();
    return this.selected;
  }
  async sandboxKind() {
    return (await this.sandbox())?.kind;
  }
  private seal(value: Record<string, string>, id: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return [iv, cipher.getAuthTag(), bytes]
      .map((b) => b.toString("base64url"))
      .join(".");
  }
  private unseal(value: unknown, id: string): Record<string, string> {
    if (!value) return {};
    const [iv, tag, bytes] = String(value)
      .split(".")
      .map((p) => Buffer.from(p, "base64url"));
    const cipher = createDecipheriv("aes-256-gcm", this.key, iv!);
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(tag!);
    return JSON.parse(
      Buffer.concat([cipher.update(bytes!), cipher.final()]).toString("utf8"),
    ) as Record<string, string>;
  }
  private rows(organizationId?: string): Row[] {
    return (
      organizationId
        ? this.db
            .prepare(
              "SELECT * FROM agent_hosted_server WHERE organization_id=? ORDER BY id",
            )
            .all(organizationId)
        : this.db.prepare("SELECT * FROM agent_hosted_server").all()
    ).map((row) => {
      const data = JSON.parse(String(row.data)) as Partial<Row> & {
        revision: number;
        enabled: boolean;
      };
      const template = String(row.template);
      return {
        id: String(row.id),
        organizationId: String(row.organization_id),
        port: Number(row.port),
        revision: data.revision,
        enabled: data.enabled,
        definition: data.definition ?? {
          source: "template",
          template: template as HostedTemplateId,
        },
        name:
          data.name ??
          HOSTED_TEMPLATES[template as HostedTemplateId]?.name ??
          template,
      };
    });
  }
  private row(organizationId: string, id: string) {
    const row = this.rows(organizationId).find((r) => r.id === id);
    if (!row) throw new HostedError("hosted_not_found", 404);
    return row;
  }
  private write(row: Row) {
    this.db.prepare("UPDATE agent_hosted_server SET data=? WHERE id=?").run(
      JSON.stringify({
        revision: row.revision,
        enabled: row.enabled,
        name: row.name,
        definition: row.definition,
      }),
      row.id,
    );
  }
  private secretsOf(row: Row) {
    const stored = this.db
      .prepare("SELECT secret FROM agent_hosted_server WHERE id=?")
      .get(row.id);
    return this.unseal(stored?.secret, row.id);
  }
  private origin(row: Row) {
    return `http://127.0.0.1:${row.port}`;
  }
  private trust(row: Row) {
    const origin = this.origin(row);
    if (!this.trusted.includes(origin)) this.trusted.push(origin);
  }
  private untrust(row: Row) {
    const i = this.trusted.indexOf(this.origin(row));
    if (i >= 0) this.trusted.splice(i, 1);
  }
  private runtime(id: string) {
    let value = this.runtimes.get(id);
    if (!value) {
      value = { status: "stopped", log: [], crashes: [], generation: 0 };
      this.runtimes.set(id, value);
    }
    return value;
  }
  private append(runtime: Runtime, chunk: string, known: string[] = []) {
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue;
      runtime.log.push(maskLog(line, known));
      if (runtime.log.length > LOG_LINES) runtime.log.shift();
    }
  }
  private artifact(definition: Definition) {
    if (definition.source === "template") {
      const t = HOSTED_TEMPLATES[definition.template];
      return {
        artifact: t.package,
        version: t.version,
        args: t.args,
        env: (t.env ?? []).map(
          (item): EnvVar => ({
            name: item.name,
            value: item.value,
            secret: false,
          }),
        ),
      };
    }
    if (definition.source === "npm")
      return {
        artifact: definition.package,
        version: definition.version,
        args: definition.args,
        env: definition.env,
      };
    const [image, digest] = definition.image.split("@");
    return {
      artifact: image!,
      version: digest!,
      args: definition.args,
      env: definition.env,
    };
  }
  view(row: Row): HostedServer {
    const runtime = this.runtime(row.id);
    const { artifact, version, args, env } = this.artifact(row.definition);
    return HostedServerSchema.parse({
      id: row.id,
      source: row.definition.source,
      ...(row.definition.source === "template"
        ? { template: row.definition.template }
        : {}),
      name: row.name,
      artifact,
      version,
      enabled: row.enabled,
      status: runtime.status,
      url: `${this.origin(row)}/mcp`,
      revision: row.revision,
      restarts: runtime.crashes.length,
      ...(runtime.error ? { error: runtime.error } : {}),
      args,
      env: env.map((item) => ({
        name: item.name,
        secret: item.secret,
        ...(!item.secret && item.value !== undefined
          ? { value: item.value }
          : {}),
      })),
    });
  }
  list(organizationId: string) {
    return this.rows(organizationId).map((row) => this.view(row));
  }
  logs(organizationId: string, id: string) {
    return [...this.runtime(this.row(organizationId, id).id).log];
  }
  private insert(
    organizationId: string,
    key: string,
    name: string,
    definition: Definition,
    secretValues: Record<string, string> = {},
  ) {
    const rows = this.rows();
    if (rows.length >= this.maxServers)
      throw new HostedError("hosted_limit", 429);
    const used = new Set(rows.map((r) => r.port));
    let port = this.ports.first;
    while (used.has(port) && port <= this.ports.last) port++;
    if (port > this.ports.last) throw new HostedError("hosted_limit", 429);
    const id = `hs_${randomBytes(12).toString("hex")}`;
    const row: Row = {
      id,
      organizationId,
      port,
      revision: 1,
      enabled: true,
      name,
      definition,
    };
    try {
      this.db
        .prepare("INSERT INTO agent_hosted_server VALUES (?,?,?,?,?,?)")
        .run(
          id,
          organizationId,
          key,
          port,
          JSON.stringify({ revision: 1, enabled: true, name, definition }),
          Object.keys(secretValues).length ? this.seal(secretValues, id) : null,
        );
    } catch {
      throw new HostedError("hosted_exists", 409);
    }
    this.trust(row);
    void this.run(row);
    return this.view(row);
  }
  create(organizationId: string, templateId: HostedTemplateId) {
    const template = HOSTED_TEMPLATES[templateId];
    if (!template) throw new HostedError("hosted_template_unknown", 404);
    if (
      this.rows(organizationId).some(
        (r) =>
          r.definition.source === "template" &&
          r.definition.template === templateId,
      )
    )
      throw new HostedError("hosted_exists", 409);
    return this.insert(organizationId, templateId, template.name, {
      source: "template",
      template: templateId,
    });
  }
  createCustom(
    organizationId: string,
    name: string,
    input: HostedDefinitionInput,
  ) {
    if (!this.allowCustom) throw new HostedError("hosted_custom_disabled", 403);
    const secretValues: Record<string, string> = {};
    const env = input.env.map((item) => {
      if (item.value !== undefined && /[\r\n\0]/.test(item.value))
        throw new HostedError("hosted_invalid", 400);
      if (item.secret) {
        if (item.value) secretValues[item.name] = item.value;
        return { name: item.name, secret: true };
      }
      return item;
    });
    return this.insert(
      organizationId,
      `custom:${randomBytes(8).toString("hex")}`,
      name,
      { ...input, env } as Definition,
      secretValues,
    );
  }
  /** Registry metadata only: nothing is downloaded or executed. */
  async resolve(pkg: string, version?: string) {
    if (!this.allowCustom) throw new HostedError("hosted_custom_disabled", 403);
    const result = await this.exec(
      {
        command: this.npm,
        args: [
          "view",
          `${pkg}@${version ?? "latest"}`,
          "--json",
          "name",
          "version",
          "description",
          "license",
          "_npmUser",
          "time",
          "dist.integrity",
          "bin",
          "scripts",
        ],
      },
      20000,
      { HOME: this.root },
    );
    if (result.code !== 0) throw new HostedError("hosted_package_unknown", 404);
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout || "{}");
    } catch {
      throw new HostedError("hosted_package_unknown", 404);
    }
    const parsed = z
      .object({
        name: z.string(),
        version: z.string(),
        description: z.string().optional(),
        license: z.string().optional(),
        _npmUser: z
          .union([z.string(), z.object({ name: z.string() })])
          .optional(),
        time: z.record(z.string(), z.string()).optional(),
        "dist.integrity": z.string(),
        bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
        scripts: z.record(z.string(), z.string()).optional(),
      })
      .safeParse(raw);
    if (!parsed.success) throw new HostedError("hosted_package_unknown", 404);
    const v = parsed.data;
    const bins =
      typeof v.bin === "string"
        ? [v.name.split("/").at(-1)!]
        : Object.keys(v.bin ?? {});
    return HostedPackageInfo.parse({
      package: v.name,
      version: v.version,
      ...(v.description ? { description: v.description.slice(0, 500) } : {}),
      ...(v.license ? { license: v.license.slice(0, 100) } : {}),
      ...(v._npmUser
        ? {
            publisher:
              typeof v._npmUser === "string" ? v._npmUser : v._npmUser.name,
          }
        : {}),
      ...(v.time?.[v.version] ? { published: v.time[v.version] } : {}),
      integrity: v["dist.integrity"],
      bins,
      // Never run, but worth knowing: the package may not work without them.
      hasInstallScripts: ["preinstall", "install", "postinstall"].some(
        (s) => !!v.scripts?.[s],
      ),
    });
  }
  private check(row: Row, revision: number) {
    if (row.revision !== revision)
      throw new HostedError("hosted_conflict", 409);
  }
  command(
    organizationId: string,
    id: string,
    revision: number,
    type: "start" | "stop" | "restart" | "remove",
  ) {
    const row = this.row(organizationId, id);
    this.check(row, revision);
    if (type === "remove") {
      this.halt(row);
      this.db.prepare("DELETE FROM agent_hosted_server WHERE id=?").run(row.id);
      this.untrust(row);
      this.runtimes.delete(row.id);
      rmSync(this.directory(row), { recursive: true, force: true });
      rmSync(this.envFile(row), { force: true });
      return undefined;
    }
    const next = {
      ...row,
      revision: row.revision + 1,
      enabled: type !== "stop",
    };
    this.write(next);
    const runtime = this.runtime(row.id);
    if (type !== "stop") runtime.crashes = [];
    this.halt(row);
    if (type !== "stop") void this.run(next);
    return this.view(next);
  }
  /** Starts every enabled server; leftover containers from a crash are removed first. */
  startAll() {
    for (const row of this.rows()) if (row.enabled) void this.run(row);
  }
  private directory(row: Row) {
    const dir = resolve(this.root, row.id);
    if (!dir.startsWith(resolve(this.root) + "/"))
      throw new HostedError("hosted_invalid", 500);
    return dir;
  }
  private envFile(row: Row) {
    return resolve(this.root, `${row.id}.env`);
  }
  private container(row: Row) {
    return `agent-${row.id}`;
  }
  private exec(
    command: Command,
    timeout: number,
    env: Record<string, string> = {},
    runtime?: Runtime,
  ) {
    return new Promise<{ code: number | null; stdout: string }>((done) => {
      let stdout = "";
      let child: ChildProcess;
      try {
        child = this.launch(command.command, command.args, {
          env: (command.env ?? {
            PATH: process.env.PATH ?? "",
            ...env,
          }) as unknown as NodeJS.ProcessEnv,
          ...(command.cwd ? { cwd: command.cwd } : {}),
          stdio: ["ignore", "pipe", "pipe"],
          timeout,
        });
      } catch {
        return done({ code: -1, stdout });
      }
      child.stdout?.on("data", (d: Buffer) => {
        stdout += String(d);
        if (runtime) this.append(runtime, String(d));
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (runtime) this.append(runtime, String(d));
      });
      child.once("error", () => done({ code: -1, stdout }));
      child.once("close", (code) => done({ code, stdout }));
    });
  }
  private ensureNetwork(sandbox: Sandbox) {
    this.networkReady ??= (async () => {
      const network = sandbox.network?.();
      if (network && (await this.exec(network.inspect, 10000)).code !== 0)
        await this.exec(network.create, 20000);
    })();
    return this.networkReady;
  }
  private install(row: Row, runtime: Runtime, sandbox: Sandbox) {
    const dir = this.directory(row);
    const marker = join(dir, ".agent-installed");
    const definition = row.definition;
    // A process has no mounted cache, so it keeps one in its own directory.
    const cache =
      sandbox.kind === "process"
        ? join(dir, ".npm-cache")
        : join(this.root, ".npm-cache");
    mkdirSync(join(dir, "home", "tmp"), { recursive: true, mode: 0o700 });
    if (definition.source === "image") return Promise.resolve();
    const pending = this.installs.get(row.id);
    if (pending) return pending;
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    const work = (async () => {
      if (definition.source === "template") {
        const source = HOSTED_TEMPLATES[definition.template].source;
        const digest = digestFile(join(source, "package-lock.json"));
        if (existsSync(marker) && readFileSync(marker, "utf8") === digest)
          return;
        for (const file of ["package.json", "package-lock.json"])
          copyFileSync(join(source, file), join(dir, file));
      } else if (!existsSync(join(dir, "package-lock.json"))) {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            name: "agent-hosted-server",
            private: true,
            dependencies: { [definition.package]: definition.version },
          }),
        );
        runtime.status = "installing";
        const locked = await this.exec(
          sandbox.lock(dir, cache),
          5 * 60 * 1000,
          {},
          runtime,
        );
        if (locked.code !== 0) throw new HostedError("hosted_install_failed");
      }
      const digest = digestFile(join(dir, "package-lock.json"));
      if (
        definition.source !== "template" &&
        existsSync(marker) &&
        readFileSync(marker, "utf8") === digest
      )
        return;
      runtime.status = "installing";
      const installed = await this.exec(
        sandbox.install(dir, cache),
        5 * 60 * 1000,
        {},
        runtime,
      );
      if (installed.code !== 0) throw new HostedError("hosted_install_failed");
      writeFileSync(marker, digest, { mode: 0o600 });
    })().finally(() => this.installs.delete(row.id));
    this.installs.set(row.id, work);
    return work;
  }
  /** The executable of an installed npm package: its only bin, or the chosen one. */
  private npmEntry(
    row: Row,
    definition: Extract<Definition, { source: "npm" }>,
  ) {
    const dir = this.directory(row);
    const manifest = JSON.parse(
      readFileSync(
        join(dir, "node_modules", definition.package, "package.json"),
        "utf8",
      ),
    ) as { bin?: string | Record<string, string>; name: string };
    const bins =
      typeof manifest.bin === "string"
        ? { [manifest.name.split("/").at(-1)!]: manifest.bin }
        : (manifest.bin ?? {});
    const names = Object.keys(bins);
    const chosen =
      definition.bin ?? (names.length === 1 ? names[0] : undefined);
    const target = chosen ? bins[chosen] : undefined;
    if (!target) throw new HostedError("hosted_bin_required");
    const entry = join("node_modules", definition.package, target);
    if (!resolve(dir, entry).startsWith(dir + "/"))
      throw new HostedError("hosted_invalid");
    return entry;
  }
  private async run(row: Row) {
    if (this.closing) return;
    const runtime = this.runtime(row.id);
    const generation = ++runtime.generation;
    runtime.error = undefined;
    runtime.status = "starting";
    const sandbox = await this.sandbox();
    // Custom code runs only in Docker; the process runtime is for curated templates.
    if (
      !sandbox ||
      (sandbox.kind === "process" && row.definition.source !== "template")
    ) {
      if (runtime.generation !== generation) return;
      runtime.status = "failed";
      runtime.error = "sandbox_unavailable";
      return;
    }
    await this.ensureNetwork(sandbox);
    const leftover = sandbox.remove?.(this.container(row));
    if (leftover) await this.exec(leftover, 20000);
    if (runtime.generation !== generation || this.closing) return;
    try {
      await this.install(row, runtime, sandbox);
      // Node's permission model follows links, so none may lead out of the directory.
      if (sandbox.kind === "process" && escapes(this.directory(row))) {
        this.append(runtime, "a link leads out of the server directory");
        throw new HostedError("hosted_install_failed");
      }
    } catch {
      if (runtime.generation !== generation) return;
      runtime.status = "failed";
      runtime.error = "install_failed";
      return;
    }
    if (runtime.generation !== generation || this.closing) return;
    runtime.status = "starting";
    const definition = row.definition;
    const secretValues = this.secretsOf(row);
    let program: Parameters<Sandbox["run"]>[0]["program"];
    let memoryMb = 512;
    const port = (args: string[], value: number) =>
      args.map((a) => a.replaceAll("{port}", String(value)));
    try {
      if (definition.source === "template") {
        const template = HOSTED_TEMPLATES[definition.template];
        memoryMb = template.memoryMb;
        program = {
          kind: "node",
          entry: template.entry,
          args: port(template.args, row.port),
        };
      } else if (definition.source === "npm") {
        program = {
          kind: "node",
          entry: this.npmEntry(row, definition),
          args: port(definition.args, row.port),
        };
      } else {
        program = {
          kind: "image",
          image: definition.image,
          containerPort: definition.port,
          args: port(definition.args, definition.port),
        };
      }
    } catch (error) {
      runtime.status = "failed";
      runtime.error =
        error instanceof HostedError && error.code === "hosted_bin_required"
          ? "bin_required"
          : "start_failed";
      return;
    }
    // Values go through a private file, never the command line other users could read.
    const env =
      definition.source === "template"
        ? (HOSTED_TEMPLATES[definition.template].env ?? []).map(
            (item): [string, string] => [item.name, item.value],
          )
        : definition.env
            .map((item) => [
              item.name,
              item.secret ? secretValues[item.name] : item.value,
            ])
            .filter((pair): pair is [string, string] => pair[1] !== undefined);
    // A process gets them in its own environment instead.
    const file = sandbox.kind === "docker" && env.length > 0;
    if (file)
      writeFileSync(
        this.envFile(row),
        env.map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
        { mode: 0o600 },
      );
    else rmSync(this.envFile(row), { force: true });
    const command = sandbox.run({
      name: this.container(row),
      // Real path: the permission model compares the paths Node resolves.
      dir: realpathSync(this.directory(row)),
      port: row.port,
      memoryMb,
      program,
      env: Object.fromEntries(env),
      ...(file ? { envFile: this.envFile(row) } : {}),
    });
    const known = Object.values(secretValues);
    const child = this.launch(command.command, command.args, {
      env: (command.env ?? {
        PATH: process.env.PATH ?? "",
      }) as unknown as NodeJS.ProcessEnv,
      ...(command.cwd ? { cwd: command.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    runtime.child = child;
    child.stdout?.on("data", (d: Buffer) =>
      this.append(runtime, String(d), known),
    );
    child.stderr?.on("data", (d: Buffer) =>
      this.append(runtime, String(d), known),
    );
    child.once("error", () => {
      runtime.error = "start_failed";
    });
    child.once("exit", (code, signal) => {
      if (runtime.child === child) runtime.child = undefined;
      if (runtime.generation !== generation || this.closing) return;
      this.append(runtime, `exited (${signal ?? code})`);
      const now = Date.now();
      runtime.crashes = [
        ...runtime.crashes.filter((t) => t > now - CRASH_WINDOW),
        now,
      ];
      if (runtime.crashes.length >= MAX_CRASHES) {
        runtime.status = "failed";
        runtime.error = "crashed";
        return;
      }
      runtime.status = "starting";
      const delay = Math.min(30000, 1000 * 2 ** (runtime.crashes.length - 1));
      runtime.timer = setTimeout(() => {
        const current = this.rows().find((r) => r.id === row.id);
        if (current?.enabled && runtime.generation === generation)
          void this.run(current);
      }, delay);
    });
    const ready = await this.waitForHttp(
      row.port,
      () => runtime.generation !== generation || !runtime.child,
    );
    if (runtime.generation !== generation) return;
    if (ready) runtime.status = "running";
    else if (runtime.child) {
      runtime.status = "failed";
      runtime.error = "not_ready";
      this.halt(row);
      runtime.status = "failed";
    }
  }
  /** Any HTTP answer means the server listens: a published port accepts TCP before that. */
  private async waitForHttp(port: number, cancelled: () => boolean) {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline && !cancelled()) {
      const answered = await new Promise<boolean>((done) => {
        const req = request(
          { host: "127.0.0.1", port, path: "/", method: "GET", timeout: 1500 },
          (res) => {
            res.resume();
            done(true);
          },
        );
        req.once("timeout", () => req.destroy());
        req.once("error", () => done(false));
        req.end();
      });
      if (answered) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }
  private halt(row: Row) {
    const runtime = this.runtime(row.id);
    runtime.generation++;
    clearTimeout(runtime.timer);
    const child = runtime.child;
    runtime.child = undefined;
    runtime.status = "stopped";
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 5000).unref();
    }
    // The container must not outlive the attached client, e.g. after SIGKILL.
    const leftover = this.chosen?.remove?.(this.container(row));
    if (leftover) void this.exec(leftover, 20000);
  }
  async close() {
    this.closing = true;
    const rows = this.rows();
    const children = [...this.runtimes.values()]
      .map((r) => r.child)
      .filter((c): c is ChildProcess => !!c && c.exitCode === null);
    const exits = children.map(
      (c) => new Promise<void>((done) => c.once("exit", () => done())),
    );
    for (const row of rows) if (this.runtimes.has(row.id)) this.halt(row);
    await Promise.race([
      Promise.all(exits),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
  }
}
