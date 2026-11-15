<?php
declare(strict_types=1);

// Mounted into the isolated CI container only, never copied to production images.
require '/var/www/FreshRSS/cli/_cli.php';
cliInitUser(getenv('NEWS_FRESHRSS_USER') ?: 'news');
function checkNews(bool $condition, string $message): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
}
foreach (['http://feeds.example.com/rss.xml', 'https://127.0.0.1/private',
    'https://[::1]/private', 'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/private', 'https://224.0.0.1/private',
    'https://freshrss/private', 'https://user:pass@feeds.example.com/rss.xml',
    'https://feeds.example.com:8443/rss.xml'] as $url) {
    checkNews(FreshRSS_http_Util::getCurlResolveInfo($url) === null, 'Origin policy allowed a prohibited URL');
}
$resolution = FreshRSS_http_Util::getCurlResolveInfo('https://feeds.example.com/rss.xml');
checkNews(is_array($resolution) && count($resolution) > 0 && str_starts_with($resolution[0], 'feeds.example.com:443:'),
    'DNS result was not pinned into CURLOPT_RESOLVE');
$valid = new FreshRSS_SimplePieFetch('https://feeds.example.com/rss.xml');
checkNews($valid->success && str_contains((string)$valid->get_body_content(), 'news-fixture-1'), 'Valid RSS failed direct SimplePie fetch');
foreach (['doctype.xml', 'redirect-private', 'redirect-http'] as $path) {
    $file = new FreshRSS_SimplePieFetch('https://feeds.example.com/' . $path);
    checkNews(!$file->success || (string)$file->get_body_content() === '', 'Direct collector policy failed for ' . $path);
}
checkNews(FreshRSS_Context::userConf()->ttl_default === 900, '15 minute TTL is not configured');
$archiving = FreshRSS_Context::userConf()->archiving;
checkNews(empty($archiving['keep_period']) && empty($archiving['keep_max']), 'Default retention is enabled');
$feed = new FreshRSS_Feed('https://feeds.example.com/rss.xml');
checkNews($feed->cleanOldEntries() === 0, 'Automatic deletion guard is missing');
echo "PASS: real FreshRSS direct collector DNS/HTTPS/DOCTYPE/retention policies\n";
