# Shim Multi-Target Fan-Out 완료 감사

## 감사 범위

- 설계: `docs/superpowers/specs/2026-07-18-shim-multi-target-fanout-design.md`
- 구현 계획: `docs/superpowers/plans/2026-07-18-shim-multi-target-fanout.md`
- 비교 기준: `bc60a70..HEAD`
- 사용자 시나리오: 구버전 회사 shim이 설치된 동일 사용자 계정에서 개인 서버 installer를 실행해 회사·개인 target을 함께 전송하고, 서버별 제거와 마지막 전체 제거를 수행한다.

## 완료 기준 추적표

| # | 설계 완료 기준 | 구현 증거 | 직접 테스트·감사 증거 | 판정 |
|---|---|---|---|---|
| 1 | shim·daemon 하나가 임의 개수 target 처리 | `TargetStore::load_or_migrate`, `collect::run_with`의 target loop | `capabilities_and_target_list_are_machine_safe`, Unix lifecycle의 2-target fixture; registry가 `Vec<Target>` loop라 개수 하드코딩 없음 | 충족 |
| 2 | 회사·개인에 usage/tool/content 각각 전송 | target별 usage/tool/content cursor와 injectable transport | `.github/scripts/test-shim-installer-unix.sh`가 두 prefix의 events/prompts/tool-events/inventory capture를 검증 | 충족 |
| 3 | token·정책·cursor·since·probe·최근 상태 격리 | `targets/<id>/credentials`, `state/cursors`, `unsupported-*`, `delivery.json` | cursor/fanout/inventory/probe/delivery 단위 테스트와 Unix target별 state assertion | 충족 |
| 4 | 회사 실패가 개인 전송을 막지 않음 | target별 `TargetRunResult`와 독립 commit | `failed_target_does_not_block_or_advance_successful_target`, Unix 회사-only 503 단계 | 충족 |
| 5 | 회사 복구 시 회사 누락분만 재전송 | target별 sent/hash cursor와 서버 dedup | 같은 단위 테스트의 2회차 recovery assertion, Unix 복구 후 target별 cursor/capture 검증 | 충족 |
| 6 | 구버전 회사 credentials·cursor 보존 | locked legacy importer, copy-missing, backup | `migrates_legacy_target_state_before_loading_registry`, `reimport_updates_credentials_without_overwriting_existing_cursor`, Unix legacy fixture | 충족 |
| 7 | 신규 installer가 기존 target 보존·자기 endpoint upsert | POSIX/PowerShell capability→target upsert 순서 | shell/PowerShell installer 생성 테스트, Unix 개인 install 후 target 2개 assertion | 충족 |
| 8 | 같은 endpoint 재설치가 중복·cursor reset 방지 | normalized endpoint SHA-256 ID, state-preserving upsert | `upsert_updates_one_target_without_resetting_state`, `same_endpoint_updates_credentials_without_deleting_state`, Unix 개인 installer 2회 실행 | 충족 |
| 9 | 서버별 uninstaller가 자기 target만 제거 | endpoint-bound dynamic uninstall route와 machine remove | POSIX/PowerShell uninstaller 계약 테스트, Unix 개인 제거 후 회사 target·shim 유지 | 충족 |
| 10 | 마지막 target만 전체 shim 정리 | `cleanup-pending` receipt와 remaining=0 승격 | `machine_remove_is_idempotent_and_reports_remaining_targets`, receipt failure/orphan tests, Unix 마지막 회사 제거 | 충족 |
| 11 | 없는 target 제거가 전체 정리를 유발하지 않음 | `removed=false` machine contract | remove 단위·CLI 테스트, Unix missing endpoint 제거 후 회사 target·shim 유지 | 충족 |
| 12 | 구·신버전 서버 wire 계약 유지 | 기존 `/v1/events`, `/v1/prompts`, `/v1/tool-events`, `/v1/tool-inventory`, `/v1/events/reconcile` payload 경로 유지 | 비교 범위에 ingest API route/schema 변경 없음; 전체 web ingest contract tests 통과 | 충족 |
| 13 | token·본문이 인자·진단·지속 오류 상태에 미노출 | env-only token 입력, curl auth config/body 0600 temp, hashed error fingerprint | CLI secret-free list, curl argument redaction, delivery fingerprint 테스트, Unix capture가 token/body plaintext 부재 검증 | 충족 |
| 14 | 필수 단위·통합·스크립트 검증 통과 | CI workflow와 local commands | 아래 검증 실행표. Windows 네이티브 lifecycle은 push 후 `windows-latest` pre-merge gate | 로컬 충족·Windows CI 대기 |

