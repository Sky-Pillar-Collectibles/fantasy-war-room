/* =====================================================================
   THE WAR ROOM — 2026  ·  app logic
   ===================================================================== */

const SLEEPER = 'https://api.sleeper.app/v1';
const FCALC   = 'https://api.fantasycalc.com/values/current';
const SEASON  = '2026';

/* =====================================================================
   1. LEAGUE CONFIG
   ===================================================================== */
function activeLeague(){
  const id = LS.get('league', 'preset_du');
  return S.leagues.concat(PRESETS).find(l => l.id === id) || PRESETS[0];
}

/* Canonical string for a league's market-pricing format. Used to look up the
   right slice of the weekly snapshot when the live call is unavailable. */
function configKey(L){
  return `${L.dynasty?'dyn':'red'}_${L.qbs}qb_${L.teams}tm_ppr${L.ppr}`;
}

function renderLeaguePicker(){
  const sel = document.getElementById('leaguePick');
  const cur = LS.get('league','preset_du');
  const opts = [];
  if(S.leagues.length){
    opts.push('<optgroup label="Your Sleeper Leagues">');
    S.leagues.forEach(l => opts.push(`<option value="${l.id}">${esc(l.name)}</option>`));
    opts.push('</optgroup>');
  }
  opts.push('<optgroup label="Presets">');
  PRESETS.forEach(l => opts.push(`<option value="${l.id}">${esc(l.name)}</option>`));
  opts.push('</optgroup>');
  sel.innerHTML = opts.join('');
  sel.value = cur;
  if(sel.value !== cur){ sel.value = 'preset_du'; LS.set('league','preset_du'); }
}

/* Translate a Sleeper league object into our config shape. */
function sleeperLeagueToConfig(l){
  const sc = l.scoring_settings || {};
  const rp = l.roster_positions || [];
  const qbSlots = rp.filter(p => p==='QB').length;
  const superflex = rp.some(p => p==='SUPER_FLEX' || p==='QB/RB/WR/TE');
  return {
    id: l.league_id,
    name: (l.name || '').trim(),
    teams: l.total_rosters || 12,
    ppr: sc.rec != null ? sc.rec : 1,
    qbs: superflex ? 2 : (qbSlots || 1),
    dynasty: (l.settings && (l.settings.type === 2)) || false,   // 2 = dynasty in Sleeper
    rosterPositions: rp,
    // TE premium: extra points per TE reception. FantasyCalc has no parameter
    // for this, so it is applied as an explicit adjustment (see buildUnified).
    tePremium: sc.bonus_rec_te != null ? sc.bonus_rec_te : 0,
    // Some of these leagues don't start a kicker or a defence at all.
    usesK:   rp.includes('K'),
    usesDST: rp.includes('DEF') || rp.includes('DST'),
    preDraft: l.status === 'pre_draft',
    draftId: l.draft_id || null,
    scoring: {
      pass_td: sc.pass_td != null ? sc.pass_td : 4,
      int:     sc.pass_int != null ? sc.pass_int : -1,
      pass_yd: sc.pass_yd != null ? sc.pass_yd : 0.04,
      rush_yd: sc.rush_yd != null ? sc.rush_yd : 0.1,
      rush_td: sc.rush_td != null ? sc.rush_td : 6,
      fum:     sc.fum_lost != null ? sc.fum_lost : -2,
      rec:     sc.rec != null ? sc.rec : 1
    },
    raw: l
  };
}

/* =====================================================================
   2. DATA LOADING
   ===================================================================== */
async function loadAll(force){
  if(force){
    Object.keys(localStorage).filter(k=>k.startsWith('wr26_cache_')).forEach(k=>localStorage.removeItem(k));
  }
  S.health = [];

  // --- Sleeper account FIRST, so the active league's real settings are known
  //     before we ask FantasyCalc to price players for that format. ---
  const uname = LS.get('user', '');
  if(uname) await loadSleeperAccount(uname);

  const L = activeLeague();
  S.league = L;

  // --- expert blend (bundled, refreshed weekly by the Cowork task) ---
  const expert = await getJSON('expert_blend.json', 'Expert Blend (SI/NBC/BR/ESPN)', 60*24*3);
  S.expert = expert;

  // --- written outlooks, rebuilt weekly. Entirely optional: if the file is
  //     missing or stale the profile falls back to live data and says so,
  //     rather than showing an empty section or breaking. ---
  S.notes = await getJSON('player_notes.json', 'Player Outlooks (weekly)', 60*24) || null;

  // --- FantasyCalc live market values, configured to THIS league ---
  const fcUrl = `${FCALC}?isDynasty=${!!L.dynasty}&numQbs=${L.qbs}&numTeams=${L.teams}&ppr=${L.ppr}`;
  let fc = await getJSON(fcUrl, 'FantasyCalc Market (live)', 60*6);

  // Fallback: a weekly snapshot committed to this repo. Means the tool keeps
  // working if the live call is ever blocked, rate-limited, or the site is down.
  if(!Array.isArray(fc) || !fc.length){
    const snap = await getJSON('market_snapshot.json', 'Market Snapshot (weekly backup)', 60*24);
    if(snap && snap.configs){
      const key = configKey(L);
      const exact = snap.configs[key];
      const any = exact || snap.configs[Object.keys(snap.configs)[0]];
      if(any){
        fc = any;
        markHealth('FantasyCalc Market (live)', 'warn',
          exact ? `live call failed · using ${snap.generated} snapshot`
                : `live call failed · using ${snap.generated} snapshot for a different format`);
      }
    }
  }
  S.fc = Array.isArray(fc) ? fc : [];

  // --- Sleeper player dictionary (slimmed + cached 7 days; ~5MB download, once) ---
  await loadSleeperPlayers();

  // --- rosters for the now-known active league ---
  await loadLeagueRosters(L);

  buildUnified();
  renderAll();
}

async function loadLeagueRosters(L){
  if(!L || !L.raw){ S.rosters = []; S.lusers = []; S.tradedPicks = []; return; }
  const jobs = [
    getJSON(`${SLEEPER}/league/${L.id}/rosters`, 'League Rosters', 15),
    getJSON(`${SLEEPER}/league/${L.id}/users`, 'League Managers', 60*24)
  ];
  // Future rookie picks are real, tradeable assets in a dynasty league — often
  // worth more than the players being discussed. Redraft leagues have none.
  if(L.dynasty) jobs.push(getJSON(`${SLEEPER}/league/${L.id}/traded_picks`, 'Traded Draft Picks', 15));
  const [ros, usr, tp] = await Promise.all(jobs);
  S.rosters = ros || []; S.lusers = usr || []; S.tradedPicks = tp || [];
}

/* The cache key carries a version. The stored shape changed when depth chart,
   vitals and injury detail were added, and a returning browser holds the old
   copy for up to seven days — so without bumping the key the new fields simply
   never arrive. Bump it again if the fields kept below change. */
const SLIM_KEY = 'slimPlayersV2';

