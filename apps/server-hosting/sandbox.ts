/** Official Node image, pinned by digest: installation and npm servers run on exactly this. */
export const NODE_IMAGE =
  "node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c";
export const HOSTED_NETWORK = "agent-hosted";
export type Command = { command: string; args: string[] };
export type RunSpec = {
  /** Container name; also used to remove a leftover container after a crash. */
  name: string;
  /** The server's own directory, the only writable mount. */
  dir: string;
  /** Host port, published on loopback only. */
  port: number;
  envFile?: string;
  memoryMb: number;
  program:
    | { kind: "node"; entry: string; args: string[] }
    | { kind: "image"; image: string; containerPort: number; args: string[] };
};
export interface Sandbox {
  readonly kind: "docker";
  /** A command that succeeds only when the sandbox can run containers. */
  probe(): Command;
  network(): { inspect: Command; create: Command };
  /** npm ci from the committed or generated lockfile; no install scripts. */
  install(dir: string, cache: string): Command;
  /** Generates a lockfile for an exact package version without installing it. */
  lock(dir: string, cache: string): Command;
  run(spec: RunSpec): Command;
  remove(name: string): Command;
}

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
              `--max-old-space-size=${Math.max(64, spec.memoryMb - 128)}`,
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
