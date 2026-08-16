/**
 * Builds a page of scannable QR codes and copyable strings for testing the add
 * flow on a real device.
 *
 * Run `npm run fixtures`, open the generated HTML on the PC monitor, and point
 * the phone at it. Every fixture states which branch of app/add.tsx it drives,
 * so a pass means the whole camera -> parse -> form -> save path was covered
 * rather than just the happy case.
 *
 * The rejected fixtures are deliberately broken. They are here because the
 * error messages are user-facing and only ever appear on device.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import QRCode from 'qrcode';
import * as OTPAuth from 'otpauth';

const HERE = dirname(fileURLToPath(import.meta.url));
export const OUTPUT = resolve(HERE, 'fixtures.html');

// Base32 of the RFC 6238 seeds, matching src/otp/otp.test.ts. Reusing them means
// a code shown on screen can be checked against the vectors already in the suite.
const RFC_SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_SHA256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const RFC_SHA512 =
  'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';

/**
 * `accepts: true` means the URI must parse and reach the confirmation form.
 * Anything else must be turned away with a readable notice and no saved entry.
 */
const FIXTURES = [
  {
    group: 'Standard',
    title: 'Plain TOTP',
    exercises: 'The baseline. Joins the shared header countdown; row shows no timer of its own.',
    uri: 'otpauth://totp/GitHub:you@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    accepts: true,
  },
  {
    group: 'Standard',
    title: 'No issuer parameter',
    exercises: 'Issuer comes from the label alone, and the account ends up empty.',
    uri: 'otpauth://totp/Fastmail?secret=JBSWY3DPEHPK3PXP',
    accepts: true,
  },
  {
    group: 'Standard',
    title: 'Label with spaces and a plus address',
    exercises: 'Percent-decoding of both label halves. Check the row does not show %20 or %2B.',
    uri: 'otpauth://totp/Big%20Corp%20Ltd:first.last%2Btag@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Big%20Corp%20Ltd',
    accepts: true,
  },
  {
    group: 'Standard',
    title: 'Very long issuer and account',
    exercises: 'Row layout under overflow. Neither name should push the code off screen.',
    uri: 'otpauth://totp/Department%20of%20Infrastructure%20and%20Regional%20Development:marcus.oates.longaddress@some-very-long-domain-name.example.com?secret=JBSWY3DPEHPK3PXP&issuer=Department%20of%20Infrastructure%20and%20Regional%20Development',
    accepts: true,
  },

  {
    group: 'Algorithms and digits',
    title: 'SHA256',
    exercises: 'normaliseAlgorithm, and generation on a non-default digest.',
    uri: `otpauth://totp/Vector%20SHA256:rfc6238@example.com?secret=${RFC_SHA256}&issuer=Vector%20SHA256&algorithm=SHA256`,
    accepts: true,
  },
  {
    group: 'Algorithms and digits',
    title: 'SHA512',
    exercises: 'The longest seed in the set, so also the densest QR to scan.',
    uri: `otpauth://totp/Vector%20SHA512:rfc6238@example.com?secret=${RFC_SHA512}&issuer=Vector%20SHA512&algorithm=SHA512`,
    accepts: true,
  },
  {
    group: 'Algorithms and digits',
    title: '8 digits',
    exercises: 'formatCode splitting 8 digits into 4 and 4, and the wider row.',
    uri: `otpauth://totp/Vector%208%20digit:rfc6238@example.com?secret=${RFC_SHA1}&issuer=Vector%208%20digit&digits=8`,
    accepts: true,
  },

  {
    group: 'Off cadence',
    title: '60-second period',
    exercises: 'isOffCadence, so the row carries its own timer instead of the shared ring.',
    uri: 'otpauth://totp/Slow%20Service:you@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Slow%20Service&period=60',
    accepts: true,
  },
  {
    group: 'Off cadence',
    title: '15-second period',
    exercises: 'A fast per-row timer, obvious at a glance next to the 30-second ring.',
    uri: 'otpauth://totp/Fast%20Service:you@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Fast%20Service&period=15',
    accepts: true,
  },
  {
    group: 'Off cadence',
    title: 'HOTP, counter 0',
    exercises: 'No countdown at all. Tap to advance and confirm the counter persists across a restart.',
    uri: 'otpauth://hotp/Counter%20Based:you@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Counter%20Based&counter=0',
    accepts: true,
  },

  {
    group: 'Turned away',
    title: 'Google Authenticator export',
    exercises: 'The named bulk-import message at app/add.tsx:89, not a generic parse failure.',
    uri: 'otpauth-migration://offline?data=CjEKCkhlbGxvId6tvu8SGEV4YW1wbGU6YWxpY2VAZ29vZ2xlLmNvbRoHRXhhbXBsZTACEAEYASAAKMuU3IUE',
    accepts: false,
  },
  {
    group: 'Turned away',
    title: 'Not an otpauth link',
    exercises: 'Scanning an ordinary web QR by mistake. Expect "Not an otpauth:// link".',
    uri: 'https://example.com/this-is-not-a-code',
    accepts: false,
  },
  {
    group: 'Turned away',
    title: 'Secret is not base32',
    exercises: 'isValidSecret rejecting characters outside A-Z and 2-7.',
    uri: 'otpauth://totp/Broken%20Secret?secret=0189!!!!&issuer=Broken%20Secret',
    accepts: false,
  },
  {
    group: 'Turned away',
    title: 'No secret at all',
    exercises: 'A URI that is otherwise well formed. Must not save a blank entry.',
    uri: 'otpauth://totp/Missing%20Secret?issuer=Missing%20Secret',
    accepts: false,
  },
  {
    group: 'Turned away',
    title: 'Unsupported scheme type',
    exercises: 'otpauth:// but neither totp nor hotp, e.g. a Steam guard code.',
    uri: 'otpauth://steam/Valve:you@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Valve',
    accepts: false,
  },
];