async function loadSleeperPlayers(){
  const slim = LS.get(SLIM_KEY, null);
  if(slim && (Date.now() - slim.t) < 7*86400000){
    S.sleeperMap = slim.d;
    markHealth('Sleeper Player DB', true, 'cached · ' + timeAgo(slim.t));
    return;
  }
  try{
    const r = await fetch(`${SLEEPER}/players/nfl`, {cache:'no-store'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const all = await r.json();
    const map = {};
    for(const id in all){
      const p = all[id];
      if(!p || !p.position) continue;
      if(!['QB','RB','WR','TE','K','DEF'].includes(p.position)) continue;
      if(p.position !== 'DEF' && !p.team && p.status === 'Inactive') continue;
      // Short keys on purpose: this whole map goes into localStorage, which caps
      // out around 5MB. Optional fields are only written when they exist so a
      // healthy player with no injury data costs nothing.
      const m = { n: p.full_name || ((p.first_name||'')+' '+(p.last_name||'')).trim(),
                  p: p.position === 'DEF' ? 'DST' : p.position,
                  t: fixTeam(p.team || ''),
                  b: p.bye_week || null,
                  i: p.injury_status || null,
                  a: p.age || null,
                  e: p.years_exp };
      if(p.depth_chart_position) m.dp = p.depth_chart_position;
      if(p.depth_chart_order != null) m.do = p.depth_chart_order;
      if(p.number != null) m.num = p.number;
      if(p.height) m.ht = p.height;
      if(p.weight) m.wt = p.weight;
      if(p.college) m.col = p.college;
      if(p.injury_body_part) m.ibp = p.injury_body_part;
      if(p.injury_notes) m.inote = String(p.injury_notes).slice(0,220);
      if(p.status && p.status !== 'Active') m.st = p.status;
      if(p.news_updated) m.nu = p.news_updated;
      map[id] = m;
    }
    S.sleeperMap = map;
    // If the enriched map overflows the storage quota the write silently fails
    // and the app simply re-downloads next load — slower, never broken.
    LS.set(SLIM_KEY, {t:Date.now(), d:map});
    markHealth('Sleeper Player DB', true, 'live · just now');
  }catch(e){
    if(slim){ S.sleeperMap = slim.d; markHealth('Sleeper Player DB','warn','offline · copy from '+timeAgo(slim.t)); }
    else markHealth('Sleeper Player DB', false, e.message);
  }
}

async function loadSleeperAccount(uname){
  const u = await getJSON(`${SLEEPER}/user/${encodeURIComponent(uname)}`, 'Sleeper Account', 60*24);
  if(!u || !u.user_id){ markHealth('Sleeper Account', false, 'username not found'); S.user=null; return; }
  S.user = u;
  const lg = await getJSON(`${SLEEPER}/user/${u.user_id}/leagues/nfl/${SEASON}`, 'Sleeper Leagues', 60);
  S.leagues = (lg || []).map(sleeperLeagueToConfig);
  // If real Sleeper leagues exist but the saved selection isn't one of them,
  // snap to the first real league — its actual scoring beats a generic preset.
  // Skipped once the user has deliberately chosen from the dropdown.
  const saved = String(LS.get('league',''));
  const isReal = S.leagues.some(l => l.id === saved);
  // A preset is a fallback for before Sleeper loads — never a destination once
  // real leagues are known. If a preset somehow got pinned (a stray change event
  // will do it), clear the pin rather than stranding the user on a league with
  // no rosters. Only a genuine Sleeper league may hold the pin.
  if(S.leagues.length && !isReal && LS.get('leaguePinned', false)){
    LS.set('leaguePinned', false);
  }
  if(S.leagues.length && !isReal && !LS.get('leaguePinned', false)){
    LS.set('league', S.leagues[0].id);
  }
  renderLeaguePicker();
}

/* =====================================================================
   3. UNIFY — join expert blend + market values + sleeper IDs
   ===================================================================== */
function buildUnified(){
  const players = [];
  const byKey = {};   // normname|POS -> player

  function keyOf(name, pos){ return norm(name) + '|' + pos; }
  function upsert(name, pos, team){
    const k = keyOf(name, pos);
    if(byKey[k]) return byKey[k];
    const p = { name, pos, team: fixTeam(team), key:k,
                srcRanks:{}, expertRank:null, expertTier:null,
                mktRank:null, mktPosRank:null, value:null, adp:null,
                trend:null, rostered:null, sleeperId:null, tier:null,
                bye:null, injury:null, age:null, owner:null };
    byKey[k] = p; players.push(p); return p;
  }

  // ---- expert blend (positional ranks from the sources named in the file) ----
  // The blend file declares its own columns in "source_keys", so sources can be
  // added or dropped by the weekly refresh without touching this code. SHORT is
  // only a display nicety; unknown keys fall back to the uppercased key.
  const SHORT = {si:'SI', nbc:'NBC', br:'B/R', espn:'ESPN', cbs:'CBS',
                 fp:'FPros', ffc:'FFC', rot:'Roto', pff:'PFF', ds:'DShrk', yah:'Yahoo'};
  const SRC = (S.expert && S.expert.source_keys)
    ? Object.fromEntries(Object.keys(S.expert.source_keys).map(k => [k, SHORT[k] || k.toUpperCase()]))
    : {si:'SI', nbc:'NBC', br:'B/R', espn:'ESPN'};
  if(S.expert && S.expert.positions){
    for(const pos in S.expert.positions){
      S.expert.positions[pos].forEach(r => {
        const p = upsert(r.player, pos, r.team);
        p.expertRank = r.rank;
        p.expertAvg  = r.avg;
        p.expertTier = r.tier;
        for(const k in SRC){ if(r[k] != null) p.srcRanks[SRC[k]] = r[k]; }
      });
    }
  }

  // ---- FantasyCalc live market ----
  const fcByKey = {};
  S.fc.forEach(row => {
    const pl = row.player || {};
    const pos = pl.position === 'DEF' ? 'DST' : pl.position;
    if(!pos) return;
    const p = upsert(pl.name, pos, pl.maybeTeam || '');
    p.sleeperId  = pl.sleeperId ? String(pl.sleeperId) : p.sleeperId;
    p.value      = row.value;
    p.mktRank    = row.overallRank;
    p.mktPosRank = row.positionRank;
    // NOTE: FantasyCalc's maybeAdp is empty for every player (verified 0/200),
    // so ADP is not available from any free CORS-open source. Draft-value is
    // derived from market-vs-expert divergence instead — see p.edge below.
    p.rostered   = row.maybeRosterPercent != null ? row.maybeRosterPercent * 100 : null;
    p.trend      = row.trend30Day != null ? row.trend30Day : null;
    if(row.maybeTier != null) p.mktTier = row.maybeTier;
    if(pl.maybeAge != null) p.age = pl.maybeAge;
    p.srcRanks['Market'] = row.positionRank;
    fcByKey[p.key] = p;
  });

  // ---- TE premium adjustment ----
  // Two of these leagues pay a bonus per TE reception. FantasyCalc has no
  // TE-premium setting, so its values understate tight ends there. A starting
  // TE catches roughly 70 balls, so a 0.5 bonus is ~35 extra points a season —
  // worth roughly an 18% bump in trade value at 0.5/rec. This is an explicit
  // approximation, and it is labelled as one everywhere it shows up.
  const teP = (S.league && S.league.tePremium) || 0;
  S.tePremiumApplied = teP > 0;
  S.teBump = 1 + teP * 0.36;
  if(teP > 0){
    players.forEach(p => {
      if(p.pos === 'TE' && p.value != null){
        p.valueRaw = p.value;
        p.value = Math.round(p.value * S.teBump);
      }
    });
  }

  // ---- drop positions this league doesn't even roster ----
  // Both dynasty leagues start no kicker and no defence; showing them is noise.
  const L2 = S.league || {};
  const dropK   = L2.usesK   === false;
  const dropDST = L2.usesDST === false;

  // ---- enrich from Sleeper player DB (bye, injury, id backfill) ----
  const sleeperByKey = {};
  for(const id in S.sleeperMap){
    const m = S.sleeperMap[id];
    sleeperByKey[keyOf(m.n, m.p)] = {id, ...m};
  }
  players.forEach(p => {
    const m = sleeperByKey[p.key];
    if(m){
      p.sleeperId = p.sleeperId || m.id;
      p.bye = m.b; p.injury = m.i;
      if(p.age == null) p.age = m.a;
      if(!p.team) p.team = m.t;
      // Profile-only detail. Carried through so the sheet never has to re-query.
      p.exp = m.e; p.depthPos = m.dp; p.depthOrder = m.do; p.number = m.num;
      p.height = m.ht; p.weight = m.wt; p.college = m.col;
      p.injuryPart = m.ibp; p.injuryNote = m.inote; p.rosterStatus = m.st;
      p.newsUpdated = m.nu;
    }
  });

  // How many players his own team lists at his position — turns a bare
  // depth_chart_order into "WR2 of 6", which is the number that actually means
  // something when deciding whether he sees the field.
  const depthCount = {};
  for(const id in S.sleeperMap){
    const m = S.sleeperMap[id];
    if(m.t && m.dp) depthCount[m.t + '|' + m.dp] = (depthCount[m.t + '|' + m.dp] || 0) + 1;
  }
  players.forEach(p => {
    if(p.team && p.depthPos) p.depthOf = depthCount[p.team + '|' + p.depthPos] || null;
  });

  // ---- positional consensus: average available normalised ranks ----
  const byPos = {};
  players.forEach(p => { (byPos[p.pos] = byPos[p.pos] || []).push(p); });

  for(const pos in byPos){
    const list = byPos[pos];
    list.forEach(p => {
      const ranks = Object.values(p.srcRanks).filter(v => typeof v === 'number');
      p.nSources = ranks.length;
      if(ranks.length){
        p.consensusPos = ranks.reduce((a,b)=>a+b,0) / ranks.length;
        p.spread = Math.max(...ranks) - Math.min(...ranks);
        p.best = Math.min(...ranks); p.worst = Math.max(...ranks);
      } else {
        p.consensusPos = 999; p.spread = 0;
      }
    });
    // final positional consensus rank
    list.slice().sort((a,b)=>a.consensusPos-b.consensusPos)
        .forEach((p,i)=>{ p.posRank = i+1; });
    // disagreement flag: spread large relative to position depth
    const spreads = list.map(p=>p.spread).filter(s=>s>0).sort((a,b)=>a-b);
    const p80 = spreads.length ? spreads[Math.floor(spreads.length*0.8)] : 99;
    list.forEach(p => { p.disputed = p.nSources >= 3 && p.spread >= Math.max(p80, 6); });
  }

  // ---- overall board ordering ----
  // Market value is the only genuinely cross-positional signal, so it anchors
  // overall order. Expert consensus adjusts within-position.
  const haveMarket = players.some(p => p.value != null);
  const maxV = Math.max(1, ...players.map(p=>p.value||0));
  players.forEach(p => {
    p.valPct = p.value ? p.value / maxV : 0;
    p.hasData = p.nSources > 0;

    // --- Draft edge: where the analysts and the market disagree ---
    // Your league-mates draft roughly in line with the market. So when the
    // published experts rate a player materially higher than the market does,
    // he tends to still be sitting there later than his analysis warrants.
    // Positive edge = experts high / market low = buy low.
    const expertOnly = Object.entries(p.srcRanks)
      .filter(([k]) => k !== 'Market').map(([,v]) => v).filter(v => typeof v === 'number');
    p.expertPos = expertOnly.length ? expertOnly.reduce((a,b)=>a+b,0)/expertOnly.length : null;
    p.edge = (p.expertPos != null && p.mktPosRank != null)
             ? (p.mktPosRank - p.expertPos) : null;
    // Fallback cross-positional score, used only if the market feed is down.
    // Superflex pushes QBs way up; TEs are scarce; K/DST are near-worthless early.
    const sf = S.league && S.league.qbs === 2;
    const W = { QB: sf ? 1.55 : 0.72, RB: 1.0, WR: 1.0, TE: 0.88, K: 0.12, DST: 0.14 };
    p.fallbackScore = 1000 / Math.pow((p.consensusPos || 99) + 2, 0.85) * (W[p.pos] || 1);
  });
  players.sort((a,b)=>{
    if(haveMarket){
      const av = a.value != null ? a.value : -1, bv = b.value != null ? b.value : -1;
      if(bv !== av) return bv - av;
      return (a.consensusPos||999) - (b.consensusPos||999);
    }
    return b.fallbackScore - a.fallbackScore;
  });
  S.marketDown = !haveMarket;

  // Filter FIRST, then number — otherwise removing kickers and defences leaves
  // gaps in the overall ranks (…12, 14, 17…), which reads as a bug on the board.
  S.players = players.filter(p => p.hasData
    && !(dropK && p.pos === 'K')
    && !(dropDST && p.pos === 'DST'));
  S.players.forEach((p,i)=>{ p.overall = i+1; });
  S.bySleeper = {};
  S.players.forEach(p => { if(p.sleeperId) S.bySleeper[p.sleeperId] = p; });

  // ---- tag rostered players in the active league ----
  tagOwnership();

  // ---- future rookie picks as first-class assets ----
  buildPickAssets();
}

/* =====================================================================
   3b. FUTURE DRAFT PICKS
   In a dynasty league a 2027 1st is a top-100 asset — worth more than most
   starters. Leaving picks out of the roster maths makes it look like a win to
   trade three firsts for one player, which is exactly how a team gets gutted.
   ===================================================================== */
const ORD = {1:'1st', 2:'2nd', 3:'3rd', 4:'4th', 5:'5th'};

function buildPickAssets(){
  S.picks = [];
  S.pickValueMap = {};
  const L = S.league;
  if(!L || !L.dynasty || !S.rosters.length) return;

  // FantasyCalc prices picks under names like "2027 1st". Index them.
  S.fc.forEach(row => {
    const pl = row.player || {};
    if(pl.position === 'PICK' && pl.name) S.pickValueMap[pl.name.trim()] = row.value;
  });
  if(!Object.keys(S.pickValueMap).length) return;

  const curSeason = parseInt(L.raw && L.raw.season ? L.raw.season : SEASON, 10);
  const rounds = (L.raw && L.raw.settings && L.raw.settings.draft_rounds) || 4;

  // Sleeper records only TRADED picks; everything else sits with its original
  // team. How many years out a league trades isn't exposed, so take the furthest
  // season anyone has actually traded, with a floor of two years.
  const tradedSeasons = (S.tradedPicks||[]).map(p=>parseInt(p.season,10)).filter(n=>n>curSeason);
  const maxSeason = Math.max(curSeason + 2, ...(tradedSeasons.length?tradedSeasons:[0]));
  const seasons = [];
  for(let y = curSeason + 1; y <= maxSeason; y++) seasons.push(y);
  S.pickSeasons = seasons;

  // start with every team holding its own picks, then apply the trades
  const owner = {};                       // "season|round|originalRosterId" -> rosterId
  S.rosters.forEach(r => seasons.forEach(y => {
    for(let rd = 1; rd <= rounds; rd++) owner[`${y}|${rd}|${r.roster_id}`] = r.roster_id;
  }));
  (S.tradedPicks||[]).forEach(tp => {
    const y = parseInt(tp.season,10);
    if(y < curSeason+1 || y > maxSeason || tp.round > rounds) return;
    const k = `${y}|${tp.round}|${tp.roster_id}`;
    if(k in owner) owner[k] = tp.owner_id;
  });

  for(const k in owner){
    const [y, rd, origId] = k.split('|');
    const name = `${y} ${ORD[rd] || rd+'th'}`;
    const value = S.pickValueMap[name];
    if(value == null) continue;           // no market price -> don't invent one
    S.picks.push({
      key: `pick_${y}_${rd}_${origId}`,
      name, pos: 'PICK', season: +y, round: +rd,
      origRosterId: +origId, rosterId: owner[k],
      value, isPick: true,
      team: '', bye: null, injury: null, srcRanks: {}, nSources: 0
    });
  }
  // A team can hold several "2027 1st"s acquired from different managers. They
  // are distinct assets, so name them by origin or the UI shows duplicates.
  const nameOfRoster = rid => {
    const r = S.rosters.find(x=>x.roster_id===rid); if(!r) return 'Team '+rid;
    const u = S.lusers.find(x=>x.user_id===r.owner_id);
    return (u && (u.display_name||u.username)) || ('Team '+rid);
  };
  S.picks.forEach(p => {
    p.displayName = p.origRosterId === p.rosterId
      ? p.name
      : `${p.name} (${nameOfRoster(p.origRosterId)}'s)`;
  });
  S.picks.sort((a,b)=>b.value-a.value);
}

function picksOf(rosterId){ return (S.picks||[]).filter(p=>p.rosterId === rosterId); }

function myRosterId(){
  if(!S.user) return null;
  const r = S.rosters.find(x=>x.owner_id === S.user.user_id);
  return r ? r.roster_id : null;
}

function tagOwnership(){
  S.players.forEach(p => { p.owner = null; p.mine = false; });
  if(!S.rosters.length) return;
  const uid = S.user && S.user.user_id;
  const nameOf = {};
  S.lusers.forEach(u => { nameOf[u.user_id] = u.display_name || u.username; });
  S.rosters.forEach(r => {
    (r.players || []).forEach(pid => {
      const p = S.bySleeper[String(pid)];
      if(p){ p.owner = nameOf[r.owner_id] || 'Team '+r.roster_id;
             p.mine = uid && r.owner_id === uid;
             p.rosterId = r.roster_id; }   // needed to pull balancing pieces off a specific team
    });
  });
}

/* =====================================================================
   4. TIERS
   ===================================================================== */
function tierOf(p){
  const clamp = n => Math.max(1, Math.min(5, n));
  if(p.expertTier){
    const m = p.expertTier.match(/Tier (\d+)/);
    if(m) return clamp(+m[1]);
  }
  if(p.mktTier) return clamp(p.mktTier);
  const r = p.posRank || 99;
  if(r<=5) return 1; if(r<=12) return 2; if(r<=24) return 3; if(r<=40) return 4; return 5;
}
function tierLabel(t){ return ['','Elite','Strong','Solid','Depth','Deep'][t] || 'Deep'; }

/* =====================================================================
   5. RENDER
   ===================================================================== */
const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function renderAll(){
  renderSub(); renderBoard(); renderDraft(); renderTeams(); renderHealth();
  renderMethodology(); renderLeagueEditor(); renderIdeas();
}

function renderSub(){
  const L = S.league || {};
  const okCount = S.health.filter(h=>h.ok===true).length;
  document.getElementById('subline').textContent =
    `${L.teams||12}-team · ${L.qbs===2?'Superflex':'1QB'} · ${L.ppr===1?'PPR':L.ppr===0.5?'Half-PPR':'Standard'} · ${okCount} feeds live`;
}

function positionsPresent(){
  const set = new Set(S.players.map(p=>p.pos));
  return ['QB','RB','WR','TE','K','DST'].filter(p=>set.has(p));
}

function renderChips(elId, cur, onPick){
  const el = document.getElementById(elId);
  const list = ['ALL'].concat(positionsPresent());
  el.innerHTML = list.map(p=>`<button class="chip ${p===cur?'on':''}" data-p="${p}">${p==='ALL'?'All':p}</button>`).join('');
  el.querySelectorAll('.chip').forEach(b=>b.onclick=()=>onPick(b.dataset.p));
}

function filtered(pos, q){
  let list = S.players.filter(p => pos==='ALL' || p.pos===pos);
  if(q){ const n = norm(q); list = list.filter(p => norm(p.name).includes(n) || (p.team||'').toLowerCase().includes(q.toLowerCase())); }
  return list;
}

function sortList(list, mode){
  const c = list.slice();
  switch(mode){
    case 'expert':  c.sort((a,b)=>(a.expertRank||999)-(b.expertRank||999)); break;
    case 'market':  c.sort((a,b)=>(a.mktRank||9999)-(b.mktRank||9999)); break;
    case 'trend':   c.sort((a,b)=>(b.trend==null?-9999:b.trend)-(a.trend==null?-9999:a.trend)); break;
    case 'split':   c.sort((a,b)=>(b.spread||0)-(a.spread||0)); break;
    case 'value':   c.sort((a,b)=>(b.edge==null?-999:b.edge)-(a.edge==null?-999:a.edge)); break;
    default:        c.sort((a,b)=>a.overall-b.overall);
  }
  return c;
}

function rowHTML(p, opts){
  opts = opts || {};
  const t = tierOf(p);
  const gone = S.drafted.has(p.key);
  const tags = [];
  tags.push(`<span class="tag t${t}">T${t} ${tierLabel(t)}</span>`);
  if(p.mine) tags.push('<span class="tag mine">MINE</span>');
  else if(p.owner) tags.push(`<span class="tag t5">${esc(p.owner).slice(0,10)}</span>`);
  if(p.disputed) tags.push('<span class="tag split">SPLIT</span>');
  if(p.edge != null && p.edge >= 6) tags.push('<span class="tag val">BUY LOW</span>');
  if(p.edge != null && p.edge <= -6) tags.push('<span class="tag reach">HYPED</span>');
  if(p.trend != null && p.trend >= 15) tags.push('<span class="tag val">RISING</span>');
  if(p.trend != null && p.trend <= -15) tags.push('<span class="tag reach">FALLING</span>');
  if(p.injury) tags.push(`<span class="tag reach">${esc(p.injury).slice(0,4).toUpperCase()}</span>`);

  const primary = opts.rankField === 'pos' ? (p.pos + (p.posRank||'')) : p.overall;
  const rightNum = p.value != null ? p.value.toLocaleString() : '—';

  return `<div class="prow pos-${esc(p.pos)} ${gone?'gone':''}" data-k="${esc(p.key)}">
    <div class="prk">${primary}<small>${opts.rankField==='pos'?'POS':'OVR'}</small></div>
    <div>
      <div class="pname">${esc(p.name)}</div>
      <div class="pmeta">
        <span class="poschip ${esc(p.pos)}">${esc(p.pos)}${p.posRank?('#'+p.posRank):''}</span>
        <span>${esc(p.team||'FA')}</span>
        ${p.bye?`<span>BYE ${p.bye}</span>`:''}
        ${p.trend!=null&&p.trend!==0?`<span>${p.trend>0?'▲':'▼'}${Math.abs(p.trend)}</span>`:''}
        <span>${p.nSources} src</span>
      </div>
      <div class="pmeta">${tags.join(' ')}</div>
    </div>
    <div class="pright"><div class="pval">${rightNum}<small>VALUE</small></div></div>
  </div>`;
}

function renderBoard(){
  renderChips('posChips', S.pos, p => { S.pos = p; renderBoard(); });
  const q = document.getElementById('boardSearch').value.trim();
  const list = sortList(filtered(S.pos, q), S.sort).slice(0, 300);

  const alerts = document.getElementById('boardAlerts');
  const dead = S.health.filter(h=>h.ok===false);
  let banner = '';
  if(dead.length){
    banner += `<div class="err"><b>${dead.length} feed${dead.length>1?'s':''} unavailable:</b> ${dead.map(d=>esc(d.name)).join(', ')}.
      Rankings below are built from whatever else loaded — check <b>Setup → Feed Health</b>.</div>`;
  }
  if(S.tePremiumApplied){
    banner += `<div class="ok-note"><b>TE premium league.</b> This league pays
      +${S.league.tePremium}/reception to tight ends, which no market feed prices in.
      TE values below are bumped ${Math.round((S.teBump-1)*100)}% to compensate — an estimate, not a measurement.
      Treat close TE calls as closer than they look.</div>`;
  }
  if(S.marketDown){
    banner += `<div class="err">Live market values are down, so overall order falls back to expert consensus
      weighted by position${S.league&&S.league.qbs===2?' (superflex-adjusted)':''}. Positional ranks and tiers are
      unaffected. Trade values will be unavailable until the feed returns.</div>`;
  }
  alerts.innerHTML = banner;

  document.getElementById('boardList').innerHTML = list.length
    ? `<div class="plist">${list.map(p=>rowHTML(p)).join('')}</div>`
    : `<div class="empty">No players match.</div>`;
  wireRows('boardList', openSheet);
}

function wireRows(containerId, fn){
  document.getElementById(containerId).querySelectorAll('.prow').forEach(el=>{
    el.onclick = () => fn(el.dataset.k);
  });
}
const findByKey = k => S.players.find(p=>p.key===k) || (S.picks||[]).find(p=>p.key===k);

/* ---------- full player profile ----------
   Everything known about one player in a single view: who he is, where he sits
   on his own depth chart, what the market and the analysts each think, and the
   written outlook from the weekly refresh. Live data always renders; the written
   parts degrade to a plain note when player_notes.json is missing or stale. */

/* Sleeper hosts a headshot for every player at a predictable URL. No key, no
   rate limit. onerror hides the frame rather than showing a broken image.
   Deliberately NOT: the sheet is display:none until it opens, so
   a lazy image is judged off-screen and never starts loading at all. These only
   exist once the profile is open, so eager is both correct and cheap. */
function headshotHTML(p){
  if(!p.sleeperId) return '';
  return `<img class="pshot" src="https://sleepercdn.com/content/nfl/players/${esc(p.sleeperId)}.jpg"
     alt="" onerror="this.style.display='none'">`;
}
function teamLogoHTML(team){
  if(!team) return '';
  return `<img class="plogo" src="https://sleepercdn.com/images/team_logos/nfl/${esc(String(team).toLowerCase())}.png"
     alt="" onerror="this.style.display='none'">`;
}

function notesFor(p){
  if(!S.notes) return null;
  const byId = S.notes.players && p.sleeperId ? S.notes.players[String(p.sleeperId)] : null;
  if(byId) return byId;
  // Fall back to a normalised name match — a player can change Sleeper id.
  if(S.notes.players){
    const want = norm(p.name);
    for(const k in S.notes.players){
      const n = S.notes.players[k];
      if(n && n.player && norm(n.player) === want) return n;
    }
  }
  return null;
}

function openSheet(key){
  const p = findByKey(key); if(!p) return;
  if(p.isPick) return openPickSheet(key);
  const t = tierOf(p);
  const srcs = Object.entries(p.srcRanks);
  const note = notesFor(p);
  const teamBrief = S.notes && S.notes.teams && p.team ? S.notes.teams[p.team] : null;
  const gen = S.notes && S.notes.generated ? S.notes.generated : null;

  const vitals = [];
  if(p.number != null) vitals.push('#' + p.number);
  if(p.age) vitals.push(p.age + ' yrs');
  if(p.exp != null) vitals.push(p.exp === 0 ? 'Rookie' : p.exp + ' yr' + (p.exp===1?'':'s') + ' exp');
  if(p.height) vitals.push(String(p.height).replace(/^(\d)(\d+)$/, "$1'$2\""));
  if(p.weight) vitals.push(p.weight + ' lb');
  if(p.college) vitals.push(p.college);

  const stat = (n, l, col) =>
    `<div class="srcbox"><div class="n"${col?` style="color:${col}"`:''}>${n}</div><div class="l">${esc(l)}</div></div>`;

  document.getElementById('sheetIn').innerHTML = `
    <div class="grab"></div>

    <div class="phead">
      ${headshotHTML(p)}
      <div style="min-width:0;flex:1">
        <div class="row" style="gap:7px;align-items:center">
          ${teamLogoHTML(p.team)}
          <h2 style="font-size:25px;line-height:1.05">${esc(p.name)}</h2>
        </div>
        <div class="pmeta" style="margin-top:5px">
          <span class="poschip ${esc(p.pos)}">${esc(p.pos)}${p.posRank?('#'+p.posRank):''}</span>
          <span>${esc(p.team||'FA')}</span>
          ${p.bye?`<span>BYE ${p.bye}</span>`:''}
          ${p.depthPos && p.depthOrder!=null
            ? `<span class="tag ${p.depthOrder<=1?'t1':p.depthOrder===2?'t2':'t4'}">${esc(p.depthPos)}${p.depthOrder}${p.depthOf?' of '+p.depthOf:''} on depth chart</span>`
            : ''}
        </div>
        ${vitals.length?`<div class="small muted" style="margin-top:5px">${vitals.map(esc).join(' · ')}</div>`:''}
        ${p.owner?`<div class="small" style="margin-top:4px;color:var(--gold)">${p.mine?'On your roster':'Rostered by '+esc(p.owner)}</div>`:''}
      </div>
    </div>

    ${(p.injury || p.rosterStatus) ? `
      <div class="err" style="margin-top:10px;text-align:left">
        <b>${esc(p.injury || p.rosterStatus)}</b>${p.injuryPart?` — ${esc(p.injuryPart)}`:''}
        ${p.injuryNote?`<br><span class="small">${esc(p.injuryNote)}</span>`:''}
        ${p.newsUpdated?`<br><span class="small muted">Sleeper record updated ${timeAgo(p.newsUpdated)}</span>`:''}
      </div>` : ''}

    <div class="spacer"></div>
    <div class="srcgrid">
      ${stat(p.overall, 'Overall')}
      ${stat(p.posRank ? p.pos + p.posRank : '—', 'At position')}
      ${stat(p.value!=null?p.value.toLocaleString():'—', 'Market value')}
      ${stat(p.trend!=null?(p.trend>0?'+':'')+p.trend:'—', '30-day trend',
             p.trend>0?'var(--good)':p.trend<0?'var(--bad)':null)}
      ${stat('T'+t, tierLabel(t), 'var(--t'+t+')')}
      ${p.rostered!=null?stat(Math.round(p.rostered)+'%', 'Rostered'):''}
    </div>

    <div class="spacer"></div>
    <h3 class="disp psec">Where the sources land</h3>
    <div class="hint" style="margin-bottom:6px">Positional rank from each independent source. Wide gaps mean the pros disagree — that's your risk signal.</div>
    <div class="srcgrid">
      ${srcs.map(([k,v])=>`<div class="srcbox"><div class="n">${v}</div><div class="l">${esc(k)}</div></div>`).join('')}
    </div>
    ${srcs.length>=2 ? `
      <div class="small muted" style="margin-top:9px">
        Range <b style="color:var(--chalk)">${p.best}–${p.worst}</b> ·
        consensus <b style="color:var(--chalk)">${p.consensusPos.toFixed(1)}</b> ·
        spread ${p.spread} ${p.disputed?'<span class="tag split">HIGH DISAGREEMENT</span>':''}
      </div>` : ''}

    ${p.edge!=null && Math.abs(p.edge)>=3 ? `
      <div class="spacer"></div>
      <div class="card" style="margin:0">
        <div class="small"><b>Draft edge:</b> the analysts have him around <b>${p.pos}${Math.round(p.expertPos)}</b>,
        the market has him at <b>${p.pos}${p.mktPosRank}</b> —
        <span style="color:${p.edge>=0?'var(--good)':'var(--bad)'}">
        ${p.edge>=0
          ? `${Math.round(p.edge)} spots of daylight in your favour. Your league-mates draft off the market, so he should last past his analysis. Buy low.`
          : `the market is ${Math.round(Math.abs(p.edge))} spots ahead of the analysts. You'd be paying for hype the pros haven't signed off on.`}</span></div>
      </div>`:''}

    <div class="spacer"></div>
    <h3 class="disp psec">Outlook</h3>
    ${note && note.outlook ? `
      <div class="pnote">${esc(note.outlook)}</div>
      ${note.watch?`<div class="pnote sub"><b>Watch:</b> ${esc(note.watch)}</div>`:''}`
    : `<div class="hint">No written outlook for this player yet. The weekly refresh writes these — everything above is live from Sleeper and the market.</div>`}

    ${teamBrief && teamBrief.brief ? `
      <div class="spacer"></div>
      <h3 class="disp psec">${esc(p.team)} situation</h3>
      <div class="pnote">${esc(teamBrief.brief)}</div>` : ''}

    ${gen?`<div class="small muted" style="margin-top:8px">Outlook written ${esc(gen)}. Market value and injury status above are live.</div>`:''}

    <div class="spacer"></div>
    <div class="row">
      <button class="btn grow ${p.mine?'gold':''}" onclick="addTrade('${esc(p.key)}','give')">
        ${p.mine?'Trade him away':'+ I Give'}</button>
      <button class="btn grow ${(p.owner&&!p.mine)?'gold':''}" onclick="addTrade('${esc(p.key)}','get')">
        ${(p.owner&&!p.mine)?'Target him':'+ I Get'}</button>
    </div>
    <div class="spacer"></div>
    <button class="btn grow" style="width:100%" onclick="toggleDrafted('${esc(p.key)}')">
      ${S.drafted.has(p.key)?'Un-mark drafted':'Mark as drafted'}</button>
    <div class="spacer"></div>
    <button class="btn" style="width:100%" onclick="closeSheet()">Close</button>
  `;
  document.getElementById('sheet').classList.add('on');
}
function closeSheet(){ document.getElementById('sheet').classList.remove('on'); }
document.getElementById('sheet').onclick = e => { if(e.target.id==='sheet') closeSheet(); };

/* =====================================================================
   6. DRAFT MODE
   ===================================================================== */
function toggleDrafted(k){
  if(S.drafted.has(k)) S.drafted.delete(k); else S.drafted.add(k);
  LS.set('drafted', [...S.drafted]);
  closeSheet(); renderBoard(); renderDraft();
}

function renderDraft(){
  renderChips('draftPosChips', S.dpos, p => { S.dpos = p; renderDraft(); });
  const avail = S.players.filter(p => !S.drafted.has(p.key) && (S.dpos==='ALL' || p.pos===S.dpos));
  const list = sortList(avail, 'consensus').slice(0, 200);
  document.getElementById('draftList').innerHTML =
    `<div class="plist">${list.map(p=>rowHTML(p)).join('')}</div>`;
  wireRows('draftList', openSheet);

  // scarcity
  const rows = [];
  ['QB','RB','WR','TE'].forEach(pos=>{
    const left = S.players.filter(p=>p.pos===pos && !S.drafted.has(p.key));
    const t12 = left.filter(p=>tierOf(p)<=2).length;
    const t3  = left.filter(p=>tierOf(p)===3).length;
    const total = S.players.filter(p=>p.pos===pos && tierOf(p)<=2).length || 1;
    const pct = Math.round(100*t12/total);
    rows.push(`<div style="margin-bottom:9px">
      <div class="row small"><span class="grow"><b>${pos}</b> — ${t12} elite/strong left, ${t3} solid</span>
      <span class="muted">${pct}%</span></div>
      <div class="bar"><i style="width:${pct}%;background:${pct<25?'var(--bad)':pct<50?'var(--gold)':'var(--good)'}"></i></div>
    </div>`);
  });
  document.getElementById('scarcity').innerHTML = rows.join('');
  document.getElementById('draftHint').textContent =
    `${S.drafted.size} players off the board. Tap any player to mark them gone.`;
}

document.getElementById('draftReset').onclick = () => {
  S.drafted.clear(); LS.set('drafted', []); renderDraft(); renderBoard();
};

document.getElementById('draftSync').onclick = async () => {
  const id = document.getElementById('draftId').value.trim();
  if(!id) return alert('Paste your Sleeper draft ID. It is the last part of the draft URL:\nsleeper.com/draft/nfl/XXXXXXXXX');
  LS.set('draftId', id);
  const picks = await getJSON(`${SLEEPER}/draft/${id}/picks`, 'Live Draft Picks', 0);
  if(!picks){ return alert('Could not load that draft. Double-check the ID.'); }
  let hit = 0;
  picks.forEach(pk => {
    const p = S.bySleeper[String(pk.player_id)];
    if(p){ S.drafted.add(p.key); hit++; }
  });
  LS.set('drafted', [...S.drafted]);
  renderDraft(); renderBoard();
  alert(`Synced ${picks.length} picks (${hit} matched to the board).`);
};

/* =====================================================================
   7. TRADE EVALUATOR
   ===================================================================== */
function addTrade(key, side){
  const arr = side==='give' ? S.give : S.get;
  if(!arr.includes(key)) arr.push(key);
  closeSheet(); showTab('trade'); renderTrade();
}
function removeTrade(key, side){
  if(side==='give') S.give = S.give.filter(k=>k!==key);
  else S.get = S.get.filter(k=>k!==key);
  renderTrade();
}

/* Diminishing returns: you can only start so many players, so the 2nd, 3rd,
   4th piece in a package is worth progressively less than its raw value. */
function packageValue(keys){
  const vals = keys.map(k => { const p = findByKey(k); return p && p.value ? p.value : 0; })
                   .sort((a,b)=>b-a);
  let total = 0;
  vals.forEach((v,i) => { total += v * Math.pow(0.92, i); });
  return { adjusted: Math.round(total), raw: Math.round(vals.reduce((a,b)=>a+b,0)), n: vals.length };
}

/* Who is on the other side of this trade? Inferred from whoever owns most of
   what you're asking for — the app never makes you pick a partner manually. */
function counterpartyRosterId(){
  const counts = {};
  S.get.map(k=>findByKey(k)).filter(Boolean).forEach(a => {
    const rid = a.isPick ? a.rosterId : a.rosterId;
    if(rid != null && rid !== myRosterId()) counts[rid] = (counts[rid]||0) + 1;
  });
  const best = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
  return best ? +best[0] : null;
}

/* Suggest pieces that would even out a lopsided offer.
   Candidates are scored by simulating the trade WITH them added, so the
   package discount is respected — matching raw value to the raw gap would
   consistently overshoot. */
const FAIR_PCT = 8;

function suggestBalancers(){
  if(!S.give.length || !S.get.length) return null;
  const g0 = packageValue(S.give), r0 = packageValue(S.get);
  const diff0 = r0.adjusted - g0.adjusted;
  const pct0 = g0.adjusted ? (diff0 / g0.adjusted * 100) : 0;
  if(Math.abs(pct0) < FAIR_PCT) return { balanced: true, pct: pct0 };

  const iAmUp = diff0 > 0;               // I'm receiving more than I'm sending
  const side  = iAmUp ? 'give' : 'get';  // so the light side is mine (give) or theirs (get)
  const myRid = myRosterId();
  const cpRid = counterpartyRosterId();
  const fromRid = iAmUp ? myRid : cpRid;
  if(fromRid == null) return { needPartner: !iAmUp, pct: pct0 };

  const inTrade = new Set(S.give.concat(S.get));
  const pool = S.players.filter(p => p.rosterId === fromRid && p.value != null && !inTrade.has(p.key))
    .concat((S.picks||[]).filter(p => p.rosterId === fromRid && !inTrade.has(p.key)));

  const scored = pool.map(c => {
    const give = side === 'give' ? S.give.concat(c.key) : S.give;
    const get  = side === 'get'  ? S.get.concat(c.key)  : S.get;
    const g = packageValue(give), r = packageValue(get);
    const d = r.adjusted - g.adjusted;
    const p = g.adjusted ? (d / g.adjusted * 100) : 0;
    return { asset: c, newPct: p, absPct: Math.abs(p) };
  }).filter(x => x.absPct < Math.abs(pct0))       // must actually improve things
    .sort((a,b) => a.absPct - b.absPct);

  // Interchangeable assets (three identical 2027 1sts) should take one slot,
  // not crowd out the genuinely different options.
  const seen = new Set();
  const options = scored.filter(x => {
    const sig = `${x.asset.isPick ? x.asset.name : x.asset.key}|${x.asset.value}`;
    if(seen.has(sig)) return false;
    seen.add(sig); return true;
  }).slice(0, 5);

  return { balanced:false, pct: pct0, side, iAmUp, fromRid, options,
           fromName: (() => {
             const r = S.rosters.find(x=>x.roster_id===fromRid); if(!r) return '';
             const u = S.lusers.find(x=>x.user_id===r.owner_id);
             return fromRid === myRid ? 'your roster' : ((u&&(u.display_name||u.username))||'their roster');
           })() };
}

function renderBalancers(){
  const box = document.getElementById('balanceBox');
  if(!box) return;
  const s = suggestBalancers();
  if(!s){ box.innerHTML = ''; return; }

  if(s.balanced){
    box.innerHTML = `<div class="card" style="margin-top:10px">
      <h2>Even It Out</h2>
      <div class="hint">This is already inside ${FAIR_PCT}% — close enough that neither side is being
        fleeced. Nothing to add.</div></div>`;
    return;
  }
  if(s.needPartner){
    box.innerHTML = `<div class="card" style="margin-top:10px">
      <h2>Even It Out</h2>
      <div class="hint">Add a player you'd be receiving so I know which team you're dealing with,
        and I'll suggest what to ask them for.</div></div>`;
    return;
  }
  if(!s.options.length){
    box.innerHTML = `<div class="card" style="margin-top:10px">
      <h2>Even It Out</h2>
      <div class="hint">Nothing on ${esc(s.fromName)} closes this gap without overshooting it.
        The pieces are too big or too small — try changing the main players instead.</div></div>`;
    return;
  }

  box.innerHTML = `<div class="card" style="margin-top:10px">
    <h2>Even It Out</h2>
    <div class="hint">You're ${s.iAmUp?'ahead':'behind'} by ${Math.abs(Math.round(s.pct))}%.
      Adding one of these from <b>${esc(s.fromName)}</b> to the
      <b>${s.side==='give'?'I Give':'I Get'}</b> side gets closest to even.
      Each figure below is what the deal would read after adding that piece.</div>
    <div class="spacer"></div>
    <div class="plist">
      ${s.options.map(o => {
        const a = o.asset;
        const col = o.absPct < FAIR_PCT ? 'var(--good)' : 'var(--gold)';
        return `<div class="prow" onclick="addTrade('${esc(a.key)}','${s.side}')">
          <div class="prk" style="font-size:15px">${a.isPick?'📄':(a.pos||'')}<small>${a.isPick?'PICK':'POS'}</small></div>
          <div>
            <div class="pname">${esc(a.displayName || a.name)}</div>
            <div class="pmeta">
              <span>${a.value.toLocaleString()} value</span>
              ${a.isPick?'':`<span>${esc(a.team||'FA')}</span>`}
              ${!a.isPick && tierOf(a)<=2 ? '<span class="tag t1">CORE</span>' : ''}
            </div>
          </div>
          <div class="pright"><div class="pval" style="color:${col}">${o.newPct>0?'+':''}${Math.round(o.newPct)}%<small>AFTER</small></div></div>
        </div>`;
      }).join('')}
    </div>
    ${s.side==='get' ? `<div class="hint" style="margin-top:9px">These come off
      ${esc(s.fromName)}'s roster — it's what you'd be asking them to include.</div>` : ''}
  </div>`;
}

/* =====================================================================
   TRADE IDEAS
   Proposals generated across the whole league. The scoring deliberately uses
   min(my benefit, their benefit): a trade only ranks well if BOTH sides fix a
   real hole. That is what stops it proposing daylight robbery — a deal that
   only helps you scores zero here, however lopsided the value is in your
   favour, and never surfaces.
   ===================================================================== */
const IDEA_FAIR_PCT = 12;   // value must be within this to be worth proposing
// Both sides must gain at least this much positionally. Tuned against the live
// league: at 10 the only shape that survived was "sell a WR for picks", which
// hid the equally valid "sell a WR for a RB" — the second-biggest hole on this
// roster. Lower and it starts proposing swaps neither manager would notice.
const IDEA_MIN_HELP = 8;

function tradeIdeas(limit){
  limit = limit || 8;
  if(!S.rosters.length || !S.user) return [];
  const P = leagueProfiles();
  const me = P.find(t => t.isMe);
  if(!me) return [];
  const groups = FIT_POS.concat(me.PICKS != null ? ['PICKS'] : []);
  const grpOf = a => a.isPick ? 'PICKS' : a.pos;
  const worth = a => a.value != null && a.value >= 700;   // ignore roster filler

  const ideas = [];
  const myAssets = me.players.filter(worth).concat(me.picks || []);

  P.filter(t => !t.isMe).forEach(T => {
    const theirAssets = T.players.filter(worth).concat(T.picks || []);
    myAssets.forEach(A => {
      const ga = grpOf(A);
      if(groups.indexOf(ga) < 0) return;
      theirAssets.forEach(B => {
        const gb = grpOf(B);
        if(groups.indexOf(gb) < 0 || ga === gb) return;   // like-for-like fixes nothing

        const pct = A.value ? (B.value - A.value) / A.value * 100 : 0;
        if(Math.abs(pct) > IDEA_FAIR_PCT) return;         // must be near-even money

        // I receive at gb (where I'm thin) and spend at ga (where I'm deep).
        // Both conditions have to hold, hence the min.
        const myBenefit    = Math.min(100 - me[gb], me[ga] - 100);
        // They receive at ga (where they're thin) and spend at gb (where they're deep).
        const theirBenefit = Math.min(100 - T[ga],  T[gb] - 100);
        const mutual = Math.min(myBenefit, theirBenefit);
        if(mutual < IDEA_MIN_HELP) return;

        ideas.push({
          partner: T.name, partnerRank: T.valueRank, rosterId: T.rosterId,
          give: A, get: B, pct, mutual,
          myBenefit, theirBenefit,
          why: `You're thin at ${gb === 'PICKS' ? 'future picks' : gb} and deep at ${ga === 'PICKS' ? 'picks' : ga}. ` +
               `${T.name} is the mirror image, so both rosters come out better balanced.`
        });
      });
    });
  });

  // Spread the list around: at most one idea per asset of mine, two per partner,
  // so it reads as a set of options rather than eight versions of one trade.
  ideas.sort((a,b) => b.mutual - a.mutual || Math.abs(a.pct) - Math.abs(b.pct));
  const usedAsset = new Set(), perPartner = {};
  const out = [];
  for(const i of ideas){
    if(usedAsset.has(i.give.key)) continue;
    perPartner[i.partner] = perPartner[i.partner] || 0;
    if(perPartner[i.partner] >= 2) continue;
    usedAsset.add(i.give.key); perPartner[i.partner]++;
    out.push(i);
    if(out.length >= limit) break;
  }
  return out;
}

