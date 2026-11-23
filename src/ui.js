/*
 * Piano Keys - overtake module
 *
 * Turns Move's 4x8 pad grid into two octaves of piano keyboard:
 *   row 4 (top)   : black keys  -  C# D# -  F# G# A# -
 *   row 3         : white keys  C  D  E  F  G  A  B  C   (octave B, one octave up)
 *   row 2         : black keys  -  C# D# -  F# G# A# -
 *   row 1 (bottom): white keys  C  D  E  F  G  A  B  C   (octave A)
 * Unused positions (between E-F and B-C) stay dark.
 *
 * Notes are sent on one or more chosen MIDI channels (or the channel of the track
 * that was selected on Move when the module was started) to Move's own tracks
 * (cable-2 injection), to the USB-A port, or to both.
 *
 * Controls:
 *   Track buttons 1-4   select that Move track; the channel stays on Auto and follows it
 *   Left / Right        knob bank L / R (starts on L, back to L on a Set change); the 8 knobs
 *                       send the CCs of the active bank, shown as KnobCC-L / KnobCC-R
 *   Step buttons 1-16   toggle channels 1-16 on/off; every active channel gets
 *                       notes, aftertouch and knob CCs. Active steps are lit.
 *                       A note-on arriving on the external MIDI input flashes the step of its
 *                       channel green (bright on an active step, dim on an inactive one).
 *   Up / Down           octave (lowest note shifts by 12)
 *   Jog turn            move the highlighted (inverted) label: Preset / Ch / From / Prg / Out / AT
 *   [Help] (top right)  selectable with the jog; click opens a short button list, the jog scrolls it
 *                       line by line, click (or Back) closes it
 *   Jog click           toggle editing: the value of the highlighted label becomes active and
 *                       the jog changes it (Preset = 0-9: stores the current settings and loads
 *                       the chosen preset, no program change is sent; From = lowest note, Prg = program change 0-127)
 *                       Out = output target, AT = pad pressure: Off / Poly AT / Channel AT /
 *                       CC1 / CC2 ... CC127 (pressure sent as that CC)
 *   Shift + Jog click   with the Set item highlighted: rename the Set with Schwung's on-screen
 *                       keyboard (the first 5 characters are shown after "Set:")
 *   Menu                black key layout: C# on the second pad (2, default) or on the first pad (1,
 *                       one more black key fits)
 *   Shift + Delete (X)  reset the active Set (name and values) to the defaults: the first press
 *                       shows a confirmation on the screen, a second Shift + Delete press resets,
 *                       Back / jog cancels. Delete alone is not used yet
 *   Back                exit the module
 *   Play / Record       passed through to Move (module.json button_passthrough 85, 86); their LEDs
 *                       follow the transport state tracked by the module
 *   Capture / Undo      sent to Move only (not to USB); the display shows "Capture sent" (plus the
 *                       new tempo when Move's tempo changed) or "Undo sent" for a moment
 *   Mute                sent to Move only (not to USB)
 *   Shift + Mute        All MIDI notes off (CC 123 on all channels) to the selected output(s)
 *   Knobs 1-8           send MIDI CC (bank L default CC 71-78, bank R CC 79-86, relative -> absolute 0..127)
 *   Shift + knob        reassign the knob's CC number in the active bank (nothing is sent)
 *   Knob touch          shows the CC number; turning shows CC number and value
 *
 * Each of the 10 presets keeps Ch, From, Prg, Out, AT, the knob CC numbers and the knob values
 * (new CC or Set reset: 64). Knob values are written to disk on a Set change or on exit, not on
 * every turn. Presets are saved to disk and restored on start.
 */

import {
    MidiNoteOn, MidiNoteOff, MidiCC, MidiPC, MidiPolyAftertouch, MidiChAftertouch, MidiCCOn, MidiCCOff,
    MoveShift, MoveMenu, MoveBack, MoveCapture, MoveUndo, MoveMute, MoveDelete, MoveKnob1, MoveKnob1Touch, MoveStep1,
    MoveMainKnob, MoveMainButton, MoveUp, MoveDown, MoveLeft, MoveRight,
    MoveRow1, MoveRow4, MovePlay, MoveRec,
    MovePads, White, DarkGrey3, Black, Green, Red, LightMagenta, DarkMutedTeal
} from '/data/UserData/schwung/shared/constants.mjs';

import {
    isNoiseMessage, isCapacitiveTouchMessage,
    setLED, setButtonLED, invalidateLedCache, decodeDelta
} from '/data/UserData/schwung/shared/input_filter.mjs';

import { announce } from '/data/UserData/schwung/shared/screen_reader.mjs';

import {
    openTextEntry, closeTextEntry, isTextEntryActive, handleTextEntryMidi, tickTextEntry, drawTextEntry
} from '/data/UserData/schwung/shared/text_entry.mjs';

