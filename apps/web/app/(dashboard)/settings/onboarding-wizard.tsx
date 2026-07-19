"use client";

import Link from "next/link";
import { useEffect, useMemo, useReducer, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  buildInstallCommand,
  detectInstallPlatform,
  type InstallPlatform,
} from "@/lib/onboarding-install";
import { initialOnboardingState, onboardingReducer } from "./onboarding-flow";
import {
  checkTokenConnectionAction,
  issueOnboardingTokenAction,
} from "./token-actions";

const POLL_MS = 2_000;
const POLL_TIMEOUT_MS = 120_000;
const PLATFORMS: InstallPlatform[] = ["windows", "macos", "linux"];

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: { platform?: string };
};

export function OnboardingWizard({
  baseUrl,
  contentEnabled,
  contentDefaultOn,
}: {
  baseUrl: string;
  contentEnabled: boolean;
  contentDefaultOn: boolean;
}) {
  const t = useTranslations("settings");
  const [state, dispatch] = useReducer(onboardingReducer, initialOnboardingState);
  const [collectContent, setCollectContent] = useState(contentDefaultOn);
  const [copied, setCopied] = useState<"install" | "doctor" | null>(null);
  const [issuing, startIssuing] = useTransition();

  useEffect(() => {
    const nav = navigator as NavigatorWithUserAgentData;
    const platform = detectInstallPlatform({
      userAgentDataPlatform: nav.userAgentData?.platform,
      platform: nav.platform,
      userAgent: nav.userAgent,
    });
    if (platform) dispatch({ type: "select-platform", platform });
  }, []);

  useEffect(() => {
    if (state.step !== "verifying" || !state.tokenId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const poll = async () => {
      try {
        const status = await checkTokenConnectionAction(state.tokenId!);
        if (!active) return;
        if (status.connected) {
          dispatch({ type: "connected", lastHost: status.lastHost });
          return;
        }
      } catch {
        // 일시적인 조회 실패는 2분 제한 안에서 다시 확인한다.
      }
      if (!active) return;
      if (Date.now() - startedAt >= POLL_TIMEOUT_MS) {
        dispatch({ type: "timeout" });
        return;
      }
      timer = setTimeout(poll, POLL_MS);
    };

    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [state.step, state.tokenId]);

  const totalSteps = 3;

  const installCommand = useMemo(() => {
    if (!state.platform || !state.token) return "";
    return buildInstallCommand({
      platform: state.platform,
      baseUrl,
      token: state.token,
      collectContent,
    });
  }, [baseUrl, collectContent, state.platform, state.token]);

  const copy = async (kind: "install" | "doctor", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      toast.success(t(kind === "install" ? "wizard.copiedInstall" : "wizard.copiedDoctor"));
    } catch {
      toast.error(t("errors.copyCommandFailed"));
    }
  };

  const issue = () => {
    if (!state.platform) return;
    startIssuing(async () => {
      const result = await issueOnboardingTokenAction();
      if (!result.token || !result.tokenId) {
        toast.error(result.error ?? t("errors.issueTokenFailed"));
        return;
      }
      dispatch({ type: "issued", token: result.token, tokenId: result.tokenId });
    });
  };

  if (state.step === "intro") {
    return (
      <div className="mx-auto max-w-xl space-y-5 py-2 text-center">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{t("wizard.introTitle")}</h2>
          <p className="text-muted-foreground text-sm">{t("wizard.introDescription")}</p>
        </div>
        {contentEnabled ? (
          <div className="bg-muted/50 flex items-start justify-between gap-4 rounded-lg p-4 text-left">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="wizard-content">
                {t("wizard.contentLabel")}
              </label>
              <p className="text-muted-foreground text-xs">
                {t(collectContent ? "wizard.contentWithPrompts" : "wizard.contentMetadataOnly")}
              </p>
            </div>
            <Switch
              id="wizard-content"
              checked={collectContent}
              onCheckedChange={setCollectContent}
            />
          </div>
        ) : (
          <p className="bg-muted/50 rounded-lg p-4 text-left text-xs">
            {t("wizard.introPrivacyMetadata")}
          </p>
        )}
        <Button className="w-full sm:w-auto" onClick={() => dispatch({ type: "start" })}>
          {t("wizard.start")}
        </Button>
      </div>
    );
  }

  if (state.step === "platform") {
    return (
      <WizardStep current={1} total={totalSteps} label={t("wizard.progress", { current: 1, total: totalSteps })}>
        <h2 className="text-lg font-semibold">{t("wizard.platformTitle")}</h2>
        <p className="text-muted-foreground text-sm">{t("wizard.platformDescription")}</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {PLATFORMS.map((platform) => (
            <Button
              key={platform}
              type="button"
              variant={state.platform === platform ? "default" : "outline"}
              aria-pressed={state.platform === platform}
              onClick={() => dispatch({ type: "select-platform", platform })}
            >
              {t(`wizard.${platform}`)}
            </Button>
          ))}
        </div>
        {state.platform ? (
          <p className="text-muted-foreground text-xs">
            {t("wizard.detected", { platform: t(`wizard.${state.platform}`) })}
          </p>
        ) : null}
        <Button className="w-full sm:w-auto" disabled={!state.platform || issuing} onClick={issue}>
          {issuing ? t("wizard.issuing") : t("wizard.continue")}
        </Button>
      </WizardStep>
    );
  }

  if (state.step === "install" && state.platform) {
    return (
      <WizardStep current={2} total={totalSteps} label={t("wizard.progress", { current: 2, total: totalSteps })}>
        <h2 className="text-lg font-semibold">{t(`wizard.installTitle.${state.platform}`)}</h2>
        <ol className="space-y-3 text-sm">
          <li><b>1.</b> {t(`wizard.openTerminal.${state.platform}`)}</li>
          <li><b>2.</b> {t("wizard.copyInstall")}</li>
          <li><b>3.</b> {t("wizard.pasteAndRun")}</li>
        </ol>
        <pre className="bg-muted max-w-full overflow-x-auto rounded-lg p-3 text-left text-xs">
          <code>{installCommand}</code>
        </pre>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => void copy("install", installCommand)}>
            {copied === "install" ? t("wizard.copiedInstall") : t("wizard.copyInstall")}
          </Button>
          <Button onClick={() => dispatch({ type: "verify" })}>{t("wizard.ranCommand")}</Button>
        </div>
      </WizardStep>
    );
  }

  if (state.step === "verifying") {
    return (
      <WizardStep current={3} total={totalSteps} label={t("wizard.progress", { current: 3, total: totalSteps })}>
        <h2 className="text-lg font-semibold">{t("wizard.verifyTitle")}</h2>
        <p className="text-muted-foreground text-sm">{t("wizard.verifyDescription")}</p>
        <div className="bg-muted/50 rounded-lg p-5 text-center text-sm" role="status">
          {t("wizard.waiting")}
        </div>
      </WizardStep>
    );
  }

  if (state.step === "success" && state.platform) {
    return (
      <WizardStep current={totalSteps} total={totalSteps} label={t("wizard.progress", { current: totalSteps, total: totalSteps })}>
        <h2 className="text-lg font-semibold">{t("wizard.connectedTitle")}</h2>
        <p className="text-muted-foreground text-sm">
          {t("wizard.connectedDescription", {
            computer: state.lastHost ?? t(`wizard.${state.platform}`),
          })}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button asChild><Link href="/">{t("wizard.viewUsage")}</Link></Button>
          <Button variant="outline" onClick={() => dispatch({ type: "reset" })}>
            {t("wizard.connectAnother")}
          </Button>
        </div>
      </WizardStep>
    );
  }

  const doctorCommand = state.platform === "windows"
    ? '& "$HOME\\.toard\\bin\\toard-shim.exe" doctor'
    : "toard-shim doctor";
  return (
    <WizardStep current={3} total={totalSteps} label={t("wizard.progress", { current: 3, total: totalSteps })}>
      <h2 className="text-lg font-semibold">{t("wizard.stalledTitle")}</h2>
      <p className="text-muted-foreground text-sm">{t("wizard.stalledDescription")}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button variant="outline" onClick={() => void copy("install", installCommand)}>
          {t("wizard.copyAgain")}
        </Button>
        <Button variant="outline" onClick={() => void copy("doctor", doctorCommand)}>
          {copied === "doctor" ? t("wizard.copiedDoctor") : t("wizard.copyDoctor")}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            dispatch({ type: "reset" });
            dispatch({ type: "start" });
          }}
        >
          {t("wizard.choosePlatformAgain")}
        </Button>
      </div>
    </WizardStep>
  );
}

function WizardStep({
  current,
  total,
  label,
  children,
}: {
  current: number;
  total: number;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-xl space-y-5 py-2">
      <div className="space-y-2" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={current} aria-label={label}>
        <div className="flex gap-1.5" aria-hidden="true">
          {Array.from({ length: total }, (_, index) => index + 1).map((step) => (
            <span key={step} className={`h-1.5 flex-1 rounded-full ${step <= current ? "bg-primary" : "bg-muted"}`} />
          ))}
        </div>
        <p className="text-muted-foreground text-xs">{current}/{total}</p>
      </div>
      {children}
    </div>
  );
}
