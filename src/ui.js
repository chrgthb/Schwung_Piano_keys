/*
 * Piano Keys - overtake module
 *
 * Turns Move's 4x8 pad grid into two octaves of piano keyboard:
 *   row 4 (top)   : black keys  C# D# -  F# G# A# -  C#
 *   row 3         : white keys  C  D  E  F  G  A  B  C   (octave B, one octave up)
 *   row 2         : black keys  C# D# -  F# G# A# -  C#
 *   row 1 (bottom): white keys  C  D  E  F  G  A  B  C   (octave A)
 * Unused positions (between E-F and B-C) stay dark.
 *
 * Notes are sent on one or more chosen MIDI channels (or the channel of the track
 * that was selected on Move when the module was started) to Move's own tracks
 * (cable-2 injection), to the USB-A port, or to both.
 *
 * Controls:
 *   Track buttons 1-4   channel 1-4 (only that channel)
 *   Left / Right        channel (Auto, 1..16) (only that channel)
 *   Step buttons 1-16   toggle channels 1-16 on/off; every active channel gets
 *                       notes, aftertouch and knob CCs. Active steps are lit.
 *   Up / Down           octave (lowest note shifts by 12)
 *   Jog turn            move the highlighted (inverted) label: Channel / From / Prg / Out / AT
 *   Jog click           toggle editing: the value of the highlighted label becomes active and
 *                       the jog changes it (From = lowest note, Prg = program change 0-127)
 *                       Out = output target, AT = pad pressure: Off / Poly AT / Channel AT /
 *                       CC1 / CC2 ... CC127 (pressure sent as that CC)
 *   Menu                output target (Move / USB / Both)
 *   Back                exit the module
 *   Play / Record       passed through to Move (module.json button_passthrough 85, 86); their LEDs
 *                       follow the transport state tracked by the module
 *   Knobs 1-8           send MIDI CC (default CC 71-78, relative -> absolute 0..127)
 *   Shift + knob        reassign the knob's CC number (nothing is sent)
 *   Knob touch          shows the CC number; turning shows CC number and value
 *
 * The CC assignment, last knob values, pressure mode, pressure CC and program are saved to disk and restored on start.
 */

import {
    MidiNoteOn, MidiNoteOff, MidiCC,
    MoveShift, MoveMenu, MoveMainKnob, MoveMainButton, MoveUp, MoveDown, MoveLeft, MoveRight,
    MoveRow1, MoveRow4, MovePlay, MoveRec,
    MovePads, White, DarkGrey3, Black, Green, Red
} from '/data/UserData/schwung/shared/constants.mjs';

import {
    isNoiseMessage, isCapacitiveTouchMessage,
    setLED, setButtonLED, invalidateLedCache, decodeDelta
} from '/data/UserData/schwung/shared/input_filter.mjs';

import { announce } from '/data/UserData/schwung/shared/screen_reader.mjs';

const WHITE_KEY_COLOR = White;
const BLACK_KEY_COLOR = 26;      /* palette #FF2BD4 (magenta) */
const PRESSED_COLOR = 126;       /* palette #00FF00 (green) */

const FIRST_PAD = MovePads[0];
const FIRST_STEP = 16;           /* step buttons 1-16 = notes 16..31 */
const BASE_NOTE = 48;            /* lowest C at octave offset 0 */
const FROM_MIN = 0;              /* lowest note of the keyboard */
const FROM_MAX = 96;
const LEDS_PER_FRAME = 12;
/* Move's firmware can overwrite pad LEDs when it plays the injected notes, so
   pad LEDs are re-sent continuously: slowly at rest, faster right after a pad event */
const REFRESH_IDLE = 1;
const REFRESH_BOOST = 6;
const BOOST_TICKS = 80;
/* Move's "Auto" MIDI-in channel plays whichever track is selected on Move, whatever the
   channel number. The module owns the track buttons, so it presses them on Move's behalf */
const TRACK_PRESS_MS = 40;
const TRACK_RETRY_MS = 250;
const TRACK_MAX_TRIES = 4;
const TRACK_IGNORE_MS = 400;     /* ignore echoes of our own injected track press */
const AUTO_POLL_MS = 30;         /* how often Move's selected track is re-read */
const DRAW_INTERVAL_MS = 40;     /* display redraw rate cap (25 Hz) */
const AUX_LED_COUNT = 20;        /* 16 step LEDs + 4 track button LEDs */

/* Semitone offsets within one octave's pair of rows; null = unused pad */
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11, 12];
const BLACK_OFFSETS = [1, 3, null, 6, 8, 10, null, 13];

