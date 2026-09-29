/**
 * ROI multiples formatting.
 * Formats full-precision raw ROI and Long-Term ROI (e.g. 65.09x, 2.45x, -16.61x).
 */

export function formatRoi(value, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const fallback = opts.fallback ?? 'NA';
  const dp = opts.dp ?? 2;
  const num = Number(value);

  if (value === null || value === undefined || value === '' || !Number.isFinite(num)) {
    return fallback;
  }
  return `${num.toFixed(dp)}x`;
}

export function isRoiCapped() {
  return false;
}