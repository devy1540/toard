import { getIngestEndpoint } from "@/lib/public-url";
import { uninstallScript } from "@/lib/shell-uninstaller";

export const dynamic = "force-dynamic";

export async function GET() {
  const endpoint = await getIngestEndpoint();
  return new Response(uninstallScript(endpoint), {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
