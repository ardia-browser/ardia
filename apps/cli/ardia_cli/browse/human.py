# The humanized timing, curves and key table here are ported from pydoll 3.0 (https://github.com/autoscrape-labs/pydoll).
# Copyright (c) 2025 AutoscrapeLabs. MIT License:
#
# Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
# documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
# rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
# persons to whom the Software is furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
# Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
# WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
# COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
# OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

import asyncio
import math
import random
from dataclasses import dataclass

from ardia_cli import cdp
from ardia_cli.browse.errors import ConnectionLost, OutcomeUnknown

BUTTON_MASK = {"left": 1, "right": 2, "middle": 4, "back": 8, "forward": 16}
PRESSED_FORCE = 0.5
PAUSE_CHARS = frozenset(" .,!?;:\n")
SHIFTED_DIGITS = ")!@#$%^&*("
PUNCTUATION = {
    " ": ("Space", 32), "-": ("Minus", 189), "=": ("Equal", 187), "[": ("BracketLeft", 219), "]": ("BracketRight", 221),
    "\\": ("Backslash", 220), ";": ("Semicolon", 186), "'": ("Quote", 222), "`": ("Backquote", 192), ",": ("Comma", 188),
    ".": ("Period", 190), "/": ("Slash", 191), "_": ("Minus", 189), "+": ("Equal", 187), "{": ("BracketLeft", 219),
    "}": ("BracketRight", 221), "|": ("Backslash", 220), ":": ("Semicolon", 186), '"': ("Quote", 222), "~": ("Backquote", 192),
    "<": ("Comma", 188), ">": ("Period", 190), "?": ("Slash", 191),
}
CHAR_TO_KEY_INFO: dict[str, tuple[str, str, int]] = {
    **{letter: (letter, f"Key{letter.upper()}", ord(letter.upper())) for letter in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"},
    **{str(digit): (str(digit), f"Digit{digit}", 48 + digit) for digit in range(10)},
    **{symbol: (symbol, f"Digit{digit}", 48 + digit) for digit, symbol in enumerate(SHIFTED_DIGITS)},
    **{symbol: (symbol, code, keycode) for symbol, (code, keycode) in PUNCTUATION.items()},
    "\n": ("Enter", "Enter", 13),
    "\t": ("Tab", "Tab", 9),
}


@dataclass(frozen=True)
class TypingTiming:
    key_hold_min: float = 0.06
    key_hold_max: float = 0.14
    keystroke_min: float = 0.03
    keystroke_max: float = 0.12
    punctuation_min: float = 0.08
    punctuation_max: float = 0.18
    thinking_probability: float = 0.02
    thinking_min: float = 0.3
    thinking_max: float = 0.7
    distraction_probability: float = 0.005
    distraction_min: float = 0.5
    distraction_max: float = 1.2


@dataclass(frozen=True)
class MouseTiming:
    fitts_a: float = 0.070
    fitts_b: float = 0.150
    frame_interval: float = 0.012
    frame_interval_variance: float = 0.004
    curvature_min: float = 0.10
    curvature_max: float = 0.30
    curvature_asymmetry: float = 0.6
    short_distance_threshold: float = 50.0
    tremor_amplitude: float = 1.0
    overshoot_probability: float = 0.70
    overshoot_distance_min: float = 0.03
    overshoot_distance_max: float = 0.12
    overshoot_speed_threshold: float = 200.0
    pre_click_pause_min: float = 0.05
    pre_click_pause_max: float = 0.20
    click_hold_min: float = 0.05
    click_hold_max: float = 0.15
    double_click_interval_min: float = 0.05
    double_click_interval_max: float = 0.10
    drag_start_pause_min: float = 0.08
    drag_start_pause_max: float = 0.20
    drag_end_pause_min: float = 0.05
    drag_end_pause_max: float = 0.15
    micro_pause_probability: float = 0.03
    micro_pause_min: float = 0.015
    micro_pause_max: float = 0.04
    min_duration: float = 0.08
    max_duration: float = 2.5


@dataclass(frozen=True)
class ScrollTiming:
    min_duration: float = 0.5
    max_duration: float = 1.5
    bezier_points: tuple[float, float, float, float] = (0.645, 0.045, 0.355, 1.0)
    frame_interval: float = 0.012
    delta_jitter: int = 3
    micro_pause_probability: float = 0.05
    micro_pause_min: float = 0.02
    micro_pause_max: float = 0.05
    overshoot_probability: float = 0.15
    overshoot_factor_min: float = 1.02
    overshoot_factor_max: float = 1.08


class CubicBezier:
    def __init__(self, x1: float, y1: float, x2: float, y2: float):
        self.cx = 3.0 * x1
        self.bx = 3.0 * (x2 - x1) - self.cx
        self.ax = 1.0 - self.cx - self.bx
        self.cy = 3.0 * y1
        self.by = 3.0 * (y2 - y1) - self.cy
        self.ay = 1.0 - self.cy - self.by

    def x_at(self, t: float) -> float:
        return ((self.ax * t + self.bx) * t + self.cx) * t

    def y_at(self, t: float) -> float:
        return ((self.ay * t + self.by) * t + self.cy) * t

    def slope_x(self, t: float) -> float:
        return (3.0 * self.ax * t + 2.0 * self.bx) * t + self.cx

    def t_for(self, x: float, epsilon: float = 1e-6) -> float:
        t = x
        for _ in range(8):
            error = self.x_at(t) - x
            if abs(error) < epsilon:
                return t
            slope = self.slope_x(t)
            if abs(slope) < epsilon:
                break
            t -= error / slope
        low, high, t = 0.0, 1.0, x
        if t < low:
            return low
        if t > high:
            return high
        while low < high:
            current = self.x_at(t)
            if abs(current - x) < epsilon:
                return t
            if x > current:
                low = t
            else:
                high = t
            t = (high - low) * 0.5 + low
        return t

    def solve(self, x: float) -> float:
        return self.y_at(self.t_for(x))


def minimum_jerk(t: float) -> float:
    t3 = t * t * t
    return 10.0 * t3 - 15.0 * t3 * t + 6.0 * t3 * t * t


def bezier_point(t: float, p0, p1, p2, p3) -> tuple[float, float]:
    u = 1.0 - t
    a, b, c, d = u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t
    return a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]


