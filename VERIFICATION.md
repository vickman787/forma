# Verification

Forma runs at https://useforma.site, with signed website previews on a separate HTTPS origin.

The automated suite exercises all four generation/render pipelines, ownership, validation, frozen quotes, durable recovery, spending reservations, canonical receipts, and escrow authority/timeouts. Provider and chain traffic in the test suite is isolated from paid APIs and mainnet. Local EVM tests include false-return and short-transfer tokens, reentrant callbacks and rollback on failed settlement.

Production verification includes an ARM64 container build, four keyless renderer checks (including website ZIP decompression and MP4 dimensions/duration), PostgreSQL migration with checksum preservation, database/private-file backup restoration, secure wallet sign-in, protected downloads, signed preview expiry/tampering, and worker credential separation. Actual mainnet funding, delivery and customer acceptance were verified before public cutover. No new paid order is implied by public smoke checks.

Public app code has no demo checkout, anonymous trial login or generated-content fallback. Test fixtures are excluded from the deployment image. AI-assisted output still needs customer review; contract source verification is not an independent audit.

Use `npm run typecheck`, `npm test`, and `npm run build` for local checks. See `deploy/README.md` for production storage and worker setup. Never commit private configuration, databases, delivery files or keys.
