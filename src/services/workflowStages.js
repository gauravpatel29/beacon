// Which screens a workflow can be on, and where to reopen it.

export const STAGES = {
  ingestion: { stage: 'Data Ingestion', route: '/data-ingestion' },
  stitching: { stage: 'Data Stitching', route: '/data-stitching' },
  review: { stage: 'Data Review', route: '/eda' },
  transformation: { stage: 'Data Transformation', route: '/data-transformation' },
  modelling: { stage: 'Model Configuration', route: '/model-configuration' },
  response_curves: { stage: 'Response Curves', route: '/response-curves' },
  optimization: { stage: 'Optimization', route: '/optimization' },
};

const KNOWN_ROUTES = new Set(Object.values(STAGES).map((s) => s.route));

const MOVED_ROUTES = {
  '/data-review': '/eda',
  '/ingestion': '/data-ingestion',
  '/stitching': '/data-stitching',
  '/transformation': '/data-transformation',
  '/modelling': '/model-configuration',
};

export function resumeRouteFor(workflow) {
  const rawRoute = workflow?.current_route;
  const route = MOVED_ROUTES[rawRoute] || rawRoute;
  return KNOWN_ROUTES.has(route) ? route : STAGES.ingestion.route;
}