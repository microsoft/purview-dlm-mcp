# Contributing to Microsoft Purview DLM Diagnostics MCP

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Development Setup

1. Clone the repository:

   ```bash
   git clone https://github.com/microsoft/purview-dlm-mcp.git
   cd purview-dlm-mcp
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build:

   ```bash
   npm run build
   ```

## Running Tests

The test suite uses Vitest and includes unit tests (171 tests, no Exchange Online required), E2E tests (~30 tests), and TSG integration tests (~14 tests).

To run **unit tests only** (no Exchange Online connection needed):

```bash
npm test
```

To run the **full suite** (E2E + TSG tests require a live Exchange Online environment), set the following environment variables:

```bash
export DLM_UPN=admin@yourtenant.onmicrosoft.com
export DLM_ORGANIZATION=yourtenant.onmicrosoft.com
```

Then run:

```bash
npm run test:e2e
```

E2E and TSG tests use interactive MSAL authentication — a browser window will open for sign-in on first run.

## Pull Request Process

1. Fork the repository and create your branch from `main`.
2. Add copyright headers to any new `.ts` files:
   ```typescript
   // Copyright (c) Microsoft Corporation.
   // Licensed under the MIT License.
   ```
3. Ensure `npm run build` succeeds with no errors.
4. Ensure `npm run lint` passes.
5. Run the unit test suite and ensure all tests pass: `npm test`.
6. Update documentation if you add or change functionality.
7. Submit a pull request with a clear description of the changes.

## Branch Protection

The `main` branch is protected with the following rules:

- **Pull requests required** — All changes must go through a PR; direct commits to `main` are not allowed.
- **Review required** — At least one approving review is required before merging.
- **Stale review dismissal** — Approvals are dismissed when new commits are pushed.
- **Status checks required** — CI must pass (build, lint, test) before merging.
- **Up-to-date branches** — PRs must be up-to-date with `main` before merging.
- **No force pushes** — Force pushes to `main` are not allowed.

## Reporting Issues

Please use [GitHub Issues](https://github.com/microsoft/purview-dlm-mcp/issues) to report bugs or request features. For security vulnerabilities, see [SECURITY.md](SECURITY.md).
