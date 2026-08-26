<?php
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
date_default_timezone_set('Europe/Berlin');

const APP_LOG_MAX_BYTES = 100 * 1024;

$GLOBALS['app_request_started_at'] = microtime(true);
$GLOBALS['app_request_finished'] = false;
$GLOBALS['app_request_id'] = bin2hex(random_bytes(8));

header('X-Diagnostic-ID: ' . appRequestId());
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

function appRequestId(): string
{
    return (string)$GLOBALS['app_request_id'];
}

function logFilePath(): string
{
    return dirname(__DIR__) . '/logs/app.log';
}

function rotateLogs(string $logFile): void
{
    clearstatcache(true, $logFile);
    if (!is_file($logFile) || (int)filesize($logFile) <= APP_LOG_MAX_BYTES) {
        return;
    }

    $oldLogFile = $logFile . '.old';
    if (is_file($oldLogFile)) {
        @unlink($oldLogFile);
    }
    @rename($logFile, $oldLogFile);
}

function sanitizeLogContext(array $context): array
{
    $sensitiveKeys = [
        'authorization', 'api_key', 'apikey', 'secret', 'password', 'raw_text',
        'draft', 'input', 'prompt', 'content', 'transcript', 'audio', 'response_body',
    ];

    $clean = [];
    foreach ($context as $key => $value) {
        $normalizedKey = strtolower((string)$key);
        if (in_array($normalizedKey, $sensitiveKeys, true)) {
            $clean[$key] = '[REDACTED]';
            continue;
        }
        if (is_array($value)) {
            $clean[$key] = sanitizeLogContext($value);
        } elseif (is_string($value)) {
            $clean[$key] = mb_substr(preg_replace('/Bearer\s+\S+/i', 'Bearer [REDACTED]', $value) ?? $value, 0, 2000);
        } elseif (is_scalar($value) || $value === null) {
            $clean[$key] = $value;
        } else {
            $clean[$key] = get_debug_type($value);
        }
    }
    return $clean;
}

function appLog(string $level, string $event, array $context = []): void
{
    try {
        $logFile = logFilePath();
        $logDirectory = dirname($logFile);
        if (!is_dir($logDirectory) && !mkdir($logDirectory, 0755, true) && !is_dir($logDirectory)) {
            return;
        }

        rotateLogs($logFile);
        $entry = [
            'time' => date('c'),
            'level' => strtoupper($level),
            'request_id' => appRequestId(),
            'event' => $event,
            'context' => sanitizeLogContext($context),
        ];
        $line = json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
        if ($line !== false) {
            file_put_contents($logFile, $line . PHP_EOL, FILE_APPEND | LOCK_EX);
        }
    } catch (Throwable) {
        // Das Diagnoselog darf niemals den eigentlichen API-Endpunkt blockieren.
    }
}

function finishRequest(int $status, array $context = []): void
{
    if (($GLOBALS['app_request_finished'] ?? false) === true) {
        return;
    }
    $GLOBALS['app_request_finished'] = true;
    appLog($status >= 400 ? 'error' : 'info', 'request_finished', array_merge([
        'http_status' => $status,
        'duration_ms' => (int)round((microtime(true) - (float)$GLOBALS['app_request_started_at']) * 1000),
        'peak_memory_bytes' => memory_get_peak_usage(true),
    ], $context));
}