def fitts_duration(distance: float, width: float, a: float, b: float) -> float:
    return a if distance <= 0 else a + b * math.log2(distance / width + 1.0)


def control_points(start, end, timing: MouseTiming):
    dx, dy = end[0] - start[0], end[1] - start[1]
    distance = math.hypot(dx, dy)
    if distance < 1.0:
        return start, end
    perpendicular = (-dy / distance, dx / distance)
    scale = min(1.0, distance / timing.short_distance_threshold)
    first = random.uniform(timing.curvature_min, timing.curvature_max) * distance * scale
    second = random.uniform(timing.curvature_min, timing.curvature_max) * distance * scale
    sign = random.choice([-1.0, 1.0])
    t1 = random.uniform(0.2, timing.curvature_asymmetry)
    t2 = random.uniform(timing.curvature_asymmetry, 0.8)
    near = (start[0] + dx * t1 + perpendicular[0] * first * sign, start[1] + dy * t1 + perpendicular[1] * first * sign)
    counter = random.uniform(0.3, 1.0)
    far = (start[0] + dx * t2 + perpendicular[0] * second * sign * counter, start[1] + dy * t2 + perpendicular[1] * second * sign * counter)
    return near, far


class Keyboard:
    def __init__(self, executor, timing: TypingTiming | None = None):
        self.executor = executor
        self.timing = timing or TypingTiming()
        self.refocus = hasattr(executor, "focus")

    async def _ensure_focus(self):
        if self.refocus:
            await self.executor.focus()

    @staticmethod
    def key_events(char: str) -> tuple[dict, dict]:
        key, code, keycode = CHAR_TO_KEY_INFO.get(char, (char, "", 0))
        down = {"type": "keyDown", "text": char, "unmodifiedText": char, "code": code, "key": key,
                "windowsVirtualKeyCode": keycode, "nativeVirtualKeyCode": keycode}
        up = {"type": "keyUp", "code": code, "key": key, "windowsVirtualKeyCode": keycode, "nativeVirtualKeyCode": keycode}
        return {"method": "Input.dispatchKeyEvent", "params": down}, {"method": "Input.dispatchKeyEvent", "params": up}

    async def type_text(self, text: str, humanize: bool = False):
        if humanize:
            for char in text:
                await self.type_char(char)
                await self.pause_after(char)
            return
        await self._ensure_focus()
        commands = [command for char in text for command in self.key_events(char)]
        batch = getattr(self.executor, "_execute_commands", None)
        if batch is not None:
            await batch(commands)
            return
        for command in commands:
            await self.executor._execute_command(command)

    async def type_char(self, char: str, hold: float | None = None):
        await self._ensure_focus()
        down, up = self.key_events(char)
        await self.executor._execute_command(down)
        dwell = random.uniform(self.timing.key_hold_min, self.timing.key_hold_max) if hold is None else hold
        if dwell > 0:
            await asyncio.sleep(dwell)
        await self.executor._execute_command(up)

    async def pause_after(self, char: str):
        timing = self.timing
        delay = random.uniform(timing.keystroke_min, timing.keystroke_max)
        if char in PAUSE_CHARS:
            delay += random.uniform(timing.punctuation_min, timing.punctuation_max)
        if random.random() < timing.thinking_probability:
            delay += random.uniform(timing.thinking_min, timing.thinking_max)
        if random.random() < timing.distraction_probability:
            delay += random.uniform(timing.distraction_min, timing.distraction_max)
        await asyncio.sleep(delay)


