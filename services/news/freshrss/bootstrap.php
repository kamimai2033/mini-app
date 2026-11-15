<?php
declare(strict_types=1);

// Runs only inside the dedicated FreshRSS container. Existing users/data are kept.
$base = '/var/www/FreshRSS';
$user = getenv('NEWS_FRESHRSS_USER') ?: 'news';
if (!preg_match('/^[a-zA-Z0-9_]{1,32}$/D', $user)) {
    throw new RuntimeException('Invalid NEWS_FRESHRSS_USER');
}
function credential(string $name, string $default): string {
    $value = trim(@file_get_contents(getenv($name) ?: $default) ?: '');
    if (strlen($value) < 24) {
        throw new RuntimeException('Missing or short credential file: ' . $name);
    }
    return $value;
}
function cliNews(array $args): void {
    $process = proc_open($args, [0 => ['file', '/dev/null', 'r'], 1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
    if (!is_resource($process) || proc_close($process) !== 0) {
        throw new RuntimeException('FreshRSS initialization failed; check the volume and configuration.');
    }
}
if (!file_exists($base . '/data/applied_migrations.txt')) {
    cliNews(['php', $base . '/cli/do-install.php', '--default-user', $user, '--db-type', 'sqlite', '--auth-type', 'form',
        '--api-enabled', '--base-url', getenv('FRESHRSS_PUBLIC_URL') ?: 'http://localhost:8088', '--language', 'ja']);
}
if (!is_file($base . '/data/users/' . $user . '/config.php')) {
    cliNews(['php', $base . '/cli/create-user.php', '--user', $user,
        '--password', credential('FRESHRSS_ADMIN_PASSWORD_FILE', '/run/secrets/admin_password'),
        '--api-password', credential('FRESHRSS_API_PASSWORD_FILE', '/run/secrets/freshrss_password'),
        '--language', 'ja', '--no-default-feeds', '--feed-ttl-default', '900']);
}
