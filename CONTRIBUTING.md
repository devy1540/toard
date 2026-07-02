# 기여 가이드 (Contributing)

기여 환영합니다. 이슈·PR 은 **한국어가 1급**이지만 영어도 환영합니다 (Issues and PRs in English are welcome).

## 개발 환경

- Node.js ≥ 20, pnpm 9 (`package.json` 의 `packageManager` 기준), Docker (로컬 Postgres)

```bash
pnpm install
cp .env.example .env          # AUTH_SECRET 등 채우기
pnpm db:up                    # 로컬 Postgres
pnpm migrate && pnpm seed
pnpm dev                      # http://localhost:3000
```

shim(Rust) 은 `shim/rust` 에서 `cargo build` / `cargo clippy`.

## 시작하기 전에

- 작은 수정(오타·문서)은 바로 PR 주세요. **동작·설계가 바뀌는 변경은 이슈로 먼저 논의**하는 것을 권장합니다.
- 설계 배경은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 를 참고하세요. 특히:
  - §4 데이터 모델·§5 수집 계약은 되돌리기 비싼 영역 — 변경 시 ADR 갱신 필요
  - `UsageEvent` 계약은 TS(`packages/core`)와 shim(Rust) **양쪽 미러 — 동시 갱신**

## 검증

PR 전에 로컬에서 CI 와 동일한 검증을 돌려 주세요:

```bash
pnpm typecheck     # 전 패키지
pnpm test          # 단위 테스트
```

shim 변경 시: `cargo clippy --all-targets -- -D warnings`.

## 커밋 · PR 규칙

- **Conventional Commits**: `<type>(<scope>): <subject>` — type 은 feat·fix·docs·style·refactor·perf·test·build·ci·chore·revert. subject 끝에 마침표 금지.
- PR 본문은 템플릿의 세 섹션(**목적 / 내용(의도 포함) / 성공기준**)을 채워 주세요. 성공기준에는 실제로 실행한 검증만 적습니다.
- 보안 취약점은 PR/이슈가 아니라 [SECURITY.md](SECURITY.md) 절차로 신고해 주세요.
