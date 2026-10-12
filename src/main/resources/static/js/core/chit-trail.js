/**
 * Where a hosted chit's money stands, against an entry or a payment (see ChitTrailService on the server):
 *
 *   chitStatus(trail)       one status, always the same width so a list of them lines up as a column (an empty slot when
 *                           the entry has none, unless { empty: false }). Its tinted left segment says what kind of chit
 *                           entry it is (a member's payment, a transfer, the payout, the commission); the label says where
 *                           the money stands. Once the month is paid out, a payment or a gather keeps its status and turns
 *                           green with a small crown; only the payout itself says "Payout". The details are its tooltip.
 *   chitTrailHtml(trail)    the expanded entry: the kind, the movement status and the payout status side by side, and
 *                           the facts (month, by which entry, the payments carried, who was paid and when)
 *   hasChitStatus(list)     whether any of the entries has a status (to show the column at all)
 */
import { icon } from './icons.js';
import { esc } from './ui.js';
import { money, date } from './format.js';

/** The kind of chit entry: its icon and its name. */
const KINDS = {
    COLLECTION: ['hand-coins', 'Chit payment'],
    MOVE: ['merge', 'Chit transfer'],
    PAYOUT: ['crown', 'Chit payout'],
    COMMISSION: ['piggy', 'Chit commission'],
};

/** [label, tone] of each movement state. */
const STATES = {
    TO_MOVE: ['To move', 'warn'],
    MOVED: ['Moved', 'blue'],
    IN_COLLECTIONS: ['Collected', 'teal'],
    DIRECT: ['To winner', 'violet'],
    GATHERED: ['Gathered', 'indigo'],
    PAYOUT: ['Payout', 'gold'],
    TO_BANK: ['To my bank', 'good'],
    COMMISSION_PENDING: ['To move', 'warn'],
    COMMISSION_MOVED: ['Moved', 'good'],
    TRANSFER: ['Transfer', 'muted'],
};

/** The movement state of the entry (never "paid out": that is shown on top of it). */
function stateOf(t) {
    if (!t) return null;
    if (t.kind === 'PAYOUT') return 'PAYOUT';
    if (t.kind === 'COMMISSION') return t.status === 'PENDING' ? 'COMMISSION_PENDING' : 'COMMISSION_MOVED';
    if (t.kind === 'MOVE') {
        if (t.moveType === 'Commission to my bank') return 'TO_BANK';
        if (t.moveType === 'Gathered into collections') return 'GATHERED';
        return 'TRANSFER';
    }
    return STATES[t.status] ? t.status : null;
}

/** A payment or a gather whose month is paid out (the payout entry is itself the payout). */
const paidOut = t => !!t && t.kind !== 'PAYOUT' && t.kind !== 'COMMISSION' && !!t.payoutDate;

function payoutText(t) {
    return t.payoutDate ? `Paid out ${date(t.payoutDate)} to ${t.winner || 'the winner'}${t.payoutAmount ? ` (${money(t.payoutAmount)})` : ''}${t.payoutEntryNo ? ` · ${t.payoutEntryNo}` : ''}`
        : t.kind === 'MOVE' && t.status === 'AWAITING_PAYOUT' ? 'Payout not made yet' : '';
}

/** Everything about it, for the tooltip. */
function tipOf(t) {
    return [
        `${(KINDS[t.kind] || [])[1] || 'Chit'} · ${[t.chitName, t.payCode].filter(Boolean).join(' · ')}`,
        t.kind === 'MOVE' && t.moveType ? t.moveType : t.label,
        t.detail,
        t.movedBy && t.kind === 'COLLECTION' ? `Moved by ${t.movedBy}${t.movedOn ? ` on ${date(t.movedOn)}` : ''}` : '',
        payoutText(t),
    ].filter(Boolean).join('\n');
}

export function chitStatus(t, { empty = true } = {}) {
    const key = stateOf(t);
    if (!key) return empty ? '<span class="ct-st none"></span>' : '';
    const [label, tone] = STATES[key];
    const [kindIcon, kindName] = KINDS[t.kind] || ['hand-coins', 'Chit'];
    const paid = paidOut(t);
    return `<span class="ct-st ${tone} ${paid ? 'paid' : ''}" title="${esc(tipOf(t))}" aria-label="${esc(`${kindName}: ${label}${paid ? ', paid out' : ''}`)}">`
        + `<i class="ct-kind">${icon(kindIcon)}</i><span class="ct-st-label">${esc(label)}</span>${paid ? `<i class="ct-paid">${icon('crown')}</i>` : ''}</span>`;
}

// ------------------------------------------------------------- short descriptions (collapsed rows)

/** The chit's code from its name, as the server makes it when none is set: first letters, "75K" whole, 4 characters. */
export function chitTag(name) {
    let b = '';
    for (const w of String(name || '').split(/[^A-Za-z0-9]+/)) {
        if (!w) continue;
        b += /\d/.test(w) ? w.toUpperCase() : w[0].toUpperCase();
        if (b.length >= 4) break;
    }
    return b.slice(0, 4) || 'CHIT';
}

const CHIT_ACCOUNT = /^(.+?)\s+-\s+(collections|commission|late interest)$/i;

/** "My Household 75K (Oct26–Dec26) - collections" → "MH75 collections" (code: the chit's own code, when known). */
export function shortAccount(name, code = null) {
    const m = CHIT_ACCOUNT.exec(String(name || '').trim());
    return m ? `${code || chitTag(m[1])} ${m[2].toLowerCase()}` : name;
}

