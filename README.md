# Piano Keys – Schwung module for Ableton Move

An overtake module that turns the 32 pads into a piano keyboard instead of Move's original in-key / chromatic mode. Works as a simple MIDI controller, can send things even on multiple MIDI channels. Knobs and aftertouch can be set to different CC.

<p align="center">
  <img src="images/Piano_Keys.png" alt="Piano Keys on Ableton Move" width="700">
</p>

```
Row 4  –   C#   D#  –   F#  G#   A#  –      (black, magenta)   upper octave
Row 3  C   D    E   F   G   A    B   C      (white)            upper octave
Row 2  –   C#   D#  –   F#  G#   A#  –      (black, magenta)   lower octave
Row 1  C   D    E   F   G   A    B   C      (white)            lower octave
```

Unused pads (between E–F and B–C, and the first pad of the black rows) stay dark. A pressed key lights up green.

The **Menu** button switches the black key layout (saved, applies to all presets). The default is layout 2, where C# is on the second pad, so the black keys sit between the white keys like on a piano. In layout 1 the first pad is C#, which lets one more black key (the upper C#) fit on each black row:

```
Layout 2 (default, C# on the second pad)   Layout 1 (C# on the first pad)
Black row:  –   C#  D#   –   F#  G#  A#   –        C#  D#   –   F#  G#  A#   –   C#
White row:  C   D   E    F   G   A   B    C        C   D    E   F   G   A    B   C
```

## Controls