function jsonResponse(array $payload, int $status = 200): never
{
    if ($status >= 400) {
        $payload['diagnosticId'] = appRequestId();
        appLog('error', 'api_error_returned', [
            'http_status' => $status,
            'error' => (string)($payload['error'] ?? 'Unbekannter Fehler'),
        ]);
    }
    finishRequest($status, ['success' => (bool)($payload['success'] ?? false)]);
    http_response_code($status);
    header('Content-Type: application/json; charset=UTF-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function openAiKey(): string
{
    $keyFile = dirname(__DIR__) . '/secret/keys.inc.php';
    if (!is_file($keyFile)) {
        jsonResponse(['success' => false, 'error' => 'Lokale OpenAI-Keydatei secret/keys.inc.php nicht gefunden.'], 500);
    }
    require_once $keyFile;
    if (!defined('OPENAI_API_KEY') || (string)constant('OPENAI_API_KEY') === '') {
        jsonResponse(['success' => false, 'error' => 'OPENAI_API_KEY fehlt.'], 500);
    }
    return (string)constant('OPENAI_API_KEY');
}

function openAiEndpointName(string $url): string
{
    return (string)(parse_url($url, PHP_URL_PATH) ?: 'openai');
}

function openAiJson(string $url, array $payload, string $stage, array $metadata = [], int $timeout = 120): array
{
    $encodedPayload = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    if ($encodedPayload === false) {
        jsonResponse(['success' => false, 'error' => 'Die OpenAI-Anfrage konnte nicht serialisiert werden.'], 500);
    }

    $callId = appRequestId() . '-' . $stage;
    $openAiRequestId = '';
    $startedAt = microtime(true);
    appLog('info', 'openai_call_started', array_merge([
        'call_id' => $callId,
        'stage' => $stage,
        'endpoint' => openAiEndpointName($url),
        'model' => (string)($payload['model'] ?? ''),
        'payload_bytes' => strlen($encodedPayload),
        'timeout_seconds' => $timeout,
    ], $metadata));

    $curl = curl_init($url);
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . openAiKey(),
        ],
        CURLOPT_POSTFIELDS => $encodedPayload,
        CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_HEADERFUNCTION => static function ($curlHandle, string $header) use (&$openAiRequestId): int {
            if (stripos($header, 'x-request-id:') === 0) {
                $openAiRequestId = trim(substr($header, strlen('x-request-id:')));
            }
            return strlen($header);
        },
    ]);

    $response = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_HTTP_CODE);
    $curlError = curl_error($curl);
    $durationMs = (int)round((microtime(true) - $startedAt) * 1000);

    if ($response === false) {
        appLog('error', 'openai_call_failed', [
            'call_id' => $callId,
            'stage' => $stage,
            'endpoint' => openAiEndpointName($url),
            'http_status' => $status,
            'openai_request_id' => $openAiRequestId,
            'duration_ms' => $durationMs,
            'curl_error' => $curlError,
        ]);
        jsonResponse(['success' => false, 'error' => 'Netzwerkfehler beim OpenAI-Aufruf: ' . $curlError], 502);
    }

    $decoded = json_decode($response, true);
    if ($status < 200 || $status >= 300 || !is_array($decoded)) {
        $error = is_array($decoded) ? ($decoded['error'] ?? []) : [];
        appLog('error', 'openai_call_failed', [
            'call_id' => $callId,
            'stage' => $stage,
            'endpoint' => openAiEndpointName($url),
            'http_status' => $status,
            'openai_request_id' => $openAiRequestId,
            'duration_ms' => $durationMs,
            'response_bytes' => strlen($response),
            'error_type' => (string)($error['type'] ?? ''),
            'error_code' => (string)($error['code'] ?? ''),
            'error_message' => (string)($error['message'] ?? 'Keine gültige JSON-Antwort erhalten.'),
        ]);
        $message = is_array($error) ? (string)($error['message'] ?? '') : '';
        jsonResponse(['success' => false, 'error' => $message !== '' ? $message : 'OpenAI-Anfrage fehlgeschlagen.'], 502);
    }

    appLog('info', 'openai_call_completed', [
        'call_id' => $callId,
        'stage' => $stage,
        'endpoint' => openAiEndpointName($url),
        'http_status' => $status,
        'openai_request_id' => $openAiRequestId,
        'response_id' => (string)($decoded['id'] ?? ''),
        'response_status' => (string)($decoded['status'] ?? 'completed'),
        'model' => (string)($decoded['model'] ?? $payload['model'] ?? ''),
        'duration_ms' => $durationMs,
        'response_bytes' => strlen($response),
        'usage' => is_array($decoded['usage'] ?? null) ? $decoded['usage'] : [],
    ]);
    return $decoded;
}

function extractResponseText(array $response): string
{
    if (isset($response['output_text']) && is_string($response['output_text'])) {
        return trim($response['output_text']);
    }

    $texts = [];
    foreach (($response['output'] ?? []) as $item) {
        if (!is_array($item) || ($item['type'] ?? '') !== 'message') {
            continue;
        }
        foreach (($item['content'] ?? []) as $part) {
            if (!is_array($part)) {
                continue;
            }
            if (($part['type'] ?? '') === 'output_text' && is_string($part['text'] ?? null)) {
                $texts[] = $part['text'];
            } elseif (($part['type'] ?? '') === 'refusal') {
                appLog('warning', 'openai_refusal', ['reason' => (string)($part['refusal'] ?? 'Keine Begründung')]);
            }
        }
    }
    return trim(implode("\n", $texts));
}

set_exception_handler(static function (Throwable $error): never {
    appLog('critical', 'unhandled_exception', [
        'type' => get_class($error),
        'message' => $error->getMessage(),
        'file' => basename($error->getFile()),
        'line' => $error->getLine(),
    ]);
    jsonResponse(['success' => false, 'error' => 'Interner Serverfehler.'], 500);
});

register_shutdown_function(static function (): void {
    $error = error_get_last();
    if (is_array($error) && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        appLog('critical', 'php_fatal_error', [
            'message' => (string)$error['message'],
            'file' => basename((string)$error['file']),
            'line' => (int)$error['line'],
        ]);
        finishRequest(500, ['fatal' => true]);
    } elseif (($GLOBALS['app_request_finished'] ?? false) !== true) {
        finishRequest(http_response_code() ?: 200, ['implicit_shutdown' => true]);
    }
});

appLog('info', 'request_started', [
    'method' => (string)($_SERVER['REQUEST_METHOD'] ?? ''),
    'path' => (string)(parse_url((string)($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH) ?: ''),
    'content_type' => (string)($_SERVER['CONTENT_TYPE'] ?? ''),
    'content_length' => (int)($_SERVER['CONTENT_LENGTH'] ?? 0),
]);

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    finishRequest(204);
    http_response_code(204);
    exit;
}