const BACK_CC = 51;
const KNOB_COUNT = 8;
const KNOB_CC_FIRST = 71;        /* MoveKnob1..MoveKnob8 = CC 71..78 */
const KNOB_TOUCH_FIRST = 0;      /* knob touch = notes 0..7 */
const DEFAULT_KNOB_CC = [71, 72, 73, 74, 75, 76, 77, 78];
const MAX_KNOB_STEP = 8;
const INFO_HOLD_MS = 1200;
const SAVE_DELAY_MS = 800;
const SETTINGS_DIR = '/data/UserData/schwung/piano-keys';
const SETTINGS_FILE = SETTINGS_DIR + '/settings.json';

const AT_OFF = 0;
const AT_POLY = 1;
const AT_CHANNEL = 2;
const AT_CC = 3;                 /* pressure sent as a MIDI CC instead */
const AT_NAMES = ['Off', 'Poly', 'Chan', 'CC'];
const AT_POLY_STATUS = 0xA0;
const AT_CHANNEL_STATUS = 0xD0;
const AT_SEND_INTERVAL_MS = 20;

const OUT_MOVE = 0;
const OUT_USB = 1;
const OUT_NAMES = ['Move', 'USB', 'Move+USB'];
const PROGRAM_STATUS = 0xC0;

/* Selectable display items, in jog navigation order */
const IT_CHANNEL = 0;
const IT_FROM = 1;
const IT_PROGRAM = 2;
const IT_OUT = 3;
const IT_AT = 4;
const IT_COUNT = 5;
const PRESSURE_CC_MAX = 127;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ITEM_NAMES = ['Channel', 'From', 'Program', 'Output', 'Aftertouch'];
const OUT_SPOKEN = ['Move', 'USB', 'Move and USB'];
const AT_SPOKEN = ['Off', 'Polyphonic', 'Channel'];

let navChannel = 0;              /* Left/Right position: 0 = Auto, 1..16 */
let channelMask = 0;             /* bit n = MIDI channel n+1; ignored in Auto */
let autoMode = true;             /* follow the selected Move track */
let fromNote = BASE_NOTE;        /* note of the lowest C key */
let program = 0;                 /* last program change value sent */
let selItem = IT_CHANNEL;        /* highlighted item */
let editing = false;             /* jog changes the value of selItem instead of moving the selection */
let output = OUT_MOVE;
let pressureMode = AT_CHANNEL;
let pressureCC = 1;              /* CC number used in AT_CC mode, 1..127 */
let shiftHeld = false;
let lastAutoChannel = 1;
let lastAutoPoll = 0;
let lastDraw = 0;

const knobCC = DEFAULT_KNOB_CC.slice();           /* knob -> CC number */
const knobValue = new Array(KNOB_COUNT).fill(64); /* knob -> last sent value */
const knobTouched = new Array(KNOB_COUNT).fill(false);
let lastKnob = -1;
let lastKnobAction = '';         /* 'touch' | 'turn' | 'assign' */
let infoUntil = 0;
let exiting = false;
let exitAt = 0;
const EXIT_DELAY_MS = 300;
let saveAt = 0;
let refreshCursor = 0;
let auxCursor = 0;
let trackSyncPending = false;
let trackSyncTries = 0;
let trackSyncAt = 0;
let trackReleaseCC = -1;
let trackReleaseAt = 0;
let trackIgnoreUntil = 0;
let boostTicks = 0;

const pressure = new Array(32).fill(0);   /* pad index -> latest pressure */
const pressureSent = new Array(32).fill(0);
let channelSent = 0;
let channelSentMask = 0;
let channelSentCC = null;        /* CC used for the last send; null = channel pressure */
let lastPressureSend = 0;
let pressureDirty = false;

const held = new Array(32).fill(null);   /* pad index -> {chs, note} */
const stepLit = new Array(16).fill(-1);  /* last color sent per step LED */
const lit = new Array(32).fill(-1);      /* last color sent per pad */

/* Transport state. Move's own Play / Record LED updates are suppressed while the module
   runs (RGB sysex), so the state is tracked here and the two LEDs are driven from it.
   null = not known yet: the LED is left to Move until a press or the host tells us. */
const TRANSPORT_POLL_MS = 250;
let playing = null;
let recording = null;
let overlayPlaying = null;       /* last transportPlaying value read from the host */
let lastTransportPoll = 0;
let lastTransportLed = 0;

function readHostPlaying() {
    if (typeof shadow_get_overlay_state !== 'function') return null;
    const state = shadow_get_overlay_state();
    return state && typeof state.transportPlaying === 'number' ? state.transportPlaying !== 0 : null;
}

