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
 *   Up / Down, jog      octave
 *   Shift + jog         transpose (semitones)
 *   Menu                output target (Move / USB / Both)
 *   Shift + Menu        pad pressure: Off / Poly AT / Channel AT / CC
 *   Shift + Up/Down     CC number used for the pressure CC mode
 *   Knobs 1-8           send MIDI CC (default CC 71-78, relative -> absolute 0..127)
 *   Shift + knob        reassign the knob's CC number (nothing is sent)
 *   Knob touch          shows the CC number; turning shows CC number and value
 *
 * The CC assignment, last knob values, pressure mode and CC are saved to disk and restored on start.
 */

import {
    MidiNoteOn, MidiNoteOff, MidiCC,
    MoveShift, MoveMenu, MoveMainKnob, MoveUp, MoveDown, MoveLeft, MoveRight,
    MoveRow1, MoveRow4,
    MovePads, White, DarkGrey3, Black
} from '/data/UserData/schwung/shared/constants.mjs';

import {
    isNoiseMessage, isCapacitiveTouchMessage,
    setLED, setButtonLED, invalidateLedCache, decodeDelta
} from '/data/UserData/schwung/shared/input_filter.mjs';

const WHITE_KEY_COLOR = White;
const BLACK_KEY_COLOR = 26;      /* palette #FF2BD4 (magenta) */
const PRESSED_COLOR = 126;       /* palette #00FF00 (green) */

const FIRST_PAD = MovePads[0];
const FIRST_STEP = 16;           /* step buttons 1-16 = notes 16..31 */
const BASE_NOTE = 48;            /* lowest C at octave offset 0 */
const OCT_MIN = -3;
const OCT_MAX = 3;
const TRANSPOSE_MAX = 11;
const LEDS_PER_FRAME = 12;
/* Move's firmware can overwrite pad LEDs when it plays the injected notes, so
   pad LEDs are re-sent continuously: slowly at rest, faster right after a pad event */
const REFRESH_IDLE = 1;
const REFRESH_BOOST = 6;
const BOOST_TICKS = 80;

/* Semitone offsets within one octave's pair of rows; null = unused pad */
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11, 12];
const BLACK_OFFSETS = [1, 3, null, 6, 8, 10, null, 13];

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
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

let navChannel = 0;              /* Left/Right position: 0 = Auto, 1..16 */
let channelMask = 0;             /* bit n = MIDI channel n+1; ignored in Auto */
let autoMode = true;             /* follow the selected Move track */
let octave = 0;
let transpose = 0;
let output = OUT_MOVE;
let pressureMode = AT_CHANNEL;
let pressureCC = 1;              /* CC number used in AT_CC mode */
let shiftHeld = false;
let lastAutoChannel = 1;

const knobCC = DEFAULT_KNOB_CC.slice();           /* knob -> CC number */
const knobValue = new Array(KNOB_COUNT).fill(64); /* knob -> last sent value */
const knobTouched = new Array(KNOB_COUNT).fill(false);
let lastKnob = -1;
let lastKnobAction = '';         /* 'touch' | 'turn' | 'assign' */
let infoUntil = 0;
let saveAt = 0;
let refreshCursor = 0;
let boostTicks = 0;
let pressureInfoUntil = 0;

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
    const note = BASE_NOTE + 12 * octave + transpose + offset;
    return note >= 0 && note <= 127 ? note : null;
}

function padColor(padIndex) {
    if (padNote(padIndex) === null) return Black;
    if (held[padIndex]) return PRESSED_COLOR;
    return (padIndex >> 3) & 1 ? BLACK_KEY_COLOR : WHITE_KEY_COLOR;
}

