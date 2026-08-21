# Contributing

Contributions in English or Korean are equally welcome. Maintainers may add a short translation or summary when it helps other contributors follow the discussion.

By submitting a contribution, you agree that it is provided under the repository's [MIT License](LICENSE). AI-assisted contributions are welcome, but the contributor remains responsible for correctness, tests, licensing, and removing credentials or private data from prompts, logs, fixtures, and screenshots.

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md) in every project space. For usage questions and troubleshooting, see [SUPPORT.md](SUPPORT.md). Report security vulnerabilities privately through [SECURITY.md](SECURITY.md), never through a public issue or pull request.

## Where to start

- Ask usage and deployment questions in [GitHub Discussions Q&A](https://github.com/devy1540/toard/discussions/categories/q-a).
- Use the bug form for a reproducible defect and the feature form for a scoped proposal.
- Small fixes such as typos, tests, and documentation updates can be submitted directly as pull requests.
- Discuss behavior, data model, authentication, privacy, encryption, retention, or deployment-contract changes before implementing them.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design context. Changes to the data model in section 4 or the ingestion contract in section 5 are expensive to reverse and require an ADR update. The `UsageEvent` contract is mirrored in TypeScript (`packages/core`) and Rust (`shim`); update both sides together.

## Contribution workflow

External contributors should:

1. Fork this repository.
2. Create a working branch in the fork.
3. Commit and push the change.
4. Open a pull request against this repository's `main` branch.

Repository collaborators may create a working branch here instead. No one should push directly to `main`.

## Development environment

Use Node.js 22.13 or later, pnpm 11.15.1 (as pinned in `package.json`), and Docker.

```bash
pnpm install
cp .env.example .env          # Replace AUTH_SECRET; leave BOOTSTRAP_ADMIN_* empty for browser setup
pnpm db:up                    # Start local PostgreSQL and ClickHouse
pnpm migrate
pnpm seed                     # Seed provider and pricing baselines
pnpm dev                      # http://localhost:3000
```

Create the first administrator at `http://localhost:3000/setup`. For headless provisioning, set both `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` before running `pnpm seed`.

## Verification

Run the checks relevant to the change and list only commands that actually passed in the pull request.

```bash
pnpm verify:release-version
pnpm test:release-version
pnpm typecheck
pnpm build
pnpm -r test                  # Unit and contract tests without Docker integration
pnpm test                     # Full suite; requires Docker for migration and security tests
```

For Rust shim changes, also run:

```bash
cargo fmt --manifest-path shim/rust/Cargo.toml --check
cargo clippy --manifest-path shim/rust/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path shim/rust/Cargo.toml
```

For Kubernetes or Helm changes, run the relevant manifest and chart checks documented in [docs/DEPLOY.md](docs/DEPLOY.md).

## Commit and pull request conventions

- Use Conventional Commits: `<type>(<scope>): <subject>`.
- Allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`.
- Keep the subject concise and do not end it with a period.
- Complete the three pull request sections: **목적**, **내용(의도 포함)**, and **성공기준**.
- Keep pull requests focused. Separate unrelated refactors or generated changes.
- Do not include tokens, credentials, private prompts, customer data, or unsanitized logs in commits, issues, or CI output.
