// What a sensible adstock and saturation looks like for a kind of channel.
//
// Auto Select fits these parameters from the data; this is the other half - a
// benchmark to sanity-check the fit against, and a starting point for a channel
// with too little history for the fit to mean much. A rep-call series that
// comes back with a 0.9 decay is worth a second look when detailing is known to
// fade in two to four weeks.
//
// The advice is keyed off the channel's NAME, which is a guess, so it is shown
// on request rather than applied automatically.

/**
 * The concrete settings each profile recommends.
 *
 * Kept as values, not prose: the reference app wrote the numbers into a
 * sentence ("Set Adstock Decay to 0.70, Adstock Horizon to 4-6 weeks..."),
 * which a user then had to retype into four dropdowns. These drive an Apply
 * button, so the advice and what gets applied cannot disagree.
 */
const PROFILES = [
  {
    match: /tv|broad|video/,
    tacticType: 'Mass Media / Television / CTV',
    adstockDecay: '0.60 - 0.80 (high memory retention)',
    adstockHorizon: '4 to 8 weeks',
    saturation: 'Log: ln(1 + k·x) with k ~ 1.0, or Power (p ~ 0.40)',
    rationale: 'Broad mass media builds awareness with a long carryover half-life. '
      + 'High frequency hits diminishing returns quickly through fatigue.',
    suggested: { normalization: 'none', decay: 0.7, horizon: 4, saturation: 'log', param: 1.0 },
  },
  {
    match: /call|det|rep|f2f/,
    tacticType: 'HCP Personal Detailing / Sales Rep Calls',
    adstockDecay: '0.40 - 0.60 (medium retention)',
    adstockHorizon: '2 to 4 weeks',
    saturation: 'Power: x^p (p ~ 0.50 - 0.60), or Log (k ~ 1.0)',
    rationale: 'Details have an immediate clinical impact, with memory decaying over '
      + 'two to four weeks. Frequency saturates after three or four calls per HCP per month.',
    suggested: { normalization: 'none', decay: 0.5, horizon: 2, saturation: 'power', param: 0.5 },
  },
  {
    match: /samp|voucher|copay/,
    tacticType: 'Physical Samples & Co-Pay Vouchers',
    adstockDecay: '0.20 - 0.30 (short, near-immediate)',
    adstockHorizon: '1 to 2 weeks',
    saturation: 'Power: x^p (p ~ 0.60), or linear',
    rationale: 'Samples lead directly to trial prescriptions with little long-term carryover.',
    suggested: { normalization: 'none', decay: 0.2, horizon: 1, saturation: 'power', param: 0.6 },
  },
  {
    match: /dig|sear|disp|soci|email|rte/,
    tacticType: 'Digital / Search / Social / Email / RTE',
    adstockDecay: '0.10 - 0.30 (fast decay)',
    adstockHorizon: '1 to 2 weeks',
    saturation: 'Log (k ~ 1.5 - 2.0)',
    rationale: 'Digital impressions trigger near-immediate action, and saturate quickly '
      + 'as the same audience stops noticing them.',
    suggested: { normalization: 'none', decay: 0.2, horizon: 1, saturation: 'log', param: 1.5 },
  },
  {
    match: /speak|symp|conf|event/,
    tacticType: 'Peer-to-Peer Speaker Programs & Symposia',
    adstockDecay: '0.60 - 0.75 (long clinical half-life)',
    adstockHorizon: '6 to 8 weeks',
    saturation: 'Log: ln(1 + k·x) (k ~ 1.0)',
    rationale: 'Peer influence changes prescribing behaviour over several subsequent '
      + 'treatment cycles rather than immediately.',
    suggested: { normalization: 'none', decay: 0.7, horizon: 8, saturation: 'log', param: 1.0 },
  },
];

const DEFAULT_PROFILE = {
  tacticType: 'General Marketing & Promotion Channel',
  adstockDecay: '0.40 - 0.50 (standard benchmark)',
  adstockHorizon: '2 to 4 weeks',
  saturation: 'Log: ln(1 + k·x), or Power (p = 0.50)',
  rationale: 'Standard promotional channel. Balances short-term lift against a '
    + 'multi-week memory decay.',
  suggested: { normalization: 'none', decay: 0.5, horizon: 2, saturation: 'log', param: 1.0 },
};

/** Guidance for one channel, matched on its name. Never null. */
export function getChannelGuidance(channelName) {
  const l = String(channelName || '').toLowerCase();
  return PROFILES.find((p) => p.match.test(l)) || DEFAULT_PROFILE;
}

/**
 * What a row will actually do to the series, in the engine's terms.
 *
 * Worth saying on the row, because the two controls interact in a way the
 * labels do not admit: `transform_single_channel` only applies geometric decay
 * when the decay is above zero AND the horizon is above zero. With a decay of
 * 0.0 and a horizon above zero the same horizon becomes a plain shift by that
 * many periods - the series is delayed, not smeared - and with a horizon of
 * zero neither happens whatever the decay says.
 */
export function describeAdstock(decay, horizon) {
  const d = Number(decay);
  const h = Number(horizon);
  if (!(h > 0)) return 'No carryover';
  if (d > 0) return `Decays over ${h} period${h === 1 ? '' : 's'}`;
  return `Shifts ${h} period${h === 1 ? '' : 's'} (no decay)`;
}