function loadIdea(giveKey, getKey){
  S.give = [giveKey]; S.get = [getKey];
  renderTrade();
  const el = document.getElementById('tradeVerdict');
  if(el && typeof el.scrollIntoView === 'function') el.scrollIntoView({behavior:'smooth', block:'center'});
}

function renderIdeas(){
  const box = document.getElementById('ideasBox');
  if(!box) return;
  const ideas = tradeIdeas(8);
  if(!ideas.length){
    box.innerHTML = `<div class="card"><h2>Trade Ideas</h2>
      <div class="hint">${S.rosters.length
        ? `Nothing right now that clearly helps both sides at a fair price. That usually means your
           roster is shaped like everyone else's — check <b>My Teams → Trade Partners</b> for where the
           gaps are.`
        : `Pick a Sleeper league from the dropdown to generate ideas.`}</div></div>`;
    return;
  }
  box.innerHTML = `<div class="card">
      <h2>Trade Ideas</h2>
      <div class="hint">Offers worth sending. Each one is within ${IDEA_FAIR_PCT}% on value and fixes a
        real hole <b>on both rosters</b> — a deal that only helped you would score zero here and never
        appear. Tap one to load it into the evaluator.</div>
    </div>
    ${ideas.map(i => `
      <div class="card" style="padding:12px;cursor:pointer" onclick="loadIdea('${esc(i.give.key)}','${esc(i.get.key)}')">
        <div class="row">
          <div class="grow" style="min-width:0">
            <div style="font-weight:600;font-size:14px">${esc(i.partner)}
              <span class="muted" style="font-weight:400">· #${i.partnerRank} by value</span></div>
          </div>
          <div style="text-align:right">
            <div style="font-family:'Teko';font-size:17px;line-height:1;color:${Math.abs(i.pct)<=6?'var(--good)':'var(--gold)'}">
              ${i.pct>0?'+':''}${Math.round(i.pct)}%</div>
            <div style="font-size:8.5px;color:var(--faint);letter-spacing:.05em">VALUE SWING</div>
          </div>
        </div>
        <div class="row" style="margin-top:9px;gap:8px;align-items:stretch">
          <div class="tside" style="flex:1;min-height:0;padding:7px">
            <div style="font-size:8.5px;color:var(--faint);letter-spacing:.06em">YOU SEND</div>
            <div style="font-weight:600;font-size:13px;margin-top:2px">${esc(i.give.displayName || i.give.name)}</div>
            <div class="muted" style="font-size:11px">${i.give.isPick?'Pick':esc(i.give.pos)} · ${i.give.value.toLocaleString()}</div>
          </div>
          <div class="tside" style="flex:1;min-height:0;padding:7px">
            <div style="font-size:8.5px;color:var(--faint);letter-spacing:.06em">YOU GET</div>
            <div style="font-weight:600;font-size:13px;margin-top:2px">${esc(i.get.displayName || i.get.name)}</div>
            <div class="muted" style="font-size:11px">${i.get.isPick?'Pick':esc(i.get.pos)} · ${i.get.value.toLocaleString()}</div>
          </div>
        </div>
        <div class="small" style="margin-top:8px;color:var(--dim);line-height:1.5">${i.why}</div>
      </div>`).join('')}`;
}

