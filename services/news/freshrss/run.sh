#!/bin/sh
set -eu
php /news/bootstrap.php
./cli/access-permissions.sh --only-userdirs
if [ -n "${CRON_MIN:-}" ]; then
    cron
fi
. /etc/apache2/envvars
exec apache2 -D FOREGROUND
