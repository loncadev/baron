#!/usr/bin/env python3
"""Render an asciicast v2 (.cast) recording to an animated GIF with Pillow — no external tooling.

A tiny terminal emulator: replays the cast's output events onto a character grid (handling printable
text, CR/LF, and the SGR color escapes the demo uses), snapshots the grid after each event, then draws
every snapshot as a frame with a per-frame duration equal to the gap to the next event.

Usage: python scripts/render_gif.py docs/demo/baron-demo.cast docs/demo/baron-demo.gif
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont

BG = (0x1B, 0x1E, 0x24)
DEFAULT_FG = (0xE6, 0xE6, 0xE6)
# The palette the demo actually emits: 90 gray, 92 green, 96 cyan, 0/39 default.
SGR = {"90": (0x8A, 0x8F, 0x99), "92": (0x3F, 0xD0, 0x7F), "96": (0x5A, 0xD6, 0xE0)}


def load(path):
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    header = json.loads(lines[0])
    events = [json.loads(line) for line in lines[1:] if line.strip()]
    return header.get("width", 92), events


def simulate(width, events):
    grid = [[(" ", DEFAULT_FG) for _ in range(width)]]
    row = col = 0
    fg = DEFAULT_FG

    def ensure(r):
        while len(grid) <= r:
            grid.append([(" ", DEFAULT_FG) for _ in range(width)])

    def sgr(params):
        nonlocal fg
        for p in (params or "0").split(";"):
            if p in ("", "0", "39"):
                fg = DEFAULT_FG
            elif p in SGR:
                fg = SGR[p]

    snapshots = []
    times = []
    for t, kind, data in events:
        if kind != "o":
            continue
        i = 0
        while i < len(data):
            ch = data[i]
            if ch == "\x1b" and i + 1 < len(data) and data[i + 1] == "[":
                j = i + 2
                while j < len(data) and not ("@" <= data[j] <= "~"):
                    j += 1
                if j < len(data) and data[j] == "m":
                    sgr(data[i + 2 : j])
                i = j + 1
                continue
            if ch == "\r":
                col = 0
            elif ch == "\n":
                row += 1
                ensure(row)
            else:
                ensure(row)
                if col < width:
                    grid[row][col] = (ch, fg)
                col += 1
            i += 1
        snapshots.append([r[:] for r in grid])
        times.append(t)
    return snapshots, times


def render(snapshots, times, out):
    try:
        font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 18)
    except OSError:
        font = ImageFont.truetype("C:/Windows/Fonts/cour.ttf", 18)
    cw = int(round(font.getlength("M"))) or 10
    ascent, descent = font.getmetrics()
    ch = ascent + descent + 4
    pad = cw

    rows = max(len(s) for s in snapshots)
    cols = 1
    for s in snapshots:
        for line in s:
            last = max((i for i, (c, _) in enumerate(line) if c != " "), default=-1)
            cols = max(cols, last + 1)

    w = pad * 2 + cols * cw
    h = pad * 2 + rows * ch

    frames = []
    for snap in snapshots:
        img = Image.new("RGB", (w, h), BG)
        draw = ImageDraw.Draw(img)
        for r, line in enumerate(snap):
            for c, (char, color) in enumerate(line):
                if char != " ":
                    draw.text((pad + c * cw, pad + r * ch), char, font=font, fill=color)
        frames.append(img.convert("P", palette=Image.ADAPTIVE, colors=16))

    durations = [max(20, int(round((times[i + 1] - times[i]) * 1000))) for i in range(len(times) - 1)]
    durations.append(1500)  # hold the final frame
    frames[0].save(
        out,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )
    print(f"Wrote {out}: {len(frames)} frames, {w}x{h}, {sum(durations)/1000:.1f}s")


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else "docs/demo/baron-demo.cast"
    out = sys.argv[2] if len(sys.argv) > 2 else "docs/demo/baron-demo.gif"
    width, events = load(src)
    snapshots, times = simulate(width, events)
    render(snapshots, times, out)


if __name__ == "__main__":
    main()
