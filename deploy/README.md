# Forma deployment

Forma is deployed at https://useforma.site with previews at https://preview.useforma.site. The VPS installation is `/opt/forma`, with private configuration under `/opt/forma/config`. STYX and Janus routes remain in the shared Caddy installation. Localhost workers are stopped after cutover; do not run a second live operator against the old SQLite snapshot.

The image supports AMD64 and ARM64 and includes FFmpeg and DejaVu fonts. Web, generation, operator, chain recovery and preview run as separate processes. Only the operator receives the signing key; only generation receives the OpenAI key. PostgreSQL uses a separate application role and private named volumes. Host ports bind to loopback for an HTTPS reverse proxy.

1. Choose an app HTTPS origin and a distinct preview HTTPS origin. Configure the owner wallet allowlist.
2. Run `npx tsx --env-file-if-exists=.env scripts/deployment-config.ts --app-url=https://YOUR_DOMAIN --preview-url=https://YOUR_PREVIEW_DOMAIN`. Private configuration is written into ignored `.forma/deploy`. Never commit, print or share it.
3. Review and transfer the image/configuration through the approved server access method. Keep configuration files readable only by the operator account. Adapt Caddy to the chosen origins without replacing STYX's routes.
4. Start only PostgreSQL with `docker compose -f deploy/compose.production.yml up -d db`.

On native Linux, Compose file-backed secrets retain host file permissions. Before first database initialization, make the two database password files readable by the container's `postgres` UID (obtain it from the pinned PostgreSQL image), with mode 0400 and a private host parent directory. Do not make generation/operator environment files readable by that UID. Verify that the `forma` role was created; database health alone does not prove role initialization completed.
5. Stop source web, generation, operator, chain and preview processes for cutover. Back up SQLite plus its WAL and all private files. Set `SOURCE_SQLITE_PATH` and the target `DATABASE_URL` in a private environment, then run `npx tsx scripts/migrate-sqlite-to-pg.ts --source-stopped`. The target must be empty. This preserves real projects, receipts, private file metadata and both spending ledgers; sessions/nonces are intentionally invalidated. Copy the existing `uploads` and `artifacts` into the target private data volume. Do not start both old and new operator processes.
6. Start web, generation, chain and preview. Confirm all health checks and authenticated private previews behind HTTPS. Check that the web container has no operator key or OpenAI credential.
7. Activate the operator profile only after an explicit, bounded gas policy is approved and configured in `operator.env`: policy ID, total QIE allocation, maximum fee per transaction, expiry, permitted `create,deliver` actions and optional exact order scope. `--profile operator up -d` starts it. It reserves delivery gas before registration and never automatically replaces an ambiguous signed transaction.
8. Verify the complete wallet payment → generation → delivery → acceptance/release path and failed-job/refund handling with authorized transactions. Only then enable public checkout flags in shared configuration. Customer wallet transactions always require customer confirmation.

Database and private-volume backups must be retained and restoration exercised before launch. Failed or ambiguous paid provider requests retain their budget reservations. An expired, on-chain-unfunded quote can release unused provider capacity. An exhausted/expired operator policy or stale worker heartbeat blocks new sales.

The deployed backup command is `/opt/forma/backup.sh` (root). `forma-backup.timer` runs it daily at approximately 02:00 UTC. Backups include PostgreSQL, private files, service configuration and proxy configuration; they are private and contain credentials. The initial production dump and file backup passed isolated restoration checks. These scheduled backups are on the VPS; keep additional off-server copies for host-loss recovery. The old SQLite snapshot is a cutover backup, not a current copy of future public orders.

Use `docker compose -f deploy/compose.production.yml config --quiet` to validate syntax without displaying secrets. Never paste plain `docker compose config` output into a chat or log.
