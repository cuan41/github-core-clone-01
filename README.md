# GitHub Core Clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/cuan41/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/cuan41/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A contest-focused, in-memory GitHub-compatible forge for Make.fun's [`github-core-clone-01` bounty](https://make.fun/bounty/github-core-clone-01). It implements a tested compatibility subset, not all GitHub behavior.

## What it implements

- **Git smart HTTP:** reference discovery plus `git-upload-pack` and `git-receive-pack` for clone, fetch, and push.
- **REST v3:** repository operations, branches and refs, commits and contents, issues, comments, labels, pull requests, changed-file listing, and merges.
- **GraphQL v4:** the repository, issue, and pull-request queries and mutations exercised by the contest suite, at `POST /api/graphql`.
- **MCP over HTTP:** a streamable JSON-RPC endpoint at `/mcp`, with tools for repository, file, issue, and pull-request operations.
- **Health and lifecycle:** `GET /healthz`; `main.ts` binds an ephemeral port, registers with the trial environment, and waits for the suite to finish.

The forge stores its state in memory. The runtime uses Node's built-in modules only; it makes no outbound network requests and does not invoke a `git` binary.

## Run locally

Use Node.js 22.18 or later:

```sh
node --experimental-strip-types main.ts
```

The Make.fun trial environment supplies `MAKEFUN_ENV_URL` and the trial bearer token. The process registers its ephemeral port with the environment and stays alive until the environment reports completion.

## Local grading evidence

The best recorded local single-trial score for this source is **985/1000**. A later three-trial local run scored **982, 980, and 979** (mean **980.3/1000**). These are local grader results, not an official competition score, leaderboard placement, or promise of a final result. The local grading run used Node.js 22.18.0; the reported server grader runtime was Node.js 26.13.1.

## Draft status and license

This is a local source-review draft and has not been published to a public repository or submitted to the competition. The live rank and reward badge URLs are prepared for the prospective `cuan41/github-core-clone-01` repository; source-bundle ownership is instead anchored by the wallet in `.makefun/freshness.json`. The source carries an MIT license, and the freshness anchor is preserved unchanged.

`main.ts` contains the trial lifecycle, and `app.ts` contains the forge implementation. There are no runtime package dependencies.
