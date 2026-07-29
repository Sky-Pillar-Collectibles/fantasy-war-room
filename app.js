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
  if(!L || !L.raw){ S.rosters = []; S.lusers = []; return; }
  const [ros, usr] = await Promise.all([
    getJSON(`${SLEEPER}/league/${L.id}/rosters`, 'League Rosters', 15),
    getJSON(`${SLEEPER}/league/${L.id}/users`, 'League Managers', 60*24)
  ]);
  S.rosters = ros || []; S.lusers = usr || [];
}

async function loadSleeperPlayers(){
  const slim = LS.get('slimPlayers', null);
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
      map[id] = { n: p.full_name || ((p.first_name||'')+' '+(p.last_name||'')).trim(),
                  p: p.position === 'DEF' ? 'DST' : p.position,
                  t: fixTeam(p.team || ''),
                  b: p.bye_week || null,
                  i: p.injury_status || null,
                  a: p.age || null,
                  e: p.years_exp };
    }
    S.sleeperMap = map;
    LS.set('slimPlayers', {t:Date.now(), d:map});
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

  // ---- expert blend (positional ranks from 4 published sources) ----
  const SRC = {si:'SI', nbc:'NBC', br:'B/R', espn:'ESPN'};
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
    }
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
             p.mine = uid && r.owner_id === uid; }
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
  renderMethodology(); renderLeagueEditor();
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

  return `<div class="prow ${gone?'gone':''}" data-k="${esc(p.key)}">
    <div class="prk">${primary}<small>${opts.rankField==='pos'?'POS':'OVR'}</small></div>
    <div>
      <div class="pname">${esc(p.name)}</div>
      <div class="pmeta">
        <span>${esc(p.pos)}${p.posRank?('#'+p.posRank):''}</span>
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
const findByKey = k => S.players.find(p=>p.key===k);

/* ---------- detail sheet ---------- */
function openSheet(key){
  const p = findByKey(key); if(!p) return;
  const t = tierOf(p);
  const srcs = Object.entries(p.srcRanks);
  const el = document.getElementById('sheetIn');
  el.innerHTML = `
    <div class="grab"></div>
    <h2 style="font-size:26px">${esc(p.name)}</h2>
    <div class="muted small" style="margin-bottom:10px">
      ${esc(p.pos)}${p.posRank?' #'+p.posRank:''} · ${esc(p.team||'FA')}${p.bye?' · Bye '+p.bye:''}${p.age?' · Age '+p.age:''}
      ${p.owner?` · <span style="color:var(--gold)">${esc(p.owner)}</span>`:''}
    </div>
    <div class="srcgrid">
      <div class="srcbox"><div class="n">${p.overall}</div><div class="l">Overall</div></div>
      <div class="srcbox"><div class="n">${p.value!=null?p.value.toLocaleString():'—'}</div><div class="l">Mkt Value</div></div>
      <div class="srcbox"><div class="n" style="color:${p.trend>0?'var(--good)':p.trend<0?'var(--bad)':'var(--chalk)'}">${p.trend!=null?(p.trend>0?'+':'')+p.trend:'—'}</div><div class="l">30d Trend</div></div>
      <div class="srcbox"><div class="n" style="color:var(--t${t})">T${t}</div><div class="l">${tierLabel(t)}</div></div>
    </div>

    <div class="spacer"></div>
    <h3 class="disp" style="font-size:17px;text-transform:uppercase">Where the sources land</h3>
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

    ${p.rostered!=null?`<div class="small muted" style="margin-top:8px">Rostered in ${(p.rostered).toFixed(0)}% of leagues</div>`:''}

    <div class="spacer"></div>
    <div class="row">
      <button class="btn grow" onclick="addTrade('${esc(p.key)}','give')">+ I Give</button>
      <button class="btn grow" onclick="addTrade('${esc(p.key)}','get')">+ I Get</button>
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

