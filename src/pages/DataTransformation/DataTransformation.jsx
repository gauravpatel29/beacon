import { useState, useEffect, useMemo, useRef } from 'react';
import Papa from 'papaparse';
import {
  Bar, BarChart, CartesianGrid, Line, LineChart,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  ensureWorkflow, listFiles, problemMessage, transformationApply,
  transformationCorrelation, transformationPreviewSingle, transformationGridSearchSingle,
  v2GetCsv, v2ListArds, edaHistogram, edaDetectOutliers,
  correlationMatrix as fetchPreCorrelationMatrix,
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

function isNumericColumn(rows, col) {
  return rows.some((r) => typeof r[col] === 'number');
}

const NORMALIZATION_OPTIONS = [
  { value: 'none', label: 'None (Raw Volume)' },
  { value: 'minmax', label: 'Min-Max Scaling [0, 1]' },
  { value: 'zscore', label: 'Z-Score (Standardized)' },
  { value: 'iqr', label: 'Robust / IQR Scaling' },
];

const NORMALIZATION_VALUES = new Set(NORMALIZATION_OPTIONS.map((o) => o.value));
const normalizationValue = (v) => (NORMALIZATION_VALUES.has(v) ? v : 'none');

const GRANULARITY_UNIT = { daily: 'day', weekly: 'week', monthly: 'month', quarterly: 'quarter', yearly: 'year' };
function pluralUnit(n, unit) { return `${n} ${unit}${n === 1 ? '' : 's'}`; }
const SATURATION_OPTIONS = [
  { value: 'none', label: 'None (Linear)' },
  { value: 'log', label: 'Log: ln(1 + k·x)' },
  { value: 'power', label: 'Power: x^p' },
];

let derivedIdCounter = 0;

function DataTransformation() {
  const [workflowId, setWorkflowId] = useState(null);
  const [ards, setArds] = useState([]);
  const [selectedArdFilename, setSelectedArdFilename] = useState('');
  const [isLoadingArds, setIsLoadingArds] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [activeCsv, setActiveCsv] = useState('');
  const [rows, setRows] = useState([]);
  const [columns, setColumns] = useState([]);
  const [isLoadingData, setIsLoadingData] = useState(false);
  const [dataError, setDataError] = useState(null);

  // Step 1: Outliers
  const [outlierVariable, setOutlierVariable] = useState('');
  const [outlierMethod, setOutlierMethod] = useState('percentile');
  const [outlierLowerPct, setOutlierLowerPct] = useState(0.5);
  const [outlierUpperPct, setOutlierUpperPct] = useState(99.5);
  const [outlierThreshold, setOutlierThreshold] = useState(3.0);
  const [binWidthInput, setBinWidthInput] = useState('');
  const [binWidth, setBinWidth] = useState(null);
  const [binWidthError, setBinWidthError] = useState(null);
  const [histRaw, setHistRaw] = useState(null);
  const [outlierRaw, setOutlierRaw] = useState(null);
  const [isScanningOutliers, setIsScanningOutliers] = useState(false);
  const [outlierScanError, setOutlierScanError] = useState(null);
  const [excludedRowKeys, setExcludedRowKeys] = useState(() => new Set());

  const effectiveCsv = useMemo(() => {
    if (!excludedRowKeys.size) return activeCsv;
    const keptRows = rows.filter((_, idx) => !excludedRowKeys.has(idx));
    return Papa.unparse(keptRows, { columns });
  }, [activeCsv, rows, columns, excludedRowKeys]);

  // Step 2: Columns & Roles
  const [dateKeys, setDateKeys] = useState([]);
  const [geoKeys, setGeoKeys] = useState([]);
  const [dependentVars, setDependentVars] = useState([]);
  const [zipKeys, setZipKeys] = useState([]);
  const [dmaKeys, setDmaKeys] = useState([]);
  const [popKeys, setPopKeys] = useState([]);
  const [carryover, setCarryover] = useState(false);
  const [modelSpec, setModelSpec] = useState('linear_log');

  const detectedGranularity = useMemo(() => {
    const dateCol = dateKeys[0];
    if (!dateCol || !rows.length) return null;
    const uniqueDates = [...new Set(rows.map((r) => r[dateCol]).filter(Boolean))]
      .map((d) => new Date(d))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => a - b);
    if (uniqueDates.length < 2) return null;
    const gaps = [];
    for (let i = 1; i < uniqueDates.length; i++) {
      gaps.push((uniqueDates[i] - uniqueDates[i - 1]) / 86400000);
    }
    gaps.sort((a, b) => a - b);
    const medianGapDays = gaps[Math.floor(gaps.length / 2)];
    if (medianGapDays <= 2) return 'daily';
    if (medianGapDays <= 10) return 'weekly';
    if (medianGapDays <= 45) return 'monthly';
    if (medianGapDays <= 100) return 'quarterly';
    return 'yearly';
  }, [rows, dateKeys]);

  const granularityUnitLabel = GRANULARITY_UNIT[detectedGranularity] || 'week';

  // Step 3: Configurations
  const [selectedVars, setSelectedVars] = useState(new Set());
  const [declaredRoles, setDeclaredRoles] = useState({});
  const [derivedVars, setDerivedVars] = useState([]);
  const [derivedDraft, setDerivedDraft] = useState(null);
  const [guidanceFor, setGuidanceFor] = useState('');

  // Grid Search Modal State
  const [gridSearchModal, setGridSearchModal] = useState(null);

  const [configs, setConfigs] = useState({});
  const [lagDrafts, setLagDrafts] = useState({});
  const [decayDrafts, setDecayDrafts] = useState({});
  const [horizonDrafts, setHorizonDrafts] = useState({});

  const [transformSetName, setTransformSetName] = useState('');
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);

  // Step 4: Transformed Previews
  const [transformResult, setTransformResult] = useState(null);
  const [inspectVar, setInspectVar] = useState('');
  const [corrThreshold, setCorrThreshold] = useState(0.7);
  const [correlation, setCorrelation] = useState(null);
  const [corrError, setCorrError] = useState(null);
  const [isScoringCorr, setIsScoringCorr] = useState(false);
  const [preCorrelation, setPreCorrelation] = useState(null);
  const [preCorrError, setPreCorrError] = useState(null);
  const [isScoringPreCorr, setIsScoringPreCorr] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const restoredArd = useRef(null);
  const setNameRef = useRef(null);
  const [savedSet, setSavedSet] = useState(null);

  useEffect(() => { recordStage('transformation'); }, []);

  const stateRestored = useScreenState('transformation', {
    ready: Boolean(columns.length),
    deps: [selectedArdFilename, dateKeys, geoKeys, dependentVars, zipKeys, dmaKeys,
           popKeys, carryover, modelSpec, selectedVars, derivedVars, configs, transformSetName,
           corrThreshold, inspectVar, savedSet],
    snapshot: () => ({
      ard: selectedArdFilename,
      dateKeys, geoKeys, dependentVars, zipKeys, dmaKeys, popKeys,
      carryover,
      modelSpec,
      selectedVars: Array.from(selectedVars),
      derivedVars,
      configs,
      transformSetName,
      corrThreshold,
      inspectVar: activeInspectVar,
      savedSet,
    }),
    restore: (s) => {
      if (Array.isArray(s.dateKeys)) setDateKeys(s.dateKeys);
      if (Array.isArray(s.geoKeys)) setGeoKeys(s.geoKeys);
      if (Array.isArray(s.dependentVars)) setDependentVars(s.dependentVars);
      if (Array.isArray(s.zipKeys)) setZipKeys(s.zipKeys);
      if (Array.isArray(s.dmaKeys)) setDmaKeys(s.dmaKeys);
      if (Array.isArray(s.popKeys)) setPopKeys(s.popKeys);
      if (typeof s.carryover === 'boolean') setCarryover(s.carryover);
      if (s.modelSpec === 'linear_log' || s.modelSpec === 'log_log') setModelSpec(s.modelSpec);
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
    if (!stateRestored) return;
    (async () => {
      setIsLoadingArds(true);
      setLoadError(null);
      try {
        const id = await ensureWorkflow();
        setWorkflowId(id);
        const [data, uploads] = await Promise.all([
          v2ListArds(id),
          listFiles(id, { kind: 'upload' }).catch(() => ({ items: [] })),
        ]);
        const items = data.items || [];
        setArds(items);
        setDeclaredRoles(rolesFromDatasets(uploads.items));
        if (items.length) {
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

      const keepConfig = restoredArd.current === filename;
      if (!keepConfig) {
        const part = rolePartition(cols, declaredRoles);
        setDateKeys(part['Time Variable'].slice(0, 1));
        setGeoKeys(part['Cross-sectional Variable'].slice(0, 1));
        setDependentVars(part['Dependent Variable'].slice(0, 1));
        setZipKeys([]); setDmaKeys([]);
        setPopKeys(part['Baseline Variables'].slice(0, 1));
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
    () => new Set([...dateKeys, ...geoKeys, ...zipKeys, ...dmaKeys]),
    [dateKeys, geoKeys, zipKeys, dmaKeys]
  );

  const eligibleColumns = useMemo(() => {
    const part = rolePartition(columns, declaredRoles);
    const list = [...part['Independent Promotions'], ...part['Baseline Variables']];
    if (modelSpec === 'log_log') {
      for (const dep of dependentVars) if (!list.includes(dep)) list.push(dep);
    }
    return list.filter((c) => !lockedKeys.has(c) && isNumericColumn(rows, c));
  }, [columns, declaredRoles, rows, lockedKeys, dependentVars, modelSpec]);

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

  const derivedDefaultName = (draft) => draft.parts.join(draft.operator).toUpperCase();

  const commitDerivedVariable = () => {
    if (!derivedDraft || derivedDraft.parts.length < 2) return;
    const name = (derivedDraft.name.trim() || derivedDefaultName(derivedDraft)).toUpperCase();
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
    setConfigs((prev) => ({ ...prev, [name]: { ...configFor(name), ...updates, source: updates.source || 'manual' } }));
  };

  const toTransformation = (name) => sharedToTransformation(configs, name);
  const toDerivedVariables = () => sharedToDerivedVariables(derivedVars);

  const columnRoles = rolesFor(columns, declaredRoles);
  const selectedVarList = useMemo(() => [...selectedVars], [selectedVars]);

  const selectedList = useMemo(() => {
    const chosen = [...selectedVars, ...popKeys];
    if (modelSpec === 'log_log') chosen.push(...dependentVars);
    const kept = chosen.filter((c, i) => eligibleColumns.includes(c) && chosen.indexOf(c) === i);
    return [...kept, ...derivedVars.map((d) => d.name)];
  }, [selectedVars, popKeys, dependentVars, modelSpec, eligibleColumns, derivedVars]);

  const activeInspectVar = selectedList.includes(inspectVar)
    ? inspectVar
    : (selectedList[0] || '');

  // ── Grid Search Auto-Tune Handlers ──────────────────────────────────────
  const handleOpenGridSearch = async (channelName) => {
    if (!effectiveCsv || !dependentVars.length) {
      setApplyError('Dependent variable must be selected in Step 2 to tune channel parameters.');
      return;
    }
    setGridSearchModal({
      channel: channelName,
      isTuning: true,
      result: null,
      error: null,
      current: configFor(channelName),
    });

    try {
      const res = await transformationGridSearchSingle({
        csv_data: effectiveCsv,
        channel: channelName,
        geo_column: geoKeys[0] || '',
        date_column: dateKeys[0] || '',
        dependent_variable: dependentVars[0],
        derived_variables: toDerivedVariables(),
        pop_column: popKeys[0] || null,
      });
      setGridSearchModal((prev) => (prev && prev.channel === channelName ? {
        ...prev,
        isTuning: false,
        result: res,
      } : prev));
    } catch (err) {
      setGridSearchModal((prev) => (prev && prev.channel === channelName ? {
        ...prev,
        isTuning: false,
        error: problemMessage(err, 'Grid search parameter optimization failed.'),
      } : prev));
    }
  };

  const handleApplyGridSearchResult = (channelName, gridResult) => {
    if (!gridResult) return;
    updateConfig(channelName, {
      normalization: gridResult.normalization || 'none',
      decay: gridResult.decay ?? 0.5,
      horizon: gridResult.horizon ?? 2,
      lag: gridResult.lag ?? 0,
      saturation: gridResult.saturation || 'none',
      param: gridResult.param ?? 1.0,
      source: 'auto',
    });
    setGridSearchModal(null);
  };

  const handleSaveApply = async () => {
    if (!dateKeys.length || !geoKeys.length || !dependentVars.length) {
      setApplyError('Set Date, Geo, and Dependent Variable columns in Step 2 first.');
      return;
    }
    if (selectedList.length === 0) {
      setApplyError('Select at least one variable to transform in Step 3.');
      return;
    }
    setApplyError(null);
    setIsApplying(true);

    try {
      const builtTransformations = selectedList.map(toTransformation);
      const data = await transformationApply({
        csv_data: effectiveCsv,
        geo_column: geoKeys[0],
        date_column: dateKeys[0],
        dependent_variable: dependentVars[0],
        transformations: builtTransformations,
        derived_variables: toDerivedVariables(),
        pop_column: popKeys[0] || null,
        add_carryover: carryover,
      });

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

  const appliedSignature = useMemo(() => JSON.stringify({
    ard: selectedArdFilename,
    dateKeys, geoKeys, dependentVars, popKeys, carryover,
    transformations: selectedList.map(toTransformation),
    derived: toDerivedVariables(),
  }),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [selectedArdFilename, dateKeys, geoKeys, dependentVars, popKeys, carryover,
   selectedVars, configs, derivedVars]);

  const isSaved = Boolean(savedSet) && savedSet.signature === appliedSignature;

  const saveTransformationSet = () => {
    if (!transformResult) return;
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
      columns: transformResult.columns,
      rowCount: transformResult.rowCount,
    });
  };

  // Correlation Scoring
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
  }, [transformResult]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rawColumnsToScore = (transformResult?.transformedCols || [])
        .map((c) => c.raw).slice(0, 8);
      if (!effectiveCsv || !rawColumnsToScore.length) {
        if (!cancelled) setPreCorrelation(null);
        return;
      }
      setIsScoringPreCorr(true);
      try {
        const data = await fetchPreCorrelationMatrix({
          csv_data: effectiveCsv,
          columns: rawColumnsToScore,
          derived_variables: toDerivedVariables(),
          method: 'pearson',
        });
        if (!cancelled) { setPreCorrelation(data); setPreCorrError(null); }
      } catch (err) {
        if (!cancelled) {
          setPreCorrelation(null);
          setPreCorrError(problemMessage(err, 'Could not score pre-transformation correlation.'));
        }
      } finally {
        if (!cancelled) setIsScoringPreCorr(false);
      }
    })();
    return () => { cancelled = true; };
  }, [transformResult, effectiveCsv]);

  const correlationMatrix = useMemo(() => {
    if (!correlation?.columns?.length) return [];
    const cols = correlation.columns;
    return cols.map((c1) => ({
      col: c1,
      values: cols.map((c2) => Number(correlation.matrix?.[c2]?.[c1] ?? 0)),
    }));
  }, [correlation]);

  const preCorrelationMatrix = useMemo(() => {
    if (!preCorrelation?.columns?.length) return [];
    const cols = preCorrelation.columns;
    return cols.map((c1) => ({
      col: c1,
      values: cols.map((c2) => Number(preCorrelation.matrix?.[c2]?.[c1] ?? 0)),
    }));
  }, [preCorrelation]);

  const [scatterXVar, setScatterXVar] = useState('');
  const [scatterYVar, setScatterYVar] = useState('');
  const SCATTER_POINT_CAP = 500;
  const effectiveScatterX = scatterXVar || activeInspectVar;
  const effectiveScatterY = scatterYVar || dependentVars[0] || '';

  const preScatterData = useMemo(() => {
    if (!effectiveScatterX || !effectiveScatterY || !rows.length) return [];
    const keptRows = excludedRowKeys.size ? rows.filter((_, idx) => !excludedRowKeys.has(idx)) : rows;
    return keptRows
      .slice(0, SCATTER_POINT_CAP)
      .map((r) => ({ x: Number(r[effectiveScatterX]), y: Number(r[effectiveScatterY]) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  }, [rows, excludedRowKeys, effectiveScatterX, effectiveScatterY]);

  const postScatterTransformedCol = `${effectiveScatterX}_transformed`;
  const postScatterHasX = Boolean(transformResult?.columns?.includes(postScatterTransformedCol));
  const postScatterData = useMemo(() => {
    if (!effectiveScatterX || !effectiveScatterY || !postScatterHasX || !transformResult?.rows?.length) return [];
    return transformResult.rows
      .slice(0, SCATTER_POINT_CAP)
      .map((r) => ({ x: Number(r[postScatterTransformedCol]), y: Number(r[effectiveScatterY]) }))
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  }, [transformResult, effectiveScatterX, effectiveScatterY, postScatterHasX, postScatterTransformedCol]);

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!effectiveCsv || !activeInspectVar || !geoKeys.length || !dependentVars.length) {
        if (!cancelled) setPreview(null);
        return;
      }
      setIsPreviewing(true);
      try {
        const data = await transformationPreviewSingle({
          csv_data: effectiveCsv,
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCsv, activeInspectVar, configs, derivedVars, geoKeys, dateKeys, dependentVars, popKeys]);

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

  // Step 1 Outlier Logic
  const numericColumnsAll = useMemo(
    () => columns.filter((c) => !lockedKeys.has(c) && isNumericColumn(rows, c)),
    [columns, rows, lockedKeys]
  );

  useEffect(() => {
    if (!outlierVariable && numericColumnsAll.length) setOutlierVariable(numericColumnsAll[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numericColumnsAll]);

  const runOutlierScan = () => {
    if (!activeCsv || !outlierVariable) return;
    setIsScanningOutliers(true);
    setOutlierScanError(null);
    Promise.all([
      edaHistogram({
        csv_data: activeCsv,
        column: outlierVariable,
        ...(binWidth ? { bin_width: binWidth } : {}),
      }),
      edaDetectOutliers({
        csv_data: activeCsv,
        column: outlierVariable,
        method: outlierMethod,
        threshold: Number(outlierThreshold) || 3.0,
        lower_percentile: Number(outlierLowerPct),
        upper_percentile: Number(outlierUpperPct),
      }),
    ])
      .then(([hist, out]) => {
        setHistRaw(hist);
        if (!binWidth && hist?.bin_width) setBinWidthInput(String(hist.bin_width));
        setOutlierRaw(out);
      })
      .catch((err) => setOutlierScanError(problemMessage(err, 'Outlier scan failed.')))
      .finally(() => setIsScanningOutliers(false));
  };

  useEffect(() => {
    runOutlierScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCsv, outlierVariable, binWidth]);

  const lastOutlierVariable = useRef('');
  useEffect(() => {
    const previous = lastOutlierVariable.current;
    lastOutlierVariable.current = outlierVariable;
    if (!previous || previous === outlierVariable) return;
    setBinWidth(null);
    setBinWidthInput('');
    setBinWidthError(null);
  }, [outlierVariable]);

  const applyOutlierBinWidth = () => {
    const raw = binWidthInput.trim();
    if (!raw) { setBinWidth(null); setBinWidthError(null); return; }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setBinWidthError('Enter a bucket width greater than zero.');
      return;
    }
    setBinWidthError(null);
    setBinWidth(parsed);
  };

  const histogramData = useMemo(() => {
    if (!histRaw || !(histRaw.counts || []).length) return null;
    return {
      bins: histRaw.counts,
      labels: histRaw.bin_labels,
      width: Number(histRaw.bin_width) || 0,
    };
  }, [histRaw]);

  const outlierResult = useMemo(() => {
    if (!outlierRaw) return null;
    const allFlagged = outlierRaw.outlier_indices || [];
    return {
      lower: Number(outlierRaw.lower_bound) || 0,
      upper: Number(outlierRaw.upper_bound) || 0,
      flaggedIndices: allFlagged.filter((idx) => !excludedRowKeys.has(idx)),
      pct: Number(outlierRaw.outlier_pct) || 0,
    };
  }, [outlierRaw, excludedRowKeys]);

  const handleExcludeOutliers = () => {
    if (!outlierResult || !outlierResult.flaggedIndices.length) return;
    const count = outlierResult.flaggedIndices.length;
    if (!window.confirm(
      `${count} row(s) will be removed from the working dataset used for previews, correlation, and ` +
      `Save & Apply. The original file on disk is not changed, and "Restore Original Dataset" puts them back.`
    )) return;
    setExcludedRowKeys((prev) => {
      const next = new Set(prev);
      outlierResult.flaggedIndices.forEach((idx) => next.add(idx));
      return next;
    });
  };

  const handleRestoreOriginalDataset = () => {
    setExcludedRowKeys(new Set());
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
          {/* Active ARD selector */}
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
              {/* Step 1: Outlier Diagnostics & Pre-Treatment */}
              <div className="transform-card">
                <p className="transform-section-title">Outlier Diagnostics &amp; Pre-Treatment</p>
                <p className="transform-section-desc">
                  Inspect extreme values and outliers before applying feature engineering transforms.
                  Outlier exclusion updates the working dataset immediately.
                </p>

                <div className="outlier-controls-row-t">
                  <div className="outlier-field-t">
                    <label>Select Variable to Inspect:</label>
                    <select value={outlierVariable} onChange={(e) => setOutlierVariable(e.target.value)}>
                      {numericColumnsAll.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="outlier-field-t">
                    <label>Detection Strategy:</label>
                    <select value={outlierMethod} onChange={(e) => setOutlierMethod(e.target.value)}>
                      <option value="percentile">Percentile Cutoffs (Bottom &amp; Top Tails)</option>
                      <option value="zscore">Z-Score (Standard Deviations)</option>
                    </select>
                  </div>
                  {outlierMethod === 'percentile' ? (
                    <>
                      <div className="outlier-field-t">
                        <label>Bottom Tail Cutoff % (Flags lower values):</label>
                        <input
                          type="number" step="0.5" min="0" max="100" value={outlierLowerPct}
                          onChange={(e) => setOutlierLowerPct(Number(e.target.value))}
                        />
                      </div>
                      <div className="outlier-field-t">
                        <label>Top Tail Cutoff % (Flags higher values):</label>
                        <input
                          type="number" step="0.5" min="0" max="100" value={outlierUpperPct}
                          onChange={(e) => setOutlierUpperPct(Number(e.target.value))}
                        />
                      </div>
                    </>
                  ) : (
                    <div className="outlier-field-t">
                      <label>Threshold Value (N &times; &sigma;):</label>
                      <input
                        type="number" step="0.1" value={outlierThreshold}
                        onChange={(e) => setOutlierThreshold(Number(e.target.value) || 3.0)}
                      />
                    </div>
                  )}
                </div>

                <div className="outlier-scan-row-t">
                  <button type="button" className="recalc-btn-t" onClick={runOutlierScan} disabled={isScanningOutliers}>
                    &#8635; {isScanningOutliers ? 'Scanning...' : 'Re-Scan Outliers'}
                  </button>
                  <input
                    type="number" step="any" min="0" placeholder="Automatic"
                    value={binWidthInput}
                    onChange={(e) => { setBinWidthInput(e.target.value); setBinWidthError(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') applyOutlierBinWidth(); }}
                  />
                  <button type="button" className="bin-width-apply-t" onClick={applyOutlierBinWidth}>
                    Apply Width
                  </button>
                </div>
                {binWidthError && <p className="bin-width-error-t">{binWidthError}</p>}
                {outlierScanError && <div className="transform-error-banner">{outlierScanError}</div>}

                {outlierResult && (
                  <div className="stat-card-row-transform cols-4">
                    <div className="tstat-card grey"><p className="tstat-value">{outlierResult.flaggedIndices.length.toLocaleString()}</p><p className="tstat-label">Outlier Points</p></div>
                    <div className="tstat-card grey"><p className="tstat-value">{outlierResult.pct.toFixed(1)}%</p><p className="tstat-label">Dataset Proportion</p></div>
                    <div className="tstat-card grey"><p className="tstat-value">{outlierResult.lower.toFixed(0)}</p><p className="tstat-label">Lower Cutoff</p></div>
                    <div className="tstat-card grey"><p className="tstat-value">{outlierResult.upper.toFixed(0)}</p><p className="tstat-label">Upper Cutoff</p></div>
                  </div>
                )}

                <div className="outlier-exclude-row-t">
                  {outlierResult && outlierResult.flaggedIndices.length > 0 && (
                    <button type="button" className="exclude-outliers-btn-t" onClick={handleExcludeOutliers}>
                      Exclude {outlierResult.flaggedIndices.length} Outliers from Dataset
                    </button>
                  )}
                  {excludedRowKeys.size > 0 && (
                    <button type="button" className="restore-dataset-btn-t" onClick={handleRestoreOriginalDataset}>
                      &#8635; Restore Original Dataset (Undo Exclusions)
                    </button>
                  )}
                </div>
                {excludedRowKeys.size > 0 && (
                  <p className="outlier-exclusion-note-t">
                    {excludedRowKeys.size} row(s) currently excluded from the working dataset — this
                    affects the live channel preview, the correlation matrices below, and Save &amp;
                    Apply Transformation Set.
                  </p>
                )}

                {histogramData && (
                  <div className="dist-chart-box">
                    <p className="dist-chart-title">Raw Distribution Histogram ({outlierVariable})</p>
                    <MiniBarChart
                      bins={histogramData.bins}
                      binLabels={histogramData.labels}
                      color="#1d2a6b"
                      xLabel={outlierVariable}
                      yLabel="Records"
                      showXTicks={false}
                    />
                  </div>
                )}

                {outlierResult && outlierResult.flaggedIndices.length > 0 && (
                  <>
                    <p className="transform-card-heading" style={{ marginTop: 'var(--spacing-md)' }}>
                      Flagged Outlier Records:
                    </p>
                    <div className="transformed-preview-scroll">
                      <table className="transformed-preview-table">
                        <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                        <tbody>
                          {outlierResult.flaggedIndices.slice(0, 100).map((idx) => (
                            <tr key={idx}>{columns.map((c) => <td key={c}>{rows[idx]?.[c]}</td>)}</tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>

              {/* Step 2: Column Categorization */}
              <div className="transform-card">
                <p className="transform-section-title">Column Categorization (from Ingestion)</p>
                <p className="transform-section-desc">
                  Variables are categorized according to their Ingestion roles. You can adjust channel inclusions or switch model formulation below.
                </p>

                <div className="category-card-grid">
                  <CategoryCard
                    index={1} title="Time Variable" hint="Dates, Weeks, Periods"
                    role="Time Variable"
                    columns={columns} columnRoles={columnRoles}
                    selected={dateKeys}
                    onToggle={(c) => togglePill(setDateKeys, dateKeys, c)}
                  />
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
                  <CategoryCard
                    index={4} title="Independent Promotions" hint="Calls, Details, Spend, Emails, Media"
                    role="Independent Promotions"
                    columns={columns} columnRoles={columnRoles}
                    selected={selectedVarList}
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
                    <p className="category-card-hint">Decide whether the Dependent Variable is transformed</p>
                    <label className="formulation-option">
                      <input
                        type="radio" name="model-formulation"
                        checked={modelSpec === 'linear_log'}
                        onChange={() => setModelSpec('linear_log')}
                      />
                      Lock Dependent Variable (Sales KPI)
                    </label>
                    <label className="formulation-option">
                      <input
                        type="radio" name="model-formulation"
                        checked={modelSpec === 'log_log'}
                        onChange={() => setModelSpec('log_log')}
                      />
                      Unlock Dependent Variable (Sales KPI)
                    </label>

                    {dependentVars.length > 0 && (
                      <p className="category-card-hint" style={{ marginTop: '0.7rem' }}>
                        {modelSpec === 'log_log'
                          ? `${dependentVars.join(', ')} is unlocked and appears in the transformation table.`
                          : `${dependentVars.join(', ')} is locked out of the transformation table.`}
                      </p>
                    )}
                    <p className="category-card-hint">
                      {eligibleColumns.length} channel(s) eligible for transformation.
                    </p>
                  </div>
                </div>
              </div>

              {/* Step 3: Transformation Configuration Table */}
              {selectedList.length > 0 && (
                <div className="transform-card">
                  <p className="transform-section-title">Transformation Configuration Table</p>
                  <p className="transform-section-desc">
                    Configure Normalization, Adstock Decay, Adstock Horizon, Lag, and Saturation curves per channel.
                    Click <strong>Auto</strong> for automated multi-dimensional Grid Search optimization or <strong>i</strong> for channel benchmarks.
                  </p>

                  <div className="step-toolbar">
                    <button
                      className="add-derived-btn" onClick={openDerivedBuilder}
                      disabled={eligibleColumns.length < 2}
                    >
                      Add Derived Channel
                    </button>
                  </div>

                  {derivedDraft && (
                    <div className="derived-builder">
                      <p className="transform-card-heading">Create Arithmetic Derived Channel</p>
                      <div className="derived-builder-row">
                        <div className="derived-builder-field">
                          <label>Name</label>
                          <input
                            type="text"
                            value={derivedDraft.name}
                            placeholder={derivedDefaultName(derivedDraft)}
                            onChange={(e) => setDerivedDraft((p) => ({ ...p, name: e.target.value }))}
                          />
                        </div>
                        <div className="derived-builder-field">
                          <label>Operator</label>
                          <select
                            value={derivedDraft.operator}
                            onChange={(e) => setDerivedDraft((p) => ({ ...p, operator: e.target.value }))}
                          >
                            {['+', '-', '*', '/'].map((o) => <option key={o} value={o}>{o}</option>)}
                          </select>
                        </div>
                      </div>
                      <p className="derived-builder-label">
                        Columns, in order ({derivedDraft.parts.length} selected, at least 2):
                      </p>
                      <div className="pill-group-box">
                        {eligibleColumns.map((c) => {
                          const position = derivedDraft.parts.indexOf(c);
                          return (
                            <button
                              type="button"
                              key={c}
                              className={`col-pill${position >= 0 ? ' selected' : ''}`}
                              onClick={() => toggleDerivedPart(c)}
                            >
                              {position >= 0 ? `${position + 1}. ` : '+ '}{c}
                            </button>
                          );
                        })}
                      </div>
                      <div className="derived-builder-actions">
                        <button
                          className="mapping-btn primary"
                          disabled={derivedDraft.parts.length < 2}
                          onClick={commitDerivedVariable}
                        >
                          Add
                        </button>
                        <button className="mapping-btn" onClick={cancelDerivedBuilder}>Cancel</button>
                      </div>
                    </div>
                  )}

                  <div className="config-table-wrapper">
                    <table className="config-table">
                      <thead>
                        <tr>
                          <th>Variable</th>
                          <th>Category</th>
                          <th>Normalization</th>
                          <th>Adstock (Decay)</th>
                          <th>Adstock Horizon</th>
                          <th>Lag (Shift)</th>
                          <th>Saturation Curve</th>
                          <th>Param (k / p)</th>
                          <th>Auto-Tune</th>
                          <th>Guidance</th>
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
                                {derived && (
                                  <span className="derived-formula">
                                    = {derived.parts.join(` ${derived.operator} `)}
                                  </span>
                                )}
                              </td>
                              <td>
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
                                  value={normalizationValue(cfg.normalization)}
                                  onChange={(e) => updateConfig(name, { normalization: e.target.value })}
                                >
                                  {NORMALIZATION_OPTIONS.map((o) => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                  ))}
                                </select>
                              </td>
                              <td>
                                <div className="lag-input-cell">
                                  <input
                                    type="number" min="0" max="0.99" step="0.01"
                                    value={decayDrafts[name] !== undefined ? decayDrafts[name] : String(cfg.decay ?? 0)}
                                    onChange={(e) => {
                                      const normalized = e.target.value.replace(/^0+(?=\d)/, '');
                                      setDecayDrafts((d) => ({ ...d, [name]: normalized }));
                                    }}
                                    onBlur={(e) => {
                                      const parsed = Math.min(0.99, Math.max(0, Number(e.target.value) || 0));
                                      updateConfig(name, { decay: parsed });
                                      setDecayDrafts((d) => {
                                        const next = { ...d };
                                        delete next[name];
                                        return next;
                                      });
                                    }}
                                  />
                                </div>
                              </td>
                              <td>
                                <div className="lag-input-cell">
                                  <input
                                    type="number" min="1" step="1"
                                    value={horizonDrafts[name] !== undefined ? horizonDrafts[name] : String(cfg.horizon ?? 1)}
                                    onChange={(e) => {
                                      const normalized = e.target.value.replace(/^0+(?=\d)/, '');
                                      setHorizonDrafts((d) => ({ ...d, [name]: normalized }));
                                    }}
                                    onBlur={(e) => {
                                      const parsed = Math.max(1, Number(e.target.value) || 1);
                                      updateConfig(name, { horizon: parsed });
                                      setHorizonDrafts((d) => {
                                        const next = { ...d };
                                        delete next[name];
                                        return next;
                                      });
                                    }}
                                  />
                                  <span className="lag-input-unit">{granularityUnitLabel}(s)</span>
                                </div>
                              </td>
                              <td>
                                <div className="lag-input-cell">
                                  <input
                                    type="number" min="0" step="1"
                                    value={lagDrafts[name] !== undefined ? lagDrafts[name] : String(cfg.lag ?? 0)}
                                    onChange={(e) => {
                                      const normalized = e.target.value.replace(/^0+(?=\d)/, '');
                                      setLagDrafts((d) => ({ ...d, [name]: normalized }));
                                    }}
                                    onBlur={(e) => {
                                      const parsed = Math.max(0, Number(e.target.value) || 0);
                                      updateConfig(name, { lag: parsed });
                                      setLagDrafts((d) => {
                                        const next = { ...d };
                                        delete next[name];
                                        return next;
                                      });
                                    }}
                                  />
                                  <span className="lag-input-unit">{granularityUnitLabel}(s)</span>
                                </div>
                              </td>
                              <td>
                                <select value={cfg.saturation} onChange={(e) => updateConfig(name, { saturation: e.target.value })}>
                                  {SATURATION_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                              </td>
                              <td>
                                {cfg.saturation !== 'none' ? (
                                  <input
                                    type="number" step="0.1" value={cfg.param}
                                    onChange={(e) => updateConfig(name, { param: Number(e.target.value) })}
                                  />
                                ) : '-'}
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="auto-optuna-btn"
                                  onClick={() => handleOpenGridSearch(name)}
                                  title="Run Grid Search optimization on this channel"
                                >
                                  Auto
                                </button>
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

                  {/* Exhaustive Grid Search Modal */}
                  {gridSearchModal && (
                    <div className="modal-overlay" onClick={() => setGridSearchModal(null)}>
                      <div className="optuna-tune-modal" onClick={(e) => e.stopPropagation()}>
                        <div className="optuna-modal-head">
                          <div>
                            <p className="optuna-modal-title">
                              Grid Search Parameter Optimization: {gridSearchModal.channel}
                            </p>
                            <p className="optuna-modal-subtitle">
                              Exhaustively evaluating combinations of Normalization, Adstock Decay, Horizon, Lag, and Saturation curves
                            </p>
                          </div>
                          <button type="button" className="optuna-modal-close" onClick={() => setGridSearchModal(null)}>✕</button>
                        </div>

                        <div className="optuna-modal-body">
                          {gridSearchModal.isTuning && (
                            <div className="optuna-tuning-state">
                              <span className="loading-spinner" aria-hidden="true" />
                              <p>Evaluating multi-dimensional grid search permutations against {dependentVars[0]}...</p>
                            </div>
                          )}

                          {gridSearchModal.error && (
                            <div className="transform-error-banner">{gridSearchModal.error}</div>
                          )}

                          {gridSearchModal.result && (
                            <>
                              <div className="optuna-comparison-table-wrap">
                                <table className="optuna-comparison-table">
                                  <thead>
                                    <tr>
                                      <th>Parameter</th>
                                      <th>Current Settings</th>
                                      <th>Grid Search Best Settings</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    <tr>
                                      <td><strong>Normalization</strong></td>
                                      <td>{gridSearchModal.current.normalization || 'none'}</td>
                                      <td className="optuna-highlight">{gridSearchModal.result.normalization}</td>
                                    </tr>
                                    <tr>
                                      <td><strong>Adstock Decay (&alpha;)</strong></td>
                                      <td>{gridSearchModal.current.decay}</td>
                                      <td className="optuna-highlight">{gridSearchModal.result.decay}</td>
                                    </tr>
                                    <tr>
                                      <td><strong>Adstock Horizon</strong></td>
                                      <td>{pluralUnit(gridSearchModal.current.horizon, granularityUnitLabel)}</td>
                                      <td className="optuna-highlight">{pluralUnit(gridSearchModal.result.horizon, granularityUnitLabel)}</td>
                                    </tr>
                                    <tr>
                                      <td><strong>Pure Shift Lag</strong></td>
                                      <td>{pluralUnit(gridSearchModal.current.lag, granularityUnitLabel)}</td>
                                      <td className="optuna-highlight">{pluralUnit(gridSearchModal.result.lag, granularityUnitLabel)}</td>
                                    </tr>
                                    <tr>
                                      <td><strong>Saturation Function</strong></td>
                                      <td>{gridSearchModal.current.saturation}</td>
                                      <td className="optuna-highlight">{gridSearchModal.result.saturation}</td>
                                    </tr>
                                    <tr>
                                      <td><strong>Saturation Parameter (k / p)</strong></td>
                                      <td>{gridSearchModal.current.saturation === 'none' ? '-' : gridSearchModal.current.param}</td>
                                      <td className="optuna-highlight">{gridSearchModal.result.saturation === 'none' ? '-' : gridSearchModal.result.param}</td>
                                    </tr>
                                  </tbody>
                                </table>
                              </div>
                              <p className="optuna-note">
                                Applying Grid Search recommendations will immediately update this row in the Transformation Configuration Table.
                              </p>
                            </>
                          )}
                        </div>

                        <div className="optuna-modal-foot">
                          <button
                            type="button"
                            className="mapping-btn secondary"
                            onClick={() => setGridSearchModal(null)}
                          >
                            Dismiss
                          </button>
                          {gridSearchModal.result && (
                            <button
                              type="button"
                              className="mapping-btn primary"
                              onClick={() => handleApplyGridSearchResult(gridSearchModal.channel, gridSearchModal.result)}
                            >
                              ✓ Apply Grid Search Settings
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Benchmark Guidance Panel */}
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

              {/* Step 4: Transformed Dataset Preview & Validation */}
              {transformResult && (
                <>
                  <div className="transform-card">
                    <div className="transform-card-titlebar">
                      <div>
                        <p className="transform-section-title">Transformed Dataset Preview</p>
                        <p className="transform-section-desc">
                          Showing first 10 rows of {transformResult.rows.length.toLocaleString()} total rows ({transformResult.columns.length} columns)
                        </p>
                      </div>
                      <button type="button" className="download-csv-btn" onClick={downloadTransformed}>
                        Download CSV
                      </button>
                    </div>
                    <div className="transformed-preview-scroll">
                      <table className="transformed-preview-table">
                        <thead>
                          <tr>
                            {transformResult.columns.map((c) => <th key={c}>{c}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {transformResult.rows.slice(0, 10).map((r, i) => (
                            <tr key={i}>
                              {transformResult.columns.map((c) => (
                                <td key={c}>
                                  {typeof r[c] === 'number' ? r[c].toLocaleString(undefined, { maximumFractionDigits: 4 }) : r[c]}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="transform-card">
                    <p className="transform-section-title">Pre vs. Post Transformation Correlation Comparison</p>
                    <p className="transform-section-desc">
                      Compare correlation structure before and after feature engineering to ensure adstock smoothing and non-linear saturation transforms have not introduced collinearity.
                    </p>
                    <div className="threshold-slider-row-t">
                      <label>Highlight Threshold (|r| ≥ {corrThreshold.toFixed(2)}):</label>
                      <input type="range" min="0" max="1" step="0.05" value={corrThreshold} onChange={(e) => setCorrThreshold(Number(e.target.value))} />
                      <span className="ready-badge">{selectedList.length} Features Ready for Regression</span>
                    </div>

                    <div className="scatter-axis-picker-row">
                      <div className="scatter-axis-field">
                        <label>Scatter X Axis</label>
                        <select value={effectiveScatterX} onChange={(e) => setScatterXVar(e.target.value)}>
                          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                      <div className="scatter-axis-field">
                        <label>Scatter Y Axis</label>
                        <select value={effectiveScatterY} onChange={(e) => setScatterYVar(e.target.value)}>
                          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      </div>
                    </div>

                    <div className="corr-compare-row">
                      <div className="corr-compare-col">
                        <p className="corr-compare-title">Pre-Transformation Matrix (Raw Features)</p>
                        {isScoringPreCorr && <p className="transform-section-desc" role="status">Scoring correlation…</p>}
                        {preCorrError && <p className="transform-section-desc" role="alert">{preCorrError}</p>}
                        <div className="config-table-wrapper">
                          <table className="corr-table-t">
                            <thead><tr><th>Variable</th>{preCorrelationMatrix.map((r) => <th key={r.col}>{r.col}</th>)}</tr></thead>
                            <tbody>
                              {preCorrelationMatrix.map((row, i) => (
                                <tr key={row.col}>
                                  <th>{row.col}</th>
                                  {row.values.map((v, j) => (
                                    <td key={j} className={i === j ? 'corr-self-t' : Math.abs(v) >= corrThreshold ? 'corr-hi-t' : ''}>{v.toFixed(2)}</td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                        {effectiveScatterX && effectiveScatterY && (
                          <div className="dist-chart-box" style={{ marginTop: 'var(--spacing-md)' }}>
                            <p className="dist-chart-title">Scatter: {effectiveScatterX} (Raw) vs {effectiveScatterY}</p>
                            {preScatterData.length ? (
                              <ResponsiveContainer width="100%" height={220}>
                                <ScatterChart margin={{ top: 10, right: 20, bottom: 22, left: 8 }}>
                                  <CartesianGrid stroke={GRID} />
                                  <XAxis type="number" dataKey="x" name={effectiveScatterX} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                                         label={{ value: effectiveScatterX, ...X_LABEL }} />
                                  <YAxis type="number" dataKey="y" name={effectiveScatterY} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                                         label={{ value: effectiveScatterY, ...Y_LABEL }} />
                                  <Tooltip content={<ChartTooltip />} cursor={{ strokeDasharray: '3 3' }} />
                                  <Scatter data={preScatterData} fill="#94a3b8" />
                                </ScatterChart>
                              </ResponsiveContainer>
                            ) : (
                              <p className="mc-empty">No numeric rows found for this X/Y pair.</p>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="corr-compare-col">
                        <p className="corr-compare-title">Post-Transformation Matrix (Transformed Features)</p>
                        {isScoringCorr && <p className="transform-section-desc" role="status">Scoring correlation…</p>}
                        {corrError && <p className="transform-section-desc" role="alert">{corrError}</p>}
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
                        {effectiveScatterX && effectiveScatterY && (
                          <div className="dist-chart-box" style={{ marginTop: 'var(--spacing-md)' }}>
                            <p className="dist-chart-title">Scatter: {effectiveScatterX} (Transformed) vs {effectiveScatterY}</p>
                            {postScatterData.length ? (
                              <ResponsiveContainer width="100%" height={220}>
                                <ScatterChart margin={{ top: 10, right: 20, bottom: 22, left: 8 }}>
                                  <CartesianGrid stroke={GRID} />
                                  <XAxis type="number" dataKey="x" name={`${effectiveScatterX} (transformed)`} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                                         label={{ value: `${effectiveScatterX} (transformed)`, ...X_LABEL }} />
                                  <YAxis type="number" dataKey="y" name={effectiveScatterY} tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID }}
                                         label={{ value: effectiveScatterY, ...Y_LABEL }} />
                                  <Tooltip content={<ChartTooltip />} cursor={{ strokeDasharray: '3 3' }} />
                                  <Scatter data={postScatterData} fill="#1d4ed8" />
                                </ScatterChart>
                              </ResponsiveContainer>
                            ) : !transformResult ? (
                              <p className="mc-empty">Run Save &amp; Apply Transformation Set to see the transformed scatter.</p>
                            ) : !postScatterHasX ? (
                              <p className="mc-empty">"{effectiveScatterX}" has no transformed counterpart — pick a promotional channel to see this chart.</p>
                            ) : (
                              <p className="mc-empty">No numeric rows found for this X/Y pair.</p>
                            )}
                          </div>
                        )}
                      </div>
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
                    <div className="transform-card-titlebar">
                      <div>
                        <p className="transform-section-title">Preview &amp; Validation</p>
                        <p className="transform-section-desc">
                          Review the empirical impact of transformations, validate distribution compression, and inspect response shape against KPI before saving.
                        </p>
                      </div>
                      <button
                        type="button"
                        className="save-set-btn"
                        disabled={!transformResult || isSaved}
                        title={isSaved ? 'This set is already saved' : 'Save this transformation set'}
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
                      <div className={`tstat-card ${isSaved ? 'green' : 'dark'}`}>
                        <p className="tstat-value">{isSaved ? savedSet.name : 'Unsaved'}</p>
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

                    {isPreviewing && <p className="transform-section-desc" role="status">Previewing this channel…</p>}
                    {previewError && <p className="transform-section-desc" role="alert">{previewError}</p>}

                    {inspectDetail && (
                      <>
                        <div className="inspect-layout">
                          <div className="transform-detail-card">
                            <p className="transform-detail-title">Transformation Details: {activeInspectVar.toUpperCase()}</p>
                            <div className="detail-grid">
                              <div><p className="detail-item-label">Normalization</p><p className="detail-item-value">{inspectDetail.config.normalization || 'none'}</p></div>
                              <div><p className="detail-item-label">Adstock Decay (α)</p><p className="detail-item-value">{inspectDetail.config.decay}</p></div>
                              <div><p className="detail-item-label">Adstock Horizon</p><p className="detail-item-value">{pluralUnit(inspectDetail.config.horizon, granularityUnitLabel)}</p></div>
                              <div><p className="detail-item-label">Pure Shift Lag</p><p className="detail-item-value">{pluralUnit(inspectDetail.config.lag, granularityUnitLabel)}</p></div>
                              <div><p className="detail-item-label">Saturation Transform</p><p className="detail-item-value">{SATURATION_OPTIONS.find((o) => o.value === inspectDetail.config.saturation)?.label.split(':')[0]}</p></div>
                              <div><p className="detail-item-label">Param (k / p)</p><p className="detail-item-value">{inspectDetail.config.saturation === 'none' ? '-' : inspectDetail.config.param}</p></div>
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
                            <MiniBarChart bins={inspectDetail.histBefore} binLabels={inspectDetail.binsBefore} color="#94a3b8" xLabel={activeInspectVar} yLabel="Records" showXTicks={false} />
                          </div>
                          <div className="dist-chart-box">
                            <p className="dist-chart-title after-title">Transformed Distribution (Normalized &amp; Saturated)</p>
                            <MiniBarChart bins={inspectDetail.histAfter} binLabels={inspectDetail.binsAfter} color="#1d4ed8" xLabel={`${activeInspectVar} (transformed)`} yLabel="Records" showXTicks={false} />
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

const CHART_MARGIN = { top: 10, right: 20, bottom: 24, left: 10 };

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
        {!offered.length && (
          <span className="category-card-empty">No columns mapped to this category</span>
        )}
      </div>
    </div>
  );
}

function MiniBarChart({ bins, color, xLabel = '', yLabel = 'Records', binLabels = [], showXTicks = true }) {
  if (!bins.length) return null;
  const total = bins.reduce((a, b) => a + b, 0);
  const data = bins.map((count, i) => ({ bin: binLabels[i] ?? String(i + 1), count }));

  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={CHART_MARGIN}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis
          dataKey="bin" tick={showXTicks ? { fontSize: 8, fill: '#8a94a3' } : false} tickLine={false}
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

export default DataTransformation;

