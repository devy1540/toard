import { buildPowerShellUninstallScript } from "@/lib/powershell-installer";
import { getIngestEndpoint } from "@/lib/public-url";

export const dynamic = "force-dynamic";

export async function GET() {
  const endpoint = await getIngestEndpoint();
  return new Response(buildPowerShellUninstallScript(endpoint), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
