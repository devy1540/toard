"use client";

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Inbox, KeyRound, LockKeyhole } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter, useSearchParams } from "next/navigation";
import type { SessionUsageSummary } from "@toard/core";
import { DashboardFilters } from "@/components/dashboard/dashboard-filters";
import { TurnText } from "@/components/dashboard/turn-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { contentKeyVault } from "@/lib/content-key-vault";
import { unlockApprovedBrowser } from "@/lib/content-auto-unlock";
import {
  acceptInitialE2eeMigrationStatus,
  createE2eeMigrationCompletionBoundary,
  createE2eeToManagedLoop,
  resolveE2eeContentAccountState,
  type E2eeMigrationCompletionBoundary,
  type E2eeManagedMigrationStatus,
} from "@/lib/e2ee-to-managed-worker";
import {
  decryptE2eeRecord,
  exportBrowserPublicKey,
  generateBrowserDeviceKey,
  openDeviceEnvelope,
  recoverUckFromMnemonic,
  sealUckForDevice,
} from "@/lib/e2ee-browser-crypto";
import type { E2eeHistoryDetail, E2eeHistoryPage } from "@/lib/e2ee-history";
import type { ContentKeyWrapperWire, E2eePromptRecordWire } from "@/lib/e2ee-contract";
import { formatCostForCoverage } from "@/lib/cost-coverage";
import { fmtUsd } from "@/lib/format";
import { groupHistoryAgents } from "@/lib/history-grouping";
import { toHistoryPreview } from "@/lib/history-preview";
import type { ProviderOption } from "@/lib/providers";
import { initialE2eeHistoryState, reduceE2eeHistory } from "./e2ee-history-state";
import { HistorySessionList } from "./history-session-list";
import { historyPagination, type HistoryListItem } from "./history-list-view";
import { HistoryAgentGroup } from "./history-agent-group";
import { LockedHistory } from "./locked-history";
import {
  managedMigrationStateBody,
  ManagedMigrationPanel,
} from "./managed-migration-panel";

type DecryptedSession = E2eeHistoryPage["sessions"][number] & { preview: string };
type DecryptedTurn = E2eePromptRecordWire & { text: string | null };

const INACTIVITY_MS = 15 * 60 * 1000;

