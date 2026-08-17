# Pico paddle bridge

USB bridge for a Bencher BY-1 (or any iambic paddle) so it can key Morsey in
the browser via Web Serial, while staying detachable for direct radio use.

## Signal path

```
Bencher BY-1                       Bridge box
┌─────────────┐   3.5mm TRS aux   ┌──────────────────────────┐
│ L paddle ───┼─ Tip ──────────── ┼─ Tip  ── GP14 (Pin 19)   │
│ R paddle ───┼─ Ring ─────────── ┼─ Ring ── GP15 (Pin 20)   │ Pico H ── USB
│ base/frame ─┼─ Sleeve ───────── ┼─ Sleeve─ GND  (Pin 18)   │
└─────────────┘                   └──────────────────────────┘
```

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
- `DIT_DOWN` / `DIT_UP` — left paddle (tip, GP14)
- `DAH_DOWN` / `DAH_UP` — right paddle (ring, GP15)

Contacts are debounced for 5 ms on the Pico. All keying logic (element
timing, iambic squeeze, decoding) lives in the browser — in Morsey, open
**Send → Connect USB key** and pick the Pico's serial port. Morsey's
serial layer understands both this line protocol and raw CTS/DSR control
lines, so simpler serial-wired paddles keep working too.
