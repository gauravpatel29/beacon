/**
 * ROI multiples, formatted the same way everywhere they appear.
 *
 * Past 10x the exact figure stops being information and starts being noise:
 * a channel at 340.18x is not meaningfully different from one at 512.06x, and
 * both are usually a small denominator rather than a real return. Showing
 * ">10x" says what the reader can actually use - this is off the scale - and
 * does not invite anyone to compare two numbers that cannot be compared.
 *
 * The threshold is on the magnitude, so a large negative reads "<-10x" rather
 * than being quietly passed through at full precision.
 */
export const ROI_CAP = 10;

export function formatRoi(value, { fallback = 'NA' } = {}) {
  const num = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(num)) {
    return fallback;
  }
  if (num > ROI_CAP) return `>${ROI_CAP}x`;
  if (num < -ROI_CAP) return `<-${ROI_CAP}x`;
  return `${num.toFixed(2)}x`;
}

/** True when the value is past the cap, for callers that style it differently. */
export function isRoiCapped(value) {
  const num = Number(value);
  return Number.isFinite(num) && Math.abs(num) > ROI_CAP;
}
