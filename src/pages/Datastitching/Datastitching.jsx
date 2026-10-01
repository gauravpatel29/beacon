import { useState, useEffect, useRef, useMemo } from 'react';
import { v2ListFiles, v2BuildArd, v2ListArds, v2GetCsv, deleteFile, problemMessage, ensureWorkflow } from '../../services/api.js';
import { forgetFile, loadScreenState, recordStage, saveScreenState } from '../../services/workflowState.js';
import { rolesFor, rolesFromDatasets } from '../../services/columnRoles.js';
import GranularityPanel from '../../components/Granularity/GranularityPanel.jsx';
import './Datastitching.css';
import PageFooterNav from '../../components/PageFooterNav/PageFooterNav.jsx';

const DEFAULT_TABS = [];

const JOIN_TYPES = [
  { value: 'left', label: 'Left Join | keep every left row' },
  { value: 'inner', label: 'Inner Join | keep only rows matching on both sides' },
  { value: 'right', label: 'Right Join | keep every right row' },
  { value: 'outer', label: 'Outer Join | keep every row from both sides' },
  { value: 'cross', label: 'Cross Join | every combination, no keys' },
];

const JOIN_LABELS = Object.fromEntries(
  JOIN_TYPES.map((j) => [j.value, j.label.split(' | ')[0]])
);

function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function makeEmptyStep() {
  return {
    operationType: 'join',
    leftFile: '', rightFile: '', joinType: 'left',
    keyPairs: [{ left: '', right: '' }],
    sourceFile: '', bridgeFile: '',
    rollupMappingMethod: 'equal_split',
    weightFile: '', weightMatchKey: '', weightColumn: '', weightFallback: 'equal_split',
    sourceKey: '', matchKey: '', targetKey: '', dateKey: '',
    aggregations: {},
    higherGrainFile: '', lowerGrainStructureFile: '',
    sourceGrainKey: '', targetGrainKey: '', crosswalkFile: '',
    crosswalkMatchKey: '',
    allocationMethod: 'equal',
    metricsToAllocate: [],
    weightDatasetFile: '', weightColumn: '',
    // Carryover fields
    entityKeys: [],
    metricColumn: '',
    outputColumnName: '',
    decayRateMethod: 'manual',
    decayRate: 0.6,
    firstPeriodValue: 'zero',
    timeGapHandling: 'reset',
    negativeHandling: 'floor_zero',
  };
}

const OPERATION_TYPES = [
  { value: 'join', label: 'Relational Join (Same Grain)' },
  { value: 'rollup', label: 'Rollup (Lower → Higher Grain)' },
  { value: 'allocate', label: 'Allocate (Higher → Lower Grain)' },
];

const AGG_OPTIONS = [
  { value: 'sum', label: 'Sum (Default / Conserved)' },
  { value: 'avg', label: 'Average (Mean)' },
  { value: 'min', label: 'Minimum' },
  { value: 'max', label: 'Maximum' },
  { value: 'count', label: 'Count' },
  { value: 'distinct_count', label: 'Distinct Count' },
  { value: 'first', label: 'First Occurrence' },
  { value: 'last', label: 'Last Occurrence' },
];
const AGG_VALUES = new Set(AGG_OPTIONS.map((o) => o.value));
const aggValue = (v) => (AGG_VALUES.has(v) ? v : 'sum');

