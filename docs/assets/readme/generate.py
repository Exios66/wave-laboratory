#!/usr/bin/env python3
"""Generate the repository's constellation README artwork.

Design system: wave-v1 — the Digital-Mailroom constellation family
(midnight backgrounds, system fonts, rounded cards) tailored to the
laboratory: sea-teal depth layers, a spectral sun-glow, summed sinusoids
for sea bands, and the experiment loop as the process diagram.

Run `python3 docs/assets/readme/generate.py` to rebuild the adjacent SVGs,
or append `--check` for a read-only drift check. Python standard library
only. Facts are repository-local CONFIG values backed by the source tree:
see `src/vessel/hulls.ts`, `src/schema/presets.ts`, and the unit-test run.
No timestamp, external font, network access or image-generation dependency.
"""
from __future__ import annotations

import argparse
from html import escape
from pathlib import Path

CONFIG = {
    'kind': 'wave',
    'title': 'Wave Laboratory',
    'tagline': 'Build a sea state from ocean physics. Drop in a ship. Measure how it handles.',
    'tagline_lines': ['Build a sea state from ocean physics.', 'Drop in a ship. Measure how it handles.'],
    'eyebrow': 'WAVE SPECTRA · 6-DOF SEAKEEPING · WEATHER · INSTRUMENTATION',
    'description': 'Wind-driven spectra synthesise a chopped sea surface through four FFT '
                   'cascades; ships integrate hull pressure in 6-DOF; gauges, spectra and '
                   'statistics measure the response. CPU and GPU use the same amplitudes.',
    'stages': [('Wind & spectra', 'JONSWAP · PM · Bretschneider', 'TMA depth · Airy'),
               ('Sea surface', 'four FFT cascades', 'choppy (Lagrangian) displacement'),
               ('Ships in 6-DOF', 'hull pressure integration', 'added mass · damping · sail'),
               ('Measure', 'gauges · Welch spectra', 'motion sickness · CSV')],
    'mobile_stages': [('Wind & spectra', 'JONSWAP · PM · Bretsch.'),
                      ('Sea surface', 'four FFT cascades'),
                      ('Ships in 6-DOF', 'hull pressure · sails'),
                      ('Measure', 'gauges · spectra · CSV')],
    'mobile_note': ['Wind → sea → ship response → instrument record',
                    'NewWave rogues · gusts & squalls · deterministic seed'],
    'footer_band': 'NewWave focused rogue groups · von Kármán gusts & squall fronts · '
                   'sea state follows the weather · the same amplitudes on CPU and GPU',
    'stats': [('11 hulls', 'parametric designs', 'lifeboat → Nimitz-class'),
              ('280 water columns', 'hull pressure integration', 'hydrostatics + Froude–Krylov'),
              ('4 FFT cascades', 'surface synthesis', '1 km swell → cm ripples'),
              ('632 tests', 'physics validation', 'unit + statistical suites')],
}
# Sea-tailored accent set: wind sky, sea teal, storm amber, rogue pink.
COLORS = ('#38bdf8', '#2dd4bf', '#f59e0b', '#f472b6')
FONT = "ui-sans-serif,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"


def text(x, y, value, size=20, color='#e2e8f0', weight=400, anchor='start'):
    """Draw escaped text using system fonts and explicit SVG coordinates."""
    return (f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" '
            f'font-weight="{weight}" text-anchor="{anchor}">{escape(str(value))}</text>')


