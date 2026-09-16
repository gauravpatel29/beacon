// Which screens a workflow can be on, and where to reopen it.
//
// Deliberately free of imports: this is the routing half of session resume,
// and keeping it away from `api.js` means it can be reasoned about - and
// tested - without a network layer or Vite's import.meta.env behind it.

/** Stage label -> route, for both recording progress and resuming it. */
export const STAGES = {
  ingestion: { stage: 'Data Ingestion', route: '/data-ingestion' },
  stitching: { stage: 'Data Stitching', route: '/data-stitching' },
  // The screen is called Data Review; its route is /eda, which is what App.jsx
  // registers and what the sidebar links to. They have to agree here or a
  // resumed workflow navigates to a path no route matches.
  review: { stage: 'Data Review', route: '/eda' },
  transformation: { stage: 'Data Transformation', route: '/data-transformation' },
  modelling: { stage: 'Model Configuration', route: '/model-configuration' },
};

/** Routes a stored `current_route` is allowed to send you to. */
const KNOWN_ROUTES = new Set(Object.values(STAGES).map((s) => s.route));

/**
 * Routes that used to exist, and where they went.
 *
 * A workflow last open on Data Review has `/data-review` written into its
 * saved state. Without this it fails the check below and resumes at ingestion
 * - silently sending the user back three screens.
 */
const MOVED_ROUTES = { '/data-review': '/eda' };

/**
 * Where a resumed workflow should open.
 *
 * Falls back to ingestion for anything unrecognised, so a route written by an
 * older build - or a stage that no longer exists - cannot strand the user on a
 * blank screen.
 */
export function resumeRouteFor(workflow) {
  const route = MOVED_ROUTES[workflow?.current_route] || workflow?.current_route;
  return KNOWN_ROUTES.has(route) ? route : STAGES.ingestion.route;
}