function setPlaying(on) {
    playing = on;
    if (!on) recording = false;
}

/* Adopts the host's transport state on start and whenever it changes */
function pollTransport() {
    const now = Date.now();
    if (now - lastTransportPoll < TRANSPORT_POLL_MS) return;
    lastTransportPoll = now;
    const hostPlaying = readHostPlaying();
    if (hostPlaying === null || hostPlaying === overlayPlaying) return;
    overlayPlaying = hostPlaying;
    if (hostPlaying !== playing) setPlaying(hostPlaying);
}

function handleTransportButton(cc) {
    if (cc === MovePlay) {
        setPlaying(!playing);
    } else {
        recording = !recording;
        /* Starting a recording from stop starts the transport too */
        if (recording) playing = true;
    }
}

/* Re-sent a few times per second: the cache can't see Move overwrite these */
function updateTransportLeds(immediate) {
    const now = Date.now();
    if (!immediate && now - lastTransportLed < TRANSPORT_POLL_MS) return;
    lastTransportLed = now;
    if (playing !== null) setButtonLED(MovePlay, playing ? Green : Black, true);
    if (recording !== null) setButtonLED(MoveRec, recording ? Red : Black, true);
}

/* Pad index -> semitone offset from the base note, or null if unused */
function padOffset(padIndex) {
    const row = padIndex >> 3;
    const col = padIndex & 7;
    const table = (row & 1) ? BLACK_OFFSETS : WHITE_OFFSETS;
    const rel = table[col];
    return rel === null ? null : rel + 12 * (row >> 1);
}

function padNote(padIndex) {
    const offset = padOffset(padIndex);
    if (offset === null) return null;
    const note = fromNote + offset;
    return note >= 0 && note <= 127 ? note : null;
}

function padColor(padIndex) {
    if (padNote(padIndex) === null) return Black;
    if (held[padIndex]) return PRESSED_COLOR;
    return (padIndex >> 3) & 1 ? BLACK_KEY_COLOR : WHITE_KEY_COLOR;
}

function autoChannel() {
    const now = Date.now();
    if (now - lastAutoPoll < AUTO_POLL_MS) return lastAutoChannel;
    lastAutoPoll = now;
    if (typeof host_get_move_info === 'function') {
        const info = host_get_move_info();
        if (info && info.valid && info.selectedTrack >= 0 && info.selectedTrack <= 3) {
            lastAutoChannel = info.selectedTrack + 1;
        }
    }
    return lastAutoChannel;
}

/* Active 1-based channels */
function currentChannels() {
    if (autoMode) return [autoChannel()];
    const list = [];
    for (let i = 0; i < 16; i++) {
        if (channelMask & (1 << i)) list.push(i + 1);
    }
    return list;
}

function activeMask() {
    return autoMode ? 1 << (autoChannel() - 1) : channelMask;
}

function maskOf(chs) {
    return chs.reduce((m, ch) => m | (1 << (ch - 1)), 0);
}

function channelSpeech() {
    const chs = currentChannels();
    return autoMode ? `Auto, ${chs[0]}` : chs.join(', ');
}

function itemSpeech(item) {
    switch (item) {
        case IT_CHANNEL: return channelSpeech();
        case IT_FROM: return noteName(fromNote);
        case IT_PROGRAM: return String(program);
        case IT_OUT: return OUT_SPOKEN[output];
        default: return pressureMode === AT_CC ? `CC ${pressureCC}` : AT_SPOKEN[pressureMode];
    }
}

function announceItem(item) {
    announce(`${ITEM_NAMES[item]}: ${itemSpeech(item)}`);
}

function selectSingleChannel(ch) {
    navChannel = ch;
    autoMode = ch === 0;
    channelMask = ch === 0 ? 0 : 1 << (ch - 1);
    requestTrackSync();
    announceItem(IT_CHANNEL);
}

function toggleChannel(index) {
    if (autoMode) {
        autoMode = false;
        channelMask = 1 << index;
    } else {
        const next = channelMask ^ (1 << index);
        if (next === 0) {            /* keep at least one channel */
            announce(`Channel ${index + 1} stays on`);
            return;
        }
        channelMask = next;
    }
    navChannel = index + 1;
    requestTrackSync();
    announce(`Channel ${index + 1} ${channelMask & (1 << index) ? 'on' : 'off'}`);
}

/* Move track (1-4) that should be selected so its instrument gets the notes; 0 = none */
function targetTrack() {
    if (autoMode || output === OUT_USB) return 0;
    if (navChannel >= 1 && navChannel <= 4 && (channelMask & (1 << (navChannel - 1)))) return navChannel;
    for (let ch = 1; ch <= 4; ch++) {
        if (channelMask & (1 << (ch - 1))) return ch;
    }
    return 0;
}

