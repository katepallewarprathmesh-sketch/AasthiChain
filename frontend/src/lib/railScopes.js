// Which rail routes act on a named participant, and are therefore pointless
// to call while nobody is signed in.
//
// THE DEFECT THIS EXISTS TO FIX
// A visitor who is not signed in used to load /umi and watch its panels fire
// a request each at the rail. The rail is right to refuse them: these routes
// read one participant's wallet, orders, conditions and instructions, and the
// caller has no name. So every one came back ERR_UMI_NO_IDENTITY, which meant
//
//   the visitor saw a row of failures instead of an explanation, and
//   the deployment's own error rate was mostly its own front page.
//
// Neither side was broken. The request simply should never have left the
// browser. A request whose answer is known before it is sent is not a read,
// it is noise, and it is noise that looks like an outage on a dashboard.
//
// WHY A LIST AND NOT A TRY-IT-AND-SEE
// Learning from the first 401 still costs one failed request per route per
// page load, which is the thing being removed. A list is explicit, and
// tests/railanon.test.mjs holds it against the running rail in both
// directions: every prefix here must really refuse an anonymous caller, and
// no route the frontend calls outside this list may refuse one. The list
// cannot quietly drift away from the rail without the suite failing.

// Prefixes, because these routes have item forms too: /work/W-1, /keys/abc.
// Exactly the routes the rail refuses, no more. The first draft of this list
// also held /token, /credentials, /keys, /baskets, /offers and /documents,
// which read as participant-scoped and are not: the rail answers all six to
// anyone, because they describe the asset or the register rather than a
// person's position in it. tests/railanon.test.mjs caught every one of them
// by asking the rail instead of believing the list.
const IDENTIFIED_PREFIXES = [
  '/wallets',
  '/instructions',
  '/conditions',
  '/crossborder',
  '/work',
];

// Routes under an identified prefix that are open to anyone, because they
// describe the rules rather than a person's position under them.
const PUBLIC_EXCEPTIONS = [
  '/crossborder/rules',
  '/work/provider',
];

/** Does this rail path act on a named participant? */
export function needsIdentity(path) {
  const clean = String(path || '').split('?')[0].replace(/\/+$/, '') || '/';
  if (PUBLIC_EXCEPTIONS.some((p) => clean === p || clean.startsWith(p + '/'))) return false;
  return IDENTIFIED_PREFIXES.some((p) => clean === p || clean.startsWith(p + '/'));
}

/**
 * Is somebody signed in?
 *
 * Read from the same storage that getAuthHeaders reads, so the answer here
 * and the header sent there can never disagree. getAuthHeaders falls back to
 * the identity "investor1" when storage is empty, which is convenient for a
 * signed-in session that has not resolved its role yet and misleading as a
 * test of whether anyone is there at all: that default is exactly the case
 * the rail refuses. So presence of the stored user is what counts.
 */
export function isSignedIn() {
  try {
    const raw = localStorage.getItem('aasthi_user');
    if (!raw) return false;
    const user = JSON.parse(raw);
    return Boolean(user && user.identityId);
  } catch {
    return false;
  }
}

export const __test__ = { IDENTIFIED_PREFIXES, PUBLIC_EXCEPTIONS };
