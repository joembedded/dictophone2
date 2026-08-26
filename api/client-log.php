<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Nur POST ist erlaubt.'], 405);
}
if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 8192) {
    jsonResponse(['success' => false, 'error' => 'Logmeldung ist zu groß.'], 413);
}

$payload = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($payload)) {
    jsonResponse(['success' => false, 'error' => 'Ungültige Logmeldung.'], 400);
}

$allowedEvents = [
    'javascript_error', 'unhandled_rejection', 'api_error', 'response_parse_error',
    'microphone_error', 'recording_error', 'playback_error', 'clipboard_error', 'share_error',
];
$event = preg_replace('/[^a-z0-9_-]/', '', strtolower((string)($payload['event'] ?? '')));
if (!in_array($event, $allowedEvents, true)) {
    jsonResponse(['success' => false, 'error' => 'Unbekannter Logereignistyp.'], 400);
}

$source = (string)($payload['source'] ?? '');
$sourcePath = $source !== '' ? (string)(parse_url($source, PHP_URL_PATH) ?: '') : '';
appLog('error', 'client_' . $event, [
    'message' => mb_substr((string)($payload['message'] ?? ''), 0, 500),
    'source' => mb_substr($sourcePath, 0, 250),
    'line' => max(0, (int)($payload['line'] ?? 0)),
    'column' => max(0, (int)($payload['column'] ?? 0)),
    'http_status' => max(0, (int)($payload['httpStatus'] ?? 0)),
    'server_diagnostic_id' => mb_substr(preg_replace('/[^a-f0-9]/i', '', (string)($payload['diagnosticId'] ?? '')) ?? '', 0, 32),
    'user_agent' => mb_substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 350),
]);

jsonResponse(['success' => true], 202);