function renderTrade(){
  const paint = (arr, side, elId) => {
    document.getElementById(elId).innerHTML = arr.length ? arr.map(k=>{
      const p = findByKey(k); if(!p) return '';
      return `<div class="tpill"><span>${esc(p.displayName || p.name)} <span class="muted">${esc(p.pos)}</span></span>
        <span><b>${p.value!=null?p.value.toLocaleString():'—'}</b>
        <button onclick="removeTrade('${esc(k)}','${side}')">×</button></span></div>`;
    }).join('') : '<div class="muted small">Nothing yet.</div>';
  };
  paint(S.give,'give','giveList'); paint(S.get,'get','getList');

  const g = packageValue(S.give), r = packageValue(S.get);
  const el = document.getElementById('tradeVerdict');
  if(!S.give.length || !S.get.length){ el.innerHTML=''; renderBalancers(); return; }

  const diff = r.adjusted - g.adjusted;
  const pct = g.adjusted ? (diff / g.adjusted * 100) : 0;
  const cls = Math.abs(pct) < 8 ? 'even' : (diff > 0 ? 'win' : 'lose');
  const word = Math.abs(pct) < 8 ? 'Fair Deal' : (diff > 0 ? 'You Win' : 'You Lose');

  /* ---- future capital check ----
     The failure mode this exists to catch: a package of picks can clear the
     value bar and still hollow out the team, because picks are the only asset
     that replaces itself for free every year. */
  let capital = '';
  const myRid = myRosterId();
  if(myRid != null && (S.picks||[]).length){
    const mine = picksOf(myRid);
    const myPickTotal = mine.reduce((s,p)=>s+p.value,0);
    const outPicks = S.give.map(k=>findByKey(k)).filter(p=>p && p.isPick);
    const inPicks  = S.get.map(k=>findByKey(k)).filter(p=>p && p.isPick);
    const outVal = outPicks.reduce((s,p)=>s+p.value,0);
    const inVal  = inPicks.reduce((s,p)=>s+p.value,0);
    const netOut = outVal - inVal;

    if(outPicks.length || inPicks.length){
      const pctGone = myPickTotal ? Math.round(100*netOut/myPickTotal) : 0;
      const firstsOut = outPicks.filter(p=>p.round===1).length;
      const firstsLeft = mine.filter(p=>p.round===1).length - firstsOut + inPicks.filter(p=>p.round===1).length;
      const severe = pctGone >= 45 || firstsOut >= 2 || firstsLeft <= 0;
      const mild   = !severe && pctGone >= 20;

      if(netOut > 0 && (severe || mild)){
        capital = `<div class="${severe?'err':'ok-note'}" style="margin-top:10px;text-align:left">
          <b>${severe?'You are mortgaging the future.':'Heads up on draft capital.'}</b>
          This sends away <b>${pctGone}%</b> of your future draft capital${
            firstsOut?` — including <b>${firstsOut} first-round pick${firstsOut>1?'s':''}</b>`:''}.
          ${firstsLeft<=0
            ? `You would have <b>no first-rounders left</b> in ${S.pickSeasons.join(' or ')}. If this player
               doesn't work out, there is nothing behind him.`
            : `You'd be left with ${firstsLeft} future 1st${firstsLeft===1?'':'s'}.`}
          <br><br>The trade may still be right — contenders should buy — but picks are the only asset
          that renews itself every year, so this is a real cost the value totals alone won't show you.
        </div>`;
      } else if(netOut < 0){
        capital = `<div class="ok-note" style="margin-top:10px;text-align:left">
          <b>You're buying future capital.</b> This nets you
          ${inPicks.length} pick${inPicks.length===1?'':'s'} worth ${Math.abs(netOut).toLocaleString()}.
          Good if you're rebuilding; a real cost if you're trying to win this year.</div>`;
      }
    }
  }

  // roster-need context
  let need = '';
  if(S.rosters.length && S.user){
    const mine = S.rosters.find(x => x.owner_id === S.user.user_id);
    if(mine){
      const counts = {};
      (mine.players||[]).forEach(pid=>{ const p=S.bySleeper[String(pid)]; if(p&&tierOf(p)<=3) counts[p.pos]=(counts[p.pos]||0)+1; });
      const outPos = S.give.map(k=>findByKey(k)).filter(Boolean).map(p=>p.pos);
      const thin = outPos.filter(pos => (counts[pos]||0) <= 2);
      if(thin.length) need = `<div class="small" style="margin-top:8px;color:var(--gold)">
        Heads up — you're already thin at ${[...new Set(thin)].join('/')} on this roster. Value isn't everything.</div>`;
    }
  }

  el.innerHTML = `<div class="verdict ${cls}">
    <div class="big">${word}</div>
    <div class="small muted" style="margin-top:4px">
      ${diff>0?'+':''}${diff.toLocaleString()} adjusted value (${pct>0?'+':''}${pct.toFixed(0)}%)</div>
    <table class="mini" style="margin-top:10px;text-align:left">
      <tr><td>You give (${g.n})</td><td>${g.adjusted.toLocaleString()}</td></tr>
      <tr><td>You get (${r.n})</td><td>${r.adjusted.toLocaleString()}</td></tr>
      <tr><td class="muted">Raw sum, no depth discount</td><td class="muted">${g.raw.toLocaleString()} → ${r.raw.toLocaleString()}</td></tr>
    </table>
    ${need}
    ${capital}
    <div class="small muted" style="margin-top:8px">Configured for ${S.league.teams}-team ${S.league.qbs===2?'superflex':'1QB'}${S.league.dynasty?' dynasty':''}${
      S.league.dynasty && S.pickSeasons ? ` · future picks priced for ${S.pickSeasons.join(' & ')}` : ''}.</div>
  </div>`;

  renderBalancers();
}
document.getElementById('tradeClear').onclick = () => { S.give=[]; S.get=[]; renderTrade(); };

document.getElementById('tradeSearch').oninput = e => {
  const q = e.target.value.trim();
  const box = document.getElementById('tradeResults');
  if(q.length < 2){ box.innerHTML=''; return; }
  // Picks are searchable too — type "2027" or "1st" to pull them up.
  const nq = q.toLowerCase();
  const pickHits = (S.picks||[]).filter(p =>
      p.name.toLowerCase().includes(nq) || (p.displayName||'').toLowerCase().includes(nq));
  const hits = pickHits.slice(0,6).concat(filtered('ALL', q)).slice(0,10);
  const ownerName = rid => {
    const r = S.rosters.find(x=>x.roster_id===rid); if(!r) return '';
    const u = S.lusers.find(x=>x.user_id===r.owner_id);
    return u ? (u.display_name||u.username) : ('Team '+rid);
  };
  box.innerHTML = hits.length ? `<div class="plist" style="margin-top:8px">${hits.map(p=>`
    <div class="prow">
      <div class="prk">${p.isPick?'📄':p.overall}<small>${p.isPick?'PICK':'OVR'}</small></div>
      <div><div class="pname">${esc(p.displayName || p.name)}</div>
        <div class="pmeta"><span>${p.isPick?esc(ownerName(p.rosterId)):esc(p.pos)+' · '+esc(p.team||'FA')}</span><span>${p.value!=null?p.value.toLocaleString():'—'}</span></div></div>
      <div class="pright" style="display:flex;gap:4px">
        <button class="btn sm" onclick="addTrade('${esc(p.key)}','give')">Give</button>
        <button class="btn sm" onclick="addTrade('${esc(p.key)}','get')">Get</button>
      </div>
    </div>`).join('')}</div>` : '<div class="empty">No match.</div>';
};

/* =====================================================================
   8. MY TEAMS
   ===================================================================== */

/* Plain-language explanation for each roster stat, including what it does NOT
   tell you — a number you misread is worse than no number. */
const STAT_INFO = {
  rank: { title:'Value Rank',
    body:`Where your roster sits, 1 to ${'{TEAMS}'}, if you add up the market value of every player
      each manager owns. <b>1 means you hold the most valuable collection of assets in the league.</b>
      <br><br>It answers "who has the best stuff", not "who wins on Sunday". It counts your whole
      roster, so a team with lots of good depth can out-rank a team with three superstars and nothing
      after them — and in a start-9 league, the superstars usually win. Treat it as a trade-leverage
      reading, not a power ranking.` },
  total: { title:'Total Value',
    body:`The market value of everything you own, added up, shown in thousands. The units are arbitrary
      — the number only means something next to the other teams in this league.
      <br><br><b>In a dynasty league this includes your future rookie picks</b>, because they are real
      tradeable assets and a total that ignored them would be flattering nonsense.
      <br><br>Its real use is trade math: it's the same currency the Trade tab prices packages in,
      so you can see what a deal does to your overall holdings. On its own, ignore it.` },
  picks: { title:'Future 1sts / Picks',
    body:`Your future rookie draft picks — first-rounders shown first, total picks after the slash.
      Pulled live from Sleeper, including every pick you've traded for or away.
      <br><br>These are priced by the same market as players. A 2027 1st is currently worth more than
      most starters, which is exactly why trading them away can look like a win on a value sheet while
      quietly hollowing out the team.
      <br><br>The Trade tab now warns you when a deal sends away a big share of this, and tells you how
      many first-rounders you'd have left. Contenders should spend picks; the point is to do it knowing
      the price.` },
  players: { title:'Players',
    body:`How many players on your roster the board has data for.
      <br><br>If this is lower than your actual Sleeper roster count, the difference is deep bench guys
      too far down to be ranked or priced anywhere — which is itself a signal about how much of your
      bench is doing nothing.` },
  diff: { title:'Difference-Makers',
    body:`How many of your players land in <b>Tier 1 or Tier 2</b> — the ones who genuinely swing a
      matchup, rather than filling a slot.
      <br><br>This is the number to watch, more than the two on its left. Championships come from
      concentrated talent, and it's the one stat here that a pile of mediocre depth can't inflate.
      Four or more is a contender. One or two means you should be consolidating: trade three good
      players for one great one.` }
};

function statBox(value, label, key){
  return `<div class="srcbox statbox" onclick="toggleStat('${key}')">
    <div class="n">${value}</div><div class="l">${esc(label)}</div>
    <div class="qmark">?</div>
  </div>`;
}

function toggleStat(key){
  const panel = document.getElementById('statInfo');
  if(!panel) return;
  if(panel.dataset.open === key){ panel.dataset.open = ''; panel.innerHTML = ''; return; }
  panel.dataset.open = key;
  const info = STAT_INFO[key]; if(!info) return;
  const teams = (S.league && S.league.teams) || 12;
  panel.innerHTML = `<div class="statinfo">
    <div class="row"><b class="grow">${esc(info.title)}</b>
      <button class="btn sm" onclick="toggleStat('${key}')">Close</button></div>
    <div class="hint" style="margin-top:6px">${info.body.replace('{TEAMS}', teams)}</div>
  </div>`;
}
/* ---------------------------------------------------------------------
   League-wide team profiles + trade-fit matching
   --------------------------------------------------------------------- */
const FIT_POS = ['QB','RB','WR','TE'];

/* Build a profile for every roster: total value, tier counts, and positional
   strength expressed as a percentage of the league average at that spot. */
function leagueProfiles(){
  const nameOf = {}; S.lusers.forEach(u => nameOf[u.user_id] = u.display_name || u.username);
  const top3 = (players, pos) => players.filter(p=>p.pos===pos)
      .sort((a,b)=>(b.value||0)-(a.value||0)).slice(0,3)
      .reduce((s,p)=>s+(p.value||0),0);

  const profiles = S.rosters.map(r => {
    const players = (r.players||[]).map(pid=>S.bySleeper[String(pid)]).filter(Boolean)
                      .sort((a,b)=>a.overall-b.overall);
    const picks = picksOf(r.roster_id);
    const playerVal = players.reduce((s,p)=>s+(p.value||0),0);
    const pickVal = picks.reduce((s,p)=>s+p.value,0);
    return {
      rosterId: r.roster_id,
      ownerId: r.owner_id,
      name: nameOf[r.owner_id] || ('Team ' + r.roster_id),
      isMe: !!(S.user && r.owner_id === S.user.user_id),
      record: r.settings ? `${r.settings.wins||0}-${r.settings.losses||0}` : '',
      players, picks,
      playerVal, pickVal,
      firsts: picks.filter(p=>p.round===1).length,
      total: playerVal + pickVal,   // picks are assets; a value rank that ignores them lies
      diffMakers: players.filter(p=>tierOf(p)<=2).length,
      raw: {}
    };
  });

  // league average per position, then each team's % of it
  FIT_POS.forEach(pos => {
    const vals = profiles.map(t => top3(t.players, pos));
    const avg = vals.reduce((a,b)=>a+b,0) / (vals.length||1);
    profiles.forEach((t,i) => {
      t.raw[pos] = vals[i];
      t[pos] = avg ? Math.round(100 * vals[i] / avg) : 100;
    });
  });

  // Draft capital scored on the same scale, so a pick-rich team is as visible
  // as a receiver-rich one. Dynasty only — redraft has no future picks.
  if(S.league && S.league.dynasty && (S.picks||[]).length){
    const vals = profiles.map(t => t.pickVal);
    const avg = vals.reduce((a,b)=>a+b,0) / (vals.length||1);
    profiles.forEach((t,i) => {
      t.raw.PICKS = vals[i];
      t.PICKS = avg ? Math.round(100 * vals[i] / avg) : 100;
    });
  }

  profiles.sort((a,b)=>b.total-a.total);
  profiles.forEach((t,i)=>{ t.valueRank = i+1; });
  return profiles;
}

/* How well do two rosters match up as trade partners?
   The point is COMPLEMENTARY need, not raw wealth. A rich team that is strong
   exactly where you are strong has nothing you can pry loose at a fair price. */
/* What matters is the gap BETWEEN the two rosters at each position, not each
   team's distance from the league average. A manager sitting on RB 170 while
   you're at RB 92 is a real trade target even though you're only slightly below
   average — the 78-point gap is the tradeable surplus, and measuring each side
   against 100 independently throws that away. */
const FIT_GAP = 20;   // ignore anything smaller; it's noise, not a surplus

function tradeFit(me, them){
  let raw = 0; const reasons = [];
  const groups = FIT_POS.concat(me.PICKS != null && them.PICKS != null ? ['PICKS'] : []);
  const dev = v => (v-100 > 0 ? '+' : '') + (v-100) + '%';
  groups.forEach(pos => {
    const gap = them[pos] - me[pos];
    const isP = pos === 'PICKS';
    if(gap >= FIT_GAP){
      raw += gap;
      reasons.push({dir:'buy', pos, gap,
        text: isP
          ? `They're sitting on far more <b>future capital</b> — ${dev(them.PICKS)} vs your ${dev(me.PICKS)}. A rebuild partner: they take a veteran, you take picks.`
          : `They're far deeper at <b>${pos}</b> — ${dev(them[pos])} vs your ${dev(me[pos])}`});
    } else if(gap <= -FIT_GAP){
      raw += -gap;
      reasons.push({dir:'sell', pos, gap,
        text: isP
          ? `You hold far more <b>future capital</b> — ${dev(me.PICKS)} vs their ${dev(them.PICKS)}. They're buying now; picks are what you'd send.`
          : `You're far deeper at <b>${pos}</b> — ${dev(me[pos])} vs their ${dev(them[pos])}`});
    }
  });
  // Both directions present means each side gets something it actually wants,
  // which is what makes an offer get accepted rather than ignored.
  const twoWay = reasons.some(r=>r.dir==='sell') && reasons.some(r=>r.dir==='buy');
  const score = Math.round((twoWay ? raw * 1.6 : raw) / 2);
  reasons.sort((a,b)=>Math.abs(b.gap)-Math.abs(a.gap));
  return { score, reasons, twoWay };
}

