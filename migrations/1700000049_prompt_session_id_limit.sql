-- Up Migration
-- 신규 prompt session id는 URL·cursor·provider 계약의 공통 상한(255자)을 따른다.
-- NOT VALID는 기존 설치에 비정상 장문 행이 있어도 배포를 막지 않으면서 신규 쓰기에는 즉시 적용된다.
ALTER TABLE prompt_records
  ADD CONSTRAINT prompt_records_session_id_length
  CHECK (session_id IS NULL OR char_length(session_id) BETWEEN 1 AND 255)
  NOT VALID;

-- Down Migration
ALTER TABLE prompt_records
  DROP CONSTRAINT IF EXISTS prompt_records_session_id_length;
