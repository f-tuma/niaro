import { join } from "node:path";

/** Official Node image, pinned by digest: installation and npm servers run on exactly this. */
export const NODE_IMAGE =
  "node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c";
export const HOSTED_NETWORK = "agent-hosted";
export type Command = {
  command: string;
  args: string[];
  /** The whole environment; without it only PATH is passed. */
  env?: Record<string, string>;
  cwd?: string;
};
export type RunSpec = {
  /** Container name; also used to remove a leftover container after a crash. */
  name: string;
  /** The server's own directory, the only writable mount. */
  dir: string;
  /** Host port, published on loopback only. */
  port: number;
  envFile?: string;
  /** The same values for a runtime without an env file. */
  env: Record<string, string>;
  memoryMb: number;
  program:
    | { kind: "node"; entry: string; args: string[] }
    | { kind: "image"; image: string; containerPort: number; args: string[] };
};
export interface Sandbox {
  readonly kind: "docker" | "process";
  /** A command that succeeds only when the sandbox can run servers. */
  probe(): Command;
  network?(): { inspect: Command; create: Command };
  /** npm ci from the committed or generated lockfile; no install scripts. */
  install(dir: string, cache: string): Command;
  /** Generates a lockfile for an exact package version without installing it. */
  lock(dir: string, cache: string): Command;
  run(spec: RunSpec): Command;
  /** Removes what a crashed server may have left running. */
  remove?(name: string): Command;
}
const heapMb = (memoryMb: number) => Math.max(64, memoryMb - 128);

/** Each container: no capabilities or privilege escalation, a read-only root, an
 * unprivileged user, memory and process limits, its own network namespace (the host's
 * loopback services are unreachable) and a port published on 127.0.0.1 only. */
export class DockerSandbox implements Sandbox {
  readonly kind = "docker" as const;
  constructor(
    private readonly docker = "docker",
    private readonly user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  ) {}
  private hardening(memoryMb: number) {
    return [
      "--network",
      HOSTED_NETWORK,
      "--user",
      this.user,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      `${memoryMb}m`,
      "--memory-swap",
      `${memoryMb}m`,
      "--label",
      "agent.hosted=1",
    ];
  }
  probe(): Command {
    return {
      command: this.docker,
      args: ["info", "--format", "{{.ServerVersion}}"],
    };
  }
  network() {
    return {
      inspect: {
        command: this.docker,
        args: ["network", "inspect", HOSTED_NETWORK],
      },
      create: {
        command: this.docker,
        args: [
          "network",
          "create",
          "--driver",
          "bridge",
          // Hosted servers cannot reach each other either.
          "-o",
          "com.docker.network.bridge.enable_icc=false",
          HOSTED_NETWORK,
        ],
      },
    };
  }
  private npm(dir: string, cache: string, npmArgs: string[]): Command {
    return {
      command: this.docker,
      args: [
        "run",
        "--rm",
        ...this.hardening(1024),
        "-e",
        "HOME=/data/home",
        "-e",
        "npm_config_cache=/cache",
        "-e",
        "npm_config_update_notifier=false",
        "-v",
        `${dir}:/data`,
        "-v",
        `${cache}:/cache`,
        "-w",
        "/data",
        NODE_IMAGE,
        "npm",
        ...npmArgs,
      ],
    };
  }
  install(dir: string, cache: string) {
    return this.npm(dir, cache, [
      "ci",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ]);
  }
  lock(dir: string, cache: string) {
    return this.npm(dir, cache, [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
  }
  run(spec: RunSpec): Command {
    const program = spec.program;
    const inner = program.kind === "node" ? spec.port : program.containerPort;
    return {
      command: this.docker,
      args: [
        "run",
        "--rm",
        "--name",
        spec.name,
        ...this.hardening(spec.memoryMb),
        "--read-only",
        "--tmpfs",
        "/tmp:rw,size=64m",
        "-e",
        "HOME=/data/home",
        "-e",
        "NODE_ENV=production",
        ...(spec.envFile ? ["--env-file", spec.envFile] : []),
        "-v",
        `${spec.dir}:/data`,
        "-w",
        "/data",
        "-p",
        `127.0.0.1:${spec.port}:${inner}`,
        ...(program.kind === "node"
          ? [
              NODE_IMAGE,
              "node",
              `--max-old-space-size=${heapMb(spec.memoryMb)}`,
              `/data/${program.entry}`,
              ...program.args,
            ]
          : [program.image, ...program.args]),
      ],
    };
  }
  remove(name: string): Command {
    return { command: this.docker, args: ["rm", "-f", name] };
  }
}

// The child exits once its parent is gone, so a killed server leaves no process
// holding the port. A data URL needs no file read permission.
const ORPHAN_GUARD =
  "data:text/javascript,const p=process.ppid;setInterval(()=>{if(process.ppid!==p)process.exit(0)},1000).unref()";
const npmEnv = (dir: string, cache: string): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  HOME: join(dir, "home"),
  TMPDIR: join(dir, "home", "tmp"),
  npm_config_cache: cache,
  npm_config_update_notifier: "false",
});

/** Without Docker: a Node child of this server, the same user, limited by Node's
 * permission model. It reads only its own directory and writes only its home; no child
 * processes, workers, addons or WASI. It has an explicit environment and listens on
 * 127.0.0.1, but its network is not restricted. Node programs only, no images. */
export class ProcessSandbox implements Sandbox {
  readonly kind = "process" as const;
  constructor(
    private readonly node = process.execPath,
    private readonly npmCommand = "npm",
  ) {}
  probe(): Command {
    return { command: this.node, args: ["--permission", "-e", ""] };
  }
  private npm(dir: string, cache: string, npmArgs: string[]): Command {
    return {
      command: this.npmCommand,
      args: npmArgs,
      env: npmEnv(dir, cache),
      cwd: dir,
    };
  }
  install(dir: string, cache: string) {
    return this.npm(dir, cache, [
      "ci",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ]);
  }
  lock(dir: string, cache: string) {
    return this.npm(dir, cache, [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
  }
  run(spec: RunSpec): Command {
    const program = spec.program;
    if (program.kind !== "node") throw Error("Images need Docker");
    const home = join(spec.dir, "home");
    const env = { ...spec.env };
    // Node options or a preloaded library in the environment could widen the permissions.
    for (const name of Object.keys(env))
      if (/^(?:NODE_|LD_|DYLD_)/.test(name)) delete env[name];
    return {
      command: this.node,
      args: [
        "--permission",
        `--allow-fs-read=${spec.dir}`,
        `--allow-fs-write=${home}`,
        `--max-old-space-size=${heapMb(spec.memoryMb)}`,
        "--import",
        ORPHAN_GUARD,
        join(spec.dir, program.entry),
        // No container network here: a wildcard host becomes loopback.
        ...program.args.map((a) =>
          a.replace(/^0\.0\.0\.0(?=:\d|$)/, "127.0.0.1"),
        ),
      ],
      env: {
        ...env,
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: join(home, "tmp"),
        NODE_ENV: "production",
      },
      cwd: spec.dir,
    };
  }
}
