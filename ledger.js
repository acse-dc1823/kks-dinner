// Pure money logic. All amounts are integer cents.
//
// Each person i owes the pot fine_i. They cover it by paying cash in to the
// holder (paidIn_i), by buying food for the dinner (spent_i), or by settling
// transfers (sent_i / recv_i). The holder physically keeps all paid-in cash,
// so that cash counts against the holder's own balance.
//
// If spending is below the pot, the leftover stays with the holder.
// If spending is above the pot, the excess is split equally between everyone.

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

  const base = Math.floor(overspend / people.length);
  let extraCents = overspend - base * people.length;

  const rows = people.map((p) => {
    const share = base + (extraCents-- > 0 ? 1 : 0);
    const own = p.paidIn + spent[p.id] - p.fine - share; // fine status, ignoring transfers
    const isHolder = p.id === holder;
    const personal = isHolder ? own : own + sent[p.id] - recv[p.id];
    const net = isHolder
      ? own - cashHeld + sent[p.id] - recv[p.id] + leftover
      : personal;
    return {
      ...p,
      isHolder,
      spent: spent[p.id],
      sent: sent[p.id],
      recv: recv[p.id],
      overspendShare: share,
      owes: Math.max(0, -personal), // section 1: still owes towards their fine
      credit: Math.max(0, personal), // still to get back
      net, // section 3: >0 receives, <0 pays
    };
  });

  return {
    rows,
    totalFine,
    cashHeld,
    totalSpent,
    leftover,
    overspend,
    totalOwed: rows.reduce((s, r) => s + r.owes, 0),
    transfers: settle(rows),
  };
}

// Greedy settlement: largest debtor pays largest creditor. At most n-1 transfers.
export function settle(rows) {
  const cred = rows.filter((r) => r.net > 0).map((r) => ({ id: r.id, amt: r.net }));
  const debt = rows.filter((r) => r.net < 0).map((r) => ({ id: r.id, amt: -r.net }));
  cred.sort((a, b) => b.amt - a.amt);
  debt.sort((a, b) => b.amt - a.amt);
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