## 상세 리뷰에서 추가로 증명한 안전 조건

| 조건 | 증거 |
|---|---|
| 등록과 첫 collect 사이 tool/content event 유실·등록 전 전송 방지 | 밀리초 `content-since`/`tool-since`, `enable_cutoffs_preserve_millisecond_precision`, `first_collect_sends_tools_created_after_target_registration` |
| malformed legacy가 정상 registry 운영을 막지 않음 | `invalid_legacy_credentials_do_not_block_valid_registry_targets` |
| 유효한 legacy migration I/O 실패를 무시하지 않음 | `valid_legacy_io_failure_still_blocks_new_target_upsert` |
| legacy installer가 활성 E2EE를 plaintext/server mode로 강등하지 않음 | `reimport_preserves_unmentioned_policy_and_e2ee_metadata` |
| E2EE setup 중 remove/re-add·token 갱신 ABA 차단 | 매 upsert revision, `locked_e2ee_activation_rejects_updated_or_recreated_target`, legacy fallback remote activation preflight |
| collect 중 같은 endpoint 교체 시 이전 token 결과 commit 차단 | `target_still_exists` revision 비교, `replaced_same_endpoint_target_never_commits_the_old_delivery_cursor` |
| 마지막 target receipt 실패·orphan 오판 방지 | `last_target_is_not_deleted_when_cleanup_receipt_cannot_be_written`, `orphan_directory_never_counts_as_the_last_registered_target` |
| 제거 후 후속 정리 실패 재시도 | POSIX/PowerShell 모두 shim과 receipt를 마지막까지 유지하고 삭제 실패를 성공으로 숨기지 않는 생성 테스트 |
| Disabled/Unsupported/실패 관측 정확성 | `disabled_content_keeps_cursor_and_records_disabled_delivery`, `unsupported_tool_inventory_remains_observable_until_a_probe_succeeds`, `real_failure_overrides_degraded_delivery_kind` |
| daemon 로그 제한과 수동 진단 가시성 동시 보장 | delivery rate-limit tests, `manual_collect_always_emits_the_current_failure`, selected doctor HTTP 500 integration test |

## 검증 실행표

| Gate | 2026-07-18 최종 실행 결과 |
|---|---|
| Rust fmt/test/clippy/release build | exit 0. unit 181 + doctor 1 + CLI integration 6 = 188 passed, 성능 benchmark 1 ignored, warning 0, release build 성공 |
| Web 전체 test | 453개 중 451 passed, 환경 의존 2 skipped, 0 failed |
| Workspace typecheck | 7개 대상 workspace 모두 exit 0 |
| POSIX syntax·Unix lifecycle E2E | shell/Node syntax exit 0, `multi-target Unix installer lifecycle E2E passed` 확인 |
| Singleton/secret audit | legacy importer·호환 fallback·test fixture hit만 확인; production installer 직접 credentials write 0건 |
| Branch/diff audit | 의도한 multi-target 관련 파일만 변경, `git diff --check` 통과, 생성 artifact 없음 |
| Windows native | `.github/workflows/shim-ci.yml`의 `windows-latest`가 PowerShell parse, Rust tests/build, ACL·scheduled-task lifecycle을 실행; 로컬 macOS에서는 `pwsh` 부재로 미실행 |

## 결론

설계·구현 계획·코드·로컬 검증 증거는 사용자 시나리오와 완료 기준에 일치한다. 로컬 구현 완료와 별개로, Windows 네이티브 lifecycle은 브랜치를 push한 뒤 GitHub Actions가 통과해야 merge/release 가능 상태로 판정한다.
