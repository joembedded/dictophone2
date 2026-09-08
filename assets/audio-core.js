// PCM-Aufnahme aus LKI-STT mit der bisherigen Dic2-Sprachschwelle.
export const SPEECH_RMS_THRESHOLD = 0.052;
export const MICROPHONE_INIT_MS = 300;
export const PRE_ROLL_MS = 400;
export const SAMPLE_RATE = 16000;

export function rms(samples) {
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
}

// Ein kontinuierlicher PCM-Strom vermeidet Containerlücken und abgeschnittene
// Wortanfänge. Vor der Schwelle bleiben nur die letzten 400 ms im Ringpuffer.
export class CaptureBuffer {
    constructor({ sampleRate = SAMPLE_RATE, threshold = SPEECH_RMS_THRESHOLD, maxSamples = 16000 * 1000 } = {}) {
        this.rate = sampleRate;
        this.threshold = threshold;
        this.maxSamples = maxSamples;
        this.ring = new Float32Array(Math.round(sampleRate * PRE_ROLL_MS / 1000));
        this.position = 0;
        this.buffered = 0;
        this.elapsed = 0;
        this.recording = false;
        this.chunks = [];
        this.samples = 0;
        this.limited = false;
    }
    push(input) {
        const level = rms(input);
        this.elapsed += input.length;
        let started = false;
        if (!this.recording && this.elapsed >= this.rate * MICROPHONE_INIT_MS / 1000 && level > this.threshold) {
            this.recording = started = true;
            const pre = new Float32Array(this.buffered);
            const first = (this.position - this.buffered + this.ring.length) % this.ring.length;
            for (let i = 0; i < pre.length; i++) pre[i] = this.ring[(first + i) % this.ring.length];
            this.chunks.push(pre);
            this.samples = pre.length;
        }
        if (this.recording) {
            const keep = Math.min(input.length, this.maxSamples - this.samples);
            if (keep > 0) { this.chunks.push(input.slice(0, keep)); this.samples += keep; }
            this.limited = this.samples >= this.maxSamples;
        } else {
            for (const sample of input) {
                this.ring[this.position] = sample;
                this.position = (this.position + 1) % this.ring.length;
            }
            this.buffered = Math.min(this.ring.length, this.buffered + input.length);
        }
        return { level, started, recording: this.recording, samples: this.samples, limited: this.limited };
    }
    finish() {
        const pcm = new Float32Array(this.samples);
        let offset = 0;
        for (const chunk of this.chunks) { pcm.set(chunk, offset); offset += chunk.length; }
        this.clear();
        return pcm;
    }
    clear() { this.chunks = []; this.samples = 0; this.ring.fill(0); this.buffered = 0; }
}

export function encodeWav(pcm, sampleRate = SAMPLE_RATE) {
    const buffer = new ArrayBuffer(44 + pcm.length * 2);
    const view = new DataView(buffer);
    const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE');
    text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, pcm.length * 2, true);
    pcm.forEach((sample, i) => { const x = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, Math.round(x * (x < 0 ? 32768 : 32767)), true); });
    return buffer;
}
