"""gunshots-prep.py -- cut the recorded gunfire clips for nz-audio.js (section 15c).

Source: The Free Firearm Sound Library, "Prepared SFX Library" (Still North
Media; Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney), CC0 1.0.
https://opengameart.org/content/the-free-firearm-sound-library

    python scripts/gunshots-prep.py "<path>/Prepared SFX Library" assets/gunshots
    node scripts/make-gunshots-asset.mjs

Every shot is cut at its onset with 1.5 ms of pre-roll, one microphone per
clip (the library's spaced pairs are not mono-compatible: summing L and R
comb-filters the blast, so each channel is its own variant instead),
resampled 96 -> 48 kHz, high-passed at 22 Hz, faded out, loudness-matched per
set (BS.1770 K-weighting over the first 250 ms, peaks held under -1 dBFS) and
encoded to mono MP3. Needs ffmpeg with libmp3lame, numpy and scipy.
"""
import sys, os, json, tempfile, numpy as np, subprocess, warnings
from scipy.io import wavfile
from scipy import signal
warnings.filterwarnings('ignore')
SRC = sys.argv[1].rstrip('/') + '/'
OUT = sys.argv[2].rstrip('/') + '/'
SR = 48000

def load(p):
    sr, d = wavfile.read(SRC + p)
    return sr, d.astype(np.float64) / 2**31

def kw(x):  # ITU-R BS.1770 K-weighting at 48 kHz
    x = signal.lfilter([1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585], x)
    return signal.lfilter([1.0, -2.0, 1.0], [1, -1.99004745483398, 0.99007225036621], x)

def lk(x, n=None):
    y = kw(x if n is None else x[:n])
    return -0.691 + 10 * np.log10(np.mean(y * y) + 1e-20)

HP = signal.butter(2, 22, 'highpass', fs=SR, output='sos')

# group, file, times (s), mode ('onset' = align to shot onset, 'abs' = cut from time), length s, fade-out start s, kbps
SPEC = [
    ('pistol_near',  'Walther PPQ/X_39P.wav', [1.406, 6.444, 10.660], 'onset', 0.60, 0.26, 112),
    ('pistol_far',   'Walther PPQ/X_31P.wav', [1.084, 5.242],         'onset', 1.30, 0.62, 80),
    ('rifle_near',   'AR-15/D_32P.wav',       [0.702, 5.646],         'onset', 0.55, 0.24, 112),
    ('rifle_far',    'AR-15/D_24P.wav',       [0.548, 3.908],         'onset', 1.40, 0.70, 80),
    ('shotgun_near', 'Nova/O_21P.wav',        [0.428, 3.462],         'onset', 0.90, 0.40, 112),
    ('shotgun_far',  'Nova/O_17P.wav',        [0.690, 3.704],         'onset', 1.60, 0.80, 80),
    ('pump_back',    'Model 12/K_22P.wav',    [4.180],                'abs',   0.27, 0.17, 96),
    ('pump_fwd',     'Model 12/K_22P.wav',    [4.680],                'abs',   0.30, 0.20, 96),
]
PRE = 0.0015
clips = []
for grp, f, times, mode, L, F, kbps in SPEC:
    sr, d = load(f)
    for ti, t in enumerate(times):
        for ch in (0, 1):
            x = d[:, ch]
            if mode == 'onset':
                i0, i1 = int((t - 0.03) * sr), int((t + 0.03) * sr)
                seg = np.abs(x[i0:i1]); k = int(np.argmax(seg > 0.25 * seg.max()))
                start = i0 + k - int(PRE * sr)
            else:
                start = int(t * sr)
            y = x[start:start + int((L + 0.01) * sr)]
            y = signal.resample_poly(y, 1, 2)[:int(L * SR)]          # 96k -> 48k
            y = signal.sosfilt(HP, y)
            n = len(y); tt = np.arange(n) / SR
            fi = int(0.0003 * SR); y[:fi] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(fi) / fi)
            fo = (tt >= F); ph = (tt[fo] - F) / (L - F)
            y[fo] *= 0.5 + 0.5 * np.cos(np.pi * np.clip(ph, 0, 1))
            win = int(0.25 * SR) if mode == 'onset' else None
            clips.append(dict(group=grp, src=f, t=t, ch=ch, y=y, lk=lk(y, win), kbps=kbps))

# one loudness target per group so every variant of a sound is equally loud;
# groups are leveled against each other in code. Peak ceiling -1 dBFS.
groups = {}
for c in clips: groups.setdefault(c['group'], []).append(c)
manifest = {}
for g, cs in groups.items():
    tgt = min(c['lk'] + (-1.0 - 20 * np.log10(np.abs(c['y']).max())) for c in cs)
    for i, c in enumerate(cs):
        gain = 10 ** ((tgt - c['lk']) / 20)
        y = c['y'] * gain
        name = f"{g}_{i}"
        tmp = os.path.join(tempfile.gettempdir(), name + '.wav')
        wavfile.write(tmp, SR, (np.clip(y, -1, 1) * 32767).astype(np.int16))
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', tmp, '-ac', '1', '-ar', str(SR),
                        '-c:a', 'libmp3lame', '-b:a', f"{c['kbps']}k", '-id3v2_version', '0',
                        OUT + name + '.mp3'], check=True)
        os.remove(tmp)
        pk = 20 * np.log10(np.abs(y).max())
        manifest.setdefault(g, []).append(dict(file=name + '.mp3', src=c['src'], shot_t=c['t'], channel=c['ch'],
                                               peak_dbfs=round(pk, 2), lk=round(tgt, 2), dur=round(len(y) / SR, 3)))
    print(f"{g:13s} {len(cs)} clips  target {tgt:6.2f} LK  pre-norm spread {max(c['lk'] for c in cs) - min(c['lk'] for c in cs):.1f} dB")
json.dump(manifest, open(OUT + 'manifest.json', 'w'), indent=1)
