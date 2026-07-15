import { buildPowerShellUninstallScript } from "@/lib/powershell-installer";

export const dynamic = "force-static";

export function GET() {
  return new Response(buildPowerShellUninstallScript(), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