function autoChannel() {
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

function maskOf(chs) {
    return chs.reduce((m, ch) => m | (1 << (ch - 1)), 0);
}

function selectSingleChannel(ch) {
    navChannel = ch;
    autoMode = ch === 0;
    channelMask = ch === 0 ? 0 : 1 << (ch - 1);
}

function toggleChannel(index) {
    if (autoMode) {
        autoMode = false;
        channelMask = 1 << index;
    } else {
        const next = channelMask ^ (1 << index);
        if (next === 0) return;      /* keep at least one channel */
        channelMask = next;
    }
    navChannel = index + 1;
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
        if (Number.isInteger(data.pressureCC)) pressureCC = clamp(data.pressureCC, 0, 127);
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
    host_write_file(SETTINGS_FILE, JSON.stringify({ cc: knobCC, value: knobValue, pressure: pressureMode, pressureCC }));
}

function scheduleSave() {
    saveAt = Date.now() + SAVE_DELAY_MS;
}

function showKnobInfo(knob, action) {
    lastKnob = knob;
    lastKnobAction = action;
    infoUntil = Date.now() + INFO_HOLD_MS;
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
    showKnobInfo(knob, 'turn');
    if (next === knobValue[knob]) return;
    knobValue[knob] = next;
    sendOnChannels(MidiCC, currentChannels(), knobCC[knob], next);
    scheduleSave();
}

function handleKnobTouch(knob, touched) {
    knobTouched[knob] = touched;
    showKnobInfo(knob, 'touch');
}

function setPressureMode(mode) {
    resetChannelPressure();
    pressureMode = mode;
    pressureInfoUntil = Date.now() + INFO_HOLD_MS;
    pressure.fill(0);
    pressureSent.fill(0);
    pressureDirty = false;
    scheduleSave();
}

function adjustPressureCC(delta) {
    resetChannelPressure();
    pressureCC = clamp(pressureCC + delta, 0, 127);
    pressureInfoUntil = Date.now() + INFO_HOLD_MS;
    scheduleSave();
}

function handleCC(cc, value) {
    if (cc === MoveShift) {
        shiftHeld = value > 0;
        return;
    }

    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (delta === 0) return;
        if (shiftHeld) transpose = clamp(transpose + delta, -TRANSPOSE_MAX, TRANSPOSE_MAX);
        else octave = clamp(octave + delta, OCT_MIN, OCT_MAX);
        return;
    }

    if (cc >= KNOB_CC_FIRST && cc < KNOB_CC_FIRST + KNOB_COUNT) {
        handleKnob(cc - KNOB_CC_FIRST, value);
        return;
    }

    if (value === 0) return;

    if (shiftHeld && (cc === MoveUp || cc === MoveDown)) adjustPressureCC(cc === MoveUp ? 1 : -1);
    else if (cc === MoveUp) octave = clamp(octave + 1, OCT_MIN, OCT_MAX);
    else if (cc === MoveDown) octave = clamp(octave - 1, OCT_MIN, OCT_MAX);
    else if (cc === MoveRight) selectSingleChannel(clamp(navChannel + 1, 0, 16));
    else if (cc === MoveLeft) selectSingleChannel(clamp(navChannel - 1, 0, 16));
    else if (cc === MoveMenu && shiftHeld) setPressureMode((pressureMode + 1) % AT_NAMES.length);
    else if (cc === MoveMenu) output = (output + 1) % OUT_NAMES.length;
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

    const active = maskOf(currentChannels());
    for (let i = 0; i < 16; i++) {
        const color = active & (1 << i) ? White : Black;
        if (stepLit[i] !== color) {
            setLED(FIRST_STEP + i, color, true);
            stepLit[i] = color;
        }
    }

    for (let cc = MoveRow4; cc <= MoveRow1; cc++) {
        const trackChannel = MoveRow1 - cc + 1;
        setButtonLED(cc, active & (1 << (trackChannel - 1)) ? White : DarkGrey3);
    }
}

function drawKnobInfo() {
    if (Date.now() < pressureInfoUntil) {
        print(2, 40, `Pressure: ${AT_NAMES[pressureMode]}`, 1);
        print(2, 50, `Pressure CC: ${pressureCC}`, 1);
        return;
    }
    const active = lastKnob >= 0 && (knobTouched[lastKnob] || Date.now() < infoUntil);
    if (!active) {
        print(2, 40, 'Knobs: CC ' + knobCC[0] + '-' + knobCC[KNOB_COUNT - 1], 1);
        print(2, 50, 'Shift+knob: set CC', 1);
        return;
    }
    print(2, 40, `Knob ${lastKnob + 1}: CC ${knobCC[lastKnob]}`, 1);
    if (lastKnobAction === 'turn') print(2, 50, `Value: ${knobValue[lastKnob]}`, 1);
    else if (lastKnobAction === 'assign') print(2, 50, 'CC assigned', 1);
    else if (shiftHeld) print(2, 50, 'Turn to set CC', 1);
}

function drawUI() {
    clear_screen();
    const chs = currentChannels();
    let chText = autoMode ? `Auto (${chs[0]})` : chs.join(',');
    if (chText.length > 12) chText = `${chs.length} selected`;
    const low = BASE_NOTE + 12 * octave + transpose;
    const trText = transpose > 0 ? `+${transpose}` : `${transpose}`;
    print(2, 0, 'Piano Keys', 1);
    print(2, 10, `Channel: ${chText}`, 1);
    print(2, 20, `From: ${noteName(Math.max(0, low))}  Tr: ${trText}`, 1);
    print(2, 30, `Out: ${OUT_NAMES[output]}`, 1);
    const atText = pressureMode === AT_CC ? `AT>CC${pressureCC}` : `AT:${AT_NAMES[pressureMode]}`;
    print(128 - text_width(atText) - 2, 30, atText, 1);
    drawKnobInfo();
}

globalThis.init = function () {
    lit.fill(-1);
    held.fill(null);
    pressure.fill(0);
    pressureSent.fill(0);
    pressureDirty = false;
    channelSent = 0;
    channelSentMask = 0;
    stepLit.fill(-1);
    shiftHeld = false;
    knobTouched.fill(false);
    lastKnob = -1;
    loadSettings();
    autoChannel();
};

globalThis.onResume = function () {
    invalidateLedCache();
    lit.fill(-1);
    stepLit.fill(-1);
};

globalThis.onUnload = function () {
    releaseAll();
    for (let i = 0; i < 16; i++) setLED(FIRST_STEP + i, Black, true);
    if (saveAt) saveSettings();
};

globalThis.tick = function () {
    if (saveAt && Date.now() >= saveAt) saveSettings();
    flushPressure();
    updateLeds();
    drawUI();
};
