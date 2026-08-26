// Einstellbare Parameter für die sprachgesteuerte Aufnahme.
export const SPEECH_RMS_THRESHOLD = 0.052;
export const SILENCE_STOP_MS = 2000;
export const SILENCE_THRESHOLD_RATIO = 0.5;
export const MICROPHONE_INIT_MS = 300;

export function computeRms(byteArray) {
    let sumSquares = 0;
    for (let index = 0; index < byteArray.length; index++) {
        const value = (byteArray[index] - 128) / 128;
        sumSquares += value * value;
    }
    return Math.sqrt(sumSquares / byteArray.length);
}

export function createVadState(startedAt = 0) {
    return {
        phase: 'initializing',
        startedAt,
        silenceStartedAt: null,
        speechDetected: false,
    };
}

export function updateVadState(state, rms, now) {
    const transition = {
        speechStarted: false,
        speechResumed: false,
        silenceStarted: false,
        shouldStop: false,
    };

    if (state.phase === 'initializing') {
        if (now - state.startedAt < MICROPHONE_INIT_MS) return transition;
        state.phase = 'waiting';
    }

    switch (state.phase) {
        case 'waiting':
            if (rms > SPEECH_RMS_THRESHOLD) {
                state.phase = 'speaking';
                state.speechDetected = true;
                transition.speechStarted = true;
            }
            break;

        case 'speaking':
            if (rms < SPEECH_RMS_THRESHOLD * SILENCE_THRESHOLD_RATIO) {
                state.phase = 'silence';
                state.silenceStartedAt = now;
                transition.silenceStarted = true;
            }
            break;

        case 'silence':
            if (rms > SPEECH_RMS_THRESHOLD) {
                state.phase = 'speaking';
                state.silenceStartedAt = null;
                transition.speechResumed = true;
            } else if (now - state.silenceStartedAt >= SILENCE_STOP_MS) {
                state.phase = 'finished';
                transition.shouldStop = true;
            }
            break;
    }

    return transition;
}