function requestTrackSync() {
    trackSyncPending = true;
    trackSyncTries = 0;
    trackSyncAt = 0;
}

function injectTrackButton(cc, value) {
    move_midi_inject_to_move([0x0B, MidiCC, cc, value]);
}

/* Select the target track on Move itself by injecting a track button press, retried
   until host_get_move_info reports it selected (one attempt when that is unavailable) */
function syncMoveTrack() {
    if (typeof move_midi_inject_to_move !== 'function') return;
    const now = Date.now();
    if (trackReleaseCC >= 0) {
        if (now < trackReleaseAt) return;
        injectTrackButton(trackReleaseCC, 0);
        trackReleaseCC = -1;
        trackIgnoreUntil = now + TRACK_IGNORE_MS;
        trackSyncAt = now + TRACK_RETRY_MS;
        return;
    }
    if (!trackSyncPending || now < trackSyncAt) return;

    const target = targetTrack();
    const info = typeof host_get_move_info === 'function' ? host_get_move_info() : null;
    const known = !!(info && info.valid && info.selectedTrack >= 0 && info.selectedTrack <= 3);
    if (target === 0 || (known && info.selectedTrack + 1 === target) ||
        trackSyncTries >= (known ? TRACK_MAX_TRIES : 1)) {
        trackSyncPending = false;
        return;
    }
    trackSyncTries++;
    const cc = MoveRow1 - (target - 1);
    injectTrackButton(cc, 127);
    trackReleaseCC = cc;
    trackReleaseAt = now + TRACK_PRESS_MS;
    trackIgnoreUntil = now + TRACK_PRESS_MS + TRACK_IGNORE_MS;
}

/* Send a channel message on every channel in chs */
function sendOnChannels(statusHigh, chs, d1, d2) {
    for (const ch of chs) sendMidi(statusHigh | (ch - 1), d1, d2);
}

/* Send a 3-byte channel message to the selected output(s), on cable 2 */
function sendMidi(status, d1, d2) {
    const packet = [0x20 | (status >> 4), status, d1, d2];
    if (output !== OUT_USB && typeof move_midi_inject_to_move === 'function') {
        move_midi_inject_to_move(packet);
    }
    if (output !== OUT_MOVE) {
        move_midi_external_send(packet);
    }
}

function noteName(note) {
    return NOTE_NAMES[note % 12] + (Math.floor(note / 12) - 1);
}

function noteOff(entry) {
    sendOnChannels(MidiNoteOff, entry.chs, entry.note, 0);
}

function resetPressure(padIndex) {
    pressure[padIndex] = 0;
    pressureSent[padIndex] = 0;
    pressureDirty = true;
}

function releaseAll() {
    for (let i = 0; i < held.length; i++) {
        if (held[i]) {
            noteOff(held[i]);
            held[i] = null;
            pressure[i] = 0;
            pressureSent[i] = 0;
        }
    }
    resetChannelPressure();
}

function handlePad(type, padIndex, velocity) {
    if (type === MidiNoteOn && velocity > 0) {
        const note = padNote(padIndex);
        if (note === null) return;
        if (held[padIndex]) noteOff(held[padIndex]);
        const chs = currentChannels();
        held[padIndex] = { chs, note };
        pressure[padIndex] = 0;
        pressureSent[padIndex] = 0;
        sendOnChannels(MidiNoteOn, chs, note, velocity);
    } else if (held[padIndex]) {
        /* Release with the note/channel that was pressed, whatever changed since */
        noteOff(held[padIndex]);
        held[padIndex] = null;
        resetPressure(padIndex);
        if (!held.some(Boolean)) resetChannelPressure();
    }
}

/* Channel-wide pressure: channel aftertouch, or a CC in AT_CC mode */
function sendChannelLevel(chIndex, cc, value) {
    if (cc === null) sendMidi(AT_CHANNEL_STATUS | chIndex, value, 0);
    else sendMidi(MidiCC | chIndex, cc, value);
}

function sendChannelPressure(value) {
    let mask = 0;
    for (const entry of held) if (entry) mask |= maskOf(entry.chs);
    if (mask === 0 || (value === channelSent && mask === channelSentMask)) return;
    const cc = pressureMode === AT_CC ? pressureCC : null;
    /* Channels that lost their last held note get a pressure reset */
    for (let i = 0; i < 16; i++) {
        if ((channelSentMask & ~mask) & (1 << i)) sendChannelLevel(i, channelSentCC, 0);
        if (mask & (1 << i)) sendChannelLevel(i, cc, value);
    }
    channelSent = value;
    channelSentMask = mask;
    channelSentCC = cc;
}

