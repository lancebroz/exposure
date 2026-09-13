/* /api/rosters — fetches the five FFPC SetLineup pages server-side (their
   public ltuid links), parses starters + bench, and returns JSON the
   tracker consumes on page load. Cached at the CDN for 6 hours
   (s-maxage), so FFPC gets hit a handful of times a day at most —
   rosters refresh each morning without any manual step.

   Labels must match the SEED labels in index.html exactly. */

const FFPC_TEAMS = [
  { label: 'Desert Power', ltuid: 'B53-6F3DA4E9125F' },
  { label: 'Kwisatz Haderach', ltuid: '295-CE331642203F' },
  { label: 'Shai-Hulud',           ltuid: 'F5E-BAE7894EEF55' },
  { label: 'Spacing Guild',        ltuid: '9F1-5F1862AB9E47' },
  { label: 'Gom Jabbar',           ltuid: 'EB6-3B1DAC0B4F7E' }
];

const TEAM_FIX = { JAC: 'JAX', ARZ: 'ARI', WSH: 'WAS', LA: 'LAR' };
const fixTeam = t => TEAM_FIX[t] || t;

/* "McCaffrey, Christian SF" -> {name:"Christian McCaffrey", nfl:"SF"}
   "Walker III, Kenneth KC"  -> {name:"Kenneth Walker III", nfl:"KC"}
   "LAC DST"                 -> {name:"LAC D/ST", nfl:"LAC", pos:"DST"} */
function parsePlayerText(text) {
  const dst = text.match(/^([A-Z]{2,3})\s+DST$/);
  if (dst) {
    const t = fixTeam(dst[1]);
    return { name: t + ' D/ST', nfl: t, pos: 'DST' };
  }
  const comma = text.indexOf(', ');
  if (comma < 0) return null;
  const last = text.slice(0, comma).trim();          // may carry a suffix: "Walker III"
  const rest = text.slice(comma + 2).trim().split(/\s+/);
  if (rest.length < 2) return null;
  const nfl = fixTeam(rest.pop());
  const first = rest.join(' ');
  const lastParts = last.split(/\s+/);
  const suffix = lastParts.length > 1 ? ' ' + lastParts.slice(1).join(' ') : '';
  return { name: `${first} ${lastParts[0]}${suffix}`, nfl };
}

function parseLineup(html) {
  const re = /PlayerProfile\.aspx\?playerID=[^"'<>]*["'][^>]*>\s*([^<]+?)\s*</g;
  const found = [];
  let m;
  while ((m = re.exec(html))) {
    const text = m[1].replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const p = parsePlayerText(text);
    if (!p) continue;
    if (!p.pos) {
      // POS column follows the player cell in the same row; news blurbs can
      // make that cell long, so scan to the end of the row, not a fixed window
      const rowEnd = html.indexOf('</tr>', re.lastIndex);
      const tail = html.slice(re.lastIndex, rowEnd > 0 ? rowEnd : re.lastIndex + 3000);
      const pm = tail.match(/>\s*(?:&nbsp;)*\s*(QB|RB|WR|TE|PK|DST)\s*(?:&nbsp;)*\s*</);
      p.pos = pm ? pm[1] : '?';
    }
    if (p.pos === 'PK') p.pos = 'K';
    found.push({ ...p, at: m.index });
  }
  // one entry per player, first occurrence wins
  const seen = new Set();
  const players = found.filter(p => !seen.has(p.name) && seen.add(p.name));
  if (!players.length) return { ok: false, starters: [], bench: [], reason: 'no players parsed' };

  // starters table renders before the Bench header, bench after it
  let split = -1;
  const bench = /Bench/gi;
  let bm;
  while ((bm = bench.exec(html))) {
    if (bm.index > players[0].at && bm.index < players[players.length - 1].at) { split = bm.index; break; }
  }
  let starters, benchList;
  if (split > 0) {
    starters = players.filter(p => p.at < split);
    benchList = players.filter(p => p.at > split);
  } else if (players.length === 20) {
    starters = players.slice(0, 10);
    benchList = players.slice(10);
  } else {
    return { ok: false, starters: [], bench: [], reason: 'no bench boundary, ' + players.length + ' players' };
  }
  const strip = p => ({ pos: p.pos, name: p.name, nfl: p.nfl });
  return { ok: starters.length === 10, starters: starters.map(strip), bench: benchList.map(strip) };
}

export default async function handler(req, res) {
  const debug = req.query && req.query.debug;
  const teams = await Promise.all(FFPC_TEAMS.map(async t => {
    try {
      const r = await fetch('https://myffpc.com/SetLineup.aspx?ltuid=' + t.ltuid, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; ExposureBook/1.0)' }
      });
      if (!r.ok) return { label: t.label, ok: false, reason: 'http ' + r.status };
      const html = await r.text();
      const parsed = parseLineup(html);
      if (debug) parsed.htmlLength = html.length;
      return { label: t.label, ...parsed };
    } catch (e) {
      return { label: t.label, ok: false, reason: String(e && e.message || e) };
    }
  }));
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
  res.status(200).json({ fetchedAt: Date.now(), teams });
}
