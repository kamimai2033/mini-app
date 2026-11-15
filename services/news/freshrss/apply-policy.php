<?php
declare(strict_types=1);

// Reviewed against FreshRSS 1.30.4. Fail the image build if upstream code changes.
function patch(string $file, string $from, string $to, int $expected = 1): void {
    $source = file_get_contents($file);
    if (!is_string($source) || substr_count($source, $from) !== $expected) {
        throw new RuntimeException('FreshRSS policy patch does not match: ' . $file);
    }
    file_put_contents($file, str_replace($from, $to, $source));
}
$base = '/var/www/FreshRSS/';
patch($base . 'config-user.default.php', "'keep_period' => 'P3M'", "'keep_period' => ''");
patch($base . 'config-user.default.php', "'keep_max' => 200", "'keep_max' => 0");
patch($base . 'config-user.default.php', "'ttl_default' => 3600", "'ttl_default' => 900");

// No automatic article removal, even if an administrator changes a per-feed
// archiving setting accidentally. A future retention feature must remove this
// explicit guard in a reviewed release; default remains OFF.
patch($base . 'app/Models/Feed.php', 'public function cleanOldEntries(): int|false {',
    "public function cleanOldEntries(): int|false {\n\t\treturn 0; // mini-app: automatic deletion is disabled.\n");

$gate = <<<'PHP'
        // mini-app feed policy: every redirect is checked before a connection.
        $newsUrl = parse_url($url);
        if (!is_array($newsUrl) || ($newsUrl['scheme'] ?? '') !== 'https' ||
            isset($newsUrl['user']) || isset($newsUrl['pass']) ||
            (isset($newsUrl['port']) && $newsUrl['port'] !== 443)) {
            return null;
        }
PHP;
patch($base . 'app/Utils/httpUtil.php',
    'public static function getCurlResolveInfo(string $url): array|null|false {',
    "public static function getCurlResolveInfo(string \$url): array|null|false {\n" . $gate);
patch($base . 'app/Utils/httpUtil.php', "'240.0.0.0/4',", "'224.0.0.0/4',\n\t\t'192.0.0.0/24',\n\t\t'198.18.0.0/15',\n\t\t'ff00::/8',\n\t\t'240.0.0.0/4',");

// Proxies bypass origin DNS checks. Disable them for this dedicated collector.
// Both FreshRSS HTTP and SimplePie receive TLS verification and a transfer cap.
$options = <<<'PHP'
        $curl_options[CURLOPT_PROXY] = '';
        $curl_options[CURLOPT_SSL_VERIFYHOST] = 2;
        $curl_options[CURLOPT_SSL_VERIFYPEER] = true;
        $curl_options[CURLOPT_MAXFILESIZE] = 2097152;
        $curl_options[CURLOPT_NOPROGRESS] = false;
        $curl_options[CURLOPT_XFERINFOFUNCTION] = static function ($curl, $total, $downloaded): int {
            return $downloaded > 2097152 ? 1 : 0;
        };
PHP;
patch($base . 'app/Utils/httpUtil.php', "\t\t\tcurl_setopt_array(\$ch, \$curl_options);",
    $options . "\n\t\t\tcurl_setopt_array(\$ch, \$curl_options);");
patch($base . 'app/Models/SimplePieFetch.php',
    "\t\tparent::__construct(\$url, \$timeout, \$redirects, \$headers, \$useragent, \$force_fsockopen, \$curl_options);",
    $options . <<<'PHP'

        parent::__construct($url, min(10, $timeout), min(4, max(0, $redirects)), $headers, $useragent, false, $curl_options);
        $newsBody = (string)$this->get_body_content();
        if (strlen($newsBody) > 2097152 || preg_match('/<!\s*(DOCTYPE|ENTITY)\b/i', str_replace("\0", '', $newsBody))) {
            $this->set_body_content('');
            $this->error = 'Feed rejected by XML policy';
            $this->success = false;
        }
PHP);
echo "FreshRSS 1.30.4 news policies applied.\n";
