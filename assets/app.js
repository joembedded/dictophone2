import { createRecordingController } from './recording.js';

const draft = document.querySelector('#draft');
const recordButton = document.querySelector('#record-button');
const formatButton = document.querySelector('#format-button');
const speakButton = document.querySelector('#speak-button');
const undoButton = document.querySelector('#undo-button');
const copyButton = document.querySelector('#copy-button');
const shareButton = document.querySelector('#share-button');
const clearButton = document.querySelector('#clear-button');
const infoButton = document.querySelector('#info-button');
const status = document.querySelector('#status');
const player = document.querySelector('#player');
const messageDialog = document.querySelector('#message-dialog');
const messageTitle = document.querySelector('#message-title');
const messageText = document.querySelector('#message-text');
const messageClose = document.querySelector('#message-close');
const confirmDialog = document.querySelector('#confirm-dialog');
const confirmCancel = document.querySelector('#confirm-cancel');
const confirmClear = document.querySelector('#confirm-clear');
const MAX_HISTORY = 80;
const APP_VERSION = '2.8.1 (08.09.2026)';
const history = [];

let busy = false;
let currentAudioUrl = null;
let lastTypingSnapshotAt = 0;
let clientLogInFlight = false;
let toastTimer = null;

const recording = createRecordingController({
    onAccept: (blob, { selectionStart, selectionEnd }) => { void processAudio(blob, selectionStart, selectionEnd); },
    onCancel: () => setStatus('Aufnahme verworfen'),
    onStateChange: syncControls,
    onError: error => {
        setStatus('Aufnahme fehlgeschlagen');
        void reportClientError('recording_error', error);
        const messages = {
            NotAllowedError: 'Der Mikrofonzugriff wurde abgelehnt. Bitte in den Browser-Einstellungen erlauben.',
            NotFoundError: 'Es wurde kein Mikrofon gefunden.',
            NotReadableError: 'Das Mikrofon wird bereits verwendet oder kann nicht gelesen werden.',
        };
        showMessage('Aufnahme fehlgeschlagen', messages[error.name] || error.message);
    },
});

class ApiError extends Error {
    constructor(message, httpStatus = 0, diagnosticId = '') {
        super(message);
        this.name = 'ApiError';
        this.httpStatus = httpStatus;
        this.diagnosticId = diagnosticId;
    }
}

function setStatus(message, duration = 1800) {
    clearTimeout(toastTimer);
    status.textContent = message;
    status.classList.toggle('is-visible', Boolean(message));
    if (message && duration > 0) {
        toastTimer = setTimeout(() => {
            status.classList.remove('is-visible');
            status.textContent = '';
        }, duration);
    }
}

function showMessage(title, message, { allowHtml = false } = {}) {
    messageTitle.textContent = title;
    if (allowHtml) {
        messageText.innerHTML = message;
    } else {
        messageText.textContent = message;
    }
    if (typeof messageDialog.showModal === 'function' && !messageDialog.open) {
        messageDialog.showModal();
    } else {
        window.alert(`${title}\n\n${messageText.textContent}`);
    }
}

function diagnosticSuffix(error) {
    return error?.diagnosticId ? `\n\nDiagnose-ID: ${error.diagnosticId}` : '';
}

function snapshot(force = false) {
    const state = {
        value: draft.value,
        selectionStart: draft.selectionStart,
        selectionEnd: draft.selectionEnd,
    };
    const previous = history.at(-1);
    if (!force && previous?.value === state.value && previous?.selectionStart === state.selectionStart && previous?.selectionEnd === state.selectionEnd) {
        return;
    }
    history.push(state);
    if (history.length > MAX_HISTORY) history.shift();
}

function restoreState(state) {
    draft.value = state.value;
    draft.focus();
    const start = Math.min(state.selectionStart, draft.value.length);
    const end = Math.min(state.selectionEnd, draft.value.length);
    draft.setSelectionRange(start, end);
}