def frame(width, height, title, description):
    """Open an accessible, self-contained SVG with shared family tokens."""
    return [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
            f'width="{width}" height="{height}" role="img" aria-labelledby="title desc" font-family="{FONT}">',
            f'<title id="title">{escape(title)}</title><desc id="desc">{escape(description)}</desc>',
            '<defs><linearGradient id="bg" x2="1" y2="1">'
            '<stop stop-color="#0b1220"/><stop offset=".5" stop-color="#0a2a3f"/>'
            '<stop offset="1" stop-color="#081d2f"/></linearGradient>'
            '<linearGradient id="sea" x2="1" y2="0">'
            '<stop stop-color="#0ea5e9" stop-opacity=".55"/>'
            '<stop offset=".5" stop-color="#2dd4bf" stop-opacity=".45"/>'
            '<stop offset="1" stop-color="#f59e0b" stop-opacity=".5"/></linearGradient>'
            '<linearGradient id="heading"><stop stop-color="#7dd3fc"/>'
            '<stop offset=".5" stop-color="#c4b5fd"/><stop offset="1" stop-color="#f9a8d4"/>'
            '</linearGradient><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" '
            'markerWidth="6" markerHeight="6" orient="auto-start-reverse">'
            '<path d="M0 0 L10 5 L0 10" fill="none" stroke="#94a3b8" stroke-width="1.5"/>'
            '</marker></defs>',
            '<style>.cue{stroke-dasharray:6 22;animation:travel 4.5s linear 1}'
            '@keyframes travel{from{stroke-dashoffset:112}to{stroke-dashoffset:0}}'
            '@media(prefers-reduced-motion:reduce){.cue{animation:none}}</style>',
            f'<rect width="{width}" height="{height}" rx="24" fill="url(#bg)"/>',
            f'<rect x=".5" y=".5" width="{width-1}" height="{height-1}" rx="24" fill="none" stroke="#334155"/>']


def line(x1, y1, x2, y2, cue=False):
    """Draw a permanently visible connector with an optional finite flow cue."""
    base = (f'<path d="M{x1} {y1} L{x2} {y2}" fill="none" stroke="#64748b" '
            'stroke-width="2" marker-end="url(#arrow)"/>')
    if cue:
        base += (f'<path class="cue" d="M{x1} {y1} L{x2} {y2}" '
                 'fill="none" stroke="#7dd3fc" stroke-width="2"/>')
    return base


def card(x, y, width, label, detail, color, height=86, detail2=None):
    """Draw one labeled stage without relying on motion to reveal content."""
    bits = (f'<rect x="{x}" y="{y}" width="{width}" height="{height}" rx="14" '
            f'fill="#0d1a2b" stroke="{color}" stroke-opacity=".65"/>'
            f'<rect x="{x+16}" y="{y+18}" width="5" height="{height-36}" rx="2" fill="{color}"/>'
            + text(x+34, y+36, label, 21, '#e2e8f0', 700)
            + text(x+34, y+60, detail, 15, '#cbd5e1'))
    if detail2:
        bits += text(x+34, y+82, detail2, 15, '#94a3b8')
    return bits


def wave_band(width, y_base, unused=None):
    """Draw deterministic sea bands: summed sinusoids, low amplitudes, no motion."""
    import math
    bits = []
    # Deterministic component tables (amplitude, cycles, phase) per band.
    bands = (((6.5, 2.0, 0.6), (3.0, 5.0, 2.1), (1.8, 9.0, 4.0)),       # hindmost, tallest
             ((4.5, 3.0, 1.9), (2.6, 7.0, 0.4), (1.4, 13.0, 2.8)),
             ((3.0, 4.0, 3.4), (2.0, 10.0, 1.2), (1.0, 17.0, 5.6)))
    for i, comps in enumerate(bands):
        y0 = y_base + i*13
        pts = []
        for x in range(0, width+8, 8):
            yy = y0
            for amp, cycles, phase in comps:
                yy += amp*math.sin(2*math.pi*cycles*x/width + phase)
            pts.append((x, yy))
        d = 'M' + ' L'.join(f'{x} {yy:.1f}' for x, yy in pts)
        color = '#0ea5e9' if i == 0 else '#14b8a6' if i == 1 else '#2dd4bf'
        bits.append(f'<path d="{d}" fill="none" stroke="{color}" stroke-opacity="{0.5-i*0.12}" stroke-width="1.6"/>')
    return '\n'.join(bits)


def ship_silhouette(x, y, scale=1.0, color='#f9a8d4'):
    """Small starboard-view hull silhouette riding the sea band."""
    s = scale
    bow = x + 56*s
    deck = y - 8*s
    keel = y + 7*s
    d = (f'M{x-48*s} {deck} L{x-40*s} {keel} L{bow-18*s} {keel} Q{bow} {keel} {bow} {deck-2*s} '
         f'L{x+20*s} {deck} Z')
    return (f'<path d="{d}" fill="{color}" fill-opacity=".8" stroke="{color}"/>'
            f'<path d="M{x+6*s} {deck} l4 {0} m2 0 l10 {0}" stroke="{color}" stroke-width="1"/>'
            f'<path d="M{x-30*s} {deck} V{deck-14*s} H{x-26*s} V{deck}" fill="{color}" fill-opacity=".6"/>')


