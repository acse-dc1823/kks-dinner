import { compute, parseEuros } from './ledger.js?v=5';
import * as S from './store.js?v=5';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (cents) =>
  new Intl.NumberFormat('en-IE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: cents % 100 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(Math.abs(cents) / 100);
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  del: (k) => { try { localStorage.removeItem(k); } catch {} },
};

const st = {
  key: null,
  token: null,
  data: null,
  busy: false,
  editingPot: false,
  confirm: null, // id of the item waiting for a second click
  me: store.get('kks.me') || '',
  showSetup: false,
};

// ---------- login ----------

async function tryRemembered() {
  const saved = store.get('kks.key');
  if (!saved) return false;
  try {
    const key = await S.importKey(saved);
    await S.unseal(key, S.CONF.check);
    await start(key);
    return true;
  } catch {
    store.del('kks.key');
    return false;
  }
}

$('#login').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#login button');
  const err = $('#login-error');
  err.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Unlocking…';
  try {
    const key = await S.deriveKey($('#pw').value);
    try {
      await S.unseal(key, S.CONF.check);
    } catch {
      throw new Error('Wrong password');
    }
    if ($('#remember').checked) store.set('kks.key', await S.exportKey(key));
    await start(key);
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
});

async function loadToken(key) {
  try {
    const res = await fetch('config.enc.json', { cache: 'no-store' });
    if (!res.ok) return null;
    return (await S.unseal(key, await res.json())).token;
  } catch {
    return null;
  }
}

async function start(key) {
  st.key = key;
  st.token = await loadToken(key);
  await refresh();
  $('#gate').hidden = true;
  $('#app').hidden = false;
  const every = st.token ? 30_000 : 300_000; // unauthenticated reads are rate-limited
  setInterval(() => document.visibilityState === 'visible' && refresh(), every);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh());
}

async function refresh() {
  if (st.busy) return;
  try {
    const { data } = await S.loadData(st.key, st.token);
    st.data = data;
    setStatus(st.token ? 'Synced' : 'Read-only', st.token ? 'ok' : 'warn');
  } catch (e) {
    setStatus(e.status === 403 ? 'Rate-limited, retrying' : 'Offline', 'bad');
  }
  render();
}

function setStatus(text, kind) {
  const el = $('#status');
  if (!el) return;
  el.textContent = text;
  el.dataset.kind = kind;
}

async function save(fn, okText = 'Saved') {
  if (!st.token) return;
  st.busy = true;
  setStatus('Saving…', 'busy');
  document.body.classList.add('saving');
  try {
    const { data } = await S.mutate(st.key, st.token, fn);
    st.data = data;
    setStatus(okText, 'ok');
  } catch (e) {
    const auth = e.status === 401 || e.status === 403;
    setStatus(auth ? 'Token expired, set it up again' : 'Save failed, try again', 'bad');
    if (auth) st.showSetup = true;
  } finally {
    st.busy = false;
    st.confirm = null;
    document.body.classList.remove('saving');
    render();
  }
}

// ---------- rendering ----------

