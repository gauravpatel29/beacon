import { useEffect, useMemo, useState } from 'react';
import {
  commitSpec, detectGranularity, getFile, problemMessage,
} from '../../services/api.js';
import './GranularityPanel.css';

/**
 * Roll one source file up to a coarser time grain, before it is joined.
 *
 * This lived on the Data Ingestion screen, one file at a time, behind a tab.
 * Granularity is a joining concern rather than an ingestion one: two files at
 * different grains cannot be joined on a date, and that only becomes apparent
 * here. So it sits in front of the join, with a file picker of its own.
 *
 * The rollup is written into the file's manifest, so it is applied by the same
 * engine as every other spec change and survives a reload. Nothing is computed
 * in the browser.
 */

/** Which coarser grains a given grain can roll up to. */
const GRAIN_TARGETS = {
  Daily: ['Weekly', 'Monthly'],
  Weekly: ['Monthly'],
  Monthly: ['Yearly'],
};

const AGG_OPS = ['sum', 'average', 'min', 'max', 'product'];

/** A column's name after any rename in the committed spec. */
function renamedIn(spec, col) {
  const to = (spec?.live_updates?.column_renames || [])
    .find((r) => r.from === col)?.to;
  return to || col;
}

function GranularityPanel({ files, workflowId, onApplied }) {
  const [filename, setFilename] = useState('');
  const [detail, setDetail] = useState(null);      // the file's meta + spec
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const [dateCol, setDateCol] = useState('');
  const [geoCol, setGeoCol] = useState('');
  const [numOps, setNumOps] = useState({});
  const [target, setTarget] = useState('');

  const [detected, setDetected] = useState('');
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectNote, setDetectNote] = useState('');

  const [isApplying, setIsApplying] = useState(false);
  const [applyNote, setApplyNote] = useState('');

  // ── The chosen file's columns and current spec ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!filename || !workflowId) { setDetail(null); return; }
      setIsLoading(true);
      setError(null);
      setDetected(''); setDetectNote(''); setApplyNote('');
      try {
        const meta = await getFile(workflowId, filename);
        if (cancelled) return;
        setDetail(meta);
        // Reopen on whatever rollup is already committed for this file, so the
        // panel shows the current state rather than an empty form.
        const g = meta.spec?.granularity;
        setDateCol(g?.date_column || '');
        setGeoCol(g?.geo_column || '');
        setTarget(g?.to || '');
        setNumOps(g?.numeric || {});
      } catch (err) {
        if (!cancelled) setError(problemMessage(err, 'Could not load this file.'));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [filename, workflowId]);

  // Columns as they exist after the file's committed spec: a renamed or
  // dropped column must not be offered under a name the engine will reject.
  const columns = useMemo(() => detail?.columns || [], [detail]);

  // Everything that is not a key and is worth summing. The engine needs an
  // operation for each, so they are all listed rather than only the ones
  // somebody happened to change.
  const aggregatable = useMemo(
    () => columns.filter((c) => c !== dateCol && c !== geoCol),
    [columns, dateCol, geoCol]
  );

  // ── Detection, automatic once a date column is chosen ───────────────────
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!filename || !dateCol || !workflowId) { setDetected(''); return; }
      setIsDetecting(true);
      setDetectNote('');
      try {
        const res = await detectGranularity(workflowId, filename, { date_column: dateCol });
        if (cancelled) return;
        setDetected(res.granularity || '');
        setDetectNote(
          `${res.granularity} - ${res.distinct_dates} distinct dates, `
          + `${res.min_date} to ${res.max_date}.`
        );
      } catch (err) {
        if (cancelled) return;
        setDetected('');
        setDetectNote(problemMessage(err, 'Could not read a grain from this column.'));
      } finally {
        if (!cancelled) setIsDetecting(false);
      }
    };
    run();
    return () => { cancelled = true; };
  }, [filename, dateCol, workflowId]);

  const targets = GRAIN_TARGETS[detected] || [];
  const canApply = Boolean(filename && dateCol && geoCol && detected && target)
    && target !== detected && !isApplying;

  const apply = async () => {
    setIsApplying(true);
    setApplyNote('');
    try {
      // Merge into the committed spec rather than replacing it: a PATCH that
      // omitted live_updates would undo the renames and type casts this file
      // already carries.
      const spec = detail.spec || {};
      const numeric = {};
      for (const col of aggregatable) numeric[col] = numOps[col] || 'sum';

      await commitSpec(workflowId, filename, {
        ...(spec.config_metadata ? { config_metadata: spec.config_metadata } : {}),
        ...(spec.live_updates ? { live_updates: spec.live_updates } : {}),
        ...(spec.filters ? { filters: spec.filters } : {}),
        granularity: {
          from: detected,
          to: target,
          date_column: renamedIn(spec, dateCol),
          geo_column: renamedIn(spec, geoCol),
          numeric,
          categorical: {},
        },
      });
      setApplyNote(`Rolled ${filename} up from ${detected} to ${target}.`);
      onApplied?.(filename);
      // Re-read so the panel reflects what is now committed.
      setDetail(await getFile(workflowId, filename));
    } catch (err) {
      setApplyNote(problemMessage(err, 'Could not apply the rollup.'));
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="stitching-card gran-panel">
      <p className="stitching-section-title">Granularity (optional)</p>
      <p className="stitching-section-desc">
        Roll a file up to a coarser time grain before joining it. Two files at
        different grains cannot be joined on a date, so this is the place to
        line them up.
      </p>

      <div className="gran-row">
        <div className="gran-field">
          <label htmlFor="gran-file">File</label>
          <select id="gran-file" value={filename} onChange={(e) => setFilename(e.target.value)}>
            <option value="">Select a file...</option>
            {files.map((f) => (
              <option key={f.filename} value={f.filename}>
                {f.filename} ({(f.row_count ?? 0).toLocaleString()} rows)
              </option>
            ))}
          </select>
        </div>

        <div className="gran-field">
          <label htmlFor="gran-date">Date column</label>
          <select
            id="gran-date" value={dateCol} disabled={!columns.length}
            onChange={(e) => setDateCol(e.target.value)}
          >
            <option value="">Select...</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        <div className="gran-field">
          <label htmlFor="gran-geo">Grouping column</label>
          <select
            id="gran-geo" value={geoCol} disabled={!columns.length}
            onChange={(e) => setGeoCol(e.target.value)}
          >
            <option value="">Select...</option>
            {columns.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {isLoading && <p className="gran-note">Loading columns…</p>}
      {error && <div className="stitching-tab-error"><span>{error}</span></div>}

      {/* Detection runs on its own; there is no Detect button to forget. */}
      {dateCol && (
        <p className={`gran-note${detected ? ' is-ok' : ''}`}>
          {isDetecting ? 'Detecting grain…' : detectNote}
        </p>
      )}

      {detected && (
        <>
          <div className="gran-row">
            <div className="gran-field">
              <label htmlFor="gran-target">Roll up to</label>
              <select id="gran-target" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Select target grain...</option>
                {targets.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
              {!targets.length && (
                <p className="gran-note">
                  {detected} is the coarsest grain this file can be rolled up to.
                </p>
              )}
            </div>
          </div>

          {/* Every aggregatable column needs an operation. Listing only the
              ones somebody changed would silently sum the rest. */}
          {target && aggregatable.length > 0 && (
            <>
              <p className="gran-subhead">How to aggregate each column</p>
              <div className="gran-ops-grid">
                {aggregatable.map((col) => (
                  <div className="gran-field" key={col}>
                    <label title={col}>{col}</label>
                    <select
                      value={numOps[col] || 'sum'}
                      onChange={(e) => setNumOps((p) => ({ ...p, [col]: e.target.value }))}
                    >
                      {AGG_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="gran-actions">
            <button className="mapping-btn primary" disabled={!canApply} onClick={apply}>
              {isApplying ? 'Applying…' : 'Apply rollup'}
            </button>
            {target && target === detected && (
              <span className="gran-note">
                Already {detected}; choose a coarser grain to roll up.
              </span>
            )}
            {applyNote && <span className="gran-note is-ok">{applyNote}</span>}
          </div>
        </>
      )}
    </div>
  );
}

export default GranularityPanel;
