import { useState, useEffect, useMemo, useRef } from 'react';
import Papa from 'papaparse';
import {
  Bar, BarChart, CartesianGrid, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  ensureWorkflow, listFiles, problemMessage, transformationApply,
  transformationCorrelation, transformationPreviewSingle, v2GetCsv, v2ListArds,
} from '../../services/api.js';
import { recordStage } from '../../services/workflowState.js';
import { useScreenState } from '../../services/useScreenState.js';
import { roleMeta, rolePartition, rolesFor, rolesFromDatasets } from '../../services/columnRoles.js';
import { getChannelGuidance } from '../../services/channelGuidance.js';
import {
  configFor as sharedConfigFor,
  toDerivedVariables as sharedToDerivedVariables,
  toTransformation as sharedToTransformation,
} from '../../services/transformationSet.js';
import { ChartTooltip } from '../../components/charts/ChartTooltip.jsx';
import {
  AXIS_TICK, fmt, GRID, LINE_TYPE, X_LABEL, Y_LABEL,
} from '../../components/charts/chartTheme.js';
import PageFooterNav from '../../components/PageFooterNav/PageFooterNav.jsx';
import './DataTransformation.css';

// Statistics, histograms and response curves all come from the engine now;
// the local implementations of them were removed with the adstock maths.
function isNumericColumn(rows, col) {
  return rows.some((r) => typeof r[col] === 'number');
}

// Every method `normalize_series_vectorized` implements. Population scaling
// needs a Population column chosen in Step 1; without one the engine leaves the
// series alone, so the option says as much rather than failing quietly.
const NORMALIZATION_OPTIONS = [
  { value: 'none', label: 'None (Raw Volume)' },
  { value: 'population', label: 'Population Based (per Universe)' },
  { value: 'minmax', label: 'Min-Max Scaling [0, 1]' },
  { value: 'zscore', label: 'Z-Score (Standardized)' },
  { value: 'iqr', label: 'Robust / IQR Scaling' },
];