function render() {
  if (!st.data) return;
  const d = st.data;
  const c = compute(d);
  const name = Object.fromEntries(d.people.map((p) => [p.id, p.name]));
  const holderName = name[d.holder];
  const ro = !st.token;
  const disabled = ro ? 'disabled' : '';

  // header
  const meSel = $('#me');
  meSel.innerHTML =
    `<option value="">someone</option>` +
    d.people.map((p) => `<option value="${p.id}" ${p.id === st.me ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

  const left = c.totalFine - c.totalSpent;
  const each = money(Math.round(Math.abs(c.adjust) / d.people.length)); // equal share of the gap
  const pct = c.totalFine ? Math.min(100, (c.totalSpent / c.totalFine) * 100) : 0;
  $('#stats').innerHTML = `
    <div class="tile"><span>Pot</span><b>${money(c.totalFine)}</b><small>${d.people.length} people's fines</small></div>
    <div class="tile"><span>Spent</span><b>${money(c.totalSpent)}</b><small>${d.expenses.length} purchase${d.expenses.length === 1 ? '' : 's'}</small></div>
    <div class="tile ${left < 0 ? 'neg' : 'accent'}"><span>${left < 0 ? 'Over by' : c.final ? (left ? 'Unspent' : 'Spot on') : 'Left'}</span><b>${money(left)}</b><small>${
      left < 0 ? `${each} more each` : c.final ? (left ? `${each} less each` : 'cost = pot') : 'still to spend'
    }</small></div>
    <div class="bar" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>`;

  $('#readonly').hidden = !ro || st.showSetup;
  $('#setup').hidden = !st.showSetup;

  // 1. pot
  const potRows = c.rows
    .map((r) => {
      const bits = [];
      if (r.paidIn) bits.push(`${money(r.paidIn)} ${r.isHolder ? 'in the pot' : `paid to ${esc(holderName)}`}`);
      if (r.spent) bits.push(`${money(r.spent)} on food`);
      if (r.share) bits.push(r.share > 0 ? `+${money(r.share)} extra cost` : `−${money(r.share)} unspent pot`);
      if (!r.isHolder && r.sent) bits.push(`${money(r.sent)} settled`);
      let owes = `<span class="pill ok">✓</span>`;
      if (r.owes) owes = `<span class="amt owe">${money(r.owes)}</span>`;
      else if (r.credit && !r.isHolder) owes = `<span class="amt get">+${money(r.credit)} back</span>`;
      if (st.editingPot) {
        return `<tr data-id="${r.id}">
          <td>${esc(r.name)}${r.isHolder ? ' <span class="tag">holds cash</span>' : ''}</td>
          <td><input class="num" name="fine" inputmode="decimal" value="${r.fine / 100}" aria-label="Fine for ${esc(r.name)}"></td>
          <td><input class="num" name="paidIn" inputmode="decimal" value="${r.paidIn / 100}" aria-label="Cash paid in by ${esc(r.name)}"></td>
        </tr>`;
      }
      return `<tr class="${r.id === st.me ? 'me' : ''}">
        <td><div class="who">${esc(r.name)}${r.isHolder ? ' <span class="tag">holds cash</span>' : ''}</div>${bits.length ? `<div class="sub">${bits.join(' · ')}</div>` : ''}</td>
        <td class="num">${money(r.fine)}</td>
        <td class="num">${owes}</td>
      </tr>`;
    })
    .join('');
  $('#pot').innerHTML = `
    <table class="grid">
      <thead><tr><th>Who</th><th class="num">Fine</th><th class="num">${st.editingPot ? `Paid to ${esc(holderName)}` : 'Owes'}</th></tr></thead>
      <tbody>${potRows}</tbody>
      ${st.editingPot ? '' : `<tfoot><tr><td>Total</td><td class="num">${money(c.totalFine)}</td><td class="num">${money(c.totalOwed)}</td></tr></tfoot>`}
    </table>
    <div class="row-actions">
      ${st.editingPot
        ? `<button class="btn" data-act="pot-save" ${disabled}>Save</button><button class="btn ghost" data-act="pot-cancel">Cancel</button>`
        : `<button class="btn ghost small" data-act="pot-edit" ${disabled}>Edit fines</button>`}
    </div>`;

  // 2. shopping
  const opts = (sel) =>
    d.people.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const exps = [...d.expenses].sort((a, b) => b.at.localeCompare(a.at));
  $('#shop-by').innerHTML = `<option value="" disabled ${st.me ? '' : 'selected'}>Who paid?</option>` + opts(st.me);
  $('#shop-form').querySelectorAll('input,select,button').forEach((el) => (el.disabled = ro));
  $('#shop-list').innerHTML = exps.length
    ? exps
        .map(
          (e) => `<li>
          <div><div class="what">${esc(e.what)}</div><div class="sub">${esc(name[e.by] || '?')} · ${day(e.at)}</div></div>
          <span class="amt">${money(e.amount)}</span>
          <button class="x ${st.confirm === e.id ? 'sure' : ''}" data-act="exp-del" data-id="${e.id}" ${disabled} aria-label="Delete">${st.confirm === e.id ? 'Delete?' : '×'}</button>
        </li>`,
        )
        .join('')
    : `<li class="empty">Nothing bought yet. Add the first item above.</li>`;
  $('#shop-total').innerHTML = `${money(c.totalSpent)} spent · <b>${money(left)} ${left < 0 ? 'over' : c.final ? 'unspent' : 'left'}</b> of ${money(c.totalFine)}`;
  const doneBtn = $('#done-btn');
  doneBtn.disabled = ro;
  doneBtn.classList.toggle('sure', st.confirm === 'done');
  doneBtn.textContent =
    st.confirm === 'done' ? 'Tap again to confirm' : d.done ? 'Reopen shopping' : 'Shopping done → final split';
  $('#done-hint').textContent = d.done
    ? 'Shopping is closed: section 3 shows the final transfers.'
    : 'When all the food is bought, close shopping to get the final transfers.';

  // 3. settle up
  $('#settle-lead').textContent = c.final
    ? 'Final transfers. After these, everyone has paid exactly their share. Tap “Mark paid” once the money is sent.'
    : 'Who pays back the people who bought food. Tap “Mark paid” once the money is sent.';

  const tr = c.transfers;
  $('#transfers').innerHTML = tr.length
    ? tr
        .map(
          (t) => `<li class="${t.from === st.me || t.to === st.me ? 'me' : ''}">
          <div class="flow"><b>${esc(name[t.from])}</b><span class="arrow">pays</span><b>${esc(name[t.to])}</b></div>
          <span class="amt">${money(t.amount)}</span>
          <button class="btn small" data-act="pay" data-from="${t.from}" data-to="${t.to}" data-amount="${t.amount}" ${disabled}>Mark paid</button>
        </li>`,
        )
        .join('')
    : `<li class="empty">Nobody needs paying back yet.</li>`;

  const notes = [];
  const h = c.rows.find((r) => r.isHolder);
  const H = esc(holderName);
  if (c.final) {
    notes.push(
      c.adjust < 0
        ? `The dinner cost ${money(c.totalSpent)}, ${money(c.adjust)} under the ${money(c.totalFine)} pot, so everyone pays ${each} less than their fine.`
        : c.adjust > 0
          ? `The dinner cost ${money(c.totalSpent)}, ${money(c.adjust)} over the ${money(c.totalFine)} pot, so everyone pays ${each} more than their fine.`
          : `The dinner cost exactly the pot, so everyone pays exactly their fine.`,
    );
    const out = tr.filter((t) => t.from === h?.id).reduce((s, t) => s + t.amount, 0);
    if (h && h.cashNow)
      notes.push(
        out < h.cashNow
          ? `${H} holds ${money(h.cashNow)} of pot cash. He keeps ${money(h.cashNow - out)}, which he is owed himself (${[
              h.spent ? 'the food he bought' : '',
              c.adjust < 0 ? 'his share of the unspent pot' : '',
            ].filter(Boolean).join(' and ') || 'his own money back'})${out ? `, and hands out ${money(out)}` : ''}.`
          : `${H} hands out the ${money(h.cashNow)} pot cash he holds${out > h.cashNow ? `, plus ${money(out - h.cashNow)} of his own` : ''}.`,
      );
    if (c.adjust % (100 * d.people.length))
      notes.push(`The amounts have cents because ${money(c.adjust)} split between ${d.people.length} is ${each} each.`);
  } else {
    if (h && h.cashNow) {
      const avail = Math.max(0, -h.net); // pot cash left once he has paid himself back
      const keep = Math.max(0, h.cashNow - avail);
      const kept = keep ? ` (${money(h.cashNow)} held, minus ${money(keep)} he keeps for the food he bought)` : '';
      notes.push(
        tr.length
          ? `${H} pays first, from the ${money(avail)} pot cash he has${kept}. After that, whoever still owes the most pays.`
          : `Nothing to pay yet. When someone buys food, ${H}'s ${money(avail)} pot cash${kept} pays them back first.`,
      );
    }
    if (c.overspend)
      notes.push(`Food is already ${money(c.overspend)} over the pot. The extra is split equally (${each} each) and is already included.`);
    notes.push(`Once all the food is bought, press “Shopping done” in section 2. If the dinner cost less than the pot, everyone then pays the same amount less.`);
    if (h && h.owes)
      notes.push(`${H}'s own ${money(h.owes)} needs no transfer: he just adds it to the pot, then updates it in “Edit fines”.`);
  }
  $('#settle-notes').innerHTML = notes.map((n) => `<p>${n}</p>`).join('');

  // Holder with cash shows what he holds; everyone else what they are owed / still owe.
  const shown = c.rows.map((r) => {
    // pot cash he can still hand out = cash held minus what he is owed himself (e.g. his own food)
    if (r.isHolder && r.net <= 0 && !c.final) return { r, v: -r.net, cls: 'hold', label: `${money(r.net)} pot cash` };
    if (r.isHolder && r.net < 0) return { r, v: r.net, cls: 'hold', label: `hands out ${money(r.net)}` };
    if (r.net > 0) return { r, v: r.net, cls: 'get', label: `is owed ${money(r.net)}` };
    if (r.net < 0) return { r, v: r.net, cls: 'owe', label: `owes ${money(r.net)}` };
    return { r, v: 0, cls: '', label: 'square' };
  });
  const maxAbs = Math.max(1, ...shown.map((s) => Math.abs(s.v)));
  $('#balances').innerHTML = shown
    .map(({ r, v, cls, label }) => {
      const w = (Math.abs(v) / maxAbs) * 50;
      const side = v >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
      return `<li class="${r.id === st.me ? 'me' : ''}">
        <span class="who">${esc(r.name)}</span>
        <span class="track"><i class="${cls}" style="${side}"></i></span>
        <span class="amt ${cls}">${label}</span>
      </li>`;
    })
    .join('');

  const pays = [...d.payments].sort((a, b) => b.at.localeCompare(a.at));
  $('#payments').innerHTML = pays.length
    ? pays
        .map(
          (p) => `<li>
          <div><div class="what">${esc(name[p.from])} → ${esc(name[p.to])}</div><div class="sub">${day(p.at)}</div></div>
          <span class="amt">${money(p.amount)}</span>
          <button class="x ${st.confirm === p.id ? 'sure' : ''}" data-act="pay-del" data-id="${p.id}" ${disabled} aria-label="Undo">${st.confirm === p.id ? 'Undo?' : '×'}</button>
        </li>`,
        )
        .join('')
    : `<li class="empty">No payments recorded yet.</li>`;
  $('#pay-from').innerHTML = opts(st.me);
  $('#pay-to').innerHTML = opts(d.holder);
  $('#pay-form').querySelectorAll('input,select,button').forEach((el) => (el.disabled = ro));
}

