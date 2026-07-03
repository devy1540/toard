-- Up Migration

-- Claude Desktop 의 Code 탭은 OTLP resource 의 service.name 을 'claude-code-desktop' 으로 보낸다
-- (CLI 는 'claude-code'). 기존 provider 패턴은 'claude-code' 만 매칭해 Desktop 사용량이 통째로
-- 드롭됐다(§4.4 identifyProvider). 기존 배포의 claude_code 행에 desktop 패턴을 보강한다(멱등).
UPDATE providers
SET service_name_patterns = array_append(service_name_patterns, 'claude-code-desktop')
WHERE key = 'claude_code'
  AND NOT ('claude-code-desktop' = ANY(service_name_patterns));

-- Down Migration

UPDATE providers
SET service_name_patterns = array_remove(service_name_patterns, 'claude-code-desktop')
WHERE key = 'claude_code';