// The full range the engine accepts. 0.0 is not "no adstock": with a Horizon
// above zero the engine reads it as a pure shift by that many weeks, which is
// why it is labelled as a lag rather than as nothing.
const ADSTOCK_OPTIONS = [0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const HORIZON_OPTIONS = [
  { value: 1, label: '1 week' },
  { value: 2, label: '2 weeks' },
  { value: 4, label: '4 weeks (1 month)' },
  { value: 8, label: '8 weeks' },
];
// A pure delay applied beside the decay, sent as its own `Lag` key.
const PURE_LAG_OPTIONS = [
  { value: 0, label: '0 (none)' },
  { value: 1, label: '1 week' },
  { value: 2, label: '2 weeks' },
  { value: 3, label: '3 weeks' },
  { value: 4, label: '4 weeks' },
];
const SATURATION_OPTIONS = [
  { value: 'none', label: 'None (Linear)' },
  { value: 'log', label: 'Log: ln(1 + k·x)' },
  { value: 'power', label: 'Power: x^p' },
];

// Adstock, saturation and correlation are computed by the engine in
// core/processing.py, not here. They used to be reimplemented in this file; a
// second copy of the maths is a second thing to keep in step with the version
// the model is actually fitted with, and the two drift silently because both
// produce plausible numbers.

let derivedIdCounter = 0;

function DataTransformation() {
  const [workflowId, setWorkflowId] = useState(null);
  const [ards, setArds] = useState([]);
  const [selectedArdFilename, setSelectedArdFilename] = useState('');
  const [isLoadingArds, setIsLoadingArds] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // The CSV text exactly as stored, kept because the transformation engines
  // take the dataset rather than a parsed copy of it.
  const [activeCsv, setActiveCsv] = useState('');
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState(null);

  // Step 1
  const [dateKeys, setDateKeys] = useState([]);
  const [geoKeys, setGeoKeys] = useState([]);
  const [dependentVars, setDependentVars] = useState([]);
  const [zipKeys, setZipKeys] = useState([]);
  const [dmaKeys, setDmaKeys] = useState([]);
  const [popKeys, setPopKeys] = useState([]);
  const [carryover, setCarryover] = useState(false);
  // Linear-Log keeps the KPI in linear units and out of the transformable set;
  // Log-Log puts a log curve on it, which makes it a channel Step 3 configures.
  const [modelSpec, setModelSpec] = useState('linear_log'); // linear_log | log_log
  // KPI columns the user has chosen to keep out of the transformable set.
  // Empty by default: nothing is locked unless it is locked deliberately.
  const [lockedDeps, setLockedDeps] = useState([]);

  // Step 2
  const [selectedVars, setSelectedVars] = useState(new Set());
  // What the user declared each column IS, on the ingestion screen. Empty for a
  // workflow whose files predate column categories, in which case every
  // fallback below is the name-based guess this screen used to make on its own.
  const [declaredRoles, setDeclaredRoles] = useState({});
  const [derivedVars, setDerivedVars] = useState([]); // [{id, name, operator, parts}]
  const [derivedDraft, setDerivedDraft] = useState(null); // {name, operator, parts}
  // Which channel's benchmark panel is open, if any.
  const [guidanceFor, setGuidanceFor] = useState('');

  // Step 3: per-variable config
  const [configs, setConfigs] = useState({}); // { [varName]: {decay, horizon, saturation, param, source} }

  const [transformSetName, setTransformSetName] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);

  // Result of applying (post-Step-3-save)
  const [transformResult, setTransformResult] = useState(null); // { rows, transformedCols, corrThreshold... }
  const [inspectVar, setInspectVar] = useState('');
  const [corrThreshold, setCorrThreshold] = useState(0.7);
  const [correlation, setCorrelation] = useState(null);
  const [corrError, setCorrError] = useState(null);
  const [isScoringCorr, setIsScoringCorr] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  // The ARD a restored configuration belongs to. Consumed once by the loader,
  // so only that first load keeps the config instead of resetting it.
  const restoredArd = useRef(null);
  // The set-name field, so Save can send the user to it when it is empty.
  const setNameRef = useRef(null);
  // The set the user deliberately saved, with a signature of the config it
  // was saved from. Null until Save is pressed.
  const [savedSet, setSavedSet] = useState(null);

  // Remember where the user got to, so Resume reopens this screen instead
  // of always returning to Data Ingestion.
  useEffect(() => { recordStage('transformation'); }, []);

  // Everything the user chose on this screen. The transformed dataset itself
  // is not stored: it is reproducible from this config plus the ARD, and a
  // stale copy of it would outlive the data it was computed from.
  const stateRestored = useScreenState('transformation', {
    ready: Boolean(columns.length),
    deps: [selectedArdFilename, dateKeys, geoKeys, dependentVars, zipKeys, dmaKeys,
           popKeys, carryover, modelSpec, lockedDeps, selectedVars, derivedVars, configs, transformSetName,
           corrThreshold, inspectVar, savedSet],
    snapshot: () => ({
      ard: selectedArdFilename,
      dateKeys, geoKeys, dependentVars, zipKeys, dmaKeys, popKeys,
      carryover,
      modelSpec,
      // A Set does not survive JSON.
      selectedVars: Array.from(selectedVars),
      derivedVars,
      configs,
      transformSetName,
      corrThreshold,
      inspectVar: activeInspectVar,
      savedSet,
    }),
    restore: (s) => {
      // The ARD is restored by the loader effect below, which also refetches
      // its rows; setting it here would race that.
      if (Array.isArray(s.dateKeys)) setDateKeys(s.dateKeys);
      if (Array.isArray(s.geoKeys)) setGeoKeys(s.geoKeys);
      if (Array.isArray(s.dependentVars)) setDependentVars(s.dependentVars);
      if (Array.isArray(s.zipKeys)) setZipKeys(s.zipKeys);
      if (Array.isArray(s.dmaKeys)) setDmaKeys(s.dmaKeys);
      if (Array.isArray(s.popKeys)) setPopKeys(s.popKeys);
      if (typeof s.carryover === 'boolean') setCarryover(s.carryover);
      if (s.modelSpec === 'linear_log' || s.modelSpec === 'log_log') setModelSpec(s.modelSpec);
      if (Array.isArray(s.lockedDeps)) setLockedDeps(s.lockedDeps);
      if (Array.isArray(s.selectedVars)) setSelectedVars(new Set(s.selectedVars));
      if (Array.isArray(s.derivedVars)) setDerivedVars(s.derivedVars);
      if (s.configs && typeof s.configs === 'object') setConfigs(s.configs);
      if (typeof s.transformSetName === 'string') setTransformSetName(s.transformSetName);
      if (typeof s.corrThreshold === 'number') setCorrThreshold(s.corrThreshold);
      if (typeof s.inspectVar === 'string') setInspectVar(s.inspectVar);
      if (s.savedSet && typeof s.savedSet === 'object') setSavedSet(s.savedSet);
      restoredArd.current = s.ard || null;
    },
  });

  useEffect(() => {
    // Waits for the restore. Running concurrently would let this pick the
    // first ARD in the list before the saved choice had arrived.
    if (!stateRestored) return;
    (async () => {
      setIsLoadingArds(true);
      setLoadError(null);
      try {
        const id = await ensureWorkflow();
        setWorkflowId(id);
        const [data, uploads] = await Promise.all([
          v2ListArds(id),
          // Roles are declared per source file; an ARD is those files joined,
          // so they are merged into one map covering its columns. A failure
          // here costs the defaults, not the screen - hence the catch.
          listFiles(id, { kind: 'upload' }).catch(() => ({ items: [] })),
        ]);
        const items = data.items || [];
        setArds(items);
        setDeclaredRoles(rolesFromDatasets(uploads.items));
        if (items.length) {
          // Reopen the ARD the user was working on, when it still exists.
          const wanted = items.find((x) => x.filename === restoredArd.current);
          setSelectedArdFilename((wanted || items[0]).filename);
        }
      } catch (err) {
        setLoadError(problemMessage(err, 'Could not load ARDs for this workflow.'));
      } finally {
        setIsLoadingArds(false);
      }
    })();
  }, [stateRestored]);

  const loadArdData = async (filename) => {
    if (!filename || !workflowId) return;
    setIsLoadingData(true);
    setDataError(null);
    setTransformResult(null);
    try {
      const csvText = await v2GetCsv(workflowId, filename);
      setActiveCsv(csvText);
      const parsed = Papa.parse(csvText, { header: true, dynamicTyping: true, skipEmptyLines: true });
      const cols = parsed.meta.fields || [];
      setColumns(cols);
      setRows(parsed.data);

      // Loading a DIFFERENT ARD clears the configuration, because column names
      // chosen against one dataset rarely mean anything in another. Loading
      // the ARD a restored config was saved against must not: that is the
      // resume path, and resetting here would wipe the work a moment after
      // putting it back.
      // Not consumed: StrictMode mounts twice, so this runs twice for the same
      // file. Clearing it on the first pass let the second re-guess and wipe
      // the configuration that had just been restored. Comparing without
      // clearing is idempotent - and selecting a genuinely different ARD still
      // falls through to fresh guesses, which is the intended behaviour.
      const keepConfig = restoredArd.current === filename;
      if (!keepConfig) {
        // Step 1 is answered from what the user declared at ingestion rather
        // than re-guessed here. The old guesses were a second, weaker set of
        // rules - `/npi|dma|zip|id$/` took the first match and had no way to be
        // told it was wrong - and they disagreed with the ones Data Review and
        // Model Configuration were each making separately.
        //
        // `rolePartition` falls back to the same kind of name matching for any
        // column with no declared role, so an ARD built before column
        // categories existed still opens with something sensible selected.
        const part = rolePartition(cols, declaredRoles);
        setDateKeys(part['Time Variable'].slice(0, 1));
        setGeoKeys(part['Cross-sectional Variable'].slice(0, 1));
        setDependentVars(part['Dependent Variable'].slice(0, 1));
        setZipKeys([]); setDmaKeys([]);
        setPopKeys(part['Baseline Variables'].slice(0, 1));
        // Promotions are what a marketing mix model transforms, so they start
        // ticked - the same default as the reference app.
        setSelectedVars(new Set(part['Independent Promotions']));
        setDerivedVars([]);
        setDerivedDraft(null);
        setConfigs({});
      }
    } catch (err) {
      setDataError(problemMessage(err, 'Could not load this dataset.'));
      setActiveCsv('');
      setRows([]);
      setColumns([]);
    } finally {
      setIsLoadingData(false);
    }
  };

  useEffect(() => {
    if (selectedArdFilename && workflowId) loadArdData(selectedArdFilename);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedArdFilename, workflowId]);

  const lockedKeys = useMemo(
    () => new Set([...dateKeys, ...geoKeys, ...zipKeys, ...dmaKeys, ...popKeys]),
    [dateKeys, geoKeys, zipKeys, dmaKeys, popKeys]
  );

  // A KPI is transformable unless the user locks it. It used to be locked
  // unconditionally, which made "strictly locked from transformation" a rule
  // of the screen rather than a decision anyone had taken.
  const eligibleColumns = useMemo(
    () => columns.filter((c) => !lockedKeys.has(c)
      && !lockedDeps.includes(c)
      && isNumericColumn(rows, c)),
    [columns, rows, lockedKeys, lockedDeps]
  );

  const togglePill = (setter, list, col) => {
    setter(list.includes(col) ? list.filter((c) => c !== col) : [...list, col]);
  };

  const toggleVarSelect = (col) => {
    setSelectedVars((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
  };

  const selectAllEligible = () => setSelectedVars(new Set(eligibleColumns));
  const deselectAll = () => setSelectedVars(new Set());

  // The builder stays a draft until Add: a half-specified derived variable
  // would otherwise reach the engine, which needs at least two real columns.
  const openDerivedBuilder = () => {
    if (eligibleColumns.length < 2) return;
    setDerivedDraft({ name: '', operator: '+', parts: eligibleColumns.slice(0, 2) });
  };

  const cancelDerivedBuilder = () => setDerivedDraft(null);

  const toggleDerivedPart = (col) => {
    setDerivedDraft((prev) => {
      if (!prev) return prev;
      const parts = prev.parts.includes(col)
        ? prev.parts.filter((c) => c !== col)
        : [...prev.parts, col];
      return { ...prev, parts };
    });
  };

  // The default name spells out the expression, which is what makes a column
  // called "CALLS+EMAILS" readable three screens later in the model output.
  const derivedDefaultName = (draft) => draft.parts.join(draft.operator).toUpperCase();

  const commitDerivedVariable = () => {
    if (!derivedDraft || derivedDraft.parts.length < 2) return;
    const name = (derivedDraft.name.trim() || derivedDefaultName(derivedDraft)).toUpperCase();
    // A derived name that collides with a real column would shadow it in the
    // frame the engine builds, so the two cannot share one.
    if (columns.includes(name) || derivedVars.some((d) => d.name === name)) {
      setApplyError(`"${name}" is already a column. Give the derived variable another name.`);
      return;
    }
    setApplyError(null);
    derivedIdCounter += 1;
    setDerivedVars((prev) => [...prev, {
      id: derivedIdCounter, name, operator: derivedDraft.operator, parts: derivedDraft.parts,
    }]);
    setSelectedVars((prev) => new Set(prev).add(name));
    setDerivedDraft(null);
  };

  const removeDerivedVariable = (id, name) => {
    setDerivedVars((prev) => prev.filter((d) => d.id !== id));
    setSelectedVars((prev) => {
      const next = new Set(prev);
      next.delete(name);
      return next;
    });
    setConfigs((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const configFor = (name) => sharedConfigFor(configs, name);

  const updateConfig = (name, updates) => {
    setConfigs((prev) => ({ ...prev, [name]: { ...configFor(name), ...updates, source: 'manual' } }));
  };

  // ── Engine payloads ─────────────────────────────────────────────────────
  // Shared with Model Configuration, which replays this same set to rebuild
  // the transformed frame the regression is fitted on. Two copies would mean
  // two frames from one saved set.
  const toTransformation = (name) => sharedToTransformation(configs, name);
  const toDerivedVariables = () => sharedToDerivedVariables(derivedVars);

  // Auto Select was removed: the reference application no longer offers it,
  // and a per-channel fit that nothing else in the app agrees with is worse
  // than the benchmarks the guidance panel gives. The endpoint still exists
  // server-side; nothing here calls it.


  // Roles for the columns in THIS frame, so a derived variable or a column
  // from a file ingested before categories existed still gets one.
  const columnRoles = rolesFor(columns, declaredRoles);

  const selectedList = Array.from(selectedVars);

  // Derived rather than synced through an effect: the inspected channel is
  // always one of the currently selected variables, falling back to the first
  // when the chosen one is deselected. No extra render, nothing to keep in step.
  const activeInspectVar = selectedList.includes(inspectVar)
    ? inspectVar
    : (selectedList[0] || '');

  const handleSaveApply = async () => {
    if (!dateKeys.length || !geoKeys.length || !dependentVars.length) {
      setApplyError('Set Date, Geo, and Dependent Variable columns in Step 1 first.');
      return;
    }
    if (selectedList.length === 0) {
      setApplyError('Select at least one variable to transform in Step 2.');
      return;
    }
    setApplyError(null);
    setIsApplying(true);

    try {
      // Run on the server: derived variables, then normalization -> adstock ->
      // saturation per channel, then the optional carryover column. This is the
      // same engine the model is fitted with, so what is previewed here is what
      // gets modelled.
      const data = await transformationApply({
        csv_data: activeCsv,
        geo_column: geoKeys[0],
        date_column: dateKeys[0],
        dependent_variable: dependentVars[0],
        transformations: selectedList.map(toTransformation),
        derived_variables: toDerivedVariables(),
        pop_column: popKeys[0] || null,
        add_carryover: carryover,
      });

      // The full transformed dataset comes back as CSV; the `preview` field is
      // only the first 60 rows, which would quietly make the correlation panel
      // and the inspector chart describe a sample rather than the data.
      const parsed = Papa.parse(data.csv_data, {
        header: true, dynamicTyping: true, skipEmptyLines: true,
      });
      const outputRows = parsed.data;

      const transformedCols = selectedList
        .map((raw) => ({ raw, transformed: `${raw}_transformed`, config: configFor(raw) }))
        .filter((c) => (data.columns || []).includes(c.transformed));

      setTransformResult({
        rows: outputRows,
        transformedCols,
        dependentVar: dependentVars[0],
        columns: data.columns || [],
        rowCount: data.rows ?? outputRows.length,
        csv: data.csv_data,
      });
      setInspectVar(transformedCols[0]?.raw || '');
    } catch (err) {
      setApplyError(problemMessage(err, 'Could not apply the transformations.'));
      setTransformResult(null);
    } finally {
      setIsApplying(false);
    }
  };

  // What was applied, as one comparable string. Saving records this, and the
  // card goes back to Unsaved the moment any of it changes - a set that still
  // read "Saved" after the config moved underneath it would be a lie.
  const appliedSignature = useMemo(() => JSON.stringify({
    ard: selectedArdFilename,
    dateKeys, geoKeys, dependentVars, popKeys, carryover,
    transformations: selectedList.map(toTransformation),
    derived: toDerivedVariables(),
  }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [selectedArdFilename, dateKeys, geoKeys, dependentVars, popKeys, carryover,
   selectedVars, configs, derivedVars]);

  // Saved only when a set was saved AND nothing has changed since.
  const isSaved = Boolean(savedSet) && savedSet.signature === appliedSignature;

  const saveTransformationSet = () => {
    if (!transformResult) return;

    // A set with no name is a set nobody can identify later. Rather than
    // inventing one, point at the field that needs filling in - it lives up in
    // Step 3, which is easy to miss from the button down here.
    if (!transformSetName.trim()) {
      setApplyError('Name this transformation set in Step 3 before saving it.');
      setNameRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setNameRef.current?.focus();
      return;
    }

    setApplyError(null);
    setSavedSet({
      name: transformSetName.trim(),
      signature: appliedSignature,
      savedAt: new Date().toISOString(),
      // The transformed frame is deliberately not stored: it is 26k rows of
      // derived data that this config reproduces exactly, and a stale copy
      // would outlive the ARD it came from.
      columns: transformResult.columns,
      rowCount: transformResult.rowCount,
    });
  };

  // ---- Validation section ----
  // Correlation over the transformed columns, computed by the same engine the
  // Data Review screen uses, so the two screens cannot disagree about the same
  // pair of channels.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const columnsToScore = (transformResult?.transformedCols || [])
        .map((c) => c.transformed).slice(0, 8);
      if (!transformResult?.csv || !columnsToScore.length) {
        if (!cancelled) setCorrelation(null);
        return;
      }
      setIsScoringCorr(true);
      try {
        const data = await transformationCorrelation({
          csv_data: transformResult.csv,
          columns: columnsToScore,
          // 0 so the response carries every pair. The slider filters what is
          // shown; it does not change the correlations themselves, so it must
          // not cause another upload of the whole dataset.
          threshold: 0,
        });
        if (!cancelled) { setCorrelation(data); setCorrError(null); }
      } catch (err) {
        if (!cancelled) {
          setCorrelation(null);
          setCorrError(problemMessage(err, 'Could not score correlation.'));
        }
      } finally {
        if (!cancelled) setIsScoringCorr(false);
      }
    })();
    return () => { cancelled = true; };
    // Deliberately NOT keyed on corrThreshold. The slider steps in 0.05, so
    // dragging it once re-ran this twenty times, each posting the entire
    // transformed dataset; the connection gave out and the screen reported the
    // backend as unreachable.
  }, [transformResult]);

  // The server returns the matrix column-major ({ colA: { colB: r } }); the
  // table renders rows, so it is pivoted once here.
  const correlationMatrix = useMemo(() => {
    if (!correlation?.columns?.length) return [];
    const cols = correlation.columns;
    return cols.map((c1) => ({
      col: c1,
      values: cols.map((c2) => Number(correlation.matrix?.[c2]?.[c1] ?? 0)),
    }));
  }, [correlation]);

  // Filtered here, from the matrix already in hand, using the same rule the
  // engine applies: upper triangle only, |r| at or above the threshold,
  // strongest first. The value shown keeps its sign, which the matrix cells
  // above it also show; the threshold compares the magnitude.
  const highCorrPairs = useMemo(() => {
    const cols = correlation?.columns || [];
    const pairs = [];
    for (let i = 0; i < cols.length; i += 1) {
      for (let j = i + 1; j < cols.length; j += 1) {
        const r = Number(correlation.matrix?.[cols[i]]?.[cols[j]] ?? 0);
        if (Number.isNaN(r)) continue;
        if (Math.abs(r) >= corrThreshold) pairs.push({ a: cols[i], b: cols[j], r });
      }
    }
    return pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  }, [correlation, corrThreshold]);

  // Live preview of ONE channel, computed by the engine. It re-runs whenever
  // the config for that channel changes, so the effect of a decay or a
  // saturation curve is visible before committing anything with Save & Apply.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!activeCsv || !activeInspectVar || !geoKeys.length || !dependentVars.length) {
        if (!cancelled) setPreview(null);
        return;
      }
      setIsPreviewing(true);
      try {
        const data = await transformationPreviewSingle({
          csv_data: activeCsv,
          channel: activeInspectVar,
          geo_column: geoKeys[0],
          date_column: dateKeys[0] || '',
          dependent_variable: dependentVars[0],
          config: toTransformation(activeInspectVar),
          derived_variables: toDerivedVariables(),
          pop_column: popKeys[0] || null,
        });
        if (!cancelled) { setPreview(data); setPreviewError(null); }
      } catch (err) {
        if (!cancelled) {
          setPreview(null);
          setPreviewError(problemMessage(err, 'Could not preview this channel.'));
        }
      } finally {
        if (!cancelled) setIsPreviewing(false);
      }
    })();
    return () => { cancelled = true; };
    // `configs` is a dependency so editing the inspected channel re-previews.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCsv, activeInspectVar, configs, derivedVars, geoKeys, dateKeys, dependentVars, popKeys]);

  // The server response, reshaped for the panels below. Statistics, bins and
  // curves all come from the engine, so what is shown here is what the model
  // will be fitted on rather than a second approximation of it.
  const inspectDetail = useMemo(() => {
    if (!preview) return null;
    const byMetric = Object.fromEntries(
      (preview.stats_table || []).map((s) => [s.metric, s])
    );
    const side = (key) => ({
      mean: Number(byMetric.Mean?.[key] ?? 0),
      median: Number(byMetric.Median?.[key] ?? 0),
      std: Number(byMetric['Standard Deviation']?.[key] ?? 0),
      min: Number(byMetric.Minimum?.[key] ?? 0),
      max: Number(byMetric.Maximum?.[key] ?? 0),
      p25: Number(byMetric['25th Percentile']?.[key] ?? 0),
      p75: Number(byMetric['75th Percentile']?.[key] ?? 0),
    });
    const counts = (hist) => (hist || []).map((h) => Number(h.count) || 0);
    const curve = (c) => (c?.binned_curve || [])
      .map((p) => ({ x: Number(p.spend_x) || 0, y: Number(p.response_y) || 0 }));

    return {
      config: configFor(activeInspectVar),
      before: side('original'), after: side('transformed'),
      histBefore: counts(preview.raw_hist), histAfter: counts(preview.trans_hist),
      binsBefore: (preview.raw_hist || []).map((h) => h.bin),
      binsAfter: (preview.trans_hist || []).map((h) => h.bin),
      curveBefore: curve(preview.raw_curve), curveAfter: curve(preview.trans_curve),
      shapeBefore: preview.raw_curve?.shape_indicator || null,
      shapeAfter: preview.trans_curve?.shape_indicator || null,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview, activeInspectVar, configs]);

  const downloadTransformed = () => {
    if (!transformResult) return;
    const csv = Papa.unparse(transformResult.rows);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${transformSetName || 'transformed_dataset'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="transform-page">
      <div className="page-header">
        <div>
          <p className="page-header-title">Data Transformation &amp; Feature Engineering</p>
          <p className="page-header-subtitle">
            Apply Normalization, Adstock decay, Horizon smoothing, Saturation curves (Log/Power), and manage versioned transformation sets
          </p>
        </div>
      </div>

      {isLoadingArds && <p className="transform-empty">Loading ARDs...</p>}
      {!isLoadingArds && loadError && <div className="transform-error-banner">{loadError}</div>}
      {!isLoadingArds && !loadError && ards.length === 0 && (
        <p className="transform-empty">No ARDs found - build one on the Data Stitching &amp; ARD Creation page first.</p>
      )}

      {!isLoadingArds && !loadError && ards.length > 0 && (
        <>
          {/* ---- Active ARD selector ---- */}
          <div className="transform-card">
            <p className="transform-card-heading">Active ARD Dataset Under Transformation</p>
            <p className="transform-card-heading" style={{ marginBottom: '0.5rem' }}>Select ARD Table:</p>
            <div className="ard-select-row-transform">
              <select value={selectedArdFilename} onChange={(e) => setSelectedArdFilename(e.target.value)}>
                {ards.map((a) => (
                  <option key={a.filename} value={a.filename}>
                    {a.filename} ({a.grain} · {(a.row_count ?? 0).toLocaleString()} rows · {a.columns?.length} cols)
                  </option>
                ))}
              </select>
              <span className="ard-status-badge">Status: <span className="ard-status-ok">✓ Loaded</span></span>
            </div>
          </div>

          {isLoadingData && <p className="transform-empty">Loading dataset...</p>}
          {dataError && <div className="transform-error-banner">{dataError}</div>}

          {!isLoadingData && !dataError && rows.length > 0 && (
            <>
              {/* ---- Step 1: Column categorization ---- */}
              <div className="transform-card">
                <p className="transform-section-title">
                  Step 1: Column Categorization (from Ingestion)
                </p>
                <p className="transform-section-desc">
                  Variables are categorized according to their Ingestion roles. You can adjust
                  channel inclusions or switch model formulation below.
                </p>

                <div className="category-card-grid">
                  <CategoryCard
                    index={1} title="Time Variable" hint="Dates, Weeks, Periods"
                    role="Time Variable"
                    columns={columns} columnRoles={columnRoles}
                    selected={dateKeys}
                    onToggle={(c) => togglePill(setDateKeys, dateKeys, c)}
                  />
                  {/* ZIP and DMA had pickers of their own that were never sent
                      to the engine - they only excluded a column from
                      transformation, which selecting it here already does. */}
                  <CategoryCard
                    index={2} title="Cross-sectional Variable" hint="HCP IDs, DMA, Zip, Region Keys"
                    role="Cross-sectional Variable"
                    columns={columns} columnRoles={columnRoles}
                    selected={geoKeys}
                    onToggle={(c) => togglePill(setGeoKeys, geoKeys, c)}
                  />
                  <CategoryCard
                    index={3} title="Dependent Variable (KPI)" hint="Sales, TRx, NRx, Revenue"
                    role="Dependent Variable"
                    columns={columns} columnRoles={columnRoles}
                    selected={dependentVars}
                    onToggle={(c) => togglePill(setDependentVars, dependentVars, c)}
                  />
                  {/* The promotions card IS the channel inclusion list: these
                      are the columns Step 3 will configure. */}
                  <CategoryCard
                    index={4} title="Independent Promotions" hint="Calls, Details, Spend, Emails, Media"
                    role="Independent Promotions"
                    columns={columns} columnRoles={columnRoles}
                    selected={selectedList}
                    onToggle={toggleVarSelect}
                  />
                  <CategoryCard
                    index={5} title="Baseline Variables" hint="Target Population, Macro, Universe"
                    role="Baseline Variables"
                    columns={columns} columnRoles={columnRoles}
                    selected={popKeys}
                    onToggle={(c) => togglePill(setPopKeys, popKeys, c)}
                  />

                  <div className="formulation-card">
                    <p className="category-card-title">Model Formulation &amp; KPI Lock</p>
                    <p className="category-card-hint">
                      Decide whether the Dependent Variable is transformed (Log-Log) or kept in
                      linear units (Linear-Log).
                    </p>
                    <label className="formulation-option">
                      <input
                        type="radio" name="model-formulation"
                        checked={modelSpec === 'linear_log'}
                        onChange={() => setModelSpec('linear_log')}
                      />
                      Linear-Log (Keep Sales KPI Linear / Un-transformed)
                    </label>
                    <label className="formulation-option">
                      <input
                        type="radio" name="model-formulation"
                        checked={modelSpec === 'log_log'}
                        onChange={() => setModelSpec('log_log')}
                      />
                      Log-Log (Transform Sales KPI with Log Curve)
                    </label>
                    <label className="formulation-option is-check">
                      <input
                        type="checkbox" checked={carryover}
                        onChange={(e) => setCarryover(e.target.checked)}
                      />
                      Generate Carryover (Lag 1 of Sales KPI)
                    </label>

                    {/* The lock is now a decision, not a rule. A KPI is
                        transformable until somebody ticks it here. */}
                    {dependentVars.length > 0 && (
                      <>
                        <p className="category-card-hint" style={{ marginTop: '0.7rem' }}>
                          Lock a KPI to keep it out of the transformation table:
                        </p>
                        {dependentVars.map((kpi) => (
                          <label className="formulation-option" key={kpi}>
                            <input
                              type="checkbox"
                              checked={lockedDeps.includes(kpi)}
                              onChange={() => setLockedDeps(
                                lockedDeps.includes(kpi)
                                  ? lockedDeps.filter((k) => k !== kpi)
                                  : [...lockedDeps, kpi]
                              )}
                            />
                            Lock {kpi}
                          </label>
                        ))}
                      </>
                    )}
                    <p className="category-card-hint">
                      {eligibleColumns.length} channel(s) eligible for transformation.
                    </p>
                  </div>
                </div>
              </div>

              {/* ---- Step 2: Variable Selection Grid ---- */}
              <div className="transform-card">
                <p className="transform-section-title">Step 2: Variable Selection Grid</p>
                <p className="transform-section-desc">
                  Check the marketing variables you want to transform. Target KPI(s) are visible but locked to prevent transformation.
                </p>
                <div className="step-toolbar">
                  <span className="step-toolbar-link" onClick={selectAllEligible}>Select All Eligible</span>
                  <div className="step-toolbar-divider" />
                  <span className="step-toolbar-link muted" onClick={deselectAll}>Deselect All</span>
                  <button className="add-derived-btn" onClick={openDerivedBuilder} disabled={eligibleColumns.length < 2}>Add Derived Variable</button>
                </div>

                {derivedDraft && (
                  <div className="derived-builder">
                    <p className="transform-card-heading">Create Arithmetic Derived Variable</p>
                    <div className="derived-builder-row">
                      <div className="derived-builder-field">
                        <label>Derived Channel Name</label>
                        <input
                          type="text"
                          value={derivedDraft.name}
                          placeholder={derivedDraft.parts.length >= 2
                            ? derivedDefaultName(derivedDraft) : 'e.g. TOTAL_PERSONAL_PROMO'}
                          onChange={(e) => setDerivedDraft({ ...derivedDraft, name: e.target.value })}
                        />
                      </div>
                      <div className="derived-builder-field">
                        <label>Operator</label>
                        <select
                          value={derivedDraft.operator}
                          onChange={(e) => setDerivedDraft({ ...derivedDraft, operator: e.target.value })}
                        >
                          <option value="+">Addition (+)</option>
                          <option value="-">Subtraction (-)</option>
                          <option value="*">Multiplication (*)</option>
                          <option value="/">Division (/)</option>
                        </select>
                      </div>
                    </div>

                    <p className="derived-builder-label">
                      Source Variables (pick at least two, applied in the order shown)
                    </p>
                    <div className="derived-part-pills">
                      {eligibleColumns.map((c) => {
                        const position = derivedDraft.parts.indexOf(c);
                        return (
                          <button
                            type="button"
                            key={c}
                            className={`col-pill${position >= 0 ? ' selected' : ''}`}
                            onClick={() => toggleDerivedPart(c)}
                          >
                            {position >= 0 ? `${position + 1}. ${c}` : c}
                          </button>
                        );
                      })}
                    </div>

                    <p className="derived-builder-preview">
                      {derivedDraft.parts.length >= 2
                        ? `${derivedDraft.name.trim().toUpperCase() || derivedDefaultName(derivedDraft)} = ${derivedDraft.parts.join(` ${derivedDraft.operator} `)}`
                        : 'Pick a second variable to complete the expression.'}
                    </p>

                    <div className="derived-builder-actions">
                      <button
                        type="button"
                        className="mapping-btn primary"
                        disabled={derivedDraft.parts.length < 2}
                        onClick={commitDerivedVariable}
                      >
                        Add
                      </button>
                      <button type="button" className="mapping-btn" onClick={cancelDerivedBuilder}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                <div className="var-grid-table-wrapper">
                  <table className="var-grid-table">
                    <thead>
                      <tr><th>Select</th><th>Variable Name</th><th>Category</th><th>Grain</th><th>Type</th><th>Transformation Status</th></tr>
                    </thead>
                    <tbody>
                      {[...columns, ...derivedVars.map((d) => d.name)].map((c) => {
                        const isKey = lockedKeys.has(c) && !dependentVars.includes(c);
                        const isDependent = dependentVars.includes(c);
                        const isEligible = eligibleColumns.includes(c) || derivedVars.some((d) => d.name === c);
                        return (
                          <tr key={c}>
                            <td>
                              {isEligible && (
                                <input type="checkbox" checked={selectedVars.has(c)} onChange={() => toggleVarSelect(c)} />
                              )}
                            </td>
                            <td><strong>{c}</strong></td>
                            {/* What this column was declared to be at
                                ingestion, shown where the decision to
                                transform it is actually taken. */}
                            <td>
                              <span className={`role-chip tone-${roleMeta(columnRoles[c])?.tone || 'neutral'}`}>
                                {roleMeta(columnRoles[c])?.short || 'Derived'}
                              </span>
                            </td>
                            <td><span className="grain-badge">{geoKeys[0] ? geoKeys[0].toUpperCase() : 'HCP'}</span></td>
                            <td>Numeric</td>
                            <td>
                              {isKey ? (
                                <span className="status-preserved">ID / Group Key (Preserved)</span>
                              ) : isDependent ? (
                                <span className="status-locked"><span className="status-lock-icon">🔒</span>Sales (Dependent Variable) - Transform Disabled</span>
                              ) : selectedVars.has(c) ? (
                                <span className="status-included">✓ Included in Step 3</span>
                              ) : (
                                <span className="status-preserved">Not selected</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* ---- Step 3: Transformation Configuration Table ---- */}
              {selectedList.length > 0 && (
                <div className="transform-card">
                  <p className="transform-section-title">Step 3: Transformation Configuration Table</p>
                  <p className="transform-section-desc">
                    Configure Normalization, Adstock Decay, Adstock Horizon (decay span), Lag (pure shift) and Saturation curves per channel. Use the i on any row for benchmarks.
                  </p>

                  <div className="config-table-wrapper">
                    <table className="config-table">
                      <thead>
                        <tr>
                          <th>Variable</th><th>Category</th><th>Normalization</th><th>Adstock (Decay)</th>
                          <th>Adstock Horizon</th><th>Lag (Shift)</th>
                          <th>Saturation Curve</th><th>Param (k / p)</th><th>Guidance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedList.map((name) => {
                          const cfg = configFor(name);
                          const derived = derivedVars.find((d) => d.name === name);
                          const isDep = dependentVars.includes(name);
                          return (
                            <tr key={name} className={derived ? 'is-derived' : isDep ? 'is-dependent' : ''}>
                              <td>
                                <div className="config-name-cell">
                                  <strong>{name}</strong>
                                  {/* Deleting a derived channel lives with its
                                      name now that the Actions column is gone;
                                      guidance has a column of its own. */}
                                  {derived && (
                                    <button
                                      className="remove-derived-btn"
                                      title="Delete this derived channel"
                                      onClick={() => removeDerivedVariable(derived.id, name)}
                                    >
                                      ✕
                                    </button>
                                  )}
                                </div>
                                {/* A derived channel's formula, so a row named
                                    "promo_total" says what it is made of. */}
                                {derived && (
                                  <span className="derived-formula">
                                    = {derived.parts.join(` ${derived.operator} `)}
                                  </span>
                                )}
                              </td>
                              <td>
                                {/* Derived and KPI rows are not promotions, and
                                    a KPI only appears here at all under
                                    Log-Log. */}
                                <span className={`role-chip tone-${
                                  derived ? 'amber' : isDep ? 'red'
                                    : roleMeta(columnRoles[name])?.tone || 'neutral'}`}
                                >
                                  {derived ? 'Derived' : isDep ? 'KPI'
                                    : roleMeta(columnRoles[name])?.short || '-'}
                                </span>
                              </td>
                              <td>
                                <select
                                  value={cfg.normalization || 'none'}
                                  onChange={(e) => updateConfig(name, { normalization: e.target.value })}
                                  title={!popKeys.length && (cfg.normalization === 'population')
                                    ? 'Choose a Population column in Step 1 for this to have an effect.'
                                    : undefined}
                                >
                                  {NORMALIZATION_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <select value={cfg.decay} onChange={(e) => updateConfig(name, { decay: Number(e.target.value) })}>
                                  {ADSTOCK_OPTIONS.map((v) => (
                                    <option key={v} value={v}>
                                      {v === 0 ? '0.0 (pure lag)' : v.toFixed(1)}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <select value={cfg.horizon} onChange={(e) => updateConfig(name, { horizon: Number(e.target.value) })}>
                                  {HORIZON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </td>
                              {/* The pure shift, separate from the horizon and
                                  sent as its own `Lag` key, exactly as the
                                  reference app sends it. */}
                              <td>
                                <select value={cfg.lag ?? 0} onChange={(e) => updateConfig(name, { lag: Number(e.target.value) })}>
                                  {PURE_LAG_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </td>
                              <td>
                                <select value={cfg.saturation} onChange={(e) => updateConfig(name, { saturation: e.target.value })}>
                                  {SATURATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </td>
                              <td>
                                {cfg.saturation !== 'none' ? (
                                  <input type="number" step="0.1" value={cfg.param} onChange={(e) => updateConfig(name, { param: Number(e.target.value) })} />
                                ) : '-'}
                              </td>
                              <td>
                                <button
                                  type="button" className="guidance-btn"
                                  onClick={() => setGuidanceFor(name)}
                                  title="Benchmarks for this kind of channel"
                                >
                                  i
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {guidanceFor && (() => {
                    const g = getChannelGuidance(guidanceFor);
                    return (
                      <div className="guidance-panel">
                        <div className="guidance-head">
                          <p className="guidance-title">{guidanceFor} - {g.tacticType}</p>
                          <button
                            type="button" className="guidance-close"
                            onClick={() => setGuidanceFor('')} aria-label="Close guidance"
                          >
                            ✕
                          </button>
                        </div>
                        <p className="guidance-rationale">{g.rationale}</p>
                        <div className="guidance-grid">
                          <div><span>Adstock decay</span><strong>{g.adstockDecay}</strong></div>
                          <div><span>Adstock horizon</span><strong>{g.adstockHorizon}</strong></div>
                          <div><span>Saturation</span><strong>{g.saturation}</strong></div>
                        </div>
                        {/* The reference app wrote these numbers into a
                            sentence for the user to retype into four
                            dropdowns. Applying them is the same information,
                            minus the transcription. */}
                        <button
                          type="button" className="mapping-btn"
                          onClick={() => {
                            updateConfig(guidanceFor, { ...g.suggested, source: 'guided' });
                            setGuidanceFor('');
                          }}
                        >
                          Apply these settings to {guidanceFor}
                        </button>
                      </div>
                    );
                  })()}

                  <div className="set-name-row">
                    <div className="set-name-field">
                      <label>Transformation Set Name:</label>
                      <input
                        ref={setNameRef}
                        value={transformSetName}
                        onChange={(e) => setTransformSetName(e.target.value)}
                        placeholder="e.g. Q4 National Launch v1"
                      />
                    </div>
                    <button className="save-apply-btn" onClick={handleSaveApply} disabled={isApplying}>
                      {isApplying ? 'Applying...' : 'Apply Transformation Set'}
                    </button>
                  </div>
                  {applyError && <div className="transform-error-banner" style={{ marginTop: '0.75rem' }}>{applyError}</div>}
                </div>
              )}

              {/* ---- Validation sections (post apply) ---- */}
              {transformResult && (
                <>
                  <div className="transform-card">
                    <p className="transform-section-title">1. Post-Transformation Multicollinearity Matrix</p>
                    <p className="transform-section-desc">
                      Verify correlation across transformed channels to ensure adstock smoothing and saturation transforms have not introduced severe collinearity before modeling.
                    </p>
                    <div className="threshold-slider-row-t">
                      <label>Highlight Threshold (|r| ≥ {corrThreshold.toFixed(2)}):</label>
                      <input type="range" min="0" max="1" step="0.05" value={corrThreshold} onChange={(e) => setCorrThreshold(Number(e.target.value))} />
                      <span className="ready-badge">{selectedList.length} Features Ready for Regression</span>
                    </div>
                    {isScoringCorr && (
                      <p className="transform-section-desc" role="status">Scoring correlation…</p>
                    )}
                    {corrError && (
                      <p className="transform-section-desc" role="alert">{corrError}</p>
                    )}
                    <div className="config-table-wrapper">
                      <table className="corr-table-t">
                        <thead><tr><th>Variable</th>{correlationMatrix.map((r) => <th key={r.col}>{r.col.replace('_transformed', '')}</th>)}</tr></thead>
                        <tbody>
                          {correlationMatrix.map((row, i) => (
                            <tr key={row.col}>
                              <th>{row.col.replace('_transformed', '')}</th>
                              {row.values.map((v, j) => (
                                <td key={j} className={i === j ? 'corr-self-t' : Math.abs(v) >= corrThreshold ? 'corr-hi-t' : ''}>{v.toFixed(2)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {highCorrPairs.length > 0 && (
                      <table className="high-corr-pairs-table">
                        <thead><tr><th>Transformed Tactic 1</th><th>Transformed Tactic 2</th><th>Correlation (r)</th></tr></thead>
                        <tbody>
                          {highCorrPairs.map((p, i) => (
                            <tr key={i}><td>{p.a}</td><td>{p.b}</td><td>{p.r.toFixed(4)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>

                  <div className="transform-card">
                    <p className="transform-section-title">2. Transformed Dataset Preview</p>
                    <p className="transform-section-desc">
                      Showing first 10 rows of {transformResult.rows.length.toLocaleString()} total rows ({[...columns, ...transformResult.transformedCols.map((c) => c.transformed)].length} columns)
                    </p>
                    <div className="transformed-preview-scroll">
                      <table className="transformed-preview-table">
                        <thead>
                          <tr>
                            {columns.map((c) => <th key={c}>{c}</th>)}
                            {transformResult.transformedCols.map((c) => <th key={c.transformed}>{c.transformed}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {transformResult.rows.slice(0, 10).map((r, i) => (
                            <tr key={i}>
                              {columns.map((c) => <td key={c}>{typeof r[c] === 'number' ? r[c].toLocaleString(undefined, { maximumFractionDigits: 4 }) : r[c]}</td>)}
                              {transformResult.transformedCols.map((c) => <td key={c.transformed}>{Number(r[c.transformed]).toFixed(4)}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="section-connector">
                   
                  </div>

                  <div className="transform-card">
                    <div className="transform-card-titlebar">
                      <div>
                        <p className="transform-section-title">3. Preview &amp; Validation</p>
                        <p className="transform-section-desc">
                          Review the empirical impact of transformations, validate distribution compression, and inspect response shape against KPI before saving.
                        </p>
                      </div>
                      {/* Applying runs the engine; saving records the set that
                          produced this result. Nothing to save until something
                          has been applied. */}
                      <button
                        type="button"
                        className="save-set-btn"
                        disabled={!transformResult || isSaved}
                        title={isSaved
                          ? 'This set is already saved'
                          : 'Save this transformation set'}
                        onClick={saveTransformationSet}
                      >
                        {isSaved ? 'Saved' : 'Save Transformation Set'}
                      </button>
                    </div>
                    <div className="stat-card-row-transform">
                      <div className="tstat-card blue"><p className="tstat-value">{selectedList.length}</p><p className="tstat-label">Variables Transformed</p></div>
                      <div className="tstat-card green"><p className="tstat-value">{Object.values(configs).filter((c) => c.source === 'auto').length}</p><p className="tstat-label">Auto Selected</p></div>
                      <div className="tstat-card grey"><p className="tstat-value">{Object.values(configs).filter((c) => c.source === 'manual').length}</p><p className="tstat-label">Manually Configured</p></div>
                      <div className="tstat-card purple"><p className="tstat-value">{derivedVars.length}</p><p className="tstat-label">Derived Variables</p></div>
                      <div className="tstat-card yellow"><p className="tstat-value">{highCorrPairs.length}</p><p className="tstat-label">High Corr Pairs</p></div>
                      {/* Reads Saved only while the saved signature still
                          matches the current config. Changing anything after
                          saving puts it back to Unsaved. */}
                      <div className={`tstat-card ${isSaved ? 'green' : 'dark'}`}>
                        <p className="tstat-value">
                          {isSaved ? savedSet.name : 'Unsaved'}
                        </p>
                        <p className="tstat-label">Active Version</p>
                      </div>
                    </div>

                    <div className="inspect-select-row">
                      <p className="transform-card-heading">Select Variable to Inspect:</p>
                      <select value={activeInspectVar} onChange={(e) => setInspectVar(e.target.value)}>
                        {transformResult.transformedCols.map((c) => (
                          <option key={c.raw} value={c.raw}>
                            {c.raw} ({geoKeys[0]?.toUpperCase() || 'HCP'} • none • {SATURATION_OPTIONS.find((o) => o.value === c.config.saturation)?.label.split(':')[0].trim()})
                          </option>
                        ))}
                      </select>
                    </div>

                    {isPreviewing && (
                      <p className="transform-section-desc" role="status">Previewing this channel…</p>
                    )}
                    {previewError && (
                      <p className="transform-section-desc" role="alert">{previewError}</p>
                    )}

                    {inspectDetail && (
                      <>
                        <div className="inspect-layout">
                          <div className="transform-detail-card">
                            <p className="transform-detail-title">Transformation Details: {activeInspectVar.toUpperCase()}</p>
                            <div className="detail-grid">
                              <div><p className="detail-item-label">Normalization</p><p className="detail-item-value">none</p></div>
                              <div><p className="detail-item-label">Adstock Decay (α)</p><p className="detail-item-value">{inspectDetail.config.decay}</p></div>
                              <div><p className="detail-item-label">Adstock Horizon</p><p className="detail-item-value">{inspectDetail.config.horizon} weeks</p></div>
                              <div><p className="detail-item-label">Saturation Transform</p><p className="detail-item-value">{SATURATION_OPTIONS.find((o) => o.value === inspectDetail.config.saturation)?.label.split(':')[0]}</p></div>
                              <div><p className="detail-item-label">Param (k  p)</p><p className="detail-item-value">{inspectDetail.config.saturation === 'none' ? '-' : inspectDetail.config.param}</p></div>
                              <div><p className="detail-item-label">Configuration Source</p><p className="detail-item-value"><span className={`source-badge ${inspectDetail.config.source}`}>{inspectDetail.config.source === 'auto' ? 'Auto Selected' : 'Manual'}</span></p></div>
                            </div>
                          </div>

                          <div>
                            <p className="transform-card-heading">Before vs. After Summary Statistics ({activeInspectVar}):</p>
                            <table className="before-after-table">
                              <thead><tr><th>Metric</th><th>Original</th><th>Transformed</th></tr></thead>
                              <tbody>
                                <tr><td>Mean</td><td>{inspectDetail.before.mean.toFixed(3)}</td><td className="after-val">{inspectDetail.after.mean.toFixed(3)}</td></tr>
                                <tr><td>Median</td><td>{inspectDetail.before.median.toFixed(3)}</td><td className="after-val">{inspectDetail.after.median.toFixed(3)}</td></tr>
                                <tr><td>Standard Deviation</td><td>{inspectDetail.before.std.toFixed(3)}</td><td className="after-val">{inspectDetail.after.std.toFixed(3)}</td></tr>
                                <tr><td>Minimum</td><td>{inspectDetail.before.min.toFixed(3)}</td><td className="after-val">{inspectDetail.after.min.toFixed(3)}</td></tr>
                                <tr><td>Maximum</td><td>{inspectDetail.before.max.toFixed(3)}</td><td className="after-val">{inspectDetail.after.max.toFixed(3)}</td></tr>
                                <tr><td>25th Percentile</td><td>{inspectDetail.before.p25.toFixed(3)}</td><td className="after-val">{inspectDetail.after.p25.toFixed(3)}</td></tr>
                                <tr><td>75th Percentile</td><td>{inspectDetail.before.p75.toFixed(3)}</td><td className="after-val">{inspectDetail.after.p75.toFixed(3)}</td></tr>
                              </tbody>
                            </table>
                          </div>
                        </div>

                        <p className="transform-card-heading">Variable Distribution Comparison (Compression &amp; Skewness Check):</p>
                        <div className="dist-compare-row">
                          <div className="dist-chart-box">
                            <p className="dist-chart-title">Original Distribution (Raw Histogram)</p>
                            <MiniBarChart bins={inspectDetail.histBefore} binLabels={inspectDetail.binsBefore} color="#94a3b8" xLabel={activeInspectVar} yLabel="Records" />
                          </div>
                          <div className="dist-chart-box">
                            <p className="dist-chart-title after-title">Transformed Distribution (Normalized &amp; Saturated)</p>
                            <MiniBarChart bins={inspectDetail.histAfter} binLabels={inspectDetail.binsAfter} color="#1d4ed8" xLabel={`${activeInspectVar} (transformed)`} yLabel="Records" />
                          </div>
                        </div>

                        <p className="transform-card-heading">Relationship with KPI (Poor Man's Curve): Before vs. After Transformation</p>
                        <div className="curve-compare-row">
                          <div className="dist-chart-box">
                            <p className="dist-chart-title">Before: {activeInspectVar} vs {dependentVars[0]}</p>
                            <MiniLineChart points={inspectDetail.curveBefore} color="#94a3b8" xLabel={activeInspectVar} yLabel={`Average ${dependentVars[0] || 'KPI'}`} />
                          </div>
                          <div className="dist-chart-box">
                            <p className="dist-chart-title after-title">After: {activeInspectVar} (Transformed) vs {dependentVars[0]}</p>
                            <MiniLineChart points={inspectDetail.curveAfter} color="#1d4ed8" xLabel={`${activeInspectVar} (transformed)`} yLabel={`Average ${dependentVars[0] || 'KPI'}`} />
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                  
                </>
              )}
            </>
          )}
        </>
      )}

      <PageFooterNav currentStepId="data-transformation" />
    </div>
  );
}

// recharts, like Data Review. These were hand-drawn SVGs with no hover at all:
// you could see a shape but not read a value off it, and the hit-testing to
// add that is exactly what recharts already does.
const CHART_MARGIN = { top: 10, right: 20, bottom: 24, left: 10 };

/**
 * One of the five categories, and the columns the ingestion screen put in it.
 *
 * Step 1 used to be six pickers - Date, Geo, Dependent, ZIP, DMA, Population -
 * each listing every column in the ARD. On a sales file that is the same 32
 * names rendered six times, so choosing the date column meant reading past
 * thirty call-detail columns to find it, and the ZIP and DMA pickers were never
 * sent to the engine at all.
 *
 * The categories already answer "which of these could this be", so the step now
 * shows them: one card per category, holding what was declared for it. The
 * count reads selected-over-available, so a card nobody has touched still says
 * how much is in it.
 *
 * `extra` carries columns chosen for this card that the ingestion screen filed
 * elsewhere - a selection has to stay visible, or it could be counted but not
 * unpicked.
 */
function CategoryCard({ index, title, hint, role, columns, columnRoles, selected, onToggle }) {
  const inRole = columns.filter((c) => columnRoles[c] === role);
  const extra = selected.filter((c) => columnRoles[c] !== role && columns.includes(c));
  const offered = [...inRole, ...extra];

  return (
    <div className="category-card">
      <div className="category-card-head">
        <p className="category-card-title">{index}. {title}</p>
        <span className={`category-card-count tone-${roleMeta(role)?.tone || 'neutral'}`}>
          {selected.filter((c) => columns.includes(c)).length} / {offered.length}
        </span>
      </div>
      <p className="category-card-hint">{hint}</p>
      <div className="category-card-pills">
        {offered.map((c) => (
          <span
            key={c}
            className={`col-pill${selected.includes(c) ? ' selected' : ''}`}
            onClick={() => onToggle(c)}
            title={columnRoles[c] !== role ? `Categorised as ${roleMeta(columnRoles[c])?.short}` : undefined}
          >
            {selected.includes(c) ? '✓ ' : '+ '}{c}
          </span>
        ))}
        {/* Not an error - a file may genuinely have no population column - so
            it says what is missing rather than looking broken. */}
        {!offered.length && (
          <span className="category-card-empty">No columns mapped to this category</span>
        )}
      </div>
    </div>
  );
}

function MiniBarChart({ bins, color, xLabel = '', yLabel = 'Records', binLabels = [] }) {
  if (!bins.length) return null;
  const total = bins.reduce((a, b) => a + b, 0);
  // The bin's own range as the category, so the axis and the tooltip both
  // report the values rather than a bin index.
  const data = bins.map((count, i) => ({ bin: binLabels[i] ?? String(i + 1), count }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="bin" tick={{ fontSize: 8, fill: '#8a94a3' }} tickLine={false}
          axisLine={{ stroke: GRID }} minTickGap={14}
          label={{ value: xLabel, ...X_LABEL }}
        />
        <YAxis
          tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
          label={{ value: yLabel, ...Y_LABEL }}
        />
        <Tooltip
          cursor={{ fill: 'rgba(29, 42, 107, 0.08)' }}
          content={
            <ChartTooltip
              title={(label) => `${xLabel}: ${label}`}
              rows={(label, payload) => {
                const count = payload[0]?.value ?? 0;
                return [
                  { label: 'Records', value: count.toLocaleString(), color },
                  { label: 'Share', value: total ? `${((count / total) * 100).toFixed(1)}%` : '-' },
                ];
              }}
            />
          }
        />
        <Bar dataKey="count" fill={color} radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function MiniLineChart({ points, color, xLabel = '', yLabel = '' }) {
  if (!points.length) return null;

  return (
    <ResponsiveContainer width="100%" height={200}>
      <LineChart data={points} margin={CHART_MARGIN}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
        <XAxis
          dataKey="x" type="number" domain={['dataMin', 'dataMax']}
          tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
          tickFormatter={(v) => fmt(v)}
          label={{ value: xLabel, ...X_LABEL }}
        />
        <YAxis
          tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
          tickFormatter={(v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v)}
          label={{ value: yLabel, ...Y_LABEL }}
        />
        <Tooltip
          cursor={{ stroke: '#c7d2e5', strokeWidth: 1 }}
          content={
            <ChartTooltip
              title={(label) => `${xLabel}: ${fmt(label)}`}
              rows={(label, payload) => [
                { label: yLabel, value: fmt(payload[0]?.value), color },
              ]}
            />
          }
        />
        <Line
          type={LINE_TYPE} dataKey="y" stroke={color} strokeWidth={2}
          dot={{ r: 3, fill: color }}
          activeDot={{ r: 5, strokeWidth: 1.5, stroke: '#fff' }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default DataTransformation;