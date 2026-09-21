import { useState, useEffect, useRef } from 'react';
import { v2ListFiles, v2BuildArd, v2ListArds, v2GetCsv, deleteFile, problemMessage, ensureWorkflow } from '../../services/api.js';
import { forgetFile, loadScreenState, recordStage, saveScreenState } from '../../services/workflowState.js';
import './Datastitching.css';
import PageFooterNav from '../../components/PageFooterNav/PageFooterNav.jsx';

// No ARD until the user adds one. The screen used to open with an HCP and a
// DMA tab already present, claiming two ARDs nobody had asked for and which
// could not be removed.
const DEFAULT_TABS = [];

// The five join_type values the build endpoint accepts. Labels deliberately
// carry no file name - the guide warns that a label like "Left Join (Keep all
// crosswalk.csv rows)" is ambiguous - and only `value` is ever sent.
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


/** A tab title as a filename: "ARD 1" -> "ard_1". */
function slugify(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function makeEmptyStep() {
  return {
    // 'join' | 'rollup' | 'allocate' — see OPERATION_TYPES below.
    operationType: 'join',
    // Join fields
    leftFile: '', rightFile: '', joinType: 'left',
    // Positional pairs: keyPairs[n].left joins to keyPairs[n].right. A date key
    // is simply a second pair rather than a dedicated field.
    keyPairs: [{ left: '', right: '' }],
    // Rollup fields (Lower Grain -> Higher Grain, via a bridge/crosswalk)
    sourceFile: '', bridgeFile: '',
    sourceKey: '', matchKey: '', targetKey: '', dateKey: '',
    aggregations: {}, // { [metricColumn]: 'sum'|'average'|'min'|'max'|'weighted_average' }
    // Allocate fields (Higher Grain -> Lower Grain, via a crosswalk + method)
    higherGrainFile: '', lowerGrainStructureFile: '',
    sourceGrainKey: '', targetGrainKey: '', crosswalkFile: '',
    allocationMethod: 'equal',
    metricsToAllocate: [], // column names from higherGrainFile
    // Only meaningful (and only sent) when allocationMethod === 'weighted_column'.
    // Confirmed as its own dataset + column by the build endpoint's response
    // format doc: an allocate lineage entry reports `weight_dataset` and
    // `weight_column` as separate fields from `mapping` (the crosswalk), so
    // "weighted" allocation reads its weights from a third file, not from a
    // column already present in one of the other three.
    weightDatasetFile: '', weightColumn: '',
  };
}

// All three modes call the same POST /v2/workflows/{id}/ard/build endpoint.
// The `mapping_file`/`source_file`/`target_file` naming this comment used to
// describe (inferred from response_format.odt's lineage shape, by analogy
// with how the working join step's `left_file`/`right_file` come back as
// `left`/`right`) turned out wrong for the REQUEST: a rollup step sent with
// `source_file` got back "Step 1: Left dataset 'None' not found" - a
// join-shaped error, on a non-join step. That only makes sense if the
// backend checks `left_file` on every step regardless of `operation`,
// defaulting to None when it's absent - i.e. the two primary datasets for
// EVERY operation type go under the same `left_file`/`right_file` names a
// join uses, not per-operation names. Fixed below for rollup (confirmed by
// that error) and allocate (same error, same fix, on its primary dataset);
// which of allocate's other two files (lower-grain structure vs. crosswalk)
// belongs under `right_file` is still a guess - see the comment on that step
// below. Everything else here (per-key field names, aggregations shape,
// method values) is still unconfirmed the same way it always was: logged to
// the console before every build, with any 400/422 surfaced via the error
// banner below.
const OPERATION_TYPES = [
  { value: 'join', label: 'Relational Join (Same Grain)' },
  { value: 'rollup', label: 'Rollup (Lower \u2192 Higher Grain)' },
  { value: 'allocate', label: 'Allocate (Higher \u2192 Lower Grain)' },
];
function makeDefaultDraft() {
  return {
    // Blank means "use the grain-based default". Kept per tab so each ARD in
    // the workflow can be named separately.
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
    activePreview: null, // { cardIndex, data, isLoading, error }
    generatedArd: null,  // the committed build: { filename, version, row_count, columns, preview }
    // Which dataset this tab has written, name only. The build above is
    // deliberately not persisted - it is rebuildable, and a stored preview
    // would outlive the data it described - but the name has to survive a
    // resume, otherwise deleting the tab later leaves the ARD orphaned.
    generatedArdName: null,
  };
}

// Starts at zero so the first ARD added is "ARD 1". It began at one when two
// tabs already existed and the counter only ever named the extras.
let tabCounter = 0;

function Datastitching() {
  const [workflowId, setWorkflowId] = useState(null);
  // Saves are armed only after the restore has run, so the blank initial
  // state cannot overwrite work being fetched.
  const hasRestored = useRef(false);
  const [files, setFiles] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  // A problem with one tab, shown above the tab bar. Kept apart from
  // `loadError`, which stands in for the whole screen.
  const [tabError, setTabError] = useState(null);

  // Every ARD ever built in this workflow, not just the one open in the
  // active tab's draft — GET /v2/workflows/{id}/ard, listed in a section of
  // its own (see the JSX near PageFooterNav) so a previously-generated ARD
  // is still visible and downloadable after switching tabs or reloading.
  const [savedArds, setSavedArds] = useState([]);
  const [isLoadingArds, setIsLoadingArds] = useState(false);
  const [ardListError, setArdListError] = useState(null);
  const [downloadingArdName, setDownloadingArdName] = useState(null);

  const [tabs, setTabs] = useState(DEFAULT_TABS);
  const [activeTabId, setActiveTabId] = useState('');
  const [drafts, setDrafts] = useState({});

  // Modal now edits exactly ONE step at a time.
  const [modal, setModal] = useState(null); // { mode: 'add'|'edit', stepIndex, step }

  // The name being typed into the tab that is currently being renamed. Only
  // one tab can be in edit mode, so a single value is enough - and holding it
  // here is what lets a button outside the input submit it.
  const [renameValue, setRenameValue] = useState('');

  // Null until an ARD is added. Everything below either guards on it or is
  // rendered only when it exists.
  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0] || null;
  const draft = drafts[activeTab?.id] || makeDefaultDraft();

  // No-ops with no ARD open, rather than creating a draft under an empty key
  // that nothing would ever render.
  const setDraft = (updates) => {
    if (!activeTab) return;
    setDrafts((prev) => ({ ...prev, [activeTab.id]: { ...prev[activeTab.id], ...updates } }));
  };

  const updateDraft = (updaterFn) => {
    if (!activeTab) return;
    setDrafts((prev) => ({ ...prev, [activeTab.id]: updaterFn(prev[activeTab.id]) }));
  };

  // The build endpoint requires a target_grain and validates it, but never
  // passes it to the join: `execute_pipeline` takes only the steps, the frames
  // and a preview size. It is a label, so it is no longer asked for - the tab's
  // own name identifies the ARD instead.
  const targetGrain = 'hcp';
  const ardLabel = activeTab?.title || 'this ARD';

  // What gets written to the workflow: the recipe, not the rendered result.
  // Join cards, previews and row counts are all things the server can rebuild
  // from the steps, and storing them would mean a stale copy of a preview
  // outliving the data it described.
  const persistableState = () => ({
    activeTabId,
    tabs: tabs.map(({ id, title, grain, removable }) => ({ id, title, grain, removable })),
    drafts: Object.fromEntries(Object.entries(drafts).map(([id, d]) => [id, {
      ardName: d.ardName,
      steps: d.steps,
      // A Set does not survive JSON.
      selectedFiles: Array.from(d.selectedFiles || []),
      // Whichever is known: the live build this session, or the name carried
      // over from the last one.
      generatedArdName: d.generatedArd?.filename || d.generatedArdName || null,
    }])),
  });

  const restoreDrafts = (saved) => {
    if (!saved || !Array.isArray(saved.tabs) || !saved.tabs.length) return false;

    // Sessions saved while the screen still opened with fixed HCP and DMA tabs
    // carry those two in `state_data`, so they would come straight back however
    // empty the defaults are now. An unused one is dropped; one holding real
    // joins is kept, because that is work the user did.
    const isUnusedLegacyTab = (tab) => tab.removable === false
      && !(saved.drafts?.[tab.id]?.steps || []).length;

    const tabsToKeep = saved.tabs
      .filter((tab) => !isUnusedLegacyTab(tab))
      // A kept legacy tab becomes an ordinary one: removable and renameable
      // like any other. Its stored grain is dropped along with the picker.
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
      setFiles((filesData.items || []).filter((f) => f.kind !== 'ard'));

      // Non-blocking on purpose: a failure listing ARDs shouldn't take down
      // the whole screen, only leave that one section showing its own error.
      loadArdList(id);

      // Joins the user added last time. Restored before the save effect is
      // armed, so an empty starting state is never written over real work.
      const saved = await loadScreenState('stitching');
      // A second restore would rebuild every draft from makeDefaultDraft(),
      // which resets `joinCards` - so cards already replayed from these steps
      // would blank out, and the rebuild effect would not fire again because
      // the step count had not changed. That is what made restored joins flash
      // up and vanish.
      if (isCancelled()) return;
      restoreDrafts(saved);
    } catch (err) {
      if (!isCancelled()) setLoadError(problemMessage(err, 'Could not load this workflow.'));
    } finally {
      if (!isCancelled()) {
        hasRestored.current = true;
        setIsLoading(false);
      }
    }
  };

  // Remember where the user got to, so Resume reopens this screen instead
  // of always returning to Data Ingestion.
  useEffect(() => { recordStage('stitching'); }, []);

  // Cancelled on unmount, which under StrictMode's deliberate double-mount
  // means only the second pass restores. Without this both passes did, and the
  // second wiped the cards the first had just built.
  useEffect(() => {
    let cancelled = false;
    loadEverything(() => cancelled);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Save the recipe whenever it changes, debounced so dragging through a
  // multi-step join is one write rather than one per keystroke. Gated on the
  // restore having finished: without that, the empty initial state would be
  // saved over the joins still being fetched.
  useEffect(() => {
    if (!hasRestored.current) return undefined;
    const timer = setTimeout(() => { saveScreenState('stitching', persistableState()); }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, drafts, activeTabId]);

  // Rebuild the join cards for whichever tab is open. The steps are restored
  // from the workflow; the cards, row counts and previews come from replaying
  // them against the current files, so a card can never describe a dataset
  // that has changed underneath it.
  useEffect(() => {
    if (!workflowId || !hasRestored.current) return;
    // `joinCards.length` is a dependency, not just a condition: a draft whose
    // cards get cleared while its steps stand must rebuild them. Keying only
    // on the step count left that state stuck, because the count had not moved.
    // Not while one is in flight, and not after one has failed: a failed
    // rebuild leaves the cards empty, which would otherwise satisfy this
    // condition again and retry forever. The error stays on screen and editing
    // a step clears it, which is the retry.
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
    // Seeds the name box with the suggestion, so Enter or the tick accepts it
    // and typing replaces it.
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

  // Leaves the name as it was. Used by Escape, so an accidental edit can be
  // abandoned without having to remember what the tab was called.
  const cancelRenameTab = (tabId) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, editing: false } : t)));
  };

  const removeTab = async (tabId, e) => {
    e.stopPropagation();

    // Deleting a tab discards the joins in it, and the save that follows takes
    // them out of the workflow too - so an ARD with work in it asks first. An
    // empty one goes without ceremony, since there is nothing to lose.
    const tab = tabs.find((t) => t.id === tabId);
    const tabDraft = drafts[tabId] || {};
    const stepCount = (tabDraft.steps || []).length;
    // The dataset this tab produced, from this session or a previous one.
    const builtArd = tabDraft.generatedArd?.filename || tabDraft.generatedArdName || null;

    if (stepCount > 0 || builtArd) {
      const label = tab?.title || 'this ARD';
      const joins = stepCount === 1 ? '1 join' : `${stepCount} joins`;
      const lines = [`Delete ${label}?`, ''];
      if (stepCount > 0) lines.push(`Its ${joins} will be removed from this workflow.`);
      // The tab is where an ARD is built and named, so leaving the dataset
      // behind left a file nothing on this screen could reach again.
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
    // Fall back to whatever is left, which may be nothing at all.
    if (activeTabId === tabId) setActiveTabId(remaining[0]?.id || '');

    if (!builtArd || !workflowId) return;
    try {
      await deleteFile(workflowId, builtArd);
      // Only after the delete lands: a failed one must not prune the state of
      // a dataset that is still there. This also clears the selection on Data
      // Review and Data Transformation, which held it by name.
      await forgetFile(builtArd);
    } catch (err) {
      // The tab is already gone, and re-adding it would be more confusing than
      // saying what is left over.
      // Not `loadError`: that one replaces the whole screen, and the screen is
      // still perfectly usable - one dataset just outlived its tab.
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

  // Rollup and Allocate steps were falling through this validator's
  // join-only checks — `leftFile`/`rightFile` are never filled in for them,
  // so every rollup/allocate step failed with "Choose both a left and right
  // dataset" no matter what was actually configured, and could never be
  // added. Branches per operationType now, checking the fields that step
  // type's own form actually collects.
  const validateStep = (step) => {
    if (step.operationType === 'rollup') {
      if (!step.sourceFile || !step.bridgeFile) {
        return 'Choose both a Lower Grain Source Dataset and a Bridge/Crosswalk Mapping Dataset.';
      }
      if (!step.sourceKey || !step.matchKey || !step.targetKey || !step.dateKey) {
        return 'Source Key, Match Key, Target Key and Time/Date Key are all required.';
      }
      return null;
    }

    if (step.operationType === 'allocate') {
      if (!step.higherGrainFile || !step.lowerGrainStructureFile) {
        return 'Choose both a Higher Grain Spend/Media Dataset and a Target Lower Grain Structure Dataset.';
      }
      if (!step.sourceGrainKey || !step.targetGrainKey || !step.dateKey || !step.crosswalkFile) {
        return 'Source Grain Key, Target Grain Key, Time/Date Key and the Crosswalk Mapping Dataset are all required.';
      }
      if (!(step.metricsToAllocate || []).length) {
        return 'Select at least one media metric to allocate down.';
      }
      if (step.allocationMethod === 'weighted_column' && (!step.weightDatasetFile || !step.weightColumn)) {
        return 'Weighted-column allocation needs a Weight Dataset and a Weight Column.';
      }
      return null;
    }

    // join
    if (!step.leftFile || !step.rightFile) {
      return 'Choose both a left and right dataset.';
    }
    if (step.joinType === 'cross') return null; // cross takes no keys

    const pairs = step.keyPairs || [];
    const filled = pairs.filter((p) => p.left && p.right);
    if (!filled.length) {
      return 'At least one key pair is required.';
    }
    // The API pairs keys positionally and rejects a count mismatch, so a
    // half-filled row has to be caught before it is sent.
    if (pairs.some((p) => Boolean(p.left) !== Boolean(p.right))) {
      return 'Every key pair needs a column on both sides, or remove the row.';
    }
    const leftKeys = filled.map((p) => p.left);
    if (new Set(leftKeys).size !== leftKeys.length) {
      return 'The same left column is used in more than one key pair.';
    }
    return null;
  };

  // Shown as the placeholder and used when the field is left blank. Matches
  // what the API would pick on its own, so the two never disagree.
  // Derived from the tab name rather than the grain: with no grain to vary,
  // every ARD would otherwise default to the same filename and the second
  // build would replace the first.
  // Derived from the tab name rather than the grain. With no grain to vary,
  // every ARD would otherwise default to the same filename and the second
  // build would replace the first.
  const defaultArdName = `${slugify(activeTab?.title) || 'ard'}.csv`;

  const payloadFor = (steps) => ({
    steps: steps.map((s) => {
      if (s.operationType === 'rollup') {
        const payload = {
          operation: 'rollup',
          // Renamed from source_file/mapping_file: a dry run with those names
          // came back "Left dataset 'None' not found" - a rollup step, not a
          // join - which only makes sense if the backend checks `left_file`
          // on every step regardless of operation, defaulting to None when
          // it's absent. So the two rollup datasets go under the same
          // left/right names a join uses, not operation-specific ones.
          left_file: s.sourceFile,
          right_file: s.bridgeFile,
          // Same story, one error later: source_key/match_key came back
          // "choose join keys for both left and right datasets" - the exact
          // message a join gives for empty left_key/right_key. So rollup
          // reuses those too, as arrays, not its own singular key fields -
          // source_key -> left_key, match_key -> right_key.
          left_key: [s.sourceKey].filter(Boolean),
          right_key: [s.matchKey].filter(Boolean),
          target_key: s.targetKey,
          date_key: s.dateKey,
          aggregations: s.aggregations || {},
        };
        // target_key/date_key (what to group by after the join) and the
        // aggregations shape are still unconfirmed - see the comment above
        // OPERATION_TYPES. If this still 422s, check whether the new error
        // is about one of those instead.
        console.log('[Data Stitching] rollup step payload:', payload);
        return payload;
      }
      if (s.operationType === 'allocate') {
        const isWeighted = s.allocationMethod === 'weighted_column';
        const payload = {
          operation: 'allocate',
          // left_file: same reasoning as rollup above - confirmed by the
          // identical "Left dataset 'None' not found" error on an allocate
          // step. Which of the OTHER two allocate datasets (lower-grain
          // structure vs. the crosswalk) the backend wants as `right_file`
          // is not yet confirmed - crosswalk is the current guess, by
          // analogy with rollup's bridge/mapping dataset filling that slot;
          // watch the console log against the next error/success here.
          left_file: s.higherGrainFile,
          right_file: s.crosswalkFile,
          target_file: s.lowerGrainStructureFile,
          source_grain_key: s.sourceGrainKey,
          target_grain_key: s.targetGrainKey,
          date_key: s.dateKey,
          method: s.allocationMethod || 'equal',
          allocated_metrics: s.metricsToAllocate || [],
          // Only the weighted method uses a separate weights file/column —
          // omitted otherwise, same reasoning as a cross join omitting keys.
          ...(isWeighted ? {
            weight_dataset: s.weightDatasetFile,
            weight_column: s.weightColumn,
          } : {}),
        };
        console.log('[Data Stitching] allocate step payload:', payload);
        return payload;
      }
      const base = {
        operation: 'join',
        left_file: s.leftFile,
        right_file: s.rightFile,
        join_type: s.joinType,
      };
      // Omit the key arrays entirely on a cross join; the other four 422 with
      // keys_missing without them.
      if (s.joinType === 'cross') return base;
      const filled = (s.keyPairs || []).filter((p) => p.left && p.right);
      return {
        ...base,
        left_key: filled.map((p) => p.left),
        right_key: filled.map((p) => p.right),
      };
    }),
    target_grain: targetGrain,
    // Only sent when the user typed one; otherwise the API applies its own
    // grain-based default. A name without .csv gets the extension server-side.
    ...(draft.ardName.trim() ? { output: draft.ardName.trim() } : {}),
  });

  // Re-runs the whole pipeline (dry run) for a given steps array and turns
  // the result into joinCards - used after add/edit/delete so the cards
  // and final row/column counts always reflect what's really configured.
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
        // `type` ("join" | "rollup" | "allocate") is the authoritative
        // discriminator per response_format.odt, present on every lineage
        // entry - more reliable than inferring the step kind from which of
        // `left`/`source` happens to be set.
        type: s.type,
        left: s.left,
        right: s.right,
        join: s.join,
        // The lineage already reports the resolved key names, which is the
        // authoritative answer once the server has matched them case-insensitively.
        keys: s.keys || [],
        // Rollup/allocate-specific fields, straight from the documented
        // response shape - used so the card can describe what the server
        // actually did instead of only ever echoing the client's own draft.
        source: s.source,
        target: s.target,
        mapping: s.mapping,
        groupBy: s.group_by || [],
        method: s.method,
        weightDataset: s.weight_dataset,
        weightColumn: s.weight_column,
        allocatedMetrics: s.allocated_metrics || [],
        rows_in: s.rows_in ?? 0,
        rows_out: s.rows_out ?? 0,
        // What this step produced. A later step joining on "Step N Result"
        // needs these to offer real key columns, and they cannot be derived
        // client-side: a name clash is suffixed ("month_step1") and duplicate
        // right-hand keys are collapsed before the join.
        columns: s.columns || [],
      }));
      setDraft({
        steps,
        joinCards: cards,
        finalRowCount: data.row_count ?? 0,
        finalColumnCount: data.columns?.length ?? 0,
        isSavingPipeline: false,
        activePreview: null,
        // The steps changed, so the last build no longer describes them.
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

  // ---- Modal open/close for a single step ----
  const openAddJoinModal = () => {
    if (draft.selectedFiles.size === 0) return;
    setModal({ mode: 'add', stepIndex: draft.steps.length, step: makeEmptyStep(), error: null });
  };

  const openEditJoinModal = (cardIndex) => {
    setModal({ mode: 'edit', stepIndex: cardIndex, step: { ...draft.steps[cardIndex] }, error: null });
  };

  const handleModalStepChange = (updates) => {
    setModal((prev) => ({ ...prev, step: { ...prev.step, ...updates } }));
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
    else setModal((prev) => ({ ...prev, error: 'See error below  pipeline could not be validated.' }));
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
      // Keep the steps and cards rather than resetting the draft: the user
      // needs to see what produced this ARD, and may want to adjust and
      // rebuild. The preview panel picks `built` up via shownPreview.
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

  // "Step N Result" is a virtual name - it is never a dataset, so it is not in
  // `files`. The dry run reports what each step produced, so the modal can look
  // its columns up here instead of falling back to a blind text box.
  const stepResultColumns = Object.fromEntries(
    draft.joinCards
      .filter((card) => (card.columns || []).length)
      .map((card) => [`Step ${card.step} Result`, card.columns])
  );

  const previewedCard = draft.activePreview ? draft.joinCards[draft.activePreview.cardIndex] : null;

  // The panel shows an explicitly requested step preview when one is open,
  // otherwise the ARD just generated. Same table either way.
  const shownPreview = draft.activePreview
    ? {
        heading: previewedCard
          ? `Step ${previewedCard.step} result: ${previewedCard.left} + ${previewedCard.right}`
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

  // problem+json errors carry a 1-based `step`; use it to mark the card that
  // failed instead of leaving the user to match a banner against a list.
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
                    {/* Enter still works; this is for anyone who expects to
                        click. onMouseDown is prevented so the input does not
                        blur out from under the click and commit twice. */}
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
                    {/* Rename and delete, revealed on hover so the tab reads as
                        a name until you go looking for them. Double-clicking
                        the tab still starts a rename. */}
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

          {/* Nothing is configured until an ARD exists. */}
          {!activeTab && (
            <div className="stitching-empty">
              No ARD yet. Use <strong>+ Add New</strong> above to create one.
            </div>
          )}

          {activeTab && (
            <>
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

          {/* ---- Current Joins ---- */}
          <div className="current-joins-card">
            <div className="current-joins-header">
              <p className="section-heading">
                Current Joins
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
                  : 'No joins configured yet click "+ Add Join" above to get started.'}
              </p>
            ) : (
              draft.joinCards.map((card, i) => (
                <div
                  key={i}
                  className={`join-summary-card${draft.activePreview?.cardIndex === i ? ' active' : ''}${failedSteps.has(card.step) ? ' has-error' : ''}`}
                >
                  <div className="join-summary-header">
                    <span className="step-card-title">
                      {/* `card.type` is the confirmed discriminator once a dry
                          run has succeeded for this step; the client-side
                          `operationType` is only a fallback for the moment
                          right after an edit, before the rebuild lands. */}
                      {(card.type || draft.steps[i]?.operationType) === 'join'
                        ? `Join ${card.step} ${JOIN_LABELS[card.join] || card.join}`
                        : (card.type || draft.steps[i]?.operationType) === 'rollup'
                        ? `Step ${card.step} Rollup`
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
                    {card.type === 'join' ? (
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
                    ) : draft.steps[i]?.operationType === 'rollup' ? (
                      <>
                        Rolling up <strong>{draft.steps[i].sourceFile}</strong> to{' '}
                        <strong>{draft.steps[i].bridgeFile}</strong>'s grain via{' '}
                        <code>{draft.steps[i].sourceKey}</code> &rarr; <code>{draft.steps[i].targetKey}</code>
                      </>
                    ) : draft.steps[i]?.operationType === 'allocate' ? (
                      <>
                        Allocating <strong>{draft.steps[i].higherGrainFile}</strong> down to{' '}
                        <strong>{draft.steps[i].lowerGrainStructureFile}</strong>'s grain via{' '}
                        <strong>{draft.steps[i].crosswalkFile}</strong>
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

          {/* ---- Preview, then the generate action beneath it ---- */}
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

// ─── Modal: configure exactly ONE join step (add or edit) ──────────────────
function SingleJoinModal({ files, selectedFileList, ardLabel, mode, stepIndex, existingSteps, stepResultColumns = {}, step, error, isSaving, onChange, onDone, onClose }) {
  // A real dataset first, then a previous step's result. Returns null only when
  // neither is known yet - the first time a step is configured, before any dry
  // run has reported what it produces - and the key field falls back to free
  // text for that case rather than showing an empty dropdown.
  const columnsForDataset = (name) => {
    const dataset = files.find((f) => f.filename === name);
    if (dataset) return dataset.columns || null;
    const fromStep = stepResultColumns[name];
    return fromStep && fromStep.length ? fromStep : null;
  };

  // Exclude files already used by OTHER steps (not this one), so the same
  // source file can't be picked twice across the pipeline. Prior steps'
  // results are offered as chaining options.
  const usedFilenames = (side) => {
    const used = new Set();
    existingSteps.forEach((s, i) => {
      if (i === stepIndex) return; // editing this step, so do not exclude its own current values
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

  // Rollup/Allocate reference more dataset "slots" than left/right (source,
  // bridge, higher-grain, lower-grain-structure, crosswalk) — no exclusion
  // logic maps cleanly onto that, so this just offers everything selected.
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
    // Suggest the next unused left column, and the same name on the right when
    // it exists, so the common case needs no further clicks.
    const taken = keyPairs.map((p) => p.left);
    const nextLeft = (leftCols || []).find((c) => !taken.includes(c)) || '';
    const nextRight = (rightCols || []).find(
      (c) => c.toLowerCase() === String(nextLeft).toLowerCase()
    ) || '';
    onChange({ keyPairs: [...keyPairs, { left: nextLeft, right: nextRight }] });
  };

  const onRemoveKeyPair = (pairIndex) => {
    if (keyPairs.length <= 1) return; // one pair is the minimum
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
                {/* Keys are positional pairs: the Nth left key joins to the Nth
                    right key. A date key is just another pair, so a crosswalk
                    that joins on the ID alone simply has one. */}
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

                {(() => {
                  const sourceCols = columnsForDataset(step.sourceFile);
                  const bridgeCols = columnsForDataset(step.bridgeFile);
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
                      {(sourceCols || []).filter((c) => ![step.sourceKey, step.dateKey].includes(c)).length === 0 && (
                        <p className="step-hint-text">Pick the Lower Grain Source Dataset above to configure per-column aggregation.</p>
                      )}
                      {(sourceCols || [])
                        .filter((c) => ![step.sourceKey, step.dateKey].includes(c))
                        .map((col) => (
                          <div key={col} className="agg-rule-row">
                            <span className="agg-rule-name">{col} <span className="source-badge">Metric</span></span>
                            <select
                              className="step-select"
                              value={(step.aggregations || {})[col] || 'sum'}
                              onChange={(e) => onChange({ aggregations: { ...(step.aggregations || {}), [col]: e.target.value } })}
                            >
                              <option value="sum">Sum (Default / Conserved)</option>
                              <option value="average">Average</option>
                              <option value="min">Min</option>
                              <option value="max">Max</option>
                              <option value="weighted_average">Weighted Average</option>
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
                        {keyField('Source Grain Key (e.g. DMA)', 'sourceGrainKey', higherCols, 'e.g. dma_code')}
                        {keyField('Target Grain Key (e.g. NPI)', 'targetGrainKey', lowerCols, 'e.g. npi_id')}
                      </div>
                      <div className="step-grid-2">
                        {keyField('Time / Date Key', 'dateKey', higherCols, 'e.g. month_start_date')}
                        <div>
                          <p className="step-field-label">Crosswalk Mapping Dataset</p>
                          <select className="step-select" value={step.crosswalkFile} onChange={(e) => onChange({ crosswalkFile: e.target.value })}>
                            <option value="">Select...</option>
                            {allDatasetOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                          </select>
                        </div>
                      </div>

                      <div style={{ marginBottom: '0.6rem' }}>
                        <p className="step-field-label">Allocation Method</p>
                        <select className="step-select" value={step.allocationMethod} onChange={(e) => onChange({ allocationMethod: e.target.value })}>
                          <option value="equal">Equal Distribution (1/N per target)</option>
                          <option value="weighted_column">Population-Weighted Distribution</option>
                          <option value="proportional">Proportional (by target volume)</option>
                        </select>
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