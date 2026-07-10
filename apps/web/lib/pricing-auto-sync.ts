import { getAppSetting, setAppSetting } from "./app-settings";
import { orgDate } from "./org-time";
import { getPricingStatus } from "./pricing";
import { runPricingSync } from "./pricing-sync";

// 내장 가격 자동 동기화 (설계 §6.2 의 self-host 경로) — 외부 스케줄러(Vercel cron·GH Actions)
// 없이도 `docker compose up` 만으로 LiteLLM 가격 동기화가 일 1회 돌게 앱 기동 시 등록한다.
// on/off 는 admin 시스템 탭 토글이 DB(app_settings)에 저장하고 매 틱마다 다시 읽으므로
// 재시작 없이 반영된다(최대 1시간). env PRICING_AUTO_SYNC 는 인프라용 — off=킬스위치, on=dev 강제.
// 다중 replica 는 각자 틱을 돌지만 성공 조직 날짜로 스킵하고, 동시 실행은 transaction advisory lock으로 직렬화한다.

export const AUTO_SYNC_SETTING_KEY = "pricing_auto_sync";

const TICK_MS = 60 * 60 * 1000; // 1시간 — 틱은 "오늘 동기화 필요한가" 검사만 하므로 가볍다
const STARTUP_DELAY_MS = 10_000; // 기동 직후 마이그레이션·seed 마무리와 겹치지 않게 한 박자 늦춘다

/**
 * 내장 스케줄러 기동 판정 — 순수 함수. 프로세스 수명 동안 불변인 환경만 본다(토글은 틱에서).
 * - Vercel 은 vercel.json crons 가 담당하고 serverless 라 setInterval 이 부적합 → 항상 끔
 * - PRICING_AUTO_SYNC=off → 끔(킬스위치), =on → dev 서버에서도 켬
 * - 기본: production(self-host — compose·k8s·helm·bare)에서 켬
 */
export function schedulerEligible(env: NodeJS.ProcessEnv): boolean {
  if (env.VERCEL) return false;
  const flag = (env.PRICING_AUTO_SYNC ?? "").toLowerCase();
  if (flag === "off" || flag === "0" || flag === "false") return false;
  if (flag === "on" || flag === "1" || flag === "true") return true;
  return env.NODE_ENV === "production";
}

/** admin 토글 상태 — 기본 on (설치만으로 동작해야 하므로 행이 없으면 켜진 것으로 본다). */
export async function isAutoSyncEnabled(): Promise<boolean> {
  const v = await getAppSetting<{ enabled: boolean }>(AUTO_SYNC_SETTING_KEY);
  return v?.enabled !== false;
}

export async function setAutoSyncEnabled(enabled: boolean): Promise<void> {
  await setAppSetting(AUTO_SYNC_SETTING_KEY, { enabled });
}

export function pricingSyncDueToday(lastDay: string | null, today = orgDate(0)): boolean {
  return lastDay !== today;
}

/** 오늘(조직 타임존) 아직 성공 동기화 전이면 true. */
async function dueToday(): Promise<boolean> {
  const { lastDay } = await getPricingStatus();
  return pricingSyncDueToday(lastDay);
}

async function tick(): Promise<void> {
  try {
    if (!(await isAutoSyncEnabled()) || !(await dueToday())) return;
    const r = await runPricingSync();
    if (r.ok) {
      console.log(`[toard] 가격 자동 동기화 완료 — ${r.upserted} 모델 (${r.day})`);
    } else {
      console.warn(
        `[toard] 가격 자동 동기화 실패 — ${r.error}${r.kept ? " (기존 스냅샷 유지)" : ""} — 1시간 뒤 재시도`,
      );
    }
  } catch (e) {
    // DB 일시 장애·마이그레이션 전 등 — 다음 틱에서 재시도
    console.warn(`[toard] 가격 자동 동기화 오류 — ${String(e)} — 1시간 뒤 재시도`);
  }
}

/** 기동 10초 후 + 1시간 주기로 tick 을 실행한다. 프로세스당 한 벌만 등록. */
export function startPricingAutoSync(): void {
  // dev HMR 등으로 register 가 중복 호출돼도 타이머는 한 벌만
  const g = globalThis as { __toardPricingAutoSync?: true };
  if (g.__toardPricingAutoSync) return;
  g.__toardPricingAutoSync = true;
  setTimeout(tick, STARTUP_DELAY_MS).unref();
  setInterval(tick, TICK_MS).unref();
}
