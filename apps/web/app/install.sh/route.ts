import { contentCollectionDefaultOn } from "@/lib/content-crypto";
import { getIngestEndpoint } from "@/lib/public-url";
import { installScript } from "@/lib/shell-installer";

// toard 가 직접 서빙하는 원클릭 설치 스크립트. endpoint 를 서버가 주입하고, 토큰은 env 로 받는다.
//   curl -fsSL <toard>/install.sh | TOARD_INGEST_TOKEN=tk_... sh
export const dynamic = "force-dynamic";

export async function GET() {
  const endpoint = await getIngestEndpoint();
  return new Response(installScript(endpoint, contentCollectionDefaultOn()), {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
