# Contributing

Thanks for helping. Issues and pull requests are welcome.

1. `pnpm install`, then `pnpm test`.
2. Keep changes focused and covered by tests. Security-relevant behaviour (input limits, XML guard, HTTP
   authentication, redaction) needs a test that proves the attack is refused, like the ones in `test/http.test.ts`.
3. Add a changeset for any change to the published package: `pnpm changeset`.
4. **Synthetic data only.** Never commit real CDA documents, codici fiscali, tokens or certificates, not even in
   issues. Use `generate_sample_cda` output for fixtures. Report vulnerabilities privately, see
   [SECURITY.md](SECURITY.md).
5. Tool descriptions describe what the tool does. They must not instruct the model to do anything else.
6. The server must make no outbound network calls and must never write to stdout outside the MCP transport.

Code style is enforced by ESLint and Prettier (`pnpm lint`, `pnpm format`). Exported APIs need TSDoc comments.
