/**
 * Where a hosted chit's money stands, against an entry or a payment (see ChitTrailService on the server):
 *
 *   chitTrailChips(trail)   compact chips for a row: the move's type, the movement status, and the payout once made
 *   chitTrailHtml(trail)    the full line for an expanded entry: chit, month, what happened, by which entry, the payout
 */
import { icon } from './icons.js';
import { esc } from './ui.js';
import { money, date } from './format.js';

const ICON = { warn: 'clock', good: 'check', teal: 'wallet', muted: 'transfer' };

/** The payout, once it is made: "Paid out GA40-M01 · Ravi". */
const payoutChip = t => t.payoutEntryNo || t.payoutDate
    ? `<span class="ct-chip good" title="${esc(`Paid out ${t.payCode || ''} on ${date(t.payoutDate)} to ${t.winner || 'the winner'}${t.payoutAmount ? `: ${money(t.payoutAmount)}` : ''}${t.payoutEntryNo ? ` · ${t.payoutEntryNo}` : ''}`)}">${icon('crown')}Paid out${t.payCode ? ` <small>${esc(t.payCode)}</small>` : ''}</span>`
    : '';

export function chitTrailChips(t) {
    if (!t) return '';
    const type = t.kind === 'MOVE' && t.moveType && t.moveType !== t.label
        ? `<span class="ct-chip type" title="${esc(t.detail || '')}">${icon('merge')}${esc(t.moveType)}</span>` : '';
    // a gathered move shows "awaiting payout" until the payout is made, then the payout itself
    const status = t.kind === 'MOVE' && t.status === 'PAID_OUT' ? ''
        : t.kind === 'PAYOUT' ? '' : `<span class="ct-chip ${esc(t.tone)}" title="${esc(t.detail || '')}">${icon(ICON[t.tone] || 'info')}${esc(t.kind === 'MOVE' && t.status === 'AWAITING_PAYOUT' ? 'Awaiting payout' : t.label)}${t.kind === 'MOVE' && t.payCode ? ` <small>${esc(t.payCode)}</small>` : ''}</span>`;
    return `<span class="ct-chips">${type}${status}${t.kind === 'COMMISSION' || (t.kind === 'PAYOUT' && !t.payoutDate) ? '' : payoutChip(t)}</span>`;
}

export function chitTrailHtml(t) {
    if (!t) return '';
    const facts = [
        t.payCode ? `<b>${esc(t.payCode)}</b>` : '',
        esc(t.detail || ''),
        t.movedBy && t.kind === 'COLLECTION' ? `moved by <b>${esc(t.movedBy)}</b>${t.movedOn ? ` on ${date(t.movedOn)}` : ''}` : '',
        t.payments ? `${t.payments} payment${t.payments === 1 ? '' : 's'} · ${money(t.paymentsTotal)}` : '',
        t.payoutDate && t.kind !== 'PAYOUT' ? `paid out ${date(t.payoutDate)} to <b>${esc(t.winner || 'the winner')}</b>${t.payoutAmount ? ` (${money(t.payoutAmount)})` : ''}${t.payoutEntryNo ? ` · ${esc(t.payoutEntryNo)}` : ''}`
            : t.kind === 'MOVE' && t.status === 'AWAITING_PAYOUT' ? 'the payout is not made yet' : '',
    ].filter(Boolean);
    return `<div class="ct-line"><span class="ct-chit">${icon('hand-coins')}${esc(t.chitName || '')}</span>${chitTrailChips(t)}
        <span class="ct-facts">${facts.join(' · ')}</span></div>`;
}
