# Contributing

Contributions are welcome. English is the primary language for issues and pull requests, and Korean contributions are welcome as well.

## Contribution workflow

External contributors should propose changes through the following workflow:

1. Fork this repository.
2. Create a working branch in your fork.
3. Commit your changes and push the branch to your fork.
4. Open a pull request against the `main` branch of this repository.

Repository collaborators may create a working branch in this repository instead of using a fork. No one should push directly to `main`.

## Development environment

- Node.js 22.13 or later, pnpm 11 (as defined by `packageManager` in `package.json`), and Docker for local PostgreSQL

```bash
pnpm install
cp .env.example .env          # Fill in AUTH_SECRET and other required values
pnpm db:up                    # Start local PostgreSQL
pnpm migrate && pnpm seed
pnpm dev                      # http://localhost:3000
```

For the Rust shim, run `cargo build` and `cargo clippy` from `shim/rust`.

## Before you begin

- Small fixes such as typos and documentation updates can be submitted directly as pull requests. For changes that affect behavior or design, please open an issue for discussion first.
- See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design context. In particular:
  - Changes to the data model in section 4 or the ingestion contract in section 5 are expensive to reverse and require an ADR update.
  - The `UsageEvent` contract is mirrored in TypeScript (`packages/core`) and Rust (`shim`); update both sides together.

## Verification

Before opening a pull request, run the same checks used by CI:

```bash
pnpm typecheck     # All packages
pnpm test          # Unit tests
```

For shim changes, also run `cargo clippy --all-targets -- -D warnings`.

## Commit and pull request conventions

- Use **Conventional Commits**: `<type>(<scope>): <subject>`. Allowed types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, and `revert`. Do not end the subject with a period.
- Complete the three sections in the pull request template: **목적**, **내용(의도 포함)**, and **성공기준**. In the success criteria, list only checks that you actually ran.
- Report security vulnerabilities through the process in [SECURITY.md](SECURITY.md), not through a public issue or pull request.
