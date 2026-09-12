import { useNavigate } from 'react-router-dom';
import './PageFooterNav.css';

// Single source of truth for pipeline order AND descriptions — matches the
// sidebar and the Home page's pipeline cards. Add a new page here once and
// every existing PageFooterNav automatically knows where "Back"/"Proceed"
// should go, and what to say about it.
//
// `description` is written as "what this step does" — reused both as the
// card description on Home, and here as the "what you're about to do next"
// text when this step is the *next* one in the sequence.
export const PIPELINE_STEPS = [
  {
    id: 'data-ingestion',
    label: 'Data Ingestion',
    path: '/data-ingestion',
    completionTitle: 'Files Ingested & Mapped',
    description: 'upload CSV files, standardize columns, detect date formats, merge and filter datasets.',
  },
  {
    id: 'data-stitching',
    label: 'Data Stitching & ARD Creation',
    path: '/data-stitching',
    completionTitle: 'ARD Generated',
    description: 'join mapped source files on shared keys to build HCP or DMA-level analytic record datasets.',
  },
  {
    id: 'data-review',
    label: 'Data Review',
    path: '/data-review',
    completionTitle: 'Dataset Diagnostics Complete',
    description: 'inspect column profiles, detect multicollinearity, and validate data quality before modelling.',
  },
  {
    id: 'data-transformation',
    label: 'Data Transformation',
    path: '/data-transformation',
    completionTitle: 'Transformations Applied',
    description: 'apply Adstock decay, saturation functions (Log/Power), and lag transformations.',
  },
  {
    id: 'model-configuration',
    label: 'Model Configuration',
    path: '/model-configuration',
    completionTitle: 'Model Configured',
    description: 'select channels, dependent variables, and date ranges to configure your MMM model.',
  },
  {
    id: 'model-output',
    label: 'Model Output',
    path: '/model-output',
    completionTitle: 'Model Run Complete',
    description: 'run OLS regression with impactable % attribution, ROI, and Long Term ROI calculations.',
  },
  {
    id: 'optimization',
    label: 'Optimization',
    path: '/optimization',
    completionTitle: 'Optimization Complete',
    description: 'budget and sales goal optimization across channels using marginal ROI logic.',
  },
  {
    id: 'ai-integration',
    label: 'AI Integration',
    path: '/ai-integration',
    completionTitle: 'AI Insights Ready',
    description: 'surface AI-powered insights and recommendations throughout your MMM workflow.',
  },
];

/**
 * Drop this at the bottom of any pipeline page — it's fully dynamic by
 * default, no need to write per-page status text:
 *
 *   <PageFooterNav currentStepId="data-review" />
 *
 * This alone renders:
 *   Title:    "Dataset Diagnostics Complete"          (from this step's completionTitle)
 *   Subtitle: "Ready to proceed: apply Adstock decay, saturation
 *              functions (Log/Power), and lag transformations."  (from the NEXT step's description)
 *   Buttons:  "← Back to Data Stitching & ARD Creation" / "Proceed to Data Transformation →"
 *
 * Pass statusTitle/statusSubtitle to override the auto-generated text for a
 * specific page if it needs something more specific than the default.
 * Pass nextDisabled to grey out Proceed (e.g. until validation passes).
 */
function PageFooterNav({ currentStepId, statusTitle, statusSubtitle, nextDisabled = false }) {
  const navigate = useNavigate();
  const index = PIPELINE_STEPS.findIndex((s) => s.id === currentStepId);
  const currentStep = index >= 0 ? PIPELINE_STEPS[index] : null;
  const prevStep = index > 0 ? PIPELINE_STEPS[index - 1] : null;
  const nextStep = index >= 0 && index < PIPELINE_STEPS.length - 1 ? PIPELINE_STEPS[index + 1] : null;

  const resolvedTitle = statusTitle || currentStep?.completionTitle || 'Step Complete';
  const resolvedSubtitle =
    statusSubtitle ||
    (nextStep
      ? `Ready to proceed: ${nextStep.description}`
      : "You've completed the full MMM pipeline.");

  return (
    <div className="page-footer-nav">
      <div className="page-footer-status">
        <p className="page-footer-status-title">{resolvedTitle}</p>
        <p className="page-footer-status-subtitle">{resolvedSubtitle}</p>
      </div>

      <div className="page-footer-actions">
        {prevStep && (
          <button className="page-footer-back-btn" onClick={() => navigate(prevStep.path)}>
            &larr; Back to {prevStep.label}
          </button>
        )}
        {nextStep && (
          <button
            className="page-footer-proceed-btn"
            onClick={() => navigate(nextStep.path)}
            disabled={nextDisabled}
          >
            Proceed to {nextStep.label} &rarr;
          </button>
        )}
      </div>
    </div>
  );
}

export default PageFooterNav;