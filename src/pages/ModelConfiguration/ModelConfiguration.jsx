import { useState, useEffect, useMemo } from 'react';
import Papa from 'papaparse';
import {
  ensureWorkflow,
  listFiles,
  getAvailableChannels,
  problemMessage,
  runRegression,
  runRidge,
  transformationApply,
  v2GetCsv,
  v2ListArds,
} from '../../services/api.js';
import { loadScreenState, recordStage } from '../../services/workflowState.js';
import { useScreenState } from '../../services/useScreenState.js';
import { buildApplyPayload, dependentNames } from '../../services/transformationSet.js';
import { rolesFor, rolesFromDatasets } from '../../services/columnRoles.js';
import { fmt } from '../../components/charts/chartTheme.js';
import PageFooterNav from '../../components/PageFooterNav/PageFooterNav.jsx';
import './ModelConfiguration.css';

// This screen used to fit the regression in the browser: a hand-rolled normal
// equations solve, with a 300ms "queued" pause in front of it so the status
// badge had something to show. Two problems with that beyond the theatre.
//
// It was a different model from the one the rest of the app is built around -
// no impactable sales, no spend, no ROI, no carryover-derived long-term
// factor, and no statsmodels summary - so nothing it produced could be carried
// into Model Output or Optimization. And inverting X'X by Gauss-Jordan on
// collinear media channels is exactly the case that goes singular, which the
// pivoting here papered over with a 1e-9 fallback rather than reporting.
//
// `/api/modelling` now does the fit. What is left here is configuration.

const GRAIN_LABELS = { hcp: 'HCP', dma: 'DMA' };

// The alphas the server's time-series CV searches, shown beside the fold
// slider so the alpha that comes back is a value from a known set.
const ALPHA_GRID = '0.001  0.01  0.1  1  2  4  8  10  20  50  100';

/** Rounds for display without pretending to a precision the fit does not have. */
const num = (v, dp = 4) => (Number.isFinite(Number(v)) ? Number(v).toFixed(dp) : '-');

/** A coefficient row's key. `Variable` is unique within one fit. */
const rowKey = (r) => r.Variable ?? r.variable ?? JSON.stringify(r);

/**
 * Step 3's starting point for Model Name: the dataset chosen in Step 1,
 * as-is. Strips a trailing file extension defensively (ARD names in this
 * app generally don't carry one, but an uploaded file's filename might).
 */
const defaultModelName = (ardMeta) => (ardMeta?.filename || '').replace(/\.(csv|xlsx?|tsv)$/i, '').trim();