/* Zero the channel-wide pressure on the channels (and CC) it was last sent on */
function resetChannelPressure() {
    if (channelSent !== 0) {
        for (let i = 0; i < 16; i++) {
            if (channelSentMask & (1 << i)) sendChannelLevel(i, channelSentCC, 0);
        }
    }
    channelSent = 0;
    channelSentMask = 0;
}

/* Forward pressure, rate limited; runs from tick so the final value is never lost */
function flushPressure() {
    if (!pressureDirty) return;
    const now = Date.now();
    if (now - lastPressureSend < AT_SEND_INTERVAL_MS) return;
    lastPressureSend = now;
    pressureDirty = false;

    if (pressureMode === AT_POLY) {
        for (let i = 0; i < held.length; i++) {
            const entry = held[i];
            if (entry && pressure[i] !== pressureSent[i]) {
                pressureSent[i] = pressure[i];
                sendOnChannels(AT_POLY_STATUS, entry.chs, entry.note, pressure[i]);
            }
        }
    } else {
        let max = 0;
        for (let i = 0; i < held.length; i++) {
            if (held[i] && pressure[i] > max) max = pressure[i];
        }
        sendChannelPressure(max);
    }
}

function handlePressure(padIndex, value) {
    if (pressureMode === AT_OFF || !held[padIndex]) return;
    pressure[padIndex] = value;
    pressureDirty = true;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function loadSettings() {
    if (typeof host_read_file !== 'function') return;
    try {
        const text = host_read_file(SETTINGS_FILE);
        if (!text) return;
        const data = JSON.parse(text);
        if (Number.isInteger(data.program)) program = clamp(data.program, 0, 127);
        if (Number.isInteger(data.pressureCC)) pressureCC = clamp(data.pressureCC, 1, PRESSURE_CC_MAX);
        if (Number.isInteger(data.pressure) && data.pressure >= 0 && data.pressure < AT_NAMES.length) {
            pressureMode = data.pressure;
        }
        for (let i = 0; i < KNOB_COUNT; i++) {
            if (Array.isArray(data.cc) && Number.isInteger(data.cc[i])) {
                knobCC[i] = clamp(data.cc[i], 0, 127);
            }
            if (Array.isArray(data.value) && Number.isInteger(data.value[i])) {
                knobValue[i] = clamp(data.value[i], 0, 127);
            }
        }
    } catch (e) { /* corrupt file: keep defaults */ }
}

function saveSettings() {
    saveAt = 0;
    if (typeof host_write_file !== 'function') return;
    if (typeof host_ensure_dir === 'function') host_ensure_dir(SETTINGS_DIR);
    host_write_file(SETTINGS_FILE, JSON.stringify({ cc: knobCC, value: knobValue, pressure: pressureMode, pressureCC, program }));
}

function scheduleSave() {
    saveAt = Date.now() + SAVE_DELAY_MS;
}

function showKnobInfo(knob, action) {
    lastKnob = knob;
    lastKnobAction = action;
    infoUntil = Date.now() + INFO_HOLD_MS;
    if (action === 'assign') announce(`Knob ${knob + 1} assigned to CC ${knobCC[knob]}`);
    else announce(`Knob ${knob + 1}, CC ${knobCC[knob]}, value ${knobValue[knob]}`);
}

/* Relative encoder value -> signed step; speed is encoded in the magnitude */
function knobStep(value) {
    const raw = value < 64 ? value : value - 128;
    return clamp(raw, -MAX_KNOB_STEP, MAX_KNOB_STEP);
}

function handleKnob(knob, value) {
    if (shiftHeld) {
        const delta = decodeDelta(value);
        if (delta === 0) return;
        knobCC[knob] = clamp(knobCC[knob] + delta, 0, 127);
        showKnobInfo(knob, 'assign');
        scheduleSave();
        return;
    }

    const step = knobStep(value);
    if (step === 0) return;
    const next = clamp(knobValue[knob] + step, 0, 127);
    const changed = next !== knobValue[knob];
    knobValue[knob] = next;
    showKnobInfo(knob, 'turn');
    if (!changed) return;
    sendOnChannels(MidiCC, currentChannels(), knobCC[knob], next);
    scheduleSave();
}

function handleKnobTouch(knob, touched) {
    knobTouched[knob] = touched;
    if (touched) showKnobInfo(knob, 'touch');
    /* A release must not steal the display from a knob touched since */
    else if (knob === lastKnob) infoUntil = Date.now() + INFO_HOLD_MS;
}

function setPressure(mode, cc) {
    resetChannelPressure();
    pressureMode = mode;
    pressureCC = cc;
    pressure.fill(0);
    pressureSent.fill(0);
    pressureDirty = false;
    scheduleSave();
}

function setOutput(next) {
    output = next;
    requestTrackSync();
    announceItem(IT_OUT);
}

function sendProgramChange(value) {
    for (const ch of currentChannels()) sendMidi(PROGRAM_STATUS | (ch - 1), value, 0);
}

/* Pressure options as one list: Off, Poly, Chan, CC1 ... CC127 */
function pressurePosition() {
    return pressureMode === AT_CC ? AT_CC + pressureCC - 1 : pressureMode;
}

function pressureText() {
    return pressureMode === AT_CC ? `CC${pressureCC}` : AT_NAMES[pressureMode];
}

/* Jog turn while an item's value is active */
function adjustSelected(delta) {
    switch (selItem) {
        case IT_CHANNEL:
            selectSingleChannel(clamp(navChannel + delta, 0, 16));
            break;
        case IT_FROM:
            fromNote = clamp(fromNote + delta, FROM_MIN, FROM_MAX);
            announceItem(IT_FROM);
            break;
        case IT_PROGRAM: {
            const next = clamp(program + delta, 0, 127);
            if (next === program) break;
            program = next;
            sendProgramChange(program);
            scheduleSave();
            announceItem(IT_PROGRAM);
            break;
        }
        case IT_OUT:
            setOutput(clamp(output + delta, 0, OUT_NAMES.length - 1));
            break;
        case IT_AT: {
            const pos = pressurePosition();
            const next = clamp(pos + delta, 0, AT_CC + PRESSURE_CC_MAX - 1);
            if (next === pos) break;
            if (next >= AT_CC) setPressure(AT_CC, next - AT_CC + 1);
            else setPressure(next, pressureCC);
            announceItem(IT_AT);
            break;
        }
    }
}

function shiftOctave(octaves) {
    fromNote = clamp(fromNote + 12 * octaves, FROM_MIN, FROM_MAX);
    announceItem(IT_FROM);
}

function handleCC(cc, value) {
    if (cc === MoveShift) {
        shiftHeld = value > 0;
        return;
    }

    /* Jog click toggles between moving the selection and editing its value.
       Shift + jog click belongs to Schwung (exit) */
    if (cc === MoveMainButton) {
        if (value > 0 && !shiftHeld) {
            editing = !editing;
            if (editing) announce(`Editing ${ITEM_NAMES[selItem]}`);
            else announceItem(selItem);
        }
        return;
    }

    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (delta === 0) return;
        if (editing) {
            adjustSelected(delta);
        } else {
            selItem = clamp(selItem + delta, 0, IT_COUNT - 1);
            announceItem(selItem);
        }
        return;
    }

    if (cc >= KNOB_CC_FIRST && cc < KNOB_CC_FIRST + KNOB_COUNT) {
        handleKnob(cc - KNOB_CC_FIRST, value);
        return;
    }

    if (cc >= MoveRow4 && cc <= MoveRow1 && Date.now() < trackIgnoreUntil) return;

    if (value === 0) return;

    if (cc === MovePlay || cc === MoveRec) {
        handleTransportButton(cc);
        updateTransportLeds(true);
        return;
    }

    if (cc === BACK_CC) {
        exiting = true;
        shutdown();
        /* On exit Schwung normally replays the LED state from before the module started,
           which brings back a stale Play / Record LED. A native repaint request skips that
           replay, so the hardware keeps the state shutdown() wrote. The exit is delayed so
           the LED writes reach the hardware first (pending writes are dropped on exit) */
        if (typeof shadow_set_skip_led_clear === 'function') shadow_set_skip_led_clear(1);
        exitAt = Date.now() + EXIT_DELAY_MS;
        return;
    }

    if (cc === MoveUp) shiftOctave(1);
    else if (cc === MoveDown) shiftOctave(-1);
    else if (cc === MoveRight) selectSingleChannel(clamp(navChannel + 1, 0, 16));
    else if (cc === MoveLeft) selectSingleChannel(clamp(navChannel - 1, 0, 16));
    else if (cc === MoveMenu) setOutput((output + 1) % OUT_NAMES.length);
    else if (cc >= MoveRow4 && cc <= MoveRow1) selectSingleChannel(MoveRow1 - cc + 1);
}