const WHITE_KEY_COLOR = White;
const BLACK_KEY_COLOR = LightMagenta;   /* palette #FF2BD4 (magenta) */
const PRESSED_COLOR = Green;    /* palette #00FF00 (green) */
const MIDI_IN_FLASH_ACTIVE = Green;   /* step LED flash on incoming notes: bright green on an active channel */
const MIDI_IN_FLASH_IDLE = DarkMutedTeal;   /* palette #276622 (dim green) on an inactive channel */
const MIDI_IN_FLASH_MS = 100;

const FIRST_PAD = MovePads[0];
const FIRST_STEP = MoveStep1;   /* step buttons 1-16 = notes 16..31 */
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
const RIGHT_COL_X = 64;          /* left edge of the Ch and Prg items: screen center */
const ITEM_GAP = 3;              /* pixels between an item's label and value */
const AUX_LED_COUNT = 20;        /* 16 step LEDs + 4 track button LEDs */

/* Semitone offsets within one octave's pair of rows; null = unused pad */
const WHITE_OFFSETS = [0, 2, 4, 5, 7, 9, 11, 12];
/* Black key layouts: 0 = C# on the first pad of the row (one more black key fits),
   1 = C# on the second pad (default), so the black keys sit between the white keys like on a piano */
const BLACK_OFFSETS = [
    [1, 3, null, 6, 8, 10, null, 13],
    [null, 1, 3, null, 6, 8, 10, null]
];
const LAYOUT_COUNT = BLACK_OFFSETS.length;
const DEFAULT_BLACK_LAYOUT = 1;

const ALL_NOTES_OFF_CC = 123;
const NOTICE_MS = 2500;          /* how long a "sent" message stays on screen */
const CAPTURE_WATCH_MS = 2500;   /* after Capture, how long Move's tempo is watched for a change */
const TEMPO_CHANGE_MIN = 0.05;   /* BPM difference counted as a changed tempo */
const KNOB_COUNT = 8;
const KNOB_CC_FIRST = MoveKnob1; /* MoveKnob1..MoveKnob8 = CC 71..78 */
const KNOB_TOUCH_FIRST = MoveKnob1Touch;   /* knob touch = notes 0..7 */
const KNOB_BANKS = 2;            /* Left = bank L, Right = bank R */
const KNOB_TOTAL = KNOB_COUNT * KNOB_BANKS;
const KNOB_BANK_NAMES = ['L', 'R'];
const KNOB_BANK_SPOKEN = ['Left', 'Right'];
const KNOB_START_VALUE = 64;
const DEFAULT_KNOB_CC = [71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86];
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
const AT_POLY_STATUS = MidiPolyAftertouch;
const AT_CHANNEL_STATUS = MidiChAftertouch;
const AT_SEND_INTERVAL_MS = 20;

const OUT_MOVE = 0;
const OUT_USB = 1;
const OUT_NAMES = ['Move', 'USB', 'Move+USB'];
const PROGRAM_STATUS = MidiPC;

/* Selectable display items, in jog navigation order */
const IT_PRESET = 0;
const IT_CHANNEL = 1;
const IT_FROM = 2;
const IT_PROGRAM = 3;
const IT_OUT = 4;
const IT_AT = 5;
const IT_HELP = 6;
const NAV_ORDER = [IT_HELP, IT_PRESET, IT_CHANNEL, IT_FROM, IT_PROGRAM, IT_OUT, IT_AT];
/* Buttons whose function cannot be changed on the jog-selectable main screen */
const HELP_LINES = [
    'Up/Down: octave',
    'Left/Right: knob bank',
    'Tracks 1-4: channel',
    'Steps 1-16: multi Ch',
    'Menu: black layout',
    'Knobs 1-8: send CC',
    'Shift+knob: set CC',
    'Mute: to Move',
    'Capture/Undo: to Move',
    'Shift+Mute: panic',
    'Shift+X: reset Set',
    'Play/Rec: to Move',
    'Back: exit module'
];
const HELP_VISIBLE = 4;
const PRESET_COUNT = 10;
const NAME_SHOWN = 5;            /* characters of a Set name that fit after "Set:" */
const NAME_MAX = 16;             /* characters kept of a typed Set name */
const NAME_SHOW_MS = 1000;       /* how long the full Set name replaces Ch: after a Set change or rename */
const PRESSURE_CC_MAX = 127;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ITEM_NAMES = ['Preset', 'Channel', 'From', 'Program', 'Output', 'Aftertouch', 'Help'];
const OUT_SPOKEN = ['Move', 'USB', 'Move and USB'];
const AT_SPOKEN = ['Off', 'Polyphonic', 'Channel'];

