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

## Linux setup

The Pico enumerates as a USB CDC serial device (`2e8a:0005`, "MicroPython
Board in FS mode"). The in-kernel `cdc_acm` driver binds to it and creates
`/dev/ttyACM0` — nothing to install. Two things commonly stop the browser from
opening that port, and one browser caveat:

### 1. Permission denied on `/dev/ttyACM0`

Every mainstream distro creates the port as `root:dialout`, mode `660`, and a
fresh user account is **not** in `dialout`. Chrome's serial picker will list
the port but fail to open it. Pick one fix:

**Option A — udev rule (recommended: no group change, no re-login).**

```bash
sudo cp hardware/pico-bridge/99-morsey-pico.rules /etc/udev/rules.d/
sudo udevadm control --reload
# unplug and replug the Pico
```

The rule tags the device `uaccess`, so systemd-logind grants the logged-in
desktop user an ACL on the port automatically. It also sets
`ID_MM_DEVICE_IGNORE` (see §2).

**Option B — join the `dialout` group.**

```bash
sudo usermod -aG dialout "$USER"
```

Then **reboot**. Logging out and back in is often *not* enough on a modern
desktop: on GNOME (and other systemd-managed sessions) the per-user
`systemd --user` manager survives logout and re-spawns the shell, terminal
and browser with its boot-time group list, so `id -nG` still lacks
`dialout` after a fresh login. A reboot (or `sudo loginctl terminate-user
"$USER"`, which kills every process you own) restarts that manager.

### 2. ModemManager grabs new serial ports

ModemManager probes any new tty for a modem for 20–30 s after plug-in;
during that window the port opens as "busy". The udev rule above opts the
Pico out. If you chose Option B instead, either add the rule anyway or stop
the service (`sudo systemctl disable --now ModemManager`) if you don't use a
cellular modem.

### 3. Browser

Web Serial exists only in Chromium-based browsers (Chrome, Edge, Chromium,
Brave). Firefox has no Web Serial API. A **Flatpak** or **Snap** Chrome
cannot see serial devices unless the sandbox is opened, e.g.
`flatpak override --user --device=all com.google.Chrome`; the distro or
Google `.deb`/`.rpm` package works out of the box.

### Verifying

```bash
lsusb | grep 2e8a          # Pico is enumerated
ls -l /dev/ttyACM*         # port node exists (root dialout, crw-rw----)
id -nG | grep -w dialout   # Option B only: group applied to this login
head -c1 /dev/ttyACM0      # hangs waiting for data = OK; "Permission denied" = not yet
```

If `head` hangs, press Ctrl+C — the port is yours. Open Morsey in Chrome,
pull up the keyer bar and hit **CONNECT**.

## Protocol

Plain text lines over USB serial (baud is ignored by USB CDC):

- `MORSEY_BRIDGE_READY` once on boot
- `TIP_DOWN` / `TIP_UP` — tip contact (GP14)
- `RING_DOWN` / `RING_UP` — ring contact (GP15)

Contacts are debounced for 5 ms on the Pico. All interpretation (key type,
element timing, iambic squeeze logic, decoding) happens in the browser: open
Morsey, pull up the **keyer bar** at the bottom, set your key type, and hit
**CONNECT** to pick the Pico's serial port.