globalThis.onMidiMessageInternal = function (data) {
    const type = data[0] & 0xF0;

    /* Knob touch: handled before the filters, which drop capacitive touch */
    if ((type === MidiNoteOn || type === MidiNoteOff) &&
        data[1] >= KNOB_TOUCH_FIRST && data[1] < KNOB_TOUCH_FIRST + KNOB_COUNT) {
        handleKnobTouch(data[1] - KNOB_TOUCH_FIRST, type === MidiNoteOn && data[2] > 0);
        return;
    }

    if (type === AT_POLY_STATUS) {
        const padIndex = data[1] - FIRST_PAD;
        if (padIndex >= 0 && padIndex < 32) handlePressure(padIndex, data[2]);
        return;
    }

    /* Host-level channel pressure (broadcast): apply to every held pad */
    if (type === AT_CHANNEL_STATUS) {
        for (let i = 0; i < held.length; i++) handlePressure(i, data[1]);
        return;
    }

    if (isNoiseMessage(data)) return;
    if (isCapacitiveTouchMessage(data)) return;

    if (type === MidiNoteOn || type === MidiNoteOff) {
        const padIndex = data[1] - FIRST_PAD;
        if (padIndex >= 0 && padIndex < 32) {
            handlePad(type, padIndex, data[2]);
            boostTicks = BOOST_TICKS;
        }
        else if (type === MidiNoteOn && data[2] > 0 && data[1] >= FIRST_STEP && data[1] < FIRST_STEP + 16) {
            toggleChannel(data[1] - FIRST_STEP);
        }
    } else if (type === MidiCC) {
        handleCC(data[1], data[2]);
    }
};