function ModelConfiguration() {
  const [workflowId, setWorkflowId] = useState(null);
  const [allArds, setAllArds] = useState([]);
  const [isLoadingArds, setIsLoadingArds] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // The saved Data Transformation set, replayed to rebuild the frame the model
  // is fitted on. Null when nothing has been saved yet.
  const [savedSet, setSavedSet] = useState(null);
  // The categories declared on the ingestion screen, so the pickers here offer
  // the same shortlist the Transformation screen did.
  const [declaredRoles, setDeclaredRoles] = useState({});

  const [modelLevel, setModelLevel] = useState('hcp'); // 'hcp' | 'dma'
  // DMA only. Recorded on the run and shown in its label; the request itself is
  // identical either way, because the engine has no residual mode - see the
  // note rendered beside the picker.
  const [dmaMode, setDmaMode] = useState('standalone'); // 'standalone' | 'residual'
  const [residualSourceId, setResidualSourceId] = useState('');
  const [selectedArdFilename, setSelectedArdFilename] = useState('');
  // The ARD named by the saved state, read back once on restore. State rather
  // than a ref because the value is read while rendering.
  const [restoredArd, setRestoredArd] = useState('');

  // Both frames the modelling endpoints need, as CSV text.
  const [granularCsv, setGranularCsv] = useState('');
  const [transformedCsv, setTransformedCsv] = useState('');
  const [transformedColumns, setTransformedColumns] = useState([]);
  const [usingTransformedSet, setUsingTransformedSet] = useState(false);
  const [isPreparing, setIsPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState(null);

  // The user's explicit picks. '' means 'not overridden' - the derived values
  // further down fall back to the transformation set, then to a name match.
  const [dateColumnChoice, setDateColumnChoice] = useState('');
  const [geoColumnChoice, setGeoColumnChoice] = useState('');
  const [dependentChoice, setDependentChoice] = useState('');

  const [channels, setChannels] = useState([]);
  const [selectedChannels, setSelectedChannels] = useState([]);
  const [dateBounds, setDateBounds] = useState({ start: '', end: '' });
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [channelsError, setChannelsError] = useState(null);

  const [modelName, setModelName] = useState('');
  // Whether the user has hand-edited the name since it was last defaulted.
  // While false, Model Name tracks the Step 1 dataset choice; a manual edit
  // stops that tracking so it isn't silently overwritten, and picking a
  // different dataset in Step 1 resumes it (see the effect below).
  const [modelNameTouched, setModelNameTouched] = useState(false);
  const [modelType, setModelType] = useState('ols'); // 'ols' | 'ridge'

  // Ridge. The engine chooses alpha by cross-validation unless told otherwise,
  // and can be given a per-channel prior weight, which is how a channel with
  // known-good evidence is penalised less than one without.
  const [alphaMode, setAlphaMode] = useState('auto'); // 'auto' | 'manual'
  const [manualAlpha, setManualAlpha] = useState(1.0);
  const [cvSplits, setCvSplits] = useState(3);
  const [positiveCoef, setPositiveCoef] = useState(false);
  const [useCustomPenalties, setUseCustomPenalties] = useState(false);
  const [priorWeights, setPriorWeights] = useState({});

  const [runStatus, setRunStatus] = useState('idle'); // idle | running | complete | failed
  const [runError, setRunError] = useState(null);
  const [stage1, setStage1] = useState(null);
  const [showSummary, setShowSummary] = useState(false);

  const [modelHistory, setModelHistory] = useState([]);
  // Which history row is loaded into the form, so it can be highlighted.
  const [activeHistoryId, setActiveHistoryId] = useState('');

  useEffect(() => { recordStage('modelling'); }, []);

  // ── Load the workflow, its ARDs, and the saved transformation set ────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setIsLoadingArds(true);
      setLoadError(null);
      try {
        const id = await ensureWorkflow();
        if (cancelled) return;
        setWorkflowId(id);
        const [ards, transformation, uploads] = await Promise.all([
          v2ListArds(id),
          loadScreenState('transformation'),
          // A failure here costs the shortlist, not the screen.
          listFiles(id, { kind: 'upload' }).catch(() => ({ items: [] })),
        ]);
        if (cancelled) return;
        setAllArds(ards.items || []);
        setSavedSet(transformation || null);
        setDeclaredRoles(rolesFromDatasets(uploads.items));
      } catch (err) {
        if (!cancelled) setLoadError(problemMessage(err, 'Could not load ARDs for this workflow.'));
      } finally {
        if (!cancelled) setIsLoadingArds(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, []);

  // Dataset selection now comes first (Step 1) and spans every ARD, regardless
  // of grain — the old `ardsForLevel` filter assumed modelLevel was already
  // chosen, which is backwards from the new flow: the chosen ARD's own real
  // `.grain` field is what determines the level, not the other way around.
  //
  // Which ARD is open. Derived rather than synced through an effect: the list
  // arrives after the first render, and an effect that writes the selection
  // back on every such change is both an extra render and a stale-value
  // hazard - the prepare effect below would run once against the old
  // filename before the new one landed.
  //
  // `selectedArdFilename` is the user's override; it only counts while it
  // names an ARD that actually exists.
  const activeArd = useMemo(() => {
    if (!allArds.length) return '';
    const has = (name) => Boolean(name) && allArds.some((a) => a.filename === name);
    if (has(selectedArdFilename)) return selectedArdFilename;
    // The ARD from the saved state, else the one the transformation set was
    // built on - that is the only one with transformed channels in it.
    if (has(restoredArd)) return restoredArd;
    if (has(savedSet?.ard)) return savedSet.ard;
    return allArds[0].filename;
  }, [allArds, savedSet, selectedArdFilename, restoredArd]);

  const activeArdMeta = useMemo(
    () => allArds.find((a) => a.filename === activeArd) || null,
    [allArds, activeArd]
  );
  // Real metadata already carried on the ARD (set when it was built on Data
  // Stitching, based on whether an NPI or a DMA key is actually present) -
  // not a client-side guess from column names.
  const detectedGrain = (activeArdMeta?.grain || '').toLowerCase(); // 'hcp' | 'dma' | ''

  // Step 3's Model Name defaults to the Step 1 dataset choice, and stays in
  // sync with it - switching datasets updates the name again - right up
  // until the user types their own; `modelNameTouched` is cleared by the
  // Step 1 picker itself so a fresh dataset choice always gets a fresh
  // default, even after a previous manual edit.
  useEffect(() => {
    if (modelNameTouched || !activeArdMeta) return;
    const next = defaultModelName(activeArdMeta);
    if (next) setModelName(next);
  }, [activeArdMeta, modelNameTouched]);

  // Model Level (Step 2) now follows the selected dataset's own grain rather
  // than being picked first. Only re-synced when the detection actually
  // resolves to one of the two known grains, so a dataset with no `.grain`
  // metadata doesn't silently force the level to something wrong.
  useEffect(() => {
    if (detectedGrain === 'hcp' || detectedGrain === 'dma') setModelLevel(detectedGrain);
  }, [detectedGrain]);

  // ── Build both frames ────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeArd || !workflowId) return undefined;
    let cancelled = false;

    const prepare = async () => {
      setIsPreparing(true);
      setPrepareError(null);
      setChannels([]);
      setStage1(null);
      setRunStatus('idle');
      try {
        const rawCsv = await v2GetCsv(workflowId, activeArd);
        if (cancelled) return;
        setGranularCsv(rawCsv);

        // Replay the saved set against this ARD. The transformed frame is
        // deliberately never stored - it is derived data that this recipe
        // reproduces exactly - so it is rebuilt here rather than cached.
        const applicable = savedSet && savedSet.ard === activeArd;
        const payload = applicable ? buildApplyPayload(rawCsv, savedSet) : null;
        if (payload) {
          const applied = await transformationApply(payload);
          if (cancelled) return;
          setTransformedCsv(applied.csv_data || rawCsv);
          setTransformedColumns(applied.columns || []);
          setUsingTransformedSet(true);
        } else {
          // Honest fallback rather than a blocked screen: the endpoints accept
          // the raw frame for both, and the card above says which is in use.
          const cols = Papa.parse(rawCsv, { header: true, preview: 1 }).meta.fields || [];
          setTransformedCsv(rawCsv);
          setTransformedColumns(cols);
          setUsingTransformedSet(false);
        }
      } catch (err) {
        if (!cancelled) {
          setPrepareError(problemMessage(err, 'Could not prepare this dataset for modelling.'));
          setGranularCsv(''); setTransformedCsv(''); setTransformedColumns([]);
        }
      } finally {
        if (!cancelled) setIsPreparing(false);
      }
    };
    prepare();
    return () => { cancelled = true; };
  }, [activeArd, workflowId, savedSet]);

  // Column roles default to the transformation set's own choices - they are the
  // same decisions, already made on that screen - and stay overridable here.
  //
  // Derived, like the ARD above: a chosen column only counts while it exists in
  // the current frame, so switching ARD cannot leave the model pointed at a
  // date column that is no longer there.
  const pickColumn = (chosen, fromSet, nameTest) => {
    if (chosen && transformedColumns.includes(chosen)) return chosen;
    const saved = (fromSet || [])[0];
    if (saved && transformedColumns.includes(saved)) return saved;
    return transformedColumns.find(nameTest) || '';
  };
  const dateColumn = pickColumn(dateColumnChoice, savedSet?.dateKeys,
    (c) => /date|week|month|period/i.test(c));
  const geoColumn = pickColumn(geoColumnChoice, savedSet?.geoKeys,
    (c) => /npi|geo|dma|zip|region|territory/i.test(c));
  const dependentVariable = pickColumn(dependentChoice, savedSet?.dependentVars,
    (c) => /trx|nrx|sales|revenue|units/i.test(c));

  // The frame's columns carry a `_transformed` suffix; the categories were
  // declared against the raw names, so the suffix comes off before the lookup.
  const roleOf = (col) => {
    const base = String(col).replace(/_transformed$/, '');
    return rolesFor([base], declaredRoles)[base];
  };

  // A workflow whose files predate column categories has no declarations at
  // all, and an empty picker there would be worse than an unfiltered one.
  const kpiColumns = useMemo(() => {
    const matching = transformedColumns.filter((c) => roleOf(c) === 'Dependent Variable');
    return matching.length ? matching : transformedColumns;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transformedColumns, declaredRoles]);

  // Promotions and baselines are both modellable; a geography or a date that
  // slipped into the channel list is not.
  const channelColumns = useMemo(() => {
    const matching = channels.filter((c) => {
      const role = roleOf(c);
      return role === 'Independent Promotions' || role === 'Baseline Variables';
    });
    return matching.length ? matching : channels;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, declaredRoles]);

  const depNames = useMemo(
    () => {
      const base = dependentNames({ dependentVars: [dependentVariable] }, transformedColumns);
      return { ...base, dependent_variable: dependentVariable || base.dependent_variable };
    },
    [dependentVariable, transformedColumns]
  );

  // ── Ask the server which channels can be modelled ────────────────────────
  useEffect(() => {
    if (!transformedCsv || !dateColumn || !dependentVariable) return undefined;
    let cancelled = false;
    const fetchChannels = async () => {
      setChannelsError(null);
      try {
        const data = await getAvailableChannels({
          csv_data: transformedCsv,
          date_column: dateColumn,
          geo_column: geoColumn,
          ...depNames,
        });
        if (cancelled) return;
        const list = data.channels || [];
        setChannels(list);
        setSelectedChannels((prev) => {
          const kept = prev.filter((c) => list.includes(c));
          // First load: everything the engine offers, which is the set the
          // Transformation screen just produced.
          return kept.length ? kept : list;
        });
        const range = data.date_range || {};
        setDateBounds({ start: range.start || '', end: range.end || '' });
        setStartDate((prev) => (prev && prev >= range.start && prev <= range.end ? prev : range.start || ''));
        setEndDate((prev) => (prev && prev >= range.start && prev <= range.end ? prev : range.end || ''));
      } catch (err) {
        if (!cancelled) setChannelsError(problemMessage(err, 'Could not read the channels in this dataset.'));
      }
    };
    fetchChannels();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transformedCsv, dateColumn, geoColumn, dependentVariable]);

  // ── Persist the configuration ────────────────────────────────────────────
  // The hook still gates saving on the restore having run; nothing on this
  // screen needs to render differently while that is in flight.
  useScreenState('modelling', {
    ready: Boolean(transformedColumns.length),
    deps: [activeArd, modelLevel, dmaMode, residualSourceId, modelName, modelType, dateColumn, geoColumn,
           dependentVariable, selectedChannels, startDate, endDate, alphaMode, manualAlpha,
           cvSplits, positiveCoef, useCustomPenalties, priorWeights, modelHistory],
    snapshot: () => ({
      ard: activeArd,
      modelLevel, dmaMode, residualSourceId, modelName, modelType,
      dateColumn, geoColumn, dependentVariable,
      selectedChannels, startDate, endDate,
      alphaMode, manualAlpha, cvSplits, positiveCoef, useCustomPenalties, priorWeights,
      // Coefficients and summaries are not stored: they are the output of a
      // fit this configuration reproduces, and a stale copy would outlive the
      // ARD it was fitted on. What is kept is enough to identify a run.
      modelHistory,
      activeHistoryId,
    }),
    restore: (s) => {
      const str = (x) => typeof x === 'string';
      const arr = Array.isArray;
      if (str(s.ard)) setRestoredArd(s.ard);
      if (s.modelLevel === 'hcp' || s.modelLevel === 'dma') setModelLevel(s.modelLevel);
      if (s.dmaMode === 'standalone' || s.dmaMode === 'residual') setDmaMode(s.dmaMode);
      if (str(s.residualSourceId)) setResidualSourceId(s.residualSourceId);
      // This hook's restore can fire again after the user has already
      // switched datasets in Step 1 (e.g. while `ready` cycles during the
      // reload), replaying the ORIGINAL saved snapshot - for the PREVIOUS
      // dataset. Applying `s.modelName` unconditionally would then stomp the
      // fresh default just set for the newly chosen dataset. Guarded here:
      // only take the saved name when it belongs to the dataset the user
      // currently has selected (or no explicit Step 1 choice has been made
      // yet, i.e. the very first restore on page load).
      if (str(s.modelName) && (!selectedArdFilename || s.ard === selectedArdFilename)) {
        setModelName(s.modelName);
        setModelNameTouched(true);
      }
      if (s.modelType === 'ols' || s.modelType === 'ridge') setModelType(s.modelType);
      if (str(s.dateColumn)) setDateColumnChoice(s.dateColumn);
      if (str(s.geoColumn)) setGeoColumnChoice(s.geoColumn);
      if (str(s.dependentVariable)) setDependentChoice(s.dependentVariable);
      if (arr(s.selectedChannels)) setSelectedChannels(s.selectedChannels);
      if (str(s.startDate)) setStartDate(s.startDate);
      if (str(s.endDate)) setEndDate(s.endDate);
      if (s.alphaMode === 'auto' || s.alphaMode === 'manual') setAlphaMode(s.alphaMode);
      if (Number.isFinite(s.manualAlpha)) setManualAlpha(s.manualAlpha);
      if (Number.isFinite(s.cvSplits)) setCvSplits(s.cvSplits);
      if (typeof s.positiveCoef === 'boolean') setPositiveCoef(s.positiveCoef);
      if (typeof s.useCustomPenalties === 'boolean') setUseCustomPenalties(s.useCustomPenalties);
      if (s.priorWeights && typeof s.priorWeights === 'object') setPriorWeights(s.priorWeights);
      if (arr(s.modelHistory)) setModelHistory(s.modelHistory);
      if (str(s.activeHistoryId)) setActiveHistoryId(s.activeHistoryId);
    },
  });

  // ── Selection helpers ────────────────────────────────────────────────────
  const toggleIn = (list, setList) => (value) => {
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);
  };
  const toggleChannel = toggleIn(selectedChannels, setSelectedChannels);

  const validate = () => {
    if (!modelName.trim()) return 'Name this model before running it.';
    if (!activeArd) return 'Select an ARD table for this level.';
    if (!dateColumn) return 'Select the date column.';
    if (!geoColumn) return 'Select the geography column - impactable sales are summed per geography.';
    if (!dependentVariable) return 'Select a dependent variable.';
    if (!selectedChannels.length) return 'Select at least one channel to model.';
    if (!startDate || !endDate) return 'Set a training time period.';
    if (startDate > endDate) return 'The start of the training period is after its end.';
    if (modelType === 'ridge') {
      if (alphaMode === 'manual' && !(manualAlpha > 0)) return 'Alpha must be greater than zero.';
      if (alphaMode === 'auto' && !(cvSplits >= 2)) return 'Cross-validation needs at least 2 splits.';
    }
    if (modelLevel === 'dma' && dmaMode === 'residual' && !residualSourceId) {
      return 'Pick the HCP-level model this DMA model follows on from.';
    }
    return null;
  };

  const baseBody = () => ({
    transformed_csv: transformedCsv,
    granular_csv: granularCsv,
    date_column: dateColumn,
    geo_column: geoColumn,
    ...depNames,
    selected_channels: selectedChannels,
    start_date: startDate,
    end_date: endDate,
  });

  const ridgeBody = (stage) => ({
    ...baseBody(),
    alpha_mode: alphaMode,
    manual_alpha: Number(manualAlpha),
    cv_splits: Number(cvSplits),
    positive_coef: positiveCoef,
    use_custom_penalties: useCustomPenalties,
    // Only the weights for channels actually in the model; a weight left over
    // from a deselected channel would be sent for a column that is not there.
    prior_weights: Object.fromEntries(
      Object.entries(priorWeights).filter(([k]) => selectedChannels.includes(k))
    ),
    stage,
  });

  const handleRunModel = async () => {
    const message = validate();
    if (message) { setRunError(message); return; }
    setRunError(null);
    setRunStatus('running');
    setStage1(null);

    try {
      const s1 = modelType === 'ridge'
        ? await runRidge(ridgeBody(1))
        : await runRegression(baseBody());
      setStage1(s1);


      setRunStatus('complete');
      setModelHistory((prev) => [{
        id: `model-${Date.now()}`,
        name: modelName.trim(),
        level: modelLevel,
        type: modelType,
        label: modelLabel(),
        dmaMode: modelLevel === 'dma' ? dmaMode : null,
        residualSourceId: modelLevel === 'dma' && dmaMode === 'residual' ? residualSourceId : null,
        ard: activeArd,
        dependentVariable,
        selectedChannels,
        channels: selectedChannels.length,
        r2: s1.r_squared,
        adjR2: s1.adj_r_squared,
        rmse: s1.rmse,
        coefficients: s1.coefficients,
        summary: s1.summary,
        alpha: s1.alpha,
        startDate, endDate,
        createdAt: new Date().toISOString(),
      }, ...prev].slice(0, 30));
    } catch (err) {
      setRunStatus('failed');
      setRunError(problemMessage(err, 'The model run failed. Check the channel selection and the training window.'));
    }
  };

  // How a run identifies itself, matching the reference app:
  //   "Ridge Stage 1 (DMA - residual)"
  const modelLabel = () => {
    const estimator = modelType === 'ridge' ? 'Ridge' : 'OLS';
    const level = GRAIN_LABELS[modelLevel];
    const suffix = modelLevel === 'dma' ? ` - ${dmaMode}` : '';
    return `${estimator} Stage 1 (${level}${suffix})`;
  };

  const priorHcpModels = useMemo(
    () => modelHistory.filter((m) => m.level === 'hcp'),
    [modelHistory]
  );

  const isBusy = runStatus === 'running';
  const canRun = Boolean(transformedCsv && granularCsv && channels.length) && !isBusy;

  // Two models with the same name are two rows in the history that cannot be
  // told apart, which is the one thing that registry is for.
  const isDuplicateName = modelHistory.some(
    (m) => m.name.trim().toLowerCase() === modelName.trim().toLowerCase()
  );

  /** Put a history row's configuration back on the screen. */
  // Switching the Step 1 dataset sets the new default name in the same
  // update as the selection itself, rather than leaving it to the
  // `activeArdMeta` effect a render later. That effect still exists as a
  // fallback for non-interactive changes (initial load, restore), but doing
  // it synchronously here means there is never a render in between where
  // `selectedArdFilename` points at the new ARD while `modelName` still
  // reflects the old one - which is the gap that let a stale name get
  // captured and persisted by the auto-save, and come back after a reload.
  const handleSelectArd = (filename) => {
    setSelectedArdFilename(filename);
    setModelNameTouched(false);
    const meta = allArds.find((a) => a.filename === filename) || null;
    const next = meta ? defaultModelName(meta) : '';
    if (next) setModelName(next);
  };

  const loadFromHistory = (m) => {
    setActiveHistoryId(m.id);
    setModelName(m.name);
    setModelNameTouched(true);
    setModelLevel(m.level);
    setModelType(m.type);
    if (m.ard) setSelectedArdFilename(m.ard);
    if (m.dependentVariable) setDependentChoice(m.dependentVariable);
    if (Array.isArray(m.selectedChannels)) setSelectedChannels(m.selectedChannels);
    if (m.startDate) setStartDate(m.startDate);
    if (m.endDate) setEndDate(m.endDate);
    if (m.dmaMode) setDmaMode(m.dmaMode);
    if (m.residualSourceId) setResidualSourceId(m.residualSourceId);
    // The fit itself is not stored - it is reproducible from this - so the
    // results panel clears rather than showing numbers from another run.
    setStage1(null);
    setRunStatus('idle');
  };

  return (
    <div className="model-config-page">
      <div className="page-header">
        <div>
          <p className="page-header-title">Model Configuration</p>
          <p className="page-header-subtitle">
            Configure HCP or DMA models from saved transformation sets across OLS and Ridge
            regressions, with standalone or residual workflows and an interactive model history.
          </p>
        </div>
      </div>

      {isLoadingArds && <p className="mc-empty">Loading ARDs...</p>}
      {!isLoadingArds && loadError && <div className="mc-error-banner">{loadError}</div>}

      {!isLoadingArds && !loadError && (
        <>
          {/* ---- Step 1: dataset ---- */}
          <div className="mc-card">
            <p className="mc-section-title">Select Dataset (ARD / Transformed Table)</p>
            {allArds.length === 0 ? (
              <div className="mc-source-note">
                No ARDs found. Build one on the Data Stitching page, then save a
                transformation set for it.
              </div>
            ) : (
              <>
                <div className="mc-field" style={{ maxWidth: 560 }}>
                  <label>Select Dataset</label>
                  <select
                    value={activeArd}
                    onChange={(e) => handleSelectArd(e.target.value)}
                  >
                    {allArds.map((a) => (
                      <option key={a.filename} value={a.filename}>
                        {a.filename} ({GRAIN_LABELS[(a.grain || '').toLowerCase()] || 'Unknown grain'} &bull;{' '}
                        {(a.row_count ?? 0).toLocaleString()} rows)
                      </option>
                    ))}
                  </select>
                </div>

                {/* Real detection, not a guess: activeArdMeta.grain is the same
                    field Data Stitching set when the ARD was built, based on
                    whether an NPI or a DMA key was actually present in it. */}
                {/* <div className="grain-detection-banner">
                  <span className="grain-detection-text">
                    Column Key Detection:{' '}
                    {detectedGrain === 'hcp' && <strong>NPI Doctor Key detected. Recommended for HCP-level modelling.</strong>}
                    {detectedGrain === 'dma' && <strong>DMA Geography Key detected. Recommended for DMA-level modelling.</strong>}
                    {detectedGrain !== 'hcp' && detectedGrain !== 'dma' && <strong>Could not determine a grain for this dataset automatically.</strong>}
                  </span>
                  <span className="grain-pill-row">
                    <span className={`grain-pill${detectedGrain === 'hcp' ? ' active' : ''}`}>
                      HCP Grain {detectedGrain === 'hcp' ? '\u2713' : '\u2717'}
                    </span>
                    <span className={`grain-pill${detectedGrain === 'dma' ? ' active' : ''}`}>
                      DMA Grain {detectedGrain === 'dma' ? '\u2713' : '\u2717'}
                    </span>
                  </span>
                </div> */}

                {/* What the model will actually be built on, read off the
                    frame rather than assumed. */}
                {transformedColumns.length > 0 && (
                  <div className="dataset-summary">
                    <div>
                      <span>Date Column</span>
                      <strong>{dateColumn || '-'}</strong>
                    </div>
                    <div>
                      <span>Geography Key</span>
                      <strong>{geoColumn || '-'}</strong>
                    </div>
                    <div>
                      <span>Target Sales KPI</span>
                      <strong>{dependentVariable || '-'}</strong>
                    </div>
                    <div>
                      <span>Promotional IVs</span>
                      <strong>{channels.length} promotional channels</strong>
                    </div>
                  </div>
                )}

                <div className={`mc-source-note${usingTransformedSet ? ' is-ready' : ''}`}>
                  {isPreparing && 'Rebuilding the transformed dataset…'}
                  {!isPreparing && usingTransformedSet && (
                    <>
                      Modelling the transformation set
                      {savedSet?.transformSetName ? ` "${savedSet.transformSetName}"` : ''}
                      {' '}- {transformedColumns.length} columns, replayed from the saved configuration.
                    </>
                  )}
                  {!isPreparing && !usingTransformedSet && (
                    <>
                      No saved transformation set for this ARD, so the raw table is being modelled
                      as-is. Save a set on the Data Transformation screen to model adstocked,
                      saturated channels instead.
                    </>
                  )}
                </div>
              </>
            )}
          </div>

          {/* ---- Step 2: model level ---- */}
          {/* <div className="mc-card">
            <p className="mc-section-title">Step 2 - Model Level</p>
            <p className="mc-hint" style={{ marginTop: 0, marginBottom: 'var(--spacing-sm)' }}>
              Choose the aggregation level for this regression model based on detected dataset capabilities.
            </p>
            <div className="level-card-row">
              {[
                { id: 'hcp', label: 'HCP-Level Model', desc: 'Physician & Sales Rep grain' },
                { id: 'dma', label: 'DMA-Level Model', desc: 'Designated Market Area grain' },
              ].map((lvl) => {
                // If detection is unresolved (no .grain on this ARD), leave
                // both cards choosable rather than disabling both - an
                // unknown state shouldn't strand the user with no path
                // forward.
                // Asymmetric on purpose: an HCP-detected dataset only allows
                // the HCP-Level Model (disables DMA); a DMA-detected dataset
                // allows BOTH cards, not just DMA. Unresolved detection (no
                // .grain on this ARD) leaves both open either way.
                const isAvailable = !detectedGrain || detectedGrain === 'dma' || detectedGrain === lvl.id;
                return (
                  <button
                    key={lvl.id}
                    type="button"
                    className={`level-card${modelLevel === lvl.id ? ' selected' : ''}${!isAvailable ? ' disabled' : ''}`}
                    onClick={() => { if (isAvailable) setModelLevel(lvl.id); }}
                    disabled={!isAvailable}
                    title={!isAvailable ? `This dataset's detected grain doesn't match ${lvl.label}.` : undefined}
                  >
                    <strong>{lvl.label}</strong>
                    <span>{lvl.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {prepareError && <div className="mc-error-banner">{prepareError}</div>} */}

          {/* Everything downstream needs a frame. Dimmed rather than hidden, so
              the shape of the screen does not change while it loads. */}
          <div className={transformedColumns.length ? '' : 'mc-disabled'}>
            {/* ---- Step 3: model setup ---- */}
            <div className="mc-card">
              <p className="mc-section-title">Model Setup</p>
              <div className="mc-field-row three">
                <div className="mc-field required">
                  <label>Model Name</label>
                  <input
                    type="text" value={modelName} maxLength={200}
                    className={isDuplicateName ? 'is-duplicate' : ''}
                    onChange={(e) => { setModelName(e.target.value); setModelNameTouched(true); }}
                    placeholder="e.g. HCP OLS Baseline Model"
                  />
                  {isDuplicateName && (
                    <p className="mc-warn">A model with this name is already in the history.</p>
                  )}
                </div>
                <div className="mc-field required">
                  <label>Start Date</label>
                  <input
                    type="date" value={startDate}
                    min={dateBounds.start} max={endDate || dateBounds.end}
                    onChange={(e) => setStartDate(e.target.value)}
                  />
                </div>
                <div className="mc-field required">
                  <label>End Date</label>
                  <input
                    type="date" value={endDate}
                    min={startDate || dateBounds.start} max={dateBounds.end}
                    onChange={(e) => setEndDate(e.target.value)}
                  />
                </div>
              </div>
              {dateBounds.start && (
                <p className="mc-hint">Data covers {dateBounds.start} to {dateBounds.end}.</p>
              )}

              <div className="mc-field" style={{ marginTop: 'var(--spacing-md)' }}>
                <label>Model Type</label>
                <div className="model-type-row">
                  <button
                    className={`model-type-btn${modelType === 'ols' ? ' selected' : ''}`}
                    onClick={() => setModelType('ols')}
                  >
                    OLS (Ordinary Least Squares)
                  </button>
                  <button
                    className={`model-type-btn${modelType === 'ridge' ? ' selected' : ''}`}
                    onClick={() => setModelType('ridge')}
                  >
                    Ridge Regression (L2)
                  </button>
                  {/* Present and disabled, as in the reference app: the option
                      exists in the roadmap, not in the engine. */}
                  <button className="model-type-btn" disabled>
                    Bayesian MMM
                    <span className="disabled-tag">Coming soon</span>
                  </button>
                </div>
              </div>
            </div>

            {/* ---- DMA configuration ---- */}
            {modelLevel === 'dma' && (
              <div className="mc-card">
                <p className="mc-section-title">DMA Configuration Mode</p>
                <div className="dma-mode-toggle">
                  <button
                    className={dmaMode === 'standalone' ? 'active' : ''}
                    onClick={() => setDmaMode('standalone')}
                  >
                    Standalone
                  </button>
                  <button
                    className={dmaMode === 'residual' ? 'active' : ''}
                    onClick={() => setDmaMode('residual')}
                  >
                    Residual
                  </button>
                </div>

                {dmaMode === 'residual' && (
                  <>
                    <div className="mc-field required" style={{ maxWidth: 420 }}>
                      <label>HCP-Level Model This Follows</label>
                      <select value={residualSourceId} onChange={(e) => setResidualSourceId(e.target.value)}>
                        <option value="">Select a prior HCP-level model...</option>
                        {priorHcpModels.map((m) => (
                          <option key={m.id} value={m.id}>{m.name} (R² {num(m.r2, 3)})</option>
                        ))}
                      </select>
                    </div>
                    {priorHcpModels.length === 0 && (
                      <p className="mc-empty">
                        No HCP-level models run yet - run one first to reference it here.
                      </p>
                    )}
                    <p className="residual-note">
                      Residual mode labels this run as following on from the selected HCP model.
                      The fit itself is the same standalone regression - the engine has no
                      residual estimator, so nothing here silently changes the model.
                    </p>
                  </>
                )}
              </div>
            )}

            {/* ---- Ridge configuration ---- */}
            {modelType === 'ridge' && (
              <div className="mc-card">
                <p className="mc-section-title">Ridge Configuration</p>
                <div className="mc-field-row">
                  <div className="mc-field">
                    <label>Alpha Selection Strategy</label>
                    <div className="model-type-row">
                      {/* <button
                        className={`model-type-btn${alphaMode === 'auto' ? ' selected' : ''}`}
                        onClick={() => setAlphaMode('auto')}
                      >
                        Auto (time-series CV)
                      </button> */}
                      <button
                        className={`model-type-btn${alphaMode === 'manual' ? ' selected' : ''}`}
                        onClick={() => setAlphaMode('manual')}
                      >
                        Manual alpha
                      </button>
                    </div>

                    {alphaMode === 'manual' ? (
                      <div className="mc-field required" style={{ marginTop: 'var(--spacing-sm)' }}>
                        <label>Regularization Alpha (λ)</label>
                        <input
                          type="number" step="0.5" min="0.0001" value={manualAlpha}
                          onChange={(e) => setManualAlpha(Number(e.target.value))}
                        />
                      </div>
                    ) : (
                      <div style={{ marginTop: 'var(--spacing-sm)' }}>
                        <div className="cv-slider-head">
                          {/* <span>CV folds: <strong>{cvSplits}</strong></span> */}
                          {/* The grid the server searches, so the alpha that
                              comes back is a value from a known set rather
                              than a number out of nowhere. */}
                          {/* <span className="alpha-grid">Grid: {ALPHA_GRID}</span> */}
                        </div>
                        {/* <input
                          type="range" min="2" max="10" value={cvSplits}
                          onChange={(e) => setCvSplits(Number(e.target.value))}
                          className="cv-slider"
                        /> */}
                      </div>
                    )}
                  </div>

                  <div className="mc-field">
                    <label>Regularization Constraints</label>
                    <label className="mc-check">
                      <input
                        type="checkbox" checked={positiveCoef}
                        onChange={(e) => setPositiveCoef(e.target.checked)}
                      />
                      Enforce non-negative marketing coefficients
                    </label>
                    <label className="mc-check">
                      <input
                        type="checkbox" checked={useCustomPenalties}
                        onChange={(e) => setUseCustomPenalties(e.target.checked)}
                      />
                      Custom prior shrinkage weights per channel
                    </label>
                  </div>
                </div>

                {useCustomPenalties && (
                  <div className="prior-weight-grid">
                    {selectedChannels.map((c) => (
                      <div className="mc-field" key={c}>
                        <label title={c} className={c.endsWith('_transformed') ? 'is-transformed-label' : ''}>{c}</label>
                        <input
                          type="number" step="0.1" min="0.1"
                          value={priorWeights[c] ?? 1}
                          onChange={(e) => setPriorWeights((prev) => ({
                            ...prev, [c]: Number(e.target.value),
                          }))}
                        />
                      </div>
                    ))}
                    {!selectedChannels.length && <p className="mc-empty">Select channels first.</p>}
                    <p className="mc-hint">
                      A weight above 1 shrinks that channel less than the others; below 1, more.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ---- Step 4: variables ---- */}
            <div className="mc-card">
              <p className="mc-section-title">Variable Selection (From Transformed Set)</p>
              {channelsError && <div className="mc-error-banner">{channelsError}</div>}

              {/* Date and geography are not chosen here: they come from the
                  transformation set, and Step 2 shows which ones are in force.
                  Offering them again invited a model keyed on one column while
                  the frame was built around another. */}
              <div className="mc-field required" style={{ maxWidth: 460 }}>
                <label>Dependent Variable (Target Sales KPI)</label>
                <select value={dependentVariable} onChange={(e) => setDependentChoice(e.target.value)}>
                  <option value="">Select...</option>
                  {kpiColumns.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
                <p className="mc-hint">
                  {kpiColumns.length} column(s) categorised as Dependent Variable at ingestion.
                </p>
              </div>
              {depNames.dependent_variable_user_input !== depNames.dependent_variable && (
                <p className="mc-hint">
                  Fitting on <code>{depNames.dependent_variable_user_input}</code>; sales totals and
                  ROI are taken from <code>{depNames.dependent_variable}</code> in the raw ARD.
                </p>
              )}

              <div className="mc-field required" style={{ marginTop: 'var(--spacing-md)' }}>
                <label>
                  Independent Variables (Transformed Marketing Promotions)
                  {' '}({selectedChannels.length} of {channelColumns.length} selected)
                </label>
                <div className="var-pill-box">
                  {channelColumns.map((c) => {
                    const isTransformed = c.endsWith('_transformed');
                    return (
                      <span
                        key={c}
                        className={`var-pill${selectedChannels.includes(c) ? ' selected' : ''}${isTransformed ? ' is-transformed' : ''}`}
                        onClick={() => toggleChannel(c)}
                      >
                        {selectedChannels.includes(c) ? '' : '+ '}{c}
                      </span>
                    );
                  })}
                  {!channelColumns.length && (
                    <span className="mc-empty">No modellable channels in this dataset.</span>
                  )}
                </div>
                <p className="selected-count-note">
                  <button type="button" className="mc-link" onClick={() => setSelectedChannels(channelColumns)}>
                    Select all
                  </button>
                  {' | '}
                  <button type="button" className="mc-link" onClick={() => setSelectedChannels([])}>
                    Clear
                  </button>
                </p>
              </div>
            </div>

            {/* ---- Run ---- */}
            <div className="mc-card">
              {runError && <div className="mc-error-banner">{runError}</div>}
              <div className="run-row">
                <div>
                  <p className="run-ready-title">
                    Ready to run {GRAIN_LABELS[modelLevel]} {modelType.toUpperCase()}
                    {modelLevel === 'dma' ? ` (${dmaMode})` : ''}
                  </p>
                  <p className="run-ready-note">
                    {selectedChannels.length} transformed tactics regressed against{' '}
                    {dependentVariable || 'the KPI'}
                  </p>
                </div>
                <button className="run-model-btn" onClick={handleRunModel} disabled={!canRun}>
                  {isBusy ? 'Running Regression…' : 'Run Regression'}
                </button>
                {runStatus !== 'idle' && (
                  <span className={`run-status-badge ${runStatus}`}>
                    {runStatus === 'running' && 'Running…'}
                    {runStatus === 'complete' && 'Complete'}
                    {runStatus === 'failed' && 'Failed'}
                  </span>
                )}
              </div>
            </div>

            {/* ---- Results ---- */}
            {stage1 && (
              <>
                <div className="mc-card">
                  <p className="mc-section-title">
                    Results{modelName.trim() ? `: ${modelName.trim()}` : ''}
                  </p>
                  <p className="mc-hint" style={{ marginTop: 0, marginBottom: 'var(--spacing-sm)' }}>
                    {modelLabel()} · {selectedChannels.length} channels · {startDate} to {endDate}
                  </p>
                  <div className="result-stat-row">
                    <div className="result-stat-card">
                      <p className="result-stat-value">{num(stage1.r_squared, 4)}</p>
                      <p className="result-stat-label">R² (Fit)</p>
                    </div>
                    <div className="result-stat-card">
                      <p className="result-stat-value">{num(stage1.adj_r_squared, 4)}</p>
                      <p className="result-stat-label">Adjusted R²</p>
                    </div>
                    <div className="result-stat-card">
                      <p className="result-stat-value">{num(stage1.rmse, 2)}</p>
                      <p className="result-stat-label">RMSE</p>
                    </div>
                    {/* Ridge returns the alpha it settled on; OLS has none, so
                        that slot shows the window instead. */}
                    {/* {stage1.alpha != null ? (
                      <div className="result-stat-card">
                        <p className="result-stat-value">{String(stage1.alpha)}</p>
                        <p className="result-stat-label">Best Alpha</p>
                      </div>
                    ) : (
                      <div className="result-stat-card">
                        <p className="result-stat-value" style={{ fontSize: '0.8rem' }}>
                          {startDate} → {endDate}
                        </p>
                        <p className="result-stat-label">Modelling Period</p>
                      </div>
                    )} */}
                  </div>

                  <p className="mc-card-heading" style={{ marginTop: 'var(--spacing-md)' }}>
                    Estimated Coefficients &amp; Impactable Attribution
                  </p>
                  <CoefficientTable rows={stage1.coefficients} />
                </div>

                {/* Which alpha won, and by how much. */}
                {Array.isArray(stage1.cv_results) && stage1.cv_results.length > 0 && (
                  <div className="mc-card">
                    <p className="mc-section-title">Cross-Validation Results (CV Split Scores)</p>
                    <CoefficientTable rows={stage1.cv_results} />
                  </div>
                )}

                {stage1.summary && (
                  <div className="mc-card">
                    <p className="mc-section-title">Regression Statistical Summary</p>
                    <button
                      type="button" className="mc-link"
                      onClick={() => setShowSummary((v) => !v)}
                    >
                      {showSummary ? 'Hide' : 'Show'} full summary
                    </button>
                    {showSummary && <pre className="model-summary">{stage1.summary}</pre>}
                  </div>
                )}
              </>
            )}

            {/* ---- History ---- */}
            <div className="mc-card">
              <p className="mc-section-title">Model History &amp; Iteration Registry</p>
              <p className="transform-section-desc">
                Click any row to load its configuration back into the screen for editing and review.
              </p>
              {modelHistory.length === 0 ? (
                <p className="mc-empty">No models run yet. Configure and run a model above.</p>
              ) : (
                <div className="history-table-wrap">
                  <table className="history-table">
                    <thead>
                      <tr>
                        <th>Model Name</th><th>Level</th><th>Type</th><th>Target KPI</th>
                        <th>R²</th><th>Adj. R²</th><th>RMSE</th><th>Training Window</th><th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modelHistory.map((m) => (
                        <tr
                          key={m.id}
                          className={activeHistoryId === m.id ? 'is-active' : ''}
                          onClick={() => loadFromHistory(m)}
                          title="Load this configuration"
                        >
                          <td className="history-name">{m.name}</td>
                          <td>
                            <span className={`grain-badge ${m.level}`}>
                              {GRAIN_LABELS[m.level] || m.level}
                            </span>
                          </td>
                          <td>{String(m.type).toUpperCase()}</td>
                          <td>{m.dependentVariable || '-'}</td>
                          <td><strong>{num(m.r2, 4)}</strong></td>
                          <td>{num(m.adjR2, 4)}</td>
                          <td>{num(m.rmse, 2)}</td>
                          <td className="history-window">{m.startDate} → {m.endDate}</td>
                          <td><span className="history-status">Complete</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <PageFooterNav currentStepId="model-configuration" />
    </div>
  );
}

/**
 * The coefficient table the engine returns.
 *
 * Columns are rendered from the keys present rather than a fixed list: stage 1,
 * stage 2 and the combined decomposition return overlapping but different
 * shapes, and hardcoding one of them would silently drop the others' columns.
 */
// Any column whose header names it as a percentage (e.g. "Impactable (%)")
// gets rounded to a consistent 1 decimal place here, rather than trusting
// whatever precision fmt() or the backend happens to produce — handles the
// value arriving either as a plain number or as an already "36.9276%"-style
// string, so rounding is guaranteed either way.
//
// A negative share is floored at 0%. A channel cannot take sales away from the
// total it is being decomposed out of, so a negative value here is an artefact
// of the fit - a coefficient that came out below zero on a collinear or sparse
// channel - rather than a quantity anybody can act on.
//
// Only the displayed share is floored. The coefficient, impactable sales and
// ROI on the same row are left exactly as the engine returned them, so a
// negative fit is still visible where it carries meaning.
function formatPercentCell(raw) {
  if (raw === null || raw === undefined || raw === '') return '-';
  const num = Number(String(raw).replace('%', ''));
  if (!Number.isFinite(num)) return String(raw);
  return `${Math.max(0, num).toFixed(1)}%`;
}

/**
 * One percentage column, floored at zero and rescaled to total exactly 100.0.
 *
 * Two things stop the raw shares adding up on their own. Flooring the
 * negatives removes weight without giving it back, so what is left over-counts
 * the total; and the engine's own shares only sum to 100 when the fit
 * reconstructs the dependent variable exactly, which ridge and a two-stage
 * split do not.
 *
 * Rounding is done by largest remainder rather than per cell: rounding each
 * share independently to one decimal leaves a column reading 99.9% or 100.1%,
 * which is exactly the kind of total somebody checks with a calculator. The
 * leftover tenths go to the rows with the largest fractional parts, so the
 * numbers on screen add to 100.0 as written.
 *
 * Returns one entry per row: a formatted string, or null for a cell that was
 * not a number and should be rendered as it arrived.
 */
function percentColumn(rows, column) {
  const values = rows.map((r) => {
    const raw = r[column];
    if (raw === null || raw === undefined || raw === '') return null;
    const num = Number(String(raw).replace('%', ''));
    return Number.isFinite(num) ? Math.max(0, num) : null;
  });

  const total = values.reduce((sum, v) => sum + (v || 0), 0);
  // Every share floored away, or a column of blanks: there is no total to
  // divide by, and inventing one would be worse than showing zeroes.
  if (!(total > 0)) return values.map((v) => (v === null ? null : '0.0%'));

  // Work in tenths of a percent so the rounding is exact integer arithmetic.
  const exact = values.map((v) => (v === null ? null : (v / total) * 1000));
  const floors = exact.map((v) => (v === null ? null : Math.floor(v)));
  const assigned = floors.reduce((sum, v) => sum + (v || 0), 0);

  // Hand the remaining tenths to the largest fractional parts.
  const order = exact
    .map((v, i) => ({ i, frac: v === null ? -1 : v - Math.floor(v) }))
    .filter((e) => e.frac >= 0)
    .sort((a, b) => b.frac - a.frac);

  const tenths = [...floors];
  let left = 1000 - assigned;
  for (let n = 0; n < order.length && left > 0; n += 1, left -= 1) {
    tenths[order[n].i] += 1;
  }

  return tenths.map((v) => (v === null ? null : `${(v / 10).toFixed(1)}%`));
}

function CoefficientTable({ rows }) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return <p className="mc-empty">No coefficients returned.</p>;

  // `Impactable %` is the raw number behind the formatted `Impactable (%)`;
  // showing both would be the same column twice.
  const hidden = new Set(['Impactable %']);
  const columns = Object.keys(list[0]).filter((c) => !hidden.has(c));
  const numeric = (v) => typeof v === 'number';
  const isPercentColumn = (c) => c.trim().endsWith('(%)');

  // Each percentage column is resolved once, across every row, because making
  // a column total 100 is not a decision a single cell can take.
  const shares = Object.fromEntries(
    columns.filter(isPercentColumn).map((c) => [c, percentColumn(list, c)])
  );

  return (
    <div className="coef-table-wrap">
      <table className="coef-table">
        <thead>
          <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {list.map((r, rowIndex) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td
                  key={c}
                  className={c === 'Coefficient' && numeric(r[c])
                    ? (r[c] >= 0 ? 'coef-positive' : 'coef-negative') : ''}
                >
                  {isPercentColumn(c)
                    // A cell the column could not read as a number keeps
                    // whatever it arrived as.
                    ? (shares[c][rowIndex] ?? formatPercentCell(r[c]))
                    : (numeric(r[c]) ? fmt(r[c]) : (r[c] ?? '-'))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default ModelConfiguration;