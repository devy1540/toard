-- Up Migration

-- Claude Code·Codex 사용량 수집을 OTLP push → 트랜스크립트 pull 로 전환(docs/design-usage-pull §5.2).
-- collection_method 를 otel→logfile 로 바꿔 "provider 당 단일 소스" 로 만든다:
--   /v1/logs(OTLP)   는 collection_method!=='otel'   provider 를 드롭(identifyProvider 게이트)
--   /v1/events(pull) 는 collection_method!=='logfile' 이벤트를 드롭(대칭 게이트)
-- enabled 는 true 유지 — /v1/events·/v1/logs 의 provider 실재 검증이 둘 다
-- loadProviders()=`WHERE enabled=true` 를 쓰므로 disable 하면 pull 까지 깨진다(§5.2 자기검토).
-- 배포 순서: 이 게이트를 shim 강등(OTLP 주입 중단)보다 먼저 배포해 컷오버 이중집계를 막는다(§5.3).
UPDATE providers SET collection_method = 'logfile'
WHERE key IN ('claude_code', 'codex');

-- Down Migration

UPDATE providers SET collection_method = 'otel'
WHERE key IN ('claude_code', 'codex');
