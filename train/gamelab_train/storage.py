"""Rows of different lengths kept without padding."""

import numpy as np


class Ragged:
    """Rows of `width` integers each, a different number per entry."""

    def __init__(self):
        self._flat, self._len = [], []
        self.flat = self.len = self.start = None

    def add(self, padded, counts):
        """Append entries from a padded array [n, L, width] with `counts` real rows each."""
        counts = np.asarray(counts, dtype=np.int64)
        real = np.arange(padded.shape[1])[None, :] < counts[:, None]
        self._flat.append(padded[real])
        self._len.append(counts)

    def close(self):
        self.flat = np.concatenate(self._flat)
        self.len = np.concatenate(self._len)
        self.start = np.cumsum(self.len) - self.len
        self._flat = self._len = None

    def __len__(self):
        return len(self.len)

    def take(self, entries):
        """Entries as a zero-padded array [b, L, width] and their lengths [b]."""
        n = self.len[entries]
        out = np.zeros((len(entries), max(int(n.max()), 1), self.flat.shape[1]), self.flat.dtype)
        real = np.arange(out.shape[1])[None, :] < n[:, None]
        first = np.cumsum(n) - n
        out[real] = self.flat[np.repeat(self.start[entries] - first, n) + np.arange(int(n.sum()))]
        return out, n