const ID_TOKENS = [
  'npi', 'id', 'zip', 'fips', 'code', 'dma', 'state', 'account',
  'date', 'week', 'month', 'year', 'time',
];
function isMetricColumn(colName) {
  const l = String(colName || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  return !ID_TOKENS.some((tok) => l === tok || l.startsWith(`${tok}_`) || l.endsWith(`_${tok}`));
}

function makeDefaultDraft() {
  return {
    ardName: '',
    selectedFiles: new Set(),
    steps: [],
    joinCards: [],
    finalRowCount: null,
    finalColumnCount: null,
    isSavingPipeline: false,
    pipelineError: null,
    isGenerating: false,
    generateError: null,
    activePreview: null,
    generatedArd: null,
    generatedArdName: null,
  };
}

let tabCounter = 0;

function Datastitching() {
  const [workflowId, setWorkflowId] = useState(null);
  const hasRestored = useRef(false);
  const [files, setFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [tabError, setTabError] = useState(null);

  const [savedArds, setSavedArds] = useState([]);
  const [isLoadingArds, setIsLoadingArds] = useState(false);
  const [ardListError, setArdListError] = useState(null);
  const [downloadingArdName, setDownloadingArdName] = useState(null);

  const [tabs, setTabs] = useState(DEFAULT_TABS);
  const [activeTabId, setActiveTabId] = useState('');
  const [drafts, setDrafts] = useState({});

  const [modal, setModal] = useState(null);
  const [carryoverModal, setCarryoverModal] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0] || null;
  const draft = drafts[activeTab?.id] || makeDefaultDraft();

  const setDraft = (updates) => {
    if (!activeTab) return;
    setDrafts((prev) => ({ ...prev, [activeTab.id]: { ...prev[activeTab.id], ...updates } }));
  };

  const updateDraft = (updaterFn) => {
    if (!activeTab) return;
    setDrafts((prev) => ({ ...prev, [activeTab.id]: updaterFn(prev[activeTab.id]) }));
  };

  const targetGrain = 'hcp';
  const ardLabel = activeTab?.title || 'this ARD';

  // Read all column roles declared during Data Ingestion
  const declaredRoles = useMemo(() => {
    return rolesFromDatasets(files.concat(savedArds));
  }, [files, savedArds]);

  const persistableState = () => ({
    activeTabId,
    tabs: tabs.map(({ id, title, grain, removable }) => ({ id, title, grain, removable })),
    drafts: Object.fromEntries(Object.entries(drafts).map(([id, d]) => [id, {
      ardName: d.ardName,
      steps: d.steps,
      selectedFiles: Array.from(d.selectedFiles || []),
      generatedArdName: d.generatedArd?.filename || d.generatedArdName || null,
    }])),
  });

  const restoreDrafts = (saved) => {
    if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return false;

    const isUnusedLegacyTab = (tab) => tab.removable === false
      && !(saved.drafts?.[tab.id]?.steps || []).length;

    const tabsToKeep = saved.tabs
      .filter((tab) => !isUnusedLegacyTab(tab))
      .map((tab) => ({ ...tab, removable: true, editing: false }));

    if (!tabsToKeep.length) return false;

    const restored = {};
    for (const tab of tabsToKeep) {
      const d = saved.drafts?.[tab.id] || {};
      restored[tab.id] = {
        ...makeDefaultDraft(),
        ardName: d.ardName || '',
        steps: Array.isArray(d.steps) ? d.steps : [],
        selectedFiles: new Set(d.selectedFiles || []),
        generatedArdName: d.generatedArdName || null,
      };
    }

    setTabs(tabsToKeep);
    setDrafts(restored);
    setActiveTabId(restored[saved.activeTabId] ? saved.activeTabId : tabsToKeep[0].id);
    return true;
  };

  const loadArdList = async (id) => {
    setIsLoadingArds(true);
    setArdListError(null);
    try {
      const data = await v2ListArds(id);
      setSavedArds(data.items || data.ards || []);
    } catch (err) {
      setArdListError(problemMessage(err, 'Could not load saved ARD datasets.'));
    } finally {
      setIsLoadingArds(false);
    }
  };

  const handleDownloadArd = async (filename) => {
    if (!workflowId || downloadingArdName) return;
    setDownloadingArdName(filename);
    try {
      const csvText = await v2GetCsv(workflowId, filename);
      const blob = new Blob([csvText], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setArdListError(problemMessage(err, `Could not download ${filename}.`));
    } finally {
      setDownloadingArdName(null);
    }
  };

  const loadEverything = async (isCancelled = () => false) => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const id = await ensureWorkflow();
      if (isCancelled()) return;
      setWorkflowId(id);
      const filesData = await v2ListFiles(id);
      if (isCancelled()) return;
      setFiles((filesData?.items || []).filter((f) => f.kind !== 'ard'));

      loadArdList(id);

      const saved = await loadScreenState('stitching');
      if (isCancelled()) return;
      restoreDrafts(saved);
    } catch (err) {
      if (!isCancelled()) setLoadError(problemMessage(err, 'Could not load this workflow.'));
    } finally {
      hasRestored.current = true;
      setIsLoading(false);
    }
  };

  useEffect(() => { recordStage('stitching'); }, []);

  useEffect(() => {
    let cancelled = false;
    loadEverything(() => cancelled);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hasRestored.current) return undefined;
    const timer = setTimeout(() => { saveScreenState('stitching', persistableState()); }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, drafts, activeTabId]);

  useEffect(() => {
    if (!workflowId || !hasRestored.current) return;
    if (draft.steps.length && !draft.joinCards.length
        && !draft.isSavingPipeline && !draft.pipelineError) {
      rebuildCardsFromSteps(draft.steps);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflowId, activeTabId, draft.steps.length, draft.joinCards.length,
      draft.isSavingPipeline, draft.pipelineError]);

  const addNewArdTab = () => {
    tabCounter += 1;
    const newId = `ard-${Date.now()}`;
    const suggested = `ARD ${tabCounter}`;
    setTabs((prev) => [
      ...prev,
      { id: newId, title: suggested, grain: 'custom', removable: true, editing: true },
    ]);
    setDrafts((prev) => ({ ...prev, [newId]: makeDefaultDraft() }));
    setActiveTabId(newId);
    setRenameValue(suggested);
  };

  const startRenameTab = (tabId, e) => {
    e.stopPropagation();
    const current = tabs.find((t) => t.id === tabId)?.title || '';
    setRenameValue(current);
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, editing: true } : t)));
  };

  const finishRenameTab = (tabId, newTitle) => {
    setTabs((prev) => prev.map((t) => (
      t.id === tabId ? { ...t, title: String(newTitle).trim() || t.title, editing: false } : t
    )));
  };

  const cancelRenameTab = (tabId) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, editing: false } : t)));
  };

  const removeTab = async (tabId, e) => {
    e.stopPropagation();

    const tab = tabs.find((t) => t.id === tabId);
    const tabDraft = drafts[tabId] || {};
    const stepCount = (tabDraft.steps || []).length;
    const builtArd = tabDraft.generatedArd?.filename || tabDraft.generatedArdName || null;

    if (stepCount > 0 || builtArd) {
      const label = tab?.title || 'this ARD';
      const joins = stepCount === 1 ? '1 join' : `${stepCount} joins`;
      const lines = [`Delete ${label}?`, ''];
      if (stepCount > 0) lines.push(`Its ${joins} will be removed from this workflow.`);
      if (builtArd) lines.push(`The generated dataset "${builtArd}" will be deleted too.`);
      if (!window.confirm(lines.join('\n'))) return;
    }

    const remaining = tabs.filter((t) => t.id !== tabId);
    setTabs(remaining);
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
    if (activeTabId === tabId) setActiveTabId(remaining[0]?.id || '');

    if (!builtArd || !workflowId) return;
    try {
      await deleteFile(workflowId, builtArd);
      await forgetFile(builtArd);
    } catch (err) {
      setTabError(problemMessage(err, `Removed ${tab?.title || 'the ARD'}, but "${builtArd}" could not be deleted.`));
    }
  };

  const toggleFile = (filename) => {
    const next = new Set(draft.selectedFiles);
    if (next.has(filename)) next.delete(filename);
    else next.add(filename);
    setDraft({ selectedFiles: next });
  };

  const selectedFileList = files.filter((f) => draft.selectedFiles.has(f.filename));

  const validateStep = (step) => {
    if (step.operationType === 'carryover') {
      if (!step.sourceFile) return 'Select a Stitched ARD Table as the Source Dataset.';
      if (!step.metricColumn) return 'Select a Sales Column to compute carryover from.';
      if (!step.dateKey) return 'Select a Time / Date Key.';
      if (!(step.entityKeys || []).length) return 'Select at least one Entity / Grain Key.';
      if (step.decayRate === '' || Number.isNaN(Number(step.decayRate))) return 'Enter a valid Decay Rate.';
      return null;
    }

    if (step.operationType === 'rollup') {
      if (!step.sourceFile || !step.bridgeFile) {
        return 'Choose both a Lower Grain Source Dataset and a Bridge/Crosswalk Mapping Dataset.';
      }
      if (!step.rollupMappingMethod) {
        return 'Please choose a Mapping Method for multi-mapped records.';
      }
      if (step.rollupMappingMethod === 'weighted_split') {
        if (!step.weightFile || !step.weightMatchKey || !step.weightColumn) {
          return 'Weighted Distribution requires Weight Source File, Weight Match Key, and Weight Value Column.';
        }
      }
      if (!step.sourceKey || !step.matchKey || !step.targetKey || !step.dateKey) {
        return 'Source Key, Match Key, Target Key, and Time/Date Key are all required.';
      }
      return null;
    }

    if (step.operationType === 'allocate') {
      if (!step.higherGrainFile || !step.lowerGrainStructureFile) {
        return 'Choose both a Higher Grain Spend/Media Dataset and a Target Lower Grain Structure Dataset.';
      }
      if (!step.crosswalkFile || !step.crosswalkMatchKey) {
        return 'Crosswalk Mapping Dataset and Crosswalk Match Key are required.';
      }
      if (!step.sourceGrainKey || !step.targetGrainKey || !step.dateKey) {
        return 'Source Grain Key, Target Grain Key, and Time/Date Key are required.';
      }
      if (!(step.metricsToAllocate || []).length) {
        return 'Select at least one media metric to allocate down.';
      }
      if (step.allocationMethod === 'weighted_column' && (!step.weightDatasetFile || !step.weightColumn)) {
        return 'Weighted-column allocation needs a Weight Dataset and a Weight Column.';
      }
      return null;
    }

    if (!step.leftFile || !step.rightFile) {
      return 'Choose both a left and right dataset.';
    }
    if (step.joinType === 'cross') return null;

    const pairs = step.keyPairs || [];
    const filled = pairs.filter((p) => p.left && p.right);
    if (!filled.length) {
      return 'At least one key pair is required.';
    }
    if (pairs.some((p) => Boolean(p.left) !== Boolean(p.right))) {
      return 'Every key pair needs a column on both sides, or remove the row.';
    }
    const leftKeys = filled.map((p) => p.left);
    if (new Set(leftKeys).size !== leftKeys.length) {
      return 'The same left column is used in more than one key pair.';
    }
    return null;
  };

  const defaultArdName = `${slugify(activeTab?.title) || 'ard'}.csv`;

  const payloadFor = (steps) => ({
    steps: steps.map((s) => {
      if (s.operationType === 'carryover') {
        const metric = s.metricColumn || 'sales';
        return {
          step_type: 'carryover',
          source_file: s.sourceFile,
          entity_keys: s.entityKeys || [],
          time_key: s.dateKey,
          metric_column: metric,
          output_column_name: s.outputColumnName || `carryover_${metric}`,
          decay_rate: Number(s.decayRate ?? 0.6),
          first_period_value: s.firstPeriodValue || 'zero',
          time_gap_handling: s.timeGapHandling || 'reset',
          negative_handling: s.negativeHandling || 'floor_zero',
        };
      }
      if (s.operationType === 'rollup') {
        const isWeighted = s.rollupMappingMethod === 'weighted_split';
        return {
          step_type: 'rollup',
          source_file: s.sourceFile,
          mapping_file: s.bridgeFile,
          source_entity_key: s.sourceKey,
          mapping_source_key: s.matchKey,
          target_entity_key: s.targetKey,
          time_key: s.dateKey,
          agg_rules: s.aggregations || {},
          rollup_mapping_method: s.rollupMappingMethod || 'equal_split',
          ...(isWeighted ? {
            weight_file: s.weightFile || null,
            weight_match_key: s.weightMatchKey || null,
            weight_value_column: s.weightColumn || null,
            weight_fallback: s.weightFallback || 'equal_split',
          } : {}),
        };
      }
      if (s.operationType === 'allocate') {
        const isWeighted = s.allocationMethod === 'weighted_column';
        return {
          step_type: 'allocate',
          source_file: s.higherGrainFile,
          target_file: s.lowerGrainStructureFile,
          mapping_file: s.crosswalkFile,
          mapping_source_grain_key: s.crosswalkMatchKey || null,
          source_grain_key: s.sourceGrainKey,
          target_grain_key: s.targetGrainKey,
          time_key: s.dateKey,
          allocation_method: s.allocationMethod || 'equal',
          allocated_metrics: s.metricsToAllocate || [],
          ...(isWeighted ? {
            weight_file: s.weightDatasetFile || null,
            weight_column: s.weightColumn || null,
          } : {}),
        };
      }
      const base = {
        step_type: 'join',
        left_file: s.leftFile,
        right_file: s.rightFile,
        join_type: s.joinType,
      };
      if (s.joinType === 'cross') return base;
      const filled = (s.keyPairs || []).filter((p) => p.left && p.right);
      return {
        ...base,
        left_key: filled.map((p) => p.left),
        right_key: filled.map((p) => p.right),
      };
    }),
    target_grain: targetGrain,
    ...(draft.ardName.trim() ? { output: draft.ardName.trim() } : {}),
  });

  const rebuildCardsFromSteps = async (steps) => {
    if (steps.length === 0) {
      setDraft({ steps: [], joinCards: [], finalRowCount: null, finalColumnCount: null, activePreview: null, generatedArd: null });
      return true;
    }
    setDraft({ isSavingPipeline: true, pipelineError: null });
    try {
      const data = await v2BuildArd(workflowId, payloadFor(steps), { dryRun: true });
      const cards = (data.lineage?.steps_executed || []).map((s) => ({
        step: s.step,
        type: s.type,
        left: s.left,
        right: s.right,
        join: s.join,
        keys: s.keys || [],
        source: s.source,
        target: s.target,
        mapping: s.mapping,
        groupBy: s.group_by || [],
        method: s.method,
        weightDataset: s.weight_dataset,
        weightColumn: s.weight_column,
        allocatedMetrics: s.allocated_metrics || [],
        entityKeys: s.entity_keys || [],
        timeKey: s.time_key,
        metricColumn: s.metric_column,
        outputColumn: s.output_column,
        decayRate: s.decay_rate,
        rows_in: s.rows_in ?? 0,
        rows_out: s.rows_out ?? 0,
        columns: s.columns || [],
      }));
      setDraft({
        steps,
        joinCards: cards,
        finalRowCount: data.row_count ?? 0,
        finalColumnCount: data.columns?.length ?? 0,
        isSavingPipeline: false,
        activePreview: null,
        generatedArd: null,
      });
      return true;
    } catch (err) {
      setDraft({
        isSavingPipeline: false,
        pipelineError: {
          title: problemMessage(err, 'Stitching failed'),
          errors: err.errors?.length ? err.errors : [{ message: problemMessage(err) }],
        },
      });
      return false;
    }
  };

  const openAddJoinModal = () => {
    if (draft.selectedFiles.size === 0) return;
    setModal({ mode: 'add', stepIndex: draft.steps.length, step: makeEmptyStep(), error: null });
  };

  const openEditJoinModal = (cardIndex) => {
    const existing = draft.steps[cardIndex];
    if (existing?.operationType === 'carryover') {
      setCarryoverModal({ mode: 'edit', stepIndex: cardIndex, step: { ...existing }, error: null });
    } else {
      setModal({ mode: 'edit', stepIndex: cardIndex, step: { ...existing }, error: null });
    }
  };

  const openCarryoverModal = () => {
    const defaultSource = savedArds[0]?.filename || (draft.joinCards.length > 0 ? `Step ${draft.joinCards.length} Result` : (selectedFileList[0]?.filename || ''));
    const step = {
      ...makeEmptyStep(),
      operationType: 'carryover',
      sourceFile: defaultSource,
    };
    setCarryoverModal({ mode: 'add', stepIndex: draft.steps.length, step, error: null });
  };

  const handleModalStepChange = (updates) => {
    setModal((prev) => ({ ...prev, step: { ...prev.step, ...updates } }));
  };

  const handleCarryoverModalStepChange = (updates) => {
    setCarryoverModal((prev) => ({ ...prev, step: { ...prev.step, ...updates } }));
  };

  const handleModalDone = async () => {
    const err = validateStep(modal.step);
    if (err) {
      setModal((prev) => ({ ...prev, error: err }));
      return;
    }
    const newSteps = modal.mode === 'add'
      ? [...draft.steps, modal.step]
      : draft.steps.map((s, i) => (i === modal.stepIndex ? modal.step : s));

    const ok = await rebuildCardsFromSteps(newSteps);
    if (ok) setModal(null);
    else setModal((prev) => ({ ...prev, error: 'See error below — pipeline could not be validated.' }));
  };

  const handleCarryoverDone = async () => {
    const err = validateStep(carryoverModal.step);
    if (err) {
      setCarryoverModal((prev) => ({ ...prev, error: err }));
      return;
    }
    const newSteps = carryoverModal.mode === 'add'
      ? [...draft.steps, carryoverModal.step]
      : draft.steps.map((s, i) => (i === carryoverModal.stepIndex ? carryoverModal.step : s));

    const ok = await rebuildCardsFromSteps(newSteps);
    if (ok) setCarryoverModal(null);
    else setCarryoverModal((prev) => ({ ...prev, error: 'See error below — carryover calculation failed.' }));
  };

  const handleDeleteJoin = async (cardIndex) => {
    const newSteps = draft.steps.filter((_, i) => i !== cardIndex);
    await rebuildCardsFromSteps(newSteps);
  };

  const handleCardPreview = async (cardIndex) => {
    if (draft.activePreview?.cardIndex === cardIndex && !draft.activePreview.isLoading) {
      setDraft({ activePreview: null });
      return;
    }
    setDraft({ activePreview: { cardIndex, data: null, isLoading: true, error: null } });
    try {
      const truncatedSteps = draft.steps.slice(0, cardIndex + 1);
      const data = await v2BuildArd(workflowId, payloadFor(truncatedSteps), { dryRun: true });
      updateDraft((current) => {
        if (current.activePreview?.cardIndex !== cardIndex) return current;
        return { ...current, activePreview: { cardIndex, data, isLoading: false, error: null } };
      });
    } catch (err) {
      updateDraft((current) => {
        if (current.activePreview?.cardIndex !== cardIndex) return current;
        return { ...current, activePreview: { cardIndex, data: null, isLoading: false, error: problemMessage(err) } };
      });
    }
  };

  const handleGenerate = async () => {
    setDraft({ generateError: null, isGenerating: true, generatedArd: null, activePreview: null });
    try {
      const built = await v2BuildArd(workflowId, payloadFor(draft.steps), { dryRun: false });
      setDraft({ generatedArd: built });
      loadArdList(workflowId);
    } catch (err) {
      setDraft({
        isGenerating: false,
        generateError: {
          title: problemMessage(err, 'Stitching failed'),
          errors: err.errors?.length ? err.errors : [{ message: problemMessage(err) }],
        },
      });
      return;
    }
    setDraft({ isGenerating: false });
  };

  const stepResultColumns = Object.fromEntries(
    draft.joinCards
      .filter((card) => (card.columns || []).length)
      .map((card) => [`Step ${card.step} Result`, card.columns])
  );

  const previewedCard = draft.activePreview ? draft.joinCards[draft.activePreview.cardIndex] : null;

  const shownPreview = draft.activePreview
    ? {
        heading: previewedCard
          ? `Step ${previewedCard.step} result: ${previewedCard.left || previewedCard.source}`
          : null,
        isLoading: draft.activePreview.isLoading,
        error: draft.activePreview.error,
        data: draft.activePreview.data,
      }
    : draft.generatedArd
    ? {
        heading: `Generated ${draft.generatedArd.filename}` +
          (draft.generatedArd.version ? ` (version ${draft.generatedArd.version})` : ''),
        isLoading: false,
        error: null,
        data: draft.generatedArd,
        isGenerated: true,
      }
    : null;

  const failedSteps = new Set(
    (draft.pipelineError?.errors || [])
      .concat(draft.generateError?.errors || [])
      .map((e) => e.step)
      .filter((n) => typeof n === 'number')
  );

  return (
    <div className="stitching-page">
      <div className="page-header">
        <div>
          <p className="page-header-title">Data Stitching</p>
          <p className="page-header-subtitle">Join your mapped files into analytic record datasets</p>
        </div>
        <button className="new-ard-btn" onClick={addNewArdTab}>+ Add New ARD</button>
      </div>

      {isLoading && <p className="stitching-empty">Loading...</p>}

      {!isLoading && loadError && (
        <div className="stitching-error-banner">
          <p className="error-title">Couldn't load this workflow</p>
          <p>{loadError}</p>
        </div>
      )}

      {!isLoading && !loadError && (
        <div className="stitching-card">
          {tabError && (
            <div className="stitching-tab-error" role="status">
              <span>{tabError}</span>
              <button type="button" onClick={() => setTabError(null)} aria-label="Dismiss">✕</button>
            </div>
          )}

          {/* ---- Tab bar ---- */}
          <div className="grain-tabs">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`grain-tab${activeTabId === t.id ? ' active' : ''}`}
                onClick={() => setActiveTabId(t.id)}
                onDoubleClick={(e) => t.removable && startRenameTab(t.id, e)}
                role="button"
                tabIndex={0}
              >
                {t.editing ? (
                  <span className="tab-rename-row">
                    <input
                      className="tab-rename-input"
                      value={renameValue}
                      autoFocus
                      aria-label="ARD name"
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onBlur={() => finishRenameTab(t.id, renameValue)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') finishRenameTab(t.id, renameValue);
                        if (e.key === 'Escape') cancelRenameTab(t.id);
                      }}
                    />
                    <button
                      type="button"
                      className="tab-rename-save"
                      aria-label="Save ARD name"
                      title="Save name"
                      disabled={!renameValue.trim()}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={(e) => {
                        e.stopPropagation();
                        finishRenameTab(t.id, renameValue);
                      }}
                    >
                      ✓
                    </button>
                  </span>
                ) : (
                  <>
                    {t.title}
                    <button
                      type="button"
                      className="tab-edit-btn"
                      aria-label={`Rename ${t.title}`}
                      title="Rename"
                      onClick={(e) => startRenameTab(t.id, e)}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className="tab-remove-x"
                      aria-label={`Delete ${t.title}`}
                      title="Delete"
                      onClick={(e) => removeTab(t.id, e)}
                    >
                      ✕
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          {!activeTab && (
            <div className="stitching-empty">
              No ARD yet. Use <strong>+ Add New</strong> above to create one.
            </div>
          )}

          {activeTab && (
            <>
              <GranularityPanel
                files={files}
                workflowId={workflowId}
                onApplied={() => loadEverything()}
              />

              {/* ---- Source files ---- */}
              <div className="source-files-card">
                <p className="section-heading">Source Files</p>
                <p className="section-desc">
                  Select the mapped source files to include in <strong>{ardLabel}</strong>:
                </p>
                <div className="file-checkbox-grid">
                  {files.map((f) => (
                    <label key={f.filename} className={`file-checkbox-card${draft.selectedFiles.has(f.filename) ? ' selected' : ''}`}>
                      <input type="checkbox" checked={draft.selectedFiles.has(f.filename)} onChange={() => toggleFile(f.filename)} />
                      <div>
                        <p className="file-checkbox-name">{f.filename}</p>
                        <p className="file-checkbox-meta">{f.columns?.length ?? 0} columns</p>
                      </div>
                    </label>
                  ))}
                </div>
                <div className="source-files-footer">
                  <span>Mapping file and population universe files included automatically</span>
                  <span>{draft.selectedFiles.size} file(s) active</span>
                </div>
              </div>

              {/* ---- Current Joins & Transformations ---- */}
              <div className="current-joins-card">
                <div className="current-joins-header">
                  <p className="section-heading">
                    Current Joins &amp; Enriched Columns
                    {draft.joinCards.length > 0 && (
                      <span className="heading-note" style={{ marginLeft: '0.6rem' }}>
                        {(draft.finalRowCount ?? 0).toLocaleString()} rows · {draft.finalColumnCount ?? 0} columns
                      </span>
                    )}
                  </p>
                  <button
                    className="add-step-btn"
                    onClick={openAddJoinModal}
                    disabled={draft.selectedFiles.size === 0}
                    title={draft.selectedFiles.size === 0 ? 'Select at least one source file above first' : undefined}
                  >
                    + Add Join
                  </button>
                </div>

                {draft.pipelineError && (
                  <div className="stitching-error-banner">
                    <p className="error-title">{draft.pipelineError.title}</p>
                    {draft.pipelineError.errors.map((e, i) => <p key={i}>{e.message}</p>)}
                  </div>
                )}

                {draft.joinCards.length === 0 ? (
                  <p className="stitching-empty">
                    {draft.selectedFiles.size === 0
                      ? 'Select at least one source file above, then click "+ Add Join".'
                      : 'No joins configured yet — click "+ Add Join" above to get started.'}
                  </p>
                ) : (
                  draft.joinCards.map((card, i) => (
                    <div
                      key={i}
                      className={`join-summary-card${draft.activePreview?.cardIndex === i ? ' active' : ''}${failedSteps.has(card.step) ? ' has-error' : ''}`}
                    >
                      <div className="join-summary-header">
                        <span className="step-card-title">
                          {(card.type || draft.steps[i]?.operationType) === 'carryover'
                            ? `Step ${card.step} Carryover Column`
                            : (card.type || draft.steps[i]?.operationType) === 'join'
                            ? `Join ${card.step} ${JOIN_LABELS[card.join] || card.join}`
                            : (card.type || draft.steps[i]?.operationType) === 'rollup'
                            ? `Step ${card.step} Rollup (${(draft.steps[i]?.rollupMappingMethod === 'weighted_split' || card.mapping_method === 'weighted_split') ? 'Weighted Split' : 'Equal Split'})`
                            : (card.type || draft.steps[i]?.operationType) === 'allocate'
                            ? `Step ${card.step} Allocation`
                            : `Step ${card.step} ${card.operation || ''}`}
                        </span>
                        <span className="join-summary-rows">
                          {(card.rows_in ?? 0).toLocaleString()} → {' '}
                          <span className={(card.rows_out ?? 0) < (card.rows_in ?? 0) ? 'rows-dropped' : ''}>{(card.rows_out ?? 0).toLocaleString()}</span> rows
                        </span>
                      </div>
                      <p className="join-summary-desc">
                        {card.type === 'carryover' ? (
                          <>
                            Computing <code>{card.outputColumn || draft.steps[i]?.outputColumnName || 'carryover'}</code> = {card.decayRate || draft.steps[i]?.decayRate}&times;{card.metricColumn || draft.steps[i]?.metricColumn}(t-1) on <strong>{card.source || draft.steps[i]?.sourceFile}</strong> partitioned by <strong>{(card.entityKeys || draft.steps[i]?.entityKeys || []).join(', ')}</strong> sorted by <code>{card.timeKey || draft.steps[i]?.dateKey}</code>
                          </>
                        ) : card.type === 'join' ? (
                          card.join === 'cross' ? (
                            <>
                              Every combination of <strong>{card.left}</strong> and{' '}
                              <strong>{card.right}</strong>, no keys
                            </>
                          ) : (
                            <>
                              Joining <strong>{card.left}</strong> with{' '}
                              <strong>{card.right}</strong> on{' '}
                              {(card.keys || []).map((k, ki) => (
                                <span key={k}>
                                  {ki > 0 && ' + '}
                                  <code>{k}</code>
                                </span>
                              ))}
                            </>
                          )
                        ) : card.type === 'rollup' ? (
                          <>
                            Rolling up <strong>{card.source}</strong> via{' '}
                            <strong>{card.mapping}</strong>
                            {card.groupBy?.length ? (
                              <>
                                {' '}grouped by{' '}
                                {card.groupBy.map((k, ki) => (
                                  <span key={k}>{ki > 0 && ' + '}<code>{k}</code></span>
                                ))}
                              </>
                            ) : null}
                          </>
                        ) : card.type === 'allocate' ? (
                          <>
                            Allocating <strong>{card.source}</strong> down to{' '}
                            <strong>{card.target}</strong>'s grain via{' '}
                            <strong>{card.mapping}</strong>
                            {card.method ? <> ({card.method.replace(/_/g, ' ')})</> : null}
                          </>
                        ) : draft.steps[i]?.operationType === 'carryover' ? (
                          <>
                            Computing <code>{draft.steps[i]?.outputColumnName}</code> = {draft.steps[i]?.decayRate}&times;{draft.steps[i]?.metricColumn}(t-1)
                          </>
                        ) : (
                          'Configured step'
                        )}
                      </p>
                      <div className="join-summary-actions">
                        <button className="preview-btn" onClick={() => handleCardPreview(i)}>
                          {draft.activePreview?.cardIndex === i ? 'Hide Preview' : 'See Preview'}
                        </button>
                        <button className="edit-btn" onClick={() => openEditJoinModal(i)}>Edit</button>
                        <button className="delete-btn" onClick={() => handleDeleteJoin(i)}>Delete</button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {draft.selectedFiles.size === 0 && (
                <p className="step-error-text">Select at least one source file above first.</p>
              )}
              {draft.generateError && (
                <div className="stitching-error-banner">
                  <p className="error-title">{draft.generateError.title}</p>
                  {draft.generateError.errors.map((e, i) => <p key={i}>{e.message}</p>)}
                </div>
              )}

              {/* ---- Preview & Stitch Generation Actions ---- */}
              <div className="stitch-result">
                <div className="preview-panel">
                  {!shownPreview ? (
                    <div className="preview-placeholder">
                      <p className="preview-placeholder-title">No Preview Yet</p>
                      <p className="preview-placeholder-desc">
                        Click <strong>See Preview</strong> on any join step above to see its result here.
                      </p>
                    </div>
                  ) : (
                    <>
                      {shownPreview.heading && (
                        <p className={`preview-panel-heading${shownPreview.isGenerated ? ' is-generated' : ''}`}>
                          {shownPreview.heading}
                        </p>
                      )}
                      {shownPreview.isLoading && <p className="stitching-empty">Loading preview...</p>}
                      {shownPreview.error && <p className="step-error-text">{shownPreview.error}</p>}
                      {shownPreview.data && (
                        <>
                          <div className="sample-table-scroll">
                            <table className="sample-table">
                              <thead>
                                <tr>{(shownPreview.data.columns || []).map((c) => <th key={c}>{c}</th>)}</tr>
                              </thead>
                              <tbody>
                                {(shownPreview.data.preview || []).slice(0, 15).map((row, ri) => (
                                  <tr key={ri}>
                                    {(shownPreview.data.columns || []).map((c) => (
                                      <td key={c}>{row[c] === null || row[c] === undefined ? '-' : row[c]}</td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="sample-count-line">
                            {(shownPreview.data.row_count ?? 0).toLocaleString()} rows · {(shownPreview.data.columns || []).length} columns
                          </p>
                        </>
                      )}
                    </>
                  )}
                </div>

                <div className="stitch-generate-actions">
                  <div className="ard-name-field">
                    <label className="step-field-label" htmlFor="ard-name">
                      Resulting ARD Dataset Name
                    </label>
                    <input
                      id="ard-name"
                      type="text"
                      className="step-input"
                      value={draft.ardName}
                      onChange={(e) => setDraft({ ardName: e.target.value })}
                      placeholder={defaultArdName}
                    />
                  </div>

                  {/* ── Add Column (Carryover) Action ── */}
                  <button
                    type="button"
                    className="add-carryover-btn"
                    onClick={openCarryoverModal}
                    title="Calculate lagged carryover partitioned per entity"
                  >
                    + Add Column (Carryover)
                  </button>

                  <button
                    className="execute-btn"
                    onClick={handleGenerate}
                    disabled={draft.joinCards.length === 0 || draft.isGenerating}
                    title={draft.joinCards.length === 0 ? 'Add at least one join first' : undefined}
                  >
                    {draft.isGenerating ? 'Generating...' : 'Generate Data Stitching'}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {modal && (
        <SingleJoinModal
          files={files}
          selectedFileList={selectedFileList}
          ardLabel={ardLabel}
          mode={modal.mode}
          stepIndex={modal.stepIndex}
          existingSteps={draft.steps}
          stepResultColumns={stepResultColumns}
          step={modal.step}
          error={modal.error}
          isSaving={draft.isSavingPipeline}
          onChange={handleModalStepChange}
          onDone={handleModalDone}
          onClose={() => setModal(null)}
        />
      )}

      {carryoverModal && (
        <CarryoverConfigModal
          files={files}
          savedArds={savedArds}
          declaredRoles={declaredRoles}
          selectedFileList={selectedFileList}
          ardLabel={ardLabel}
          mode={carryoverModal.mode}
          stepIndex={carryoverModal.stepIndex}
          stepResultColumns={stepResultColumns}
          step={carryoverModal.step}
          error={carryoverModal.error}
          isSaving={draft.isSavingPipeline}
          onChange={handleCarryoverModalStepChange}
          onDone={handleCarryoverDone}
          onClose={() => setCarryoverModal(null)}
        />
      )}

      {!isLoading && !loadError && (
        <div className="saved-ards-card">
          <p className="saved-ards-title">Saved Stitched ARD Datasets</p>
          {isLoadingArds && <p className="stitching-empty">Loading saved ARDs...</p>}
          {ardListError && (
            <div className="stitching-error-banner">
              <p className="error-title">{ardListError}</p>
            </div>
          )}
          {!isLoadingArds && !ardListError && savedArds.length === 0 && (
            <p className="stitching-empty">No ARDs generated yet in this workflow.</p>
          )}
          {!isLoadingArds && savedArds.length > 0 && (
            <div className="saved-ards-list">
              {savedArds.map((ard) => (
                <div key={ard.filename} className="saved-ard-row">
                  <div className="saved-ard-info">
                    <p className="saved-ard-name">{ard.filename}</p>
                    <p className="saved-ard-meta">
                      {(ard.grain || '').toUpperCase() || 'Grain unknown'} &bull;{' '}
                      {(ard.row_count ?? 0).toLocaleString()} rows &bull;{' '}
                      {(ard.columns?.length ?? ard.column_count ?? 0)} cols
                      {ard.version ? ` \u2022 ${ard.version}` : ''}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="download-ard-btn"
                    onClick={() => handleDownloadArd(ard.filename)}
                    disabled={downloadingArdName === ard.filename}
                  >
                    &#8595; {downloadingArdName === ard.filename ? 'Downloading...' : 'Download CSV'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <PageFooterNav currentStepId="data-stitching" />
    </div>
  );
}

// ─── Carryover Configuration Modal (Operates on Stitched ARDs) ──────────────
function CarryoverConfigModal({
  files,
  savedArds = [],
  declaredRoles = {},
  selectedFileList,
  ardLabel,
  mode,
  stepIndex,
  stepResultColumns = {},
  step,
  error,
  isSaving,
  onChange,
  onDone,
  onClose,
}) {
  const columnsForDataset = (name) => {
    const foundArd = savedArds.find((a) => a.filename === name);
    if (foundArd && Array.isArray(foundArd.columns) && foundArd.columns.length) {
      return foundArd.columns;
    }
    const dataset = files.find((f) => f.filename === name);
    if (dataset && Array.isArray(dataset.columns)) return dataset.columns;
    const fromStep = stepResultColumns[name];
    return fromStep && fromStep.length ? fromStep : null;
  };

  const currentDatasetCols = columnsForDataset(step.sourceFile) || [];

  // Strictly filter to columns classified as "Dependent Variable" (Sales KPI) during Data Ingestion
  const salesOnlyCols = useMemo(() => {
    const allRoles = rolesFor(currentDatasetCols, declaredRoles);
    const matched = currentDatasetCols.filter((col) => allRoles[col] === 'Dependent Variable');
    return matched.length > 0 ? matched : currentDatasetCols.filter((c) => isMetricColumn(c));
  }, [currentDatasetCols, declaredRoles]);

  const toggleEntityKey = (col) => {
    const current = step.entityKeys || [];
    const next = current.includes(col) ? current.filter((k) => k !== col) : [...current, col];
    onChange({ entityKeys: next });
  };

  const metricChanged = (col) => {
    const defaultOutput = col ? `carryover_${col}` : '';
    onChange({ metricColumn: col, outputColumnName: step.outputColumnName || defaultOutput });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="create-ard-modal carryover-modal" onClick={(e) => e.stopPropagation()}>
        <div className="create-ard-header">
          <div>
            <p className="create-ard-title">{mode === 'edit' ? 'Edit Carryover Column' : 'Add Column: Carryover'}</p>
            <p className="create-ard-subtitle">Calculate lagged metric carryover partitioned per entity without cross-entity leakage ({ardLabel})</p>
          </div>
          <button className="create-ard-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="create-ard-body">
          <div className="step-card">
            <div className="step-grid-2">
              <div>
                <p className="step-field-label">1. Source Dataset to Operate On (Stitched ARD Table)</p>
                <select
                  className="step-select"
                  value={step.sourceFile || ''}
                  onChange={(e) => onChange({ sourceFile: e.target.value, metricColumn: '', dateKey: '', entityKeys: [] })}
                >
                  <option value="">Select Stitched ARD Table...</option>
                  {savedArds.map((ard) => (
                    <option key={ard.filename} value={ard.filename}>
                      {ard.filename} ({ard.grain?.toUpperCase() || 'ARD'} &bull; {(ard.row_count ?? 0).toLocaleString()} rows)
                    </option>
                  ))}
                  {savedArds.length === 0 && (
                    <option value="" disabled>No saved ARDs found. Generate an ARD first.</option>
                  )}
                </select>
              </div>
              <div>
                <p className="step-field-label">2. Time / Date Key (Chronologically Sorted)</p>
                <select className="step-select" value={step.dateKey || ''} onChange={(e) => onChange({ dateKey: e.target.value })}>
                  <option value="">Select date column...</option>
                  {currentDatasetCols.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>

            <div style={{ marginBottom: '0.8rem' }}>
              <p className="step-field-label">
                3. Entity / Grain Key(s) &bull; Carryover never leaks across entities
              </p>
              <div className="carryover-pill-box">
                {currentDatasetCols.length === 0 && (
                  <span className="step-hint-text">Select a Stitched ARD Table above first.</span>
                )}
                {currentDatasetCols.map((col) => {
                  const selected = (step.entityKeys || []).includes(col);
                  return (
                    <span
                      key={col}
                      className={`metric-pill${selected ? ' selected' : ''}`}
                      onClick={() => toggleEntityKey(col)}
                    >
                      {selected ? '\u2713 ' : '+ '}{col}
                    </span>
                  );
                })}
              </div>
            </div>

            <div className="step-grid-2">
              <div>
                <p className="step-field-label">4. Sales Column (Classified in Data Ingestion)</p>
                <select
                  className="step-select"
                  value={step.metricColumn || ''}
                  onChange={(e) => metricChanged(e.target.value)}
                >
                  <option value="">Select sales column...</option>
                  {salesOnlyCols.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                {salesOnlyCols.length === 0 && currentDatasetCols.length > 0 && (
                  <p className="step-hint-text" style={{ color: '#c0392b', marginTop: '0.3rem', border: 'none', padding: 0 }}>
                    No column in this dataset was categorized as "Dependent Variable (Sales KPI)" during Data Ingestion.
                  </p>
                )}
              </div>
              <div>
                <p className="step-field-label">5. Output Column Name</p>
                <input
                  type="text"
                  className="step-input"
                  value={step.outputColumnName || ''}
                  placeholder={`carryover_${step.metricColumn || 'sales'}`}
                  onChange={(e) => onChange({ outputColumnName: e.target.value })}
                />
                <p className="step-hint-text" style={{ marginTop: '0.35rem', border: 'none', padding: 0 }}>
                  Categorized as: <strong style={{ color: '#a8710d' }}>Baseline Variables</strong> (carried forward to future modules).
                </p>
              </div>
            </div>

            <hr style={{ border: 'none', borderTop: '1px solid var(--color-border-light)', margin: '1rem 0' }} />

            <p className="step-field-label" style={{ fontWeight: 'var(--font-weight-bold)' }}>
              6. Decay Rate (&lambda;) Configuration &bull; Simple Lag Method
            </p>
            <div className="step-grid-2" style={{ alignItems: 'center' }}>
              <div>
                <p className="step-field-label">Decay Rate (&lambda;) Method</p>
                <select className="step-select" value={step.decayRateMethod || 'manual'} onChange={(e) => onChange({ decayRateMethod: e.target.value })}>
                  <option value="manual">Manual Entry (Numeric &lambda;)</option>
                </select>
              </div>
              <div>
                <p className="step-field-label">Decay Value (&lambda; &in; [0, 1])</p>
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  className="step-input"
                  value={step.decayRate ?? 0.6}
                  onChange={(e) => onChange({ decayRate: e.target.value })}
                />
              </div>
            </div>
            <p className="step-hint-text" style={{ marginTop: '0.4rem', border: 'none', padding: 0 }}>
              Formula applied: <code>carryover(t) = {step.decayRate || 0.6} &times; {step.metricColumn || 'sales'}(t-1)</code>
            </p>

            <hr style={{ border: 'none', borderTop: '1px solid var(--color-border-light)', margin: '1rem 0' }} />

            <p className="step-field-label" style={{ fontWeight: 'var(--font-weight-bold)' }}>
              7. Edge Case Handling Rules
            </p>
            <div className="step-grid-2">
              <div>
                <p className="step-field-label">First-period value (per entity)</p>
                <select className="step-select" value={step.firstPeriodValue || 'zero'} onChange={(e) => onChange({ firstPeriodValue: e.target.value })}>
                  <option value="zero">Set to 0 (Standard MMx Default)</option>
                  <option value="nan">Set to NaN / blank</option>
                </select>
              </div>
              <div>
                <p className="step-field-label">Time gap handling</p>
                <select className="step-select" value={step.timeGapHandling || 'reset'} onChange={(e) => onChange({ timeGapHandling: e.target.value })}>
                  <option value="reset">Reset carryover to 0 on time gap</option>
                  <option value="continue">Carry through time gap anyway</option>
                </select>
              </div>
            </div>
            <div style={{ marginTop: '0.6rem' }}>
              <p className="step-field-label">Negative / zero sales handling</p>
              <select className="step-select" value={step.negativeHandling || 'floor_zero'} onChange={(e) => onChange({ negativeHandling: e.target.value })}>
                <option value="floor_zero">Floor at 0 (Ignore negative returns/adjustments)</option>
                <option value="allow_negative">Allow negative carryover values</option>
              </select>
            </div>
            <p className="step-hint-text" style={{ marginTop: '0.6rem' }}>
              ℹ️ <strong>New entity mid-series:</strong> Handled automatically. Transitions to new entities trigger the first-period rule, preventing carryover backfilling or bleeding across doctors/DMAs.
            </p>
          </div>

          {error && (
            <div className="stitching-error-banner">
              <p className="error-title">{error}</p>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn" onClick={onClose} style={{ marginRight: '0.5rem' }}>Cancel</button>
          <button className="modal-btn primary" onClick={onDone} disabled={isSaving}>
            {isSaving ? 'Calculating...' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Modal: configure Join / Rollup / Allocate steps ────────────────────────
function SingleJoinModal({ files, selectedFileList, ardLabel, mode, stepIndex, existingSteps, stepResultColumns = {}, step, error, isSaving, onChange, onDone, onClose }) {
  const columnsForDataset = (name) => {
    const dataset = files.find((f) => f.filename === name);
    if (dataset) return dataset.columns || null;
    const fromStep = stepResultColumns[name];
    return fromStep && fromStep.length ? fromStep : null;
  };

  const usedFilenames = (side) => {
    const used = new Set();
    existingSteps.forEach((s, i) => {
      if (i === stepIndex) return;
      if (s.leftFile) used.add(s.leftFile);
      if (s.rightFile) used.add(s.rightFile);
    });
    return used;
  };

  const datasetOptions = (side) => {
    const priorResults = Array.from({ length: stepIndex }, (_, i) => `Step ${i + 1} Result`);
    const used = usedFilenames(side);
    const available = selectedFileList.map((f) => f.filename).filter((name) => !used.has(name));
    return [...available, ...priorResults];
  };

  const allDatasetOptions = [
    ...selectedFileList.map((f) => f.filename),
    ...Array.from({ length: stepIndex }, (_, i) => `Step ${i + 1} Result`),
  ];

  const leftCols = columnsForDataset(step.leftFile);
  const rightCols = columnsForDataset(step.rightFile);

  const keyPairs = step.keyPairs || [{ left: '', right: '' }];

  const onChangeKeyPair = (pairIndex, patch) => {
    onChange({
      keyPairs: keyPairs.map((p, i) => (i === pairIndex ? { ...p, ...patch } : p)),
    });
  };

  const onAddKeyPair = () => {
    const taken = keyPairs.map((p) => p.left);
    const nextLeft = (leftCols || []).find((c) => !taken.includes(c)) || '';
    const nextRight = (rightCols || []).find(
      (c) => c.toLowerCase() === String(nextLeft).toLowerCase()
    ) || '';
    onChange({ keyPairs: [...keyPairs, { left: nextLeft, right: nextRight }] });
  };

  const onRemoveKeyPair = (pairIndex) => {
    if (keyPairs.length <= 1) return;
    onChange({ keyPairs: keyPairs.filter((_, i) => i !== pairIndex) });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="create-ard-modal" onClick={(e) => e.stopPropagation()}>
        <div className="create-ard-header">
          <div>
            <p className="create-ard-title">{mode === 'edit' ? 'Edit Join' : 'Add New Join'}</p>
            <p className="create-ard-subtitle">Building {ardLabel} from {selectedFileList.length} selected file(s)</p>
          </div>
          <button className="create-ard-close-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="create-ard-body">
          <div className="step-card">
            <div className="step-card-header">
              <span className="step-card-title">
                Step {stepIndex + 1} {step.operationType === 'rollup' ? 'Rollup' : step.operationType === 'allocate' ? 'Allocation' : 'Join'}
              </span>
            </div>

            <div style={{ marginBottom: '0.6rem' }}>
              <p className="step-field-label">Operation Type</p>
              <select
                className="step-select"
                value={step.operationType || 'join'}
                onChange={(e) => onChange({ operationType: e.target.value })}
              >
                {OPERATION_TYPES.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>

            {step.operationType === 'join' && (
              <>
                <div className="step-grid-2">
                  <div>
                    <p className="step-field-label">Left Dataset</p>
                    <select className="step-select" value={step.leftFile} onChange={(e) => onChange({ leftFile: e.target.value, keyPairs: [{ left: '', right: '' }] })}>
                      <option value="">Select...</option>
                      {datasetOptions('left').map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div>
                    <p className="step-field-label">Right Dataset</p>
                    <select className="step-select" value={step.rightFile} onChange={(e) => onChange({ rightFile: e.target.value, keyPairs: (step.keyPairs || []).map((p) => ({ ...p, right: '' })) })}>
                      <option value="">Select...</option>
                      {datasetOptions('right').map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                </div>

                <div style={{ marginBottom: '0.6rem' }}>
                  <p className="step-field-label">Join Strategy</p>
                  <select className="step-select" value={step.joinType} onChange={(e) => onChange({ joinType: e.target.value })}>
                    {JOIN_TYPES.map((j) => <option key={j.value} value={j.value}>{j.label}</option>)}
                  </select>
                </div>

                {step.joinType === 'cross' ? (
                  <p className="step-hint-text">
                    A cross join pairs every left row with every right row, so it takes no keys.
                  </p>
                ) : (
                  <>
                    {(step.keyPairs || []).map((pair, pairIndex) => (
                      <div className="step-grid-2" key={pairIndex}>
                        <div className="step-key-block">
                          <p className="step-field-label">
                            {pairIndex + 1}. Key {step.leftFile && `(${step.leftFile})`}
                          </p>
                          {leftCols ? (
                            <select
                              className="step-select"
                              value={pair.left}
                              onChange={(e) => onChangeKeyPair(pairIndex, { left: e.target.value })}
                            >
                              <option value="">Select column...</option>
                              {leftCols.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                          ) : (
                            <input
                              type="text" className="step-input" placeholder="e.g. npi"
                              value={pair.left}
                              onChange={(e) => onChangeKeyPair(pairIndex, { left: e.target.value })}
                            />
                          )}
                        </div>

                        <div className="step-key-block">
                          <p className="step-field-label">
                            {pairIndex + 1}. Key {step.rightFile && `(${step.rightFile})`}
                            {(step.keyPairs || []).length > 1 && (
                              <button
                                type="button"
                                className="step-key-remove"
                                onClick={() => onRemoveKeyPair(pairIndex)}
                                aria-label={`Remove key pair ${pairIndex + 1}`}
                              >&#10005;</button>
                            )}
                          </p>
                          {rightCols ? (
                            <select
                              className="step-select"
                              value={pair.right}
                              onChange={(e) => onChangeKeyPair(pairIndex, { right: e.target.value })}
                            >
                              <option value="">Select column...</option>
                              {rightCols.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                          ) : (
                            <input
                              type="text" className="step-input" placeholder="e.g. npi_id"
                              value={pair.right}
                              onChange={(e) => onChangeKeyPair(pairIndex, { right: e.target.value })}
                            />
                          )}
                        </div>
                      </div>
                    ))}

                    <button type="button" className="step-key-add" onClick={onAddKeyPair}>
                      + Add key pair
                    </button>
                  </>
                )}
              </>
            )}

            {step.operationType === 'rollup' && (
              <>
                <div className="step-grid-2">
                  <div>
                    <p className="step-field-label">Lower Grain Source Dataset (e.g. Sales, Calls)</p>
                    <select className="step-select" value={step.sourceFile} onChange={(e) => onChange({ sourceFile: e.target.value })}>
                      <option value="">Select...</option>
                      {allDatasetOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div>
                    <p className="step-field-label">Bridge / Crosswalk Mapping Dataset</p>
                    <select className="step-select" value={step.bridgeFile} onChange={(e) => onChange({ bridgeFile: e.target.value })}>
                      <option value="">Select...</option>
                      {allDatasetOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                </div>

                <div style={{ marginBottom: '0.8rem', padding: '0.7rem', backgroundColor: '#f7f9fc', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border-light)' }}>
                  <p className="step-field-label" style={{ fontWeight: 'var(--font-weight-bold)' }}>
                    Mapping Method (for multi-mapped records)
                  </p>
                  <select
                    className="step-select"
                    value={step.rollupMappingMethod || 'equal_split'}
                    onChange={(e) => onChange({ rollupMappingMethod: e.target.value })}
                  >
                    <option value="equal_split">Equal Distribution (1/n per target)</option>
                    <option value="weighted_split">Weighted Distribution (via Weight File)</option>
                  </select>
                  <p className="step-hint-text" style={{ marginTop: '0.35rem', border: 'none', padding: 0, backgroundColor: 'transparent' }}>
                    Applies only when a record in the Source dataset maps to more than one Target grain value (e.g. one HCP mapped to multiple DMAs). Choose how to split metrics across these ambiguous mappings.
                  </p>

                  {step.rollupMappingMethod === 'equal_split' && (
                    <div style={{ marginTop: '0.5rem', padding: '0.4rem 0.6rem', backgroundColor: '#eef1ff', borderRadius: '4px', fontSize: '0.75rem', color: '#1e3a8a' }}>
                      ℹ️ Each mapped Target (e.g. DMA) will receive an equal 1/n share of the record's metrics, where n = number of targets the record maps to.
                    </div>
                  )}

                  {step.rollupMappingMethod === 'weighted_split' && (
                    <div style={{ marginTop: '0.6rem', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                      <div className="step-grid-2">
                        <div>
                          <p className="step-field-label">Weight Source File</p>
                          <select
                            className="step-select"
                            value={step.weightFile}
                            onChange={(e) => onChange({ weightFile: e.target.value, weightMatchKey: '', weightColumn: '' })}
                          >
                            <option value="">Select Weight dataset...</option>
                            {allDatasetOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </div>
                        <div>
                          <p className="step-field-label">If record has no matching weight, apply:</p>
                          <select
                            className="step-select"
                            value={step.weightFallback || 'equal_split'}
                            onChange={(e) => onChange({ weightFallback: e.target.value })}
                          >
                            <option value="equal_split">Equal split among its mapped targets</option>
                            <option value="exclude">Exclude from rollup (drop record)</option>
                          </select>
                        </div>
                      </div>

                      {(() => {
                        const wCols = columnsForDataset(step.weightFile);
                        return (
                          <div className="step-grid-2">
                            <div>
                              <p className="step-field-label">Weight Match Key (e.g. npi_id)</p>
                              {wCols ? (
                                <select className="step-select" value={step.weightMatchKey} onChange={(e) => onChange({ weightMatchKey: e.target.value })}>
                                  <option value="">Select match key...</option>
                                  {wCols.map((c) => <option key={c} value={c}>{c}</option>)}
                                </select>
                              ) : (
                                <input type="text" className="step-input" placeholder="e.g. npi_id" value={step.weightMatchKey} onChange={(e) => onChange({ weightMatchKey: e.target.value })} />
                              )}
                            </div>
                            <div>
                              <p className="step-field-label">Weight Value Column (e.g. split_pct, weight)</p>
                              {wCols ? (
                                <select className="step-select" value={step.weightColumn} onChange={(e) => onChange({ weightColumn: e.target.value })}>
                                  <option value="">Select weight column...</option>
                                  {wCols.map((c) => <option key={c} value={c}>{c}</option>)}
                                </select>
                              ) : (
                                <input type="text" className="step-input" placeholder="e.g. split_pct" value={step.weightColumn} onChange={(e) => onChange({ weightColumn: e.target.value })} />
                              )}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>

                {(() => {
                  const sourceCols = columnsForDataset(step.sourceFile);
                  const bridgeCols = columnsForDataset(step.bridgeFile);
                  const aggregatableCols = (sourceCols || []).filter(
                    (c) => ![step.sourceKey, step.dateKey, step.targetKey].includes(c)
                      && isMetricColumn(c)
                  );
                  const keyField = (label, field, cols, placeholder) => (
                    <div className="step-key-block">
                      <p className="step-field-label">{label}</p>
                      {cols ? (
                        <select className="step-select" value={step[field]} onChange={(e) => onChange({ [field]: e.target.value })}>
                          <option value="">Select column...</option>
                          {cols.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : (
                        <input type="text" className="step-input" placeholder={placeholder} value={step[field]} onChange={(e) => onChange({ [field]: e.target.value })} />
                      )}
                    </div>
                  );
                  return (
                    <>
                      <div className="step-grid-2">
                        {keyField('1. Source Key (in Source)', 'sourceKey', sourceCols, 'e.g. dma_code')}
                        {keyField('2. Match Key (in Bridge)', 'matchKey', bridgeCols, 'e.g. dma_code')}
                      </div>
                      <div className="step-grid-2">
                        {keyField('3. Target Key (in Bridge)', 'targetKey', bridgeCols, 'e.g. npi_id')}
                        {keyField('4. Time / Date Key', 'dateKey', sourceCols, 'e.g. month_start_date')}
                      </div>

                      <p className="step-field-label" style={{ marginTop: '0.4rem' }}>
                        Group-By Aggregation Rules (Promotional &amp; Sales Metrics)
                        <span className="step-hint-text" style={{ float: 'right' }}>Default: Sum (Conserved)</span>
                      </p>
                      {aggregatableCols.length === 0 && (
                        <p className="step-hint-text">
                          {sourceCols && sourceCols.length
                            ? 'No metric columns in this dataset to aggregate.'
                            : 'Pick the Lower Grain Source Dataset above to configure per-column aggregation.'}
                        </p>
                      )}
                      {aggregatableCols.map((col) => (
                        <div key={col} className="agg-rule-row">
                          <span className="agg-rule-name">{col} <span className="source-badge">Metric</span></span>
                          <select
                            className="step-select"
                            value={aggValue((step.aggregations || {})[col])}
                            onChange={(e) => onChange({ aggregations: { ...(step.aggregations || {}), [col]: e.target.value } })}
                          >
                            {AGG_OPTIONS.map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </>
                  );
                })()}
              </>
            )}

            {step.operationType === 'allocate' && (
              <>
                <div className="step-grid-2">
                  <div>
                    <p className="step-field-label">Higher Grain Spend/Media Dataset</p>
                    <select className="step-select" value={step.higherGrainFile} onChange={(e) => onChange({ higherGrainFile: e.target.value })}>
                      <option value="">Select...</option>
                      {allDatasetOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div>
                    <p className="step-field-label">Target Lower Grain Structure Dataset</p>
                    <select className="step-select" value={step.lowerGrainStructureFile} onChange={(e) => onChange({ lowerGrainStructureFile: e.target.value })}>
                      <option value="">Select...</option>
                      {allDatasetOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                </div>

                {(() => {
                  const higherCols = columnsForDataset(step.higherGrainFile);
                  const lowerCols = columnsForDataset(step.lowerGrainStructureFile);
                  const crosswalkCols = columnsForDataset(step.crosswalkFile);

                  const keyField = (label, field, cols, placeholder) => (
                    <div className="step-key-block">
                      <p className="step-field-label">{label}</p>
                      {cols ? (
                        <select className="step-select" value={step[field]} onChange={(e) => onChange({ [field]: e.target.value })}>
                          <option value="">Select column...</option>
                          {cols.map((c) => <option key={c} value={c}>{c}</option>)}
                        </select>
                      ) : (
                        <input type="text" className="step-input" placeholder={placeholder} value={step[field]} onChange={(e) => onChange({ [field]: e.target.value })} />
                      )}
                    </div>
                  );

                  return (
                    <>
                      <div className="step-grid-2">
                        {keyField('Source Grain Key (e.g. DMA in Higher Grain File)', 'sourceGrainKey', higherCols, 'e.g. dma_code')}
                        {keyField('Target Grain Key (e.g. NPI in Structure File)', 'targetGrainKey', lowerCols, 'e.g. npi_id')}
                      </div>

                      <div className="step-grid-2">
                        <div>
                          <p className="step-field-label">Crosswalk Mapping Dataset</p>
                          <select className="step-select" value={step.crosswalkFile} onChange={(e) => onChange({ crosswalkFile: e.target.value, crosswalkMatchKey: '' })}>
                            <option value="">Select Crosswalk file...</option>
                            {allDatasetOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </div>
                        <div>
                          <p className="step-field-label">Crosswalk Match Key (↔ Source Grain Key)</p>
                          <select
                            className="step-select"
                            value={step.crosswalkMatchKey}
                            disabled={!step.crosswalkFile || !crosswalkCols}
                            onChange={(e) => onChange({ crosswalkMatchKey: e.target.value })}
                          >
                            <option value="">{step.crosswalkFile ? 'Select column in Crosswalk...' : 'Pick Crosswalk Dataset first'}</option>
                            {(crosswalkCols || []).map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </div>
                      </div>

                      <div className="step-grid-2">
                        {keyField('Time / Date Key', 'dateKey', higherCols, 'e.g. month_start_date')}
                        <div>
                          <p className="step-field-label">Allocation Method</p>
                          <select className="step-select" value={step.allocationMethod} onChange={(e) => onChange({ allocationMethod: e.target.value })}>
                            <option value="equal">Equal Distribution (1/N per target)</option>
                            <option value="weighted_column">Population-Weighted Distribution</option>
                            <option value="proportional">Proportional (by target volume)</option>
                          </select>
                        </div>
                      </div>

                      {step.allocationMethod === 'weighted_column' && (() => {
                        const weightCols = columnsForDataset(step.weightDatasetFile);
                        return (
                          <div className="step-grid-2">
                            <div>
                              <p className="step-field-label">Weight Dataset (e.g. Population by DMA)</p>
                              <select
                                className="step-select" value={step.weightDatasetFile}
                                onChange={(e) => onChange({ weightDatasetFile: e.target.value, weightColumn: '' })}
                              >
                                <option value="">Select...</option>
                                {allDatasetOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                              </select>
                            </div>
                            {keyField('Weight Column (in Weight Dataset)', 'weightColumn', weightCols, 'e.g. weight')}
                          </div>
                        );
                      })()}

                      <p className="step-field-label">Select Media Metrics to Allocate Down:</p>
                      {!higherCols && (
                        <p className="step-hint-text">Pick the Higher Grain Spend/Media Dataset above to choose which metrics to allocate.</p>
                      )}
                      {higherCols && (
                        <div className="metric-pill-row">
                          {higherCols
                            .filter((c) => c !== step.sourceGrainKey && c !== step.dateKey)
                            .map((c) => {
                              const selected = (step.metricsToAllocate || []).includes(c);
                              return (
                                <span
                                  key={c}
                                  className={`metric-pill${selected ? ' selected' : ''}`}
                                  onClick={() => {
                                    const cur = step.metricsToAllocate || [];
                                    onChange({ metricsToAllocate: selected ? cur.filter((x) => x !== c) : [...cur, c] });
                                  }}
                                >
                                  {selected ? '\u2713 ' : ''}{c}
                                </span>
                              );
                            })}
                        </div>
                      )}
                    </>
                  );
                })()}
              </>
            )}
          </div>

          {error && (
            <div className="stitching-error-banner">
              <p className="error-title">{error}</p>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="modal-btn primary" onClick={onDone} disabled={isSaving}>
            {isSaving ? 'Checking...' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default Datastitching;