class Mouse:
    def __init__(self, connection, session_id: str | None = None, timing: MouseTiming | None = None):
        self._connection_handler = connection
        self._session_id = session_id
        self._timing = timing or MouseTiming()
        self._position: tuple[float, float] = (0.0, 0.0)
        self._pressed_button: str | None = None
        self.held: str | None = None
        self.interception = None

    async def move(self, x: float, y: float, *, humanize: bool = False):
        if humanize:
            await self._move_humanized(x, y)
            return
        await self._dispatch_move(x, y)

    async def click(self, x: float, y: float, *, button: str = "left", click_count: int = 1, humanize: bool = False):
        if humanize:
            await self._click_humanized(x, y, button, click_count)
            return
        await self._dispatch_move(x, y)
        await self._dispatch_button("mousePressed", button, click_count)
        await self._dispatch_button("mouseReleased", button, click_count)

    async def down(self, button: str = "left"):
        await self._dispatch_button("mousePressed", button)

    async def up(self, button: str = "left"):
        await self._dispatch_button("mouseReleased", button)

    async def drag(self, start_x: float, start_y: float, end_x: float, end_y: float, *, humanize: bool = False):
        if humanize:
            await self._drag_humanized(start_x, start_y, end_x, end_y)
            return
        await self._dispatch_move(start_x, start_y)
        await self._dispatch_button("mousePressed", "left")
        await self._dispatch_move(end_x, end_y)
        await self._dispatch_button("mouseReleased", "left")

    def _duration(self, distance: float) -> float:
        timing = self._timing
        return max(timing.min_duration, min(fitts_duration(distance, 20.0, timing.fitts_a, timing.fitts_b), timing.max_duration))

    async def _move_humanized(self, x: float, y: float):
        start, target = self._position, (x, y)
        distance = math.hypot(x - start[0], y - start[1])
        if distance < 1.0:
            await self._dispatch_move(x, y)
            return
        timing = self._timing
        duration = self._duration(distance)
        if distance > timing.overshoot_speed_threshold and random.random() < timing.overshoot_probability:
            fraction = random.uniform(timing.overshoot_distance_min, timing.overshoot_distance_max)
            beyond = (x + (x - start[0]) * fraction, y + (y - start[1]) * fraction)
            await self._path(start, beyond, duration * 0.85)
            await self._path(beyond, target, duration * 0.15)
        else:
            await self._path(start, target, duration)
        await self._dispatch_move(x, y)

    async def _path(self, start, end, duration: float):
        timing = self._timing
        near, far = control_points(start, end, timing)
        loop = asyncio.get_running_loop()
        began = loop.time()
        previous = (start[0], start[1], began)
        while True:
            now = loop.time()
            elapsed = now - began
            if elapsed >= duration:
                break
            x, y = bezier_point(minimum_jerk(elapsed / duration), start, near, far, end)
            sigma = self._tremor(x, y, now, previous)
            x += random.gauss(0, sigma)
            y += random.gauss(0, sigma)
            await self._dispatch_move(x, y, wait=False)
            previous = (x, y, now)
            await asyncio.sleep(max(0.001, timing.frame_interval + random.uniform(-timing.frame_interval_variance, timing.frame_interval_variance)))
            if random.random() < timing.micro_pause_probability:
                pause = random.uniform(timing.micro_pause_min, timing.micro_pause_max)
                await asyncio.sleep(pause)
                began += pause

    def _tremor(self, x: float, y: float, now: float, previous) -> float:
        elapsed = now - previous[2]
        speed = max(0.2, 1.0 - math.hypot(x - previous[0], y - previous[1]) / elapsed / 500.0) if elapsed > 0 else 1.0
        return self._timing.tremor_amplitude * speed

    async def _click_humanized(self, x: float, y: float, button: str, click_count: int):
        timing = self._timing
        await self._move_humanized(x, y)
        await asyncio.sleep(random.uniform(timing.pre_click_pause_min, timing.pre_click_pause_max))
        for number in range(1, click_count + 1):
            await self._dispatch_button("mousePressed", button, number)
            await asyncio.sleep(random.uniform(timing.click_hold_min, timing.click_hold_max))
            await self._dispatch_button("mouseReleased", button, number)
            if number < click_count:
                await asyncio.sleep(random.uniform(timing.double_click_interval_min, timing.double_click_interval_max))

    async def _drag_humanized(self, start_x: float, start_y: float, end_x: float, end_y: float):
        timing = self._timing
        await self._move_humanized(start_x, start_y)
        await self._dispatch_button("mousePressed", "left")
        await asyncio.sleep(random.uniform(timing.drag_start_pause_min, timing.drag_start_pause_max))
        start = self._position
        await self._path(start, (end_x, end_y), self._duration(math.hypot(end_x - start[0], end_y - start[1])))
        await self._dispatch_move(end_x, end_y)
        await asyncio.sleep(random.uniform(timing.drag_end_pause_min, timing.drag_end_pause_max))
        await self._dispatch_button("mouseReleased", "left")

    def _command(self, params: dict) -> dict:
        command = {"method": "Input.dispatchMouseEvent", "params": params}
        if self._session_id is not None:
            command["sessionId"] = self._session_id
        return command

    async def _send(self, command: dict):
        try:
            await self._connection_handler.execute_command(command, timeout=60)
        except cdp.ConnectionLost:
            raise ConnectionLost() from None
        except cdp.CommandTimeout:
            raise OutcomeUnknown("the mouse input", "Ardia didn't answer an input event in time") from None
        except cdp.CommandFailed as error:
            from ardia_cli.browse.connection import failure

            raise failure(command["method"], error) from None

    async def _send_nowait(self, command: dict):
        try:
            await self._connection_handler.execute_command_nowait(command)
        except cdp.ConnectionLost:
            raise ConnectionLost() from None

    async def _dispatch_move(self, x: float, y: float, *, wait: bool = True):
        interception = self.interception if self._pressed_button is not None else None
        if interception is not None and interception.data is not None:
            await interception.over(x, y)
            self._position = (x, y)
            return
        params = {"type": "mouseMoved", "x": int(round(x)), "y": int(round(y))}
        pressed = self._pressed_button
        if pressed is not None:
            params.update(button=pressed, buttons=BUTTON_MASK[pressed], force=PRESSED_FORCE)
        command = self._command(params)
        await (self._send(command) if wait else self._send_nowait(command))
        self._position = (x, y)
        if interception is not None:
            await interception.moved(x, y)

    async def _dispatch_button(self, kind: str, button: str, click_count: int = 1):
        pressed = kind == "mousePressed"
        if not pressed and self.interception is not None:
            await self.interception.release(*self._position)
        if pressed:
            self.held = button
        params = {"type": kind, "x": int(round(self._position[0])), "y": int(round(self._position[1])), "button": button, "clickCount": click_count}
        if pressed:
            params.update(buttons=BUTTON_MASK[button], force=PRESSED_FORCE)
        await self._send(self._command(params))
        self._pressed_button = button if pressed else None
        if not pressed:
            self.held = None