| Control | Function |
|---|---|
| Track buttons 1–4 | Select that Move track. With Ch = Auto the channel follows the track (track N = channel N); with fixed channels the channel setting is not changed. The track selected on Move is lit green on the track buttons (the others dim) |
| Left / Right | Select knob bank L / R: the 8 knobs send the CCs of the active bank (16 CCs in total). Starts on L and returns to L when the Set changes; the bottom of the screen shows "CC bank: Left" or "CC bank: Right". The knob screen stays open on a bank change and shows the new bank's values (an edit in progress carries on) |
| Step buttons 1–16 | Toggle MIDI channels 1–16 on release; switching off the only active channel returns to Ch = Auto; holding a step for 1 s instead leaves only that channel on (also from Auto); notes, aftertouch and knob CCs go to every active channel. Active steps are lit and show the channels the pads play on (with Ch = Auto the step of the selected track's channel). A note-on received on the external MIDI input (USB-A) flashes the step of its channel for 100 ms: bright green on an active step, dim green on an inactive one (CCs and other messages do not flash) |
| Jog turn | Moves the highlighted (inverted) label: Preset / Ch / From / Prg / Out / AT |
| [Help] (top right) | Selectable with the jog turn (Set stays the initial selection). Jog click opens a short list of the buttons that cannot be changed on the main screen; the jog scrolls it line by line, the bottom line always reads "Click: exit" (jog click or Back closes it) |
| Jog click | Toggles editing: the value of the highlighted label becomes inverted and the jog changes it (Preset 0–9, Ch, From = lowest note, Prg = program change 0–127 sent on every change, Out, AT = pad pressure Off / Poly / Chan / CC1 / CC2 … CC127, default Poly). Program change and pressure CC are saved. Changing the Preset stores the current settings in the old preset and loads the new one (Ch, From, Prg, Out, AT and the knob CC numbers); no program change is sent on a preset switch, the stored Prg only applies to later changes. The label on screen is "Set:"; the channel list shows "multi" when the channel numbers do not fit |
| Shift + Jog click | With the Set item highlighted: renames the Set with Schwung's on-screen keyboard (jog turn = pick, jog click = enter, OK = confirm, Back = cancel; the pads and other buttons are ignored while it is open). Lower and upper case letters are available. The whole name (up to 16 characters) is shown after "Set:" (an empty name shows the Set number). Two Sets may share the same name. While the Set value is being edited, the bottom of the screen shows "Shift+Click: rename" instead of the CC bank |
| Up / Down | Octave (From shifts by 12 semitones) |
| Menu | Toggles the black key layout: C# on the second pad (2, default) or on the first pad (1, one more black key fits). The display shows "Black keys: C# on pad 1/2". The output target (Move / USB / Move+USB) is changed with the jog (Out) |
| Capture | Sent to Move only when Move is an output target (Out = Move or Move+USB), whatever the Ch setting; it acts on the track selected on Move (the green track LED). Never sent to USB, so external synths are unaffected. The display shows "Capture sent" and "Track N" (the track); if Move's set tempo changes within ~2.5 s, "Tempo 123" is shown too. Move does not report to the module whether the capture worked or which tempo it detected, so the shown tempo is the set tempo read with `host_get_move_info()` |
| Undo | Sent to Move only when Move is an output target, like Capture. The display shows "Undo sent" and "Track N" |
| Mute | Sent to Move only when Move is an output target, like Capture. The display shows "Mute/unmute sent" and "Track N" (also spoken by the screen reader) |
| Shift + Mute | All MIDI notes off: releases the held pads and sends CC 123 on all 16 channels to the selected output(s). The display shows "All notes off" |
| Play / Record | Handled by Move itself (start/stop, record); since Move's LED updates are suppressed while the module runs, the module tracks the transport state and lights the buttons itself (Play green, Record red) |
| X (Delete) | Without Shift: sent to Move only when Move is an output target, like Mute (never to USB). The display shows "Delete sent" and "Track N" (also spoken by the screen reader). |
| Shift + X (Delete) | Resets the active Set to the defaults: name cleared, Ch = Auto, From, Prg, Out, AT and the knob CC numbers back to their defaults (the other Sets are untouched). The first press only opens a confirmation on the screen ("Reset Set …? Shift+X again: reset"); a second Shift + X press does the reset. Back, a jog turn or a jog click cancels. While the knob screen is shown (knob touched, being edited or within its 1.2 s follow-up), Shift + X resets only that knob of the shown bank (name cleared, Ch = Pad, default CC, value 64; nothing is sent) with the same two-step confirmation ("Reset Knob …?"). The screen reader announces the question, the result and the cancellation |
| Back | Exit the module |
| Knobs 1–8 | Send MIDI CC of the active bank (default CC 71–78 in bank L, CC 79–86 in bank R; value 0–127, faster turn = bigger steps; each bank keeps its own values, saved per Set) |
| Touch knob (Ch = Auto, Out = Move or Move+USB) | Hands the knobs and the screen over to Move (Schwung co-run), so the knob does its native job on the track selected on Move. The module keeps the pads, buttons and jog, and forwards the touch to Move. Back, or 2 s after the last release, returns to the module's screen (the LEDs under the knobs are cleared). A Back pressed within 1 s of the return is ignored, so a late press does not exit the module by accident. **Shift + touch** opens the module's own knob screen (next row) without the hand-over. Needs a Schwung that offers `shadow_corun_begin_cede`; otherwise the module's knob screen is used |
| Touch knob (otherwise) | The knob screen replaces the main screen while the knob is held and for 1.2 s after: `Knob N`, `Name:`, `Ch:`, `CC:`, `Value:` and `CC bank:`. The jog turn picks a row and the jog click edits it (`(editing)` appears top right; the Name row opens Schwung's on-screen keyboard instead, up to 14 characters). `Ch: Pad` sends on the channels the pads play on, `Ch: 1`–`16` fixes one channel for that knob. While editing, touching another knob shows that knob and the jog keeps changing the same row; jog click or Back ends editing. Name, channel, CC and value are saved per knob and per Set |
| Shift + Volume touch + jog click | Exit (built into Schwung) |

**Auto channel** (Ch: Auto): the module assumes track N ↔ channel N, so the pads play on the channel of the track selected on Move (the matching step LED is lit). The module starts on the track selected on Move. On start the module also presses that track's button on Move's behalf, so if Move was in Session mode it switches to Note mode on the selected track (in Note mode this changes nothing). Start and exit are therefore consistent: Move is in Note mode on the selected track both when the module starts and when it exits. During takeover the track buttons belong to the module, so use the track buttons to switch tracks. The track is only ever changed with the track buttons: a channel setting, even 1–4, never presses a track button on Move's behalf. Use the jog and the step buttons to set fixed channels. Pressing a step button leaves Auto and selects that channel; further steps add or remove channels; pressing the only active channel's step again returns to Auto. With fixed channels the track buttons still switch the Move track but leave the channels as set.

Notes, pressure, program change and the knob CCs (with Ch: Pad) go to the selected output(s) on the channels shown by the lit steps: with Ch = Auto the channel of the selected track (track N = channel N, also to USB), with step-button channels (Ch not Auto) exactly those channels. Knobs with a fixed channel always send on it. The buttons Capture / Undo / Mute / Delete go to the track selected on Move whenever Move is an output target, whatever Ch is set to; with channels that do not belong to that track (e.g. only channel 16) they still act on it, but its sound only follows if its MIDI In is Auto or that channel.

**Track selection**: if a Move track's MIDI In channel is "Auto", it plays whatever channel arrives as long as it is the *selected* track. Since the module owns the track buttons, whenever you pick a track with a track button it presses that button on Move's behalf (and retries until Move reports that track selected). A channel setting never selects a track. The module cannot see the tracks' MIDI In settings: for the sound to follow, set each track's MIDI In to its own channel (1–4) in Move; a track whose MIDI In is Off plays nothing.

**LEDs**: the module asks Schwung to suppress Move's own LED sysex (`shadow_set_overtake_suppress_sysex`) so the firmware should stop repainting the pads in its in-key/chromatic layout, but also re-sends pad, step and track button LEDs round-robin (1–2 USB-MIDI packets per tick) as a safety net. On Back the module asks Schwung for a native LED repaint (`shadow_set_skip_led_clear`) instead of the usual replay of the pre-start LED state, writes the tracked Play / Record state, then switches Move to Session mode (the Note/Session toggle) and presses the four track buttons on Move's behalf (the selected track last, so the selection does not change), which returns Move to Note mode and makes it redraw its pads and track LEDs, and exits ~0.3 s later.

Notes go to Move's own tracks by default (cable-2 injection), so the track listening on the chosen channel plays them. The Out setting (jog) also lets you send them to a USB-A device.

**Notices**: Capture, Undo, Mute, Delete, Menu and Shift + Mute show their message ("Capture sent", "Undo sent", "Mute/unmute sent", "Delete sent", "Black keys: …", "All notes off") on the whole screen for 2.5 s, whichever screen was shown (main, Knob, Help). Then the previous screen returns; if it was the Knob screen without editing or touch, it stays for its usual 1.2 s before the main screen comes back.

**Knob CCs**: they use the same channel and output target as the notes. The 10 presets (channels, From, program, output, pressure mode and CC, knob CC assignments, names, channels and values) and their names, the active preset and the black key layout are saved to `/data/UserData/schwung/piano-keys/settings.json` and restored on the next start. Knob values are kept in memory while turning and written to the file when the Set changes or the module exits (not on every turn); to save them on exit, leave the module with the Back button; changing a knob's CC number or resetting the Set sets the value back to 64.

## Screen reader

When Schwung's screen reader (TTS) is on, the module announces its state: on start (channel, lowest note, output), on every jog selection and edit, channel and step toggles, octave, output, black key layout, Capture / Undo, Mute, Delete, knob touch or turn (knob, name, CC number, channel when fixed, value), the knob screen rows (jog selection and editing: Name, Channel, CC, Value), knob renaming, and knob bank changes (also with the new bank's value of the selected row). Pad notes are not announced.

## Installation

```bash
./scripts/install.sh [move.local]   # scp to /data/UserData/schwung/modules/overtake/piano-keys/
./scripts/build.sh                  # dist/piano-keys-module.tar.gz (for Schwung Manager)
```

After installing, restart Schwung and pick "Piano Keys" from the overtake modules.

## Release (install from GitHub in Schwung)

You can install this module from Schwung's web UI with Install Custom Module on the bottom of the Module screen.


## License

[MIT](LICENSE)

## Info

Developed with help of an AI, testing in progress (by human)...