export function E2eeHistoryClient({
  providers,
  timezone,
  previewBadgeLabel,
}: {
  providers: ProviderOption[];
  timezone: string;
  previewBadgeLabel: string;
}) {
  const t = useTranslations("dashboard.history.e2ee");
  const dashboardT = useTranslations("dashboard");
  const locale = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const sessionKey = searchParams.get("session");
  const pageNumber = Math.max(1, Number.parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const filterQuery = useMemo(() => {
    const params = new URLSearchParams(queryString);
    params.delete("session");
    params.delete("source");
    return params.toString();
  }, [queryString]);
  const [state, dispatch] = useReducer(reduceE2eeHistory, initialE2eeHistoryState);
  const [historyPage, setHistoryPage] = useState<{ sessions: DecryptedSession[]; totalSessions: number }>({
    sessions: [],
    totalSessions: 0,
  });
  const [detail, setDetail] = useState<{ key: string; turns: DecryptedTurn[]; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [hasLocalDevice, setHasLocalDevice] = useState(false);
  const [managedMigration, setManagedMigration] = useState<E2eeManagedMigrationStatus | null>(null);
  const [managedMigrationLoaded, setManagedMigrationLoaded] = useState(false);
  const [managedMigrationError, setManagedMigrationError] = useState<string | null>(null);
  const pendingKey = useRef<CryptoKeyPair | null>(null);
  const manuallyLocked = useRef(false);
  const completionActionRef = useRef<() => void>(() => undefined);
  const completionBoundaryRef = useRef<E2eeMigrationCompletionBoundary | null>(null);

  const lock = useCallback((manual = true) => {
    manuallyLocked.current = manual;
    contentKeyVault.lock();
    pendingKey.current = null;
    setHistoryPage({ sessions: [], totalSessions: 0 });
    setDetail(null);
    dispatch({ type: "lock" });
  }, []);

  completionActionRef.current = () => {
    lock(false);
    router.refresh();
  };
  if (completionBoundaryRef.current === null) {
    completionBoundaryRef.current = createE2eeMigrationCompletionBoundary(
      () => completionActionRef.current(),
    );
  }
  const completionBoundary = completionBoundaryRef.current;

  const unlock = useCallback((uck: Uint8Array) => {
    return completionBoundary.unlock(uck, (acceptedUck) => {
      contentKeyVault.unlock(acceptedUck);
      dispatch({ type: "uck-unwrapped" });
    });
  }, [completionBoundary]);

  const unlockLocal = useCallback(async () => {
    const result = await unlockApprovedBrowser({
      loadDevice: () => contentKeyVault.loadDevice(),
      loadWrapper: (deviceId) => fetchJson<ContentKeyWrapperWire>(
        `/api/content/devices/${encodeURIComponent(deviceId)}/wrapper`,
      ),
      openEnvelope: openDeviceEnvelope,
    });
    if (!result) {
      if (!completionBoundary.isComplete()) setHasLocalDevice(false);
      return false;
    }
    const accepted = unlock(result.uck);
    if (!accepted) return false;
    setHasLocalDevice(true);
    manuallyLocked.current = false;
    return true;
  }, [completionBoundary, unlock]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await fetchJson<{ state: "off" | "pending" | "active" | "migrated" }>(
          "/api/content/status",
        );
        if (cancelled) return;
        const resolution = resolveE2eeContentAccountState(completionBoundary, status.state);
        if (resolution === "complete") return;
        if (resolution !== "active") {
          dispatch({ type: "fatal", error: "E2EE_NOT_ACTIVE" });
          return;
        }
        if (!await unlockLocal() && !completionBoundary.isComplete()) {
          dispatch({ type: "status", hasLocalKey: false, hasPasskeyWrapper: false });
        }
      } catch (error) {
        if (!cancelled && !completionBoundary.isComplete()) {
          const hasLocalKey = await contentKeyVault.loadDevice().then(Boolean).catch(() => false);
          dispatch({ type: "status", hasLocalKey: false, hasPasskeyWrapper: false });
          if (hasLocalKey) contentKeyVault.lock();
        }
      }
    })();
    return () => { cancelled = true; };
  }, [completionBoundary, unlockLocal]);

  useEffect(() => {
    let cancelled = false;
    void fetchJson<E2eeManagedMigrationStatus>("/api/content/managed-migration/status")
      .then((status) => {
        if (!cancelled) {
          acceptInitialE2eeMigrationStatus(completionBoundary, status, setManagedMigration);
        }
      })
      .catch((error) => {
        if (cancelled || completionBoundary.isComplete()) return;
        const code = errorCode(error);
        if (code === "MIGRATION_NOT_FOUND") setManagedMigration(null);
        else setManagedMigrationError(code);
      })
      .finally(() => {
        if (!cancelled && !completionBoundary.isComplete()) setManagedMigrationLoaded(true);
      });
    return () => { cancelled = true; };
  }, [completionBoundary]);

  const managedMigrationRunnable = managedMigration?.state === "pending"
    || managedMigration?.state === "running";
  const managedMigrationVisible = managedMigration !== null
    && managedMigration.state !== "complete"
    && (managedMigration.state === "blocked" || managedMigration.e2eeRecords > 0);

  useEffect(() => {
    if (state.kind !== "unlocked" || !managedMigrationRunnable) return;
    const loop = createE2eeToManagedLoop({
      copyUck: () => contentKeyVault.withUnlockedUck((uck) => uck.slice()),
      fetchJson: (url, init) => fetchJson<unknown>(url, init),
      environment: {
        isVisible: () => document.visibilityState === "visible",
        isOnline: () => navigator.onLine,
        onVisibilityChange: (listener) => {
          document.addEventListener("visibilitychange", listener);
          return () => document.removeEventListener("visibilitychange", listener);
        },
        onOnline: (listener) => {
          window.addEventListener("online", listener);
          return () => window.removeEventListener("online", listener);
        },
      },
      onStatus: (status) => {
        acceptInitialE2eeMigrationStatus(completionBoundary, status, (acceptedStatus) => {
          setManagedMigration(acceptedStatus);
          setManagedMigrationError(null);
        });
      },
      onComplete: () => completionBoundary.finish(),
      onError: (error) => {
        if (!completionBoundary.isComplete()) setManagedMigrationError(errorCode(error));
      },
    });
    loop.start();
    return () => loop.dispose();
  }, [completionBoundary, managedMigrationRunnable, state.kind]);

  useEffect(() => {
    if (state.kind !== "unlocked" || !managedMigrationLoaded || managedMigrationVisible
      || managedMigrationError !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await fetchJson<E2eeHistoryPage>(
          `/api/content/history/sessions${filterQuery ? `?${filterQuery}` : ""}`,
        );
        const decrypted = await Promise.all(page.sessions.map(async (session) => {
          if (!session.previewRecord) return { ...session, preview: "" };
          try {
            const plaintext = await contentKeyVault.withUnlockedUck((uck) =>
              decryptE2eeRecord(uck, session.previewRecord!),
            );
            return { ...session, preview: toHistoryPreview(new TextDecoder().decode(plaintext)) };
          } catch {
            dispatch({ type: "record-failed", dedupKey: session.previewRecord.dedupKey });
            return { ...session, preview: t("contentUnavailable") };
          }
        }));
        if (!cancelled) setHistoryPage({ sessions: decrypted, totalSessions: page.totalSessions });
      } catch {
        if (!cancelled) dispatch({ type: "fatal", error: "CONTENT_HISTORY_FAILED" });
      }
    })();
    return () => { cancelled = true; };
  }, [filterQuery, managedMigrationError, managedMigrationLoaded, managedMigrationVisible, state.kind, t]);

  useEffect(() => {
    const onUnload = () => contentKeyVault.lock();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") timer = setTimeout(() => lock(false), INACTIVITY_MS);
      else {
        if (timer) { clearTimeout(timer); timer = null; }
        if (!manuallyLocked.current && !contentKeyVault.isUnlocked()) void unlockLocal();
      }
    };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer) clearTimeout(timer);
    };
  }, [lock, unlockLocal]);

  useEffect(() => {
    if (!expiresAt) return;
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (state.kind !== "approvalPending" || !state.approval || !pendingKey.current) return;
    let stopped = false;
    const poll = async () => {
      try {
        const result = await fetchJson<{
          state: "approved";
          deviceId: string;
          envelope: { algorithm: "hpke-p256-hkdf-sha256-aes256gcm-v1"; encapsulatedKey: string; ciphertext: string };
        }>(`/api/content/devices/approval-requests/${encodeURIComponent(state.approval!.requestId)}`, {
          allowAccepted: true,
        });
        if (result.state !== "approved" || stopped || !pendingKey.current) return;
        const pair = pendingKey.current;
        const uck = await openDeviceEnvelope(pair, result.envelope);
        await contentKeyVault.saveDevice(result.deviceId, pair);
        pendingKey.current = null;
        unlock(uck);
      } catch (error) {
        if (!stopped && error instanceof Error && error.message !== "HTTP_202") {
          dispatch({ type: "fatal", error: error.message });
        }
      }
    };
    const timer = setInterval(() => void poll(), 2_000);
    void poll();
    return () => { stopped = true; clearInterval(timer); };
  }, [state.kind, state.approval, unlock]);

  const createApproval = async () => {
    setBusy(true);
    try {
      const pair = await generateBrowserDeviceKey();
      const response = await fetchJson<{ id: string; code: string; expiresAt: string }>(
        "/api/content/devices/approval-requests",
        {
          method: "POST",
          body: JSON.stringify({
            kind: "browser",
            label: browserLabel(),
            platform: navigator.platform || "browser",
            publicKey: await exportBrowserPublicKey(pair.publicKey),
            algorithmVersion: "hpke-p256-v1",
          }),
        },
      );
      pendingKey.current = pair;
      setExpiresAt(new Date(response.expiresAt).getTime());
      dispatch({ type: "approval-created", requestId: response.id, code: response.code });
    } catch (error) {
      dispatch({ type: "fatal", error: error instanceof Error ? error.message : "DEVICE_APPROVAL_FAILED" });
    } finally {
      setBusy(false);
    }
  };

  const recover = async (mnemonic: string) => {
    setBusy(true);
    try {
      const material = await fetchJson<{ contentOwnerId: string; wrapper: ContentKeyWrapperWire }>(
        "/api/content/recovery/wrapper",
      );
      const wrapper = material.wrapper;
      const uck = await recoverUckFromMnemonic(mnemonic, {
        contentOwnerId: material.contentOwnerId,
        contentKeyVersion: wrapper.contentKeyVersion,
        publicSaltOrInput: wrapper.publicSaltOrInput!,
        nonce: wrapper.nonce!,
        authTag: wrapper.authTag!,
        wrappedContentKey: wrapper.wrappedContentKey,
      });
      const pair = await generateBrowserDeviceKey();
      const publicKey = await exportBrowserPublicKey(pair.publicKey);
      const envelope = await sealUckForDevice(publicKey, uck);
      const deviceId = crypto.randomUUID();
      await fetchJson("/api/content/recovery/complete", {
        method: "POST",
        body: JSON.stringify({
          device: {
            kind: "browser", label: browserLabel(), platform: navigator.platform || "browser",
            publicKey, algorithmVersion: "hpke-p256-v1",
          },
          deviceWrapper: {
            wrapperType: "device", wrapperRef: deviceId,
            contentKeyVersion: wrapper.contentKeyVersion, kdfVersion: "hpke-p256-v1",
            publicSaltOrInput: null, nonce: null, authTag: null,
            encapsulatedKey: envelope.encapsulatedKey, wrappedContentKey: envelope.ciphertext,
          },
        }),
      });
      await contentKeyVault.saveDevice(deviceId, pair);
      unlock(uck);
    } catch (error) {
      dispatch({ type: "fatal", error: error instanceof Error ? error.message : "RECOVERY_FAILED" });
    } finally {
      setBusy(false);
    }
  };

  const updateManagedMigrationState = useCallback(async (
    body: { action: "resume" } | { action: "block"; confirmation: "KEY_UNAVAILABLE" },
  ) => {
    setBusy(true);
    setManagedMigrationError(null);
    try {
      await fetchJson("/api/content/managed-migration/state", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const status = await fetchJson<E2eeManagedMigrationStatus>(
        "/api/content/managed-migration/status",
      );
      acceptInitialE2eeMigrationStatus(completionBoundary, status, setManagedMigration);
    } catch (error) {
      if (!completionBoundary.isComplete()) setManagedMigrationError(errorCode(error));
    } finally {
      setBusy(false);
    }
  }, [completionBoundary]);

  const resumeManagedMigration = useCallback(() => {
    void updateManagedMigrationState(managedMigrationStateBody("resume"));
  }, [updateManagedMigrationState]);

  const blockManagedMigration = useCallback((confirmation: "KEY_UNAVAILABLE") => {
    const body = managedMigrationStateBody("block");
    if (confirmation !== body.confirmation) return;
    void updateManagedMigrationState(body);
  }, [updateManagedMigrationState]);

  const openSession = useCallback(async (key: string) => {
    setBusy(true);
    try {
      const encrypted = await fetchJson<E2eeHistoryDetail>(
        `/api/content/history/sessions/${encodeURIComponent(key)}`,
      );
      const turns = await Promise.all(encrypted.turns.map(async (turn) => {
        try {
          const plaintext = await contentKeyVault.withUnlockedUck((uck) => decryptE2eeRecord(uck, turn));
          return { ...turn, text: new TextDecoder().decode(plaintext) };
        } catch {
          dispatch({ type: "record-failed", dedupKey: turn.dedupKey });
          return { ...turn, text: null };
        }
      }));
      setDetail({ key, turns, truncated: encrypted.truncated });
    } catch (error) {
      dispatch({
        type: "fatal",
        error: error instanceof Error ? error.message : "CONTENT_HISTORY_FAILED",
      });
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (state.kind !== "unlocked" || managedMigrationVisible) return;
    if (!sessionKey) {
      setDetail(null);
      return;
    }
    if (detail?.key !== sessionKey) void openSession(sessionKey);
  }, [detail?.key, managedMigrationVisible, openSession, sessionKey, state.kind]);

  const providerLabel = useCallback((key: string): string =>
    providers.find((provider) => provider.key === key)?.label ?? key, [providers]);
  const detailTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { timeZone: timezone, timeStyle: "short" }),
    [locale, timezone],
  );
  const detailTimeline = useMemo(() => groupHistoryAgents((detail?.turns ?? []).map((turn) => ({
    dedupKey: turn.dedupKey,
    sessionId: turn.sessionId,
    providerKey: turn.providerKey,
    role: turn.turnRole,
    ts: new Date(turn.ts),
    text: turn.text ?? "",
    contentUnavailable: turn.text === null,
    agent: turn.agent ?? null,
  }))), [detail?.turns]);
  const listItems = useMemo<HistoryListItem[]>(() => historyPage.sessions.map((session) => {
    const usage = session.usage;
    return {
      key: session.key,
      href: historyClientHref(queryString, { session: session.key }),
      providerKey: session.providerKey,
      providerLabel: providerLabel(session.providerKey),
      models: usage?.models ?? [],
      preview: session.preview || dashboardT("history.previewUnavailable"),
      turnLabel: dashboardT("history.turns", { count: session.turnCount }),
      totalTokens: usage ? totalUsageTokens(usage) : null,
      tokenUnit: dashboardT("tokens"),
      hosts: usage?.hosts ?? [],
      costLabel: usage ? formatCostForCoverage(fmtUsd(usage.costUsd), usage.costCoverage, {
        partial: dashboardT("costCoverage.partial"),
        unpriced: dashboardT("costCoverage.unpriced"),
        legacy: dashboardT("costCoverage.legacy"),
      }) : null,
      noUsageLabel: dashboardT("history.noUsage"),
      latestTs: session.latestTs,
    };
  }), [dashboardT, historyPage.sessions, providerLabel, queryString]);
  const pagination = historyPagination(pageNumber, historyPage.totalSessions);
  const prevHref = pagination.hasPrev
    ? historyClientHref(queryString, { session: null, page: pageNumber === 2 ? null : String(pageNumber - 1) })
    : null;
  const nextHref = pagination.hasNext
    ? historyClientHref(queryString, { session: null, page: String(pageNumber + 1) })
    : null;
  const noFilter = (!searchParams.get("period") || searchParams.get("period") === "all")
    && (!searchParams.get("provider") || searchParams.get("provider") === "all");
  const backHref = historyClientHref(queryString, { session: null });

  const migrationPanel = managedMigrationVisible && managedMigration ? (
    <ManagedMigrationPanel
      state={managedMigration.state === "complete" ? "pending" : managedMigration.state}
      migrated={managedMigration.migratedRecords}
      remaining={managedMigration.e2eeRecords}
      busy={busy}
      error={managedMigrationError}
      onResume={resumeManagedMigration}
      onBlock={blockManagedMigration}
    />
  ) : null;

  if (state.kind === "loading" || !managedMigrationLoaded) {
    return <p className="text-muted-foreground text-sm">{t("loading")}</p>;
  }
  if (managedMigrationError !== null && managedMigration === null) {
    return (
      <Card className="min-w-0">
        <CardContent className="p-4 text-sm text-muted-foreground">
          {t("error", { code: managedMigrationError })}
        </CardContent>
      </Card>
    );
  }
  if (state.kind === "locked" || state.kind === "approvalPending") {
    return (
      <section className="space-y-4">
        {migrationPanel}
        <LockedHistory
          approval={state.approval}
          secondsLeft={secondsLeft}
          busy={busy}
          canLocalUnlock={hasLocalDevice}
          onLocalUnlock={() => void unlockLocal()}
          onApprove={() => void createApproval()}
          onRecover={(mnemonic) => void recover(mnemonic)}
        />
      </section>
    );
  }
  if (state.kind === "fatal") {
    const inactive = state.error === "E2EE_NOT_ACTIVE";
    return (
      <Card className="min-w-0">
        <CardContent className="flex min-w-0 flex-col gap-3 p-4 text-sm sm:flex-row sm:items-center">
          <span className="min-w-0 break-words text-muted-foreground">
            {inactive ? t("notActive") : t("error", { code: state.error ?? "UNKNOWN" })}
          </span>
          {!inactive ? <Button className="sm:ml-auto" size="sm" variant="outline" onClick={() => lock()}>{t("lockNow")}</Button> : null}
        </CardContent>
      </Card>
    );
  }
  if (managedMigrationVisible) {
    return (
      <section className="min-w-0 space-y-4" aria-label={dashboardT("history.title")}>
        {migrationPanel}
      </section>
    );
  }

  return (
    <section className="min-w-0 space-y-6" aria-label={dashboardT("history.title")}>
      <DashboardFilters
        providers={providers}
        defaultPeriod="all"
        showAllPreset
        resetKeys={["page", "session"]}
        timezone={timezone}
        title={dashboardT("history.title")}
        statusBadge={{ status: "preview", label: previewBadgeLabel }}
        trailing={(
          <>
            <Badge variant="secondary" className="whitespace-nowrap">
              <KeyRound className="mr-1 size-3" />{t("unlockedBadge")}
            </Badge>
            <Button size="sm" variant="ghost" onClick={() => lock()}>
              <LockKeyhole />{t("lockNow")}
            </Button>
          </>
        )}
      />
      {detail ? (
        <div className="space-y-3">
          <Button asChild size="sm" variant="ghost">
            <Link href={backHref}><ArrowLeft />{t("back")}</Link>
          </Button>
          {detail.truncated ? <p className="text-muted-foreground text-xs">{t("truncated")}</p> : null}
          <Card className="min-w-0">
            <CardContent className="space-y-4 p-4 sm:p-6">
              {detailTimeline.map((item, index) => item.type === "agents" ? (
                <HistoryAgentGroup
                  key={`agents-${item.firstTs.toISOString()}-${index}`}
                  agents={item.agents}
                  firstTs={item.firstTs}
                  latestTs={item.latestTs}
                  turnUsage={new Map()}
                  fmtTime={(date) => detailTimeFormatter.format(date)}
                  costLabels={{
                    partial: dashboardT("costCoverage.partial"),
                    unpriced: dashboardT("costCoverage.unpriced"),
                    legacy: dashboardT("costCoverage.legacy"),
                  }}
                  idPrefix={`e2ee-agent-${index}`}
                  labels={{
                    subagents: (count) => dashboardT("history.subagents", { count }),
                    subagent: dashboardT("history.subagent"),
                    parallelExecution: dashboardT("history.parallelExecution"),
                    completed: dashboardT("history.agentCompleted"),
                    fallbackName: (agentIndex) => dashboardT("history.agentFallback", { index: agentIndex }),
                    depth: (depth) => dashboardT("history.agentDepth", { depth }),
                    assigned: dashboardT("history.agentAssigned"),
                    turns: (count) => dashboardT("history.turns", { count }),
                    rolePrompt: dashboardT("history.rolePrompt"),
                    roleResponse: dashboardT("history.roleResponse"),
                    showMore: dashboardT("history.showMore"),
                    showLess: dashboardT("history.showLess"),
                    contentUnavailable: dashboardT("history.contentUnavailable"),
                  }}
                />
              ) : (
                <div key={item.turn.dedupKey} className={item.turn.role === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div className="max-w-[92%] min-w-0 rounded-xl border bg-muted/30 px-3 py-2 sm:max-w-[80%]">
                    <span className="sr-only">{item.turn.role === "user" ? t("prompt") : t("response")}</span>
                    {item.turn.contentUnavailable ? (
                      <p className="text-muted-foreground text-sm italic">{t("contentUnavailable")}</p>
                    ) : (
                      <TurnText id={`e2ee-${index}`} text={item.turn.text} more={t("more")} less={t("less")} />
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      ) : historyPage.sessions.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Inbox /></EmptyMedia>
            <EmptyTitle>
              {noFilter ? dashboardT("history.emptyTitle") : dashboardT("history.noMatchTitle")}
            </EmptyTitle>
            <EmptyDescription>
              {noFilter ? dashboardT("history.emptyDescription") : dashboardT("history.noMatchDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <HistorySessionList
          items={listItems}
          totalSessions={historyPage.totalSessions}
          page={pageNumber}
          prevHref={prevHref}
          nextHref={nextHref}
          locale={locale}
          timezone={timezone}
          labels={{
            total: dashboardT("history.listTotal", { count: historyPage.totalSessions }),
            prev: dashboardT("history.prev"),
            next: dashboardT("history.next"),
            pageInfo: dashboardT("history.pageInfo", {
              page: pagination.page,
              totalPages: pagination.totalPages,
            }),
          }}
        />
      )}
    </section>
  );
}

function historyClientHref(
  queryString: string,
  overrides: Record<string, string | null>,
): string {
  const params = new URLSearchParams(queryString);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  return query ? `/history?${query}` : "/history";
}

function totalUsageTokens(usage: SessionUsageSummary): number {
  return usage.inputTokens
    + usage.outputTokens
    + usage.cacheReadTokens
    + usage.cacheCreationTokens;
}

async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit & { allowAccepted?: boolean } = {},
): Promise<T> {
  const { allowAccepted: _allowAccepted, ...requestInit } = init;
  const response = await fetch(url, {
    ...requestInit,
    headers: { "Content-Type": "application/json", ...requestInit.headers },
    cache: "no-store",
  });
  if (response.status === 202) throw new Error("HTTP_202");
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { code?: string } | null;
    throw new Error(body?.code ?? `HTTP_${response.status}`);
  }
  return response.json() as Promise<T>;
}

function browserLabel(): string {
  const agent = navigator.userAgent;
  if (agent.includes("Firefox")) return "Firefox browser";
  if (agent.includes("Edg/")) return "Edge browser";
  if (agent.includes("Chrome")) return "Chrome browser";
  if (agent.includes("Safari")) return "Safari browser";
  return "Web browser";
}

function errorCode(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "MIGRATION_FAILED";
}