function fitLabel(f){
  if(f.twoWay && f.score >= 110) return {t:'Ideal Match', c:'var(--good)'};
  if(f.score >= 75) return {t:'Strong Fit', c:'var(--good)'};
  if(f.score >= 40) return {t:'Worth Asking', c:'var(--gold)'};
  if(f.score > 0)   return {t:'Marginal', c:'var(--dim)'};
  return {t:'Poor Fit', c:'var(--faint)'};
}

/* Position filter for an opened opponent roster. Kept per-team rather than
   global so opening a different team doesn't inherit the last team's filter —
   when sizing up a trade you almost always want to start from their full board. */
function setTeamPos(rid, pos){
  S.teamPos = S.teamPos || {};
  S.teamPos[rid] = pos;
  renderTeams();
  const el = document.getElementById('team_'+rid);
  if(el && typeof el.scrollIntoView === 'function') el.scrollIntoView({behavior:'smooth', block:'start'});
}

function viewTeam(rid){
  if(S.teamPos) delete S.teamPos[rid];   // reopening a team starts unfiltered
  S.viewTeam = (S.viewTeam === rid) ? null : rid;
  renderTeams();
  const el = document.getElementById('team_'+rid);
  if(el && S.viewTeam === rid && typeof el.scrollIntoView === 'function'){
    el.scrollIntoView({behavior:'smooth', block:'start'});
  }
}

