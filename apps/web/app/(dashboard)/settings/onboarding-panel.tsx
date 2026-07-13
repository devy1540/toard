"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CopyButton } from "@/components/dashboard/copy-button";
import { Button } from "@/components/ui/button";
import { Disclosure } from "@/components/ui/disclosure";
import { detectInstallPlatform, type InstallPlatform } from "@/lib/onboarding-install";

const PLATFORMS: InstallPlatform[] = ["windows", "macos", "linux"];

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: { platform?: string };
};

export function OnboardingPanel({ baseUrl, endpoint }: { baseUrl: string; endpoint: string }) {
  const t = useTranslations("settings");
  const [platform, setPlatform] = useState<InstallPlatform>("macos");

  useEffect(() => {
    const nav = navigator as NavigatorWithUserAgentData;
    const detected = detectInstallPlatform({
      userAgentDataPlatform: nav.userAgentData?.platform,
      platform: nav.platform,
      userAgent: nav.userAgent,
    });
    if (detected) setPlatform(detected);
  }, []);

  const commands = managementCommands(platform, baseUrl, endpoint);

  return (
    <Disclosure
      trigger={t("management.title")}
      triggerClassName="text-muted-foreground hover:text-foreground text-sm"
    >
      <div className="mt-3 space-y-5 rounded-lg border p-4">
        <p className="text-muted-foreground text-xs">{t("management.description")}</p>
        <div className="space-y-2">
          <p className="text-xs font-medium">{t("management.platform")}</p>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={platform === value ? "default" : "outline"}
                aria-pressed={platform === value}
                onClick={() => setPlatform(value)}
              >
                {t(`wizard.${value}`)}
              </Button>
            ))}
          </div>
        </div>
        <ManagementCommand title={t("management.manual")} command={commands.manual} />
        <ManagementCommand title={t("management.doctor")} command={commands.doctor} />
        <ManagementCommand title={t("management.update")} command={commands.update} />
        <ManagementCommand title={t("management.uninstall")} command={commands.uninstall} />
      </div>
    </Disclosure>
  );
}

function ManagementCommand({ title, command }: { title: string; command: string }) {
  const t = useTranslations("settings");
  return (
    <div className="space-y-2 border-t pt-4 first:border-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{title}</h3>
        <CopyButton text={command} label={t("management.copy")} />
      </div>
      <pre className="bg-muted max-w-full overflow-x-auto rounded-md p-3 text-xs leading-relaxed">
        <code>{command}</code>
      </pre>
    </div>
  );
}

function managementCommands(platform: InstallPlatform, baseUrl: string, endpoint: string) {
  const base = baseUrl.replace(/\/+$/, "");
  if (platform === "windows") {
    const shim = '"$HOME\\.toard\\bin\\toard-shim.exe"';
    return {
      manual: `notepad "$HOME\\.toard\\credentials"\n# agent_key=<내 토큰>\n# endpoint=${endpoint}`,
      doctor: `& ${shim} doctor`,
      update: `& ${shim} update`,
      uninstall: `irm '${base}/uninstall.ps1' | iex`,
    };
  }
  return {
    manual: [
      "mkdir -p ~/.toard && chmod 700 ~/.toard",
      "cat > ~/.toard/credentials <<'EOF'",
      "agent_key=<내 토큰>",
      `endpoint=${endpoint}`,
      "EOF",
      "chmod 600 ~/.toard/credentials",
    ].join("\n"),
    doctor: "toard-shim doctor",
    update: "toard-shim update",
    uninstall: `curl -fsSL '${base}/uninstall.sh' | sh`,
  };
}