function syncControls() {
    const capturing = recording.isActive;
    const speaking = !player.paused && !player.ended;
    recordButton.disabled = busy || capturing;
    [formatButton, undoButton, copyButton, shareButton, clearButton].forEach(button => {
        button.disabled = busy || capturing;
    });
    speakButton.disabled = (busy && !speaking) || capturing;
    speakButton.textContent = speaking ? '\u23F9\uFE0E' : '\u25B6';
    speakButton.title = speaking ? 'Vorlesen stoppen' : 'Entwurf vorlesen';
    speakButton.setAttribute('aria-label', speakButton.title);
}

function setBusy(next, message = 'Bitte warten …') {
    busy = next;
    syncControls();
    if (next) setStatus(message, 0);
}

function setDraftKeyboard(mode) {
    if (draft.inputMode === mode) return;
    draft.inputMode = mode;
    draft.blur();
    setTimeout(() => draft.focus(), 80);
}

function joinText(before, insertion, after) {
    let left = before;
    let middle = insertion.trim();
    let right = after;
    if (left && middle && !/\s$/.test(left) && !/^[,.;:!?)]/.test(middle)) left += ' ';
    if (middle && right && !/\s$/.test(middle) && !/^[,.;:!?)]/.test(right)) middle += ' ';
    return left + middle + right;
}

function applyOperation(result, selectionStart, selectionEnd) {
    snapshot(true);
    const text = result.text ?? '';
    const current = draft.value;
    let nextValue = current;
    let caret = selectionStart;

    switch (result.operation) {
        case 'replace_all':
            nextValue = text;
            caret = nextValue.length;
            break;
        case 'prepend':
            nextValue = joinText('', text, current);
            caret = text.trim().length;
            break;
        case 'append':
            nextValue = joinText(current, text, '');
            caret = nextValue.length;
            break;
        case 'replace_selection':
            nextValue = joinText(current.slice(0, selectionStart), text, current.slice(selectionEnd));
            caret = Math.min(nextValue.length, selectionStart + text.trim().length + (selectionStart > 0 ? 1 : 0));
            break;
        case 'insert_at_caret':
        default:
            nextValue = joinText(current.slice(0, selectionStart), text, current.slice(selectionEnd));
            caret = Math.min(nextValue.length, selectionStart + text.trim().length + (selectionStart > 0 && !/\s$/.test(current.slice(0, selectionStart)) ? 1 : 0));
            break;
    }

    draft.value = nextValue;
    draft.focus();
    draft.setSelectionRange(caret, caret);
}

async function reportClientError(event, error, metadata = {}) {
    if (clientLogInFlight) return;
    clientLogInFlight = true;
    try {
        await fetch('api/client-log.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                event,
                message: String(error?.message || error || 'Unbekannter Browserfehler').slice(0, 500),
                source: metadata.source || '',
                line: metadata.line || 0,
                column: metadata.column || 0,
                httpStatus: error?.httpStatus || metadata.httpStatus || 0,
                diagnosticId: error?.diagnosticId || metadata.diagnosticId || '',
            }),
            keepalive: true,
        });
    } catch {
        // Ein Fehler beim optionalen Client-Log darf keine weitere Fehlerschleife erzeugen.
    } finally {
        clientLogInFlight = false;
    }
}

async function apiRequest(path, data) {
    let response;
    try {
        response = await fetch(path, { method: 'POST', body: data });
    } catch (error) {
        await reportClientError('api_error', error);
        throw new ApiError(`Server nicht erreichbar: ${error.message}`);
    }

    const responseText = await response.text();
    let payload;
    try {
        payload = JSON.parse(responseText);
    } catch (error) {
        const parseError = new ApiError(`Ungültige Serverantwort (${response.status}).`, response.status, response.headers.get('X-Diagnostic-ID') || '');
        await reportClientError('response_parse_error', parseError);
        throw parseError;
    }
    if (!response.ok || !payload.success) {
        const apiError = new ApiError(payload.error || `Serverfehler (${response.status})`, response.status, payload.diagnosticId || response.headers.get('X-Diagnostic-ID') || '');
        await reportClientError('api_error', apiError);
        throw apiError;
    }
    return payload;
}

function appendDraftContext(data, selectionStart, selectionEnd) {
    data.append('draft', draft.value);
    data.append('selectionStart', String(selectionStart));
    data.append('selectionEnd', String(selectionEnd));
}

