"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ArrowLeft, KeyRound, LockKeyhole, MessageSquareText } from "lucide-react";
import { useTranslations } from "next-intl";
import { TurnText } from "@/components/dashboard/turn-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { contentKeyVault } from "@/lib/content-key-vault";
import { unlockApprovedBrowser } from "@/lib/content-auto-unlock";
import { runLegacyMigrationBatch } from "@/lib/e2ee-legacy-worker";
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
import { toHistoryPreview } from "@/lib/history-preview";
import { initialE2eeHistoryState, reduceE2eeHistory } from "./e2ee-history-state";
import { LockedHistory } from "./locked-history";

type DecryptedSession = E2eeHistoryPage["sessions"][number] & { preview: string };
type DecryptedTurn = E2eePromptRecordWire & { text: string | null };

const INACTIVITY_MS = 15 * 60 * 1000;

export function E2eeHistoryClient() {
  const t = useTranslations("dashboard.history.e2ee");
  const [state, dispatch] = useReducer(reduceE2eeHistory, initialE2eeHistoryState);
  const [sessions, setSessions] = useState<DecryptedSession[]>([]);
  const [detail, setDetail] = useState<{ key: string; turns: DecryptedTurn[]; truncated: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);
  const [hasLocalDevice, setHasLocalDevice] = useState(false);
  const [legacyRemaining, setLegacyRemaining] = useState<number | null>(null);
  const [migrationBlocked, setMigrationBlocked] = useState(false);
  const pendingKey = useRef<CryptoKeyPair | null>(null);
  const manuallyLocked = useRef(false);

  const lock = useCallback((manual = true) => {
    manuallyLocked.current = manual;
    contentKeyVault.lock();
    pendingKey.current = null;
    setSessions([]);
    setDetail(null);
    dispatch({ type: "lock" });
  }, []);

  const unlock = useCallback((uck: Uint8Array) => {
    contentKeyVault.unlock(uck);
    uck.fill(0);
    dispatch({ type: "uck-unwrapped" });
  }, []);

  const unlockLocal = useCallback(async () => {
    const result = await unlockApprovedBrowser({
      loadDevice: () => contentKeyVault.loadDevice(),
      loadWrapper: (deviceId) => fetchJson<ContentKeyWrapperWire>(
        `/api/content/devices/${encodeURIComponent(deviceId)}/wrapper`,
      ),
      openEnvelope: openDeviceEnvelope,
    });
    setHasLocalDevice(result !== null);
    if (!result) return false;
    manuallyLocked.current = false;
    setActiveDeviceId(result.deviceId);
    unlock(result.uck);
    return true;
  }, [unlock]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await fetchJson<{ state: "off" | "pending" | "active" }>("/api/content/status");
        if (cancelled) return;
        if (status.state !== "active") {
          dispatch({ type: "fatal", error: "E2EE_NOT_ACTIVE" });
          return;
        }
        if (!await unlockLocal()) {
          dispatch({ type: "status", hasLocalKey: false, hasPasskeyWrapper: false });
        }
      } catch (error) {
        if (!cancelled) {
          const hasLocalKey = await contentKeyVault.loadDevice().then(Boolean).catch(() => false);
          dispatch({ type: "status", hasLocalKey: false, hasPasskeyWrapper: false });
          if (hasLocalKey) contentKeyVault.lock();
        }
      }
    })();
    return () => { cancelled = true; };
  }, [unlockLocal]);

  useEffect(() => {
    if (state.kind !== "unlocked" || !activeDeviceId) return;
    const controller = new AbortController();
    let stopped = false;
    const run = async () => {
      while (!stopped && document.visibilityState === "visible" && navigator.onLine) {
        try {
          const status = await fetchJson<{
            state: "pending" | "complete" | "blocked";
            contentOwnerId: string;
            contentKeyVersion: number;
            legacyRecords: number;
          }>("/api/content/legacy-migration/status", { signal: controller.signal });
          setLegacyRemaining(status.legacyRecords);
          setMigrationBlocked(status.state === "blocked");
          if (status.state !== "pending" || status.legacyRecords === 0) return;
          const batchUck = contentKeyVault.withUnlockedUck((uck) => uck.slice());
          try {
            const result = await runLegacyMigrationBatch({
              deviceId: activeDeviceId,
              contentOwnerId: status.contentOwnerId,
              contentKeyVersion: status.contentKeyVersion,
              uck: batchUck,
              signal: controller.signal,
              fetchJson: (url, init) => fetchJson<unknown>(url, init),
            });
            if (result.complete) { setLegacyRemaining(0); return; }
          } finally {
            batchUck.fill(0);
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        } catch {
          if (!controller.signal.aborted) setMigrationBlocked(true);
          return;
        }
      }
    };
    void run();
    return () => { stopped = true; controller.abort(); };
  }, [activeDeviceId, state.kind]);

  useEffect(() => {
    if (state.kind !== "unlocked") return;
    let cancelled = false;
    void (async () => {
      try {
        const page = await fetchJson<E2eeHistoryPage>("/api/content/history/sessions?limit=50");
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
        if (!cancelled) setSessions(decrypted);
      } catch {
        if (!cancelled) dispatch({ type: "fatal", error: "CONTENT_HISTORY_FAILED" });
      }
    })();
    return () => { cancelled = true; };
  }, [state.kind, t]);

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

  const openSession = async (key: string) => {
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
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === "loading") return <p className="text-muted-foreground text-sm">{t("loading")}</p>;
  if (state.kind === "locked" || state.kind === "approvalPending") {
    return (
      <LockedHistory
        approval={state.approval}
        secondsLeft={secondsLeft}
        busy={busy}
        canLocalUnlock={hasLocalDevice}
        onLocalUnlock={() => void unlockLocal()}
        onApprove={() => void createApproval()}
        onRecover={(mnemonic) => void recover(mnemonic)}
      />
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

  return (
    <section className="min-w-0 space-y-3" aria-labelledby="e2ee-history-heading">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 id="e2ee-history-heading" className="text-sm font-medium">{t("title")}</h2>
        <Badge variant="secondary"><KeyRound className="mr-1 size-3" />{t("unlockedBadge")}</Badge>
        {legacyRemaining !== null ? (
          <Badge variant="outline">
            {migrationBlocked ? t("legacyBlocked") : legacyRemaining === 0
              ? t("legacyComplete")
              : t("legacyProtecting", { count: legacyRemaining })}
          </Badge>
        ) : null}
        <Button className="ml-auto" size="sm" variant="ghost" onClick={() => lock()}>
          <LockKeyhole />{t("lockNow")}
        </Button>
      </div>
      {detail ? (
        <div className="space-y-3">
          <Button size="sm" variant="ghost" onClick={() => setDetail(null)}><ArrowLeft />{t("back")}</Button>
          {detail.truncated ? <p className="text-muted-foreground text-xs">{t("truncated")}</p> : null}
          <Card className="min-w-0">
            <CardContent className="space-y-4 p-4 sm:p-6">
              {detail.turns.map((turn, index) => (
                <div key={turn.dedupKey} className={turn.turnRole === "user" ? "flex justify-end" : "flex justify-start"}>
                  <div className="max-w-[92%] min-w-0 rounded-xl border bg-muted/30 px-3 py-2 sm:max-w-[80%]">
                    <span className="sr-only">{turn.turnRole === "user" ? t("prompt") : t("response")}</span>
                    {turn.text === null ? (
                      <p className="text-muted-foreground text-sm italic">{t("contentUnavailable")}</p>
                    ) : (
                      <TurnText id={`e2ee-${index}`} text={turn.text} more={t("more")} less={t("less")} />
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      ) : sessions.length === 0 ? (
        <Card><CardContent className="p-5 text-sm text-muted-foreground">{t("empty")}</CardContent></Card>
      ) : (
        <Card className="min-w-0 overflow-hidden py-0">
          <CardContent className="divide-y p-0">
            {sessions.map((session) => (
              <button
                key={session.key}
                type="button"
                disabled={busy}
                className="hover:bg-muted/40 flex w-full min-w-0 items-start gap-3 px-4 py-3 text-left"
                onClick={() => void openSession(session.key)}
              >
                <MessageSquareText className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{session.preview || t("previewUnavailable")}</span>
                  <span className="text-muted-foreground mt-1 block text-xs">
                    {session.providerKey} · {t("turns", { count: session.turnCount })}
                  </span>
                </span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}
    </section>
  );
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