/** Every chit account named inside a sentence, shortened ("ICICI Savings → Gather 40K - collections"). */
export function shortAccountsIn(text, code = null) {
    return String(text || '').replace(/([^:→+,;(·]+?)\s+-\s+(collections|commission|late interest)\b/gi, (_, n, role) => `${code || chitTag(n.trim())} ${role.toLowerCase()}`);
}

const codeOf = t => (t?.payCode || '').replace(/-M\d+$/, '') || null;

/**
 * A short, plain description of a chit entry for a collapsed row, in place of its long narration (which stays as the
 * tooltip and in the expanded view): "Ravi Kumar paid · GA40-M02", "Gathered for the GA40-M01 payout",
 * "Payout GA40-M01 to Ravi Kumar", "Commission earned · GA40-M01". Null for an entry that is not a chit's.
 */
export function chitDescription(t, { narration = '', party = '' } = {}) {
    if (!t) return null;
    const code = t.payCode || (t.monthNo ? `month ${t.monthNo}` : '');
    const member = (/^Chit collection - (.+?) - /.exec(narration) || [])[1] || (party && party !== t.chitName ? party : '');
    switch (t.kind) {
        case 'COLLECTION': return `${member || 'Member'} paid${code ? ` · ${code}` : ''}`;
        case 'PAYOUT': return `Payout${code ? ` ${code}` : ''}${t.winner || member ? ` to ${t.winner || member}` : ''}`;
        case 'COMMISSION': return `${/to its account/i.test(narration) ? 'Commission set aside' : 'Commission earned'}${code ? ` · ${code}` : ''}`;
        case 'MOVE':
            if (t.moveType === 'Gathered into collections') return `Gathered for the ${code || 'chit'} payout`;
            if (t.moveType === 'Commission to my bank') return `Commission to my bank${code ? ` · ${code}` : ''}`;
            return shortAccountsIn(narration.replace(/\s*\([^()]*\)\s*$/, ''), codeOf(t));
        default: return null;
    }
}

/** What a collapsed row says: the chit description, or the narration with chit account names shortened. */
export function shortNarration(narration, trail, party = '') {
    return chitDescription(trail, { narration, party }) || memberChit(narration) || shortAccountsIn(narration, codeOf(trail));
}

/** A chit I am a member of: "Shriram 5L Group A - installment 3/20" → "Instalment 3/20 · S5LG". */
function memberChit(narration) {
    const s = String(narration || '');
    let m = /^(.+?) - installment (\d+\/\d+)$/.exec(s);
    if (m) return `Instalment ${m[2]} · ${chitTag(m[1])}`;
    m = /^(.+?) - installment (\d+) \(paid before tracking\)$/.exec(s);
    if (m) return `Instalment ${m[2]} (before tracking) · ${chitTag(m[1])}`;
    m = /^(.+?) - (prize money|maturity payout)$/.exec(s);
    if (m) return `${m[2] === 'prize money' ? 'Prize money' : 'Maturity payout'} · ${chitTag(m[1])}`;
    return null;
}

/** Whether a party adds anything to a description that is shown (not named in it, not the chit itself). */
export function partyAdds(party, shown, trail) {
    if (!party) return false;
    if (trail && (party === trail.chitName || party === trail.winner)) return false;
    return !String(shown || '').toLowerCase().includes(String(party).toLowerCase());
}

export { codeOf as chitCodeOf };

/** For callers that only want it where there is one. */
export const chitTrailChips = t => chitStatus(t, { empty: false });

export const hasChitStatus = list => (list || []).some(x => x?.chitTrail);

/** The payout status on its own (expanded view). */
function payoutBadge(t) {
    if (t.kind === 'PAYOUT' || t.kind === 'COMMISSION') return '';
    if (t.payoutDate) return `<span class="ct-badge good">${icon('crown')}Paid out ${esc(t.payCode || '')}</span>`;
    if (t.kind === 'MOVE' && t.status === 'AWAITING_PAYOUT') return `<span class="ct-badge warn">${icon('clock')}Awaiting payout</span>`;
    if (t.kind === 'COLLECTION' && t.status !== 'DIRECT') return `<span class="ct-badge muted">${icon('clock')}Not paid out yet</span>`;
    return '';
}

export function chitTrailHtml(t) {
    if (!t) return '';
    const [kindIcon, kindName] = KINDS[t.kind] || ['hand-coins', 'Chit'];
    const facts = [
        t.kind === 'MOVE' && t.moveType ? esc(t.moveType) : '',
        esc(t.detail || ''),
        t.movedBy && t.kind === 'COLLECTION' ? `moved by <b>${esc(t.movedBy)}</b>${t.movedOn ? ` on ${date(t.movedOn)}` : ''}` : '',
        t.payments ? `${t.payments} payment${t.payments === 1 ? '' : 's'} · ${money(t.paymentsTotal)}` : '',
        t.payoutDate ? esc(payoutText(t)) : '',
    ].filter(Boolean);
    return `<div class="ct-line">
        <span class="ct-chit">${icon(kindIcon)}<b>${esc(kindName)}</b><span>${esc(t.chitName || '')}${t.payCode ? ` · ${esc(t.payCode)}` : ''}</span></span>
        ${chitStatus(t, { empty: false })}${payoutBadge(t)}
        <span class="ct-facts">${facts.join(' · ')}</span></div>`;
}
