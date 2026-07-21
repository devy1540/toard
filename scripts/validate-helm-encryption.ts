import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHART = `${ROOT}helm/toard`;
const HELM_IMAGE = process.env.TOARD_HELM_IMAGE ?? "alpine/helm:3.17.3";

type CommandResult = Readonly<{
  status: number;
  stdout: string;
  stderr: string;
}>;

function localHelm(): string | null {
  const configured = process.env.HELM_BIN?.trim();
  if (configured) return configured;
  return spawnSync("helm", ["version", "--short"], { encoding: "utf8" }).status === 0
    ? "helm"
    : null;
}

function runHelm(args: readonly string[]): CommandResult {
  const helm = localHelm();
  const command = helm ?? "docker";
  const commandArgs = helm
    ? [...args]
    : [
        "run", "--rm",
        "-v", `${ROOT}:/work`,
        "-w", "/work",
        HELM_IMAGE,
        ...args.map((argument) => (
          argument.startsWith(ROOT)
            ? `/work/${argument.slice(ROOT.length).replace(/^\//, "")}`
            : argument
        )),
      ];
  const result = spawnSync(command, commandArgs, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || "Helm command failed",
  };
}

function requirePass(label: string, args: readonly string[]): void {
  const result = runHelm(args);
  if (result.status !== 0) {
    console.error(`${label}: FAIL`);
    const diagnostic = `${result.stdout}\n${result.stderr}`.trim();
    console.error(diagnostic || "Helm command failed");
    process.exit(result.status);
  }
  console.log(`${label}: PASS`);
}

const cliArgs = process.argv.slice(2);
// pnpm/npm의 `script -- <args>` 호출은 환경에 따라 구분자 자체도 전달한다.
const valueArgs = cliArgs[0] === "--" ? cliArgs.slice(1) : cliArgs;
requirePass("helm lint --strict", ["lint", "--strict", CHART, ...valueArgs]);
// lint가 template helper의 fail을 놓치는 Helm 버전이 있어 실제 render를 별도 gate로 둔다.
requirePass("helm template", ["template", "toard", CHART, ...valueArgs]);
