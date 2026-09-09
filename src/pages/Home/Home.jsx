import "./Home.css";
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ApiError,
  createWorkflow,
  deleteWorkflow,
  listWorkflows,
  selectWorkflow,
  updateWorkflow,
} from '../../services/api.js';
import procdna_logo from "../../assets/procdna_logo.png";
import hero_image from "../../assets/hero_image.jpg";
import database from "../../assets/database.png";
import cloud from "../../assets/cloud.png";
import chart from "../../assets/chart.png";
import dot from "../../assets/dots.png";
import graph from "../../assets/graph.png";
import data from "../../assets/data.png";
import data_lifecycle from "../../assets/data_lifecycle.png";
import bar_graph from "../../assets/bar_graph.png";
import aim from "../../assets/aim.png";
import beacon_logo from "../../assets/beacon_logo.png";

const pipelineCards = [
  {
    id: 'data-ingestion',
    title: 'Data Ingestion',
    icon: cloud,
    description:
      'Upload CSV files, standardize columns, detect date formats, merge and filter datasets.',
  },
  {
    id: 'integrated-analytics',
    title: 'Integrated Analytics',
    icon: chart,
    description:
      'Join multiple channel datasets on geo and date keys into a unified analytics database.',
  },
  {
    id: 'correlation-analysis',
    title: 'Correlation Analysis',
    icon: dot,
    description:
      'Detect multicollinearity with heatmaps, VIF scores, and PCA decomposition.',
  },
  {
    id: 'exploratory-data-analysis',
    title: 'Exploratory Data Analysis',
    icon: graph,
    description:
      'Visualize sales trends, geo distributions, histograms, and scatter plots.',
  },
  {
    id: 'data-transformation',
    title: 'Data Transformation',
    icon: data,
    description:
      'Apply Adstock decay, saturation functions (Log/Power), and lag transformations.',
  },
  {
    id: 'mmm-modelling',
    title: 'MMM Modelling',
    icon: data_lifecycle,
    description:
      'Run OLS regression with impactable % attribution, ROI, and Long Term ROI calculations.',
    active: true,
  },
  {
    id: 'response-curves',
    title: 'Response Curves',
    icon: bar_graph,
    description:
      'Generate channel-level response curves showing ROI and mROI vs spend.',
  },
  {
    id: 'optimization',
    title: 'Optimization',
    icon: aim,
    description:
      'Budget and sales goal optimization across channels using marginal ROI logic.',
  },
];

const WORKFLOW_STAGES = ['Not Started', ...pipelineCards.map((card) => card.title)];

const STAGE_TONES = {
  'Not Started': 'neutral',
  'Data Ingestion': 'amber',
  'Integrated Analytics': 'blue',
  'Correlation Analysis': 'blue',
  'Exploratory Data Analysis': 'violet',
  'Data Transformation': 'violet',
  'MMM Modelling': 'red',
  'Response Curves': 'green',
  Optimization: 'green',
};

const STATUS_TONES = { Running: 'amber', Complete: 'green', Failed: 'red', New: 'neutral' };

const workflowLabel = (workflow) => workflow.workflow_name || workflow.name || 'Untitled workflow';

const stageOf = (workflow) => workflow.current_stage || 'Not Started';

const workflowStatus = (workflow) => {
  const raw = workflow.status || workflow.state || 'new';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
};

const formatRelativeTime = (value) => {
  const then = new Date(value ?? NaN).getTime();
  if (Number.isNaN(then)) return 'never';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
};