function renderTeams(){
  const box = document.getElementById('teamsBody');
  if(!S.user){
    box.innerHTML = `<div class="empty">Add your Sleeper username in <b>Setup</b> to pull your leagues and rosters.</div>`;
    return;
  }
  if(!S.rosters.length){
    box.innerHTML = `<div class="card"><h2>${esc(S.user.display_name||'')}</h2>
      <div class="hint">${S.leagues.length} ${SEASON} league(s) found. Pick a Sleeper league from the
      dropdown at the top to load its rosters.</div></div>`;
    return;
  }
  const mine = S.rosters.find(r => r.owner_id === S.user.user_id);
  const nameOf = {}; S.lusers.forEach(u=>nameOf[u.user_id]=u.display_name||u.username);

  let html = '', myRosterHtml = '';
  if(mine){
    const roster = (mine.players||[]).map(pid=>S.bySleeper[String(pid)]).filter(Boolean)
                    .sort((a,b)=>a.overall-b.overall);
    const myPicks = picksOf(mine.roster_id);
    const pickVal = myPicks.reduce((s,p)=>s+p.value,0);
    const totalVal = roster.reduce((s,p)=>s+(p.value||0),0) + pickVal;
    const rank = leagueProfiles().findIndex(t=>t.rosterId===mine.roster_id)+1;

    html += `<div class="card">
      <h2>My Roster</h2>
      <div class="hint">${esc(S.league.name)} · ${mine.settings?`${mine.settings.wins}-${mine.settings.losses}`:''}</div>
      <div class="srcgrid" style="margin-top:10px">
        ${statBox(`${rank}<span style="font-size:13px;color:var(--faint)">/${S.rosters.length}</span>`, 'Value Rank', 'rank')}
        ${statBox(Math.round(totalVal/1000)+'k', 'Total Value', 'total')}
        ${statBox(roster.length, 'Players', 'players')}
        ${statBox(roster.filter(p=>tierOf(p)<=2).length, 'Difference-Makers', 'diff')}
        ${myPicks.length ? statBox(
            `${myPicks.filter(p=>p.round===1).length}<span style="font-size:13px;color:var(--faint)">/${myPicks.length}</span>`,
            'Future 1sts / Picks', 'picks') : ''}
      </div>
      <div class="hint" style="margin-top:8px">Tap any box to see what it means.</div>
      <div id="statInfo" data-open=""></div>
    </div>`;

    if(myPicks.length){
      html += `<div class="card" style="cursor:pointer" onclick="toggleMyPicks()">
          <div class="row"><h2 class="grow">Draft Capital · ${Math.round(pickVal/1000)}k</h2>
          <span class="small" style="color:var(--gold)">${S.showMyPicks?'▲ Hide':'▼ Show'}</span></div>
          <div class="hint">${myPicks.filter(p=>p.round===1).length} future 1st-rounders across
            ${S.pickSeasons.join(' & ')} · ${Math.round(100*pickVal/(totalVal||1))}% of everything you own.</div>
        </div>
        ${S.showMyPicks ? `<div class="plist">${myPicks.map(p=>pickRowHTML(p)).join('')}</div>` : ''}
        <div class="spacer"></div>`;
    }

    // positional strength vs league
    const posAvg = {};
    ['QB','RB','WR','TE'].forEach(pos=>{
      const mineV = roster.filter(p=>p.pos===pos).sort((a,b)=>(b.value||0)-(a.value||0))
                          .slice(0,3).reduce((s,p)=>s+(p.value||0),0);
      const all = S.rosters.map(r=>(r.players||[]).map(pid=>S.bySleeper[String(pid)]).filter(p=>p&&p.pos===pos)
                    .sort((a,b)=>(b.value||0)-(a.value||0)).slice(0,3).reduce((s,p)=>s+(p.value||0),0));
      const avg = all.reduce((a,b)=>a+b,0)/(all.length||1);
      posAvg[pos] = { mine:mineV, avg, pct: avg? Math.round(100*mineV/avg) : 100 };
    });

    // Draft capital belongs on this chart too — it's the fifth position group in
    // a dynasty league, and the one this roster is actually shortest on.
    if(S.league.dynasty && myPicks.length){
      const all = S.rosters.map(r => picksOf(r.roster_id).reduce((s,p)=>s+p.value,0));
      const avg = all.reduce((a,b)=>a+b,0)/(all.length||1);
      posAvg['PICKS'] = { mine:pickVal, avg, pct: avg ? Math.round(100*pickVal/avg) : 100, isPicks:true };
    }
    // Shown as deviation from the league average rather than "95%", which reads
    // like a score out of 100. The bar diverges from a centre line, so average
    // is the middle and you can see direction at a glance.
    html += `<div class="card"><h2>Where You Stand</h2>
      <div class="hint">Your best three at each spot, compared with what the average team in this
        league has. The centre line is average — right is surplus, left is a hole.${
        posAvg.PICKS ? ` <b>Picks</b> is all your future draft capital, not a top three.` : ''}</div>
      <div class="spacer"></div>
      ${Object.entries(posAvg).map(([pos,d])=>{
        const dev = d.pct - 100;
        const w = Math.min(50, Math.abs(dev) / 2);   // ±100% of average fills the half
        const col = dev <= -15 ? 'var(--bad)' : dev >= 15 ? 'var(--good)' : 'var(--gold)';
        const word = dev <= -15 ? 'below average' : dev >= 15 ? 'above average' : 'about average';
        return `<div style="margin-bottom:11px${d.isPicks?';padding-top:10px;border-top:1px solid var(--line)':''}">
          <div class="row small">
            <span class="grow"><b>${d.isPicks?'PICKS':pos}</b> <span class="muted">${word}${
              d.isPicks?` · ${myPicks.length} pick${myPicks.length===1?'':'s'}, ${myPicks.filter(p=>p.round===1).length} 1st${myPicks.filter(p=>p.round===1).length===1?'':'s'}`:''}</span></span>
            <span style="color:${col};font-weight:600">${dev>0?'+':''}${dev}%</span>
          </div>
          <div class="dbar">
            <i style="${dev>=0?`left:50%;width:${w}%`:`right:50%;width:${w}%`};background:${col}"></i>
            <span class="mid"></span>
          </div>
        </div>`;
      }).join('')}
      <div class="hint" style="margin-top:10px">Read it as: you have ${
        Object.entries(posAvg).map(([pos,d])=>`${Math.abs(d.pct-100)}% ${d.pct>=100?'more':'less'} ${
          d.isPicks?'draft capital':pos}`).join(', ')} than a typical team here.</div>
    </div>`;

    // Held back and appended AFTER the trade-partner finder. You already know
    // your own roster; the partner list is the part you came here to act on.
    myRosterHtml = `<div class="card" style="cursor:pointer" onclick="toggleMyRoster()">
        <div class="row"><h2 class="grow">My Roster (${roster.length})</h2>
        <span class="small" style="color:var(--gold)">${S.showMyRoster?'▲ Hide':'▼ Show'}</span></div>
      </div>
      ${S.showMyRoster ? `<div class="plist">${roster.map(p=>rowHTML(p)).join('')}</div>` : ''}
      <div class="spacer"></div>`;
  }

  /* ---------- league browser + trade-partner finder ---------- */
  const profiles = leagueProfiles();
  const meProf = profiles.find(t=>t.isMe);
  const others = profiles.filter(t=>!t.isMe);

  if(meProf){
    others.forEach(t => { t.fit = tradeFit(meProf, t); });
    others.sort((a,b)=> b.fit.score - a.fit.score || b.total - a.total);
  } else {
    others.forEach(t => { t.fit = {score:0, reasons:[], twoWay:false}; });
  }

  const sortMode = S.teamSort || 'fit';
  const list = others.slice().sort((a,b) =>
    sortMode === 'value' ? b.total - a.total : (b.fit.score - a.fit.score || b.total - a.total));

  html += `<div class="card">
    <h2>Trade Partners</h2>
    <div class="hint">Ranked by how well their roster fits yours — where one of you is deep and the
      other is thin. Tap a team to open their roster, then tap any player to price a deal.</div>
    <div class="spacer"></div>
    <div class="chips" style="padding-bottom:2px">
      <button class="chip ${sortMode==='fit'?'on':''}" onclick="setTeamSort('fit')">Best Fit</button>
      <button class="chip ${sortMode==='value'?'on':''}" onclick="setTeamSort('value')">Richest Roster</button>
    </div>
  </div>`;

  html += list.map(t => {
    const f = t.fit, lab = fitLabel(f);
    const open = S.viewTeam === t.rosterId;
    // Same convention as "Where You Stand": deviation from league average, and
    // underneath it, how they compare with YOU — which is the tradeable gap.
    const groups = FIT_POS.concat(t.PICKS != null ? ['PICKS'] : []);
    const bars = groups.map(pos => {
      const dev = t[pos] - 100;
      const gap = t[pos] - (meProf ? meProf[pos] : 100);
      const col = dev <= -15 ? 'var(--bad)' : dev >= 15 ? 'var(--good)' : 'var(--dim)';
      const isP = pos === 'PICKS';
      return `<div style="flex:1;min-width:0;text-align:center${isP?';border-left:1px solid var(--line)':''}">
        <div style="font-family:'Teko';font-size:17px;line-height:1;color:${col}">${dev>0?'+':''}${dev}%</div>
        <div style="font-size:8.5px;color:var(--faint);letter-spacing:.05em">${pos}${
          meProf ? ` <span style="color:${gap>0?'var(--good)':gap<0?'var(--bad)':'var(--faint)'}">${gap>0?'+':''}${gap} vs you</span>` : ''}</div>
        ${isP?`<div style="font-size:8px;color:var(--faint);margin-top:1px">${t.picks.length}p · ${t.firsts} 1st${t.firsts===1?'':'s'}</div>`:''}
      </div>`;
    }).join('');

    return `<div class="card" id="team_${t.rosterId}" style="padding:0;overflow:hidden">
      <div style="padding:12px;cursor:pointer" onclick="viewTeam(${t.rosterId})">
        <div class="row">
          <div class="grow" style="min-width:0">
            <div style="font-weight:600;font-size:15px">${esc(t.name)}</div>
            <div class="pmeta" style="margin-top:3px">
              <span>#${t.valueRank} by value</span><span>${Math.round(t.total/1000)}k</span>
              <span>${t.diffMakers} difference-makers</span>
              ${t.picks && t.picks.length?`<span>${t.firsts} future 1st${t.firsts===1?'':'s'}</span>`:''}
              ${t.record?`<span>${t.record}</span>`:''}
            </div>
          </div>
          <div style="text-align:right">
            <div style="font-family:'Teko';font-size:19px;line-height:1;color:${lab.c}">${lab.t}</div>
            <div style="font-size:8.5px;color:var(--faint);letter-spacing:.05em">FIT ${f.score}</div>
          </div>
        </div>
        <div class="row" style="margin-top:10px;gap:4px">${bars}</div>
        ${f.reasons.length ? `<div class="small" style="margin-top:9px;color:var(--dim);line-height:1.5">
            ${f.reasons.map(r=>`${r.dir==='sell'?'▲':'▼'} ${r.text}`).join('<br>')}
            ${f.twoWay?'<br><span style="color:var(--good)">Both sides have a reason to say yes.</span>':''}
          </div>`
        : `<div class="small muted" style="margin-top:9px">No complementary need — you're shaped alike.
            Any deal here is one of you overpaying.</div>`}
        <div class="small" style="margin-top:8px;color:var(--gold)">${open?'▲ Hide roster':'▼ Show roster'}</div>
      </div>
      ${open ? (() => {
          const cur = (S.teamPos && S.teamPos[t.rosterId]) || 'ALL';
          // Only offer positions this manager actually rosters, plus PICKS if he
          // holds any. A chip that filters to an empty list is just noise.
          const present = ['QB','RB','WR','TE','K','DST'].filter(x => t.players.some(p=>p.pos===x));
          const opts = ['ALL'].concat(present).concat((t.picks||[]).length ? ['PICKS'] : []);
          const shownPlayers = cur === 'ALL' ? t.players
                             : cur === 'PICKS' ? []
                             : t.players.filter(p => p.pos === cur);
          const shownPicks = (cur === 'ALL' || cur === 'PICKS') ? (t.picks||[]) : [];
          const chips = opts.map(o =>
            `<button class="chip ${o===cur?'on':''}" onclick="event.stopPropagation();setTeamPos(${t.rosterId},'${o}')">${o==='ALL'?'All':o}</button>`
          ).join('');
          const count = shownPlayers.length + shownPicks.length;
          return `<div style="padding:9px 10px 2px;border-top:1px solid var(--line)">
              <div class="chips" style="padding-bottom:6px">${chips}</div>
              <div class="small muted" style="padding-bottom:7px">${count} asset${count===1?'':'s'}${cur==='ALL'?'':' at '+cur}</div>
            </div>
            <div class="plist" style="border-radius:0;border-left:0;border-right:0;border-bottom:0">
              ${shownPlayers.map(p=>rowHTML(p)).join('')}
              ${shownPicks.map(p=>pickRowHTML(p)).join('')}
              ${count===0?'<div class="empty">Nothing at that position on this roster.</div>':''}
            </div>`;
        })() : ''}
    </div>`;
  }).join('');

  html += myRosterHtml;

  box.innerHTML = html;
  box.querySelectorAll('.prow').forEach(el => {
    if(el.dataset.pick) el.onclick = () => openPickSheet(el.dataset.pick);
    else el.onclick = () => openSheet(el.dataset.k);
  });
}