function renderTrade(){
  const paint = (arr, side, elId) => {
    document.getElementById(elId).innerHTML = arr.length ? arr.map(k=>{
      const p = findByKey(k); if(!p) return '';
      return `<div class="tpill"><span>${esc(p.name)} <span class="muted">${esc(p.pos)}</span></span>
        <span><b>${p.value!=null?p.value.toLocaleString():'—'}</b>
        <button onclick="removeTrade('${esc(k)}','${side}')">×</button></span></div>`;
    }).join('') : '<div class="muted small">Nothing yet.</div>';
  };
  paint(S.give,'give','giveList'); paint(S.get,'get','getList');

  const g = packageValue(S.give), r = packageValue(S.get);
  const el = document.getElementById('tradeVerdict');
  if(!S.give.length || !S.get.length){ el.innerHTML=''; return; }

  const diff = r.adjusted - g.adjusted;
  const pct = g.adjusted ? (diff / g.adjusted * 100) : 0;
  const cls = Math.abs(pct) < 8 ? 'even' : (diff > 0 ? 'win' : 'lose');
  const word = Math.abs(pct) < 8 ? 'Fair Deal' : (diff > 0 ? 'You Win' : 'You Lose');

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
    <div class="small muted" style="margin-top:8px">Configured for ${S.league.teams}-team ${S.league.qbs===2?'superflex':'1QB'}${S.league.dynasty?' dynasty':''}.</div>
  </div>`;
}
document.getElementById('tradeClear').onclick = () => { S.give=[]; S.get=[]; renderTrade(); };

document.getElementById('tradeSearch').oninput = e => {
  const q = e.target.value.trim();
  const box = document.getElementById('tradeResults');
  if(q.length < 2){ box.innerHTML=''; return; }
  const hits = filtered('ALL', q).slice(0,8);
  box.innerHTML = hits.length ? `<div class="plist" style="margin-top:8px">${hits.map(p=>`
    <div class="prow">
      <div class="prk">${p.overall}<small>OVR</small></div>
      <div><div class="pname">${esc(p.name)}</div>
        <div class="pmeta"><span>${esc(p.pos)} · ${esc(p.team||'FA')}</span><span>${p.value!=null?p.value.toLocaleString():'—'}</span></div></div>
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
    body:`The market value of everyone you own, added up, shown in thousands. The units are arbitrary
      — the number only means something next to the other teams in this league.
      <br><br>Its real use is trade math: it's the same currency the Trade tab prices packages in,
      so you can see what a deal does to your overall holdings. On its own, ignore it.` },
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

  let html = '';
  if(mine){
    const roster = (mine.players||[]).map(pid=>S.bySleeper[String(pid)]).filter(Boolean)
                    .sort((a,b)=>a.overall-b.overall);
    const starters = (mine.starters||[]).map(pid=>S.bySleeper[String(pid)]).filter(Boolean);
    const totalVal = roster.reduce((s,p)=>s+(p.value||0),0);
    const rank = [...S.rosters].map(r=>({
      id:r.roster_id,
      v:(r.players||[]).reduce((s,pid)=>{const p=S.bySleeper[String(pid)];return s+(p&&p.value?p.value:0)},0)
    })).sort((a,b)=>b.v-a.v).findIndex(x=>x.id===mine.roster_id)+1;

    html += `<div class="card">
      <h2>My Roster</h2>
      <div class="hint">${esc(S.league.name)} · ${mine.settings?`${mine.settings.wins}-${mine.settings.losses}`:''}</div>
      <div class="srcgrid" style="margin-top:10px">
        ${statBox(`${rank}<span style="font-size:13px;color:var(--faint)">/${S.rosters.length}</span>`, 'Value Rank', 'rank')}
        ${statBox(Math.round(totalVal/1000)+'k', 'Total Value', 'total')}
        ${statBox(roster.length, 'Players', 'players')}
        ${statBox(roster.filter(p=>tierOf(p)<=2).length, 'Difference-Makers', 'diff')}
      </div>
      <div class="hint" style="margin-top:8px">Tap any box to see what it means.</div>
      <div id="statInfo" data-open=""></div>
    </div>`;

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
    html += `<div class="card"><h2>Where You Stand</h2>
      <div class="hint">Your top 3 at each spot vs. the league average. Under 100 is a hole to fill.</div>
      <div class="spacer"></div>
      ${Object.entries(posAvg).map(([pos,d])=>`
        <div style="margin-bottom:9px">
          <div class="row small"><span class="grow"><b>${pos}</b></span>
          <span style="color:${d.pct<85?'var(--bad)':d.pct>115?'var(--good)':'var(--dim)'}">${d.pct}%</span></div>
          <div class="bar"><i style="width:${Math.min(100,d.pct/2)}%;background:${d.pct<85?'var(--bad)':d.pct>115?'var(--good)':'var(--gold)'}"></i></div>
        </div>`).join('')}
    </div>`;

    html += `<div class="card"><h2>Roster</h2></div>
      <div class="plist">${roster.map(p=>rowHTML(p)).join('')}</div><div class="spacer"></div>`;
  }

  html += `<div class="card"><h2>League Value Board</h2>
    <table class="mini">${[...S.rosters].map(r=>({
      n: nameOf[r.owner_id]||('Team '+r.roster_id),
      me: r.owner_id===(S.user&&S.user.user_id),
      v: (r.players||[]).reduce((s,pid)=>{const p=S.bySleeper[String(pid)];return s+(p&&p.value?p.value:0)},0)
    })).sort((a,b)=>b.v-a.v).map((t,i)=>`<tr><td>${i+1}. ${esc(t.n)}${t.me?' <span class="tag mine">YOU</span>':''}</td>
      <td>${Math.round(t.v/1000)}k</td></tr>`).join('')}</table></div>`;

  box.innerHTML = html;
  const pl = box.querySelector('.plist');
  if(pl) pl.querySelectorAll('.prow').forEach(el=>el.onclick=()=>openSheet(el.dataset.k));
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
  LS.set('league', e.target.value);
  LS.set('leaguePinned', true);
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