/**
 * Mirrors the acceptance check in src/otp/otp.ts so a typo in a fixture is
 * caught here rather than looking like an app bug on device.
 */
function checkFixture(fixture) {
  let parsed;
  try {
    parsed = OTPAuth.URI.parse(fixture.uri.trim());
  } catch (err) {
    return { parses: false, reason: err.message };
  }

  const secret = (parsed.secret?.base32 ?? '').replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (secret.length < 8 || !/^[A-Z2-7]+$/.test(secret)) {
    return { parses: false, reason: 'secret is not usable base32' };
  }
  return { parses: true };
}

function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Long URIs need more modules, so they get more pixels to stay scannable. */
function qrWidth(uri) {
  if (uri.length > 160) return 300;
  if (uri.length > 90) return 260;
  return 230;
}

/** Writes the page and returns any fixtures that did not behave as declared. */
export async function render() {
  const problems = [];
  const cards = [];

  for (const [index, fixture] of FIXTURES.entries()) {
    const result = checkFixture(fixture);
    if (fixture.accepts && !result.parses) {
      problems.push(`${fixture.title}: expected to parse but did not (${result.reason})`);
    }
    if (!fixture.accepts && result.parses && !/^otpauth-migration:/i.test(fixture.uri)) {
      problems.push(`${fixture.title}: expected to be rejected but parsed cleanly`);
    }

    // Black on white regardless of the viewer's browser theme; a dark-mode
    // inversion would stop the phone reading it.
    const svg = await QRCode.toString(fixture.uri, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#000000', light: '#FFFFFF' },
    });

    cards.push(`
      <article class="card ${fixture.accepts ? 'ok' : 'reject'}" data-index="${index}">
        <header>
          <h3>${escapeHtml(fixture.title)}</h3>
          <span class="badge">${fixture.accepts ? 'should save' : 'should be refused'}</span>
        </header>
        <p class="exercises">${escapeHtml(fixture.exercises)}</p>
        <div class="qr" style="width:${qrWidth(fixture.uri)}px">${svg}</div>
        <pre class="uri">${escapeHtml(fixture.uri)}</pre>
        <button class="copy" data-uri="${escapeHtml(fixture.uri)}">Copy string</button>
      </article>`);
  }

  const groups = [...new Set(FIXTURES.map((f) => f.group))];
  const indicesByGroup = (group) =>
    FIXTURES.map((f, i) => [f, i]).filter(([f]) => f.group === group).map(([, i]) => i);

  const sections = groups
    .map((group) => {
      const inGroup = indicesByGroup(group);
      return `<section><h2>${escapeHtml(group)}</h2><div class="grid">${inGroup
        .map((i) => cards[i])
        .join('')}</div></section>`;
    })
    .join('');

  // One button per fixture so a single card can be put on screen at a time; a
  // phone reads a lone QR far more reliably than one in a wall of them.
  const picker = `<nav class="picker">
  <div class="picker-row">
    <button class="pick pick-all" data-target="all" aria-pressed="true">Show all</button>
    <button class="step" data-step="-1" title="Previous fixture">&larr; Prev</button>
    <button class="step" data-step="1" title="Next fixture">Next &rarr;</button>
  </div>
${groups
  .map(
    (group) => `  <div class="picker-row">
    <span class="picker-label">${escapeHtml(group)}</span>