// ---------- actions ----------

let confirmTimer;
function askConfirm(id) {
  if (st.confirm === id) return true;
  st.confirm = id;
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => ((st.confirm = null), render()), 3000);
  render();
  return false;
}

const parseMaybeZero = (s) => (/^\s*0*([.,]0*)?\s*$/.test(s) ? 0 : parseEuros(s));

document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-act]');
  if (!b || b.disabled || st.busy) return;
  const act = b.dataset.act;
  if (act === 'pot-edit') return ((st.editingPot = true), render());
  if (act === 'pot-cancel') return ((st.editingPot = false), render());
  if (act === 'pot-save') {
    const edits = {};
    for (const tr of document.querySelectorAll('#pot tbody tr')) {
      const fine = parseMaybeZero(tr.querySelector('[name=fine]').value);
      const paidIn = parseMaybeZero(tr.querySelector('[name=paidIn]').value);
      if (fine === null || paidIn === null) return setStatus('Check the amounts', 'bad');
      edits[tr.dataset.id] = { fine, paidIn };
    }
    st.editingPot = false;
    return save((d) => d.people.forEach((p) => edits[p.id] && Object.assign(p, edits[p.id])));
  }
  if (act === 'exp-del') {
    if (!askConfirm(b.dataset.id)) return;
    return save((d) => (d.expenses = d.expenses.filter((e) => e.id !== b.dataset.id)), 'Deleted');
  }
  if (act === 'done-toggle') {
    if (!askConfirm('done')) return;
    const done = !st.data.done;
    return save((d) => (d.done = done), done ? 'Final split ready' : 'Shopping reopened');
  }
  if (act === 'pay-del') {
    if (!askConfirm(b.dataset.id)) return;
    return save((d) => (d.payments = d.payments.filter((p) => p.id !== b.dataset.id)), 'Undone');
  }
  if (act === 'pay') {
    const { from, to } = b.dataset;
    const amount = Number(b.dataset.amount);
    return save((d) => {
      // ignore a double tap / two friends marking the same transfer at once
      const recent = Date.now() - 120_000;
      const dup = d.payments.some(
        (p) => p.from === from && p.to === to && p.amount === amount && Date.parse(p.at) > recent,
      );
      if (!dup) d.payments.push({ id: S.uid(), from, to, amount, at: new Date().toISOString() });
    }, 'Payment recorded');
  }
  if (act === 'setup-open') return ((st.showSetup = true), render());
  if (act === 'logout') {
    store.del('kks.key');
    location.reload();
  }
});

