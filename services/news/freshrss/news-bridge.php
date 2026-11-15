<?php
declare(strict_types=1);

// Internal-only adapter. The proxy must never expose this endpoint to browsers.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function reply(int $status, array $body): never {
    http_response_code($status);
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
function failNews(int $status, string $code): never {
    reply($status, ['error' => ['code' => $code]]);
}
$secretFile = getenv('NEWS_BRIDGE_TOKEN_FILE') ?: '/run/secrets/bridge_token';
$secret = trim(@file_get_contents($secretFile) ?: '');
$provided = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if (strlen($secret) < 24 || !is_string($provided) || !hash_equals('Bearer ' . $secret, $provided)) {
    failNews(401, 'unauthorized');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    failNews(405, 'method_not_allowed');
}
$body = file_get_contents('php://input', false, null, 0, 8193);
if (!is_string($body) || strlen($body) > 8192) {
    failNews(413, 'request_too_large');
}
try {
    $request = json_decode($body, true, 16, JSON_THROW_ON_ERROR);
} catch (Throwable) {
    failNews(400, 'invalid_request');
}
if (!is_array($request)) {
    failNews(400, 'invalid_request');
}

require dirname(__DIR__, 2) . '/constants.php';
require LIB_PATH . '/lib_rss.php';
try {
    FreshRSS_Context::initSystem();
    Minz_Session::init('FreshRSS', true);
    $user = getenv('NEWS_FRESHRSS_USER') ?: 'news';
    if (!FreshRSS_user_Controller::checkUsername($user)) {
        failNews(503, 'configuration_error');
    }
    FreshRSS_Context::initUser($user);
    if (!FreshRSS_Context::hasUserConf()) {
        failNews(503, 'configuration_error');
    }
    Minz_Translate::init(FreshRSS_Context::userConf()->language);
    Minz_ExtensionManager::init();
    Minz_ExtensionManager::enableByList(FreshRSS_Context::userConf()->extensions_enabled, 'user');
    $dao = FreshRSS_Factory::createFeedDao();
    $action = $request['action'] ?? '';

    if ($action === 'status') {
        $feeds = [];
        foreach ($dao->listFeeds() as $feed) {
            $feeds['feed/' . $feed->id()] = [
                'enabled' => !$feed->mute(), 'last_success' => $feed->lastUpdate(),
                'last_error' => $feed->lastError(), 'error' => $feed->inError() ? 'fetch_failed' : null,
            ];
        }
        reply(200, ['feeds' => (object)$feeds]);
    }
    if ($action === 'pause' || $action === 'resume') {
        $id = $request['feed_id'] ?? '';
        if (!is_string($id) || !preg_match('#^feed/([1-9][0-9]{0,15})$#D', $id, $match)) {
            failNews(400, 'feed_not_found');
        }
        $feed = $dao->searchById((int)$match[1]);
        if ($feed === null) {
            failNews(404, 'feed_not_found');
        }
        $ttl = abs($feed->ttl(true)) ?: max(900, FreshRSS_Context::userConf()->ttl_default);
        if (!$dao->updateFeed($feed->id(), ['ttl' => $action === 'pause' ? -$ttl : $ttl])) {
            failNews(503, 'write_failed');
        }
        reply(200, ['feed_id' => $id, 'enabled' => $action === 'resume']);
    }
    if ($action === 'validate') {
        $url = $request['url'] ?? '';
        if (!is_string($url) || strlen($url) > 2048 || FreshRSS_http_Util::getCurlResolveInfo($url) === null) {
            failNews(422, 'unsafe_feed');
        }
        // Uses the same SSRF/DNS pinning/redirect policy as all FreshRSS fetches.
        $response = FreshRSS_http_Util::httpGet($url, null, 'xml', ['timeout' => 10]);
        if ($response['fail']) {
            failNews(422, 'invalid_feed');
        }
        $xml = $response['body'];
        if ($xml === '' || strlen($xml) > 2097152 || preg_match('/<!\s*(DOCTYPE|ENTITY)\b/i', str_replace("\0", '', $xml))) {
            failNews(422, 'invalid_feed');
        }
        libxml_use_internal_errors(true);
        $doc = new DOMDocument();
        if (!$doc->loadXML($xml, LIBXML_NONET) || !in_array($doc->documentElement?->localName, ['rss', 'RDF', 'feed'], true)) {
            failNews(422, 'invalid_feed');
        }
        reply(200, ['valid' => true, 'url' => $response['effective_url'] ?: $url]);
    }
    if ($action === 'refresh') {
        $lock = fopen(DATA_PATH . '/news-refresh.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
            failNews(409, 'refresh_busy');
        }
        // Reuse FreshRSS scheduling and per-feed locks: disabled feeds are untouched.
        $result = FreshRSS_feed_Controller::actualizeFeedsAndCommit(null, null, 10);
        $errors = 0;
        foreach ($dao->listFeeds() as $feed) {
            if (!$feed->mute() && $feed->inError()) {
                $errors++;
            }
        }
        flock($lock, LOCK_UN);
        fclose($lock);
        reply(200, ['updated_feeds' => $result[0], 'new_items' => $result[2], 'errors' => $errors]);
    }
    failNews(400, 'unknown_action');
} catch (Throwable) {
    // Do not leak PHP paths, user names, credentials, or fetched content.
    failNews(503, 'freshrss_unavailable');
}
