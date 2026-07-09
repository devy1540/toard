"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/dashboard/copy-button";
import { Input } from "@/components/ui/input";
import { issueTokenAction, type TokenState } from "./token-actions";

const RELEASE_INSTALL = "https://github.com/devy1540/toard/releases/latest/download/install.sh";
const INITIAL: TokenState = {};
const ISSUE_FORM_ID = "issue-token-form";

/** 한 줄 설치 — toard 가 서빙하는 install.sh 에 토큰을 env 로 넘김(바이너리+자격+PATH 자동). */
function oneLiner(token: string, baseUrl: string, collectContent: boolean): string {
  const content = collectContent ? " TOARD_SHIM_COLLECT_CONTENT=1" : "";
  return `curl -fsSL ${baseUrl}/install.sh | TOARD_INGEST_TOKEN=${token}${content} sh`;
}

/** 수동(고급) — 릴리스 install.sh + 직접 자격/PATH 설정. */
function manualSnippet(token: string, endpoint: string, collectContent: boolean): string {
  return [
    `curl -fsSL ${RELEASE_INSTALL} | sh`,
    "mkdir -p ~/.toard && chmod 700 ~/.toard",
    "cat > ~/.toard/credentials <<'EOF'",
    `agent_key=${token}`,
    `endpoint=${endpoint}`,
    ...(collectContent ? ["collect_content=true"] : []),
    "EOF",
    "chmod 600 ~/.toard/credentials",
    'export PATH="$HOME/.toard/bin:$PATH"   # ~/.zshrc 에 추가',
  ].join("\n");
}

export function OnboardingPanel({
  baseUrl,
  endpoint,
  hasToken,
  createdAt,
  lastUsedAt,
  contentEnabled,
  contentDefaultOn = false,
}: {
  baseUrl: string;
  endpoint: string;
  hasToken: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
  contentEnabled: boolean;
  contentDefaultOn?: boolean;
}) {
  const t = useTranslations("settings");
  const [state, action, pending] = useActionState(issueTokenAction, INITIAL);
  // 운영자 정책이 opt-out(CONTENT_COLLECTION_DEFAULT=on)이면 기본 체크.
  const [collectContent, setCollectContent] = useState(contentDefaultOn);
  const token = state.token;
  const fmt = (s: string | null) => (s ? new Date(s).toLocaleString() : "—");
  const placeholder = t("onboarding.tokenPlaceholder");
  const one = oneLiner(token ?? placeholder, baseUrl, collectContent);
  // 발급 결과 토스트 — 같은 토큰으로 중복 발화 방지
  const toastedToken = useRef<string | null>(null);

  useEffect(() => {
    if (state.token && toastedToken.current !== state.token) {
      toastedToken.current = state.token;
      toast.success(t("onboarding.issueSuccess"));
    }
  }, [state.token, t]);
  useEffect(() => {
    if (state.error) toast.error(state.error);
  }, [state.error]);

  const issueLabel = hasToken || Boolean(token) ? "onboarding.issueAdditional" : "onboarding.issue";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="text-muted-foreground">{t("onboarding.tokenLabel")}</span>
          {token ? (
            <span>
              {t("onboarding.issued")}{" "}
              <span className="text-muted-foreground">{t("onboarding.justNow")}</span>
            </span>
          ) : hasToken ? (
            <span>
              {t("onboarding.issued")}{" "}
              {/* 로캘·타임존 의존 포맷 — SSR 과 달라질 수 있어 클라이언트 값 유지 */}
              <span className="text-muted-foreground" suppressHydrationWarning>
                {t("onboarding.createdInfo", {
                  createdAt: fmt(createdAt),
                  lastUsed: lastUsedAt
                    ? t("onboarding.lastUsedSuffix", { lastUsedAt: fmt(lastUsedAt) })
                    : "",
                })}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">{t("onboarding.notYet")}</span>
          )}
        </div>
        <form id={ISSUE_FORM_ID} action={action} className="flex flex-wrap items-end justify-end gap-2">
          <div className="w-48 space-y-1">
            <label className="text-muted-foreground text-xs" htmlFor="token-device-label">
              {t("onboarding.deviceLabel")}
            </label>
            <Input
              id="token-device-label"
              name="label"
              maxLength={80}
              placeholder={t("onboarding.deviceLabelPlaceholder")}
              disabled={pending}
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? t("onboarding.issuing") : t(issueLabel)}
          </Button>
        </form>
      </div>

      {state.error ? <p className="text-destructive text-sm">{state.error}</p> : null}

      {token ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p className="font-medium">{t("onboarding.newTokenNotice")}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("onboarding.newTokenReissueHint")}
          </p>
        </div>
      ) : null}

      {/* 쉬운 설치 — 한 줄 */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("onboarding.oneLinerTitle")}</h2>
          <CopyButton
            text={one}
            label={t("onboarding.copyCommandLabel")}
            message={t("onboarding.oneLinerCopied")}
          />
        </div>
        {!token ? (
          <p className="text-muted-foreground text-xs">
            {t.rich("onboarding.issueHint", { b: (chunks) => <b>{chunks}</b> })}
          </p>
        ) : null}
        {contentEnabled ? (
          <label className="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={collectContent}
              onChange={(e) => setCollectContent(e.target.checked)}
            />
            <span>
              {t.rich("onboarding.collectContentLabel", {
                muted: (chunks) => <span className="text-muted-foreground">{chunks}</span>,
                link: (chunks) => (
                  <a className="text-primary underline-offset-4 hover:underline" href="/history">
                    {chunks}
                  </a>
                ),
              })}
            </span>
          </label>
        ) : (
          <p className="text-muted-foreground text-xs">{t("onboarding.collectContentGated")}</p>
        )}
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs leading-relaxed">{one}</pre>
        <p className="text-muted-foreground text-xs">{t("onboarding.oneLinerDescription")}</p>
      </div>

      {/* 수동(고급) — 접기 */}
      <details className="text-sm">
        <summary className="text-muted-foreground cursor-pointer select-none">
          {t("onboarding.manualSummary")}
        </summary>
        <div className="mt-2 flex items-center justify-end">
          <CopyButton
            text={manualSnippet(token ?? placeholder, endpoint, collectContent)}
            message={t("onboarding.manualCopied")}
          />
        </div>
        <pre className="bg-muted mt-1 overflow-x-auto rounded-md p-3 text-xs leading-relaxed">
          {manualSnippet(token ?? placeholder, endpoint, collectContent)}
        </pre>
      </details>

      {/* 제거 */}
      <div className="space-y-2 border-t pt-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("onboarding.uninstallTitle")}</h2>
          <CopyButton
            text={`curl -fsSL ${baseUrl}/uninstall.sh | sh`}
            label={t("onboarding.copyCommandLabel")}
            message={t("onboarding.uninstallCopied")}
          />
        </div>
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs leading-relaxed">{`curl -fsSL ${baseUrl}/uninstall.sh | sh`}</pre>
        <p className="text-muted-foreground text-xs">{t("onboarding.uninstallDescription")}</p>
      </div>
    </div>
  );
}