let preset = 0;                  /* active preset 0..9 */
let navChannel = 0;              /* jog / step button position: 0 = Auto, 1..16 */
let channelMask = 0;             /* bit n = MIDI channel n+1; ignored in Auto */
let autoMode = true;             /* follow the selected Move track */
let fromNote = BASE_NOTE;        /* note of the lowest C key */
let program = 0;                 /* last program change value sent */
let selItem = IT_CHANNEL;        /* highlighted item */
let helpOpen = false;            /* help screen shown instead of the main screen */
let helpTop = 0;                 /* first visible help line */
let editing = false;             /* jog changes the value of selItem instead of moving the selection */
let output = OUT_MOVE;
let blackLayout = DEFAULT_BLACK_LAYOUT;             /* index into BLACK_OFFSETS; global, not part of a preset */
let resetPending = false;        /* Shift + Delete pressed once: waiting for the confirming second press */
let noticeLines = [];            /* message shown in place of the knob info */
let noticeUntil = 0;
let captureWatchUntil = 0;
let captureBaseTempo = 0;
let pressureMode = AT_CHANNEL;
let pressureCC = 1;              /* CC number used in AT_CC mode, 1..127 */
let shiftHeld = false;
let lastAutoChannel = 1;
let lastAutoPoll = 0;
let lastDraw = 0;
let nameShowUntil = 0;           /* until then the full Set name is drawn in place of the Ch item */

let knobBank = 0;                /* active knob bank; always starts (and returns after a Set change) on L */
const knobCC = DEFAULT_KNOB_CC.slice();           /* bank * 8 + knob -> CC number */
const presets = [];                               /* stored settings of the inactive presets */
const presetNames = new Array(PRESET_COUNT).fill('');   /* preset -> Set name; '' = unnamed */
const knobValue = new Array(KNOB_TOTAL).fill(KNOB_START_VALUE); /* bank * 8 + knob -> last sent value of the active Set */
let knobValuesDirty = false;     /* knob values changed since the last save */
const knobTouched = new Array(KNOB_COUNT).fill(false);
let lastKnob = -1;
let lastKnobAction = '';         /* 'touch' | 'turn' | 'assign' */
let infoUntil = 0;
let exiting = false;
let exitAt = 0;
const EXIT_SETTLE_MS = 300;      /* wait after the last track press so Move's repaint reaches the hardware */
const EXIT_TRACK_STEP_MS = 100;  /* spacing of the track button presses sent on exit */
const SESSION_SETTLE_MS = 250;   /* wait after switching Move to Session mode before the track presses */
let exitSteps = [];              /* pending injected USB-MIDI packets {at, pkt} */
let saveAt = 0;
let lastSavedText = '';          /* what the settings file holds; an identical save is skipped */
let refreshCursor = 0;
let auxCursor = 0;
const midiInFlashUntil = new Array(16).fill(0);   /* channel 0-15 -> end of its step LED flash */
let trackSyncPending = false;
let forcedTrack = 0;             /* track 1-4 just picked with its button while in Auto; 0 = none */
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
    const table = (row & 1) ? BLACK_OFFSETS[blackLayout] : WHITE_OFFSETS;
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
    if (forcedTrack) return lastAutoChannel;   /* Move has not switched to the picked track yet */
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
        case IT_PRESET: return presetSpeech();
        case IT_CHANNEL: return channelSpeech();
        case IT_FROM: return noteName(fromNote);
        case IT_PROGRAM: return String(program);
        case IT_OUT: return OUT_SPOKEN[output];
        case IT_HELP: return 'press to open';
        default: return pressureMode === AT_CC ? `CC ${pressureCC}` : AT_SPOKEN[pressureMode];
    }
}

function announceItem(item) {
    announce(`${ITEM_NAMES[item]}: ${itemSpeech(item)}`);
}

function selectSingleChannel(ch) {
    forcedTrack = 0;
    navChannel = ch;
    autoMode = ch === 0;
    channelMask = ch === 0 ? 0 : 1 << (ch - 1);
    requestTrackSync();
    scheduleSave();
    announceItem(IT_CHANNEL);
}

/* A track button keeps the saved setting on Auto; the channel simply follows that track */
function selectTrack(track) {
    navChannel = 0;
    autoMode = true;
    channelMask = 0;
    lastAutoChannel = track;
    forcedTrack = typeof move_midi_inject_to_move === 'function' ? track : 0;
    requestTrackSync();
    scheduleSave();
    announceItem(IT_CHANNEL);
}

function toggleChannel(index) {
    forcedTrack = 0;
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
    scheduleSave();
    announce(`Channel ${index + 1} ${channelMask & (1 << index) ? 'on' : 'off'}`);
}

