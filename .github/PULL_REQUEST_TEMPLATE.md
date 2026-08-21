## 목적

<!-- 이 PR 이 왜 필요한가 -->

## 내용(의도 포함)

<!-- 무엇을 어떻게 바꿨고, 왜 그 방식인가 -->

## 성공기준

<!-- 실제로 실행한 검증만 체크하세요 -->
- [ ] `pnpm verify:release-version`
- [ ] `pnpm test:release-version`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] (shim 변경 시) `cargo fmt --manifest-path shim/rust/Cargo.toml --check`
- [ ] (shim 변경 시) `cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings`
- [ ] (shim 변경 시) `cargo test --manifest-path shim/rust/Cargo.toml`
