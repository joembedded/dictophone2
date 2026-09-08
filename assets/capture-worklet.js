import { CaptureBuffer } from './audio-core.js';

class MicrophoneCapture extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.capture = new CaptureBuffer({ sampleRate, ...options.processorOptions });
        this.done = false;
        this.tick = 0;
        this.port.onmessage = ({ data }) => {
            if (data?.type === 'threshold' && Number.isFinite(data.value) && data.value >= 0.005 && data.value <= 0.15) this.capture.threshold = data.value;
            if (data === 'finish' && !this.done) this.finish();
            if (data === 'discard') { this.done = true; this.capture.clear(); }
        };
    }
    finish() {
        this.done = true;
        const pcm = this.capture.finish();
        this.port.postMessage({ type: 'finished', pcm }, [pcm.buffer]);
    }
    process(inputs) {
        if (this.done) return false;
        const input = inputs[0]?.[0];
        if (input) {
            const state = this.capture.push(input);
            if (state.started || (this.tick++ % 4 === 0)) this.port.postMessage({ type: 'level', ...state });
            if (state.limited) {
                this.port.postMessage({ type: 'limit' });
                this.finish();
                return false;
            }
        }
        // Der Ausgang bleibt stumm: keine Rückkopplung zum Lautsprecher.
        return true;
    }
}
registerProcessor('microphone-capture', MicrophoneCapture);
