-- Up Migration

-- shim 버전 추적 (기기 단위). 수집 요청의 User-Agent(toard-shim/<semver>)를 (user, host)
-- 로 남긴다 — 한 토큰을 여러 컴퓨터가 공유하므로 토큰 단위가 아닌 기기 단위여야 기기별
-- 표시가 가능하다. 자동 업데이트가 침묵 실패로 멈춘 기기를 설정·admin 화면에서 식별하는
-- 순수 관측용 테이블 (수집 경로의 정합성과 무관, 실패해도 수집은 계속된다).
CREATE TABLE host_shims (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host         TEXT NOT NULL,
  shim_version TEXT NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, host)
);

-- Down Migration

DROP TABLE host_shims;
