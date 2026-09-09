import "./Home.css";
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

function Home() {
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
              <button className="btn btn-primary">
                Get Started <span aria-hidden="true">→</span>
              </button>
              <button className="btn btn-secondary">Continue Workflow</button>
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
    </>
  );
}

export default Home;