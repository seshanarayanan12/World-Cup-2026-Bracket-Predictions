// Regression harness for Fixture Mode matchday locking.
// Extracts the pure helpers from the HTML and runs them under Node vm,
// matching the existing jsdom + vm convention (no DOM needed for these).
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('./wc2026-brackets.html', 'utf8');
const script = html.split('<script>').slice(-1)[0].split('</script>')[0];

// Build a sandbox with the minimum globals the helpers touch.
const sandbox = {
  console, Date, Math, isFinite, isNaN, parseInt, parseFloat, Object,
  // stubs so top-level lines referencing these don't throw
  window: { addEventListener(){}, removeEventListener(){} },
  document: { addEventListener(){}, getElementById(){ return null; },
    querySelectorAll(){ return []; }, querySelector(){ return null; },
    readyState: 'complete' },
  location: { protocol: 'https:', href: 'https://wcbracket.netlify.app/' },
  localStorage: { _d:{}, getItem(k){return this._d[k]??null;}, setItem(k,v){this._d[k]=String(v);}, removeItem(k){delete this._d[k];} },
  fetch: async () => { throw new Error('no net in test'); },
  toast(){}, setTimeout, clearTimeout,
};
sandbox.self = sandbox.window; sandbox.window.self = sandbox.window; sandbox.window.top = sandbox.window;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.supabase = null;

vm.createContext(sandbox);
// Neutralize the auto-init at the bottom (it calls DOM-heavy code).
const safe = script.replace(/init\(\);/g, '/*init disabled in test*/')
  + `\n;Object.assign(globalThis, { MATCHDAYS, MATCHDAY_BY_DATE, matchdayLockState, fixtureLockState, istToInstant, unlockLabel, GROUP_FIXTURES, MATCHDAY_OPEN_COUNT, MATCHDAY_LEAD_DAYS, DAY_MS });`;
vm.runInContext(safe, sandbox);

const {
  MATCHDAYS, MATCHDAY_BY_DATE, matchdayLockState, fixtureLockState,
  istToInstant, unlockLabel, GROUP_FIXTURES, MATCHDAY_OPEN_COUNT, MATCHDAY_LEAD_DAYS, DAY_MS
} = sandbox;

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; } else { fail++; console.log('  ✗ FAIL: ' + name); }
}

// --- Structural checks ---
check('17 matchdays detected', MATCHDAYS.length === 17);
check('first matchday is Jun 12', MATCHDAYS[0].date === '2026-06-12');
check('last matchday is Jun 28', MATCHDAYS[16].date === '2026-06-28');
check('matchdays are date-sorted', MATCHDAYS.every((m,i,a)=> i===0 || a[i-1].date < m.date));
check('every group fixture maps to a matchday',
  GROUP_FIXTURES.every(fx => !!MATCHDAY_BY_DATE[fx.ist.split('T')[0]]));
check('earliest instant of MD1 = earliest Jun12 kickoff',
  MATCHDAYS[0].earliestInstant === Math.min(...GROUP_FIXTURES
    .filter(f=>f.ist.startsWith('2026-06-12')).map(f=>istToInstant(f.ist))));

// IST conversion sanity: 00:30 IST Jun 12 == 19:00 UTC Jun 11
check('IST->UTC offset correct',
  new Date(istToInstant('2026-06-12T00:30')).toISOString() === '2026-06-11T19:00:00.000Z');

const md = d => MATCHDAY_BY_DATE[d];
const ls = (d, now) => matchdayLockState(md(d), now);

// --- First 3 matchdays: open from the start, lock at own kickoff ---
const longAgo = Date.parse('2025-01-01T00:00:00Z');
for (const d of ['2026-06-12','2026-06-13','2026-06-14']) {
  check(`MD ${d} open far in advance`, ls(d, longAgo).reason === 'open');
}
// MD1 (Jun 12) locks at its kickoff
const md1 = md('2026-06-12');
check('MD1 open 1ms before kickoff', matchdayLockState(md1, md1.earliestInstant - 1).reason === 'open');
check('MD1 closed at kickoff', matchdayLockState(md1, md1.earliestInstant).reason === 'closed');
check('MD1 closed after kickoff', matchdayLockState(md1, md1.earliestInstant + 1).reason === 'closed');

// --- 4th matchday (Jun 15, index 3): the rolling 2-day rule ---
const md4 = md('2026-06-15');
check('MD4 is index 3', md4.index === 3);
const open4 = md4.earliestInstant - MATCHDAY_LEAD_DAYS*DAY_MS;
check('MD4 upcoming before window', matchdayLockState(md4, open4 - 1).reason === 'upcoming');
check('MD4 opens exactly at -2 days', matchdayLockState(md4, open4).reason === 'open');
check('MD4 still open mid-window', matchdayLockState(md4, open4 + DAY_MS).reason === 'open');
check('MD4 open 1ms before kickoff', matchdayLockState(md4, md4.earliestInstant - 1).reason === 'open');
check('MD4 re-locks at kickoff', matchdayLockState(md4, md4.earliestInstant).reason === 'closed');

// --- Last matchday (Jun 28) rolling rule ---
const mdL = md('2026-06-28');
const openL = mdL.earliestInstant - MATCHDAY_LEAD_DAYS*DAY_MS;
check('MD-last upcoming before window', matchdayLockState(mdL, openL - 1).reason === 'upcoming');
check('MD-last opens at -2 days', matchdayLockState(mdL, openL).reason === 'open');
check('MD-last closes at kickoff', matchdayLockState(mdL, mdL.earliestInstant).reason === 'closed');

// --- fixtureLockState delegates correctly & ignores knockout ---
const someJun20 = GROUP_FIXTURES.find(f => f.ist.startsWith('2026-06-20'));
check('fixtureLockState matches matchdayLockState',
  fixtureLockState(someJun20, openL).reason === ls('2026-06-20', openL).reason);
check('knockout fixture not gated',
  fixtureLockState({ ist:'2026-07-04T23:30', kind:'knockout' }).reason === 'open');

// --- unlockLabel renders IST date of the open instant ---
check('unlockLabel for MD4 reads a Jun date', /^Jun \d+$/.test(unlockLabel(open4)));
check('unlockLabel(-Infinity) is empty', unlockLabel(-Infinity) === '');

// --- Monotonic: once any matchday is open it never reverts to upcoming as time advances ---
let monoOK = true;
for (const m of MATCHDAYS) {
  const seq = [longAgo, m.earliestInstant - 2*DAY_MS, m.earliestInstant - 1, m.earliestInstant, m.earliestInstant + DAY_MS]
    .map(t => matchdayLockState(m, t).reason);
  // reason can only progress upcoming/open -> ... -> closed, never back to upcoming after open
  let seenOpen = false;
  for (const r of seq) {
    if (r === 'open') seenOpen = true;
    if (seenOpen && r === 'upcoming') monoOK = false;
  }
}
check('lock state never reverts open->upcoming', monoOK);

console.log(`\nMatchday-lock suite: ${pass} passed, ${fail} failed (${pass+fail} checks)`);
process.exit(fail ? 1 : 0);
