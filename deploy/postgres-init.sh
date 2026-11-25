#!/bin/sh
set -eu
app_password="$(cat /run/secrets/db_password)"
psql -v ON_ERROR_STOP=1 --username postgres --dbname forma --set=app_password="$app_password" <<'SQL'
CREATE ROLE forma LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE forma TO forma;
GRANT USAGE, CREATE ON SCHEMA public TO forma;
SQL