${indicesByGroup(group)
  .map(
    (i) =>
      `    <button class="pick ${FIXTURES[i].accepts ? 'ok' : 'reject'}" data-target="${i}" aria-pressed="false">${escapeHtml(
        FIXTURES[i].title,
      )}</button>`,
  )
  .join('\n')}
  </div>`,
  )
  .join('\n')}
</nav>`;

  const html = `<!doctype html>
<html lang="en-AU">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authenticator test fixtures</title>
<style>
  :root { color-scheme: light; }
  body {
    margin: 0; padding: 32px;
    background: #F4F5F7; color: #14161A;
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, sans-serif;
  }
  h1 { margin: 0 0 4px; font-size: 24px; }
  .lede { margin: 0 0 32px; color: #55606E; max-width: 70ch; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #55606E;
       margin: 32px 0 12px; padding-bottom: 8px; border-bottom: 1px solid #DDE1E6; }
  .grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
  .card { background: #FFFFFF; border: 1px solid #DDE1E6; border-left-width: 4px;
          border-radius: 10px; padding: 18px; }
  .card.ok { border-left-color: #2F6FEB; }
  .card.reject { border-left-color: #D4692B; }
  .card header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  h3 { margin: 0; font-size: 16px; }
  .badge { font-size: 11px; color: #55606E; white-space: nowrap; }
  .exercises { margin: 6px 0 14px; font-size: 13px; color: #55606E; }
  .qr { background: #FFFFFF; }
  .qr svg { display: block; width: 100%; height: auto; }
  .uri { margin: 14px 0 10px; padding: 10px; background: #F4F5F7; border-radius: 6px;
         font: 12px/1.45 ui-monospace, Menlo, Consolas, monospace;
         white-space: pre-wrap; word-break: break-all; user-select: all; }
  .copy { font: inherit; font-size: 13px; padding: 7px 14px; cursor: pointer;
          background: #FFFFFF; border: 1px solid #C6CCD4; border-radius: 6px; }
  .copy:hover { border-color: #2F6FEB; color: #2F6FEB; }
  .copy.done { border-color: #2F6FEB; color: #2F6FEB; }
  .picker { position: sticky; top: 0; z-index: 1; margin: 0 -32px 8px; padding: 12px 32px;
            background: #F4F5F7; border-bottom: 1px solid #DDE1E6; }
  .picker-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 6px; }
  .picker-row:last-child { margin-bottom: 0; }
  .picker-label { font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
                  color: #55606E; min-width: 15ch; }
  .pick, .step { font: inherit; font-size: 13px; padding: 5px 11px; cursor: pointer;
                 background: #FFFFFF; border: 1px solid #C6CCD4; border-radius: 999px; }
  .pick { border-left-width: 3px; }
  .pick.ok { border-left-color: #2F6FEB; }
  .pick.reject { border-left-color: #D4692B; }
  .pick:hover, .step:hover { border-color: #2F6FEB; color: #2F6FEB; }
  .pick[aria-pressed="true"] { background: #2F6FEB; border-color: #2F6FEB; color: #FFFFFF; }
  /* Showing one fixture: the rest are [hidden], so just keep the lone card
     narrow enough that the QR stays a sensible size. */
  body.single .grid { grid-template-columns: minmax(0, 420px); }
</style>
</head>
<body>
<h1>Authenticator test fixtures</h1>
<p class="lede">
  Point the phone at a QR to test scanning. To test the paste path, the string has
  to reach the phone's clipboard first &mdash; decode the same QR with Google Lens or
  the iOS camera, which offers a copy button, then use <em>Paste link</em> in the app.
  Cards marked <em>should be refused</em> must show a readable notice and save nothing.
  Pick a fixture below to put it on screen on its own, or step through with the arrow keys.
</p>
${picker}
${sections}
<script>
  // Sorted by data-index so stepping follows the fixture order, not the order
  // the sections happen to place them in.
  const cards = [...document.querySelectorAll('.card')]
    .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index));
  const picks = [...document.querySelectorAll('.pick')];
  let shown = 'all';

  function show(target) {
    shown = target;
    document.body.classList.toggle('single', target !== 'all');
    for (const card of cards) card.hidden = target !== 'all' && card.dataset.index !== String(target);
    for (const section of document.querySelectorAll('section')) {
      section.hidden = ![...section.querySelectorAll('.card')].some((card) => !card.hidden);
    }
    for (const pick of picks) pick.setAttribute('aria-pressed', String(pick.dataset.target === String(target)));
    if (target !== 'all') cards[Number(target)].scrollIntoView({ block: 'center' });
  }

  function step(delta) {
    if (shown === 'all') return show(delta > 0 ? 0 : cards.length - 1);
    show((Number(shown) + delta + cards.length) % cards.length);
  }

  for (const pick of picks) {
    pick.addEventListener('click', () => show(pick.dataset.target === 'all' ? 'all' : Number(pick.dataset.target)));
  }
  for (const button of document.querySelectorAll('.step')) {
    button.addEventListener('click', () => step(Number(button.dataset.step)));
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') step(1);
    else if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'Escape') show('all');
  });

  document.querySelectorAll('.copy').forEach((button) => {
    button.addEventListener('click', async () => {
      const text = button.dataset.uri;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // file:// is not a secure context in every browser, so fall back.
        const scratch = document.createElement('textarea');
        scratch.value = text;
        document.body.appendChild(scratch);
        scratch.select();
        document.execCommand('copy');
        scratch.remove();
      }
      button.textContent = 'Copied';
      button.classList.add('done');
      setTimeout(() => {
        button.textContent = 'Copy string';
        button.classList.remove('done');
      }, 1400);
    });
  });
</script>
</body>
</html>
`;

  writeFileSync(OUTPUT, html, 'utf8');
  return problems;
}

export function fixtureSummary() {
  const accepted = FIXTURES.filter((f) => f.accepts).length;
  return `${FIXTURES.length} fixtures (${accepted} valid, ${FIXTURES.length - accepted} refused)`;
}

// Only when run directly, so serve_fixtures.mjs can import render() without
// triggering a write and a process exit.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await render();

  console.log(`Wrote ${fixtureSummary()} to:`);
  console.log(`  ${OUTPUT}`);

  if (problems.length) {
    console.error('\nFixture problems:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
}
