export type InstallPlatform = "windows" | "macos" | "linux";

export type PlatformSignals = {
  userAgentDataPlatform?: string | null;
  platform?: string | null;
  userAgent?: string | null;
};

export type InstallCommandInput = {
  platform: InstallPlatform;
  baseUrl: string;
  token: string;
  collectContent: boolean;
};

export function detectInstallPlatform(input: PlatformSignals): InstallPlatform | null {
  const value = [input.userAgentDataPlatform, input.platform, input.userAgent]
    .filter((item): item is string => Boolean(item))
    .join(" ")
    .toLowerCase();

  if (/windows|win32|win64/.test(value)) return "windows";
  if (/macintosh|macintel|mac os/.test(value)) return "macos";
  if (/linux|x11/.test(value)) return "linux";
  return null;
}

function trimBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildInstallCommand(input: InstallCommandInput): string {
  const collect = input.collectContent ? "e2ee_v1" : "0";
  const baseUrl = trimBaseUrl(input.baseUrl);

  if (input.platform === "windows") {
    return [
      `$env:TOARD_INGEST_TOKEN=${quotePowerShell(input.token)}`,
      `$env:TOARD_SHIM_COLLECT_CONTENT=${quotePowerShell(collect)}`,
      `irm ${quotePowerShell(`${baseUrl}/install.ps1`)} | iex`,
    ].join("; ");
  }

  return `curl -fsSL ${quotePosix(`${baseUrl}/install.sh`)} | TOARD_INGEST_TOKEN=${quotePosix(input.token)} TOARD_SHIM_COLLECT_CONTENT=${quotePosix(collect)} sh`;
}
