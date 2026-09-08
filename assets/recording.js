import { SPEECH_RMS_THRESHOLD, SAMPLE_RATE, encodeWav } from './audio-core.js';

// Aufnahmepfad aus LKI-STT: kontinuierliches PCM mit Sprachschwelle und Vorlauf.
export function createRecordingController({ onAccept, onCancel, onError, onStateChange, maxDurationSeconds = 60 }) {
    const $ = id => document.getElementById(id);
    const dialog = $('record-dialog');
    let session = null;
    let threshold = SPEECH_RMS_THRESHOLD;
    try {
        const saved = Number(localStorage.getItem('dic2-recording-threshold'));
        if (saved >= 0.005 && saved <= 0.15) threshold = saved;
    } catch { /* Browser-Speicher ist optional. */ }
    $('threshold').value = threshold;

    function setBadge(label, active = false) {
        $('capture-badge').textContent = label;
        $('capture-badge').classList.toggle('is-recording', active);
    }

    function meterPercent(level) {
        return level <= 0 ? 0 : Math.max(0, Math.min(100, (20 * Math.log10(level) + 60) / 60 * 100));
    }

    function updateThreshold() {
        threshold = Number($('threshold').value);
        $('threshold-value').textContent = `${threshold.toFixed(3).replace('.', ',')} RMS`;
        $('threshold-marker').style.left = `${meterPercent(threshold)}%`;
        if (session && !session.stopping) {
            session.threshold = threshold;
            session.worklet?.port.postMessage({ type: 'threshold', value: threshold });
        }
        try { localStorage.setItem('dic2-recording-threshold', String(threshold)); } catch { /* Optional. */ }
    }

    function stopAudio(s) {
        $('capture-badge').classList.remove('is-recording');
        clearTimeout(s.finishTimer);
        for (const track of s.stream?.getTracks() || []) { track.onended = null; track.stop(); }
        s.stream = null;
        if (s.worklet) {
            s.worklet.onprocessorerror = null;
            s.worklet.port.onmessage = null;
            s.worklet.port.postMessage('discard');
            s.worklet.port.close();
            s.worklet.disconnect();
        }
        s.source?.disconnect();
        if (s.context && s.context.state !== 'closed') void s.context.close().catch(() => {});
        s.worklet = s.source = s.context = null;
    }

    function resetMeter() {
        $('level-fill').style.width = '0%';
        $('level-meter').style.removeProperty('--signal-spread');
        $('level-meter').style.removeProperty('--signal-color');
        $('level-meter').setAttribute('aria-valuenow', '0');
        $('level-value').textContent = '−∞ dBFS';
    }

    function closeCapture(s) {
        session = null; // Verspätete Mikrofonfreigaben und Worklet-Nachrichten ignorieren.
        stopAudio(s);
        s.pcm = null;
        if (dialog.open) dialog.close();
        resetMeter();
        onStateChange();
    }

    function cancel() {
        if (!session) return;
        closeCapture(session);
        onCancel();
    }

    function fail(s, error) {
        if (session !== s) return;
        closeCapture(s);
        onError(error);
    }

    function commit(s) {
        // Ausschließlich eine explizite OK-Bestätigung darf Audio weitergeben.
        if (session !== s || !s.stopping) return;
        if (!s.pcm?.length) {
            fail(s, new Error('Die Aufnahme enthält keine Audiodaten. Bitte erneut aufnehmen.'));
            return;
        }
        try {
            const blob = new Blob([encodeWav(s.pcm)], { type: 'audio/wav' });
            closeCapture(s);
            onAccept(blob, s.insertion);
        } catch (error) { fail(s, error); }
    }

    function accept() {
        const s = session;
        if (!s || !s.recording || s.stopping) return;
        s.stopping = true;
        setBadge('BEENDET');
        $('record-accept').disabled = true;
        $('threshold').disabled = true;
        $('capture-status').textContent = 'Aufnahme wird übernommen …';
        if (s.pcm) { commit(s); return; }
        s.worklet.port.postMessage('finish');
        s.stream?.getTracks().forEach(track => { track.onended = null; track.stop(); });
        s.finishTimer = setTimeout(() => fail(s, new Error('Die Audioverarbeitung hat nicht geantwortet. Bitte erneut aufnehmen.')), 3000);
    }

    async function start(insertion) {
        if (session) return;
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !AudioContextClass || typeof window.AudioWorkletNode !== 'function') {
            onError(new Error('Audioaufnahme benötigt localhost oder HTTPS sowie einen Browser mit AudioWorklet-Unterstützung.'));
            return;
        }
        const s = { insertion, recording: false, stopping: false, smoothed: 0, lastLevelTime: performance.now(), threshold };
        session = s;
        onStateChange();
        $('record-accept').disabled = true;
        $('threshold').disabled = false;
        $('capture-time').textContent = '00:00.0';
        setBadge('STARTET');
        $('record-title').textContent = 'Sprechen zum Starten';
        $('capture-status').textContent = 'Mikrofon freigeben …';
        resetMeter();
        try {
            dialog.showModal();
            $('record-cancel').focus();
            // AudioContext direkt im Benutzerklick aktivieren, auch auf Mobilgeräten.
            s.context = new AudioContextClass({ sampleRate: SAMPLE_RATE });
            if (!s.context.audioWorklet) throw new Error('Dieser Browser unterstützt keine AudioWorklets.');
            await s.context.resume();
            if (session !== s) return;
            const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false } });
            if (session !== s) { stream.getTracks().forEach(track => track.stop()); return; }
            s.stream = stream;
            stream.getTracks().forEach(track => {
                track.onended = () => fail(s, new Error('Das Mikrofon wurde getrennt oder die Berechtigung entzogen. Die Aufnahme wurde verworfen.'));
            });
            await s.context.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
            if (session !== s) return;
            if (s.context.sampleRate !== SAMPLE_RATE) throw new Error('Der Browser stellt die benötigten 16000 Hz nicht bereit.');
            s.source = s.context.createMediaStreamSource(stream);
            s.worklet = new AudioWorkletNode(s.context, 'microphone-capture', {
                channelCount: 1, channelCountMode: 'explicit', numberOfInputs: 1, numberOfOutputs: 1,
                outputChannelCount: [1], processorOptions: { threshold: s.threshold, maxSamples: SAMPLE_RATE * maxDurationSeconds },
            });
            s.worklet.onprocessorerror = () => fail(s, new Error('Die Audioverarbeitung wurde unterbrochen. Bitte erneut aufnehmen.'));
            s.worklet.port.onmessage = ({ data }) => {
                if (session !== s) return;
                if (data.type === 'level') {
                    const now = performance.now();
                    s.smoothed = Math.max(data.level, s.smoothed * Math.pow(0.9, (now - s.lastLevelTime) / (1000 / 60)));
                    s.lastLevelTime = now;
                    const percent = meterPercent(s.smoothed);
                    $('level-fill').style.width = `${percent}%`;
                    $('level-meter').setAttribute('aria-valuenow', String(Math.round(percent)));
                    $('level-meter').style.setProperty('--signal-spread', `${Math.max(0, Math.min(42, (s.smoothed / s.threshold - 0.5) * 16))}px`);
                    $('level-meter').style.setProperty('--signal-color', s.smoothed >= s.threshold ? 'var(--green)' : 'var(--yellow)');
                    $('level-value').textContent = s.smoothed > 0.00001 ? `${(20 * Math.log10(s.smoothed)).toFixed(0)} dBFS` : '−∞ dBFS';
                    if (data.recording && !s.recording) {
                        s.recording = true;
                        $('record-accept').disabled = false;
                        setBadge('AUFNAHME', true);
                        $('record-title').textContent = 'Aufnahme läuft';
                        $('capture-status').textContent = 'Sprich weiter. Pausen sind möglich.';
                    }
                    // Ganze Zehntelsekunden vermeiden eine Anzeige von „00:60.0“.
                    const tenths = Math.floor(data.samples * 10 / SAMPLE_RATE);
                    $('capture-time').textContent = `${String(Math.floor(tenths / 600)).padStart(2, '0')}:${(tenths % 600 / 10).toFixed(1).padStart(4, '0')}`;
                }
                if (data.type === 'limit') s.limited = true;
                if (data.type === 'finished') {
                    s.pcm = data.pcm;
                    stopAudio(s);
                    resetMeter();
                    if (s.stopping) commit(s);
                    else if (s.limited) {
                        $('capture-time').textContent = `${String(Math.floor(maxDurationSeconds / 60)).padStart(2, '0')}:${(maxDurationSeconds % 60).toFixed(1).padStart(4, '0')}`;
                        $('capture-status').textContent = `${maxDurationSeconds} Sekunden erreicht · Mikrofon aus. Bitte OK oder Abbruch wählen.`;
                        setBadge('LIMIT ERREICHT');
                        $('record-accept').disabled = false;
                        $('threshold').disabled = true;
                    } else fail(s, new Error('Die Aufnahme wurde unerwartet beendet und verworfen.'));
                }
            };
            s.source.connect(s.worklet);
            s.worklet.connect(s.context.destination); // Worklet-Ausgang bleibt stumm.
            setBadge('WARTET');
            $('capture-status').textContent = 'Sprich los, um die Aufnahme zu starten.';
        } catch (error) { fail(s, error); }
    }

    updateThreshold();
    $('threshold').addEventListener('input', updateThreshold);
    $('record-cancel').addEventListener('click', cancel);
    $('record-accept').addEventListener('click', accept);
    dialog.addEventListener('cancel', event => { event.preventDefault(); cancel(); });
    dialog.addEventListener('close', () => { if (!dialog.open) cancel(); });

    return { start, cancel, get isActive() { return session !== null; } };
}
