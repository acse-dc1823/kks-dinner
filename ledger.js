// Pure money logic. All amounts are integer cents.
//
// Each person i owes the pot fine_i. They cover it by paying cash in to the
// holder (paidIn_i), by buying food for the dinner (spent_i), or by settling
// transfers (sent_i / recv_i). The holder physically keeps all paid-in cash,
// so that cash counts against the holder's own balance.
//
// While shopping: money only moves to pay back people who bought food. The
// holder's pot cash pays first; after that, whoever still owes the most.
// Once shopping is done (data.done): the gap between the dinner cost and the
// pot is shared equally (under the pot: everyone pays the same amount less;
// over: the same amount more) and everyone settles completely.
// Going over the pot is shared equally even while shopping.

export function compute(data) {
  const people = data.people;
  const holder = data.holder;
  const zero = () => Object.fromEntries(people.map((p) => [p.id, 0]));

  const spent = zero();
  for (const e of data.expenses) if (e.by in spent) spent[e.by] += e.amount;

  const sent = zero();
  const recv = zero();
  for (const t of data.payments) {
    if (t.from in sent) sent[t.from] += t.amount;
    if (t.to in recv) recv[t.to] += t.amount;
  }

  const totalFine = people.reduce((s, p) => s + p.fine, 0);
  const cashHeld = people.reduce((s, p) => s + p.paidIn, 0);
  const totalSpent = Object.values(spent).reduce((s, v) => s + v, 0);
  const leftover = Math.max(0, totalFine - totalSpent);
  const overspend = Math.max(0, totalSpent - totalFine);
  const final = Boolean(data.done);

  // Equal share of the gap between cost and pot; leftover cents go to the first people.
  const adjust = final ? totalSpent - totalFine : overspend;
  const sign = adjust < 0 ? -1 : 1;
  const base = Math.floor(Math.abs(adjust) / people.length);
  let extraCents = Math.abs(adjust) - base * people.length;

  const rows = people.map((p) => {
    const share = sign * (base + (extraCents-- > 0 ? 1 : 0)); // + pays more, - pays less
    const own = p.paidIn + spent[p.id] - p.fine - share; // fine status, ignoring transfers
    const isHolder = p.id === holder;
    // Holder: pot cash he still has. Paying out beyond it comes from his own pocket,
    // which counts towards his fine.
    const cashNow = isHolder ? cashHeld + recv[p.id] - sent[p.id] : 0;
    const personal = isHolder ? own + Math.max(0, -cashNow) : own + sent[p.id] - recv[p.id];
    // holder: negative net = pot cash (plus own unpaid fine) available to pay out
    const net = isHolder ? own - cashNow : personal;
    return {
      ...p,
      isHolder,
      spent: spent[p.id],
      sent: sent[p.id],
      recv: recv[p.id],
      share,
      owes: Math.max(0, -personal), // section 1: still owes towards their fine
      credit: Math.max(0, personal), // still to get back
      net, // section 3: >0 is owed, <0 could pay up to this
      cashNow: Math.max(0, cashNow),
    };
  });

  return {
    rows,
    totalFine,
    cashHeld,
    totalSpent,
    leftover,
    overspend,
    final,
    adjust,
    totalOwed: rows.reduce((s, r) => s + r.owes, 0),
    transfers: settle(rows, holder),
  };
}

// Pays back everyone who is owed, and no more. Who pays: the holder first (pot
// cash), then the biggest debtors. Then greedy matching, at most n-1 transfers.
export function settle(rows, holder) {
  const cred = rows.filter((r) => r.net > 0).map((r) => ({ id: r.id, amt: r.net }));
  cred.sort((a, b) => b.amt - a.amt);
  let need = cred.reduce((s, c) => s + c.amt, 0);
  const candidates = rows.filter((r) => r.net < 0).map((r) => ({ id: r.id, amt: -r.net }));
  candidates.sort((a, b) => (b.id === holder) - (a.id === holder) || b.amt - a.amt);
  const debt = [];
  for (const d of candidates) {
    if (need <= 0) break;
    const take = Math.min(d.amt, need);
    debt.push({ id: d.id, amt: take });
    need -= take;
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < debt.length && j < cred.length) {
    const amount = Math.min(debt[i].amt, cred[j].amt);
    if (amount > 0) out.push({ from: debt[i].id, to: cred[j].id, amount });
    debt[i].amt -= amount;
    cred[j].amt -= amount;
    if (debt[i].amt === 0) i++;
    if (cred[j].amt === 0) j++;
  }
  return out;
}

// "12,50" / "12.50" / "€ 12" -> 1250 cents. Returns null when invalid.
export function parseEuros(input) {
  const s = String(input).replace(/[€\s]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const cents = Math.round(parseFloat(s) * 100);
  return cents > 0 ? cents : null;
}