$('#me').addEventListener('change', (ev) => {
  st.me = ev.target.value;
  store.set('kks.me', st.me);
  render();
});

$('#shop-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const by = f.by.value;
  const what = f.what.value.trim();
  const amount = parseEuros(f.amount.value);
  if (!by || !what || amount === null) return setStatus(!by ? 'Pick who paid' : !what ? 'Say what it was' : 'Check the amount', 'bad');
  f.what.value = '';
  f.amount.value = '';
  save((d) => d.expenses.push({ id: S.uid(), by, what, amount, at: new Date().toISOString() }), 'Added');
});

$('#pay-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const amount = parseEuros(f.amount.value);
  if (f.from.value === f.to.value || amount === null) return setStatus('Check the payment', 'bad');
  const p = { id: S.uid(), from: f.from.value, to: f.to.value, amount, at: new Date().toISOString() };
  f.amount.value = '';
  save((d) => d.payments.push(p), 'Payment recorded');
});

$('#setup').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const tok = ev.target.token.value.trim();
  const msg = $('#setup-msg');
  msg.textContent = 'Checking…';
  try {
    await S.loadData(st.key, tok); // can read
    let sha;
    try {
      sha = (await S.readFile(tok, S.CONF.configPath, S.CONF.configBranch)).sha;
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const box = await S.seal(st.key, { token: tok });
    await S.writeFile(tok, S.CONF.configPath, S.CONF.configBranch, box, sha, 'config'); // can write
    st.token = tok;
    st.showSetup = false;
    ev.target.token.value = '';
    msg.textContent = '';
    setStatus('Editing on', 'ok');
    render();
  } catch (e) {
    msg.textContent =
      e.status === 403 || e.status === 404
        ? 'That token cannot write to the kks-dinner repo. It needs Contents: Read and write on that repository.'
        : e.status === 401
          ? 'GitHub rejected that token.'
          : e.message;
  }
});

tryRemembered().then((ok) => {
  if (!ok) {
    $('#gate').hidden = false;
    $('#pw').focus();
  }
});