async def scroll(wheel, distance: float, vertical: bool, direction: int, timing: ScrollTiming | None = None):
    timing = timing or ScrollTiming()
    overshoot = random.uniform(timing.overshoot_factor_min, timing.overshoot_factor_max) if random.random() < timing.overshoot_probability else 1.0
    effective = distance * overshoot
    duration = min(random.uniform(timing.min_duration, timing.max_duration) * (1 + 0.2 * (effective / 1000)), 3.0)

    async def step(delta: float, sign: int):
        amount = int(delta * sign)
        await wheel(0 if vertical else amount, amount if vertical else 0)

    curve = CubicBezier(*timing.bezier_points)
    loop = asyncio.get_running_loop()
    began = loop.time()
    scrolled = 0.0
    while True:
        elapsed = loop.time() - began
        if elapsed >= duration:
            break
        delta = max(effective * curve.solve(elapsed / duration) - scrolled + random.randint(-timing.delta_jitter, timing.delta_jitter), 0)
        if delta >= 1:
            await step(delta, direction)
            scrolled += delta
        await asyncio.sleep(timing.frame_interval + random.uniform(-0.002, 0.002))
        if random.random() < timing.micro_pause_probability:
            pause = random.uniform(timing.micro_pause_min, timing.micro_pause_max)
            await asyncio.sleep(pause)
            began += pause
    if effective > distance and scrolled > distance:
        await asyncio.sleep(random.uniform(0.1, 0.2))
        remaining = scrolled - distance
        corrected = 0.0
        velocity = random.uniform(max(200, remaining * 0.15 / timing.frame_interval), max(400, remaining * 0.15 / timing.frame_interval * 1.5))
        while corrected < remaining:
            delta = min(velocity * timing.frame_interval, remaining - corrected)
            await step(delta, -direction)
            corrected += delta
            velocity *= 0.85
            await asyncio.sleep(timing.frame_interval)
