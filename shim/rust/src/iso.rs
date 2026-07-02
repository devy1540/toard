// epoch ms ↔ ISO 8601 UTC 변환 — 의존성 없이 (jiff 대체, 필요한 만큼만).
// 날짜 산술은 Howard Hinnant 의 days_from_civil/civil_from_days 알고리즘.

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// epoch ms → "YYYY-MM-DDTHH:MM:SS.mmmZ"
pub fn epoch_ms_to_iso(ms: i64) -> String {
    let (days, mut rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (y, mo, d) = civil_from_days(days);
    let milli = rem % 1000;
    rem /= 1000;
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

/// ISO 8601 부분집합 파싱 → epoch ms.
/// 허용: `YYYY-MM-DD[T ]HH:MM[:SS[.frac]][Z|±HH[:MM]]` — 오프셋 없으면 UTC 로 간주.
/// (어댑터 파서가 사용 — ccusage parse_ts_timestamp 대체)
#[allow(dead_code)]
pub fn iso_to_epoch_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 16 {
        return None;
    }
    let num = |range: std::ops::Range<usize>| -> Option<i64> { s.get(range)?.parse::<i64>().ok() };
    let year = num(0..4)?;
    if bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
        return None;
    }
    let month = num(5..7)?;
    let day = num(8..10)?;
    if !matches!(bytes.get(10), Some(b'T' | b't' | b' ')) {
        return None;
    }
    let hour = num(11..13)?;
    if bytes.get(13) != Some(&b':') {
        return None;
    }
    let minute = num(14..16)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }

    let mut pos = 16;
    let mut second = 0i64;
    if bytes.get(pos) == Some(&b':') {
        second = num(pos + 1..pos + 3)?;
        if second > 60 {
            return None;
        }
        pos += 3;
    }
    let mut milli = 0i64;
    if bytes.get(pos) == Some(&b'.') {
        let start = pos + 1;
        let mut end = start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end == start {
            return None;
        }
        let frac = &s[start..end.min(start + 3)];
        milli = frac.parse::<i64>().ok()? * 10i64.pow(3 - frac.len() as u32);
        pos = end;
    }
    // 오프셋
    let mut offset_min = 0i64;
    match bytes.get(pos) {
        None => {}
        Some(b'Z' | b'z') if pos + 1 == bytes.len() => {}
        Some(sign @ (b'+' | b'-')) => {
            let oh = num(pos + 1..pos + 3)?;
            let om = match bytes.get(pos + 3) {
                Some(&b':') => num(pos + 4..pos + 6)?,
                None => 0,
                Some(_) => num(pos + 3..pos + 5)?,
            };
            if oh > 23 || om > 59 {
                return None;
            }
            offset_min = oh * 60 + om;
            if *sign == b'-' {
                offset_min = -offset_min;
            }
        }
        Some(_) => return None,
    }

    let days = days_from_civil(year, month as u32, day as u32);
    Some((((days * 24 + hour) * 60 + minute - offset_min) * 60 + second) * 1000 + milli)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_epoch_iso() {
        for ms in [0i64, 1_719_800_000_123, 253_402_300_799_000] {
            assert_eq!(iso_to_epoch_ms(&epoch_ms_to_iso(ms)), Some(ms));
        }
        assert_eq!(epoch_ms_to_iso(0), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn parses_variants() {
        // 2026-07-01 = epoch 20635일 → 00:00Z = 1_782_864_000_000ms, +12h = 1_782_907_200_000
        const NOON: i64 = 1_782_907_200_000;
        assert_eq!(iso_to_epoch_ms("2026-07-01T12:00:00Z"), Some(NOON));
        // 오프셋 없는 값은 UTC 로 간주
        assert_eq!(iso_to_epoch_ms("2026-07-01T12:00:00"), Some(NOON));
        // 공백 구분자 + 초 없음
        assert_eq!(iso_to_epoch_ms("2026-07-01 12:00"), Some(NOON));
        // 밀리초·마이크로초 절삭
        assert_eq!(iso_to_epoch_ms("2026-07-01T12:00:00.5Z"), Some(NOON + 500));
        assert_eq!(
            iso_to_epoch_ms("2026-07-01T12:00:00.123456Z"),
            Some(NOON + 123)
        );
        // 오프셋 반영 (KST 21:00 = UTC 12:00)
        assert_eq!(iso_to_epoch_ms("2026-07-01T21:00:00+09:00"), Some(NOON));
        // 양방향 일치
        assert_eq!(epoch_ms_to_iso(NOON), "2026-07-01T12:00:00.000Z");
    }

    #[test]
    fn rejects_garbage() {
        for bad in [
            "",
            "2026",
            "2026-13-01T00:00:00Z",
            "2026-07-01T25:00:00Z",
            "not a date",
        ] {
            assert_eq!(iso_to_epoch_ms(bad), None, "{bad}");
        }
    }
}