/* External MIDI is not used by this module */
globalThis.onMidiMessageExternal = function () {};

function stepColor(active, i) {
    return active & (1 << i) ? White : Black;
}

function trackColor(active, cc) {
    return active & (1 << (MoveRow1 - cc)) ? White : DarkGrey3;
}

function updateLeds() {
    let budget = LEDS_PER_FRAME;
    for (let i = 0; i < 32 && budget > 0; i++) {
        const color = padColor(i);
        if (lit[i] !== color) {
            setLED(FIRST_PAD + i, color, true);
            lit[i] = color;
            budget--;
        }
    }

    const refreshCount = boostTicks > 0 ? REFRESH_BOOST : REFRESH_IDLE;
    if (boostTicks > 0) boostTicks--;
    for (let n = 0; n < refreshCount; n++) {
        const color = padColor(refreshCursor);
        setLED(FIRST_PAD + refreshCursor, color, true);
        lit[refreshCursor] = color;
        refreshCursor = (refreshCursor + 1) % 32;
    }

    const active = activeMask();
    for (let i = 0; i < 16; i++) {
        const color = stepColor(active, i);
        if (stepLit[i] !== color) {
            setLED(FIRST_STEP + i, color, true);
            stepLit[i] = color;
        }
    }

    for (let cc = MoveRow4; cc <= MoveRow1; cc++) setButtonLED(cc, trackColor(active, cc));

    /* Step and track button LEDs are re-sent too: the cache can't see Move overwrite them */
    if (auxCursor < 16) {
        const color = stepColor(active, auxCursor);
        setLED(FIRST_STEP + auxCursor, color, true);
        stepLit[auxCursor] = color;
    } else {
        const cc = MoveRow4 + auxCursor - 16;
        setButtonLED(cc, trackColor(active, cc), true);
    }
    auxCursor = (auxCursor + 1) % AUX_LED_COUNT;
}

/* All knob CC numbers in 3-digit right-aligned cells: knobs 1-3 after the label on the
   first line, knobs 4-8 on the second line, the last three under the first three */
function drawKnobCCList() {
    const label = 'Knobs CC: ';
    const cellW = text_width('000 ');
    const digitsW = text_width('000');
    const firstX = 2 + text_width(label);
    const topCount = 3;
    const drawCell = (knob, x, y) => {
        const s = String(knobCC[knob]);
        print(x + digitsW - text_width(s), y, s, 1);
    };

    print(2, 40, label, 1);
    for (let k = 0; k < KNOB_COUNT; k++) {
        if (k < topCount) drawCell(k, firstX + k * cellW, 40);
        else drawCell(k, firstX + (k - KNOB_COUNT + topCount) * cellW, 50);
    }
}

function drawKnobInfo() {
    const active = lastKnob >= 0 && (knobTouched[lastKnob] || Date.now() < infoUntil);
    if (!active) {
        drawKnobCCList();
        return;
    }
    print(2, 40, `Knob ${lastKnob + 1}: CC ${knobCC[lastKnob]}`, 1);
    if (lastKnobAction === 'turn') print(2, 50, `Value: ${knobValue[lastKnob]}`, 1);
    else if (lastKnobAction === 'assign') print(2, 50, 'CC assigned', 1);
    else print(2, 50, shiftHeld ? 'Turn to set CC' : 'Shift+knob: set CC', 1);
}