function Home() {
  const navigate = useNavigate();
  const [showWorkflowDialog, setShowWorkflowDialog] = useState(false);
  const [workflowName, setWorkflowName] = useState('');
  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isCreatingWorkflow, setIsCreatingWorkflow] = useState(false);
  const [workflowQuery, setWorkflowQuery] = useState('');
  const [workflowStage, setWorkflowStage] = useState('all');
  const [editingWorkflowId, setEditingWorkflowId] = useState(null);
  const [editingWorkflowName, setEditingWorkflowName] = useState('');
  const [workflowActionId, setWorkflowActionId] = useState(null);

  const loadWorkflows = async () => {
    setLoading(true);
    try {
      const data = await listWorkflows();
      setWorkflows(data.items || []);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.text : 'Could not load workflows.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadWorkflows(); }, []);

  const closeWorkflowDialog = () => {
    setShowWorkflowDialog(false);
    setIsCreatingWorkflow(false);
    setWorkflowName('');
    setEditingWorkflowId(null);
    setEditingWorkflowName('');
  };

  useEffect(() => {
    if (!showWorkflowDialog) return undefined;
    const onKeyDown = (event) => { if (event.key === 'Escape') closeWorkflowDialog(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showWorkflowDialog]);

  const openWorkflowDialog = () => {
    setShowWorkflowDialog(true);
    setWorkflowQuery('');
    setWorkflowStage('all');
    loadWorkflows();
  };

  const startWorkflow = async (event) => {
    event.preventDefault();
    const name = workflowName.trim();
    if (!name) return window.alert('Enter a workflow name.');
    setLoading(true);
    try {
      const workflow = await createWorkflow({ workflow_name: name, state: 'new' });
      selectWorkflow(workflow.id);
      closeWorkflowDialog();
      navigate('/data-ingestion');
    } catch (err) {
      window.alert(err instanceof ApiError ? err.text : 'Could not create workflow.');
    } finally {
      setLoading(false);
    }
  };

  const resumeWorkflow = (workflow) => {
    selectWorkflow(workflow.id);
    closeWorkflowDialog();
    navigate('/data-ingestion');
  };

  const startRename = (workflow) => {
    setIsCreatingWorkflow(false);
    setEditingWorkflowId(workflow.id);
    setEditingWorkflowName(workflowLabel(workflow));
  };

  const cancelRename = () => {
    setEditingWorkflowId(null);
    setEditingWorkflowName('');
  };

  const saveWorkflowName = async (workflow) => {
    const name = editingWorkflowName.trim();
    if (!name) return;
    setWorkflowActionId(workflow.id);
    try {
      await updateWorkflow(workflow.id, { workflow_name: name, name });
      cancelRename();
      await loadWorkflows();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.text : 'Could not update workflow.');
    } finally {
      setWorkflowActionId(null);
    }
  };

  const removeWorkflow = async (workflow) => {
    if (!window.confirm(`Delete workflow "${workflow.workflow_name || workflow.name}"? This cannot be undone.`)) return;
    setWorkflowActionId(workflow.id);
    try {
      await deleteWorkflow(workflow.id);
      await loadWorkflows();
    } catch (err) {
      window.alert(err instanceof ApiError ? err.text : 'Could not delete workflow.');
    } finally {
      setWorkflowActionId(null);
    }
  };

  const visibleWorkflows = workflows.filter((workflow) => {
    const matchesQuery = workflowLabel(workflow).toLowerCase().includes(workflowQuery.trim().toLowerCase());
    const matchesStage = workflowStage === 'all' || workflowStage === stageOf(workflow);
    return matchesQuery && matchesStage;
  });

  return (
    <>
      {/* ---------------- HERO SECTION ---------------- */}
      <section className="hero-section">
        <div className="container hero-inner">
          <div className="hero-content">
            {/* Logo */}
            <div className="logo-row">
              {/* PLACEHOLDER: replace with ProcDNA logo image/svg */}
                <div className="logo-placeholder">
                    <img src={procdna_logo} alt="ProcDna Logo" />
                </div>
            <div className="logo-divider" />
              <span className="logo-wordmark">
                Proc<span>Timize</span>
                {/* --add beacon logo */}
                {/* <div className="logo-placeholder">
                    <img src={beacon_logo} alt="Beacon Logo" />
                </div> */}
              </span>
            </div>

            {/* Heading + copy */}
            <h1 className="hero-heading">
              <span className="highlight">Marketing Mix Modeling</span> Platform
            </h1>
            <p className="hero-description">
              Ingest, transform, model, and optimize your marketing data - from
              raw CSVs to actionable MMM insights.
            </p>

            {/* CTAs */}
            <div className="hero-cta-group">
              <button className="btn btn-primary" onClick={openWorkflowDialog}>
                Get Started <span aria-hidden="true">→</span>
              </button>
              <button className="btn btn-secondary" onClick={openWorkflowDialog}>Continue Workflow</button>
            </div>
          </div>

          {/* Hero graphic */}
          <div className="hero-graphic-wrapper">
            <div className="hero-graphic-placeholder">
                <img src={hero_image} alt="Hero Graphic" />
            </div>

            <div className="hero-floating-card">
              {/* PLACEHOLDER: replace with end-to-end/database icon */}
              <div className="icon-placeholder">
                <img src={database} alt="Database Icon" />
              </div>
              <div>
                <p className="hero-floating-card-title">End-to-end MMM</p>
                <p className="hero-floating-card-subtitle">
                  From raw data to measurable ROI impact
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------- FULL MMM PIPELINE SECTION ---------------- */}
      <section className="pipeline-section">
        <div className="container">
          <div className="pipeline-header">
            <h2 className="pipeline-title">Full MMM Pipeline</h2>
            <p className="pipeline-subtitle">
              From data ingestion to optimization - a complete pipeline for
              modern marketing mix modeling.
            </p>
          </div>

          <div className="pipeline-grid">
            {pipelineCards.map((card) => (
              <div
                key={card.id}
                className={`pipeline-card`}
              >
                <div className="icon-placeholder">
                  <img src={card.icon} alt={card.title} />
                </div>
                <h3 className="pipeline-card-title">{card.title}</h3>
                <p className="pipeline-card-description">
                  {card.description}
                </p>
                <button
                className="pipeline-card-arrow-btn"
                aria-label={`Go to ${card.title}`}
                onClick={() => card.id === 'data-ingestion' && openWorkflowDialog()}
                >
                →
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- FOOTER ---------------- */}
      <footer className="home-footer">
        <div className="container footer-inner">
          <p className="footer-text">
            &copy;2026 ProcDNA Inc. | All Rights Reserved
          </p>
          <div className="footer-links">
            <a href="/privacy-policy">Privacy Policy</a>
            <span>|</span>
            <a href="/terms-of-use">Terms of Use</a>
          </div>
        </div>
      </footer>

      {showWorkflowDialog && (
        <div className="workflow-dialog-backdrop" role="presentation" onMouseDown={closeWorkflowDialog}>
          <section className="workflow-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-dialog-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="workflow-dialog-header">
              <div>
                <h2 id="workflow-dialog-title">Workflows</h2>
                <p>View, resume, or start a new marketing mix modeling workflow.</p>
              </div>
              <div className="workflow-header-actions">
                <button type="button" className="workflow-new-btn" aria-expanded={isCreatingWorkflow} onClick={() => { setIsCreatingWorkflow((value) => !value); cancelRename(); }}>+ New Workflow</button>
                <button type="button" className="workflow-dialog-close" onClick={closeWorkflowDialog} aria-label="Close">×</button>
              </div>
            </div>

            {isCreatingWorkflow && (
              <form className="workflow-create-form" onSubmit={startWorkflow}>
                <label htmlFor="workflow-name">New workflow name</label>
                <div>
                  <input id="workflow-name" value={workflowName} onChange={(event) => setWorkflowName(event.target.value)} placeholder="e.g. Q4 Brand MMM" maxLength="200" autoFocus />
                  <button type="submit" disabled={loading || !workflowName.trim()}>{loading ? 'Creating…' : 'Create workflow'}</button>
                </div>
              </form>
            )}

            <div className="workflow-toolbar">
              <input value={workflowQuery} onChange={(event) => setWorkflowQuery(event.target.value)} placeholder="Search workflows by name..." aria-label="Search workflows" />
              <select value={workflowStage} onChange={(event) => setWorkflowStage(event.target.value)} aria-label="Filter by stage">
                <option value="all">All stages</option>
                {WORKFLOW_STAGES.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
              </select>
            </div>

            <div className="workflow-existing">
              {loading && workflows.length === 0 ? (
                <p className="workflow-empty-state">Loading workflows…</p>
              ) : visibleWorkflows.length === 0 ? (
                <p className="workflow-empty-state">
                  {workflows.length === 0 ? 'No saved workflows yet — create one to get started.' : 'No workflows match your search.'}
                </p>
              ) : (
                <div className="workflow-list">
                  {visibleWorkflows.map((workflow) => {
                    const name = workflowLabel(workflow);
                    const stage = stageOf(workflow);
                    const status = workflowStatus(workflow);
                    const isEditing = editingWorkflowId === workflow.id;
                    const isBusy = workflowActionId === workflow.id;

                    return (
                      <article className={`workflow-row${isEditing ? ' is-editing' : ''}`} key={workflow.id}>
                        {isEditing ? (
                          <form
                            className="workflow-rename-form"
                            onSubmit={(event) => { event.preventDefault(); saveWorkflowName(workflow); }}
                          >
                            <input
                              value={editingWorkflowName}
                              onChange={(event) => setEditingWorkflowName(event.target.value)}
                              onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); cancelRename(); } }}
                              aria-label={`Rename ${name}`}
                              maxLength="200"
                              autoFocus
                            />
                            <button type="submit" className="workflow-save-btn" disabled={isBusy || !editingWorkflowName.trim()}>{isBusy ? 'Saving…' : 'Save'}</button>
                            <button type="button" className="workflow-cancel-btn" onClick={cancelRename} disabled={isBusy}>Cancel</button>
                          </form>
                        ) : (
                          <>
                            <div className="workflow-row-details">
                              <div className="workflow-row-title">
                                <span>{name}</span>
                                <em className={`workflow-chip tone-${STAGE_TONES[stage] || 'neutral'}`}>{stage}</em>
                              </div>
                              <small>Status: <span className={`workflow-status tone-${STATUS_TONES[status] || 'neutral'}`}>{status}</span></small>
                              <small className="workflow-row-updated">Updated {formatRelativeTime(workflow.updated_at || workflow.created_at)}</small>
                            </div>
                            <div className="workflow-row-actions">
                              <button type="button" onClick={() => startRename(workflow)} disabled={isBusy}>Edit</button>
                              <button type="button" className="workflow-delete-btn" onClick={() => removeWorkflow(workflow)} disabled={isBusy}>{isBusy ? 'Working…' : 'Delete'}</button>
                              <button type="button" className="workflow-resume-btn" onClick={() => resumeWorkflow(workflow)} disabled={isBusy}>Resume</button>
                            </div>
                          </>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export default Home;
