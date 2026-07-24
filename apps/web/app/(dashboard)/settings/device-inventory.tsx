import type { DeviceToolInventory, ToolInventoryKind } from "@toard/core";
import { getTranslations } from "next-intl/server";
import { Disclosure } from "@/components/ui/disclosure";

export async function DeviceInventory({ inventory }: { inventory?: DeviceToolInventory }) {
  const t = await getTranslations("settings.install.inventory");
  if (!inventory) return <span className="text-muted-foreground mt-1 block text-xs">{t("missing")}</span>;
  const counts = countKinds(inventory);
  return (
    <Disclosure
      className="mt-1"
      triggerClassName="text-muted-foreground text-xs"
      trigger={<span>{t("summary", { mcp: counts.mcp, skills: counts.skill, plugins: counts.plugin })}</span>}
      contentClassName="mt-2 space-y-2 rounded-md border p-2"
    >
      {(["mcp", "skill", "plugin"] as const).map((kind) => {
        const items = inventory.items.filter((item) => item.kind === kind);
        if (items.length === 0) return null;
        return <div key={kind}><div className="text-muted-foreground text-[11px] uppercase">{t(`kind.${kind}`)}</div><div className="mt-1 flex flex-wrap gap-1">{items.map((item) => <span key={`${item.sourceProvider}:${item.itemKey}`} className="bg-muted rounded px-1.5 py-0.5 text-xs">{item.displayName}{item.version ? ` · ${item.version}` : ""}</span>)}</div></div>;
      })}
    </Disclosure>
  );
}

function countKinds(inventory: DeviceToolInventory): Record<ToolInventoryKind, number> {
  return inventory.items.reduce<Record<ToolInventoryKind, number>>((counts, item) => {
    counts[item.kind] += 1;
    return counts;
  }, { mcp: 0, skill: 0, plugin: 0 });
}
