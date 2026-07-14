# Recovery Kit 번호형 레이아웃 구현 계획

> **실행 방식:** 승인된 설계를 현재 linked worktree에서 TDD로 구현하고, 검증 후 PR 병합과 `v0.15.20` 태그 릴리스까지 한 흐름으로 진행한다.

**목표:** Recovery Kit 24개 단어를 화면과 저장 파일에서 동일한 두 자리 번호 체계로 표시해 순서 확인과 입력 대응을 쉽게 만든다.

**범위:** 로컬 Recovery Kit 확인 페이지의 HTML/CSS, Rust 렌더링, 다운로드 스크립트와 관련 테스트만 변경한다. 암호화·키 생성·확인 위치 선택·활성화 API 계약은 변경하지 않는다.

---

## 작업 1: 번호형 렌더링 계약을 테스트로 고정

**파일:**
- 수정: `shim/rust/src/e2ee_setup.rs`

1. 기존 `local_page_has_no_store_csp_and_does_not_put_words_in_action` 테스트에 다음 기대값을 추가한다.
   - `data-recovery-word` 항목이 정확히 24개다.
   - 첫 번호 `01`과 마지막 번호 `24`가 존재한다.
   - 확인 라벨은 `03번 단어`, `11번 단어`, `22번 단어`다.
   - 저장 스크립트가 두 자리 번호와 줄바꿈 형식을 생성한다.
2. 아래 명령으로 변경 전 실패를 확인한다.

```bash
cargo test --manifest-path shim/rust/Cargo.toml local_page_has_no_store_csp_and_does_not_put_words_in_action
```

## 작업 2: 반응형 번호형 목록과 저장 형식 구현

**파일:**
- 수정: `shim/rust/src/e2ee_setup_page.html`
- 수정: `shim/rust/src/e2ee_setup.rs`

1. 단어 영역을 의미 있는 순서 목록으로 바꾸고 데스크톱 4열, 모바일 2열 CSS Grid를 적용한다.
2. Rust 렌더러가 각 단어를 `01`~`24` 번호와 함께 독립 항목으로 escape해 출력하도록 한다.
3. 확인 입력 라벨을 같은 두 자리 번호 체계로 통일한다.
4. 저장 스크립트가 DOM의 단어를 순서대로 읽어 `01. 단어` 형식으로 한 줄씩 저장하도록 한다.
5. 작업 1의 단위 테스트가 통과하는지 확인한다.

```bash
cargo test --manifest-path shim/rust/Cargo.toml local_page_has_no_store_csp_and_does_not_put_words_in_action
```

## 작업 3: 전체 정적·동적 검증

1. 포맷, 린트, 전체 테스트, release 빌드와 diff 공백 검사를 실행한다.

```bash
cargo fmt --manifest-path shim/rust/Cargo.toml
cargo fmt --manifest-path shim/rust/Cargo.toml --check
cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path shim/rust/Cargo.toml
cargo build --manifest-path shim/rust/Cargo.toml --release
git diff --check
```

2. diff를 검토해 실제 Recovery Kit 단어, 비밀값, 암호화/API 범위 변경이 없는지 확인한다.

## 작업 4: 커밋·PR·병합

1. 구현과 테스트를 Conventional Commit으로 커밋한다.
2. 브랜치를 원격에 푸시하고 정해진 PR 본문 섹션으로 ready PR을 만든다.
3. PR의 필수 CI가 모두 성공한 것을 확인한 뒤 merge commit 방식으로 병합한다.
4. `origin/main`의 정확한 병합 커밋을 확인한다.

## 작업 5: `v0.15.20` 릴리스와 산출물 검증

1. 병합 커밋의 main CI가 성공한 뒤 그 커밋에 annotated tag `v0.15.20`을 만들고 푸시한다.
2. `shim-release`와 태그 기반 `docker-publish`가 성공할 때까지 확인한다.
3. GitHub Release의 shim 자산과 다음 세 Docker 이미지의 `linux/amd64`, `linux/arm64` manifest를 확인한다.
   - `ghcr.io/devy1540/toard:0.15.20`
   - `ghcr.io/devy1540/toard-migrate:0.15.20`
   - `ghcr.io/devy1540/toard-updater:0.15.20`
4. 릴리스 링크와 사용자가 실행할 업데이트·재설정 명령을 전달한다.
