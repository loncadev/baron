# @lonca/baron-conformance

Baron adapter conformance suite and in-memory transports (test support).

Part of **[Baron](https://github.com/loncadev/baron)** — a platform-agnostic work-orchestration layer for AI coding agents:
one pane of glass (issues, scm, ci, deploy, notify) across providers, via MCP + CLI.

## Install

**Not published.** This package is `private: true`: it is a devDependency of the adapters and the
CLI, never a runtime dependency of anything shipped, so publishing it would add a package nobody
installs. Third parties conformance-testing their own adapter today do it from a checkout of this
repository.

Publishing it is a real option — it needs its entry points split (the pure in-memory transports
apart from the vitest-coupled suites), a `build`, `files` and `publishConfig`, and `private`
dropped. Worth doing when someone outside this repo actually writes an adapter; see RELEASING.md.

## Documentation

See the [Baron documentation](https://github.com/loncadev/baron#readme). Source: [`packages/conformance`](https://github.com/loncadev/baron/tree/main/packages/conformance).

## License

[Apache-2.0](./LICENSE) © Baron contributors.
