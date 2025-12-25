let allRows = [];
let sortState = { key: 'market_cap_rank', dir: 1 }; // 1 asc, -1 desc

function qs(sel){ return document.querySelector(sel) }
function qsa(sel){ return Array.from(document.querySelectorAll(sel)) }

function showToast(text, error=false){
  const t = qs('#toast');
  t.textContent = text;
  t.className = 'toast ' + (error ? 'error' : 'ok');
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 3200);
}
function setLoading(v){ qs('#loader').classList.toggle('hidden', !v); }

function csvHref(vs, perPage){
  const url = new URL('/cg/top.csv', window.location.origin);
  url.searchParams.set('vs', vs);
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', '1');
  return url.toString();
}

function cmp(a,b){
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function fmtNum(v, digits=2){
  if (v === null || v === undefined || isNaN(v)) return '—';
  return Number(v).toFixed(digits);
}
function fmtBig(v){
  if (v === null || v === undefined || isNaN(v)) return '—';
  const n = Number(v);
  if (n >= 1e12) return (n/1e12).toFixed(2) + 'T';
  if (n >= 1e9) return (n/1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n/1e6).toFixed(2) + 'M';
  return n.toFixed(0);
}

function renderTable(rows){
  const tbody = qs('#coins-table tbody');
  tbody.innerHTML = '';
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="num">${r.market_cap_rank ?? '—'}</td>
      <td class="code">${r.id}</td>
      <td class="code">${(r.symbol || '').toUpperCase()}</td>
      <td class="num">${fmtNum(r.current_price, 6)}</td>
      <td class="num">${fmtBig(r.market_cap)}</td>
      <td class="name">${r.name}</td>
    `;
    tbody.appendChild(tr);
  });
  qs('#count-label').textContent = `Показано: ${rows.length}`;
}

function applyFilterSort(){
  const f = qs('#filter').value.trim().toLowerCase();
  let rows = allRows.filter(r =>
    !f ||
    (r.id || '').toLowerCase().includes(f) ||
    (r.name || '').toLowerCase().includes(f) ||
    (r.symbol || '').toLowerCase().includes(f)
  );

  rows.sort((x, y) => sortState.dir * cmp(x[sortState.key], y[sortState.key]));
  renderTable(rows);
}

async function loadTop(){
  const vs = (qs('#vs').value || 'usd').trim().toLowerCase();
  const perPage = Math.max(1, Math.min(250, parseInt(qs('#per-page').value || '50')));
  qs('#per-page').value = perPage;

  setLoading(true);
  try{
    const resp = await fetch(`/cg/top?vs=${encodeURIComponent(vs)}&per_page=${perPage}&page=1`);
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    allRows = (data.items || []).map(x => ({
      market_cap_rank: x.market_cap_rank,
      id: x.id,
      symbol: x.symbol,
      name: x.name,
      current_price: x.current_price,
      market_cap: x.market_cap,
      price_change_percentage_24h: x.price_change_percentage_24h
    }));

    qs('#btn-export').setAttribute('href', csvHref(vs, perPage));
    qs('#hint').textContent = data.cached ? 'кэш (меньше запросов)' : '';
    applyFilterSort();
  }catch(e){
    renderTable([]);
    showToast('Ошибка: ' + e.message, true);
  }finally{
    setLoading(false);
  }
}

async function doConvert(){
  const coinId = (qs('#coin-id').value || '').trim().toLowerCase();
  const vs = (qs('#vs-conv').value || 'usd').trim().toLowerCase();
  const amount = qs('#amount').value || '1';

  if (!coinId){
    showToast('Укажи coin_id (например: bitcoin)', true);
    return;
  }

  try{
    const url = new URL('/cg/convert', window.location.origin);
    url.searchParams.set('coin_id', coinId);
    url.searchParams.set('vs', vs);
    url.searchParams.set('amount', amount);

    const resp = await fetch(url.toString());
    const data = await resp.json();
    if (data.error) throw new Error(data.error);

    const rateStr = (data.rate != null) ? Number(data.rate).toFixed(8) : '—';
    const resStr  = (data.result != null) ? Number(data.result).toFixed(8) : '—';
    const box = qs('#conv-result');
    box.className = 'result ok grow';
    box.textContent = `${amount} ${data.coin_id} = ${resStr} ${data.vs} (курс: ${rateStr})` + (data.cached ? ' · кэш' : '');
  }catch(e){
    const box = qs('#conv-result');
    box.className = 'result error grow';
    box.textContent = 'Ошибка: ' + e.message;
  }
}

function debounce(fn, ms=250){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms) } }

function toggleTheme(){
  document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme-dark', document.documentElement.classList.contains('dark') ? '1':'0');
}

/* ===== Chart (vanilla canvas) ===== */

function drawLineChart(canvas, points, label){
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);

  canvas.__pts = [];
  canvas.__lastPoints = points;

  if (!points.length) return;

  const pad = {l:60, r:20, t:20, b:40};
  const xs = points.map(p => new Date(p.date).getTime());
  const ys = points.map(p => p.price);

  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const x2px = x => pad.l + (W - pad.l - pad.r) * ((x - minX) / (maxX - minX || 1));
  const y2px = y => H - pad.b - (H - pad.t - pad.b) * ((y - minY) / (maxY - minY || 1));

  const styles = getComputedStyle(document.documentElement);
  const gridColor = 'rgba(148,163,184,0.35)';
  const textColor = styles.getPropertyValue('--muted').trim() || '#64748b';
  const lineColor = styles.getPropertyValue('--primary').trim() || '#2563eb';

  ctx.fillStyle = textColor;
  ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto';

  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;

  for (let i=0;i<=5;i++){
    const yy = minY + (maxY - minY) * i/5;
    const y = y2px(yy);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
    ctx.fillText(yy.toFixed(6), 6, y-2);
  }
  for (let i=0;i<=5;i++){
    const xx = minX + (maxX - minX) * i/5;
    const d = new Date(xx);
    const label = d.toISOString().slice(0,10);
    const x = x2px(xx);
    ctx.save(); ctx.translate(x, H - pad.b + 14); ctx.rotate(-Math.PI/6); ctx.fillText(label, 0, 0); ctx.restore();
  }

  ctx.strokeStyle = '#94a3b8';
  ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b); ctx.stroke();

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p,i)=>{
    const x = x2px(new Date(p.date).getTime());
    const y = y2px(p.price);
    if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();

  canvas.__pts = points.map(p => {
    const t = new Date(p.date).getTime();
    return { date: p.date, value: p.price, x: x2px(t), y: y2px(p.price) };
  });

  // title
  ctx.fillStyle = textColor;
  ctx.fillText(label || '', pad.l, 14);
}

function ensureTooltip(canvas){
  return document.getElementById('chart-tooltip');
}

function attachChartHover(canvas, vs){
  if (canvas.__hoverBound) return;
  canvas.__hoverBound = true;
  const tip = ensureTooltip(canvas);
  const wrap = canvas.parentElement;

  function redrawMarker(pt){
    if (canvas.__lastPoints) drawLineChart(canvas, canvas.__lastPoints, canvas.__label);
    if (!pt) return;

    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = 'rgba(148,163,184,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pt.x, 20);
    ctx.lineTo(pt.x, canvas.height - 40);
    ctx.stroke();

    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#2563eb';
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI*2); ctx.fill();
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI*2); ctx.stroke();
  }

  function onMove(e){
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top) * scaleY;

    const pts = canvas.__pts || [];
    if (!pts.length){ tip.style.display='none'; redrawMarker(null); return; }

    let best = null, bestD2 = Infinity;
    for (const p of pts){
      const dx = p.x - cx, dy = p.y - cy;
      const d2 = dx*dx + dy*dy;
      if (d2 < bestD2){ bestD2 = d2; best = p; }
    }
    const threshold = 14;
    if (Math.sqrt(bestD2) > threshold){ tip.style.display='none'; redrawMarker(null); return; }

    tip.innerHTML = `${best.date}<br><b>${Number(best.value).toFixed(8)}</b> ${vs}`;
    tip.style.display = 'block';

    const wrapRect = wrap.getBoundingClientRect();
    let tx = e.clientX - wrapRect.left + 10;
    let ty = e.clientY - wrapRect.top + 10;
    const maxX = wrapRect.width - tip.offsetWidth - 6;
    const maxY = wrapRect.height - tip.offsetHeight - 6;
    tip.style.left = Math.max(6, Math.min(tx, maxX)) + 'px';
    tip.style.top  = Math.max(6, Math.min(ty, maxY)) + 'px';

    redrawMarker(best);
  }

  function onLeave(){ tip.style.display='none'; redrawMarker(null); }

  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);
}

async function buildHistory(){
  const coin = (qs('#hist-coin').value || '').trim().toLowerCase();
  const vs = (qs('#hist-vs').value || 'usd').trim().toLowerCase();
  const from = qs('#hist-from').value;
  const to = qs('#hist-to').value;

  if (!coin){ showToast('Укажи coin_id (например: bitcoin)', true); return; }
  if (!from || !to){ showToast('Укажи обе даты периода', true); return; }

  try{
    const url = new URL('/cg/history', window.location.origin);
    url.searchParams.set('coin_id', coin);
    url.searchParams.set('vs', vs);
    url.searchParams.set('date_from', from);
    url.searchParams.set('date_to', to);

    const r = await fetch(url.toString());
    const data = await r.json();
    if (data.error) throw new Error(data.error);

    const points = data.points || [];
    const canvas = qs('#chart');
    canvas.__label = `${coin} / ${vs}` + (data.cached ? ' · кэш' : '');
    drawLineChart(canvas, points, canvas.__label);

    qs('#chart-empty').style.display = points.length ? 'none' : 'block';
    attachChartHover(canvas, vs);
  }catch(e){
    showToast('Ошибка: ' + e.message, true);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  qs('#btn-load').addEventListener('click', loadTop);
  qs('#btn-convert').addEventListener('click', doConvert);
  qs('#filter').addEventListener('input', debounce(applyFilterSort, 150));
  qs('#toggle-theme').addEventListener('click', toggleTheme);
  qs('#btn-history').addEventListener('click', buildHistory);

  qsa('#coins-table th').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (sortState.key === key) sortState.dir *= -1;
      else { sortState.key = key; sortState.dir = 1; }
      applyFilterSort();
      qsa('#coins-table th').forEach(x => x.classList.remove('sorted-asc','sorted-desc'));
      th.classList.add(sortState.dir === 1 ? 'sorted-asc' : 'sorted-desc');
    });
  });

  if (localStorage.getItem('theme-dark') === '1') document.documentElement.classList.add('dark');

  // set default history period (last 30 days)
  const today = new Date();
  const to = today.toISOString().slice(0,10);
  const fromD = new Date(today.getTime() - 29*24*3600*1000);
  const from = fromD.toISOString().slice(0,10);
  qs('#hist-from').value = from;
  qs('#hist-to').value = to;

  loadTop();
});
