import { useState, useEffect, useMemo } from 'react';
import PageFooterNav from '../../components/PageFooterNav/PageFooterNav.jsx';
import './ModelOutput.css';

const HISTORY_KEY = 'mmm_model_history';
const FINALIZED_KEY = 'mmm_finalized_model';
const spendKeyFor = (modelId) => `mmm_spend_${modelId}`;

// ─── Channel bucket classification (baseline vs promotion types) ───────────
// Pattern-matched from channel/column names — there's no explicit "channel
// category" field anywhere upstream, so this is a best-effort heuristic.
// Anything that doesn't match a known pattern falls into "Other Marketing"
// rather than being force-fit into one of the three named buckets.
function classifyChannel(name) {
  const n = name.toLowerCase();
  if (/dtc/.test(n)) return 'dtc';
  if (/call|sample|speaker|detail/.test(n)) return 'personal';
  if (/rte|remote|email|npp|digital_hcp|web/.test(n)) return 'npp';
  return 'other';
}

const BUCKET_LABELS = {
  baseline: 'Baseline',
  personal: 'Personal Promotion',
  npp: 'NPP Promotion',
  dtc: 'DTC Promotion',
  other: 'Other Marketing',
};

const BUCKET_COLORS = {
  baseline: '#94a3b8',
  personal: '#1d4ed8',
  npp: '#10b981',
  dtc: '#f59e0b',
  other: '#8b5cf6',
};

// ─── Illustrative benchmark reference table ────────────────────────────────
// NOTE: there is no real external benchmark data source wired into this
// project. These numbers are placeholder/illustrative only, clearly labeled
// as such in the UI, structured so a real dataset can drop in later using
// the exact same lookup shape (therapy|maturity|dynamic -> overallImpactPct
// + channelROI list).
const THERAPY_TYPES = ['acute', 'chronic', 'recurring'];
const MATURITY_STAGES = ['Launch Year 1', 'Year 2-3', 'Year 4+'];
const MARKETING_DYNAMICS = ['high competition', 'medium competition', 'low competition'];

function lookupBenchmark(therapy, maturity, dynamic) {
  // Deterministic pseudo-variation so different combinations show different
  // (but stable) numbers, without needing 27 hand-authored rows.
  const seed = (therapy + maturity + dynamic).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const base = 28 + (seed % 15); // 28-42% overall impact
  return {
    overallImpactPct: base,
    channelROI: [
      { channel: 'Personal Promotion', roi: (2.2 + (seed % 7) * 0.15).toFixed(2) },
      { channel: 'NPP Promotion', roi: (1.6 + (seed % 5) * 0.12).toFixed(2) },
      { channel: 'DTC Promotion', roi: (1.1 + (seed % 4) * 0.1).toFixed(2) },
    ],
  };
}

function mean(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; }

