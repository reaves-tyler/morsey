"""Morsey key bridge — Raspberry Pi Pico H (MicroPython).

Dumb passthrough bridge for ANY morse key — straight key, sideswiper, bug,
single- or dual-lever paddle — wired to a 3.5mm TRS jack:

    Tip    -> GP14 (Pin 19)  first contact
    Ring   -> GP15 (Pin 20)  second contact (unused by straight keys)
    Sleeve -> GND  (Pin 18)  common ground

Both GPIOs use internal pull-ups, so an open contact reads 1 and a closed
contact (shorted to ground) reads 0.

This script knows NOTHING about morse: no keying logic, timing, or decoding.
It only reports debounced raw contact changes as single lines over USB serial:

    TIP_DOWN / TIP_UP / RING_DOWN / RING_UP

What the contacts mean (straight / bug / iambic A / iambic B, paddle
reverse) is configured downstream in the browser's keyer — exactly like the
keyer menu on an HF transceiver. Save as main.py in the root of the board.
"""

import time

from machine import Pin

DEBOUNCE_MS = 5
POLL_SLEEP_MS = 1


class Contact:
    """One debounced contact: commits a state change only after the raw
    reading has been stable for DEBOUNCE_MS."""

    def __init__(self, name, gpio):
        self.name = name
        self.pin = Pin(gpio, Pin.IN, Pin.PULL_UP)
        self.stable = self.pin.value()
        self.candidate = self.stable
        self.candidate_since = time.ticks_ms()

    def poll(self):
        raw = self.pin.value()
        now = time.ticks_ms()
        if raw != self.candidate:
            # Reading changed: restart the stability clock
            self.candidate = raw
            self.candidate_since = now
        elif raw != self.stable and time.ticks_diff(now, self.candidate_since) >= DEBOUNCE_MS:
            # Held a new value long enough — commit and report.
            # Closed contact (0) = pressed.
            self.stable = raw
            print(self.name + ("_DOWN" if raw == 0 else "_UP"))


contacts = (
    Contact("TIP", 14),
    Contact("RING", 15),
)

# Announce on boot so the host can tell the bridge is alive
print("MORSEY_BRIDGE_READY")

while True:
    for contact in contacts:
        contact.poll()
    time.sleep_ms(POLL_SLEEP_MS)
