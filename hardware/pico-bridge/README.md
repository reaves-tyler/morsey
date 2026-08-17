# Pico key bridge

USB bridge that lets **any** morse key — straight key, sideswiper, bug, or
iambic paddle (e.g. a Bencher BY-1) — key Morsey in the browser via Web
Serial, while staying detachable for direct radio use.

The bridge is deliberately dumb: it passes raw contact closures through to
the computer. What they *mean* is configured in Morsey's keyer bar (key type,
iambic A/B, paddle reverse, speed) — exactly like the keyer menu on an HF
transceiver.

## Signal path

```
Any key                            Bridge box
┌─────────────┐   3.5mm TRS aux   ┌──────────────────────────┐
│ contact 1 ──┼─ Tip ──────────── ┼─ Tip  ── GP14 (Pin 19)   │
│ contact 2 ──┼─ Ring ─────────── ┼─ Ring ── GP15 (Pin 20)   │ Pico H ── USB
│ frame/gnd ──┼─ Sleeve ───────── ┼─ Sleeve─ GND  (Pin 18)   │
└─────────────┘                   └──────────────────────────┘
```

Straight keys use only tip + sleeve, and mono plugs are safe: in straight
mode Morsey listens to the tip contact only, so a mono plug's permanently
shorted ring is ignored. Paddles and bugs use all three; wire a sideswiper's
both arms to the tip.

Radio operation: unplug the aux cable from the bridge and use a
3.5mm→1/4" TRS adapter into the transceiver's key jack instead.

## Flashing

1. Install MicroPython on the Pico (hold BOOTSEL while plugging in, copy the
   `.uf2` from micropython.org).
2. Copy `main.py` to the root of the board (Thonny, `mpremote cp main.py :`,
   or drag-and-drop in some IDEs). It runs automatically on power-up.

## Protocol

Plain text lines over USB serial (baud is ignored by USB CDC):

- `MORSEY_BRIDGE_READY` once on boot
- `TIP_DOWN` / `TIP_UP` — tip contact (GP14)
- `RING_DOWN` / `RING_UP` — ring contact (GP15)

Contacts are debounced for 5 ms on the Pico. All interpretation (key type,
element timing, iambic squeeze logic, decoding) happens in the browser: open
Morsey, pull up the **keyer bar** at the bottom, set your key type, and hit
**CONNECT** to pick the Pico's serial port.