/* Text, inverted (white box, black text) when highlighted */
function drawText(x, y, text, inverted) {
    if (inverted) {
        fill_rect(x - 1, Math.max(0, y - 1), text_width(text) + 2, 9, 1);
        print(x, y, text, 0);
    } else {
        print(x, y, text, 1);
    }
}

/* "label value": the label is inverted while the item is selected, the value while it is
   being edited. A negative x right-aligns the item to the screen edge. */
function drawItem(item, x, y, label, value) {
    const gap = 3;
    const labelW = text_width(label);
    const width = labelW + gap + text_width(value);
    const left = x < 0 ? 128 + x - width : x;
    const selected = selItem === item;
    drawText(left, y, label, selected && !editing);
    drawText(left + labelW + gap, y, value, selected && editing);
}

function drawUI() {
    const now = Date.now();
    if (now - lastDraw < DRAW_INTERVAL_MS) return;
    lastDraw = now;
    clear_screen();
    const chs = currentChannels();
    let chText = autoMode ? `Auto (${chs[0]})` : chs.join(',');
    if (chText.length > 12) chText = `${chs.length} selected`;
    print(2, 0, 'Piano Keys', 1);
    drawItem(IT_CHANNEL, 2, 10, 'Channel:', chText);
    drawItem(IT_FROM, 2, 20, 'From:', noteName(fromNote));
    drawItem(IT_PROGRAM, 70, 20, 'Prg:', String(program));
    drawItem(IT_OUT, 2, 30, 'Out:', OUT_NAMES[output]);
    drawItem(IT_AT, -2, 30, 'AT:', pressureText());
    drawKnobInfo();
}

/* Stops Move's firmware from repainting the pads with its own in-key/chromatic colors */
function suppressMoveLeds(on) {
    if (typeof shadow_set_overtake_suppress_sysex === 'function') {
        shadow_set_overtake_suppress_sysex(on ? 1 : 0);
    }
}

globalThis.init = function () {
    suppressMoveLeds(true);
    lastAutoPoll = 0;
    lastDraw = 0;
    auxCursor = 0;
    trackSyncPending = false;
    trackReleaseCC = -1;
    trackIgnoreUntil = 0;
    overlayPlaying = readHostPlaying();
    playing = overlayPlaying;
    recording = null;
    lastTransportPoll = 0;
    lastTransportLed = 0;
    lit.fill(-1);
    held.fill(null);
    pressure.fill(0);
    pressureSent.fill(0);
    pressureDirty = false;
    channelSent = 0;
    channelSentMask = 0;
    stepLit.fill(-1);
    exiting = false;
    exitAt = 0;
    shiftHeld = false;
    selItem = IT_CHANNEL;
    editing = false;
    knobTouched.fill(false);
    lastKnob = -1;
    loadSettings();
    autoChannel();
    announce(`Piano Keys. ${ITEM_NAMES[IT_CHANNEL]}: ${channelSpeech()}. From ${noteName(fromNote)}. ` +
        `Output: ${OUT_SPOKEN[output]}`);
};

globalThis.onResume = function () {
    suppressMoveLeds(true);
    invalidateLedCache();
    lit.fill(-1);
    stepLit.fill(-1);
    lastTransportLed = 0;
};

/* Safe to run twice (Back handler, then onUnload) */
function shutdown() {
    releaseAll();
    for (let i = 0; i < 32; i++) setLED(FIRST_PAD + i, Black, true);
    for (let i = 0; i < 16; i++) setLED(FIRST_STEP + i, Black, true);
    lit.fill(-1);
    stepLit.fill(-1);
    if (trackReleaseCC >= 0) {
        if (typeof move_midi_inject_to_move === 'function') injectTrackButton(trackReleaseCC, 0);
        trackReleaseCC = -1;
    }
    updateTransportLeds(true);
    suppressMoveLeds(false);
    if (saveAt) saveSettings();
}

globalThis.onUnload = shutdown;

globalThis.tick = function () {
    if (exiting) {
        if (exitAt && Date.now() >= exitAt) {
            exitAt = 0;
            updateTransportLeds(true);
            if (typeof host_exit_module === 'function') host_exit_module();
        }
        return;
    }
    if (saveAt && Date.now() >= saveAt) saveSettings();
    flushPressure();
    syncMoveTrack();
    pollTransport();
    updateTransportLeds();
    updateLeds();
    drawUI();
};
