// Which screens a workflow can be on, and where to reopen it.
//
// Deliberately free of imports: this is the routing half of session resume,
// and keeping it away from `api.js` means it can be reasoned about - and
// tested - without a network layer or Vite's import.meta.env behind it.

/** Stage label -> route, for both recording progress and resuming it. */
export const STAGES = {
  ingestion: { stage: 'Data Ingestion', route: '/data-ingestion' },
  stitching: { stage: 'Data Stitching', route: '/data-stitching' },
  review: { stage: 'Data Review', route: '/data-review' },
  transformation: { stage: 'Data Transformation', route: '/data-transformation' },
};

/** Routes a stored `current_route` is allowed to send you to. */
const KNOWN_ROUTES = new Set(Object.values(STAGES).map((s) => s.route));

/**
 * Where a resumed workflow should open.
 *
 * Falls back to ingestion for anything unrecognised, so a route written by an
 * older build - or a stage that no longer exists - cannot strand the user on a
 * blank screen.
 */
export function resumeRouteFor(workflow) {
  const route = workflow?.current_route;
  return KNOWN_ROUTES.has(route) ? route : STAGES.ingestion.route;
}
