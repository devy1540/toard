-- Up Migration
-- 신규 prompt session id는 URL·cursor·provider 계약의 공통 상한(255자)을 따른다.
-- 기존 장문 행은 보존하며, 무관한 본문/메타데이터 UPDATE도 계속 허용한다.
CREATE FUNCTION enforce_prompt_records_session_id_length()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.session_id IS DISTINCT FROM OLD.session_id)
     AND NEW.session_id IS NOT NULL
     AND char_length(NEW.session_id) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'prompt_records session_id length must be between 1 and 255',
      CONSTRAINT = 'prompt_records_session_id_length';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER prompt_records_session_id_length
BEFORE INSERT OR UPDATE OF session_id ON prompt_records
FOR EACH ROW
EXECUTE FUNCTION enforce_prompt_records_session_id_length();

-- Down Migration
DROP TRIGGER IF EXISTS prompt_records_session_id_length ON prompt_records;
DROP FUNCTION IF EXISTS enforce_prompt_records_session_id_length();
