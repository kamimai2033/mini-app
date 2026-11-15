#!/bin/sh
set -eu
php /news/bootstrap.php
./cli/access-permissions.sh --only-userdirs
if [ -n "${CRON_MIN:-}" ]; then
    cron
fi
# Debian's envvars probes optional variables such as APACHE_CONFDIR.
# Match the upstream image's shell semantics while loading Apache defaults.
set +u
. /etc/apache2/envvars
exec apache2 -D FOREGROUND