function openPickSheet(key){
  const p = findByKey(key); if(!p) return;
  const myRid = myRosterId();
  const isMine = p.rosterId === myRid;
  const holder = S.rosters.find(r=>r.roster_id===p.rosterId);
  const holderName = holder ? ((S.lusers.find(u=>u.user_id===holder.owner_id)||{}).display_name||'') : '';
  const allSame = (S.picks||[]).filter(x=>x.name===p.name);
  const rankAmong = allSame.length;
  document.getElementById('sheetIn').innerHTML = `
    <div class="grab"></div>
    <h2 style="font-size:26px">${esc(p.displayName || p.name)}</h2>
    <div class="muted small" style="margin-bottom:10px">
      Rookie draft pick · held by <span style="color:var(--gold)">${isMine?'you':esc(holderName)}</span>
    </div>
    <div class="srcgrid">
      <div class="srcbox"><div class="n">${p.value.toLocaleString()}</div><div class="l">Market Value</div></div>
      <div class="srcbox"><div class="n">${p.season}</div><div class="l">Season</div></div>
      <div class="srcbox"><div class="n">R${p.round}</div><div class="l">Round</div></div>
      <div class="srcbox"><div class="n">${rankAmong}</div><div class="l">In League</div></div>
    </div>
    <div class="spacer"></div>
    <div class="card" style="margin:0"><div class="small">
      Priced by the same market that prices players, so it can sit on either side of a trade honestly.
      For scale, this pick is worth about as much as the
      <b>#${(S.players.filter(x=>(x.value||0) >= p.value).length)||1}</b> most valuable player in the pool.
      <br><br>Picks are the only asset that renews every year. Trading them is borrowing against seasons
      you haven't played yet.
    </div></div>
    <div class="spacer"></div>
    <div class="row">
      <button class="btn grow ${isMine?'gold':''}" onclick="addTrade('${esc(p.key)}','give')">${isMine?'Trade it away':'+ I Give'}</button>
      <button class="btn grow ${!isMine?'gold':''}" onclick="addTrade('${esc(p.key)}','get')">${!isMine?'Acquire it':'+ I Get'}</button>
    </div>
    <div class="spacer"></div>
    <button class="btn" style="width:100%" onclick="closeSheet()">Close</button>`;
  document.getElementById('sheet').classList.add('on');
}

