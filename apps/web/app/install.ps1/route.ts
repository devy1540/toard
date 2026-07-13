import { contentCollectionDefaultOn } from "@/lib/content-crypto";
import { buildPowerShellInstallScript } from "@/lib/powershell-installer";
import { getIngestEndpoint } from "@/lib/public-url";

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(
    buildPowerShellInstallScript(await getIngestEndpoint(), contentCollectionDefaultOn()),
    {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}
