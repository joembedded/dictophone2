<?php
declare(strict_types=1);
require_once __DIR__ . '/bootstrap.php';

const TTS_MODEL = 'gpt-4o-mini-tts';

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    jsonResponse(['success' => false, 'error' => 'Nur POST ist erlaubt.'], 405);
}

$text = trim((string)($_POST['text'] ?? ''));
if ($text === '') {
    jsonResponse(['success' => false, 'error' => 'Kein Text zum Vorlesen.'], 400);
}
if (mb_strlen($text) > 8000) {
    jsonResponse(['success' => false, 'error' => 'Der Text ist zu lang zum Vorlesen.'], 400);
}

$payload = json_encode([
    'model' => TTS_MODEL,
    'voice' => 'fable',
    'input' => $text,
    'response_format' => 'mp3',
    'instructions' => 'Speak naturally in the language of the input text.',
], JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
if ($payload === false) {
    jsonResponse(['success' => false, 'error' => 'Der Vorleseauftrag konnte nicht serialisiert werden.'], 500);
}

$callId = appRequestId() . '-speech';
$openAiRequestId = '';
$startedAt = microtime(true);
appLog('info', 'openai_call_started', [
    'call_id' => $callId,
    'stage' => 'speech',
    'endpoint' => '/v1/audio/speech',
    'model' => TTS_MODEL,
    'input_chars' => mb_strlen($text),
    'payload_bytes' => strlen($payload),
    'timeout_seconds' => 120,
]);

$curl = curl_init('https://api.openai.com/v1/audio/speech');
curl_setopt_array($curl, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        'Content-Type: application/json',
        'Authorization: Bearer ' . openAiKey(),
    ],
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_CONNECTTIMEOUT => 15,
    CURLOPT_TIMEOUT => 120,
    CURLOPT_HEADERFUNCTION => static function ($curlHandle, string $header) use (&$openAiRequestId): int {
        if (stripos($header, 'x-request-id:') === 0) {
            $openAiRequestId = trim(substr($header, strlen('x-request-id:')));
        }
        return strlen($header);
    },
]);

$audio = curl_exec($curl);
$status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
$curlError = curl_error($curl);
$durationMs = (int)round((microtime(true) - $startedAt) * 1000);

if ($audio === false || $status < 200 || $status >= 300) {
    $decoded = is_string($audio) ? json_decode($audio, true) : null;
    $apiError = is_array($decoded) && is_array($decoded['error'] ?? null) ? $decoded['error'] : [];
    appLog('error', 'openai_call_failed', [
        'call_id' => $callId,
        'stage' => 'speech',
        'endpoint' => '/v1/audio/speech',
        'model' => TTS_MODEL,
        'http_status' => $status,
        'openai_request_id' => $openAiRequestId,
        'duration_ms' => $durationMs,
        'curl_error' => $curlError,
        'response_bytes' => is_string($audio) ? strlen($audio) : 0,
        'error_type' => (string)($apiError['type'] ?? ''),
        'error_code' => (string)($apiError['code'] ?? ''),
        'error_message' => (string)($apiError['message'] ?? 'Keine Audiodaten erhalten.'),
    ]);
    $message = (string)($apiError['message'] ?? ($curlError ?: 'Vorlesen fehlgeschlagen.'));
    jsonResponse(['success' => false, 'error' => $message], 502);
}

appLog('info', 'openai_call_completed', [
    'call_id' => $callId,
    'stage' => 'speech',
    'endpoint' => '/v1/audio/speech',
    'model' => TTS_MODEL,
    'http_status' => $status,
    'openai_request_id' => $openAiRequestId,
    'duration_ms' => $durationMs,
    'audio_bytes' => strlen($audio),
]);
finishRequest(200, ['success' => true, 'audio_bytes' => strlen($audio)]);

header('Content-Type: audio/mpeg');
header('Content-Length: ' . strlen($audio));
echo $audio;