async function processAudio(blob, selectionStart, selectionEnd) {
    if (!blob.size) {
        const error = new Error('Die Aufnahme enthält keine Audiodaten.');
        await reportClientError('recording_error', error);
        showMessage('Aufnahme fehlgeschlagen', error.message);
        return;
    }

    const mime = blob.type.split(';', 1)[0].toLowerCase();
    const extension = { 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3' }[mime] || 'webm';
    const data = new FormData();
    data.append('mode', 'dictation');
    data.append('audio', blob, `diktat.${extension}`);
    appendDraftContext(data, selectionStart, selectionEnd);
    setBusy(true, 'Diktat wird erkannt und verarbeitet …');
    try {
        const result = await apiRequest('api/process.php', data);
        applyOperation(result, selectionStart, selectionEnd);
        console.log('Diktat verarbeitet:', result);
        const intentSummary = String(result.intentSummary || '').trim();
        const completionStatus = intentSummary
            ? `Diktat erkannt und verarbeitet\nFormatierung: ${intentSummary}`
            : 'Diktat erkannt und verarbeitet';
        setStatus(completionStatus);
    } catch (error) {
        setStatus('Diktat fehlgeschlagen');
        showMessage('Diktat konnte nicht verarbeitet werden', error.message + diagnosticSuffix(error));
    } finally {
        setBusy(false);
    }
}

function startRecording() {
    if (busy || recording.isActive) return;
    const insertion = { selectionStart: draft.selectionStart, selectionEnd: draft.selectionEnd };
    player.pause();
    draft.inputMode = 'none';
    draft.blur();
    setStatus('');
    void recording.start(insertion);
}

async function formatDraft() {
    const text = draft.value.trim();
    if (!text) {
        setStatus('Kein Entwurf vorhanden.');
        return;
    }

    const selectionStart = draft.selectionStart;
    const selectionEnd = draft.selectionEnd;
    const data = new FormData();
    data.append('mode', 'format');
    data.append('text', text);
    appendDraftContext(data, selectionStart, selectionEnd);
    setBusy(true, 'Entwurf wird aufbereitet …');
    try {
        const result = await apiRequest('api/process.php', data);
        console.log('Entwurf aufbereitet:', result);
        applyOperation(result, selectionStart, selectionEnd);
        setStatus('Entwurf aufbereitet');
    } catch (error) {
        setStatus('Aufbereitung fehlgeschlagen');
        showMessage('Entwurf konnte nicht aufbereitet werden', error.message + diagnosticSuffix(error));
    } finally {
        setBusy(false);
        draft.focus();
    }
}

async function speakDraft() {
    if (!player.paused) {
        player.pause();
        player.currentTime = 0;
        syncControls();
        setStatus('Vorlesen gestoppt');
        return;
    }
    const text = draft.value.trim();
    if (!text) {
        setStatus('Kein Text zum Vorlesen.');
        return;
    }

    const data = new FormData();
    data.append('text', text);
    setBusy(true, 'Entwurf wird zum Vorlesen vorbereitet …');
    try {
        const response = await fetch('api/speak.php', { method: 'POST', body: data });
        if (!response.ok || !response.headers.get('content-type')?.includes('audio')) {
            const payload = await response.json().catch(() => ({}));
            throw new ApiError(payload.error || 'Vorlesen fehlgeschlagen.', response.status, payload.diagnosticId || response.headers.get('X-Diagnostic-ID') || '');
        }
        if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
        currentAudioUrl = URL.createObjectURL(await response.blob());
        player.src = currentAudioUrl;
        player.onended = () => {
            URL.revokeObjectURL(currentAudioUrl);
            currentAudioUrl = null;
            syncControls();
            setStatus('');
        };
        await player.play();
        syncControls();
        if (player.paused) return;
        setStatus('Wird vorgelesen');
    } catch (error) {
        setStatus('Vorlesen fehlgeschlagen');
        await reportClientError('playback_error', error);
        showMessage('Vorlesen fehlgeschlagen', error.message + diagnosticSuffix(error));
    } finally {
        setBusy(false);
    }
}

async function copyDraft() {
    if (!draft.value) {
        setStatus('Kein Text zum Kopieren.');
        return;
    }
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(draft.value);
        } else {
            draft.select();
            if (!document.execCommand('copy')) throw new Error('Kopieren wurde vom Browser abgelehnt.');
        }
        setStatus('In die Zwischenablage kopiert');
    } catch (error) {
        await reportClientError('clipboard_error', error);
        showMessage('Kopieren fehlgeschlagen', error.message);
    }
}