function ModelOutput() {
  const [modelHistory, setModelHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
  });
  const [finalizedId, setFinalizedId] = useState(() => localStorage.getItem(FINALIZED_KEY) || '');

  const finalizedModel = modelHistory.find((m) => m.id === finalizedId) || null;

  const [spendByChannel, setSpendByChannel] = useState({});
  useEffect(() => {
    if (!finalizedModel) { setSpendByChannel({}); return; }
    try {
      const stored = JSON.parse(localStorage.getItem(spendKeyFor(finalizedModel.id)) || '{}');
      setSpendByChannel(stored);
    } catch { setSpendByChannel({}); }
  }, [finalizedModel?.id]);

  const [responseChannel, setResponseChannel] = useState('');
  useEffect(() => {
    if (finalizedModel?.coefficients?.length) setResponseChannel(finalizedModel.coefficients[0].name);
  }, [finalizedModel?.id]);

  const [therapyType, setTherapyType] = useState('');
  const [maturityStage, setMaturityStage] = useState('');
  const [marketingDynamic, setMarketingDynamic] = useState('');

  const handleFinalize = (modelId) => {
    setFinalizedId(modelId);
    localStorage.setItem(FINALIZED_KEY, modelId);
  };

  const updateSpend = (channel, value) => {
    setSpendByChannel((prev) => {
      const next = { ...prev, [channel]: value };
      try { localStorage.setItem(spendKeyFor(finalizedModel.id), JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // ---- Deep-dive: real contribution per channel, from real fitted stats ----
  const deepDive = useMemo(() => {
    if (!finalizedModel) return [];
    return finalizedModel.coefficients.map((c) => {
      const stats = finalizedModel.predictorStats?.[c.name] || {};
      const contribution = c.value * (stats.sum ?? 0);
      const spend = Number(spendByChannel[c.name]) || 0;
      const roi = spend > 0 ? contribution / spend : null;
      return { ...c, bucket: classifyChannel(c.name), contribution, stats, spend, roi };
    });
  }, [finalizedModel, spendByChannel]);

  // ---- High-level impact: baseline (intercept × n) + bucketed contributions ----
  const highLevelImpact = useMemo(() => {
    if (!finalizedModel) return null;
    const baselineTotal = finalizedModel.intercept * finalizedModel.n;
    const buckets = { baseline: baselineTotal, personal: 0, npp: 0, dtc: 0, other: 0 };
    deepDive.forEach((d) => { buckets[d.bucket] += d.contribution; });
    const total = Object.values(buckets).reduce((a, b) => a + b, 0);
    return { buckets, total: total || 1 };
  }, [finalizedModel, deepDive]);

  const responseCurveData = useMemo(() => {
    if (!finalizedModel || !responseChannel) return null;
    const coef = finalizedModel.coefficients.find((c) => c.name === responseChannel);
    const stats = finalizedModel.predictorStats?.[responseChannel];
    if (!coef || !stats) return null;
    const steps = 20;
    const points = Array.from({ length: steps + 1 }, (_, i) => {
      const x = stats.min + (i / steps) * (stats.max - stats.min);
      return { x, y: coef.value * x };
    });
    return { points, coef: coef.value, stats };
  }, [finalizedModel, responseChannel]);

  const benchmark = useMemo(() => {
    if (!therapyType || !maturityStage || !marketingDynamic) return null;
    return lookupBenchmark(therapyType, maturityStage, marketingDynamic);
  }, [therapyType, maturityStage, marketingDynamic]);

  const modelOverallImpactPct = useMemo(() => {
    if (!highLevelImpact) return null;
    const promo = highLevelImpact.total - highLevelImpact.buckets.baseline;
    return (promo / highLevelImpact.total) * 100;
  }, [highLevelImpact]);

  return (
    <div className="model-output-page">
      <div className="page-header">
        <div>
          <p className="page-header-title">Model Output</p>
          <p className="page-header-subtitle">
            Run OLS regression with impactable % attribution, ROI, and Long Term ROI calculations.
          </p>
        </div>
      </div>

      {/* ---- Model runs list ---- */}
      <div className="mo-card">
        <p className="mo-section-title">Model Runs</p>
        <p className="mo-section-desc">Every model run from Model Configuration.</p>
        {modelHistory.length === 0 ? (
          <p className="mo-empty">No models have been run yet go to Model Configuration to run one first.</p>
        ) : (
          <div className="runs-table-wrapper">
            <table className="runs-table">
              <thead>
                <tr><th>Name</th><th>Level</th><th>Type</th><th>R²</th><th>N</th><th>Date</th><th></th></tr>
              </thead>
              <tbody>
                {modelHistory.map((m) => (
                  <tr key={m.id} className={m.id === finalizedId ? 'is-finalized' : ''}>
                    <td><strong>{m.name}</strong></td>
                    <td><span className="grain-badge">{m.level.toUpperCase()}</span></td>
                    <td>{m.type.toUpperCase()}</td>
                    <td>{m.r2.toFixed(3)}</td>
                    <td>{m.n}</td>
                    <td>{new Date(m.createdAt).toLocaleDateString()}</td>
                    <td>
                      {m.id === finalizedId ? (
                        <span className="finalized-badge">✓ Finalized</span>
                      ) : (
                        <button className="finalize-btn" onClick={() => handleFinalize(m.id)}>Finalize</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!finalizedModel ? (
        <p className="mo-empty">Finalize a model above to see its outputs.</p>
      ) : (
        <>
          {/* ---- High-level impact ---- */}
          <div className="mo-card">
            <p className="mo-section-title">High-Level Impact — {finalizedModel.name}</p>
            <p className="mo-section-desc">
              Baseline vs. promotional impact, computed as coefficient × total observed exposure per channel,
              classified by channel name pattern (personal / NPP / DTC / other).
            </p>
            {highLevelImpact && (
              <>
                <div className="impact-bar-wrapper">
                  {Object.entries(highLevelImpact.buckets).map(([bucket, val]) => {
                    const pct = Math.max(0, (val / highLevelImpact.total) * 100);
                    if (pct < 0.5) return null;
                    return (
                      <div key={bucket} className="impact-bar-segment" style={{ width: `${pct}%`, backgroundColor: BUCKET_COLORS[bucket] }}>
                        {pct >= 6 ? `${pct.toFixed(0)}%` : ''}
                      </div>
                    );
                  })}
                </div>
                <div className="impact-legend">
                  {Object.entries(highLevelImpact.buckets).map(([bucket, val]) => (
                    <div key={bucket} className="impact-legend-item">
                      <span className="impact-legend-swatch" style={{ backgroundColor: BUCKET_COLORS[bucket] }} />
                      {BUCKET_LABELS[bucket]}: <strong>{((val / highLevelImpact.total) * 100).toFixed(1)}%</strong>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* ---- Channel deep-dive + spend input ---- */}
          <div className="mo-card">
            <p className="mo-section-title">Channel-Level Deep-Dive &amp; Spend Input</p>
            <p className="mo-section-desc">
              Enter spend per channel to compute ROI. Spend is saved per finalized model in this browser.
            </p>
            <div className="deep-dive-table-wrapper">
              <table className="deep-dive-table">
                <thead>
                  <tr><th>Channel</th><th>Bucket</th><th>Coefficient</th><th>Contribution</th><th>% of Total</th><th>Spend</th><th>ROI</th></tr>
                </thead>
                <tbody>
                  {deepDive.map((d) => (
                    <tr key={d.name}>
                      <td><strong>{d.name}</strong></td>
                      <td><span className="bucket-badge" style={{ backgroundColor: `${BUCKET_COLORS[d.bucket]}22`, color: BUCKET_COLORS[d.bucket] }}>{BUCKET_LABELS[d.bucket]}</span></td>
                      <td>{d.value.toFixed(4)}</td>
                      <td>{d.contribution.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                      <td>{highLevelImpact ? ((d.contribution / highLevelImpact.total) * 100).toFixed(1) : '—'}%</td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          placeholder="Enter spend"
                          value={spendByChannel[d.name] ?? ''}
                          onChange={(e) => updateSpend(d.name, e.target.value)}
                        />
                      </td>
                      <td>
                        {d.roi === null ? (
                          <span className="roi-value neutral">—</span>
                        ) : (
                          <span className={`roi-value ${d.roi >= 1 ? 'good' : 'bad'}`}>{d.roi.toFixed(2)}x</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* ---- Response curve viewer ---- */}
          <div className="mo-card">
            <p className="mo-section-title">Response Curve Viewer</p>
            <p className="mo-section-desc">
              Predicted contribution vs. the channel's observed (Adstock/Saturation-transformed) exposure range from Data Transformation.
            </p>
            <div className="mo-note">
              This plots contribution against the already-transformed variable, not raw spend — the regression itself
              is linear in that space. Mapping this back to a raw-spend diminishing-returns curve requires linking to
              the channel's saturation parameters from Data Transformation, which isn't wired between these two modules yet.
            </div>
            <div className="rc-select-row">
              <label>Channel</label>
              <select value={responseChannel} onChange={(e) => setResponseChannel(e.target.value)}>
                {finalizedModel.coefficients.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </div>
            {responseCurveData && (
              <div className="rc-chart-wrapper">
                <ResponseCurveChart points={responseCurveData.points} xLabel={`${responseChannel} (transformed exposure)`} yLabel="Predicted contribution" />
              </div>
            )}
          </div>

          {/* ---- Benchmark panel ---- */}
          <div className="mo-card">
            <p className="mo-section-title">Benchmark Comparison</p>
            <div className="mo-note">
              Benchmark figures below are illustrative reference values only — there's no live external benchmark
              data source connected yet. Swap `lookupBenchmark()` for a real API call once one exists.
            </div>
            <div className="benchmark-controls-row">
              <div className="benchmark-field">
                <label>Therapy Type</label>
                <select value={therapyType} onChange={(e) => setTherapyType(e.target.value)}>
                  <option value="">Select...</option>
                  {THERAPY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="benchmark-field">
                <label>Maturity Stage</label>
                <select value={maturityStage} onChange={(e) => setMaturityStage(e.target.value)}>
                  <option value="">Select...</option>
                  {MATURITY_STAGES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="benchmark-field">
                <label>Marketing Dynamic</label>
                <select value={marketingDynamic} onChange={(e) => setMarketingDynamic(e.target.value)}>
                  <option value="">Select...</option>
                  {MARKETING_DYNAMICS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>

            {!benchmark ? (
              <p className="mo-empty">Select all three filters to see the benchmark comparison.</p>
            ) : (
              <>
                <div className="benchmark-compare-row">
                  <div className="benchmark-stat-card">
                    <p className="benchmark-stat-value">{benchmark.overallImpactPct}%</p>
                    <p className="benchmark-stat-label">Benchmark Overall Impact</p>
                  </div>
                  <div className="benchmark-stat-card">
                    <p className="benchmark-stat-value">{modelOverallImpactPct?.toFixed(1)}%</p>
                    <p className="benchmark-stat-label">Your Model's Overall Impact</p>
                    {modelOverallImpactPct !== null && (
                      <p className="benchmark-vs-label">
                        {modelOverallImpactPct >= benchmark.overallImpactPct ? 'Above' : 'Below'} benchmark by{' '}
                        {Math.abs(modelOverallImpactPct - benchmark.overallImpactPct).toFixed(1)} pts
                      </p>
                    )}
                  </div>
                </div>

                <table className="benchmark-table">
                  <thead><tr><th>Channel Bucket</th><th>Benchmark ROI</th><th>Your ROI</th><th>vs. Benchmark</th></tr></thead>
                  <tbody>
                    {benchmark.channelROI.map((b) => {
                      const yourBucketRows = deepDive.filter((d) => BUCKET_LABELS[d.bucket] === b.channel && d.roi !== null);
                      const yourRoi = yourBucketRows.length ? mean(yourBucketRows.map((d) => d.roi)) : null;
                      return (
                        <tr key={b.channel}>
                          <td>{b.channel}</td>
                          <td>{b.roi}x</td>
                          <td>{yourRoi !== null ? `${yourRoi.toFixed(2)}x` : '—'}</td>
                          <td>
                            {yourRoi !== null ? (
                              <span className={`benchmark-delta ${yourRoi >= Number(b.roi) ? 'above' : 'below'}`}>
                                {yourRoi >= Number(b.roi) ? '▲' : '▼'} {Math.abs(yourRoi - Number(b.roi)).toFixed(2)}x
                              </span>
                            ) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </>
      )}

      <PageFooterNav currentStepId="model-output" />
    </div>
  );
}

function ResponseCurveChart({ points, xLabel, yLabel }) {
  const width = 900, height = 280, padding = 45;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys, 0), maxY = Math.max(...ys, 1);
  const xScale = (v) => padding + ((v - minX) / (maxX - minX || 1)) * (width - padding * 2);
  const yScale = (v) => height - padding - ((v - minY) / (maxY - minY || 1)) * (height - padding * 2);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto' }}>
      {[0, 0.25, 0.5, 0.75, 1].map((t) => {
        const y = padding + t * (height - padding * 2);
        return <line key={t} x1={padding} x2={width - padding} y1={y} y2={y} stroke="#eef1f6" strokeWidth="1" />;
      })}
      <polyline points={points.map((p) => `${xScale(p.x)},${yScale(p.y)}`).join(' ')} fill="none" stroke="#1d4ed8" strokeWidth="2.5" />
      {points.map((p, i) => <circle key={i} cx={xScale(p.x)} cy={yScale(p.y)} r="3" fill="#1d4ed8" />)}
      <text x={width / 2} y={height - 6} fontSize="10" fill="#8a94a3" textAnchor="middle">{xLabel}</text>
      <text x={12} y={height / 2} fontSize="10" fill="#8a94a3" textAnchor="middle" transform={`rotate(-90, 12, ${height / 2})`}>{yLabel}</text>
    </svg>
  );
}

export default ModelOutput;