def desktop_diagram():
    """Render the experiment loop: wind feeds the sea, the sea feeds the ships."""
    x0, w, gap = 44, 250, 32
    bits = []
    for i, (label, d1, d2) in enumerate(CONFIG['stages']):
        x = x0 + i*(w+gap)
        bits.append(card(x, 258, w, label, d1, COLORS[i], 94, d2))
        if i < 3:
            bits.append(line(x+w, 305, x+w+gap, 305, True))
    bits.append(wave_band(1200, 436))
    bits.append(ship_silhouette(1010, 444))
    return '\n'.join(bits)


def hero(mobile=False):
    """Render the full desktop hero or a readable two-column phone variant."""
    width, height = (640, 700) if mobile else (1200, 480)
    bits = frame(width, height, CONFIG['title'], CONFIG['description'])
    center = width//2
    bits += [text(center, 54, 'REAL-TIME · DETERMINISTIC · SCIENTIFICALLY GROUNDED', 14, '#94a3b8', 700, 'middle')
             if not mobile else
             text(center, 50, 'THE WAVE LAB', 14, '#94a3b8', 700, 'middle'),
             text(center, 118 if mobile else 132, CONFIG['title'], 40 if mobile else 64,
                  'url(#heading)', 800, 'middle')]
    if mobile:
        for i, label in enumerate(CONFIG['tagline_lines']):
            bits.append(text(center, 155+i*30, label, 21, '#cbd5e1', anchor='middle'))
        for i, (label, detail) in enumerate(CONFIG['mobile_stages']):
            x, y = 24+(i % 2)*306, 232+(i//2)*120
            bits.append(card(x, y, 286, label, detail, COLORS[i], 92))
        bits.append(line(310, 278, 326, 278, True))
        bits.append(wave_band(640, 560))
        bits.append(ship_silhouette(520, 570, 0.9))
        bits += [text(center, 628, CONFIG['mobile_note'][0], 18, '#7dd3fc', 600, 'middle'),
                 text(center, 656, CONFIG['mobile_note'][1], 16, '#cbd5e1', anchor='middle')]
    else:
        bits += [text(center, 181, CONFIG['tagline'], 23, '#cbd5e1', anchor='middle'),
                 text(center, 220, CONFIG['eyebrow'], 14, '#94a3b8', 600, 'middle'),
                 desktop_diagram(),
                 text(600, 414, CONFIG['footer_band'], 15, '#94a3b8', 500, 'middle')]
    bits.append('</svg>\n')
    return '\n'.join(bits)


def stats():
    """Render static capability cards; repeat the facts as prose in the README."""
    bits = frame(1200, 176, CONFIG['title']+' at a glance', '; '.join(' — '.join(s for s in (v, l) if l) for v, l, _ in CONFIG['stats']))
    for i, (value, label, detail) in enumerate(CONFIG['stats']):
        x = 24+i*294
        bits += [f'<rect x="{x}" y="24" width="270" height="128" rx="18" fill="#0d1a2b" stroke="#334155"/>',
                 text(x+22, 76, value, 30, COLORS[i], 800),
                 text(x+22, 107, label, 18, '#e2e8f0', 600),
                 text(x+22, 132, detail, 14, '#94a3b8')]
    bits.append('</svg>\n')
    return '\n'.join(bits)


def main():
    """Generate deterministic adjacent assets, or check their bytes read-only."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='fail on asset drift without writing')
    args = parser.parse_args()
    base = Path(__file__).resolve().parent
    assets = {'hero.svg': hero(), 'hero-mobile.svg': hero(True), 'stats.svg': stats()}
    drift = []
    for name, content in assets.items():
        path = base/name
        if args.check:
            if not path.exists() or path.read_text(encoding='utf-8') != content:
                drift.append(name)
        else:
            path.write_text(content, encoding='utf-8')
    if drift:
        parser.exit(1, 'README asset drift: ' + ', '.join(drift) + '\n')
    print('README assets match' if args.check else 'Generated three README SVG assets')


if __name__ == '__main__':
    main()
