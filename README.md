# Forma

A small-business creative studio at **[useforma.site](https://useforma.site)**. It provides wallet-owned projects, AI-assisted generation, private downloads/previews and QUSDC escrow on QIE Mainnet. The build specification and artboards are in `build-pack/`. See [VERIFICATION.md](VERIFICATION.md) for verification coverage.

## Localhost

Requires Node 24+ and npm. Install with `npm ci`; configure the ignored `.env` from `.env.example`. Never publish keys or use `NEXT_PUBLIC_` for secrets.

```powershell
npm run local:test
# When the compiled build already exists:
npm run local:stack
```

One supervised command starts compiled Next on `http://127.0.0.1:3000`, previews on port 4317, generation, read-only chain recovery and the operator when explicitly authorized. Stopped services restart with backoff. Ctrl+C stops the stack. Do not start duplicate stacks or operators. Individual commands remain available: `start`, `worker`, `preview`, `chain:worker`, `operator:worker`. `npm run dev` is for code editing; use compiled Next for owner acceptance.

`LOCAL_ONLY=true` restricts HTTP and persistent SQLite to loopback. Public hosting requires PostgreSQL, durable private files, HTTPS and a separate HTTPS preview origin. [deploy/README.md](deploy/README.md) describes the separate container services and cutover. The web and preview processes receive neither the operator key nor the OpenAI key. Only generation receives the provider credential; only the operator receives the signing key.

No anonymous trial account, public fixture checkout or generated-content fallback is available. Test fixtures live only in `tests/helpers` and require the isolated test runner. Owner-created projects, uploads and real delivery files must be preserved.

## Payments and operator

The [source-verified mainnet escrow](contracts/DEPLOYMENT.md) charges 1 QUSDC per job. Customer funding enters escrow. Customer acceptance or the contract's review timeout releases to the fixed treasury; authorized refunds return to the recorded customer. There is no swap, upgrade, arbitrary withdrawal or destination override. A problem report does not pause the 48-hour on-chain review window.

The separate operator worker handles registration and delivery only under an explicitly approved policy: unique policy ID, aggregate gas allocation, per-transaction cap, expiration and permitted actions. It reserves gas for both registration and delivery before registration. Canonical receipts require three confirmations; signed transaction identity is persisted before broadcast, and ambiguous transactions are never blindly replaced. Customer transactions still require their own wallet confirmations. Refunds, transfers and acceptance are excluded from automatic registration/delivery authorization.

`npm run operator:plan -- ORDER_ID create|deliver|refund|release` prepares unsigned calldata. `npm run operator:reconcile -- ORDER_ID create|fund|deliver|settle TX_HASH` checks an existing receipt without sending a transaction. Admin UI access requires a signed-in wallet listed in `ADMIN_WALLETS`.

The app is deployed with all four services enabled, separate HTTPS previews, PostgreSQL and independent workers. The real funding → generation → delivery → customer acceptance flow was verified before cutover; migrated delivery checksums and spending ledgers were checked afterward. The historical localhost copy is stopped and its spending flags disabled. Confirmed funded orders can finish while new sales are paused. Unavailable workers, depleted capacity or expired authorization prevent new checkout.

## Generation and billing

Four bounded pipelines produce real files: responsive one-page website/ZIP; 14-second vertical MP4/poster/captions; flyer PNG/PDF and original price list; sourced review-draft report HTML/PDF/CSV. Trusted renderers preserve approved business facts; arbitrary generated code is not executed. No soundtrack, voiceover or stock-image purchase is included.

Set supported model IDs and conservative rates, then run `npm run openai:check` for an offline configuration check. Paid requests require explicit authorization and `ALLOW_PAID_API_CALLS=true`. An approved aggregate allocation uses `PROVIDER_BUDGET_ID` and `PROVIDER_TOTAL_BUDGET_USD`. The full per-job ceiling is reserved before funding and reused during generation. Ambiguous or rejected paid requests retain reservations; raising an existing saved budget is refused. These estimates are application limits, not a provider billing guarantee.

Raw responses are saved before validation. A worker restart can finish rendering a valid saved response without another paid request. Unknown provider outcomes require review before retrying. Reports disclose inference and evidence limitations; matching citations does not certify source freshness or business conclusions. Earlier authorized real-provider technical checks passed all four services; no independent content-quality certification is claimed.

## Verification

```powershell
npm run typecheck
npm test
npm run test:contracts
npm run build
# Against the running localhost stack; read-only:
npm run test:http
```

Tests use isolated databases, mocked provider/RPC traffic and a local Ganache EVM. They never use real provider credentials or mainnet signing. They cover four creative pipelines, ownership, quote expiry, worker recovery, capacity reservations, source validation, receipt reconciliation and adversarial token/reentrancy behavior. Ganache's native WebSocket fallback notice on Node 24 is harmless. Local EVM tests are not a security audit.

For a disposable local PostgreSQL database, configure private `FORMA_PG_TEST_ROOT_URL` and `FORMA_PG_TEST_APP_URL`, then run `scripts/test-postgres.ts` and `scripts/test-migration.ts` with `tsx`. They require loopback URLs, use isolated schemas and preserve owner data. Migration preserves both budget ledgers, saved responses and transaction identity; active sessions are intentionally invalidated at cutover. Always back up and stop source services before real migration.

## Architecture and dependencies

Next.js/React/TypeScript web/API → relational database → independent generation/operator/chain workers → trusted HTML/SVG/PDF/FFmpeg renderers → durable private files. Separate signed previews expire after five minutes and prohibit scripts, forms and arbitrary external resources. Cookie-authorized downloads verify ownership and checksums. Uploads are limited to decoded, normalized PNG/JPEG, with metadata removed.

Dependencies include Next.js, React, TypeScript, viem, Zod, pg, PDFKit, Sharp, Archiver, FFmpeg, OpenZeppelin and Lucide. Respect their licenses and customer asset rights. Original implementation includes the owned workspace, frozen briefs/terms, durable stages, manifests/checksums, receipt reconciliation, bounded operator, private previews and four creative pipelines. Supplied artboards/specification are user-provided references.


Dependency maintenance in this pass: updated [Sharp 0.35.5](https://github.com/lovell/sharp/releases/tag/v0.35.5) and [Archiver 8](https://github.com/archiverjs/node-archiver/releases/tag/8.0.0), following Archiver's named `ZipArchive` API. The directory matcher is pinned to its patched Node 20+ version. The production-only manifest audit reports zero advisories. Bundled Ganache development tools retain separate advisories; the runtime container was checked to contain no Ganache installation.
