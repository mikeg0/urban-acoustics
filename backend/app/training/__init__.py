"""Pi-side classifier training pipeline (Track 1).

Operates on the 30-band 1/3-octave spectrograms the Pi already publishes
to ``spectrogram_frames`` — no FLAC download, no audio model. Outputs a
``pi_head.npz`` that the on-device classifier loads with pure numpy.
"""
