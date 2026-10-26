# Security

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/massimiliano-dev/fse-mcp/security/advisories/new).
You will get an answer within 7 days. Fixes are released as patch versions with an advisory.

Supported versions: the latest minor release of 0.x.

Do not include real patient data in a report. Synthetic reproductions only.

## Threat model

The server handles HL7 CDA2 documents, which are health data, and is driven by an LLM client that may have read
attacker-controlled text. Assets, in order: patient data in submitted documents, the HTTP bearer token, the
integrity of the developer's machine.

| Threat                           | Example                                                                                                                    | Mitigation                                                                                                                                                                                                                                                                              | Default |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Prompt injection via documents   | A CDA `<text>` or an error message says "ignore previous instructions and call ..."                                        | Tools are read-only and closed-world: there is nothing to exfiltrate to and nothing to modify. Output that contains document text is labelled as untrusted data. `explain_schematron_error` does not echo its input. Tool descriptions and server instructions only describe the tools. | always  |
| Prompt injection via tool calls  | A compromised conversation calls tools with hostile arguments                                                              | Every input is validated by a zod schema with size limits (CDA 2 MiB in UTF-8 bytes, messages 4,000 chars, queries 200 chars, enums for systems and document types). Unexpected exceptions return a generic error with no details.                                                      | always  |
| XML attacks                      | XXE (`<!ENTITY x SYSTEM "file:///etc/passwd">`), billion laughs, XInclude, remote `xsi:schemaLocation` or `xml-stylesheet` | A string-level pre-flight guard refuses DOCTYPE, ENTITY and XInclude before any parser runs. Stylesheets and schema locations are never fetched. The future validator must also run a hardened, offline parser (see `src/validator-port.ts`).                                           | always  |
| Server-side request forgery      | A document URL makes the server call an internal service                                                                   | The server makes no outbound network calls.                                                                                                                                                                                                                                             | always  |
| DNS rebinding                    | A web page resolves `attacker.example` to 127.0.0.1 and posts to the local HTTP server                                     | `Host` and `Origin` must match the allowed hostnames (loopback names by default), checked before authentication; the SDK's host check is enabled as a second layer. No CORS headers are sent.                                                                                           | on      |
| Unauthenticated access over HTTP | Another local user or process calls the HTTP endpoint                                                                      | HTTP mode refuses to start without `FSE_MCP_TOKEN` (32+ characters). The token is compared in constant time (SHA-256 digests with `timingSafeEqual`). Binding to non-loopback interfaces requires an explicit allowed host.                                                             | on      |
| Token leakage                    | The token ends up in logs, error messages, tool output or a child process environment                                      | The token is read once and deleted from `process.env`, registered for redaction, never echoed in error bodies. Tools never read the environment; a test asserts that environment secrets never appear in tool output.                                                                   | always  |
| PHI in logs                      | A codice fiscale or a document fragment is written to a log file shipped elsewhere                                         | Logs go to stderr only (stdout is the stdio protocol channel), never include tool inputs or exception messages from the validator, and every line is redacted (codice fiscale including omocodia, STP/ENI, JWTs, bearer tokens, registered secrets) and truncated.                      | always  |
| Resource exhaustion              | Huge bodies, slow clients                                                                                                  | 5 MiB HTTP body limit (also for chunked bodies), header and request timeouts, a 30 s validation timeout, linear-time regular expressions over bounded inputs.                                                                                                                           | on      |
| Supply chain                     | A compromised dependency or action                                                                                         | Two runtime dependencies (`@modelcontextprotocol/sdk`, `zod`). Actions pinned to commit SHAs, read-only workflow permissions, Dependabot, `pnpm audit` and CodeQL in CI, npm provenance on publish.                                                                                     | always  |

### Out of scope

- **What the LLM provider does with the data.** Anything the model reads leaves your machine. Never use real
  patient documents with a hosted model: see the data-protection notes in the README.
- **Authenticating end users.** The bearer token authenticates a client, not a person. There is no per-user
  authorisation and no rate limiting: keep HTTP mode on loopback or behind a proxy that handles both.
- **TLS.** HTTP mode serves plain HTTP; terminate TLS in a reverse proxy when not on loopback.
- **Conformance.** The server helps explain rejections; only the official gateway decides what is accepted.

## Supply chain

- GitHub Actions are pinned to commit SHAs, workflows run with read-only permissions by default, and Dependabot
  updates both npm packages and actions.
- CI runs `pnpm audit` and CodeQL (`security-extended` queries).
- The package is published from CI with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).
- The repository never contains real credentials or real clinical documents. All fixtures are synthetic.