async function shareDraft() {
    const text = draft.value.trim();
    if (!text) {
        setStatus('Kein Text zum Teilen.');
        return;
    }
    try {
        if (navigator.share) {
            await navigator.share({ title: 'Nachricht', text });
        } else {
            window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
        }
        setStatus('Nachricht geteilt');
    } catch (error) {
        if (error.name !== 'AbortError') {
            await reportClientError('share_error', error);
            showMessage('Teilen fehlgeschlagen', error.message);
        }
    }
}

recordButton.addEventListener('click', startRecording);
formatButton.addEventListener('click', formatDraft);
speakButton.addEventListener('click', speakDraft);
player.addEventListener('play', syncControls);
player.addEventListener('pause', syncControls);
copyButton.addEventListener('click', copyDraft);
shareButton.addEventListener('click', shareDraft);
undoButton.addEventListener('click', () => {
    const previous = history.pop();
    if (previous) restoreState(previous);
});
clearButton.addEventListener('click', () => {
    if (!draft.value) return;
    confirmDialog.showModal();
});
infoButton.addEventListener('click', () => {
    showMessage('DictoPhone AI', `Diktier-App mit KI-Aufbereitung

Aufnehmen öffnet einen Dialog mit Sprachschwelle, Audiovorlauf und leuchtender Pegelanzeige. „OK“ beendet die Aufnahme und transkribiert über die OpenAI API. „Abbruch“ oder Escape verwirft sie ohne Transkription. Sprechpausen sind möglich; nach 60 Sekunden wartet die Aufnahme auf deine Bestätigung. Korrigieren setzt auch gesprochene Anweisungen zu Sprache, Stil, Duzen/Siezen, Einfügen oder Anhängen um. Vorlesen erzeugt eine Sprachausgabe des Entwurfs.

Datenschutz: Audio und Nachrichtentext werden zur Verarbeitung an OpenAI übertragen. Das lokale Diagnose-Log speichert keine Audio-, Diktat- oder Nachrichteninhalte und keine API-Schlüssel.

(C) JoEmbedded<br>OpenSource: <a href="https://github.com/joembedded/dictophone2" target="_blank" rel="noopener noreferrer">https://github.com/joembedded/dictophone2</a>

Version: ${APP_VERSION}`, { allowHtml: true });
});
confirmCancel.addEventListener('click', () => {
    confirmDialog.close();
    draft.focus();
});
confirmClear.addEventListener('click', () => {
    snapshot(true);
    draft.value = '';
    confirmDialog.close();
    draft.focus();
    setStatus('Entwurf gelöscht');
});
messageClose.addEventListener('click', () => {
    messageDialog.close();
    draft.focus();
});
draft.addEventListener('beforeinput', event => {
    if (event.inputType.startsWith('history')) return;
    const now = Date.now();
    if (now - lastTypingSnapshotAt > 800) {
        snapshot();
        lastTypingSnapshotAt = now;
    }
});
draft.addEventListener('click', () => setDraftKeyboard('text'));
window.addEventListener('error', event => {
    reportClientError('javascript_error', event.error || event.message, {
        source: event.filename,
        line: event.lineno,
        column: event.colno,
    });
});
window.addEventListener('unhandledrejection', event => {
    reportClientError('unhandled_rejection', event.reason);
});
window.addEventListener('beforeunload', event => {
    if (draft.value.trim()) {
        event.preventDefault();
        event.returnValue = true;
        return;
    }
});
window.addEventListener('pagehide', () => {
    recording.cancel();
    if (currentAudioUrl) URL.revokeObjectURL(currentAudioUrl);
});

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(error => reportClientError('javascript_error', error));
}
draft.focus();
syncControls();
