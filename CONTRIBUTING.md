# Contributing to Baron

Thanks for your interest in Baron. This guide covers how to work in the repo and — importantly —
the terms your contributions are made under. Please read the [Contribution terms](#contribution-terms)
before opening your first pull request.

## Development

Baron is a pnpm-workspaces monorepo (TypeScript, NodeNext ESM, Node ≥ 20). Workspace packages resolve
to **source** in dev — no build step is needed to run tests or typecheck.

```bash
pnpm install
pnpm test          # vitest run (all packages)
pnpm typecheck     # tsc --noEmit per package
pnpm lint          # biome check
pnpm lint:fix      # biome check --write
pnpm licenses:check  # dependency-license hygiene gate
```

See [CLAUDE.md](./CLAUDE.md) for the working conventions and [ARCHITECTURE.md](./ARCHITECTURE.md) for
the foundational decisions (read it before proposing anything that touches a port or capability
contract). A change that widens the capability or port contract must extend the conformance suite in
the same change.

## Pull requests

- Keep the green gate green: `pnpm typecheck && pnpm lint && pnpm test && pnpm licenses:check` (CI runs
  all of these plus `pnpm build`).
- All code, identifiers, and committed artifacts are in **English**.
- Prefer focused commits with clear messages. Every commit must be **signed off** (see below).
- New dependencies are scrutinized: a copyleft / non-commercial / proprietary license will fail
  `licenses:check`. Prefer permissive (MIT / Apache-2.0 / BSD / ISC) dependencies.

## Contribution terms

Baron is **open-core** (see [ARCHITECTURE.md](./ARCHITECTURE.md) decisions #13 and #20): the OSS
packages are Apache-2.0, and separate commercial-tier features may ship under a different license in a
separate repository. To keep that model viable, contributions are accepted under the two terms below.

### 1. Developer Certificate of Origin (sign-off)

Every commit must carry a `Signed-off-by` line, added automatically with:

```bash
git commit -s -m "your message"
```

This certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/) — that
you wrote the contribution (or have the right to submit it) and may submit it under the project's
license. The full text:

```
Developer Certificate of Origin
Version 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I have the right to
    submit it under the open source license indicated in the file; or
(b) The contribution is based upon previous work that, to the best of my knowledge, is
    covered under an appropriate open source license and I have the right under that
    license to submit that work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am permitted to submit under a
    different license), as indicated in the file; or
(c) The contribution was provided directly to me by some other person who certified (a),
    (b) or (c) and I have not modified it.

(d) I understand and agree that this project and the contribution are public and that a
    record of the contribution (including all personal information I submit with it,
    including my sign-off) is maintained indefinitely and may be redistributed consistent
    with this project or the open source license(s) involved.
```

### 2. License and relicensing grant

The DCO certifies provenance but does not, by itself, let the project offer your contribution under
any license other than the inbound one. So, additionally: **by contributing to an OSS (Apache-2.0)
package in this repository, you license your contribution under the Apache License 2.0, and you grant
the project maintainer a perpetual, worldwide, non-exclusive, royalty-free, irrevocable right to
reproduce, distribute, and sublicense your contribution — including under different terms (such as a
commercial license) — as part of Baron or its commercial-tier offerings.**

This preserves Baron's ability to sustain the project through a commercial tier without having to
track down every contributor for consent later. It does **not** take away your rights: your
contribution remains available to you and to everyone else under Apache-2.0.

> **Note (pending formal review).** These terms are a lightweight, good-faith starting point so the
> project's licensing model stays intact from the first contribution. They are **not legal advice**
> and are expected to be replaced by a formally reviewed Contributor License Agreement (CLA) before
> the project accepts contributions at scale. If you contribute in the meantime, opening a PR is taken
> as agreement to the terms above as written.

Questions about these terms? Open a discussion or issue before contributing.
