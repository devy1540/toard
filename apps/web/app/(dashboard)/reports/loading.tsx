import { getTranslations } from "next-intl/server";
export default async function Loading() {
  const t = await getTranslations("reports");
  return <div role="status" aria-busy="true" className="text-muted-foreground p-6">{t("loading")}</div>;
}