function setTeamSort(m){ S.teamSort = m; renderTeams(); }
function toggleMyRoster(){ S.showMyRoster = !S.showMyRoster; renderTeams(); }
function toggleMyPicks(){ S.showMyPicks = !S.showMyPicks; renderTeams(); }

/* A pick renders like a player row so it reads as the asset it is. */
function pickRowHTML(p){
  return `<div class="prow" data-pick="${esc(p.key)}">
    <div class="prk" style="font-size:15px">${p.season}<small>R${p.round}</small></div>
    <div>
      <div class="pname">${esc(p.displayName || p.name)}</div>
      <div class="pmeta">
        <span>Rookie pick</span>
        ${p.round===1?'<span class="tag t1">1ST</span>':''}
      </div>
    </div>
    <div class="pright"><div class="pval">${p.value.toLocaleString()}<small>VALUE</small></div></div>
  </div>`;
}

/* =====================================================================
   9. SETUP
   ===================================================================== */
function renderHealth(){
  document.getElementById('health').innerHTML = S.health.map(h=>`
    <div class="row small" style="padding:5px 0;border-bottom:1px solid var(--line)">
      <span class="hdot ${h.ok===true?'ok':h.ok==='warn'?'warn':''}"></span>
      <span class="grow">${esc(h.name)}</span>
      <span class="muted">${esc(h.note)}</span>
    </div>`).join('');
}

function renderMethodology(){
  const gen = S.expert && S.expert.generated ? S.expert.generated : 'unknown';
  const srcs = S.expert && S.expert.sources ? S.expert.sources.join(', ') : '—';
  document.getElementById('methodology').innerHTML = `
    <p><b>Two independent layers, deliberately.</b></p>
    <p><b>1 · Expert blend</b> — published positional rankings from ${esc(srcs)}, averaged.
    Last rebuilt <b>${esc(gen)}</b>. This layer is refreshed by a weekly automated pass, because these
    outlets have no API and have to be read.</p>
    <p><b>2 · Live market</b> — FantasyCalc, which prices every player off thousands of trades actually
    completed in real leagues each week, re-queried for your exact format. This is the crowd, not a pundit,
    and it updates continuously.</p>
    <p>A player's <b>consensus rank</b> is the average of their positional rank across every source that
    covers them. Overall board order is anchored on market value, since that is the only signal that
    compares a running back to a quarterback honestly.</p>
    <p><b>The three flags worth acting on:</b></p>
    <p><b>SPLIT</b> — the sources disagree unusually widely about this player. That is where your own read
    matters most, and where the podcast hours used to go.</p>
    <p><b>BUY LOW / HYPED</b> — the analysts and the market disagree about where he belongs. Your
    league-mates draft off the market, so a player the analysts like more than the market does tends to
    still be there later than he should be.</p>
    <p><b>RISING / FALLING</b> — 30-day movement in what real managers are actually paying in trades.</p>
    <p class="muted">Note: no free, browser-accessible source publishes true ADP, so this tool does not
    fake one. The buy-low signal is built from the analyst/market gap instead, which is measured rather
    than estimated.</p>
    <p class="muted">No projection survives contact with September. The point is not certainty — it's
    knowing where the informed opinion actually sits, and where it splits, in ninety seconds instead of
    six podcasts.</p>`;
}

function renderLeagueEditor(){
  const L = S.league || {};
  document.getElementById('leagueEditor').innerHTML = `
    <table class="mini">
      <tr><td>League</td><td>${esc(L.name||'—')}</td></tr>
      <tr><td>Teams</td><td>${L.teams||'—'}</td></tr>
      <tr><td>Format</td><td>${L.qbs===2?'Superflex':'1QB'}${L.dynasty?' · Dynasty':' · Redraft'}</td></tr>
      <tr><td>PPR</td><td>${L.ppr}</td></tr>
      <tr><td>TE premium</td><td>${L.tePremium?('+'+L.tePremium+'/rec  →  TE values ×'+S.teBump.toFixed(2)):'none'}</td></tr>
      <tr><td>Pass TD</td><td>${L.scoring?L.scoring.pass_td:'—'}</td></tr>
      <tr><td>INT</td><td>${L.scoring?L.scoring.int:'—'}</td></tr>
      <tr><td>Kicker / DST</td><td>${L.usesK?'K':'no K'} · ${L.usesDST?'DST':'no DST'}</td></tr>
      ${L.preDraft?'<tr><td style="color:var(--gold)">Status</td><td style="color:var(--gold)">Pre-draft</td></tr>':''}
      ${L.raw?'<tr><td class="muted">Source</td><td class="muted">Live from Sleeper</td></tr>':'<tr><td class="muted">Source</td><td class="muted">Manual preset</td></tr>'}
    </table>`;
}

document.getElementById('sleeperSave').onclick = async () => {
  const u = document.getElementById('sleeperUser').value.trim();
  const st = document.getElementById('sleeperStatus');
  if(!u){ st.textContent='Enter a username first.'; return; }
  st.textContent = 'Connecting…';
  LS.set('user', u);
  LS.del('cache_'+SLEEPER+'/user/'+encodeURIComponent(u));
  await loadSleeperAccount(u);
  if(S.user){
    await loadAll(false);
    st.innerHTML = `Connected as <b>${esc(S.user.display_name||u)}</b> — ${S.leagues.length} ${SEASON} league(s) found.
      Switch between them from the dropdown at the top.`;
  } else {
    st.textContent = 'No Sleeper user by that name. Check spelling (it is your username, not display name).';
  }
};

document.getElementById('hardRefresh').onclick = async () => {
  document.getElementById('health').innerHTML = '<div class="loading">Refreshing…</div>';
  await loadAll(true);
};

document.getElementById('leaguePick').onchange = async e => {
  const v = e.target.value;
  LS.set('league', v);
  // Only a real Sleeper league may be pinned. Pinning a preset would suppress
  // the snap-to-real-league on every future load and leave rosters empty.
  LS.set('leaguePinned', S.leagues.some(l => l.id === v));
  document.getElementById('boardList').innerHTML = '<div class="loading">Re-pricing for this league…</div>';
  await loadAll(false);
};

document.getElementById('boardSearch').oninput = () => renderBoard();
document.getElementById('sortChips').querySelectorAll('.chip').forEach(b=>{
  b.onclick = () => {
    S.sort = b.dataset.sort;
    document.getElementById('sortChips').querySelectorAll('.chip').forEach(x=>x.classList.remove('on'));
    b.classList.add('on');
    renderBoard();
  };
});

/* =====================================================================
   10. TABS + BOOT
   ===================================================================== */
function showTab(v){
  document.querySelectorAll('.view').forEach(s=>s.classList.remove('on'));
  document.getElementById('v-'+v).classList.add('on');
  document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.toggle('on', b.dataset.v===v));
  window.scrollTo(0,0);
}
document.querySelectorAll('nav.tabs button').forEach(b=>b.onclick=()=>showTab(b.dataset.v));

(async function boot(){
  S.drafted = new Set(LS.get('drafted', []));
  // Pre-seeded so the tool works on first open with no setup.
  if(LS.get('user','') === '') LS.set('user', 'bobbykelly');
  document.getElementById('sleeperUser').value = LS.get('user','');
  renderLeaguePicker();
  await loadAll(false);
  // If the active league hasn't drafted yet, Sleeper already told us its draft
  // id — no need to go hunting for the URL.
  const dEl = document.getElementById('draftId');
  dEl.value = LS.get('draftId','') || (S.league && S.league.draftId) || '';
})();
