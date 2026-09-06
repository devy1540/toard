# 서버별 수집 범위 구현

2026-09-06 구현. 운영 배포·Windows/Linux 실제 실행 확인은 릴리스 검증에 남아 있다.

## 적용 경로

- `collection_scope.rs`: schemaVersion 1의 All / Custom / Paused. Custom의 provider별 All / Off / Include / Exclude. 지정하지 않은 provider는 Off이고 Include/Exclude에서 프로젝트 미식별은 차단한다.
- `Credentials.collection_scope`: 한 줄 JSON으로 저장한다. 누락된 legacy 정책만 All로 해석하고, 잘못된·중복된 정책은 안전하게 중지한다. 설치 `review`는 등록과 동시에 Paused로 만든다. 일반 재설치·토큰 교체는 기존 범위를 유지한다.
- `TargetStore`: scope 확인 당시 revision을 검증하며 읽기와 쓰기가 같은 registry lock을 사용한다. Legacy 설정은 승인 시 마이그레이션하고, 재반입 시 명시되지 않은 scope를 보존한다.
- `collect`: provider별 파싱 활성화와 target별 사용량·본문·도구 활동 필터. 범위 변경 시 기존 파일도 다시 읽는다. 프로젝트 제한 중 전역 inventory와 과거 보정 요청은 보내지 않는다.
- `usage_queue`: SQL에서 현 정책에 맞는 row를 고른 뒤 전송한다. 제외된 앞부분이 허용된 뒷부분을 막지 않으며 제외 row는 보존한다. 오래된 공유 보관함은 새 보관함 commit 뒤에만 원본 sequence를 정리해 옮긴다. 다른 연결 identity로는 옮기지 않는다.
- 원격 수집 상태에는 허용된 기록의 수만 포함한다. 프로젝트에 귀속할 수 없는 파싱 오류 수는 제한 모드에서 null이다. Loopback의 일반 상태 응답도 현재 credential과 scope에 맞는 대기량만 반환한다.

## 원본 프로젝트 문맥

RawUsage / RawContent / RawToolActivity는 로컬 `Arc<LocalProject>`를 갖고, wire 변환은 이 필드를 제외한다. 설정용 경로·목록·샘플은 로컬 승인 창에만 표시한다. 기존 전송 계약의 도구 세션 식별자, 그리고 별도로 켠 본문 수집은 그대로 적용된다.

- Claude: 메시지 cwd. 누락된 값을 파일명에서 추정하지 않는다.
- Codex: session_meta/turn_context cwd. 여러 session_meta가 섞인 fork/replay 파일은 프로젝트를 입증하지 못한 것으로 취급한다. 포함·제외 모드에서는 해당 미식별 기록이 전송되지 않는다.
- Gemini: 원본 projectHash. 세션 전환 시 값이 없으면 이전 프로젝트를 승계하지 않는다.
- Qwen: `projects/<group>/chats`의 로그 그룹. 실제 작업 디렉터리라고 주장하지 않는다.
- Cursor: stop hook의 workspace_roots가 하나일 때만 opaque project ID를 기록한다. 단일 경로와 transcript의 로그 그룹은 별도 항목이다. 다중 workspace와 과거 미식별 기록은 제한 모드에서 차단한다.

경로 라벨 캐시는 `~/.toard/state/local-projects/` 아래 private 파일이다. 내용이 사라졌을 때 프로젝트 경로를 임의로 복원하지 않는다. 경로를 Git repository 단위로 합치거나 별칭·하위 경로를 동일 프로젝트라고 추정하지 않는다.

## 로컬 확인 창

`scope_ui.rs`, `scope_ui.html`, `scope_ui.js`는 loopback에서만 제공한다. 정확한 Host, POST Origin, target+revision에 묶인 10분 capability, 32KiB 요청 한도, CSP/frame 차단을 적용한다. 선택은 이 창에서만 입력하고 opener에는 결과와 범위 요약만 돌려준다. 원격 CORS API로 scope를 바꾸는 fallback은 없다.

프로젝트 라벨은 textContent로 렌더링한다. 오래된 창·다른 Origin·재사용한 capability는 적용하지 않는다. 취소는 저장하지 않으며, 구버전 helper는 미지원으로 처리한다. 실제 설정 화면에는 `CollectionScopePanel`이 연결되어 있다. 기존 원격 기기 명령 UI는 유지한다.

`scope preview --target-env`는 로컬 메타데이터 미리보기, `scope set --target-env --file ...`은 명시적인 CLI 적용 경로다. 설치 명령은 `capabilities --scope`에서 `collection-scope-v1`을 확인한 뒤 `review` 등록을 진행한다.

## 직접 OTLP와의 경계

제한된 scope에서 직접 exporter 설정이 같은 서버로 향하면 적용을 거부한다. `toard-shim otlp off`는 toard가 관리한 Codex 블록과 Claude 설정만 정리하고 사용자 수정은 보존한다. 실행 중인 AI 도구는 재시작해야 하며 사용자 정의 exporter는 별도로 해제한다. 서버 provider도 기본 `logfile` 방식을 사용해야 한다.

새 OTLP 주입과 scope 저장은 registry lock으로 직렬화한다. 범위가 제한된 상태에서 `claude-env on`이나 wrapper의 experimental 주입으로 되돌리지 않는다. 이미 실행 중인 외부 AI 프로세스나 이미 전송 중인 요청을 강제로 종료하지 않는다.

## 검증

- 실제 브라우저: review 설치 후 즉시 수집해도 저장 안 됨 → 로컬 프로젝트 선택 → 허용된 프로젝트만 실제 서버 저장 및 개인 ledger 조회. 모바일 overflow도 확인.
- 브라우저 권한 경계: foreign Origin, DNS-rebinding 형태 Host, 변경된 target, capability 재사용, HTML 라벨 삽입 차단.
- 실제 CLI/HTTP: 원본 삭제·재시작·ACK 유실·손상 줄 복구와 env-only 공유 보관함의 등록 후 복구.
- Rust: 혼합 프로젝트를 두 target에 독립 전송, 제외 대기 기록 보존, 정책 변경 후 재스캔, 읽기/파싱/미지원 진단, registry snapshot·재설치·legacy 승인 경계.

Cursor 문맥의 근거는 [공식 hook Common schema](https://prod.cursor.com/docs/hooks)다. Codex의 기존 dedup/session ID 계약은 이 변경에서 다시 정의하지 않았다.
