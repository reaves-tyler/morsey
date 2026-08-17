"""Morsey paddle bridge — Raspberry Pi Pico H (MicroPython).

Hardware state bridge for an iambic paddle (e.g. Bencher BY-1) wired to a
3.5mm TRS jack:

    Tip    -> GP14 (Pin 19)  dit (left paddle)
    Ring   -> GP15 (Pin 20)  dah (right paddle)
    Sleeve -> GND  (Pin 18)  common ground

Both GPIOs use internal pull-ups, so an open paddle reads 1 and a closed
contact (shorted to ground) reads 0.

This script does NO keying logic, timing, or decoding — it only reports
debounced paddle state changes as single lines over USB serial:

    DIT_DOWN / DIT_UP / DAH_DOWN / DAH_UP

Everything downstream (element timing, iambic squeeze, decoding) happens in
the browser via the Web Serial API. Save as main.py in the root of the board.
"""

import time

from machine import Pin

DEBOUNCE_MS = 5
POLL_SLEEP_MS = 1


class Paddle:
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
            # Closed contact (0) = paddle pressed.
            self.stable = raw
            print(self.name + ("_DOWN" if raw == 0 else "_UP"))


paddles = (
    Paddle("DIT", 14),
    Paddle("DAH", 15),
)

# Announce on boot so the host can tell the bridge is alive
print("MORSEY_BRIDGE_READY")

while True:
    for paddle in paddles:
        paddle.poll()
    time.sleep_ms(POLL_SLEEP_MS)