/* Move track (1-4) that should be selected so its instrument gets the notes; 0 = none */
function targetTrack() {
    if (forcedTrack) return forcedTrack;
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

/* Move only repaints its pads and track LEDs when something changes, and the module's
   own LEDs replaced them. Switching to Session mode and pressing every track button (the
   selected one last) makes Move redraw them in Note mode without changing the selected track */
function beginExit() {
    let at = Date.now();
    if (typeof move_midi_inject_to_move === 'function') {
        const info = typeof host_get_move_info === 'function' ? host_get_move_info() : null;
        const known = !!(info && info.valid && info.selectedTrack >= 0 && info.selectedTrack <= 3);
        const selected = known ? info.selectedTrack : lastAutoChannel - 1;
        const order = [0, 1, 2, 3].filter(t => t !== selected).concat(selected);
        /* The Note/Session toggle (CC 50, labelled Menu in the constants) switches Move to
           Session mode; the track buttons then bring it back to Note mode with a full repaint */
        exitSteps.push({ at, pkt: [0x0B, MidiCC, MoveMenu, MidiCCOn] },
                       { at: at + TRACK_PRESS_MS, pkt: [0x0B, MidiCC, MoveMenu, MidiCCOff] });
        at += SESSION_SETTLE_MS;
        for (const t of order) {
            const cc = MoveRow1 - t;
            exitSteps.push({ at, pkt: [0x0B, MidiCC, cc, MidiCCOn] },
                           { at: at + TRACK_PRESS_MS, pkt: [0x0B, MidiCC, cc, MidiCCOff] });
            at += EXIT_TRACK_STEP_MS;
        }
    }
    exitAt = at + EXIT_SETTLE_MS;
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
        forcedTrack = 0;
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

function defaultPreset() {
    return {
        autoMode: true, navChannel: 0, channelMask: 0, fromNote: BASE_NOTE, program: 0,
        output: OUT_MOVE, pressureMode: AT_CHANNEL, pressureCC: 1, knobCC: DEFAULT_KNOB_CC.slice(),
        knobValue: new Array(KNOB_TOTAL).fill(KNOB_START_VALUE)
    };
}

/* Current live settings as a preset */
function snapshotPreset() {
    return {
        autoMode, navChannel, channelMask, fromNote, program, output, pressureMode, pressureCC,
        knobCC: knobCC.slice(), knobValue: knobValue.slice()
    };
}

/* Complete, validated preset from saved data; missing or invalid fields get defaults */
function sanitizePreset(raw) {
    const p = defaultPreset();
    if (!raw || typeof raw !== 'object') return p;
    if (Number.isInteger(raw.navChannel)) p.navChannel = clamp(raw.navChannel, 0, 16);
    if (Number.isInteger(raw.channelMask)) p.channelMask = raw.channelMask & 0xFFFF;
    p.autoMode = raw.autoMode === false && p.channelMask !== 0 ? false : true;
    if (p.autoMode) {
        p.navChannel = 0;
        p.channelMask = 0;
    } else if (p.navChannel === 0) {
        p.navChannel = 32 - Math.clz32(p.channelMask & -p.channelMask);   /* lowest active channel */
    }
    if (Number.isInteger(raw.fromNote)) p.fromNote = clamp(raw.fromNote, FROM_MIN, FROM_MAX);
    if (Number.isInteger(raw.program)) p.program = clamp(raw.program, 0, 127);
    if (Number.isInteger(raw.output)) p.output = clamp(raw.output, 0, OUT_NAMES.length - 1);
    if (Number.isInteger(raw.pressureCC)) p.pressureCC = clamp(raw.pressureCC, 1, PRESSURE_CC_MAX);
    if (Number.isInteger(raw.pressureMode) && raw.pressureMode >= 0 && raw.pressureMode < AT_NAMES.length) {
        p.pressureMode = raw.pressureMode;
    }
    for (let i = 0; i < KNOB_TOTAL; i++) {
        if (Array.isArray(raw.knobCC) && Number.isInteger(raw.knobCC[i])) {
            p.knobCC[i] = clamp(raw.knobCC[i], 0, 127);
        }
        if (Array.isArray(raw.knobValue) && Number.isInteger(raw.knobValue[i])) {
            p.knobValue[i] = clamp(raw.knobValue[i], 0, 127);
        }
    }
    return p;
}

function applyPreset(p) {
    autoMode = p.autoMode;
    navChannel = p.navChannel;
    channelMask = p.channelMask;
    fromNote = p.fromNote;
    program = p.program;
    output = p.output;
    pressureMode = p.pressureMode;
    pressureCC = p.pressureCC;
    for (let i = 0; i < KNOB_TOTAL; i++) {
        knobCC[i] = p.knobCC[i];
        knobValue[i] = p.knobValue[i];
    }
}

function cleanName(raw) {
    return typeof raw === 'string' ? raw.trim().slice(0, NAME_MAX) : '';
}

/* Value shown after "Set:": the first characters of the name, or the preset number */
function presetLabel(full) {
    if (!presetNames[preset]) return String(preset);
    return full ? presetNames[preset] : presetNames[preset].slice(0, NAME_SHOWN);
}

function showFullName() {
    if (presetNames[preset].length > NAME_SHOWN) nameShowUntil = Date.now() + NAME_SHOW_MS;
}

function presetSpeech() {
    return presetNames[preset] ? `${preset}, ${presetNames[preset]}` : String(preset);
}

function renamePreset() {
    const index = preset;
    releaseAll();
    pressure.fill(0);
    pressureSent.fill(0);
    pressureDirty = false;
    openTextEntry({
        title: 'Set name',
        initialText: presetNames[index],
        padSelect: false,   /* the pads keep their own LEDs; only the jog types */
        onConfirm: (text) => {
            presetNames[index] = cleanName(text);
            showFullName();
            scheduleSave();
            announce(presetNames[index] ? `Preset ${index} named ${presetNames[index]}` : `Preset ${index} name cleared`);
        },
        onCancel: () => announceItem(IT_PRESET),
        onAnnounce: announce
    });
}

function askResetPreset() {
    resetPending = true;
    editing = false;
    announce(`Reset Set ${presetSpeech()} to defaults? Press Shift plus Delete again to confirm, Back to cancel`);
}

function cancelResetPreset() {
    if (!resetPending) return false;
    resetPending = false;
    announce('Reset cancelled');
    return true;
}

/* Active preset back to the defaults: name, channel, From, Prg, Out, AT and knob CC numbers */
function resetPreset() {
    resetPending = false;
    releaseAll();
    presetNames[preset] = '';
    applyPreset(defaultPreset());
    pressure.fill(0);
    pressureSent.fill(0);
    pressureDirty = false;
    lastKnob = -1;
    knobBank = 0;
    nameShowUntil = 0;
    requestTrackSync();
    scheduleSave();
    announce(`Set ${preset} reset to defaults. Channel: ${channelSpeech()}. From ${noteName(fromNote)}. ` +
        `Output: ${OUT_SPOKEN[output]}`);
}

/* Stores the current settings in the active preset, loads another one and activates it.
   No program change is sent: the stored program only applies to later changes */
function switchPreset(next) {
    if (next === preset) return;
    releaseAll();
    presets[preset] = snapshotPreset();
    preset = next;
    applyPreset(presets[preset]);
    pressure.fill(0);
    pressureSent.fill(0);
    pressureDirty = false;
    lastKnob = -1;
    knobBank = 0;
    showFullName();
    requestTrackSync();
    scheduleSave();
    announce(`Preset ${presetSpeech()}. Channel: ${channelSpeech()}. From ${noteName(fromNote)}. ` +
        `Output: ${OUT_SPOKEN[output]}`);
}

function loadSettings() {
    for (let i = 0; i < PRESET_COUNT; i++) presets[i] = defaultPreset();
    presetNames.fill('');
    preset = 0;
    blackLayout = DEFAULT_BLACK_LAYOUT;
    applyPreset(presets[0]);
    if (typeof host_read_file !== 'function') return;
    try {
        const text = host_read_file(SETTINGS_FILE);
        if (!text) return;
        lastSavedText = text;
        const data = JSON.parse(text);
        if (Array.isArray(data.presets)) {
            for (let i = 0; i < PRESET_COUNT; i++) presets[i] = sanitizePreset(data.presets[i]);
            if (Number.isInteger(data.preset)) preset = clamp(data.preset, 0, PRESET_COUNT - 1);
        } else {
            /* Settings from before presets existed become preset 0 */
            presets[0] = sanitizePreset({
                program: data.program, pressureMode: data.pressure, pressureCC: data.pressureCC, knobCC: data.cc
            });
        }
        if (Array.isArray(data.names)) {
            for (let i = 0; i < PRESET_COUNT; i++) presetNames[i] = cleanName(data.names[i]);
        }
        applyPreset(presets[preset]);
        if (Number.isInteger(data.blackLayout)) blackLayout = clamp(data.blackLayout, 0, LAYOUT_COUNT - 1);
    } catch (e) { /* corrupt file: keep defaults */ }
}

function saveSettings() {
    saveAt = 0;
    knobValuesDirty = false;
    if (typeof host_write_file !== 'function') return;
    presets[preset] = snapshotPreset();
    const text = JSON.stringify({ preset, presets, names: presetNames, blackLayout });
    if (text === lastSavedText) return;
    if (typeof host_ensure_dir === 'function') host_ensure_dir(SETTINGS_DIR);
    host_write_file(SETTINGS_FILE, text);
    lastSavedText = text;
}

function scheduleSave() {
    saveAt = Date.now() + SAVE_DELAY_MS;
}

/* Index into knobCC / knobValue of a physical knob (0-7) in the active bank */
function knobSlot(knob) {
    return knobBank * KNOB_COUNT + knob;
}

function setKnobBank(bank) {
    if (bank === knobBank) return;
    knobBank = bank;
    lastKnob = -1;
    infoUntil = 0;
    announce(`Knob bank ${KNOB_BANK_SPOKEN[bank]}`);
}

function showKnobInfo(knob, action) {
    const slot = knobSlot(knob);
    lastKnob = knob;
    lastKnobAction = action;
    infoUntil = Date.now() + INFO_HOLD_MS;
    if (action === 'assign') announce(`Knob ${knob + 1} assigned to CC ${knobCC[slot]}`);
    else announce(`Knob ${knob + 1}, CC ${knobCC[slot]}, value ${knobValue[slot]}`);
}

/* Relative encoder value -> signed step; speed is encoded in the magnitude */
function knobStep(value) {
    const raw = value < 64 ? value : value - 128;
    return clamp(raw, -MAX_KNOB_STEP, MAX_KNOB_STEP);
}

function handleKnob(knob, value) {
    const slot = knobSlot(knob);
    if (shiftHeld) {
        const delta = decodeDelta(value);
        if (delta === 0) return;
        const cc = clamp(knobCC[slot] + delta, 0, 127);
        if (cc !== knobCC[slot]) {
            knobCC[slot] = cc;
            knobValue[slot] = KNOB_START_VALUE;   /* a new CC starts from the middle */
            knobValuesDirty = true;
        }
        showKnobInfo(knob, 'assign');
        scheduleSave();
        return;
    }

    const step = knobStep(value);
    if (step === 0) return;
    const next = clamp(knobValue[slot] + step, 0, 127);
    const changed = next !== knobValue[slot];
    knobValue[slot] = next;
    showKnobInfo(knob, 'turn');
    if (!changed) return;
    knobValuesDirty = true;   /* written with the next save, a Set change or on exit; no write per turn */
    sendOnChannels(MidiCC, currentChannels(), knobCC[slot], next);
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
    scheduleSave();
    announceItem(IT_OUT);
}

function setBlackLayout(next) {
    releaseAll();
    blackLayout = next;
    scheduleSave();
    showNotice(['Black keys:', `C# on pad ${blackLayout + 1}`]);
    announce(`Black keys: C sharp on pad ${blackLayout + 1}`);
}

function showNotice(lines, ms) {
    noticeLines = lines;
    noticeUntil = Date.now() + (ms || NOTICE_MS);
}

function moveTempo() {
    const info = typeof host_get_move_info === 'function' ? host_get_move_info() : null;
    return info && info.valid && info.tempo > 0 ? info.tempo : 0;
}

function formatTempo(tempo) {
    return String(Math.round(tempo * 10) / 10);
}

/* Capture / Undo / Mute are no longer passed through by the host: they are forwarded here, and
   only when Move is an output target, so external synths never see them */
const forwardedHeld = new Set();

function forwardToMove(cc, value) {
    if (value > 0) {
        if (output === OUT_USB || typeof move_midi_inject_to_move !== 'function') return false;
        forwardedHeld.add(cc);
    } else if (!forwardedHeld.delete(cc)) {
        return false;
    }
    move_midi_inject_to_move([0x0B, MidiCC, cc, value]);
    return true;
}

/* CC 123 on all 16 channels to the selected output(s), after releasing the held pads */
function allNotesOff() {
    releaseAll();
    for (let ch = 0; ch < 16; ch++) sendMidi(MidiCC | ch, ALL_NOTES_OFF_CC, 0);
    showNotice(['All notes off']);
    announce('All notes off');
}

function handleCapture() {
    captureBaseTempo = moveTempo();
    captureWatchUntil = Date.now() + CAPTURE_WATCH_MS;
    showNotice(['Capture sent'], CAPTURE_WATCH_MS);
    announce('Capture sent');
}

function handleUndo() {
    captureWatchUntil = 0;
    showNotice(['Undo sent']);
    announce('Undo sent');
}

/* Move does not report whether a capture worked; a changed set tempo is the only visible result */
function pollCapture() {
    if (!captureWatchUntil) return;
    const now = Date.now();
    if (now >= captureWatchUntil) {
        captureWatchUntil = 0;
        return;
    }
    const tempo = moveTempo();
    if (captureBaseTempo <= 0 || tempo <= 0 || Math.abs(tempo - captureBaseTempo) < TEMPO_CHANGE_MIN) return;
    captureWatchUntil = 0;
    showNotice(['Capture sent', `Tempo ${formatTempo(tempo)}`]);
    announce(`Tempo ${formatTempo(tempo)}`);
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
        case IT_PRESET:
            switchPreset(clamp(preset + delta, 0, PRESET_COUNT - 1));
            break;
        case IT_CHANNEL:
            selectSingleChannel(clamp(navChannel + delta, 0, 16));
            break;
        case IT_FROM:
            fromNote = clamp(fromNote + delta, FROM_MIN, FROM_MAX);
            scheduleSave();
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
    scheduleSave();
    announceItem(IT_FROM);
}

function handleCC(cc, value) {
    if (cc === MoveShift) {
        shiftHeld = value > 0;
        return;
    }

    /* Jog click toggles between moving the selection and editing its value.
       Shift + jog click renames the Set; with Vol touched it is Schwung's exit combo */
    if (cc === MoveMainButton) {
        if (value > 0 && cancelResetPreset()) return;
        if (value > 0 && shiftHeld) {
            if (!helpOpen && selItem === IT_PRESET) renamePreset();
        } else if (value > 0) {
            if (helpOpen) {
                helpOpen = false;
                announce('Help closed');
            } else if (selItem === IT_HELP) {
                helpOpen = true;
                helpTop = 0;
                announce(`Help. ${HELP_LINES[0]}`);
            } else if (!editing) {
                editing = true;
                announce(selItem === IT_PRESET ? 'Editing Preset. Shift plus jog click renames the Set'
                    : `Editing ${ITEM_NAMES[selItem]}`);
            } else {
                editing = false;
                announceItem(selItem);
            }
        }
        return;
    }

    if (cc === MoveMainKnob) {
        const delta = decodeDelta(value);
        if (delta === 0) return;
        if (cancelResetPreset()) return;
        if (helpOpen) {
            helpTop = clamp(helpTop + delta, 0, HELP_LINES.length - HELP_VISIBLE);
            announce(HELP_LINES[helpTop]);
        } else if (editing) {
            adjustSelected(delta);
        } else {
            const pos = clamp(NAV_ORDER.indexOf(selItem) + delta, 0, NAV_ORDER.length - 1);
            selItem = NAV_ORDER[pos];
            announceItem(selItem);
        }
        return;
    }

    if (cc >= KNOB_CC_FIRST && cc < KNOB_CC_FIRST + KNOB_COUNT) {
        handleKnob(cc - KNOB_CC_FIRST, value);
        return;
    }

    if (cc >= MoveRow4 && cc <= MoveRow1 && Date.now() < trackIgnoreUntil) return;

    if (cc === MoveCapture || cc === MoveUndo) {
        if (!forwardToMove(cc, value) || value === 0) return;
        if (cc === MoveCapture) handleCapture();
        else handleUndo();
        return;
    }

    if (cc === MoveMute) {
        if (value > 0 && shiftHeld) allNotesOff();
        else forwardToMove(cc, value);
        return;
    }

    if (value === 0) return;

    if (cc === MovePlay || cc === MoveRec) {
        handleTransportButton(cc);
        updateTransportLeds(true);
        return;
    }

    if (cc === MoveDelete) {
        if (!shiftHeld || helpOpen) return;
        if (resetPending) resetPreset();
        else askResetPreset();
        return;
    }

    if (cc === MoveBack && cancelResetPreset()) return;

    if (cc === MoveBack && helpOpen) {
        helpOpen = false;
        return;
    }

    if (cc === MoveBack) {
        exiting = true;
        shutdown();
        /* On exit Schwung normally replays the LED state from before the module started,
           which brings back a stale Play / Record LED. A native repaint request skips that
           replay, so the hardware keeps the state shutdown() wrote. The exit is delayed so
           the LED writes reach the hardware first (pending writes are dropped on exit) */
        if (typeof shadow_set_skip_led_clear === 'function') shadow_set_skip_led_clear(1);
        beginExit();
        return;
    }

    if (cc === MoveUp) shiftOctave(1);
    else if (cc === MoveDown) shiftOctave(-1);
    else if (cc === MoveRight) setKnobBank(1);
    else if (cc === MoveLeft) setKnobBank(0);
    else if (cc === MoveMenu) setBlackLayout((blackLayout + 1) % LAYOUT_COUNT);
    else if (cc >= MoveRow4 && cc <= MoveRow1) selectTrack(MoveRow1 - cc + 1);
}

globalThis.onMidiMessageInternal = function (data) {
    if (exiting) return;
    const type = data[0] & 0xF0;

    /* The name keyboard takes every input; only Shift is still tracked */
    if (isTextEntryActive()) {
        if (type === MidiCC && data[1] === MoveShift) shiftHeld = data[2] > 0;
        else handleTextEntryMidi(data);
        return;
    }

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

/* Incoming external MIDI: a note-on flashes the step LED of its channel */
globalThis.onMidiMessageExternal = function (data) {
    if (exiting) return;
    if ((data[0] & 0xF0) === MidiNoteOn && data[2] > 0) {
        midiInFlashUntil[data[0] & 0x0F] = Date.now() + MIDI_IN_FLASH_MS;
    }
};

function stepColor(active, i, now) {
    const on = active & (1 << i);
    if (now < midiInFlashUntil[i]) return on ? MIDI_IN_FLASH_ACTIVE : MIDI_IN_FLASH_IDLE;
    return on ? White : Black;
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
    const now = Date.now();
    for (let i = 0; i < 16; i++) {
        const color = stepColor(active, i, now);
        if (stepLit[i] !== color) {
            setLED(FIRST_STEP + i, color, true);
            stepLit[i] = color;
        }
    }

    for (let cc = MoveRow4; cc <= MoveRow1; cc++) setButtonLED(cc, trackColor(active, cc));

    /* Step and track button LEDs are re-sent too: the cache can't see Move overwrite them */
    if (auxCursor < 16) {
        const color = stepColor(active, auxCursor, now);
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
    const label = `KnobCC-${KNOB_BANK_NAMES[knobBank]}: `;
    const cellW = text_width('000 ');
    const digitsW = text_width('000');
    const firstX = 2 + text_width(label);
    const topCount = 3;
    const drawCell = (knob, x, y) => {
        const s = String(knobCC[knobSlot(knob)]);
        print(x + digitsW - text_width(s), y, s, 1);
    };

    print(2, 40, label, 1);
    for (let k = 0; k < KNOB_COUNT; k++) {
        if (k < topCount) drawCell(k, firstX + k * cellW, 40);
        else drawCell(k, firstX + (k - KNOB_COUNT + topCount) * cellW, 50);
    }
}

function drawKnobInfo() {
    if (Date.now() < noticeUntil) {
        print(2, 40, noticeLines[0], 1);
        if (noticeLines[1]) print(2, 50, noticeLines[1], 1);
        return;
    }
    const active = lastKnob >= 0 && (knobTouched[lastKnob] || Date.now() < infoUntil);
    if (!active && selItem === IT_PRESET && editing) {
        print(2, 40, 'Shift+Jog click:', 1);
        print(2, 50, 'rename this Set', 1);
        return;
    }
    if (!active) {
        drawKnobCCList();
        return;
    }
    print(2, 40, `Knob ${lastKnob + 1}: CC ${knobCC[knobSlot(lastKnob)]}`, 1);
    if (lastKnobAction === 'turn') print(2, 50, `Value: ${knobValue[knobSlot(lastKnob)]}`, 1);
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
    const gap = ITEM_GAP;
    const labelW = text_width(label);
    const width = labelW + gap + text_width(value);
    const left = x < 0 ? 128 + x - width : x;
    const selected = selItem === item;
    drawText(left, y, label, selected && !editing);
    drawText(left + labelW + gap, y, value, selected && editing);
}

function drawHelp() {
    print(2, 0, '[HELP]', 1);
    const range = `${helpTop + 1}-${helpTop + HELP_VISIBLE}/${HELP_LINES.length}`;
    print(126 - text_width(range), 0, range, 1);
    for (let i = 0; i < HELP_VISIBLE; i++) print(2, 10 + i * 10, HELP_LINES[helpTop + i], 1);
    print(2, 54, 'Click: exit', 1);
}

function drawResetConfirm() {
    print(2, 0, `Reset Set ${presetLabel(false)}?`, 1);
    print(2, 14, 'Name and values go', 1);
    print(2, 24, 'back to defaults.', 1);
    print(2, 40, 'Shift+X again: reset', 1);
    print(2, 52, 'Back/jog: cancel', 1);
}

function drawUI() {
    const now = Date.now();
    if (now - lastDraw < DRAW_INTERVAL_MS) return;
    lastDraw = now;
    clear_screen();
    if (isTextEntryActive()) {
        drawTextEntry();
        return;
    }
    if (helpOpen) {
        drawHelp();
        return;
    }
    if (resetPending) {
        drawResetConfirm();
        return;
    }
    const chs = currentChannels();
    print(2, 0, 'Piano Keys', 1);
    drawText(126 - text_width('[Help]'), 0, '[Help]', selItem === IT_HELP);

    /* Ch and Prg labels start at the screen center, so they never move. The channel list
       becomes "multi" when the numbers do not fit next to the label */
    const free = 126 - (RIGHT_COL_X + text_width('Ch:') + ITEM_GAP);
    let chText = autoMode ? `Auto ${chs[0]}` : chs.join(',');
    if (autoMode && text_width(chText) > free) chText = `A${chs[0]}`;
    else if (text_width(chText) > free) chText = 'multi';
    const fullName = Date.now() < nameShowUntil;
    drawItem(IT_PRESET, 2, 10, 'Set:', presetLabel(fullName));
    if (!fullName) drawItem(IT_CHANNEL, RIGHT_COL_X, 10, 'Ch:', chText);
    drawItem(IT_FROM, 2, 20, 'From:', noteName(fromNote));
    drawItem(IT_PROGRAM, RIGHT_COL_X, 20, 'Prg:', String(program));
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
    midiInFlashUntil.fill(0);
    trackSyncPending = false;
    forcedTrack = 0;
    trackReleaseCC = -1;
    trackIgnoreUntil = 0;
    overlayPlaying = readHostPlaying();
    playing = overlayPlaying;
    recording = null;
    lastTransportPoll = 0;
    lastTransportLed = 0;
    noticeUntil = 0;
    captureWatchUntil = 0;
    forwardedHeld.clear();
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
    exitSteps = [];
    shiftHeld = false;
    nameShowUntil = 0;
    closeTextEntry();
    selItem = IT_PRESET;
    editing = false;
    helpOpen = false;
    helpTop = 0;
    resetPending = false;
    knobTouched.fill(false);
    lastKnob = -1;
    knobBank = 0;
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
    closeTextEntry();
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
    if (saveAt || knobValuesDirty) saveSettings();
}

globalThis.onUnload = shutdown;

globalThis.tick = function () {
    if (exiting) {
        const now = Date.now();
        while (exitSteps.length && exitSteps[0].at <= now) {
            const step = exitSteps.shift();
            move_midi_inject_to_move(step.pkt);
        }
        if (exitAt && !exitSteps.length && now >= exitAt) {
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
    pollCapture();
    tickTextEntry();
    updateTransportLeds();
    updateLeds();
    drawUI();
};
