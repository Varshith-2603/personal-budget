/**
 * Host a Chit: chits the user runs as the organiser, laid out like the Chits page: a portfolio card and figures
 * on top, the hosted chits on the left, and for the selected chit a banner, key figures and a tabbed chit book
 * (This month, Months, Payments, Members, History).
 *
 * Two kinds of chit:
 *   FIXED    chit value(m) = month-1 value + (m − 1) × increase; the winner is picked or drawn and gets the chit
 *            value less the commission; winners may pay an extra amount (₹ or % of the chit value) afterwards
 *   AUCTION  Margadarsi style: the chit value is fixed; each month the members who have not won bid the discount
 *            they give up (from the commission up to the highest bid allowed). The winner gets chit value − bid,
 *            the organiser keeps the commission and the rest of the bid is shared as a dividend, so everyone pays
 *            installment − dividend that month.
 *
 * Also: a send centre for payment reminders (each with the member's payment link) and signed receipts (link and
 * PDF), by e-mail all at once or WhatsApp one after another; temporary share links (a
 * member's status or the whole chit, optionally with the organiser's earnings) and, when the chit posts to the
 * books, separate accounts for the collections and the commission.
 */
import { api } from '../core/api.js';
import { state, can, loadAccounts, categoriesOf } from '../core/store.js';
import { panel, esc, openModal, confirmDialog, toast, emptyState, printElement, narrativeHtml } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { money, moneyShort, date, shortDate, shortDateYear, isoDate, daysFromToday, dateTime } from '../core/format.js';
import { exportButton, bindExport } from '../core/export.js';
import { setPageKeys, listNavigator } from '../core/keys.js';
import { qrSvg } from '../core/qr.js';
import { getPref, setPref } from '../core/prefs.js';
import { evidenceFieldHtml, bindEvidenceField } from '../components/evidence.js';
import { openEntryDetail } from '../components/transaction-forms.js';
import * as chitAccounts from './chit-accounts.js';
import { paymentsNarrative, sectionSwitch, moneyAccountOptions, openTransfer, whereHtml, monthTrailHtml, transfersTable, statsToggleHtml, bindStatsToggle } from './chit-accounts.js';

const view = { selectedId: null, tab: 'month', historyKind: 'ALL', memberQuery: '', duesFilter: 'ALL' };
/** The chit on screen (the last answer from the server). */
let current = null;

const TABS = [
    { key: 'month', label: 'This month', iconName: 'check-circle' },
    { key: 'dues', label: 'Dues', iconName: 'alert' },
    { key: 'months', label: 'Months', iconName: 'calendar' },
    { key: 'money', label: 'Money', iconName: 'wallet' },
    { key: 'payments', label: 'Payments', iconName: 'grid' },
    { key: 'members', label: 'Members', iconName: 'users' },
    { key: 'agreements', label: 'Agreements', iconName: 'file-text' },
    { key: 'history', label: 'In & out', iconName: 'transfer' },
];
const MODES = ['Cash', 'UPI', 'Bank'];
const SHARE_DURATIONS = [[24, '1 day'], [72, '3 days'], [168, '1 week'], [720, '1 month'], [2160, '3 months']];
const SAMPLE_NAMES = ['Ravi Kumar', 'Lakshmi Devi', 'Suresh Reddy', 'Anitha Rao', 'Venkatesh', 'Priya Sharma', 'Kiran Babu',
    'Swathi', 'Ramesh Naidu', 'Divya', 'Srinivas', 'Kavitha', 'Mahesh', 'Sandhya', 'Naresh', 'Padma', 'Arjun', 'Revathi',
    'Prakash', 'Sunitha', 'Gopal', 'Madhavi', 'Raju', 'Shobha', 'Harish', 'Vani', 'Sekhar', 'Jyothi', 'Balaji', 'Rekha'];

// ===================================================================== helpers

const num = v => Number(v || 0);
const UPI = /^[\w.\-]{2,}@[A-Za-z][\w.]{1,}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const manage = () => can('MANAGE_CHITS');
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const isAuction = c => c.chitType === 'AUCTION';
/** Planned chit: the organiser sets each month's payout (and what members pay) in the chit table. */
const isPlanned = c => c.chitType === 'PLANNED';
const typeName = c => isAuction(c) ? 'Auction' : isPlanned(c) ? 'Planned' : 'Fixed';
const typeIcon = c => isAuction(c) ? 'gavel' : isPlanned(c) ? 'calendar' : 'hand-coins';
/** The top figures (portfolio cards and the chit's key tiles) are shown on demand; the choice is remembered. */
const statsPref = () => getPref('hostChitStats', { show: false });

/** "2026-05-01" -> "May 2026" */
function monthName(iso) {
    if (!iso) return '—';
    const [y, m] = iso.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

/** "2026-05-01" -> "May '26" */
function shortMonth(iso) {
    const [y, m] = iso.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'short' }) + " '" + String(y).slice(2);
}

function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function initials(name) {
    return name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

function dueDateOf(startYm, dueDay, no) {
    const [y, m] = startYm.split('-').map(Number);
    const first = new Date(y, m - 1 + no - 1, 1);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    return isoDate(new Date(first.getFullYear(), first.getMonth(), Math.min(dueDay, last)));
}

function relDays(iso) {
    const d = daysFromToday(iso);
    return d === 0 ? 'today' : d === 1 ? 'tomorrow' : d === -1 ? 'yesterday' : d > 0 ? `in ${d} days` : `${-d} days ago`;
}

function randomPhone() {
    return String(6 + Math.floor(Math.random() * 4)) + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
}

/** The rupees a winner pays on top of the monthly amount after winning (s: a chit or the wizard's draft). */
function extraOf(s) {
    if (isAuction(s) || isPlanned(s)) return 0;
    const v = num(s.winnerExtraValue);
    return s.winnerExtraType === 'PERCENT' ? Math.round(num(s.baseValue) * v / 100) : s.winnerExtraType === 'FIXED' ? v : 0;
}

function extraText(s) {
    return s.winnerExtraType === 'PERCENT' ? `${num(s.winnerExtraValue)}% of the chit value (${money(extraOf(s))})` : money(extraOf(s));
}

/** What a member owes for a month: auction, the installment less the month's dividend; fixed, plus the winner extra. */
function dueFor(d, member, month) {
    const c = d.chit;
    if (isPlanned(c)) return num(month.installment);
    if (isAuction(c)) return num(c.installment) - num(month.dividend);
    return num(c.installment) + (member.wonMonth && member.wonMonth < month.monthNo ? num(c.winnerExtraAmount) : 0);
}

function paidFor(d, memberId, monthNo, exceptPaymentId = null) {
    return d.payments.filter(p => p.memberId === memberId && p.monthNo === monthNo && p.id !== exceptPaymentId)
        .reduce((s, p) => s + num(p.amount), 0);
}

const monthOf = (d, no) => d.schedule.find(m => m.monthNo === no);

/** Late interest still due on a member's month ({ due, daysLate, accrued, settled }), or null. */
function lateFor(d, memberId, monthNo) {
    const l = (d.lateFees || []).find(x => x.memberId === memberId && x.monthNo === monthNo);
    return l && num(l.due) > 0 ? l : null;
}

/** A temporary link to the chit, a member's statement, a receipt or an agreement; returns { url, share }. */
async function makeLink(d, body, hours = 720) {
    const created = await api.post(`/hosted-chits/${d.chit.id}/shares`, { hours, showEarnings: false, ...body });
    return { url: `${location.origin}/chit-share.html#${created.token}`, share: created.share };
}

/** wa.me link to a member (their phone when known). */
function whatsapp(member, text) {
    const phone = member?.phone ? member.phone.replace(/\D/g, '').slice(-10) : '';
    return `https://wa.me/${phone ? '91' + phone : ''}?text=${encodeURIComponent(text)}`;
}

/** A member as the update request, with some fields changed. */
function memberBody(m, changes = {}) {
    return { name: m.name, phone: m.phone || null, email: m.email || null, payoutAccount: m.payoutAccount || null,
        payToAccountId: m.payToAccountId || null, upiId: m.upiId || null, payToMemberId: m.payToMemberId || null, ...changes };
}

/**
 * Members pay this month's winner directly: shares the winner's UPI ID and mobile number with the members who still
 * owe, with the 8-character payment note (AC5L-M03) for their bank statements. Optionally points their signed payment
 * links to the winner (until the month is paid out); a message for the group and one for each member, on WhatsApp.
 */
async function openPayWinnerDirect(d, monthNo) {
    const c = d.chit;
    const month = monthOf(d, monthNo);
    const winner = d.members.find(x => x.id === month.winnerMemberId);
    if (!winner) { toast('Choose the winner first', 'error'); return; }
    const code = payCode(c, monthNo);
    const me = c.receiptSigner || c.payeeName || state.user?.fullName || 'the organiser';
    const owing = d.members.filter(x => x.id !== winner.id)
        .map(m => ({ m, due: Math.max(0, dueFor(d, m, month) - paidFor(d, m.id, monthNo)) })).filter(x => x.due > 0);
    const first = winner.name.split(' ')[0];
    const links = {};
    const st = { upi: winner.upiId || '', phone: winner.phone || '', picked: new Set(owing.map(x => x.m.id)), point: true };
    const amounts = [...new Set(owing.map(x => x.due))];
    const groupText = () => `${c.name}, month ${monthNo}: ${winner.name} won ${money(month.payout)}. Please pay your installment`
        + `${amounts.length === 1 ? ` (${money(amounts[0])})` : ''} directly to ${first}`
        + `${st.upi ? ` · UPI ${st.upi}` : ''}${st.phone ? ` · mobile ${st.phone}` : ''}. Use the note ${code} so it shows on your bank statement, and tell me once paid. – ${me}`;
    const memberText = x => `Hi ${x.m.name.split(' ')[0]}, for ${c.name} month ${monthNo} please pay ${money(x.due)} directly to ${winner.name}`
        + `${st.upi ? ` (UPI ${st.upi})` : ''}${st.phone ? `, mobile ${st.phone}` : ''}, with the note ${code}.${links[x.m.id] ? ` Signed payment details: ${links[x.m.id]}` : ''} – ${me}`;
    openModal({
        title: `Members pay ${winner.name} directly`, sub: `${c.name} · month ${monthNo} · comes off ${first}’s payout`, iconName: 'share', size: 'xl',
        body: `<div class="hc-direct">
            <div class="hc-direct-left">
                <div class="hc-direct-winner">
                    <span class="hc-avatar gold">${icon('crown')}</span>
                    <div class="min-0 grow"><b>${esc(winner.name)}</b><small>wins ${money(month.payout)} · ${plural(owing.length, 'member')} to pay ${money(owing.reduce((s, x) => s + x.due, 0))}</small></div>
                    <div class="hc-code" title="Payment note: chit short code and month, 8 characters"><small>Payment note</small><b>${esc(code)}</b></div>
                </div>
                <div class="form-grid two">
                    <label class="field"><span>${esc(first)}’s UPI ID</span><input type="text" name="upi" value="${esc(st.upi)}" maxlength="60" placeholder="name@okaxis" data-plain></label>
                    <label class="field"><span>${esc(first)}’s mobile</span><input type="tel" name="phone" value="${esc(st.phone)}" maxlength="14" inputmode="numeric" placeholder="10 digits" data-plain></label>
                </div>
                <label class="check-line"><input type="checkbox" name="point" checked> Show ${esc(first)}’s UPI ID and mobile on these members’ signed payment links (until month ${monthNo} is paid out)</label>
                <div class="section-title">${icon('users')}Members who still owe month ${monthNo}</div>
                <div class="hc-direct-list">${owing.map(x => `<label class="hc-direct-row" data-m="${x.m.id}">
                    <input type="checkbox" data-pick="${x.m.id}" checked>
                    <span class="hc-avatar xs">${esc(initials(x.m.name))}</span><b>${esc(x.m.name)}</b>
                    <small>${esc(x.m.phone || 'no mobile')}</small><b class="r">${money(x.due)}</b>
                    <a class="btn sm ghost" target="_blank" rel="noopener" data-wa="${x.m.id}" ${x.m.phone ? '' : 'hidden'}>${icon('phone')}WhatsApp</a></label>`).join('') || '<p class="muted hc-small">Everyone has paid this month.</p>'}</div>
            </div>
            <div class="hc-direct-right">
                <div class="section-title">${icon('send')}Message for the group</div>
                <textarea name="group" rows="7" data-plain></textarea>
                <div class="row wrap"><button type="button" class="btn sm" data-copy-group>${icon('copy')}Copy</button>
                    <a class="btn sm primary" target="_blank" rel="noopener" data-wa-group>${icon('phone')}Share on WhatsApp</a></div>
                <p class="book-note">${icon('info')}<span>When a member says they paid, record it under Payments as <b>paid ${esc(first)} directly</b>: it is set off against
                    ${esc(first)}’s payout, so you pay ${esc(first)} only the rest. The note <b>${esc(code)}</b> is 8 characters, so it shows whole on bank statements.</span></p>
            </div>
        </div>`,
        actions: [
            { label: 'Close' },
            { label: 'Save & make links', kind: 'primary', iconName: 'link', onClick: async modal => {
                const el = modal.el;
                const upi = st.upi.trim(), phone = st.phone.replace(/[\s-]/g, '');
                if (upi && !UPI.test(upi)) throw new Error(`${first}’s UPI ID should look like name@bank`);
                if (phone && !/^\d{10}$/.test(phone)) throw new Error('The mobile number should have 10 digits');
                if (!upi && !phone) throw new Error(`Enter ${first}’s UPI ID or mobile number`);
                let fresh = d;
                if (upi !== (winner.upiId || '') || phone !== (winner.phone || '')) {
                    fresh = await api.put(`/hosted-chits/${c.id}/members/${winner.id}`, memberBody(winner, { upiId: upi || null, phone: phone || null }));
                    winner.upiId = upi; winner.phone = phone;
                }
                const picked = owing.filter(x => st.picked.has(x.m.id));
                if (el.querySelector('[name=point]').checked) {
                    for (const x of picked) {
                        if (x.m.payToMemberId !== winner.id) fresh = await api.put(`/hosted-chits/${c.id}/members/${x.m.id}`, memberBody(x.m, { payToMemberId: winner.id, payToAccountId: null }));
                    }
                }
                if (picked.length) {
                    const made = await api.post(`/hosted-chits/${c.id}/shares/batch`, { memberIds: picked.map(x => x.m.id), hours: 24 * 30 });
                    made.forEach(l => { links[l.memberId] = shareUrl(l.token); });
                }
                draw(el);
                if (fresh !== d) await afterChange(fresh);
                toast(`${plural(picked.length, 'link')} ready: send them from the list`);
                return true;
            } },
        ],
        onOpen: modal => {
            const el = modal.el;
            el.querySelector('[name=group]').value = groupText();
            el.addEventListener('input', e => {
                if (e.target.name === 'upi') st.upi = e.target.value.trim();
                if (e.target.name === 'phone') st.phone = e.target.value.trim();
                if (e.target.name === 'upi' || e.target.name === 'phone') { el.querySelector('[name=group]').value = groupText(); draw(el); }
                if (e.target.name === 'group') draw(el);
            });
            el.addEventListener('change', e => {
                const id = Number(e.target.dataset.pick);
                if (id) { if (e.target.checked) st.picked.add(id); else st.picked.delete(id); }
            });
            el.querySelector('[data-copy-group]').addEventListener('click', async () => {
                try { await navigator.clipboard.writeText(el.querySelector('[name=group]').value); toast('Message copied', 'info'); } catch { /* not allowed */ }
            });
            draw(el);
        },
    });
    /** The WhatsApp links follow the message, the numbers and the links made. */
    function draw(el) {
        el.querySelector('[data-wa-group]').href = `https://wa.me/?text=${encodeURIComponent(el.querySelector('[name=group]').value)}`;
        owing.forEach(x => {
            const a = el.querySelector(`[data-wa="${x.m.id}"]`);
            if (a) { a.href = whatsapp(x.m, memberText(x)); a.classList.toggle('primary', !!links[x.m.id]); }
        });
    }
}

/** The link made, with copy, WhatsApp to the member and a QR code. */
function linkResultHtml(url, text, member, until) {
    return `<div class="ln-made cs-made">
        <div class="ln-qr">${qrSvg(url, { size: 140 })}</div>
        <div class="ln-made-main">
            <p class="small muted" style="margin:0">Works until <b>${dateTime(until)}</b>. Send it now: the link is shown only once.</p>
            <div class="ln-url"><input value="${esc(url)}" readonly data-plain><button type="button" class="btn sm primary" data-copy-url="${esc(url)}">${icon('copy')}Copy</button></div>
            <div class="row"><a class="btn sm" target="_blank" rel="noopener" href="${whatsapp(member, text)}">${icon('phone')}Send on WhatsApp</a>
                <a class="btn sm" target="_blank" rel="noopener" href="${esc(url)}">${icon('eye')}Preview</a></div>
        </div></div>`;
}

document.addEventListener('click', async e => {
    const b = e.target.closest('[data-copy-url]');
    if (!b) return;
    try { await navigator.clipboard.writeText(b.dataset.copyUrl); toast('Link copied', 'info'); } catch { b.previousElementSibling?.select(); }
});

/** PAID, PARTIAL, PENDING or NOTDUE for one box of the payments grid. */
function cellStatus(d, member, month) {
    const paid = paidFor(d, member.id, month.monthNo);
    if (paid >= dueFor(d, member, month)) return 'PAID';
    if (paid > 0) return 'PARTIAL';
    return month.due ? 'PENDING' : 'NOTDUE';
}

const CELL = { PAID: ['✓', 'Paid'], PARTIAL: ['½', 'Part paid'], PENDING: ['✗', 'Not paid'], NOTDUE: ['', 'Not due yet'] };
const STATUS = {
    ACTIVE: ['aqua', 'play', 'Running'], COMPLETED: ['good', 'check-circle', 'Finished'],
    ONGOING: ['aqua', 'clock', 'This month'], UPCOMING: ['gray', 'calendar', 'Coming up'],
};
function statusBadge(status) {
    const [tone, iconName, label] = STATUS[status] || ['gray', 'info', status];
    return `<span class="badge ${tone}">${icon(iconName)}${label}</span>`;
}
const typeBadge = c => isAuction(c) ? `<span class="badge violet">${icon('gavel')}Auction</span>`
    : isPlanned(c) ? `<span class="badge aqua">${icon('calendar')}Planned</span>` : `<span class="badge">${icon('trending')}Fixed</span>`;

/** Every member who owes something now: all due months not fully paid. */
function owingList(d) {
    return d.members.map(m => {
        const months = d.schedule.filter(s => s.due).map(s => ({ s, rest: dueFor(d, m, s) - paidFor(d, m.id, s.monthNo) })).filter(x => x.rest > 0);
        return { m, months, total: months.reduce((t, x) => t + x.rest, 0) };
    }).filter(x => x.total > 0);
}

function modeChips(selected = 'Cash') {
    return `<div class="seg-chips hc-modes" data-chips>${MODES.map(m =>
        `<button type="button" class="seg-chip ${m === selected ? 'active' : ''}" data-mode="${m}">${icon(m === 'Cash' ? 'cash' : m === 'UPI' ? 'qr' : 'bank')}${m}</button>`).join('')}</div>`;
}

function bindModeChips(root) {
    root.querySelectorAll('[data-chips]').forEach(group => group.addEventListener('click', e => {
        const chip = e.target.closest('[data-mode]');
        if (!chip) return;
        group.querySelectorAll('[data-mode]').forEach(c => c.classList.toggle('active', c === chip));
    }));
}

const chosenMode = root => root.querySelector('[data-chips] .active')?.dataset.mode || 'Cash';

// ===================================================================== page

export async function render(container, params, isCurrent) {
    // Host a Chit › Chit accounts: the accounts holding the chits' money (their own page, off the personal Accounts)
    if (params[0] === 'accounts') return chitAccounts.render(container, params.slice(1), isCurrent);
    const chits = await api.get('/hosted-chits');
    if (!isCurrent()) return;
    bindStatsToggle(container);
    const [first, second] = params;
    if (/^\d+$/.test(first || '')) view.selectedId = Number(first);
    if (second && TABS.some(t => t.key === second)) view.tab = second;
    if (!chits.some(c => c.id === view.selectedId)) view.selectedId = chits[0]?.id ?? null;
    const reload = () => render(container, [], isCurrent);

    container.innerHTML = `
    <div class="page chits-page hc-page ${statsPref().show ? '' : 'stats-hidden'}">
        <section class="cp-card" id="hc-brand"></section>
        <div class="cs-cards" id="hc-cards"></div>
        ${panel({
            title: 'Chits I host', iconName: 'hand-coins', cls: 'p-chit-list', bodyClass: 'flush',
            sub: `${chits.filter(c => c.status === 'ACTIVE').length} running`,
            actions: manage() ? `<button class="btn sm primary icon hc-add" id="hc-new" title="Host a new chit" aria-label="Host a new chit">${icon('plus')}</button>` : '',
            body: `<div class="chit-rows scroll" id="hc-list" tabindex="0"></div>`,
        })}
        <div class="chit-detail" id="hc-detail"></div>
    </div>`;

    drawPortfolio(container, chits);
    container.querySelector('#hc-new')?.addEventListener('click', () => openWizard());

    const listEl = container.querySelector('#hc-list');
    listEl.addEventListener('click', async e => {
        const row = e.target.closest('[data-id]');
        if (row && view.wizard && wizardDirty(view.wizard)
            && !await confirmDialog('Leave without creating the new chit? What you entered is lost.', { confirmLabel: 'Leave', danger: false })) return;
        if (row) { view.wizard = null; container.querySelector('#hc-detail')?.classList.remove('hc-creating'); }
        if (row) show(Number(row.dataset.id));
    });

    async function show(id) {
        view.selectedId = id;
        history.replaceState(null, '', `#/host-chits/${id}/${view.tab}`);
        listEl.querySelectorAll('[data-id]').forEach(el => el.classList.toggle('selected', Number(el.dataset.id) === id));
        const d = await api.get(`/hosted-chits/${id}`);
        if (view.selectedId !== id) return;
        current = d;
        drawDetail(container, d);
    }

    let keyTimer;
    setPageKeys(listNavigator({
        items: () => [...listEl.querySelectorAll('[data-id]')],
        selected: () => listEl.querySelector('.selected'),
        select: el => {
            listEl.querySelectorAll('.selected').forEach(x => x.classList.remove('selected'));
            el.classList.add('selected');
            clearTimeout(keyTimer);
            keyTimer = setTimeout(() => show(Number(el.dataset.id)), 130);
        },
    }));

    // #/host-chits/new opens the new-chit steps (after the list, so the selected chit does not replace them)
    if (first === 'new') openWizard();
    else if (view.selectedId) await show(view.selectedId);
    else container.querySelector('#hc-detail').innerHTML = welcomeHtml();
    container.querySelector('#hc-detail').addEventListener('click', e => {
        if (e.target.closest('[data-act="welcome-new"]')) openWizard();
    });
}

/** After a change: the chit as the server returned it, and fresh figures for the list and the portfolio. */
async function afterChange(d, message) {
    current = d;
    const container = document.querySelector('.hc-page')?.parentElement;
    if (!container) return;
    drawDetail(container, d);
    if (message) toast(message);
    try { drawPortfolio(container, await api.get('/hosted-chits')); } catch { /* the detail is already right */ }
}

function welcomeHtml() {
    return panel({ title: 'Host a chit', iconName: 'hand-coins', body: `
        <div class="hc-welcome">
            <span class="hc-welcome-ico">${icon('hand-coins')}</span>
            <h3>Run a chit for family or friends</h3>
            <p>Choose a <b>fixed</b> chit (the chit value rises each month and you pick the winner) or an <b>auction</b> chit
                (Margadarsi style: members bid each month and the discount is shared as a dividend). Collections, winners,
                reminders and payouts are all kept here.</p>
            ${manage() ? `<div class="row wrap"><button class="btn primary" data-act="welcome-new">${icon('plus')}Host a new chit</button></div>` : ''}
        </div>` });
}

// ---------------------------------------------------------------- portfolio card, figures and the list

function drawPortfolio(container, chits) {
    const running = chits.filter(c => c.status === 'ACTIVE');
    const sum = (list, key) => list.reduce((s, c) => s + num(c[key]), 0);
    const expected = sum(running, 'expectedThisMonth');
    const collected = sum(running, 'collectedThisMonth');
    const pct = expected ? (collected / expected) * 100 : 0;
    const next = running.filter(c => c.nextDueDate).sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate))[0];
    const auctions = chits.filter(isAuction).length;
    container.querySelector('#hc-brand').innerHTML = `
        <div class="cp-head"><span class="cp-mark">${icon('hand-coins')}</span>
            <div class="min-0"><small>Chits I host</small><b>${moneyShort(sum(chits, 'commissionEarned'))} <em>earned</em></b></div>
            <span class="cp-rate" title="Commission across the running chits each month">${moneyShort(sum(running, 'commission'))}<small>a month</small></span></div>
        <div class="cp-progress" title="Collected this month across the running chits">
            <i class="onc-bar"><em style="width:${Math.min(100, pct)}%"></em></i>
            <span>${moneyShort(collected)} of ${moneyShort(expected)} collected this month</span></div>
        <div class="cp-foot">${sectionSwitch('chits')}${statsToggleHtml()}
            <span class="cp-pill run">${icon('play')}${running.length} running</span>
            ${chits.length - running.length ? `<span class="cp-pill done">${icon('lock')}${chits.length - running.length} finished</span>` : ''}
            ${auctions ? `<span class="cp-pill done">${icon('gavel')}${auctions} auction</span>` : ''}
        </div>`;
    const cell = (iconName, label, value, sub, cls = '', meter = null) => `<div class="ov-card cs-card ${cls}">
        <span class="ov-ico">${icon(iconName)}</span>
        <div class="min-0"><span class="ov-label">${label}</span><b>${value}</b><small>${sub}</small>
            ${meter !== null ? `<i class="ov-meter"><em style="width:${Math.max(2, Math.min(100, meter))}%"></em></i>` : ''}</div></div>`;
    const pending = sum(running, 'pendingCount');
    const nextDays = next ? daysFromToday(next.nextDueDate) : null;
    container.querySelector('#hc-cards').innerHTML = `
        ${pending ? cell('alert', 'Still to collect', `<span class="down">${moneyShort(sum(running, 'pendingDues'))}</span>`, `${plural(pending, 'payment')} pending`, 'warn')
                  : cell('check-circle', 'Still to collect', moneyShort(0), 'everyone has paid', 'good')}
        ${cell('arrow-in', 'Collected this month', moneyShort(collected), `of ${moneyShort(expected)}`, '', pct)}
        ${cell('wallet', 'Money with me', moneyShort(sum(running, 'held')), 'collected, not yet paid out')}
        ${cell('crown', 'Paid to winners', moneyShort(sum(chits, 'totalPaidOut')), `${plural(chits.reduce((s, c) => s + c.completedMonths, 0), 'winner')}`)}
        ${cell('piggy', 'My commission', `<span class="gold">${moneyShort(sum(chits, 'commissionEarned'))}</span>`, 'earned so far', 'highlight')}
        ${cell('calendar', 'Next due', next ? shortDate(next.nextDueDate) : '—', next ? `${esc(next.name)} · ${relDays(next.nextDueDate)}` : 'nothing due', nextDays !== null && nextDays <= 3 ? 'note' : '')}`;

    const listEl = container.querySelector('#hc-list');
    const row = c => {
        const done = c.status === 'COMPLETED';
        const pctDone = (c.completedMonths / c.months) * 100;
        const accent = done ? 'slate' : isAuction(c) ? 'gold' : 'aqua';
        return `<div class="acct-item rich chit-item accent-${accent} status-${done ? 'matured' : 'active'} ${c.id === view.selectedId ? 'selected' : ''}" data-id="${c.id}">
            <span class="chip-icon sm ${isAuction(c) ? 'violet' : isPlanned(c) ? 'aqua' : 'gold'}">${icon(typeIcon(c))}</span>
            <div class="acct-main">
                <div class="acct-line"><span class="acct-name">${esc(c.name)}</span><b class="acct-bal" title="Chit value">${money(c.currentChitValue)}</b></div>
                <div class="acct-line sub">
                    <span class="acct-meta">${typeName(c)} · ${c.memberCount} members</span>
                    <span class="acct-facts">${c.pendingCount ? `<span class="fact bad" title="${money(c.pendingDues)} still to collect">${c.pendingCount} due</span>` : `<span class="fact good">all paid</span>`}
                        ${c.demo ? '<span class="fact muted">example</span>' : ''}</span>
                    <span class="acct-delta pos" title="My commission so far">+${moneyShort(c.commissionEarned)}</span>
                </div>
                <div class="chit-prog"><div class="acct-util good"><span style="width:${pctDone}%"></span></div>
                    <small>${done ? `${icon('check')}finished` : `month ${c.currentMonth} of ${c.months}`}</small></div>
            </div>
        </div>`;
    };
    const running2 = chits.filter(c => c.status === 'ACTIVE');
    const done = chits.filter(c => c.status !== 'ACTIVE');
    listEl.innerHTML = chits.length ? running2.map(row).join('')
        + (done.length ? `<div class="group-label"><span>Finished <i>${done.length}</i></span><b>${moneyShort(done.reduce((s, c) => s + num(c.commissionEarned), 0))}</b></div>${done.map(row).join('')}` : '')
        : emptyState('No hosted chits yet', 'hand-coins');
}

// ---------------------------------------------------------------- the selected chit

function drawDetail(container, d) {
    const old = container.querySelector('#hc-detail');
    const keepScroll = old.querySelector('#hc-tab')?.scrollTop || 0;
    const target = old.cloneNode(false);   // fresh element: no handlers left from the previous chit
    old.replaceWith(target);
    const c = d.chit;
    const done = c.status === 'COMPLETED';
    const month = d.schedule.find(m => m.status === 'ONGOING');
    const canManage = manage();
    const pctDone = (c.completedMonths / c.months) * 100;
    const nextAction = !canManage || !month ? '' : isAuction(c) && month.bid === null
        ? `<button class="btn sm gold-btn" data-act="winner" data-month="${month.monthNo}">${icon('gavel')}Record auction</button>`
        : !isAuction(c) && !month.winnerMemberId
            ? `<button class="btn sm gold-btn" data-act="winner" data-month="${month.monthNo}">${icon('crown')}Choose winner</button>`
            : `<button class="btn sm gold-btn" data-act="payout" data-month="${month.monthNo}">${icon('check')}Pay winner</button>`;

    target.innerHTML = `
        <section class="panel p-chit-head">
            <div class="chit-banner">
                <span class="hero-icon">${icon(typeIcon(c))}</span>
                <div class="ab-id">
                    <div class="ab-name">${esc(c.name)} ${typeBadge(c)} ${statusBadge(c.status)}${c.demo ? '<span class="badge gray">Example</span>' : ''}</div>
                    <div class="ab-meta">${[`${c.memberCount} members`, `${money(c.installment)} a month`, `from ${monthName(c.startMonth)}`, `due on the ${ordinal(c.dueDay)}`]
                        .map(esc).join('<i>·</i>')}</div>
                    <div class="cb-progress"><i class="split-bar on-dark"><span class="paid" style="width:${pctDone}%"></span></i>
                        <small>${done ? 'all months paid out' : `month ${c.currentMonth} of ${c.months} · ${c.completedMonths} paid out`}</small></div>
                </div>
                <div class="ab-bal">
                    <small>${done ? 'Commission earned' : isAuction(c) ? 'Chit value' : `Month ${c.currentMonth} chit value`}</small>
                    <b>${money(done ? c.commissionEarned : c.currentChitValue)}</b>
                    <span class="ab-change">${month ? `${month.winnerName ? `${esc(month.winnerName)} · ` : ''}winner gets ${month.estimated ? 'up to ' : ''}${money(month.payout)}` : 'finished'}</span>
                </div>
                <div class="ab-actions chit-actions">
                    ${nextAction}
                    ${canManage ? `<button class="btn sm on-dark" data-act="remind" title="Send payment reminders or receipts, by e-mail or WhatsApp">${icon('send')}Send</button>
                        <button class="btn sm on-dark" data-act="share" title="Share a temporary link to this chit">${icon('share')}Share</button>` : ''}
                    ${canManage && done ? `<button class="btn sm on-dark" data-act="copy-chit" title="Host a new chit with the same terms and members">${icon('copy')}Copy as a new chit</button>` : ''}
                    ${canManage ? `<button class="btn sm on-dark icon" data-act="settings" title="Settings">${icon('settings')}</button>` : ''}
                </div>
            </div>
            <div class="chit-key">
                ${keyTile('arrow-in', 'Collected so far', money(c.totalCollected), `from ${plural(c.memberCount, 'member')}`)}
                ${keyTile('crown', 'Paid to winners', money(c.totalPaidOut), `${plural(c.completedMonths, 'winner')} paid`)}
                ${keyTile('piggy', 'My commission', `<span class="gold-ink">${money(c.commissionEarned)}</span>`, `${money(c.commission)} each month`, 'gold')}
                ${keyTile(c.pendingCount || num(c.lateFeesDue) ? 'alert' : 'check-circle', 'Still to collect', c.pendingCount ? `<span class="neg">${money(c.pendingDues)}</span>` : money(0),
                    `${c.pendingCount ? `${plural(c.pendingCount, 'payment')} pending` : 'everyone has paid'}${num(c.lateFeesDue) ? ` · +${money(c.lateFeesDue)} late interest` : ''}`, c.pendingCount ? 'alert' : '')}
            </div>
            <div class="chit-statline">
                <span title="Collected minus paid out and commission">${icon('wallet')}Money with me <b class="${num(c.held) < 0 ? 'neg' : ''}">${money(c.held)}</b></span>
                ${isAuction(c) ? `<span title="Lowest bid = your commission; highest bid allowed">${icon('gavel')}Bids <b>${moneyShort(c.minBid)}</b>–<b>${moneyShort(c.maxBid)}</b><small>${num(c.maxBidPercent)}%</small></span>`
                    : isPlanned(c) ? plannedStatline(d)
                    : `<span title="Chit value goes up each month by">${icon('trending')}Rises <b>${money(c.monthlyIncrement)}</b><small>/month</small></span>
                       <span title="What a member pays on top after winning">${icon('hand-coins')}Winner extra <b>${num(c.winnerExtraAmount) ? money(c.winnerExtraAmount) : 'none'}</b></span>`}
                <span title="Interest on late installments">${icon('clock')}Late interest <b>${num(c.lateFeePercent) ? `${num(c.lateFeePercent)}%` : 'none'}</b>${num(c.lateFeePercent) ? `<small>/month after ${c.lateGraceDays} days</small> · collected <b>${money(c.lateFeesCollected)}</b>` : ''}</span>
                ${c.upiId ? `<span title="Payment links use this UPI ID">${icon('qr')}UPI <b>${esc(c.upiId)}</b></span>` : ''}
                <span title="${c.postToBooks ? 'Recorded in the journal and accounts' : 'Tracked on this page only'}">${icon(c.postToBooks ? 'journal' : 'lock')}${c.postToBooks
                    ? `Payments → <b>${esc(c.accountName || 'Cash in Hand')}</b>${c.commissionAccountName ? ` · commission → <b>${esc(c.commissionAccountName)}</b>` : ''}${c.lateFeeAccountName ? ` · late interest → <b>${esc(c.lateFeeAccountName)}</b>` : ''}${c.commissionCategoryName ? ` · income: <b>${esc(c.commissionCategoryName)}</b>` : ''}`
                    : 'Not in my accounts'}</span>
            </div>
        </section>
        <div class="hc-detail-rest">${panel({
            title: 'Chit book', iconName: 'journal', cls: 'p-chit-tabs', bodyClass: 'flush',
            actions: `${exportButton({ label: '' })}<div class="tabs sm" id="hc-tabs">${TABS.map(t =>
                `<button class="tab ${view.tab === t.key ? 'active' : ''}" data-tab="${t.key}">${icon(t.iconName)}<span class="hc-tab-label">${t.label}</span></button>`).join('')}</div>`,
            body: '<div class="scroll chit-tab-body" id="hc-tab"></div>',
        })}</div>`;

    const body = target.querySelector('#hc-tab');
    const drawTab = () => {
        body.innerHTML = { month: thisMonthHtml, dues: duesHtml, months: monthsHtml, money: moneyHtml, payments: paymentsHtml, members: membersHtml,
            agreements: agreementsHtml, history: historyHtml }[view.tab](d);
    };
    drawTab();
    body.scrollTop = keepScroll;
    bindExport(target.querySelector('.p-chit-tabs'), () => exportReport(d));

    target.addEventListener('click', async e => {
        const tab = e.target.closest('[data-tab]');
        if (tab) {
            view.tab = tab.dataset.tab;
            history.replaceState(null, '', `#/host-chits/${c.id}/${view.tab}`);
            target.querySelectorAll('#hc-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
            drawTab();
            body.scrollTop = 0;
            return;
        }
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const act = el.dataset.act;
        const m = el.dataset.month ? monthOf(d, Number(el.dataset.month)) : null;
        const memberId = Number(el.dataset.member);
        const monthNo = Number(el.dataset.no);
        try {
            if (act === 'settings') openSettings(d);
            else if (act === 'remind') openSend(d, { kind: 'REMINDER', memberId: el.dataset.member ? memberId : null });
            else if (act === 'send-receipts') openSend(d, { kind: 'RECEIPT' });
            else if (act === 'share') openShare(d, el.dataset.member ? memberId : null);
            else if (act === 'goto') target.querySelector(`#hc-tabs [data-tab="${el.dataset.to}"]`).click();
            else if (act === 'quick-paid') openQuickPaid(d, memberId, monthNo);
            else if (act === 'revert-batch') {
                const list = d.payments.filter(p => p.batchId === el.dataset.batch);
                if (!await confirmDialog(`Undo the ${plural(list.length, 'payment')} (${money(list.reduce((s, p) => s + num(p.amount), 0))}) marked paid at once for month ${monthNo}? Their journal entries are removed.`,
                    { title: 'Revert “everyone has paid”', confirmLabel: 'Revert' })) return;
                await afterChange(await api.del(`/hosted-chits/${c.id}/months/${monthNo}/batches/${el.dataset.batch}`), `${plural(list.length, 'payment')} undone`);
            }
            else if (act === 'receipt') openReceipt(d, d.payments.find(x => x.id === Number(el.dataset.payment)));
            else if (act === 'statement') openStatement(d, d.members.find(x => x.id === memberId));
            else if (act === 'agreement') openAgreement(d, Number(el.dataset.month));
            else if (act === 'view-entry' || act === 'entry') openEntryDetail(Number(el.dataset.entry));
            else if (act === 'transfer') openTransfer({ chitId: c.id, toAccountId: el.dataset.to ? Number(el.dataset.to) : null,
                from: el.dataset.from ? [{ accountId: Number(el.dataset.from), amount: num(el.dataset.amount) }] : [],
                chitMoney: el.dataset.money === '1' ? true : el.dataset.money === '0' ? false : null, onDone: refreshChit });
            else if (act === 'consolidate') openTransfer({ chitId: c.id, toAccountId: c.accountId, chitMoney: true, onDone: refreshChit,
                from: d.money.spots.filter(s => !s.chitBook && num(s.amount) > 0).map(s => ({ accountId: s.accountId, amount: num(s.amount) })) });
            else if (act === 'go') { chitAccounts.focus(el.dataset.go); location.hash = '#/host-chits/accounts'; }
            else if (act === 'money-tab') { view.moneyTab = el.dataset.tab; drawTab(); }
            else if (act === 'plan-pdf') printPlan(draftFromChit(d));
            else if (act === 'plan-link') sharePlan(draftFromChit(d));
            else if (act === 'edit-plan') openPlanEditor(d);
            else if (act === 'view-plan') openPlanView(d);
            else if (act === 'copy-chit') openWizard(d);
            else if (act === 'pay-winner-direct') openPayWinnerDirect(d, Number(el.dataset.month));
            else if (act === 'pay') openPayment(d, memberId, monthNo);
            else if (act === 'collect-all') openCollectAll(d, monthNo);
            else if (act === 'winner') (isAuction(c) ? openAuction : openWinner)(d, m, el.dataset.random === '1');
            else if (act === 'clear-winner') {
                if (!await confirmDialog(`Remove ${m.winnerName} as the winner of month ${m.monthNo}?`, { confirmLabel: 'Remove' })) return;
                await afterChange(await api.del(`/hosted-chits/${c.id}/months/${m.monthNo}/winner`), isAuction(c) ? 'Auction result removed' : 'Winner removed');
            }
            else if (act === 'payout') openPayout(d, m);
            else if (act === 'undo-payout') {
                if (!await confirmDialog(`Undo paying ${money(m.payout)} to ${m.winnerName} for month ${m.monthNo}? The month opens again.`, { confirmLabel: 'Undo' })) return;
                await afterChange(await api.del(`/hosted-chits/${c.id}/months/${m.monthNo}/payout`), `Month ${m.monthNo} is open again`);
            }
            else if (act === 'edit-payment') {
                const p = d.payments.find(x => x.id === Number(el.dataset.payment));
                openPayment(d, p.memberId, p.monthNo, p);
            }
            else if (act === 'undo-payment') undoPayment(d, d.payments.find(x => x.id === Number(el.dataset.payment)));
            else if (act === 'edit-member') openMember(d, d.members.find(x => x.id === memberId));
            else if (act === 'history-kind') { view.historyKind = el.dataset.kind; drawTab(); }
            else if (act === 'ledger-open') body.querySelectorAll('details.hc-lg').forEach(x => { x.open = true; });
            else if (act === 'lg-expand') {
                const more = el.parentElement.querySelector('.hc-lg-more');
                more.hidden = !more.hidden;
                el.classList.toggle('open', !more.hidden);
            }
            else if (act === 'dues-filter') { view.duesFilter = el.dataset.kind; drawTab(); }
            else if (act === 'delete-chit') openDelete(d);
        } catch (err) {
            el.disabled = false;
            toast(err.message, 'error');
        }
    });
    target.addEventListener('input', e => {
        if (e.target.id === 'hc-ledger-search') {
            view.ledgerQuery = e.target.value;
            const q = view.ledgerQuery.trim().toLowerCase();
            target.querySelectorAll('[data-lg-name]').forEach(r => { r.hidden = !!q && !r.dataset.lgName.includes(q); });
            if (q) target.querySelectorAll('details.hc-lg').forEach(x => { x.open = true; });
            return;
        }
        if (e.target.id !== 'hc-member-search') return;
        view.memberQuery = e.target.value;
        const q = view.memberQuery.trim().toLowerCase();
        target.querySelectorAll('[data-member-row]').forEach(r => { r.hidden = !!q && !r.dataset.memberRow.includes(q); });
    });
}

/** After a transfer: the chit again from the server (its money moved). */
/**
 * The chit table of a running chit, to read (with your commission) and to share with the members as a PDF or a link
 * (without it). Once the chit has started it cannot change; this is how it is seen.
 */
function openPlanView(d) {
    const c = d.chit;
    const w = draftFromChit(d);
    const plan = planOf(w);
    const res = isPlanned(c) ? reserveOf(plan.rows) : null;
    openModal({
        title: `${isAuction(c) ? 'How the auction works' : 'Chit table'} · ${c.name}`, iconName: isAuction(c) ? 'gavel' : 'calendar', size: 'xl',
        body: `<div class="hc-plan-view-head">
                <span>${typeBadge(c)} ${c.memberCount} members · ${c.months} months · ${monthName(c.startMonth)} – ${monthName(d.schedule.at(-1).dueDate)}</span>
                ${res ? `<span>net commission <b class="${res.total < 0 ? 'neg' : 'gold-ink'}">${signedMoney(res.total)}</b>${res.peak ? ` · keep up to <b>${money(res.peak)}</b>` : ''}</span>` : ''}
                ${c.termsLocked ? `<span class="badge gray">${icon('lock')}fixed: the chit has started</span>` : ''}</div>
            <div class="hc-plan-wrap hc-plan-modal">${planTableHtml(w, plan, {})}</div>
            <p class="muted hc-small">${icon('info')}Members get the table without your commission.</p>`,
        actions: [
            { label: 'PDF for members', left: true, iconName: 'printer', onClick: () => { printPlan(w); return true; } },
            { label: 'Share link', iconName: 'link', onClick: () => { setTimeout(() => sharePlan(w), 0); } },
            { label: 'Close', kind: 'primary' },
        ],
    });
}

/**
 * Planned chits: edit the chit table of a running chit. Months already paid out are locked; what members pay is
 * locked in months that have payments. "Fill evenly" spreads the open months' payouts from a first to a last figure.
 */
function openPlanEditor(d) {
    const c = d.chit;
    const w = draftFromChit(d);
    const locked = new Set(d.schedule.filter(m => m.status === 'COMPLETED').map(m => m.monthNo));
    const lockedEmi = new Set(d.payments.map(p => p.monthNo));
    const open = d.schedule.filter(m => !locked.has(m.monthNo));
    openModal({
        title: `Chit table · ${c.name}`, iconName: 'calendar', size: 'xl',
        body: `<div class="hc-plan-fill">
                <span>${icon('sparkles')}Open months: winner gets from</span>
                <input type="number" class="num" data-fill="first" value="${num(open[0]?.payout)}" step="1000" min="0" data-plain>
                <span>to</span>
                <input type="number" class="num" data-fill="last" value="${num(open.at(-1)?.payout)}" step="1000" min="0" data-plain>
                <button type="button" class="btn sm" data-fill-go ${open.length ? '' : 'disabled'}>Fill evenly</button>
                <span class="grow"></span><span data-plan-sum class="hc-plan-sum"></span></div>
            <div class="hc-plan-wrap hc-plan-modal" data-table></div>
            <p class="muted hc-small">${icon('lock')}Paid-out months keep their figures; what members pay stays in months with payments. Members see the new table through the share link or PDF.</p>`,
        actions: [
            { label: 'Cancel' },
            { label: 'Save the table', kind: 'primary', iconName: 'check', onClick: async () => {
                const bad = w.plan.findIndex(x => !(num(x.payout) > 0) || !(num(x.installment) > 0));
                if (bad >= 0) throw new Error(`Month ${bad + 1}: enter what each member pays and what the winner gets`);
                const months = w.plan.map((x, i) => ({ monthNo: i + 1, installment: num(x.installment), payout: num(x.payout) }))
                    .filter(x => !locked.has(x.monthNo));
                await afterChange(await api.put(`/hosted-chits/${c.id}/plan`, { months }), 'Chit table saved');
            } },
        ],
        onOpen: modal => {
            const el = modal.el;
            const draw = () => {
                const plan = planOf(w);
                el.querySelector('[data-table]').innerHTML = planTableHtml(w, plan, { editable: true, locked, lockedEmi });
                const res = reserveOf(plan.rows);
                el.querySelector('[data-plan-sum]').innerHTML = `net commission <b class="${res.total < 0 ? 'neg' : 'gold-ink'}">${signedMoney(res.total)}</b>${res.peak ? ` · keep up to <b>${money(res.peak)}</b>` : ''}`;
            };
            draw();
            el.addEventListener('change', e => {
                const cell = e.target.closest('[data-plan-i]');
                if (!cell) return;
                const row = w.plan[Number(cell.dataset.planI)];
                if (cell.dataset.planField === 'installment') row.installment = num(e.target.value); else row.payout = num(e.target.value);
                draw();
            });
            el.querySelector('[data-fill-go]').addEventListener('click', () => {
                const first = num(el.querySelector('[data-fill="first"]').value);
                const last = num(el.querySelector('[data-fill="last"]').value);
                if (!(first > 0 && last > 0)) { modal.setError('Enter what the first and last open months pay'); return; }
                const idx = w.plan.map((_, i) => i).filter(i => !locked.has(i + 1));
                spreadPayouts(idx.length, first, last).forEach((p, k) => { w.plan[idx[k]].payout = p; });
                draw();
            });
        },
    });
}

async function refreshChit() {
    if (current) await afterChange(await api.get(`/hosted-chits/${current.chit.id}`));
}

/**
 * Money: where this chit's money is (its own accounts, common chit accounts, and personal accounts members paid into),
 * month by month how each payout was funded, and the transfers. The full picture is under Chit accounts.
 */
function moneyHtml(d) {
    const c = d.chit;
    if (!c.postToBooks) return `<div class="hc-pad"><p class="book-note">${icon('lock')}<span>This chit is not recorded in your accounts. Turn it on in Settings to follow its money by account.</span></p></div>`;
    const m = d.money;
    const parked = num(m.inPersonal);
    const sub = view.moneyTab || 'where';
    return `<div class="hc-members-tools">
            <div class="seg-chips sm">${[['where', 'Where it is', 'wallet'], ['months', 'Month by month', 'calendar'], ['moves', `Transfers${d.transfers.length ? ` (${d.transfers.length})` : ''}`, 'transfer']].map(([k, l, i]) =>
                `<button class="seg-chip ${sub === k ? 'active' : ''}" data-act="money-tab" data-tab="${k}">${icon(i)}${l}</button>`).join('')}</div>
            <span class="ca-sumline">held <b>${money(m.held)}</b> · owed <b>${money(m.owedToMembers)}</b> · mine <b class="gold-ink">${money(m.mine)}</b></span>
            <span class="grow"></span>
            ${manage() ? `${parked > 0 ? `<button class="btn sm gold-btn" data-act="consolidate">${icon('merge')}Consolidate ${moneyShort(parked)}</button>` : ''}
                <button class="btn sm" data-act="transfer" ${c.accountId ? `data-to="${c.accountId}"` : ''}>${icon('transfer')}Move money</button>` : ''}
            <button class="btn sm ghost" data-act="go" data-go="chit:${c.id}" title="Open in Chit accounts">${icon('wallet')}Chit accounts</button>
        </div>
        ${sub === 'where' ? whereHtml(null, { id: c.id, money: m, collectionAccountId: c.accountId })
            : sub === 'months' ? monthTrailHtml(d)
            : transfersTable(d.transfers, 'No money moved for this chit yet', { actions: false })}`;
}

/** Planned chits on the banner: this month's commission, and the commission to keep for months that pay out more. */
function plannedStatline(d) {
    const rows = d.schedule.map(m => ({ monthNo: m.monthNo, commission: num(m.commission), done: m.status === 'COMPLETED' }));
    const r = reserveOf(rows);
    const open = rows.filter(x => !x.done);
    const still = reserveOf(open).peak;
    return `<span title="Set month by month in the chit table">${icon('calendar')}Chit table <b>${d.schedule.length} months</b></span>
        <span title="Commission over the whole chit (collected less paid out)">${icon('piggy')}Net commission <b class="${r.total < 0 ? 'neg' : ''}">${money(r.total)}</b></span>
        ${still > 0 ? `<span title="Later months pay out more than they collect: keep this much of your commission for them">${icon('shield')}Keep aside <b>${money(still)}</b></span>` : ''}`;
}

/**
 * A planned chit's commission month by month: the net, how much has to be kept for later months that pay out more
 * than they collect (peak, and the months), and whether the organiser has to put in money of their own.
 */
function reserveOf(rows) {
    let cum = 0;
    const cumulative = rows.map(x => (cum += num(x.commission)));
    let peak = 0, from = null, to = null;
    for (let t = 0; t < rows.length; t++) {
        const base = t === 0 ? 0 : cumulative[t - 1];
        let low = base;
        let at = null;
        for (let j = t; j < rows.length; j++) if (cumulative[j] < low) { low = cumulative[j]; at = j; }
        if (base - low > peak) { peak = base - low; from = rows[t].monthNo; to = rows[at].monthNo; }
    }
    const minCum = Math.min(0, ...cumulative);
    return { total: cumulative.at(-1) || 0, cumulative, peak, from, to, ownMoney: -minCum,
        negative: rows.filter(x => num(x.commission) < 0).map(x => x.monthNo) };
}

function keyTile(iconName, label, value, note, cls = '') {
    return `<div class="ck-tile ${cls}"><span class="ck-icon">${icon(iconName)}</span>
        <div class="min-0 grow"><small>${esc(label)}</small><b>${value}</b><span class="ck-note">${note}</span></div></div>`;
}

// ---------------------------------------------------------------- This month

function thisMonthHtml(d) {
    const c = d.chit;
    const month = d.schedule.find(m => m.status === 'ONGOING');
    const canManage = manage();
    const older = [];
    d.schedule.filter(m => !month || m.monthNo < month.monthNo).forEach(m => d.members.forEach(mem => {
        const rest = dueFor(d, mem, m) - paidFor(d, mem.id, m.monthNo);
        const late = num(lateFor(d, mem.id, m.monthNo)?.due);
        if (rest > 0 || late > 0) older.push({ mem, m, rest: Math.max(0, rest) + late });
    }));
    const olderHtml = older.length ? `
        <section class="hc-block">
            <div class="hc-block-head">${icon('alert')}<b>Still owed from earlier months</b><span class="muted">${money(older.reduce((s, x) => s + x.rest, 0))}</span></div>
            <div class="hc-people">${older.map(x => personRow(d, x.mem, x.m, canManage, `month ${x.m.monthNo} (${shortMonth(x.m.dueDate)})`)).join('')}</div>
        </section>` : '';
    if (!month) {
        return `<div class="hc-pad">${emptyState(`All ${c.months} months are done. You earned ${money(c.commissionEarned)} in commission.`, 'check-circle')}${olderHtml}</div>`;
    }
    const rows = d.members.map(m => ({ m, paid: paidFor(d, m.id, month.monthNo), due: dueFor(d, m, month) }));
    const unpaid = rows.filter(r => r.paid < r.due);
    const paid = rows.filter(r => r.paid >= r.due);
    const collected = rows.reduce((s, r) => s + r.paid, 0);
    const expected = rows.reduce((s, r) => s + r.due, 0);
    const auction = isAuction(c);
    const decided = auction ? month.bid !== null : !!month.winnerMemberId;
    const late = daysFromToday(month.dueDate) < 0 && unpaid.length;
    const left = d.members.filter(m => !m.wonMonth).length;

    const collectStep = (no) => `
        <li class="hc-step ${!unpaid.length ? 'done' : auction && !decided ? 'waiting' : 'active'}">
            <div class="hc-step-head">
                <span class="hc-step-no">${!unpaid.length ? icon('check') : no}</span>
                <div class="min-0"><b>Collect ${auction ? (decided ? money(num(c.installment) - num(month.dividend)) : 'the installment') : money(c.installment)} from each member${!auction && rows.some(r => r.due > num(c.installment))
                    ? ` (${money(num(c.installment) + num(c.winnerExtraAmount))} from past winners)` : ''}</b>
                    <small>${paid.length} of ${d.members.length} paid · ${money(collected)} of ${money(expected)}${auction && !decided ? ' · the amount drops once the auction sets the dividend' : ''}</small></div>
                ${canManage && unpaid.length > 1 && decided ? `<button class="btn sm" data-act="collect-all" data-no="${month.monthNo}">${icon('check-circle')}Everyone has paid</button>` : ''}
            </div>
            <i class="ov-meter hc-meter"><em style="width:${expected ? Math.min(100, (collected / expected) * 100) : 0}%"></em></i>
            ${unpaid.length ? `<div class="hc-people">${unpaid.map(r => personRow(d, r.m, month, canManage, !auction && r.due > num(c.installment) ? `won month ${r.m.wonMonth}` : '')).join('')}</div>`
                : `<p class="hc-ok">${icon('check-circle')}Everyone has paid this month.</p>`}
            ${batchesHtml(d, month, canManage)}
            ${paid.length ? `<details class="hc-paid-list" ${unpaid.length ? '' : 'open'}><summary>Paid · ${paid.length}</summary><div class="hc-people">${paid.map(r => {
                const last = d.payments.filter(p => p.memberId === r.m.id && p.monthNo === month.monthNo).at(-1);
                return `<div class="hc-person paid ${canManage ? 'clickable' : ''}" ${canManage ? `data-act="pay" data-member="${r.m.id}" data-no="${month.monthNo}" title="Change it"` : ''}>
                    <span class="hc-avatar">${esc(initials(r.m.name))}</span>
                    <div class="min-0"><b class="ellipsis">${esc(r.m.name)}</b><small class="ellipsis">${last ? `${date(last.paidDate)} · ${esc(last.mode)} · ${esc(paidWhere(last))}` : ''}</small></div>
                    <span class="hc-paid-amt">${icon(last?.paidToMemberId ? 'hand' : 'check')}${money(r.paid)}</span>
                    ${canManage && last ? `<button class="btn sm ghost icon" data-act="undo-payment" data-payment="${last.id}" title="Take back this payment">${icon('undo')}</button>` : ''}</div>`;
            }).join('')}</div></details>` : ''}
        </li>`;

    const decideStep = (no) => auction ? `
        <li class="hc-step ${decided ? 'done' : 'active'}">
            <div class="hc-step-head">
                <span class="hc-step-no">${decided ? icon('check') : no}</span>
                <div class="min-0"><b>Hold the auction</b>
                    <small>${decided ? `Won at a bid of ${money(month.bid)} · dividend ${money(month.dividend)} a member`
                        : left <= 1 ? 'Only one member is left: they take the chit at the lowest bid'
                        : `${left} members can bid · bids from ${money(c.minBid)} (your commission) to ${money(c.maxBid)}`}</small></div>
            </div>
            ${decided ? `<div class="hc-winner-box"><span class="hc-avatar gold">${icon('gavel')}</span><div class="min-0"><b>${esc(month.winnerName)}</b>
                    <small>bid ${money(month.bid)} → gets ${money(month.payout)}</small></div>
                    ${canManage ? `<span class="spacer"></span><button class="btn sm ghost" data-act="clear-winner" data-month="${month.monthNo}">Remove</button>
                    <button class="btn sm" data-act="winner" data-month="${month.monthNo}">${icon('edit')}Change</button>` : ''}</div>`
                : canManage ? `<div class="row wrap hc-step-actions"><button class="btn primary" data-act="winner" data-month="${month.monthNo}">${icon('gavel')}Record the winning bid</button></div>` : ''}
        </li>` : `
        <li class="hc-step ${decided ? 'done' : 'active'}">
            <div class="hc-step-head">
                <span class="hc-step-no">${decided ? icon('check') : no}</span>
                <div class="min-0"><b>Choose this month's winner</b>
                    <small>${decided ? (month.drawMethod === 'Random draw' ? 'Picked by random draw' : 'Picked by you') : `${left} members have not won yet`}</small></div>
            </div>
            ${decided ? `<div class="hc-winner-box"><span class="hc-avatar gold">${icon('crown')}</span><b>${esc(month.winnerName)}</b>
                    ${canManage ? `<span class="spacer"></span><button class="btn sm ghost" data-act="clear-winner" data-month="${month.monthNo}">Remove</button>
                    <button class="btn sm" data-act="winner" data-month="${month.monthNo}">${icon('refresh')}Change</button>` : ''}</div>`
                : canManage ? `<div class="row wrap hc-step-actions"><button class="btn primary" data-act="winner" data-month="${month.monthNo}">${icon('users')}Pick a member</button>
                    <button class="btn" data-act="winner" data-random="1" data-month="${month.monthNo}">${icon('dice')}Random draw</button></div>` : ''}
        </li>`;

    const directPaid = d.payments.filter(p => p.monthNo === month.monthNo && p.paidToMemberId && p.paidToMemberId === month.winnerMemberId)
        .reduce((s, p) => s + num(p.amount), 0);
    const payStep = (no) => `
        <li class="hc-step ${decided ? 'active' : 'waiting'}">
            <div class="hc-step-head">
                <span class="hc-step-no">${no}</span>
                <div class="min-0"><b>Pay the winner</b>
                    <small>${decided ? `Give ${money(month.payout)} to ${esc(month.winnerName)}, then mark it done. This closes month ${month.monthNo}.` : auction ? 'Hold the auction first' : 'Choose the winner first'}
                        ${decided && directPaid ? `<br>${icon('hand')}${money(directPaid)} of it is already with ${esc(month.winnerName)}: members paid directly.` : ''}</small></div>
            </div>
            ${canManage && decided ? `<div class="row wrap hc-step-actions"><button class="btn primary" data-act="payout" data-month="${month.monthNo}">${icon('check')}I paid ${money(month.payout)} to ${esc(month.winnerName)}</button>
                ${unpaid.length ? `<button class="btn" data-act="pay-winner-direct" data-month="${month.monthNo}" title="Share ${esc(month.winnerName)}’s UPI ID and mobile number so members pay them directly">${icon('share')}Members pay ${esc(month.winnerName.split(' ')[0])} directly…</button>` : ''}
                ${unpaid.length ? `<small class="neg">${plural(unpaid.length, 'member')} still to pay</small>` : ''}</div>` : ''}
        </li>`;

    return `
    <div class="hc-pad">
        <section class="hc-month-intro">
            <div class="min-0">
                <small>Month ${month.monthNo} of ${c.months}</small>
                <h3>${monthName(month.dueDate)}</h3>
                <p>Members pay by <b>${date(month.dueDate)}</b> <span class="${late ? 'neg' : 'muted'}">(${relDays(month.dueDate)})</span></p>
            </div>
            <div class="hc-pot">
                <span><small>Chit value</small><b>${money(month.chitValue)}</b></span>
                <i>−</i>
                ${auction ? `<span><small>Winning bid</small><b>${month.bid !== null ? money(month.bid) : '?'}</b></span>`
                    : isPlanned(c) && num(month.commission) < 0 ? `<span><small>From my commission</small><b class="neg">+${money(-num(month.commission))}</b></span>`
                    : `<span><small>My commission</small><b class="gold-ink">${money(month.commission)}</b></span>`}
                <i>=</i>
                <span class="win"><small>Winner gets</small><b>${month.estimated ? 'up to ' : ''}${money(month.payout)}</b></span>
            </div>
        </section>
        ${auction && month.bid !== null ? `<p class="book-note">${icon('info')}<span>Of the ${money(month.bid)} bid, you keep ${money(month.commission)} as commission and
            ${money(num(month.bid) - num(month.commission))} is shared: <b>${money(month.dividend)}</b> for each of the ${d.members.length} members, so everyone pays
            <b>${money(num(c.installment) - num(month.dividend))}</b> instead of ${money(c.installment)} this month.</span></p>` : ''}
        <ol class="hc-flow">${auction ? decideStep(1) + collectStep(2) + payStep(3) : collectStep(1) + decideStep(2) + payStep(3)}</ol>
        ${olderHtml}
    </div>`;
}

/** Where a payment went: the account it came into, or the winner it was paid to directly. */
function paidWhere(p) {
    if (!p.paidToMemberId) return p.accountName ? `into ${p.accountName}` : '';
    return p.paidToMemberId === p.memberId ? 'set off against the payout' : `paid ${p.paidToName} directly`;
}

/** Payments recorded together ("Everyone has paid") for the month, each batch with a way to revert it. */
function batchesHtml(d, month, canManage) {
    const batches = new Map();
    d.payments.filter(p => p.monthNo === month.monthNo && p.batchId).forEach(p => {
        if (!batches.has(p.batchId)) batches.set(p.batchId, []);
        batches.get(p.batchId).push(p);
    });
    return [...batches].map(([id, list]) => `<div class="hc-batch">${icon(list[0].paidToMemberId ? 'hand' : 'check-circle')}
        <span class="grow min-0">${plural(list.length, 'member')} marked paid at once · ${date(list[0].paidDate)} · <b>${money(list.reduce((s, p) => s + num(p.amount), 0))}</b>
            <small class="muted">${esc(list[0].paidToMemberId ? `paid ${list[0].paidToName} directly` : paidWhere(list[0]))}</small></span>
        ${canManage && !month.payoutDate ? `<button class="btn sm ghost" data-act="revert-batch" data-batch="${id}" data-no="${month.monthNo}" title="Undo all of them">${icon('undo')}Revert</button>` : ''}</div>`).join('');
}

/**
 * "Paid": a quick confirmation before anything is recorded, with what is due, the date, the mode and the account it
 * came into at hand; or that the member paid this month's winner directly (the winner's own installment: set off
 * against the payout). "More options" opens the full payment form (part payments, late interest, evidence).
 */
async function openQuickPaid(d, memberId, monthNo) {
    const c = d.chit;
    const member = d.members.find(x => x.id === memberId);
    const month = monthOf(d, monthNo);
    if (isAuction(c) && month.bid === null) { toast('Record the auction first: the dividend decides what each member pays', 'error'); return; }
    const rest = Math.max(0, dueFor(d, member, month) - paidFor(d, memberId, monthNo));
    const late = num(lateFor(d, memberId, monthNo)?.due);
    const accounts = c.postToBooks ? await loadAccounts(false, { all: true }).catch(() => []) : [];
    const lastInto = d.payments.filter(p => p.memberId === memberId && p.accountId && !p.paidToMemberId).sort((a, b) => b.id - a.id)[0]?.accountId;
    const winner = month.winnerMemberId && !month.payoutDate ? d.members.find(m => m.id === month.winnerMemberId) : null;
    let direct = false;
    openModal({
        title: `${member.name} has paid?`, iconName: 'check-circle',
        body: `
        <div class="hc-confirm">
            <span class="hc-avatar">${esc(initials(member.name))}</span>
            <div class="min-0 grow"><b>${esc(member.name)}</b><small>month ${monthNo} · due ${date(month.dueDate)}</small></div>
            <b class="hc-confirm-amt" data-total>${money(rest + late)}</b>
        </div>
        ${late ? `<p class="muted hc-small" data-late>${icon('clock')}Includes ${money(late)} late interest.</p>` : ''}
        ${winner ? `<div class="seg-chips hc-to" data-to>
            <button type="button" class="seg-chip active" data-direct="0">${icon('arrow-in')}Paid to me</button>
            <button type="button" class="seg-chip" data-direct="1">${icon('hand')}${winner.id === memberId ? 'Set off against the payout' : `Paid ${esc(winner.name)} directly`}</button></div>
            <p class="hc-note" data-direct-note hidden>${icon('info')}<span>${winner.id === memberId
                ? `${esc(member.name)} won this month: the installment is kept back from the ${money(month.payout)} payout.`
                : `The money went straight to the winner, ${esc(winner.name)}. It counts towards ${esc(member.name)}'s installment and is taken off what you pay ${esc(winner.name)}.`}
                ${late ? ` Late interest (${money(late)}) is yours: it stays due.` : ''}</span></p>` : ''}
        <form class="form-grid two" onsubmit="return false">
            <label class="field"><span>Paid on</span><input type="date" name="paidDate" value="${isoDate()}" max="${isoDate()}"></label>
            <label class="field"><span>Reference <small class="muted">optional</small></span><input type="text" name="reference" maxlength="60" placeholder="UPI ref / UTR" data-plain></label>
            <div class="field span-2"><span>Paid by</span>${modeChips('UPI')}</div>
            ${c.postToBooks ? `<label class="field span-2" data-into><span>Received into</span><select name="accountId">${moneyAccountOptions(accounts,
                { chitId: c.id, chitName: c.name, selected: member?.payToAccountId || lastInto || c.payToAccountId || c.accountId })}</select></label>` : ''}
        </form>`,
        actions: [
            { label: 'More options…', left: true, onClick: () => { setTimeout(() => openPayment(d, memberId, monthNo), 0); } },
            { label: 'Cancel' },
            { label: 'Yes, record it', kind: 'primary', iconName: 'check', onClick: async modal => {
                const f = modal.el.querySelector('form');
                const into = f.accountId?.value;
                if (f.paidDate.value && f.paidDate.value > isoDate()) throw new Error('The payment date cannot be in the future');
                if (c.postToBooks && !direct && !into) throw new Error('Pick the account the money came into');
                const fresh = await api.post(`/hosted-chits/${c.id}/payments`, {
                    memberId, monthNo, amount: rest, lateFee: direct ? 0 : late, mode: chosenMode(modal.el), paidDate: f.paidDate.value || isoDate(),
                    reference: f.reference.value.trim() || null, accountId: !direct && into ? Number(into) : null, paidToMemberId: direct ? winner.id : null,
                });
                await afterChange(fresh, `${member.name} paid ${money(rest + (direct ? 0 : late))}${direct ? (winner.id === memberId ? ' · set off' : ` to ${winner.name}`) : ''} ✓`);
            } },
        ],
        onOpen: modal => {
            bindModeChips(modal.el);
            modal.el.querySelector('[data-to]')?.addEventListener('click', e => {
                const b = e.target.closest('[data-direct]');
                if (!b) return;
                direct = b.dataset.direct === '1';
                modal.el.querySelectorAll('[data-to] [data-direct]').forEach(x => x.classList.toggle('active', x === b));
                modal.el.querySelector('[data-direct-note]').hidden = !direct;
                const intoField = modal.el.querySelector('[data-into]');
                if (intoField) intoField.hidden = direct;
                modal.el.querySelector('[data-late]')?.toggleAttribute('hidden', direct);
                modal.el.querySelector('[data-total]').textContent = money(rest + (direct ? 0 : late));
            });
            // a member pointed at this month's winner pays them directly by default
            if (winner && member.payToMemberId === winner.id) modal.el.querySelector('[data-direct="1"]')?.click();
        },
    });
}

/** A member who owes money: name, a hint, the amount and the buttons to record it or remind them. */
/** A member who owes money: what is left of the month (part payments show as a bar), late interest, and the buttons. */
function personRow(d, m, month, canManage, note = '') {
    const due = dueFor(d, m, month);
    const paid = paidFor(d, m.id, month.monthNo);
    const rest = Math.max(0, due - paid);
    const late = lateFor(d, m.id, month.monthNo);
    const total = rest + num(late?.due);
    const waiting = isAuction(d.chit) && month.bid === null;   // what each pays depends on the auction's dividend
    const hint = [note, waiting ? 'pays once the auction sets the dividend' : rest === 0 ? 'installment paid' : paid > 0 ? `paid ${money(paid)} of ${money(due)}` : m.phone || ''].filter(Boolean).join(' · ');
    return `<div class="hc-person">
        <span class="hc-avatar">${esc(initials(m.name))}</span>
        <div class="min-0"><b class="ellipsis">${esc(m.name)}</b><small>${esc(hint)}</small>
            ${late ? `<small class="hc-late">${icon('clock')}+${money(late.due)} late interest · ${late.daysLate ? `${late.daysLate} days late` : 'paid late'}</small>` : ''}
            ${paid > 0 && rest > 0 ? `<i class="hc-part" title="Part paid"><em style="width:${Math.min(100, (paid / due) * 100)}%"></em></i>` : ''}</div>
        <b class="hc-owe" title="${rest ? `${money(rest)} installment` : ''}${late ? ` + ${money(late.due)} late interest` : ''}">${money(total)}</b>
        ${canManage ? `<span class="hc-person-acts">
            <button class="btn sm ghost icon" data-act="remind" data-member="${m.id}" title="Send a reminder with a payment link">${icon('bell')}</button>
            ${waiting ? `<span class="badge gray" title="Record the auction first: the dividend decides what each member pays">${icon('gavel')}After the auction</span>` : `
            <button class="btn sm ghost" data-act="pay" data-member="${m.id}" data-no="${month.monthNo}" title="A part payment, or a different date, mode or reference">Part</button>
            <button class="btn sm primary" data-act="quick-paid" data-member="${m.id}" data-no="${month.monthNo}" title="Record ${money(total)}${late ? ' (with the late interest)' : ''}: you confirm the date, mode and account first">${icon('check')}Paid</button>`}</span>` : ''}
    </div>`;
}

// ---------------------------------------------------------------- dues

/** Every payment still pending: overdue, part paid, late interest, and this month's. */
function duesRows(d) {
    const today = isoDate();
    const rows = [];
    d.members.forEach(m => d.schedule.filter(s => s.due).forEach(s => {
        const due = dueFor(d, m, s), paid = paidFor(d, m.id, s.monthNo);
        const rest = Math.max(0, due - paid);
        const late = lateFor(d, m.id, s.monthNo);
        if (rest <= 0 && !late) return;
        const overdue = rest > 0 && s.dueDate < today;
        rows.push({ m, s, due, paid, rest, late: num(late?.due), days: overdue ? daysFromToday(s.dueDate) * -1 : 0,
            overdue, partial: paid > 0 && rest > 0, thisMonth: rest > 0 && s.dueDate >= today });
    }));
    return rows.sort((a, b) => b.days - a.days || a.s.monthNo - b.s.monthNo || a.m.slot - b.m.slot);
}

function duesHtml(d) {
    const all = duesRows(d);
    const groups = {
        ALL: ['All', all],
        OVERDUE: ['Overdue', all.filter(r => r.overdue)],
        PARTIAL: ['Part paid', all.filter(r => r.partial)],
        LATE: ['Late interest', all.filter(r => r.late > 0)],
        MONTH: ['Due this month', all.filter(r => r.thisMonth)],
    };
    const rows = groups[view.duesFilter]?.[1] || all;
    const sum = (list, f) => list.reduce((s, r) => s + f(r), 0);
    const canManage = manage();
    const status = r => r.overdue ? `<span class="badge critical">${icon('alert-circle')}Overdue${r.partial ? ' · part paid' : ''}</span>`
        : r.thisMonth ? `<span class="badge ${r.partial ? 'warning' : 'gray'}">${icon('clock')}${r.partial ? 'Part paid' : 'Due'}</span>`
        : `<span class="badge warning">${icon('clock')}Late interest</span>`;
    return `<div class="hc-dues-head">
            <div class="seg-chips sm">${Object.entries(groups).map(([k, [label, list]]) =>
                `<button class="seg-chip ${view.duesFilter === k ? 'active' : ''}" data-act="dues-filter" data-kind="${k}">${label}<span class="count">${list.length}</span></button>`).join('')}</div>
            <span class="spacer"></span>
            ${canManage && all.length ? `<button class="btn sm" data-act="remind">${icon('send')}Send all reminders</button>` : ''}
        </div>
        <div class="hc-dues-sum">
            <span><small>Overdue</small><b class="neg">${money(sum(groups.OVERDUE[1], r => r.rest))}</b></span>
            <span><small>Part paid, balance</small><b>${money(sum(groups.PARTIAL[1], r => r.rest))}</b></span>
            <span><small>Late interest</small><b>${money(sum(all, r => r.late))}</b></span>
            <span><small>Due this month</small><b>${money(sum(groups.MONTH[1], r => r.rest))}</b></span>
        </div>
        ${rows.length ? `<table class="grid compact">
            <thead><tr><th>Member</th><th class="c">Month</th><th>Pay by</th><th class="r">Late by</th><th class="r">Due</th><th class="r">Paid</th>
                <th class="r">Balance</th><th class="r">Late int.</th><th>Status</th>${canManage ? '<th></th>' : ''}</tr></thead>
            <tbody>${rows.map(r => `<tr>
                <td><span class="hc-name"><span class="hc-avatar sm">${esc(initials(r.m.name))}</span><b>${esc(r.m.name)}</b></span>${r.m.phone ? ` <small class="muted">${esc(r.m.phone)}</small>` : ''}</td>
                <td class="c">${r.s.monthNo}</td>
                <td>${date(r.s.dueDate)}</td>
                <td class="r ${r.days ? 'neg' : 'muted'}">${r.days ? `${r.days} d` : '—'}</td>
                <td class="r">${money(r.due)}</td>
                <td class="r">${r.paid ? money(r.paid) : '—'}</td>
                <td class="r"><b class="${r.rest ? 'neg' : ''}">${r.rest ? money(r.rest) : '—'}</b></td>
                <td class="r">${r.late ? money(r.late) : '—'}</td>
                <td>${status(r)}</td>
                ${canManage ? `<td class="r hc-nowrap">
                    <button class="btn sm ghost icon" data-act="remind" data-member="${r.m.id}" title="Send a reminder">${icon('bell')}</button>
                    <button class="btn sm" data-act="pay" data-member="${r.m.id}" data-no="${r.s.monthNo}">${icon('check')}Collect</button></td>` : ''}
            </tr>`).join('')}</tbody>
            <tfoot><tr class="total"><td colspan="6">Total · ${rows.length} item${rows.length === 1 ? '' : 's'}</td>
                <td class="r neg">${money(sum(rows, r => r.rest))}</td><td class="r">${money(sum(rows, r => r.late))}</td><td colspan="${canManage ? 2 : 1}"></td></tr></tfoot>
        </table>` : emptyState(view.duesFilter === 'ALL' ? 'Nothing pending: everyone is up to date' : 'Nothing in this list', 'check-circle')}`;
}

// ---------------------------------------------------------------- agreements

function agreementsHtml(d) {
    const list = d.agreements || [];
    const missing = d.schedule.filter(m => m.status === 'COMPLETED' && !list.some(a => a.monthNo === m.monthNo));
    const accepted = list.filter(a => a.status !== 'DRAFT');
    const canManage = manage();
    return `<div class="hc-dues-sum">
            <span><small>Accepted or signed</small><b class="pos">${accepted.length}</b></span>
            <span><small>Waiting for the member</small><b>${list.length - accepted.length}</b></span>
            <span><small>Payouts without one</small><b class="${missing.length ? 'neg' : ''}">${missing.length}</b></span>
            <span><small>Amount covered</small><b>${money(accepted.reduce((s, a) => s + num(a.payoutAmount), 0))}</b></span>
        </div>
        ${list.length || missing.length ? `<table class="grid compact">
            <thead><tr><th>Agreement</th><th class="c">Month</th><th>Member</th><th class="r">Received</th><th>Paid on</th><th>Status</th><th>Accepted by</th><th></th></tr></thead>
            <tbody>${list.map(a => {
                const [tone, ic, label] = AGREEMENT_STATUS[a.status] || ['gray', 'info', a.status];
                return `<tr class="clickable" data-act="agreement" data-month="${a.monthNo}">
                    <td><b>${esc(a.agreementNo)}</b></td><td class="c">${a.monthNo}</td><td>${esc(a.memberName)}</td>
                    <td class="r">${money(a.payoutAmount)}</td><td>${date(a.payoutDate)}</td>
                    <td><span class="badge ${tone}">${icon(ic)}${label}</span></td>
                    <td>${a.acceptedAt ? `${esc(a.acceptedName)} <small class="muted">${dateTime(a.acceptedAt)}</small>
                        ${a.phoneMatches === true ? `<span class="badge good" title="Mobile number matches the record">${icon('phone')}✓</span>` : a.phoneMatches === false ? `<span class="badge critical" title="Mobile number differs from the record">${icon('phone')}!</span>` : ''}
                        ${a.signature ? `<span class="badge gray" title="Signature drawn">${icon('edit')}</span>` : ''}${a.acceptedLocation ? `<span class="badge gray" title="Location shared">${icon('flag')}</span>` : ''}` : '<span class="muted">—</span>'}</td>
                    <td class="r"><button class="btn sm ghost" data-act="agreement" data-month="${a.monthNo}">${icon('eye')}Open</button></td></tr>`;
            }).join('')}
            ${missing.map(m => `<tr><td><span class="muted">No agreement</span></td><td class="c">${m.monthNo}</td><td>${esc(m.winnerName || '')}</td>
                <td class="r">${money(m.payout)}</td><td>${date(m.payoutDate)}</td><td><span class="badge gray">${icon('info')}None</span></td><td></td>
                <td class="r">${canManage ? `<button class="btn sm" data-act="agreement" data-month="${m.monthNo}">${icon('file-text')}Make</button>` : ''}</td></tr>`).join('')}</tbody>
        </table>` : emptyState('No winner has been paid yet. An agreement is made when you pay a winner.', 'file-text')}`;
}

/**
 * Deleting a chit. Accepted agreements are legal records, so such a chit cannot be deleted. With money recorded,
 * deleting first reverts it (every payment and payout undone, their journal entries taken out of the books) and asks
 * for the chit's name; without, a plain confirmation is enough.
 */
async function openDelete(d) {
    const c = d.chit;
    const signed = (d.agreements || []).filter(a => a.status !== 'DRAFT');
    if (signed.length) {
        openModal({
            title: `Can't delete ${c.name}`, iconName: 'lock',
            body: `<p style="margin-top:0">${plural(signed.length, 'winner agreement')} ${signed.length === 1 ? 'has' : 'have'} been accepted or signed
                (${signed.map(a => esc(a.agreementNo)).join(', ')}). They are kept as legal records, so this chit stays.</p>
                <p class="muted hc-small">A finished chit simply moves to “Finished” in the list.</p>`,
            actions: [{ label: 'OK', kind: 'primary' }],
        });
        return;
    }
    const paid = d.payments;
    const payouts = d.schedule.filter(m => m.payoutDate);
    if (!paid.length && !payouts.length) {
        if (!await confirmDialog(`Delete “${c.name}” and its ${c.memberCount} members? Nothing has been recorded in it yet.`, { confirmLabel: 'Delete chit' })) return;
        await api.del(`/hosted-chits/${c.id}`);
        done();
        return;
    }
    const collected = paid.reduce((s, p) => s + num(p.amount) + num(p.lateFee), 0);
    const entries = paid.filter(p => p.journalEntryId).length + payouts.filter(m => m.payoutEntryId).length * 2;
    openModal({
        title: `Revert and delete ${c.name}`, iconName: 'alert', size: 'lg',
        body: `<p class="hc-note warn">${icon('alert')}<span>This chit has money recorded in it. Deleting it first <b>reverts</b> all of that:</span></p>
            <ul class="hc-revert">
                <li>${icon('undo')}<span><b>${plural(paid.length, 'payment')}</b> from members (${money(collected)}) are undone${paid.some(p => p.journalEntryId) ? ' and their journal entries removed from your accounts' : ''}</span></li>
                ${payouts.length ? `<li>${icon('undo')}<span><b>${plural(payouts.length, 'payout')}</b> to winners (${money(payouts.reduce((s, m) => s + num(m.payout), 0))}) and the commission booked on them are undone</span></li>` : ''}
                ${entries ? `<li>${icon('journal')}<span>About <b>${plural(entries, 'journal entry', 'journal entries')}</b> leave the journal, Income and the balance sheet; accounts made for this chit keep their name but no longer hold this money</span></li>` : ''}
                ${(d.agreements || []).length ? `<li>${icon('file-text')}<span>${plural(d.agreements.length, 'agreement')} not yet accepted and every share link stop working</span></li>` : ''}
                <li>${icon('users')}<span>${c.memberCount} members and the schedule are deleted</span></li>
            </ul>
            <p style="margin-bottom:4px">This cannot be undone. Download the chit first if you want a copy (Chit book → Download).</p>
            <label class="field"><span>Type the chit's name to confirm: <b>${esc(c.name)}</b></span><input type="text" name="confirm" autocomplete="off" data-plain></label>`,
        actions: [
            { label: 'Cancel' },
            { label: 'Revert everything and delete', kind: 'danger solid', iconName: 'trash', onClick: async modal => {
                const typed = modal.el.querySelector('[name=confirm]').value.trim();
                if (typed.toLowerCase() !== c.name.trim().toLowerCase()) throw new Error(`Type ${c.name} exactly to confirm`);
                await api.del(`/hosted-chits/${c.id}?revert=true&confirm=${encodeURIComponent(typed)}`);
                done();
            } },
        ],
    });
    function done() {
        toast(`${c.name} deleted`);
        view.selectedId = null;
        location.hash = '#/host-chits';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
}

// ---------------------------------------------------------------- months

function monthsHtml(d) {
    const c = d.chit;
    const auction = isAuction(c);
    const lastDone = c.completedMonths;
    const sum = k => d.schedule.reduce((s, m) => s + num(m[k]), 0);
    const planned = isPlanned(c);
    const tools = `<div class="hc-members-tools hc-months-tools">
        ${planned && manage() && !c.termsLocked ? `<button class="btn sm primary" data-act="edit-plan">${icon('edit')}Edit chit table</button>` : ''}
        <button class="btn sm ${planned && manage() && !c.termsLocked ? '' : 'primary'}" data-act="view-plan" title="${auction ? 'How the auction works' : 'The whole chit table'}, to read, print or share">${icon('eye')}${auction ? 'Auction guide' : 'View chit table'}</button>
        ${planned && c.termsLocked ? `<span class="badge gray" title="The chit has started: the table is what the members agreed to">${icon('lock')}Table fixed</span>` : ''}
        <button class="btn sm" data-act="plan-pdf" title="${auction ? 'How the auction works' : 'The chit table'}, for the members (without your commission)">${icon('printer')}${auction ? 'Auction guide' : 'Table'} PDF</button>
        <button class="btn sm" data-act="plan-link" title="A link for the members (without your commission)">${icon('link')}Share link</button>
        <span class="grow"></span>
        ${auction ? '' : `<a class="btn sm ghost" href="#/forecast/analyzer/${c.id}" title="Who gains and who pays interest in each month, and what to keep aside">${icon('calculator')}Analyse</a>`}
    </div>`;
    return `${tools}<table class="grid compact hc-months">
        <thead><tr><th class="c">Month</th><th>Pay by</th>${auction ? '<th class="r">Winning bid</th><th class="r">Dividend</th><th class="r">Each pays</th>'
            : planned ? '<th class="r">Each pays</th><th class="r">You collect</th>' : '<th class="r">Chit value</th>'}
            <th class="r">Winner gets</th>${planned ? '<th class="r" title="Collected less paid out">Commission</th>' : ''}<th>Winner</th><th class="r">Collected</th><th>Status</th><th>Agreement</th><th></th></tr></thead>
        <tbody>${d.schedule.map(m => `<tr class="${m.status === 'ONGOING' ? 'hc-now' : m.status === 'COMPLETED' ? 'hc-past' : ''}">
            <td class="c"><b>${m.monthNo}</b></td>
            <td>${date(m.dueDate)}</td>
            ${auction ? `<td class="r">${m.bid !== null ? money(m.bid) : '<span class="muted">—</span>'}</td>
                <td class="r">${m.bid !== null ? money(m.dividend) : '<span class="muted">—</span>'}</td>
                <td class="r">${money(num(c.installment) - num(m.dividend))}</td>` : planned ? `<td class="r">${money(m.installment)}</td><td class="r">${money(m.chitValue)}</td>` : `<td class="r">${money(m.chitValue)}</td>`}
            <td class="r"><b>${m.estimated ? '<small class="muted">up to</small> ' : ''}${money(m.payout)}</b></td>
            ${planned ? `<td class="r ${num(m.commission) < 0 ? 'neg' : 'gold-ink'}">${signedMoney(num(m.commission))}</td>` : ''}
            <td>${m.winnerName ? `<span class="hc-winner">${icon(auction ? 'gavel' : 'crown')}${esc(m.winnerName)}</span>` : '<span class="muted">—</span>'}</td>
            <td class="r" title="${m.paidCount} of ${d.members.length} paid in full">${m.due || num(m.collected) ? `${moneyShort(m.collected)} <small class="muted">${m.paidCount}/${d.members.length}</small>` : '<span class="muted">—</span>'}</td>
            <td>${statusBadge(m.status)}${m.payoutDate ? `<small class="muted hc-when">paid ${shortDate(m.payoutDate)}</small>` : ''}
                ${m.legs?.length > 1 ? `<small class="muted hc-when" title="${esc(m.legs.map(l => `${l.accountName}: ${money(l.amount)}${l.reference ? ` (${l.mode} ${l.reference})` : ''}`).join('\n'))}">${icon('split')}from ${m.legs.length} accounts</small>`
                    : m.legs?.length ? `<small class="muted hc-when">from ${esc(m.legs[0].accountName)}</small>` : ''}</td>
            <td>${m.status === 'COMPLETED' ? agreementChip(d, m) : '<span class="muted">—</span>'}</td>
            <td class="r">${m.status === 'ONGOING' ? `<button class="btn sm" data-act="goto" data-to="month">Open${icon('chevron-right')}</button>`
                : manage() && m.status === 'COMPLETED' && m.monthNo === lastDone ? `<button class="btn sm ghost" data-act="undo-payout" data-month="${m.monthNo}" title="Undo the payment to the winner">${icon('undo')}Undo</button>` : ''}</td>
        </tr>`).join('')}</tbody>
        <tfoot><tr class="total"><td colspan="2">Total</td>${auction ? `<td class="r">${money(sum('bid'))}</td><td></td><td></td>` : planned ? `<td></td><td class="r">${money(sum('chitValue'))}</td>` : `<td class="r">${money(sum('chitValue'))}</td>`}
            <td class="r">${money(sum('payout'))}</td>${planned ? `<td class="r ${sum('commission') < 0 ? 'neg' : 'gold-ink'}">${signedMoney(sum('commission'))}</td>` : ''}<td></td><td class="r">${moneyShort(sum('collected'))}</td><td colspan="3"></td></tr></tfoot>
    </table>`;
}

/** "Chrome 141 on Android 14" from a user agent. */
function deviceName(ua = '') {
    const os = /Android ([\d.]+)/.exec(ua)?.[0] || (/iPhone|iPad/.test(ua) ? `iOS ${(/OS ([\d_]+)/.exec(ua)?.[1] || '').replace(/_/g, '.')}` : '')
        || (/Windows NT/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown system');
    const browser = /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)[1]}` : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)[1]}`
        : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)[1]}` : /Safari\//.test(ua) ? 'Safari' : 'a browser';
    return `${browser} on ${os}`;
}

function signatureSvg(path) {
    const safe = String(path || '').replace(/[^MLml0-9 .-]/g, '');
    return `<svg viewBox="0 0 1000 300" class="hc-signature" role="img" aria-label="Signature"><path d="${safe}" fill="none" stroke="#0a2e4f" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** What was recorded when the member accepted: the evidence, laid out for the organiser (and for printing). */
function evidenceHtml(a, member) {
    const fingerprint = `<p class="hc-rc-foot">Agreement fingerprint (SHA-256): <code class="hc-hash">${esc(a.contentHash)}</code></p>`;
    if (!a.acceptedAt) return `<p class="hc-rc-foot">Not accepted yet.</p>${fingerprint}`;
    if (a.status === 'SIGNED') return `<p class="hc-rc-foot">Signed on paper by <b>${esc(a.acceptedName)}</b>, recorded ${dateTime(a.acceptedAt)} · ${esc(a.acceptedFrom || '')}</p>${fingerprint}`;
    let dev = {};
    try { dev = JSON.parse(a.acceptedDevice || '{}'); } catch { /* old record */ }
    const [lat, lng, acc] = (a.acceptedLocation || '').split(',');
    const onRecord = member?.phone ? member.phone.replace(/\D/g, '').slice(-10) : null;
    const phone = a.acceptedPhone ? `${esc(a.acceptedPhone)} ${a.phoneMatches === true ? '<span class="badge good">matches the member\'s number</span>'
        : a.phoneMatches === false ? `<span class="badge critical">differs from ${esc(onRecord || 'the record')}</span>` : '<span class="badge gray">no number on record</span>'}` : '—';
    const row = (label, value) => `<div class="hc-ev-row"><span>${label}</span><b>${value}</b></div>`;
    return `<div class="hc-evidence">
        <div class="hc-ev-title">${icon('shield')}Evidence of acceptance</div>
        <div class="hc-ev-grid">
            <div class="hc-ev-list">
                ${row('Name typed', esc(a.acceptedName))}
                ${row('Mobile number', phone)}
                ${row('Accepted at', `${dateTime(a.acceptedAt)} <small class="muted">server time</small>`)}
                ${dev.localTime ? row('Device clock', `${esc(dev.localTime.replace(/ \(.*\)$/, ''))}`) : ''}
                ${row('IP address', esc(a.acceptedIp || (a.acceptedFrom || '').replace(/^IP /, '').split(' · ')[0] || '—'))}
                ${row('Device', `${esc(deviceName(dev.userAgent || a.acceptedFrom || ''))}${dev.mobile ? ' · phone' : ''}`)}
                ${dev.screen ? row('Screen · language · time zone', `${esc(dev.screen)} · ${esc(dev.language || '')} · ${esc(dev.timeZone || '')}`) : ''}
                ${row('Location', lat ? `<a href="https://maps.google.com/?q=${encodeURIComponent(`${lat},${lng}`)}" target="_blank" rel="noopener">${esc(lat)}, ${esc(lng)}</a> <small class="muted">±${esc(acc || '?')} m</small>` : '<span class="muted">not shared</span>')}
                ${a.deviceHash ? row('Device fingerprint', `<code class="hc-hash">${esc(a.deviceHash)}</code>`) : ''}
            </div>
            <div class="hc-ev-sign">${a.signature ? `${signatureSvg(a.signature)}<small>Signature drawn by ${esc(a.acceptedName)}</small>` : '<span class="muted">No drawn signature</span>'}</div>
        </div>
        ${a.acceptanceSeal ? `<p class="hc-rc-foot">Acceptance seal (SHA-256 of the agreement and all of the above): <code class="hc-hash">${esc(a.acceptanceSeal)}</code></p>` : ''}
        ${fingerprint}
    </div>`;
}

const AGREEMENT_STATUS = { DRAFT: ['warning', 'clock', 'Not accepted yet'], ACCEPTED: ['good', 'check-circle', 'Accepted'], SIGNED: ['good', 'edit', 'Signed'] };

function agreementChip(d, m) {
    const a = (d.agreements || []).find(x => x.monthNo === m.monthNo);
    if (!a) return manage() ? `<button class="btn sm ghost" data-act="agreement" data-month="${m.monthNo}">${icon('file-text')}Make</button>` : '<span class="muted">—</span>';
    const [tone, ic, label] = AGREEMENT_STATUS[a.status] || ['gray', 'info', a.status];
    return `<button class="btn sm ghost hc-ag" data-act="agreement" data-month="${m.monthNo}" title="${esc(a.agreementNo)}"><span class="badge ${tone}">${icon(ic)}${label}</span></button>`;
}

// ---------------------------------------------------------------- payments grid

function paymentsHtml(d) {
    const c = d.chit;
    return `<div class="hc-legend">${Object.entries(CELL).map(([k, [sym, label]]) => `<span><i class="hc-cell ${k.toLowerCase()}">${sym}</i>${label}</span>`).join('')}
            <span><span class="hc-crown">${icon('crown')}</span>Has won</span>${manage() ? '<span class="muted">· tap a box to add or change a payment</span>' : ''}
            ${manage() && d.payments.length ? `<span class="spacer"></span><button class="btn sm" data-act="send-receipts">${icon('receipt')}Send receipts</button>` : ''}</div>
        <div class="hc-grid-wrap"><table class="hc-grid">
            <thead><tr><th class="hc-name-col">Member</th>${d.schedule.map(m =>
                `<th class="${m.status === 'ONGOING' ? 'now' : ''}" title="Month ${m.monthNo} · pay by ${date(m.dueDate)}">${m.monthNo}<small>${shortMonth(m.dueDate)}</small></th>`).join('')}
                <th class="r">Owes</th></tr></thead>
            <tbody>${d.members.map(mem => `<tr>
                <th class="hc-name-col" title="${esc(mem.name)}">${mem.wonMonth ? `<span class="hc-crown" title="Won month ${mem.wonMonth}">${icon('crown')}</span>` : ''}<span class="ellipsis">${esc(mem.name)}</span></th>
                ${d.schedule.map(m => {
                    const st = cellStatus(d, mem, m);
                    const open = manage() && !(isAuction(c) && m.bid === null);
                    const paid = paidFor(d, mem.id, m.monthNo);
                    const [sym, label] = CELL[st];
                    return `<td class="${m.status === 'ONGOING' ? 'now' : ''}"><button type="button" class="hc-cell ${st.toLowerCase()}"
                        ${open ? `data-act="pay" data-member="${mem.id}" data-no="${m.monthNo}"` : 'disabled'}
                        title="${esc(mem.name)} · month ${m.monthNo}: ${isAuction(c) && m.bid === null ? 'after the auction (the dividend decides the amount)' : label}${paid ? ` (${money(paid)} of ${money(dueFor(d, mem, m))})` : ''}">${st === 'PARTIAL' ? moneyShort(paid).replace('₹', '') : sym}</button></td>`;
                }).join('')}
                <td class="r ${num(mem.balanceDue) ? 'neg' : 'muted'}"><b>${num(mem.balanceDue) ? money(mem.balanceDue) : '—'}</b></td>
            </tr>`).join('')}</tbody>
            <tfoot><tr><th class="hc-name-col">Collected</th>${d.schedule.map(m =>
                `<td class="${m.status === 'ONGOING' ? 'now' : ''}" title="${money(m.collected)} of ${money(m.expected)}">${num(m.collected) ? moneyShort(m.collected) : ''}</td>`).join('')}
                <td class="r neg">${num(c.pendingDues) ? money(c.pendingDues) : '—'}</td></tr></tfoot>
        </table></div>`;
}

// ---------------------------------------------------------------- members

function membersHtml(d) {
    const q = view.memberQuery.trim().toLowerCase();
    const canManage = manage();
    return `<div class="hc-members-tools">
            <label class="hc-search">${icon('search')}<input type="search" id="hc-member-search" placeholder="Find a member" value="${esc(view.memberQuery)}"></label>
            <span class="muted">${d.members.length} members · ${d.members.filter(m => m.wonMonth).length} have won</span>
        </div>
        <table class="grid compact">
        <thead><tr><th class="c">#</th><th>Name</th><th>Phone · e-mail</th><th>Pays into</th><th>Won</th><th class="r">Paid</th><th class="r">Owes</th><th class="r">Late interest</th>${canManage ? '<th></th>' : ''}</tr></thead>
        <tbody>${d.members.map(m => {
            const key = (m.name + ' ' + (m.phone || '') + ' ' + (m.email || '')).toLowerCase();
            const won = m.wonMonth ? monthOf(d, m.wonMonth) : null;
            return `<tr data-member-row="${esc(key)}" ${q && !key.includes(q) ? 'hidden' : ''}>
                <td class="c muted">${m.slot}</td>
                <td><span class="hc-name"><span class="hc-avatar sm ${m.wonMonth ? 'gold' : ''}">${m.wonMonth ? icon('crown') : esc(initials(m.name))}</span><b>${esc(m.name)}</b></span></td>
                <td>${m.phone ? `<a href="tel:${esc(m.phone)}">${esc(m.phone)}</a>` : '<span class="muted">no phone</span>'}${m.email ? `<small class="hc-mail"><a href="mailto:${esc(m.email)}">${esc(m.email)}</a></small>` : ''}${m.upiId ? `<small class="hc-mail">UPI ${esc(m.upiId)}</small>` : ''}</td>
                <td>${m.payToMemberId ? `<button type="button" class="hc-payto-chip member" ${canManage ? `data-act="edit-member" data-member="${m.id}"` : 'disabled'} title="${esc(m.name)} pays this winner directly (comes off the payout)">
                        ${icon('crown')}<b>${esc(m.payToMemberName || '')}</b><small>pays the winner directly</small></button>`
                    : m.payToAccountId ? `<button type="button" class="hc-payto-chip" ${canManage ? `data-act="edit-member" data-member="${m.id}"` : 'disabled'} title="${esc(m.name)}’s payment link shows this account (signed)">
                        ${icon('bank')}<b>${esc(m.payToAccountName || '')}</b><small>${esc(m.payToSummary || '')}</small></button>`
                    : `<span class="muted hc-small" title="The chit’s account or UPI ID">chit’s account</span>${canManage ? ` <button type="button" class="btn sm ghost icon" data-act="edit-member" data-member="${m.id}" title="Attach a bank account for ${esc(m.name)} to pay into">${icon('link')}</button>` : ''}`}</td>
                <td>${won ? `<span class="hc-winner">${icon('crown')}Month ${m.wonMonth}</span> <small class="muted">${money(won.payout)}</small>` : '<span class="muted">not yet</span>'}</td>
                <td class="r">${money(m.totalPaid)}</td>
                <td class="r ${num(m.balanceDue) ? 'neg' : 'muted'}">${num(m.balanceDue) ? money(m.balanceDue) : 'up to date'}</td>
                <td class="r ${num(m.lateFeeDue) ? 'neg' : 'muted'}">${num(m.lateFeeDue) ? money(m.lateFeeDue) : '—'}</td>
                ${canManage ? `<td class="r hc-nowrap">
                    <button class="btn sm ghost icon" data-act="remind" data-member="${m.id}" title="Send a reminder">${icon('bell')}</button>
                    <button class="btn sm ghost icon" data-act="statement" data-member="${m.id}" title="${esc(m.name)}'s statement: print or share">${icon('file-text')}</button>
                    <button class="btn sm ghost icon" data-act="edit-member" data-member="${m.id}" title="Edit name, phone or e-mail">${icon('edit')}</button></td>` : ''}
            </tr>`;
        }).join('')}</tbody>
        <tfoot><tr class="total"><td colspan="5">Total</td><td class="r">${money(d.members.reduce((s, m) => s + num(m.totalPaid), 0))}</td>
            <td class="r neg">${money(d.members.reduce((s, m) => s + num(m.balanceDue), 0))}</td>
            <td class="r neg">${money(d.members.reduce((s, m) => s + num(m.lateFeeDue), 0))}</td>${canManage ? '<td></td>' : ''}</tr></tfoot>
    </table>`;
}

// ---------------------------------------------------------------- history

/**
 * Money in and out, month by month: a card per chit month (newest first) with how much of the month is collected,
 * the payments received (who, when, how, into which account or straight to the winner, reference, receipt) and the
 * payout (to whom, from which accounts with their UTRs, into which account, the commission and the agreement).
 * Totals on top; filter to money in or out, or find a member.
 */
function historyHtml(d) {
    const c = d.chit;
    const kind = view.historyKind;
    const canManage = manage();
    const months = d.schedule.filter(m => m.payoutDate || d.payments.some(p => p.monthNo === m.monthNo)).slice().reverse();
    const received = d.payments.reduce((s, p) => s + num(p.amount), 0);
    const late = d.payments.reduce((s, p) => s + num(p.lateFee), 0);
    const paidOut = d.schedule.reduce((s, m) => s + (m.status === 'COMPLETED' ? num(m.payout) : 0), 0);
    const commission = d.schedule.reduce((s, m) => s + (m.status === 'COMPLETED' ? num(m.commission) : 0), 0);
    const lastDone = c.completedMonths;
    const agreementOf = no => d.agreements.find(a => a.monthNo === no);
    const stat = (iconName, label, value, sub, cls = '') => `<div class="hc-lg-stat ${cls}"><span>${icon(iconName)}</span><div><small>${label}</small><b>${value}</b><em>${sub}</em></div></div>`;

    // one dense line per payment; a click opens everything about it under the line (nothing is cut short)
    const receivedRow = p => {
        const where = p.paidToMemberId ? (p.paidToMemberId === p.memberId ? 'set off against the payout' : `paid ${p.paidToName} directly`)
            : p.accountName ? `into ${p.accountName}` : '';
        const facts = [['Received', `${date(p.paidDate)} · ${p.mode}`], ['Where', where], ['Reference', p.reference], ['Receipt', p.receiptNo],
            ['Late interest', num(p.lateFee) ? money(p.lateFee) : ''], ['Let off', num(p.lateFeeWaived) ? money(p.lateFeeWaived) : ''],
            ['Moved', p.movedTo], ['Paid out', p.paidOutMonth ? `in the month ${p.paidOutMonth} payout` : ''],
            ['Entry', p.entryNo], ['Note', p.note], ['Recorded', `${p.createdBy}, ${dateTime(p.createdAt)}`]].filter(([, v]) => v);
        return `<div class="hc-lg-item" data-lg-name="${esc((p.memberName || '').toLowerCase())}">
            <div class="hc-lg-row" data-act="lg-expand" title="Show the details">
                <span class="hc-avatar xs">${esc(initials(p.memberName || '?'))}</span>
                <b class="hc-lg-name">${esc(p.memberName)}</b>
                <span class="hc-lg-mode">${esc(p.mode)}</span>
                ${p.paidToMemberId ? `<span class="hc-lg-chip direct" title="${esc(where)}">${icon('hand')}direct</span>` : ''}
                ${p.batchId ? '<span class="hc-lg-chip" title="Marked paid with everyone at once">all</span>' : ''}
                ${p.movedTo ? `<span class="hc-lg-chip" title="Moved ${esc(p.movedTo)}">${icon('merge')}moved</span>` : ''}
                ${p.paidOutMonth ? `<span class="hc-lg-chip good" title="Paid out in month ${p.paidOutMonth}">${icon('crown')}${p.paidOutMonth}</span>` : ''}
                ${p.attachmentCount ? `<span class="hc-lg-chip" title="${p.attachmentCount} file(s) of evidence">${icon('paperclip')}${p.attachmentCount}</span>` : ''}
                <small class="hc-lg-date">${shortDate(p.paidDate)}</small>
                <span class="grow"></span>
                <b class="pos hc-lg-amt">+${money(p.amount)}</b>${num(p.lateFee) ? `<small class="hc-lg-late" title="Late payment interest">+${moneyShort(p.lateFee)}</small>` : ''}
                ${canManage ? `<span class="hc-lg-acts">
                    <button class="btn xs ghost icon" data-act="receipt" data-payment="${p.id}" title="Receipt ${esc(p.receiptNo || '')}">${icon('receipt')}</button>
                    <button class="btn xs ghost icon" data-act="edit-payment" data-payment="${p.id}" title="Change">${icon('edit')}</button>
                    <button class="btn xs ghost icon" data-act="undo-payment" data-payment="${p.id}" title="Take back">${icon('undo')}</button></span>` : ''}
            </div>
            <dl class="hc-lg-more" hidden>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}
                ${p.attachmentCount ? `<dt>Evidence</dt><dd><a href="#" data-act="view-entry" data-entry="${p.journalEntryId}">${icon('paperclip')}${p.attachmentCount} file(s)</a></dd>` : ''}</dl>
        </div>`;
    };

    const payoutCard = m => {
        if (m.status !== 'COMPLETED') {
            return `<div class="hc-lg-payout pending">
                <span class="hc-avatar gold">${icon(isAuction(c) ? 'gavel' : 'crown')}</span>
                <div class="min-0 grow"><b>${m.winnerName ? esc(m.winnerName) : 'Winner not chosen'}</b>
                    <small>${m.estimated ? 'up to ' : ''}${money(m.payout)} to be paid${m.status === 'ONGOING' ? ' this month' : ''}</small></div>
                ${canManage && m.status === 'ONGOING' && m.winnerMemberId ? `<button class="btn sm gold-btn" data-act="payout" data-month="${m.monthNo}">${icon('check')}Pay winner</button>` : ''}</div>`;
        }
        const ag = agreementOf(m.monthNo);
        const commissionNeg = num(m.commission) < 0;
        return `<div class="hc-lg-payout">
            <div class="hc-lg-payout-head"><span class="hc-avatar gold">${icon(isAuction(c) ? 'gavel' : 'crown')}</span>
                <div class="min-0 grow"><b>${esc(m.winnerName)}</b><small>${shortDate(m.payoutDate)}${m.payoutTo ? ` · to ${esc(m.payoutTo)}` : ''}${m.payoutEntryNo ? ` · ${esc(m.payoutEntryNo)}` : ''}</small></div>
                <b class="hc-lg-out">−${money(m.payout)}</b></div>
            ${(m.legs || []).length ? `<div class="hc-lg-parts">${m.legs.map(l => `<span class="hc-lg-part ${l.mode === 'Direct' ? 'direct' : ''}">
                ${icon(l.mode === 'Direct' ? 'hand' : 'arrow-out')}<span class="hc-lg-part-name">${esc(l.mode === 'Direct' ? 'Paid directly by members' : l.accountName)}</span>
                <small>${esc(l.mode === 'Direct' ? '' : l.mode || '')}${l.reference && l.mode !== 'Direct' ? ` · ${esc(l.reference)}` : ''}</small><b>${money(l.amount)}</b></span>`).join('')}</div>` : ''}
            <div class="hc-lg-foot">
                <span class="${commissionNeg ? 'neg' : 'gold-ink'}" title="${commissionNeg ? 'Paid to the winner out of your commission' : 'Your commission'}">${icon('piggy')}${commissionNeg ? `from my commission ${money(-num(m.commission))}` : `commission ${money(m.commission)}`}</span>
                ${ag ? `<span class="hc-lg-chip ${ag.status === 'DRAFT' ? 'warn' : 'good'}" data-act="agreement" data-month="${m.monthNo}" title="Open the agreement">${icon('file-text')}${ag.status === 'DRAFT' ? 'agreement not accepted' : 'agreement ' + ag.status.toLowerCase()}</span>`
                    : canManage ? `<span class="hc-lg-chip muted clickable" data-act="agreement" data-month="${m.monthNo}">${icon('file-text')}no agreement</span>` : ''}
                <span class="grow"></span>
                ${canManage && m.monthNo === lastDone ? `<button class="btn sm ghost" data-act="undo-payout" data-month="${m.monthNo}" title="Undo the payout">${icon('undo')}Undo</button>` : ''}
            </div></div>`;
    };

    const groups = months.map((m, i) => {
        const pays = d.payments.filter(p => p.monthNo === m.monthNo).sort((a, b) => b.paidDate.localeCompare(a.paidDate) || b.id - a.id);
        const inMonth = pays.reduce((s, p) => s + num(p.amount), 0);
        const pct = num(m.expected) ? Math.min(100, (num(m.collected) / num(m.expected)) * 100) : 0;
        return `<details class="hc-lg ${m.status.toLowerCase()}" ${i < 3 ? 'open' : ''}>
            <summary class="hc-lg-head">
                <span class="hc-lg-no">${m.monthNo}</span>
                <div class="min-0"><b>${monthName(m.dueDate)}</b><small>${m.paidCount} of ${d.members.length} paid · ${plural(pays.length, 'payment')}</small></div>
                <i class="hc-lg-bar" title="${money(m.collected)} of ${money(m.expected)} collected"><em style="width:${pct}%"></em></i>
                <span class="hc-lg-sum"><small>In</small><b class="pos">${money(inMonth)}</b></span>
                <span class="hc-lg-sum"><small>Out</small><b class="${m.status === 'COMPLETED' ? 'neg' : 'muted'}">${m.status === 'COMPLETED' ? money(m.payout) : '—'}</b></span>
                ${statusBadge(m.status)}
            </summary>
            <div class="hc-lg-body ${kind === 'ALL' ? '' : 'one'}">
                ${kind !== 'OUT' ? `<div class="hc-lg-col"><div class="hc-lg-col-head">${icon('arrow-in')}Received<span>${money(inMonth)}</span></div>
                    ${pays.length ? pays.map(receivedRow).join('') : '<p class="muted hc-small">Nothing received yet.</p>'}</div>` : ''}
                ${kind !== 'IN' ? `<div class="hc-lg-col"><div class="hc-lg-col-head">${icon('crown')}Paid out</div>${payoutCard(m)}</div>` : ''}
            </div></details>`;
    }).join('');

    return `<div class="hc-pad hc-ledger">
        <div class="hc-lg-stats">
            ${stat('arrow-in', 'Received', money(received), plural(d.payments.length, 'payment'), 'in')}
            ${late ? stat('clock', 'Late interest', money(late), 'your income', 'late') : ''}
            ${stat('crown', 'Paid to winners', money(paidOut), plural(c.completedMonths, 'winner'), 'out')}
            ${stat('piggy', 'Commission', money(commission), 'on paid-out months', commission < 0 ? 'neg' : 'gold')}
            ${stat('wallet', 'Money with me', money(c.held), 'collected, not paid out')}
        </div>
        <div class="hc-members-tools">
            <div class="seg-chips sm">${[['ALL', 'Everything', 'list'], ['IN', 'Received', 'arrow-in'], ['OUT', 'Paid out', 'crown']].map(([k, label, i]) =>
                `<button class="seg-chip ${kind === k ? 'active' : ''}" data-act="history-kind" data-kind="${k}">${icon(i)}${label}</button>`).join('')}</div>
            ${kind !== 'OUT' ? `<label class="hc-search">${icon('search')}<input id="hc-ledger-search" placeholder="Find a member" value="${esc(view.ledgerQuery || '')}" data-plain></label>` : ''}
            <span class="grow"></span>
            <button class="btn sm ghost" data-act="ledger-open" title="Open every month">${icon('chevron-down')}All months</button>
        </div>
        ${groups || emptyState('Nothing recorded yet', 'history')}
    </div>`;
}

// ===================================================================== new chit (wizard dialog)

function newDraft() {
    const now = new Date();
    return {
        step: 1, chitType: 'FIXED', name: '', startMonth: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, dueDay: 5,
        memberCount: 20, installment: 25000, baseValue: 500000, monthlyIncrement: 5000, commission: 25000,
        winnerExtraType: 'FIXED', winnerExtraValue: 5000, baseTouched: false,
        auctionValue: 1000000, commissionPercent: 5, maxBidPercent: 40,
        // planned chits: what members pay rises by this each month (0: the same), and the chit table
        installmentIncrement: 0, plan: null, payTouched: false,
        lateFeePercent: 2, lateGraceDays: 5, upiId: '', payeeName: '',
        postToBooks: true, collection: 'SEPARATE', accountId: null, commissionTo: 'SEPARATE', commissionAccountId: null, commissionCategoryId: null,
        lateTo: 'SEPARATE', lateFeeAccountId: null,
        members: [],
    };
}

/** Planned chits: payouts rising evenly from `first` to `last`, to the nearest ₹1,000 (the last one exact). */
function spreadPayouts(n, first, last) {
    return Array.from({ length: n }, (_, i) => i === n - 1 ? last : n === 1 ? first : Math.round((first + (last - first) * i / (n - 1)) / 1000) * 1000);
}

/**
 * Planned chits: the draft's chit table, made (or remade) for the number of members. Until the payouts are edited
 * they start at about 82% of what is collected a month and rise to about 104%, so later winners get more than is
 * collected and the early commission pays for it. Installments follow the monthly amount and its rise unless edited.
 */
function ensurePlan(w) {
    const n = num(w.memberCount);
    if (!(n >= 2 && n <= 100)) return;
    const emi = num(w.installment);
    const inc = num(w.installmentIncrement);
    if (!w.plan || w.plan.length !== n || !w.payTouched) {
        const first = emi * n;
        const pays = spreadPayouts(n, Math.round(first * 0.82 / 1000) * 1000, Math.round((emi + inc * (n - 1)) * n * 1.04 / 1000) * 1000);
        const old = w.plan || [];
        w.plan = pays.map((p, i) => ({ payout: w.payTouched && old[i] ? old[i].payout : p, installment: old[i]?.instTouched ? old[i].installment : emi + inc * i,
            instTouched: !!old[i]?.instTouched }));
    }
    w.plan.forEach((row, i) => { if (!row.instTouched) row.installment = emi + inc * i; });
}

/** 500000 -> "5L", 1500000 -> "15L", 25000000 -> "2.5Cr", 50000 -> "50K". */
function shortValue(v) {
    const trim = x => String(Math.round(x * 10) / 10).replace(/\.0$/, '');
    return v >= 1e7 ? `${trim(v / 1e7)}Cr` : v >= 1e5 ? `${trim(v / 1e5)}L` : v >= 1e3 ? `${trim(v / 1e3)}K` : String(Math.round(v));
}

/** "2026-10" plus some months -> "Oct26". */
function monthTag(ym, plus = 0) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + plus, 1);
    return d.toLocaleDateString('en-GB', { month: 'short' }).slice(0, 3) + String(d.getFullYear()).slice(2);
}

/**
 * The name a new chit is given until one is typed: the company, the chit's value and kind, and the months it runs,
 * e.g. "Aditya Chitfunds 5L (Oct26–May28)" or "Aditya Chitfunds 10L Auction (Oct26–May28)"; "#2" when already taken.
 */
function suggestName(w) {
    const n = num(w.memberCount);
    if (!(n >= 2) || !/^\d{4}-\d{2}$/.test(w.startMonth)) return w.company || '';
    const value = w.chitType === 'AUCTION' ? num(w.auctionValue) : w.chitType === 'PLANNED' ? num(w.installment) * n : num(w.baseValue);
    const kind = w.chitType === 'AUCTION' ? ' Auction' : w.chitType === 'PLANNED' ? ' Planned' : '';
    const tail = ` ${shortValue(value)}${kind} (${monthTag(w.startMonth)}–${monthTag(w.startMonth, n - 1)})`;
    let name = `${(w.company || 'Chit').slice(0, 100 - tail.length - 3)}${tail}`;
    for (let i = 2; w.takenNames?.has(name.toLowerCase()); i++) name = `${name.replace(/ #\d+$/, '')} #${i}`;
    return name;
}

/** The draft as the server's chit request. */
function draftRequest(w) {
    const n = num(w.memberCount);
    const auction = w.chitType === 'AUCTION';
    const planned = w.chitType === 'PLANNED';
    const value = auction ? num(w.auctionValue) : planned ? num(w.installment) * n : num(w.baseValue);
    if (planned) ensurePlan(w);
    return {
        name: w.name.trim(), chitType: w.chitType, startMonth: `${w.startMonth}-01`, dueDay: num(w.dueDay), memberCount: n, months: n,
        installment: auction ? Math.round(value / n) : num(w.installment), baseValue: value,
        monthlyIncrement: auction || planned ? 0 : num(w.monthlyIncrement),
        commission: auction ? Math.round(value * num(w.commissionPercent) / 100) : planned ? 0 : num(w.commission),
        winnerExtraType: auction || planned ? 'NONE' : w.winnerExtraType, winnerExtraValue: auction || planned ? 0 : num(w.winnerExtraValue),
        maxBidPercent: auction ? num(w.maxBidPercent) : null,
        installmentIncrement: planned ? num(w.installmentIncrement) : null,
        plan: planned ? (w.plan || []).map((x, i) => ({ monthNo: i + 1, installment: num(x.installment), payout: num(x.payout) })) : null,
        lateFeePercent: num(w.lateFeePercent), lateGraceDays: num(w.lateGraceDays), upiId: (w.upiId || '').trim() || null, payeeName: (w.payeeName || '').trim() || null,
        postToBooks: true,
        separateCollectionAccount: w.postToBooks && w.collection === 'SEPARATE', accountId: w.postToBooks && w.collection === 'EXISTING' ? w.accountId : null,
        separateCommissionAccount: w.postToBooks && w.commissionTo === 'SEPARATE',
        commissionAccountId: w.postToBooks && w.commissionTo === 'EXISTING' ? w.commissionAccountId : null,
        commissionCategoryId: w.postToBooks ? w.commissionCategoryId : null,
        separateLateFeeAccount: w.lateTo === 'SEPARATE', lateFeeAccountId: w.lateTo === 'EXISTING' ? w.lateFeeAccountId : null,
        members: w.members.slice(0, n).map(m => ({ name: m.name.trim(), phone: m.phone.replace(/[\s-]/g, '') || null, email: (m.email || '').trim() || null,
            payoutAccount: (m.payoutAccount || '').trim() || null, payToAccountId: m.payToAccountId || null, upiId: (m.upiId || '').trim() || null })),
        shortCode: (w.shortCode || '').trim().toUpperCase() || null,
        payToAccountId: w.payToAccountId || null,
    };
}

/**
 * The months of a draft: what each member pays, what is collected, the chit value, what the winner gets and the
 * commission (planned chits: collected − payout, negative when the winner gets more). Auction: the most a winner gets.
 */
function planOf(w) {
    const r = draftRequest(w);
    const rows = [];
    for (let m = 1; m <= r.months; m++) {
        if (w.chitType === 'PLANNED') {
            const x = w.plan[m - 1];
            const collect = num(x.installment) * r.memberCount;
            rows.push({ monthNo: m, dueDate: dueDateOf(w.startMonth, r.dueDay || 1, m), installment: num(x.installment), chitValue: collect, collect,
                payout: num(x.payout), commission: collect - num(x.payout) });
            continue;
        }
        const value = r.baseValue + (m - 1) * r.monthlyIncrement;
        rows.push({
            monthNo: m, dueDate: dueDateOf(w.startMonth, r.dueDay || 1, m), chitValue: value, installment: r.installment,
            payout: value - r.commission, commission: r.commission,
            collect: w.chitType === 'AUCTION' ? r.baseValue : r.memberCount * r.installment + (m - 1) * extraOf({ ...r }),
        });
    }
    return { r, rows };
}

/**
 * Hosting a new chit takes over the right-hand pane (the list and the figures stay): three steps with room for a
 * live explanation and the whole schedule beside the form. Cancel, or creating the chit, brings the chit view back.
 */
/**
 * Hosts a new chit. template: a chit's detail to copy (a finished chit used again): its kind, amounts, chit table,
 * late interest, UPI details and members, starting next month with a fresh name and new accounts.
 */
/**
 * Hosts a new chit, or (edit) shows a chit's settings on the same three steps, filled in. Once a chit has started its
 * terms (kind, dates, amounts, percentages, the chit table) are shown but locked; the name, members' details, UPI,
 * payment notes and accounts still change. template: a chit to copy as a new one.
 */
async function openWizard(template = null, { edit = null } = {}) {
    if (!manage()) return;
    const container = document.querySelector('.hc-page')?.parentElement;
    if (!container) return;
    const w = edit ? editDraft(edit) : template ? copyDraft(template) : newDraft();
    const [accounts, categories, cfg, existing] = await Promise.all([loadAccounts(false, { all: true }).catch(() => []),
        categoriesOf('INCOME', edit?.chit.commissionCategoryId).catch(() => []),
        api.get('/hosted-chits/settings').catch(() => ({})), api.get('/hosted-chits').catch(() => [])]);
    // new chits are named after the household's chit-funds company (Settings › Host a Chit)
    w.company = (cfg.companyName || cfg.householdName || 'Chit').trim();
    w.takenNames = new Set(existing.filter(x => x.id !== edit?.chit.id).map(x => x.name.trim().toLowerCase()));
    w.commissionCategoryId = edit?.chit.commissionCategoryId || categories.find(c => c.name === 'Chit Commission Income')?.id || null;   // null: made for the chit
    const snapshot = edit ? editSnapshot(w) : null;
    const steps = [['Chit details', 'the kind of chit, dates and money'], ['Members', 'who is in the chit'], ['Payments & accounts', 'UPI, accounts and a last look']];
    const previous = view.selectedId;
    view.wizard = w;
    const old = container.querySelector('#hc-detail');
    const target = old.cloneNode(false);
    old.replaceWith(target);
    target.classList.add('hc-creating');
    container.querySelectorAll('#hc-list .selected').forEach(x => x.classList.remove('selected'));
    target.innerHTML = `
        <section class="panel hc-create">
            <header class="hc-create-head">
                <span class="hero-icon">${icon('hand-coins')}</span>
                <div class="min-0 hc-create-title"><b>${edit ? `Chit settings · ${esc(edit.chit.name)}${edit.chit.termsLocked ? ` <span class="hc-lock-badge">${icon('lock')}started: terms locked</span>` : ''}`
                    : w.copiedFrom ? `Host a new chit · copy of ${esc(w.copiedFrom)}` : 'Host a new chit'}</b><small data-step-note></small></div>
                <ol class="hc-steps on-dark" data-steps></ol>
                <button class="btn sm on-dark icon" data-wz="cancel" title="Close (Esc)">${icon('x')}</button>
            </header>
            <div class="hc-create-body" data-step-body></div>
            <footer class="hc-create-foot">
                ${edit ? `<button class="btn danger" data-wz="delete">${icon('trash')}Delete chit…</button>
                    <button class="btn" data-wz="signature">${icon('signature')}${edit.chit.receiptSignature ? 'Receipt signature ✓' : 'Receipt signature…'}</button>
                    <button class="btn" data-wz="copy">${icon('copy')}Copy as a new chit</button>` : ''}
                <p class="form-error" data-wz-error></p>
                <span class="spacer"></span>
                <button class="btn" data-wz="back">${icon('chevron-left')}Back</button>
                <button class="btn" data-wz="cancel">Cancel</button>
                <button class="btn ${edit ? '' : 'primary'}" data-wz="next"></button>
                ${edit ? `<button class="btn primary" data-wz="save">${icon('check')}Save changes</button>` : ''}
            </footer>
        </section>`;
    const error = msg => { target.querySelector('[data-wz-error]').textContent = msg || ''; };
    const draw = () => {
        target.querySelector('[data-steps]').innerHTML = steps.map(([label], i) =>
            `<li class="${w.step === i + 1 ? 'active' : w.step > i + 1 ? 'done' : ''}" data-step="${i + 1}"><i>${w.step > i + 1 ? icon('check') : i + 1}</i><span>${label}</span></li>`).join('');
        target.querySelector('[data-step-note]').textContent = `Step ${w.step} of 3 · ${steps[w.step - 1][1]}`;
        // a fresh element each step, so one step's handlers never fire on the next
        const old = target.querySelector('[data-step-body]');
        const host = old.cloneNode(false);
        old.replaceWith(host);
        if (w.step === 1) { drawDetails(host, w); lockTerms(host, w); }
        else if (w.step === 2) drawMembers(host, w, accounts);
        else drawAccounts(host, w, accounts, categories);
        host.scrollTop = 0;
        target.querySelector('[data-wz="back"]').hidden = w.step === 1;
        target.querySelector('[data-wz="next"]').innerHTML = w.step < 3 ? `Next${icon('chevron-right')}` : `${icon('check')}Create the chit`;
        target.querySelector('[data-wz="next"]').hidden = !!edit && w.step === 3;
        error('');
        target.querySelector('[data-step-body] input:not([type=radio]):not([type=checkbox])')?.focus({ preventScroll: true });
    };
    const close = (id = previous) => {
        view.wizard = null;
        location.hash = id ? `#/host-chits/${id}/${view.tab}` : '#/host-chits';
        window.dispatchEvent(new HashChangeEvent('hashchange'));
    };
    /** Settings: the chit, its chit table (planned, not started) and the members whose details changed, in turn. */
    const save = async button => {
        const problem = checkDetails(w) || checkMembers(w) || checkAccounts(w);
        if (problem) { error(problem); return; }
        button.disabled = true;
        try {
            const c = edit.chit;
            let d = await api.put(`/hosted-chits/${c.id}`, editRequest(w));
            if (isPlanned(c) && !c.termsLocked) {
                const months = w.plan.map((x, i) => ({ monthNo: i + 1, installment: num(x.installment), payout: num(x.payout) }));
                const before = edit.schedule.map(x => ({ monthNo: x.monthNo, installment: num(x.installment), payout: num(x.payout) }));
                if (JSON.stringify(months) !== JSON.stringify(before)) d = await api.put(`/hosted-chits/${c.id}/plan`, { months });
            }
            for (const m of w.members) {
                const body = memberBody(m.orig, { name: m.name.trim(), phone: m.phone.replace(/[\s-]/g, '') || null, email: (m.email || '').trim() || null,
                    payoutAccount: (m.payoutAccount || '').trim() || null, upiId: (m.upiId || '').trim() || null,
                    payToAccountId: m.payToAccountId || null, payToMemberId: m.payToMemberId || null });
                if (JSON.stringify(body) !== JSON.stringify(memberBody(m.orig))) d = await api.put(`/hosted-chits/${c.id}/members/${m.id}`, body);
            }
            toast('Settings saved');
            current = d;
            close(c.id);
        } catch (err) {
            error(err.message);
            button.disabled = false;
        }
    };
    const next = async button => {
        const problem = w.step === 1 ? checkDetails(w) : w.step === 2 ? checkMembers(w) : checkDetails(w) || checkMembers(w) || checkAccounts(w);
        if (problem) { error(problem); return; }
        if (w.step < 3) { w.step++; draw(); return; }
        if (edit) { save(target.querySelector('[data-wz="save"]')); return; }
        button.disabled = true;
        try {
            const d = await api.post('/hosted-chits', draftRequest(w));
            toast(`${d.chit.name} is ready`);
            view.selectedId = d.chit.id;
            view.tab = 'month';
            close(d.chit.id);
        } catch (err) {
            error(err.message);
            button.disabled = false;
        }
    };
    const cancel = async () => {
        const dirty = edit ? editSnapshot(w) !== snapshot : wizardDirty(w);
        if (dirty && !await confirmDialog(edit ? 'Leave without saving your changes?' : 'Leave without creating this chit? What you entered is lost.', { confirmLabel: 'Leave', danger: false })) return;
        close();
    };
    target.addEventListener('click', e => {
        const b = e.target.closest('[data-wz]');
        if (b?.dataset.wz === 'next') next(b);
        else if (b?.dataset.wz === 'save') save(b);
        else if (b?.dataset.wz === 'delete') openDelete(edit);
        else if (b?.dataset.wz === 'signature') openSignature(edit);
        else if (b?.dataset.wz === 'copy') openWizard(edit);
        else if (b?.dataset.wz === 'back') { w.step = Math.max(1, w.step - 1); draw(); }
        else if (b?.dataset.wz === 'cancel') cancel();
        const step = e.target.closest('[data-step]');
        // settings: any step; a new chit: back to a finished one
        if (step && (edit ? Number(step.dataset.step) !== w.step : Number(step.dataset.step) < w.step)) { w.step = Number(step.dataset.step); draw(); }
    });
    target.addEventListener('keydown', e => {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
        if (e.key !== 'Enter' || e.defaultPrevented || e.target.matches('textarea, button, a, select') || e.target.closest('.ac-pop, .combo-display')) return;
        e.preventDefault();
        if (edit) save(target.querySelector('[data-wz="save"]'));
        else next(target.querySelector('[data-wz="next"]'));
    });
    draw();
}

/** A chit's settings as a draft of the wizard: its terms, members, UPI details and accounts. */
function editDraft(d) {
    const c = d.chit;
    const from = draftFromChit(d);
    return { ...newDraft(), ...from, edit: d, chitId: c.id, step: 1, name: c.name, nameTouched: true, startMonth: c.startMonth.slice(0, 7),
        commissionPercent: Math.round(num(from.commissionPercent) * 100) / 100,
        upiId: c.upiId || '', payeeName: c.payeeName || '', payToAccountId: c.payToAccountId || null, notes: c.notes || '', shortCode: c.shortCode || '',
        postToBooks: c.postToBooks, locked: c.postToBooks, collection: 'EXISTING', accountId: c.accountId,
        commissionTo: c.commissionAccountId ? 'EXISTING' : 'SAME', commissionAccountId: c.commissionAccountId,
        lateTo: c.lateFeeAccountId ? 'EXISTING' : 'SAME', lateFeeAccountId: c.lateFeeAccountId,
        members: d.members.slice().sort((a, b) => a.slot - b.slot).map(m => ({ id: m.id, orig: m, name: m.name, phone: m.phone || '', email: m.email || '',
            payoutAccount: m.payoutAccount || '', upiId: m.upiId || '', payToAccountId: m.payToAccountId || null, payToMemberId: m.payToMemberId || null })) };
}

/** What the settings form holds now, to tell whether anything changed. */
function editSnapshot(w) {
    return JSON.stringify([editRequest(w), w.plan, w.members.map(m => [m.name, m.phone, m.email, m.payoutAccount, m.upiId, m.payToAccountId, m.payToMemberId])]);
}

/**
 * The chit's update request from the settings draft. Started: the terms go back exactly as they are (only the name,
 * UPI details, notes, short code and accounts change); the members and the chit table are saved on their own.
 */
function editRequest(w) {
    const c = w.edit.chit;
    const auction = isAuction(c), planned = isPlanned(c);
    const r = { ...draftRequest(w), chitType: c.chitType, memberCount: c.memberCount, months: c.months, members: null, plan: null,
        postToBooks: w.postToBooks, notes: (w.notes || '').trim() || null, version: c.version,
        payToAccountId: w.payToAccountId || null, shortCode: (w.shortCode || '').trim().toUpperCase() || null };
    if (c.structureLocked || c.termsLocked) r.startMonth = c.startMonth;
    if (c.termsLocked) {
        Object.assign(r, { dueDay: c.dueDay,
            installment: num(c.installment), baseValue: num(c.baseValue),
            monthlyIncrement: auction || planned ? 0 : num(c.monthlyIncrement), commission: planned ? 0 : num(c.commission),
            installmentIncrement: planned ? num(c.installmentIncrement) : null, maxBidPercent: auction ? num(c.maxBidPercent) : null,
            winnerExtraType: auction || planned ? 'NONE' : c.winnerExtraType, winnerExtraValue: auction || planned ? 0 : num(c.winnerExtraValue),
            lateFeePercent: num(c.lateFeePercent), lateGraceDays: c.lateGraceDays || 0 });
    }
    return r;
}

/**
 * Settings: locks what may no longer change. Always the kind of chit and the number of members; the start month once
 * payments are recorded; every term (amounts, percentages, days, the chit table) once the chit has started.
 */
function lockTerms(host, w) {
    if (!w.edit) return;
    const c = w.edit.chit;
    host.querySelectorAll('[data-type]').forEach(b => { b.disabled = true; });
    const off = k => host.querySelectorAll(`[data-k="${k}"]`).forEach(el => { el.disabled = true; el.closest('.fl')?.classList.add('locked'); });
    off('memberCount');
    if (c.structureLocked || c.termsLocked) off('startMonth');
    if (c.termsLocked) {
        host.querySelectorAll('[data-k]').forEach(el => { if (el.dataset.k !== 'name') { el.disabled = true; el.closest('.fl')?.classList.add('locked'); } });
        host.querySelectorAll('[data-plan-i] input, [data-plan-i], [data-fill], [data-fill-go], [data-extra-fix], [data-base-auto]').forEach(el => { el.disabled = true; el.setAttribute('tabindex', '-1'); });
        host.classList.add('hc-terms-locked');
        if (!host.querySelector('[data-lock-note]')) {
            host.querySelector('.hc-col')?.insertAdjacentHTML('afterbegin', `<p class="hc-note" data-lock-note>${icon('lock')}<span><b>${esc(c.name)}</b> has started: its kind, dates,
                amounts, percentages and chit table are what the members agreed to, and are shown here locked. The name, members’ details,
                UPI, payment notes and accounts can still change.</span></p>`);
        }
    }
}

function wizardDirty(w) {
    return !!(w.name.trim() || w.members.some(m => m.name.trim()));
}

function checkDetails(w) {
    if (!w.name.trim()) return 'Give the chit a name';
    if (!/^\d{4}-\d{2}$/.test(w.startMonth)) return 'Pick the month the chit starts';
    if (!(num(w.dueDay) >= 1 && num(w.dueDay) <= 28)) return 'The payment day must be between 1 and 28';
    if (!(num(w.memberCount) >= 2 && num(w.memberCount) <= 100)) return 'The number of members must be between 2 and 100';
    if (w.chitType === 'AUCTION') {
        if (!(num(w.auctionValue) > 0)) return 'Enter the chit value';
        if (!(num(w.commissionPercent) > 0)) return 'Enter your commission (usually 5%)';
        if (!(num(w.maxBidPercent) > num(w.commissionPercent) && num(w.maxBidPercent) <= 40)) return 'The highest bid must be above your commission and at most 40%';
        return checkLate(w);
    }
    if (w.chitType === 'PLANNED') {
        if (!(num(w.installment) > 0)) return 'Enter how much each member pays a month';
        if (num(w.installmentIncrement) < 0) return 'The monthly rise cannot be negative';
        ensurePlan(w);
        const bad = w.plan.findIndex(x => !(num(x.payout) > 0) || !(num(x.installment) > 0));
        if (bad >= 0) return `Month ${bad + 1}: enter what each member pays and what the winner gets`;
        return checkLate(w);
    }
    if (!(num(w.installment) > 0)) return 'Enter how much each member pays a month';
    if (!(num(w.baseValue) > 0)) return 'Enter the chit value for month 1';
    if (num(w.monthlyIncrement) < 0 || num(w.commission) < 0) return 'Amounts cannot be negative';
    if (num(w.commission) >= num(w.baseValue)) return 'Your commission must be less than the chit value';
    if (w.winnerExtraType !== 'NONE' && !(num(w.winnerExtraValue) > 0)) return 'Enter how much extra winners pay (or choose “Nothing extra”)';
    if (w.winnerExtraType === 'PERCENT' && num(w.winnerExtraValue) > 100) return 'The winner extra can be at most 100% of the chit value';
    return checkLate(w);
}

function checkLate(w) {
    if (num(w.lateFeePercent) < 0 || num(w.lateFeePercent) > 10) return 'Late payment interest must be between 0% and 10% a month';
    if (num(w.lateGraceDays) < 0 || num(w.lateGraceDays) > 60) return 'Grace days must be between 0 and 60';
    return null;
}

function checkMembers(w) {
    const n = num(w.memberCount);
    const list = w.members.slice(0, n);
    const filled = list.filter(m => m.name.trim());
    if (filled.length < n) return `Enter all ${n} names (${filled.length} done so far)`;
    const bad = list.find(m => m.phone.trim() && !/^\d{10}$/.test(m.phone.replace(/[\s-]/g, '')));
    if (bad) return `${bad.name}: the phone number should have 10 digits`;
    const badMail = list.find(m => (m.email || '').trim() && !EMAIL.test(m.email.trim()));
    if (badMail) return `${badMail.name}: the e-mail address does not look right`;
    const badUpi = list.find(m => (m.upiId || '').trim() && !UPI.test(m.upiId.trim()));
    if (badUpi) return `${badUpi.name}: the UPI ID should look like name@bank`;
    const seen = new Set();
    for (const m of list) {
        const key = m.name.trim().toLowerCase();
        if (seen.has(key)) return `Two members are called “${m.name.trim()}”. Add a surname or initial to tell them apart.`;
        seen.add(key);
    }
    return null;
}

function checkAccounts(w) {
    if (w.upiId && !/^[\w.\-]{2,}@[A-Za-z][\w.]{1,}$/.test(w.upiId.trim())) return 'The UPI ID should look like name@bank';
    if (w.collection === 'EXISTING' && !w.accountId) return 'Pick the account the payments go to';
    if (w.commissionTo === 'EXISTING' && !w.commissionAccountId) return 'Pick the account for your commission';
    if (w.lateTo === 'EXISTING' && !w.lateFeeAccountId) return 'Pick the account for late payment interest';
    return null;
}

/** A field with its label inside the box, moving up when the box has a value (units shown at the right). */
function fl(label, key, w, { tip = '', attrs = '', type = 'number', unit = '', span = '' } = {}) {
    return `<label class="fl ${span}" title="${esc(tip)}">
        <input type="${type}" data-k="${key}" value="${esc(w[key] ?? '')}" placeholder=" " ${type === 'number' ? 'step="any" min="0" inputmode="decimal"' : ''} ${attrs} data-plain>
        <span>${label}</span>${unit ? `<i class="fl-unit">${unit}</i>` : ''}</label>`;
}

/**
 * Step 1, without scrolling: the kind of chit as two toggles and every figure as a box with its label inside;
 * beside it a short explanation and the full chit table (every month: what members and past winners pay, what you
 * collect, the chit value, your commission and what the winner gets), which can be shared as a PDF or a link.
 */
function drawDetails(host, w) {
    const auction = w.chitType === 'AUCTION';
    const planned = w.chitType === 'PLANNED';
    const type = w.winnerExtraType || 'NONE';
    if (planned) ensurePlan(w);
    const typeButton = (t, iconName, title, sub) => `<button type="button" class="${w.chitType === t ? 'active' : ''}" data-type="${t}" role="radio" aria-checked="${w.chitType === t}">
        ${icon(iconName)}<span><b>${title}</b><small>${sub}</small></span></button>`;
    host.innerHTML = `
    <div class="hc-two hc-fit">
        <div class="hc-col">
            <div class="hc-type-toggle hc-types-3" role="radiogroup" aria-label="Kind of chit">
                ${typeButton('FIXED', 'trending', 'Fixed', 'value rises a set amount monthly')}
                ${typeButton('PLANNED', 'calendar', 'Planned', 'you set each month’s payout')}
                ${typeButton('AUCTION', 'gavel', 'Auction', 'members bid, the discount is shared')}
            </div>
            <div class="hc-fit-grid">
                ${fl('Chit name', 'name', w, { type: 'text', attrs: 'maxlength="100"', span: 'span-2', unit: w.nameTouched ? '' : 'suggested',
                    tip: 'Suggested from your chit-funds company (Settings › Host a Chit), the value and the months; type your own to change it' })}
                ${fl('Starts in', 'startMonth', w, { type: 'month', tip: 'The first month members pay' })}
                ${fl('Members pay by', 'dueDay', w, { attrs: 'min="1" max="28"', unit: 'of the month', tip: 'Day of every month members pay by (1–28)' })}
                ${fl('Members', 'memberCount', w, { attrs: 'min="2" max="100"', unit: `${num(w.memberCount) || ''} months`, tip: 'Also the number of months: each member wins once' })}
                ${auction ? `
                    ${fl('Chit value', 'auctionValue', w, { unit: '₹', tip: 'What the chit is worth, e.g. 10,00,000' })}
                    <label class="fl fixed" title="Chit value ÷ members, before the dividend"><input type="text" value="${money(Math.round(num(w.auctionValue) / Math.max(1, num(w.memberCount))))}" disabled data-installment-view data-plain><span>Each pays a month</span><i class="fl-unit">before dividend</i></label>
                    ${fl('Your commission', 'commissionPercent', w, { attrs: 'max="10"', unit: '% <b data-commission-hint></b>', tip: 'Each month, % of the chit value. Also the lowest bid.' })}
                    ${fl('Highest bid allowed', 'maxBidPercent', w, { attrs: 'max="40"', unit: '% of value', tip: 'The most a member may bid (at most 40%)' })}`
                : planned ? `
                    ${fl('Each pays a month', 'installment', w, { unit: '₹ (EMI)', tip: 'The same every month unless it rises or you edit a month in the table' })}
                    ${fl('EMI rises each month by', 'installmentIncrement', w, { unit: '₹', tip: '0 keeps the EMI the same every month' })}`
                : `
                    ${fl('Each pays a month', 'installment', w, { unit: '₹', tip: '₹ per member each month' })}
                    ${fl('Chit value, month 1', 'baseValue', w, { unit: '₹ <b data-base-hint></b>', tip: 'Usually members × the monthly amount' })}
                    ${fl('Value rises each month by', 'monthlyIncrement', w, { unit: '₹', tip: '0 if the chit value stays the same' })}
                    ${fl('Your commission a month', 'commission', w, { unit: '₹', tip: 'You keep this each month; the winner gets the rest' })}
                    <label class="fl fixed" title="What a member pays on top of the installment every month after the month they win">
                        <select data-k="winnerExtraType" data-plain>
                            <option value="NONE" ${type === 'NONE' ? 'selected' : ''}>Nothing extra</option>
                            <option value="FIXED" ${type === 'FIXED' ? 'selected' : ''}>Fixed ₹ extra</option>
                            <option value="PERCENT" ${type === 'PERCENT' ? 'selected' : ''}>% of chit value</option>
                        </select><span>Winners pay afterwards</span></label>
                    <label class="fl" data-extra-box ${type === 'NONE' ? 'hidden' : ''}><input type="number" data-k="winnerExtraValue" value="${type === 'NONE' ? '' : num(w.winnerExtraValue)}" placeholder=" " step="any" min="0" inputmode="decimal" data-plain>
                        <span>Extra each month</span><i class="fl-unit" data-extra-unit>${type === 'PERCENT' ? '%' : '₹'}</i></label>`}
                ${fl('Late payment interest', 'lateFeePercent', w, { attrs: 'max="10"', unit: '% a month', tip: 'On the unpaid installment; 0 for none' })}
                ${fl('Grace period', 'lateGraceDays', w, { attrs: 'max="60"', unit: 'days', tip: 'Days after the due date before late interest starts' })}
            </div>
            <div data-summary></div>
        </div>
        <div class="hc-col hc-explain-box hc-plan-box" data-preview></div>
    </div>`;

    const summaryHtml = () => {
        const { r, rows } = planOf(w);
        const n = r.memberCount;
        if (auction) {
            return `<ul class="hc-explain hc-explain-sm">
                <li>${icon('gavel')}<span>Each month members who have not won <b>bid a discount</b>; the highest bid wins the chit value less the bid.</span></li>
                <li>${icon('piggy')}<span>You keep <b>${money(r.commission)}</b> a month (also the lowest bid), <b>${money(r.commission * n)}</b> over the chit; the rest of each bid is shared as a dividend.</span></li>
                ${lateLine(w, r.installment)}</ul>`;
        }
        if (planned) {
            const res = reserveOf(rows);
            return `<ul class="hc-explain hc-explain-sm">
                <li>${icon('piggy')}<span>Over the chit you keep <b class="${res.total < 0 ? 'neg' : ''}">${money(res.total)}</b>: ${money(rows.reduce((s, x) => s + x.collect, 0))} collected, ${money(rows.reduce((s, x) => s + x.payout, 0))} paid to winners.</span></li>
                ${res.negative.length ? `<li>${icon('shield')}<span>Months ${compactMonths(res.negative)} pay out more than they collect. Keep up to <b>${money(res.peak)}</b> of your commission for them${res.from ? ` (from month ${res.from})` : ''}; it comes out of the commission account.</span></li>` : ''}
                ${lateLine(w, r.installment)}</ul>
                ${res.ownMoney > 0 ? `<p class="hc-note warn">${icon('alert')}<span>By month ${res.cumulative.findIndex(v => v < 0) + 1} the payouts exceed everything collected so far: you would put in up to <b>${money(res.ownMoney)}</b> of your own.</span></p>`
                    : res.total < 0 ? `<p class="hc-note warn">${icon('alert')}<span>Winners get <b>${money(-res.total)}</b> more than you collect. Lower the later payouts.</span></p>`
                    : `<p class="hc-note good">${icon('check-circle')}<span>Collections cover every payout over the chit, in time.</span></p>`}`;
        }
        const net = rows.reduce((s, x) => s + x.collect - x.payout, 0);
        const fix = r.monthlyIncrement > 0 && !(w.winnerExtraType === 'FIXED' && num(w.winnerExtraValue) === r.monthlyIncrement)
            ? ` <a href="#" data-extra-fix>Make winners pay ${money(r.monthlyIncrement)} extra</a>.` : '';
        return `<ul class="hc-explain hc-explain-sm">
                <li>${icon('piggy')}<span>You keep <b>${money(r.commission)}</b> a month, <b>${money(r.commission * n)}</b> over the chit.</span></li>
                ${lateLine(w, r.installment)}</ul>
                ${net < 0 ? `<p class="hc-note warn">${icon('alert')}<span>You would pay winners <b>${money(-net)}</b> more than you collect.${fix || ' Lower the monthly rise or raise the amounts.'}</span></p>`
                    : `<p class="hc-note good">${icon('check-circle')}<span>Balanced: collections cover every payout${net > 0 ? `, ${money(net)} left for you` : ''}.</span></p>`}`;
    };

    const preview = () => {
        const n = num(w.memberCount);
        const ok = n >= 2 && n <= 100 && /^\d{4}-\d{2}$/.test(w.startMonth);
        if (!w.nameTouched) {
            w.name = suggestName(w);
            const box = host.querySelector('[data-k="name"]');
            if (box && document.activeElement !== box) box.value = w.name;
        }
        const membersUnit = host.querySelector('[data-k="memberCount"] ~ .fl-unit');
        if (membersUnit) membersUnit.textContent = n ? `${n} months` : '';
        if (auction) {
            const value = num(w.auctionValue);
            host.querySelector('[data-installment-view]').value = money(Math.round(value / Math.max(1, n)));
            host.querySelector('[data-commission-hint]').textContent = `= ${moneyShort(Math.round(value * num(w.commissionPercent) / 100))}`;
        } else if (!planned) {
            host.querySelector('[data-base-hint]').innerHTML = w.baseTouched && num(w.baseValue) !== n * num(w.installment)
                ? `· <a href="#" data-base-auto title="members × monthly amount">use ${moneyShort(n * num(w.installment))}</a>` : '';
        }
        const out = host.querySelector('[data-preview]');
        const summary = host.querySelector('[data-summary]');
        if (!ok) { out.innerHTML = emptyState('Fill in the members and the start month to see the chit table', 'calendar'); summary.innerHTML = ''; return; }
        if (planned) ensurePlan(w);
        const plan = planOf(w);
        summary.innerHTML = summaryHtml();
        out.innerHTML = `<div class="hc-plan-head"><div class="section-title">${icon(auction ? 'gavel' : 'calendar')}${auction ? 'How the auction works' : `Chit table · ${n} months`}</div>
                <span class="spacer"></span>
                <button type="button" class="btn sm" data-plan="pdf" title="Print or save it as a PDF for the members (without your commission)">${icon('printer')}PDF</button>
                <button type="button" class="btn sm" data-plan="link" title="A link for the members, before the chit starts (without your commission)">${icon('link')}Share link</button></div>
            ${planned ? `<div class="hc-plan-fill">
                <span>${icon('sparkles')}Winner gets from</span>
                <input type="number" class="num" data-fill="first" value="${num(w.plan[0].payout)}" step="1000" min="0" data-plain>
                <span>in month 1 to</span>
                <input type="number" class="num" data-fill="last" value="${num(w.plan.at(-1).payout)}" step="1000" min="0" data-plain>
                <span>in month ${n}</span>
                <button type="button" class="btn sm" data-fill-go>Fill evenly</button>
                <small class="muted">then edit any month below</small></div>` : ''}
            <div class="hc-plan-wrap">${auction ? auctionGuideHtml(plan.r, num(w.maxBidPercent)) : planTableHtml(w, plan, { editable: planned })}</div>`;
        lockTerms(host, w);
    };

    /** Planned chits: a cell was typed in; the row's figures, the totals and the summary follow without redrawing. */
    const refreshPlanned = () => {
        const plan = planOf(w);
        const res = reserveOf(plan.rows);
        plan.rows.forEach((x, i) => {
            const row = host.querySelector(`[data-plan-row="${i}"]`);
            if (!row) return;
            row.querySelector('[data-cell="collect"]').textContent = money(x.collect);
            const cm = row.querySelector('[data-cell="commission"]');
            cm.textContent = signedMoney(x.commission);
            cm.className = `r ${x.commission < 0 ? 'neg' : 'gold-ink'}`;
            const kept = row.querySelector('[data-cell="kept"]');
            kept.textContent = money(res.cumulative[i]);
            kept.className = `r muted ${res.cumulative[i] < 0 ? 'neg' : ''}`;
        });
        const foot = host.querySelector('[data-plan-foot]');
        if (foot) foot.outerHTML = plannedFootHtml(plan.rows, false);
        host.querySelector('[data-summary]').innerHTML = summaryHtml();
    };

    host.oninput = e => {
        const planCell = e.target.closest('[data-plan-i]');
        if (planCell) {
            const row = w.plan[Number(planCell.dataset.planI)];
            if (planCell.dataset.planField === 'installment') { row.installment = num(e.target.value); row.instTouched = true; }
            else { row.payout = num(e.target.value); w.payTouched = true; }
            refreshPlanned();
            return;
        }
        if (e.target.dataset.fill) return;
        const k = e.target.dataset.k;
        if (!k) return;
        w[k] = e.target.value;
        if (k === 'name') w.nameTouched = !!e.target.value.trim();   // cleared: the suggestion comes back
        if (k === 'baseValue') w.baseTouched = true;
        if (!auction && !planned && (k === 'memberCount' || k === 'installment') && !w.baseTouched) {
            w.baseValue = num(w.memberCount) * num(w.installment);
            host.querySelector('[data-k="baseValue"]').value = w.baseValue;
        }
        if (k === 'winnerExtraType') {
            w.winnerExtraValue = defaultExtra(w.winnerExtraType, num(w.monthlyIncrement), num(w.baseValue));
            host.querySelector('[data-k="winnerExtraValue"]').value = w.winnerExtraType === 'NONE' ? '' : w.winnerExtraValue;
            host.querySelector('[data-extra-box]').hidden = w.winnerExtraType === 'NONE';
            host.querySelector('[data-extra-unit]').textContent = w.winnerExtraType === 'PERCENT' ? '%' : '₹';
        }
        preview();
    };
    host.onchange = e => { if (!e.target.closest('[data-plan-i]') && !e.target.dataset.fill) host.oninput(e); };
    host.onclick = e => {
        const kind = e.target.closest('[data-type]');
        if (kind) { w.chitType = kind.dataset.type; drawDetails(host, w); return; }
        const share = e.target.closest('[data-plan]');
        if (share) { (share.dataset.plan === 'pdf' ? printPlan : sharePlan)(w); return; }
        if (e.target.closest('[data-fill-go]')) {
            const first = num(host.querySelector('[data-fill="first"]').value);
            const last = num(host.querySelector('[data-fill="last"]').value);
            if (!(first > 0 && last > 0)) { toast('Enter what the first and last winners get', 'error'); return; }
            spreadPayouts(w.plan.length, first, last).forEach((p, i) => { w.plan[i].payout = p; });
            w.payTouched = true;
            preview();
            return;
        }
        if (e.target.closest('[data-extra-fix]')) {
            e.preventDefault();
            w.winnerExtraType = 'FIXED';
            w.winnerExtraValue = num(w.monthlyIncrement);
            host.querySelector('[data-k="winnerExtraType"]').value = 'FIXED';
            host.querySelector('[data-k="winnerExtraValue"]').value = w.winnerExtraValue;
            host.querySelector('[data-extra-box]').hidden = false;
            host.querySelector('[data-extra-unit]').textContent = '₹';
            preview();
            return;
        }
        if (e.target.closest('[data-base-auto]')) {
            e.preventDefault();
            w.baseTouched = false;
            w.baseValue = num(w.memberCount) * num(w.installment);
            host.querySelector('[data-k="baseValue"]').value = w.baseValue;
            preview();
        }
    };
    preview();
}

/** "3, 5–9, 12" from month numbers. */
function compactMonths(list) {
    const out = [];
    list.forEach((no, i) => {
        if (i && no === list[i - 1] + 1) { out[out.length - 1][1] = no; return; }
        out.push([no, no]);
    });
    return out.map(([a, b]) => a === b ? `${a}` : `${a}–${b}`).join(', ');
}

const signedMoney = v => `${v < 0 ? '−' : ''}${money(Math.abs(v))}`;

/** The totals row of a planned chit's table. */
function plannedFootHtml(rows, forMembers) {
    const total = f => rows.reduce((s, x) => s + f(x), 0);
    const net = total(x => x.commission);
    return forMembers
        ? `<tfoot data-plan-foot><tr class="total"><td colspan="3">Total</td><td class="r">${money(total(x => x.payout))}</td></tr></tfoot>`
        : `<tfoot data-plan-foot><tr class="total"><td colspan="3">Total</td><td class="r">${money(total(x => x.collect))}</td><td class="r">${money(total(x => x.payout))}</td>
            <td class="r ${net < 0 ? 'neg' : 'gold-ink'}">${signedMoney(net)}</td><td></td></tr></tfoot>`;
}

/**
 * The full chit table. Fixed: per month what members who have not won pay, what past winners pay (with the extra),
 * what you collect, the chit value, your commission and what the winner gets. Planned: what each pays, what you
 * collect, what the winner gets, the commission (negative in months that pay out more) and the commission kept so
 * far; editable in the wizard and the plan editor. forMembers: the members' copy, without the commission.
 * locked: months that cannot change (paid out); lockedEmi: months whose installment cannot change (payments in).
 */
function planTableHtml(w, { r, rows }, { forMembers = false, editable = false, locked = new Set(), lockedEmi = new Set() } = {}) {
    if (w.chitType === 'AUCTION') return auctionGuideHtml(r, num(w.maxBidPercent), { forMembers });
    if (w.chitType === 'PLANNED') {
        const kept = reserveOf(rows).cumulative;
        const cell = (i, field, value, isLocked) => editable && !isLocked
            ? `<input type="number" class="num hc-plan-input" data-plan-i="${i}" data-plan-field="${field}" value="${value}" step="any" min="0" inputmode="decimal" data-plain>`
            : `${money(value)}${isLocked ? ` <span class="hc-lock" title="${field === 'installment' ? 'Payments are recorded for this month' : 'Paid out'}">${icon('lock')}</span>` : ''}`;
        return `<table class="grid compact hc-plan ${editable ? 'hc-plan-edit' : ''}">
            <thead><tr><th class="c">Month</th><th>Pay by</th><th class="r">Each pays</th>${forMembers ? '' : '<th class="r">You collect</th>'}<th class="r">Winner gets</th>
                ${forMembers ? '' : '<th class="r" title="Collected less paid out; negative when the winner gets more than is collected">Commission</th><th class="r" title="Your commission so far, after this month">Kept so far</th>'}</tr></thead>
            <tbody>${rows.map((x, i) => `<tr data-plan-row="${i}" class="${locked.has(x.monthNo) ? 'hc-past' : ''}">
                <td class="c">${x.monthNo}</td><td>${shortDateYear(x.dueDate)}</td>
                <td class="r">${cell(i, 'installment', x.installment, locked.has(x.monthNo) || lockedEmi.has(x.monthNo))}</td>
                ${forMembers ? '' : `<td class="r" data-cell="collect">${money(x.collect)}</td>`}
                <td class="r"><b>${cell(i, 'payout', x.payout, locked.has(x.monthNo))}</b></td>
                ${forMembers ? '' : `<td class="r ${x.commission < 0 ? 'neg' : 'gold-ink'}" data-cell="commission">${signedMoney(x.commission)}</td>
                    <td class="r muted ${kept[i] < 0 ? 'neg' : ''}" data-cell="kept">${money(kept[i])}</td>`}</tr>`).join('')}</tbody>
            ${plannedFootHtml(rows, forMembers)}
        </table>`;
    }
    const extra = extraOf(r);
    const total = (f) => rows.reduce((s, x) => s + f(x), 0);
    return `<table class="grid compact hc-plan">
        <thead><tr><th class="c">Month</th><th>Pay by</th><th class="r" title="Members who have not won yet">Members pay</th><th class="r" title="Members who won an earlier month (installment + extra)">Past winners pay</th>
            ${forMembers ? '' : '<th class="r">You collect</th>'}<th class="r">Chit value</th>${forMembers ? '' : '<th class="r">Commission</th>'}<th class="r">Winner gets</th></tr></thead>
        <tbody>${rows.map(x => `<tr><td class="c">${x.monthNo}</td><td>${shortDateYear(x.dueDate)}</td>
            <td class="r">${money(r.installment)} <small class="muted">× ${r.memberCount - x.monthNo + 1}</small></td>
            <td class="r">${x.monthNo > 1 ? `${money(r.installment + extra)} <small class="muted">× ${x.monthNo - 1}</small>` : '<span class="muted">—</span>'}</td>
            ${forMembers ? '' : `<td class="r">${money(x.collect)}</td>`}<td class="r">${money(x.chitValue)}</td>${forMembers ? '' : `<td class="r">${money(r.commission)}</td>`}
            <td class="r"><b>${money(x.payout)}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr class="total"><td colspan="4">Total</td>${forMembers ? '' : `<td class="r">${money(total(x => x.collect))}</td>`}<td></td>
            ${forMembers ? '' : `<td class="r">${money(r.commission * rows.length)}</td>`}<td class="r">${money(total(x => x.payout))}</td></tr></tfoot>
    </table>`;
}

/**
 * Auction chits have no fixed table (the bids decide each month), so instead: what the month looks like at the
 * lowest, a middle and the highest bid (winner gets, the dividend, what everyone pays), what a member pays over
 * the chit, and (organiser only) the commission.
 */
function auctionGuideHtml(r, maxBidPercent, { forMembers = false } = {}) {
    const n = Math.max(1, r.memberCount);
    const low = r.commission;
    const high = Math.round(r.baseValue * maxBidPercent / 100);
    const mid = Math.round((low + high) / 2 / 1000) * 1000;
    const scenario = (label, bid, cls) => {
        const dividend = Math.floor((bid - r.commission) / n);
        return `<div class="hc-ag-card ${cls}"><small>${label}</small><b>${money(bid)}</b><em>winning bid</em>
            <dl><dt>Winner gets</dt><dd>${money(r.baseValue - bid)}</dd>
                <dt>Dividend each</dt><dd>${money(dividend)}</dd>
                <dt>Everyone pays</dt><dd>${money(r.installment - dividend)}</dd></dl></div>`;
    };
    const lowest = r.installment * n - Math.floor((high - low) / n) * (n - 1);
    return `<div class="hc-auction-guide">
        <p class="muted hc-small">The amounts change every month with the winning bid, so there is no fixed table. This is what a month looks like:</p>
        <div class="hc-ag-cards">${scenario('Lowest bid', low, 'low')}${scenario('A middle bid', mid, 'mid')}${scenario('Highest bid allowed', high, 'high')}</div>
        <ul class="hc-explain hc-explain-sm">
            <li>${icon('users')}<span>Chit value <b>${money(r.baseValue)}</b>, ${n} members, ${money(r.installment)} a month before the dividend, by the ${ordinal(r.dueDay || 1)}.</span></li>
            <li>${icon('hand-coins')}<span>A member pays between <b>${money(Math.max(0, lowest))}</b> (every month at the highest bid) and <b>${money(r.installment * n)}</b> over the chit.</span></li>
            <li>${icon('crown')}<span>Bidding early gets the money sooner for a bigger discount; the last member left takes the chit at the lowest bid: <b>${money(r.baseValue - low)}</b>.</span></li>
            ${forMembers ? '' : `<li>${icon('piggy')}<span>You keep <b>${money(r.commission)}</b> a month (the lowest bid), <b>${money(r.commission * n)}</b> over the chit.</span></li>`}
        </ul></div>`;
}

/** The chit table on a page of its own, for the members (no commission): print it or save it as a PDF. */
function printPlan(w) {
    const plan = planOf(w);
    const { r, rows } = plan;
    const auction = w.chitType === 'AUCTION';
    const planned = w.chitType === 'PLANNED';
    const el = document.createElement('div');
    el.className = 'hc-plan-print';
    el.innerHTML = `<div class="hc-rc-head"><div><small>Chit table${auction ? ' · auction chit' : planned ? ' · planned chit' : ''}</small><h3>${esc(w.name || 'New chit')}</h3>
            <span class="muted">${esc(w.payeeName || state.user?.fullName || '')}</span></div>
            <div class="hc-rc-no"><b>${r.memberCount} members · ${r.months} months</b><span>${monthName(w.startMonth + '-01')} – ${monthName(rows.at(-1).dueDate)}</span></div></div>
        <p class="hc-plan-terms">${auction
            ? `Chit value ${money(r.baseValue)}. Each member pays ${money(r.installment)} a month less that month's dividend, by the ${ordinal(r.dueDay)}. Bids from ${money(r.commission)} up to ${money(Math.round(r.baseValue * num(w.maxBidPercent) / 100))}.`
            : planned ? `Each member pays ${rows.every(x => x.installment === rows[0].installment) ? `${money(rows[0].installment)} a month` : 'the amount shown for each month'} by the ${ordinal(r.dueDay)}. Each month's winner gets the amount shown.`
            : `Each member pays ${money(r.installment)} a month by the ${ordinal(r.dueDay)}${extraOf(r) ? `; after winning, ${money(r.installment + extraOf(r))} a month` : ''}.`}
            ${r.lateFeePercent ? ` Late payments carry ${r.lateFeePercent}% a month after ${r.lateGraceDays} days.` : ''}</p>
        ${planTableHtml(w, plan, { forMembers: true })}`;
    printElement(el, `Chit table - ${w.name || 'new chit'}`);
}

/**
 * A link to the chit table for the members (it is carried in the link itself, nothing is saved). It carries what
 * each member pays and what each winner gets, never the commission.
 */
function sharePlan(w) {
    const r = draftRequest(w);
    const { rows } = planOf(w);
    const data = {
        v: 2, n: r.name || 'New chit', t: r.chitType, s: w.startMonth, d: r.dueDay, m: r.memberCount, i: r.installment, b: r.baseValue,
        inc: r.monthlyIncrement, x: w.chitType === 'FIXED' ? extraOf(r) : 0, mb: r.maxBidPercent, l: r.lateFeePercent,
        g: r.lateGraceDays, o: (w.payeeName || state.user?.fullName || '').trim(), h: state.user?.tenantName || '',
    };
    if (w.chitType === 'AUCTION') data.lb = r.commission;   // the lowest bid
    else data.p = rows.map(x => x.payout);
    if (w.chitType === 'PLANNED' && rows.some(x => x.installment !== rows[0].installment)) data.e = rows.map(x => x.installment);
    if (w.chitType === 'PLANNED') data.i = rows[0].installment;
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(data)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `${location.origin}/chit-share.html#plan=${encoded}`;
    const text = `${data.n}: the chit table (${data.m} members, ${money(data.i)} a month). ${url}`;
    openModal({
        title: 'Share the chit table', iconName: 'link',
        body: `<p class="muted" style="margin-top:0">Members see what they pay and what each winner gets, not your commission. The figures travel inside the link: nothing is saved, and it does not change if you edit the chit later.</p>
            <div class="ln-made cs-made"><div class="ln-qr">${qrSvg(url, { size: 140 })}</div>
            <div class="ln-made-main">
                <div class="ln-url"><input value="${esc(url)}" readonly data-plain><button type="button" class="btn sm primary" data-copy-url="${esc(url)}">${icon('copy')}Copy</button></div>
                <div class="row"><a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(text)}">${icon('phone')}Send on WhatsApp</a>
                    <a class="btn sm" target="_blank" rel="noopener" href="mailto:?subject=${encodeURIComponent(`${data.n} - chit table`)}&body=${encodeURIComponent(text)}">${icon('mail')}E-mail</a>
                    <a class="btn sm" target="_blank" rel="noopener" href="${esc(url)}">${icon('eye')}Preview</a></div>
            </div></div>`,
        actions: [{ label: 'Done', kind: 'primary' }],
    });
}

/** A running chit as a draft, to print or share its table (and, for planned chits, to edit it). */
/** A new chit's draft copied from a chit: same terms and members, from next month, with its own name and accounts. */
function copyDraft(d) {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const from = draftFromChit(d);
    const w = { ...newDraft(), ...from, name: '', nameTouched: false, copiedFrom: d.chit.name,
        startMonth: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`,
        commissionPercent: Math.round(num(from.commissionPercent) * 100) / 100,
        winnerExtraType: from.winnerExtraType === 'NONE' ? 'FIXED' : from.winnerExtraType, payToAccountId: d.chit.payToAccountId || null,
        members: d.members.slice().sort((a, b) => a.slot - b.slot).map(m => ({ name: m.name, phone: m.phone || '', email: m.email || '',
            payoutAccount: m.payoutAccount || '', payToAccountId: m.payToAccountId || null, upiId: m.upiId || '' })) };
    if (d.chit.winnerExtraType === 'NONE') w.winnerExtraValue = 0;
    w.plan = from.plan.map(x => ({ ...x }));
    return w;
}

function draftFromChit(d) {
    const c = d.chit;
    return {
        chitType: c.chitType, name: c.name, startMonth: c.startMonth.slice(0, 7), dueDay: c.dueDay, memberCount: c.memberCount,
        installment: isPlanned(c) ? num(d.schedule[0]?.installment) : num(c.installment), baseValue: num(c.baseValue), monthlyIncrement: num(c.monthlyIncrement),
        commission: num(c.commission), winnerExtraType: c.winnerExtraType, winnerExtraValue: num(c.winnerExtraValue),
        auctionValue: num(c.baseValue), commissionPercent: num(c.baseValue) ? (num(c.commission) / num(c.baseValue)) * 100 : 0, maxBidPercent: num(c.maxBidPercent),
        installmentIncrement: num(c.installmentIncrement), payTouched: true,
        plan: d.schedule.map(m => ({ installment: num(m.installment), payout: num(m.payout), instTouched: true })),
        lateFeePercent: num(c.lateFeePercent), lateGraceDays: c.lateGraceDays, payeeName: c.payeeName || '', upiId: c.upiId || '',
        postToBooks: true, members: [],
    };
}

/** The late-interest sentence of the explanation, e.g. 2% a month after 5 days: ₹500 for a month late on ₹25,000. */
function lateLine(w, installment) {
    const rate = num(w.lateFeePercent);
    if (!rate) return `<li>${icon('clock')}<span>No interest on late payments.</span></li>`;
    return `<li>${icon('clock')}<span>A late installment carries <b>${rate}% a month</b> after ${num(w.lateGraceDays)} days of grace: about <b>${money(Math.round(installment * rate / 100))}</b> for a month late on ${money(installment)}. It is your income.</span></li>`;
}

/** A sensible winner extra when the kind changes: the monthly increase, as rupees or as a % of the chit value. */
function defaultExtra(type, increment, base) {
    if (type === 'PERCENT') return increment && base ? Math.round((increment / base) * 10000) / 100 : 1;
    if (type === 'FIXED') return increment || 5000;
    return 0;
}

/** Step 2: one compact row per member (name, phone for WhatsApp, e-mail), two columns side by side. */
function drawMembers(host, w, accounts = []) {
    const n = num(w.memberCount);
    while (w.members.length < n) w.members.push({ name: '', phone: '', email: '' });
    w.members.length = n;
    const filled = () => w.members.filter(m => m.name.trim()).length;
    host.innerHTML = `
        <div class="hc-mem-tools">
            <span class="hc-count" data-count></span>
            <small class="muted">Phone for WhatsApp reminders, e-mail for e-mailed reminders and receipts: both optional.</small>
            <span class="spacer"></span>
            ${w.edit ? `<small class="muted">${icon('lock')}${n} members: the number cannot change</small>` : `
            <button type="button" class="btn sm" data-m="paste">${icon('copy')}Paste a list</button>
            <button type="button" class="btn sm" data-m="sample">${icon('sparkles')}Fill example names</button>
            ${filled() ? `<button type="button" class="btn sm ghost" data-m="clear">${icon('x')}Clear all</button>` : ''}`}
        </div>
        <div class="hc-mem-list ${n > 24 ? 'many' : ''}">${w.members.map((m, i) => `
            <div class="hc-mem-row with-pay" data-i="${i}">
                <span class="hc-slot">${i + 1}</span>
                <input type="text" data-f="name" value="${esc(m.name)}" placeholder="Name" maxlength="100" autocomplete="off" data-plain>
                <input type="tel" data-f="phone" value="${esc(m.phone)}" placeholder="Phone" inputmode="numeric" maxlength="14" autocomplete="off" data-plain>
                <input type="email" data-f="email" value="${esc(m.email || '')}" placeholder="E-mail" maxlength="120" autocomplete="off" data-plain>
                <input type="text" data-f="upiId" value="${esc(m.upiId || '')}" placeholder="Their UPI ID" maxlength="60" autocomplete="off" title="Fellow members pay them on it in the month they win" data-plain>
                <select data-f="payTo" data-plain title="What this member pays into (on their signed payment link)">${memberPayToOptions(accounts, w.edit, m, m.payToAccountId, m.payToMemberId, 'Pays into: the chit’s')}</select>
                ${w.edit ? '<span></span>' : `<button type="button" class="btn sm ghost icon" data-del title="Remove this name">${icon('x')}</button>`}
            </div>`).join('')}
        </div>`;
    const count = () => {
        const f = filled();
        const el = host.querySelector('[data-count]');
        el.textContent = f === n ? `All ${n} members added ✓` : `${f} of ${n} members added`;
        el.classList.toggle('ok', f === n);
    };
    const redraw = () => drawMembers(host, w, accounts);
    count();
    host.oninput = e => {
        const row = e.target.closest('[data-i]');
        if (!row || e.target.dataset.f === 'payTo') return;
        w.members[Number(row.dataset.i)][e.target.dataset.f] = e.target.value;
        count();
    };
    // an account picked for a member must carry a UPI ID or bank details: asked for when missing
    host.querySelectorAll('[data-f=payTo]').forEach(sel => {
        bindPayTo(sel, accounts);
        sel.addEventListener('change', () => Object.assign(w.members[Number(sel.closest('[data-i]').dataset.i)], payToValue(sel.value)));
    });
    host.onkeydown = e => {
        if (e.key !== 'Enter' || e.target.dataset.f !== 'name') return;
        e.preventDefault();
        e.stopPropagation();
        host.querySelector(`[data-i="${Number(e.target.closest('[data-i]').dataset.i) + 1}"] [data-f="name"]`)?.focus();
    };
    host.onclick = e => {
        const del = e.target.closest('[data-del]');
        if (del) {
            w.members.splice(Number(del.closest('[data-i]').dataset.i), 1);
            w.members.push({ name: '', phone: '', email: '' });
            redraw();
            return;
        }
        const act = e.target.closest('[data-m]')?.dataset.m;
        if (act === 'sample') {
            const used = new Set(w.members.map(m => m.name.trim().toLowerCase()));
            const pool = SAMPLE_NAMES.filter(s => !used.has(s.toLowerCase())).sort(() => Math.random() - 0.5);
            w.members.forEach((m, i) => {
                if (m.name.trim()) return;
                m.name = pool.shift() || `Member ${i + 1}`;
                m.phone = m.phone || randomPhone();
            });
            redraw();
        } else if (act === 'clear') {
            w.members = [];
            redraw();
        } else if (act === 'paste') {
            openPasteList(w, redraw);
        }
    };
}

/** "Ravi Kumar 9876543210 ravi@mail.com", "Ravi Kumar, 98765 43210" or just "Ravi Kumar", one per line. */
function parseMemberLines(text) {
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const email = (line.match(/[^\s,;<>]+@[^\s,;<>]+\.[^\s,;<>]{2,}/) || [''])[0];
        if (email) line = line.replace(email, ' ').replace(/[<>]/g, ' ').replace(/[\s,;:\t-]+$/, '').trim();
        const match = line.match(/^(.*?)[\s,;:\t-]*((?:\+?91[\s-]?)?\d[\d\s-]{8,}\d)\s*$/);
        if (!match) return { name: line.replace(/^\d+[.)]\s*/, '').replace(/[\s,;:-]+$/, ''), phone: '', email };
        return { name: match[1].replace(/^\d+[.)]\s*/, '').trim(), phone: match[2].replace(/\D/g, '').slice(-10), email };
    }).filter(m => m.name);
}

function openPasteList(w, done) {
    openModal({
        title: 'Paste a list of members', iconName: 'copy', size: 'lg',
        body: `<p class="muted" style="margin-top:0">One person per line. A phone number and an e-mail address on the line are picked up too.</p>
            <textarea class="hc-paste" name="list" rows="12" placeholder="Ravi Kumar 9876543210 ravi@gmail.com&#10;Lakshmi Devi&#10;Suresh Reddy, 9123456780"></textarea>
            <label class="check-line"><input type="checkbox" name="replace"> Replace the names already entered</label>`,
        actions: [
            { label: 'Cancel' },
            { label: 'Add these names', kind: 'primary', iconName: 'check', onClick: modal => {
                const list = parseMemberLines(modal.el.querySelector('[name=list]').value);
                if (!list.length) throw new Error('Paste at least one name');
                const n = num(w.memberCount);
                if (modal.el.querySelector('[name=replace]').checked) w.members = [];
                const all = [...w.members.filter(m => m.name.trim()), ...list];
                w.members = all.slice(0, n);
                const extra = all.length - n;
                toast(extra > 0 ? `Added ${list.length - extra}. ${plural(extra, 'name')} did not fit (the chit has ${n} members).` : `Added ${plural(list.length, 'name')}`,
                    extra > 0 ? 'info' : 'success');
                done();
            } },
        ],
    });
}

/** Step 3: how members pay (UPI for payment links), where the money is recorded, and a last look, side by side. */
function drawAccounts(host, w, accounts, categories) {
    const { r, rows } = planOf(w);
    const row = (label, value) => `<div class="hc-review-row"><span>${label}</span><b>${value}</b></div>`;
    const withMail = w.members.filter(m => (m.email || '').trim()).length;
    const withPhone = w.members.filter(m => m.phone.trim()).length;
    host.innerHTML = `
    <div class="hc-two hc-fit">
        <div class="hc-col">
            <div class="section-title">${icon('qr')}Collecting payments</div>
            <div class="hc-fit-grid two">
                ${fl('My UPI ID (for “Pay now” links)', 'upiId', w, { type: 'text', unit: 'e.g. name@okhdfcbank', tip: 'Members get a “Pay now” button (GPay, PhonePe, BHIM …) and a QR code with their reminders and statements' })}
                ${fl('Name shown to members and on receipts', 'payeeName', w, { type: 'text', attrs: 'maxlength="100"' })}
                <label class="field span-2 hc-payto-field"><span>Members pay into</span><select data-k="payToAccountId" data-plain>${payToOptions(accounts, { id: w.edit?.chit.id ?? null }, w.payToAccountId,
                    'The collection account (else the UPI ID above)')}</select>
                    <small>Its UPI ID, or its bank details (account number and IFSC), go on members’ payment links</small></label>
                ${fl('Short code for payment notes', 'shortCode', w, { type: 'text', attrs: 'maxlength="4" style="text-transform:uppercase"',
                    unit: `note <b data-code-preview>${esc(payCode({ shortCode: (w.shortCode || '').toUpperCase() || deriveShortCode(w.name) }, 1))}</b>`,
                    tip: 'Up to 4 letters or digits. Payment notes are this, a dash and the month: 8 characters, so they show whole on bank statements. Empty: made from the name.' })}
                ${fl('Notes', 'notes', w, { type: 'text', attrs: 'maxlength="255"', tip: 'Only for you' })}
            </div>
            <div class="section-title">${icon('journal')}My accounts</div>
            ${booksFields(w, accounts, categories, 'data-k', true)}
        </div>
        <div class="hc-col">
            <div class="section-title">${icon('check-circle')}${esc(w.name)}</div>
            <div class="hc-review">
                ${row('Type', w.chitType === 'AUCTION' ? 'Auction (Margadarsi style)' : w.chitType === 'PLANNED' ? 'Planned (you set each month’s payout)' : 'Fixed')}
                ${row('Runs', `${monthName(w.startMonth + '-01')} – ${monthName(rows.at(-1).dueDate)} (${r.months} months)`)}
                ${row('Members pay', `${money(r.installment)} each, by the ${ordinal(r.dueDay)}${w.chitType === 'AUCTION' ? ' (less the dividend)' : ''}`)}
                ${w.chitType === 'AUCTION' ? row('Bids', `${money(r.commission)} – ${money(Math.round(r.baseValue * r.maxBidPercent / 100))}`)
                    : w.chitType === 'PLANNED' ? row('EMI', num(w.installmentIncrement) ? `rises ${money(w.installmentIncrement)} a month` : rows.every(x => x.installment === rows[0].installment) ? 'the same every month' : 'as in the chit table')
                    : row('After winning', extraOf(r) ? `pays ${money(r.installment + extraOf(r))} a month` : 'the same amount')}
                ${row('Winner gets', w.chitType === 'AUCTION' ? 'chit value − winning bid' : `${money(rows[0].payout)} → ${money(rows.at(-1).payout)}`)}
                ${w.chitType === 'PLANNED' ? row('Your commission', (() => { const res = reserveOf(rows); return `${money(res.total)} over the chit${res.peak ? ` · keep up to ${money(res.peak)} for months ${compactMonths(res.negative)}` : ''}`; })())
                    : row('Your commission', `${money(r.commission)} a month · ${money(r.commission * r.months)} in all`)}
                ${row('Late payments', r.lateFeePercent ? `${r.lateFeePercent}% a month after ${r.lateGraceDays} days` : 'no interest')}
                ${row('Members', `${r.memberCount}: ${esc(w.members.slice(0, 3).map(m => m.name).join(', '))}${r.memberCount > 3 ? '…' : ''}`)}
                ${row('Reminders & receipts', `${withPhone} on WhatsApp · ${withMail} by e-mail`)}
            </div>
            <p class="book-note">${icon('signature')}<span>After creating, add your signature for receipts under <b>Settings → Receipt signature</b> (or from the first receipt).</span></p>
        </div>
    </div>`;
    host.addEventListener('input', e => {
        const k = e.target.dataset.k;
        if (['upiId', 'payeeName', 'shortCode', 'notes'].includes(k)) w[k] = e.target.value;
        if (k === 'shortCode') {
            e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
            w.shortCode = e.target.value;
            host.querySelector('[data-code-preview]').textContent = payCode({ shortCode: w.shortCode || deriveShortCode(w.name) }, 1);
        }
    });
    const payTo = host.querySelector('[data-k=payToAccountId]');
    bindPayTo(payTo, accounts);
    payTo?.addEventListener('change', () => { w.payToAccountId = payTo.value ? Number(payTo.value) : null; });
    bindBooksFields(host, w, 'data-k');
}

/**
 * Where the members' payments, the commission and late interest go, and the income category, as rows of choice
 * chips (a drop-down appears only for "an account I have"). New chits are always recorded in the accounts; an older
 * chit that is not shows a switch to start (once on, it stays on).
 */
function booksFields(s, accounts, categories, attr, always = false) {
    const cashLike = a => a.accountClass === 'ASSET' && a.accountType !== 'CHIT_FUND';
    const key = name => attr === 'data-k' ? `data-k="${name}"` : `name="${name}"`;
    // a radio group needs one shared name, or every option stays ticked
    const chip = (name, value, checked, label, tip = '') => `<label class="hc-chip-radio" title="${esc(tip)}"><input type="radio" ${attr === 'data-k' ? `data-k="${name}" name="hc-${name}"` : `name="${name}"`}
        value="${value}" ${checked ? 'checked' : ''}><span>${label}</span></label>`;
    // this chit's own accounts, the common chit accounts (Chit accounts) and your own cash / bank accounts
    const pick = (name, value) => `<span class="hc-pick" data-pick="${name}"><select ${key(name)}>${moneyAccountOptions(accounts.filter(cashLike),
        { chitId: s.chitId || null, chitName: s.name || 'This chit', selected: value })}</select></span>`;
    const dedicated = categories.find(c => c.name === 'Chit Commission Income');
    return `<div class="hc-books">
        ${always || s.locked ? `<p class="book-note">${icon('check-circle')}<span>Recorded in my accounts: journal, income and balance sheet. Money is held under <b>Hosted Chit Funds</b> until paid out; only commission and late interest are income.
            New accounts are the chit's own, kept under <b>Host a Chit › Chit accounts</b> (not on the Accounts page).</span></p>`
            : `<label class="check-line"><input type="checkbox" ${key('postToBooks')} ${s.postToBooks ? 'checked' : ''}> Start recording this chit's money in my accounts (journal, income, balance sheet)</label>`}
        <div data-books ${s.postToBooks ? '' : 'hidden'}>
            <div class="hc-book-row"><span class="hc-book-label">Members' payments</span>
                <span class="hc-chips">${chip('collection', 'SEPARATE', s.collection === 'SEPARATE', 'New account', 'A new account “<name> - collections”')}
                ${chip('collection', 'EXISTING', s.collection === 'EXISTING', 'An account I have')}</span>
                ${pick('accountId', s.accountId)}<small class="hc-book-new" data-new="collection">“<i data-name-preview></i> - collections”</small></div>
            <div class="hc-book-row"><span class="hc-book-label">My commission</span>
                <span class="hc-chips">${chip('commissionTo', 'SEPARATE', s.commissionTo === 'SEPARATE', 'New account', 'A new account “<name> - commission”')}
                ${chip('commissionTo', 'SAME', s.commissionTo === 'SAME', 'Same as payments')}
                ${chip('commissionTo', 'EXISTING', s.commissionTo === 'EXISTING', 'An account I have')}</span>
                ${pick('commissionAccountId', s.commissionAccountId)}<small class="hc-book-new" data-new="commissionTo">“<i data-name-preview></i> - commission”</small></div>
            <div class="hc-book-row"><span class="hc-book-label">Late interest</span>
                <span class="hc-chips">${chip('lateTo', 'SEPARATE', s.lateTo === 'SEPARATE', 'New account', 'A new account “<name> - late interest”, income “Chit Late Payment Interest”')}
                ${chip('lateTo', 'SAME', s.lateTo === 'SAME', 'Same as commission')}
                ${chip('lateTo', 'EXISTING', s.lateTo === 'EXISTING', 'An account I have')}</span>
                ${pick('lateFeeAccountId', s.lateFeeAccountId)}<small class="hc-book-new" data-new="lateTo">“<i data-name-preview></i> - late interest”</small></div>
            <div class="hc-book-row"><span class="hc-book-label">Commission income</span>
                <span class="hc-pick wide"><select ${key('commissionCategoryId')} title="A separate income category keeps chit earnings apart in Income and Reports">
                    ${dedicated ? '' : `<option value="" ${!s.commissionCategoryId ? 'selected' : ''}>Chit Commission Income (new, recommended)</option>`}
                    ${categories.map(c => `<option value="${c.id}" ${c.id === Number(s.commissionCategoryId) ? 'selected' : ''}>${esc(c.name)}${c.name === 'Chit Commission Income' ? ' (recommended)' : ''}</option>`).join('')}</select></span></div>
        </div>
    </div>`;
}

function bindBooksFields(host, s, attr) {
    const sync = () => {
        host.querySelector('[data-books]').hidden = !s.postToBooks;
        // hide the wrapper: the app's searchable drop-down sits beside the real select
        host.querySelector('[data-pick="accountId"]').hidden = s.collection !== 'EXISTING';
        host.querySelector('[data-pick="commissionAccountId"]').hidden = s.commissionTo !== 'EXISTING';
        host.querySelector('[data-pick="lateFeeAccountId"]').hidden = s.lateTo !== 'EXISTING';
        host.querySelectorAll('[data-new]').forEach(x => { x.hidden = s[x.dataset.new] !== 'SEPARATE'; });
        host.querySelectorAll('[data-name-preview]').forEach(i => { i.textContent = s.name || 'Chit'; });
    };
    host.addEventListener('change', e => {
        const k = attr === 'data-k' ? e.target.dataset.k : e.target.name;
        if (!k) return;
        if (k === 'postToBooks') s.postToBooks = e.target.checked;
        else if (k === 'collection' || k === 'commissionTo' || k === 'lateTo') s[k] = e.target.value;
        else if (k === 'accountId' || k === 'commissionAccountId' || k === 'commissionCategoryId' || k === 'lateFeeAccountId') s[k] = e.target.value ? Number(e.target.value) : null;
        sync();
    });
    sync();
}


// ===================================================================== dialogs

/**
 * Record (or change) a member's payment for a month: full or part of the installment, late interest collected or
 * let off, date, mode, transaction reference, a note and evidence (photo or PDF, kept on the journal entry). After
 * saving, the receipt opens, ready to print or send.
 */
async function openPayment(d, memberId, monthNo, editing = null) {
    const c = d.chit;
    const member = d.members.find(m => m.id === memberId);
    const month = monthOf(d, monthNo);
    if (!editing && isAuction(c) && month.bid === null) {
        toast(`Record the auction for month ${monthNo} first: the dividend decides what each member pays`, 'error');
        return;
    }
    const accounts = c.postToBooks ? await loadAccounts(false, { all: true }).catch(() => []) : [];
    // the member may have paid into any of my accounts: the last one they used is the likely one
    const lastInto = d.payments.filter(p => p.memberId === memberId && p.accountId && !p.paidToMemberId).sort((a, b) => b.id - a.id)[0]?.accountId;
    // members can pay this month's winner directly (the winner's own installment: set off against the payout)
    const winner = month.winnerMemberId && !month.payoutDate ? d.members.find(m => m.id === month.winnerMemberId) : null;
    // a member pointed at this month's winner pays them directly by default
    let direct = editing ? !!editing.paidToMemberId : !!(winner && member.payToMemberId === winner.id);
    const due = dueFor(d, member, month);
    const list = d.payments.filter(p => p.memberId === memberId && p.monthNo === monthNo);
    const paid = list.reduce((s, p) => s + num(p.amount), 0) - (editing ? num(editing.amount) : 0);
    const balance = Math.max(0, due - paid);
    const late = (d.lateFees || []).find(x => x.memberId === memberId && x.monthNo === monthNo);
    const lateOpen = Math.max(0, num(late?.due) + (editing ? num(editing.lateFee) + num(editing.lateFeeWaived) : 0));
    const amount = editing ? num(editing.amount) : balance;
    const why = isAuction(c) && num(month.dividend) ? `${money(c.installment)} less ${money(month.dividend)} dividend`
        : due > num(c.installment) ? `includes ${money(c.winnerExtraAmount)} winner extra` : '';
    const chip = (label, value) => `<button type="button" class="date-chip" data-amount="${value}">${label}</button>`;
    let evidence = null;
    openModal({
        title: `${member.name} · month ${monthNo}`, iconName: 'hand-coins', size: 'lg',
        body: `
        <div class="hc-pay-sum">
            <span><small>Installment</small><b>${money(due)}</b></span>
            <span><small>Paid${editing ? ' (other payments)' : ''}</small><b class="pos">${money(paid)}</b></span>
            <span><small>Still owes</small><b class="${balance ? 'neg' : 'pos'}">${balance ? money(balance) : 'Nothing'}</b></span>
            ${late || lateOpen ? `<span><small>Late interest</small><b class="neg">${money(lateOpen)}</b></span>` : ''}
        </div>
        <p class="muted hc-small">Pay by ${date(month.dueDate)}${why ? ` · ${why}` : ''}${late ? ` · ${late.daysLate || 0} days late, ${num(c.lateFeePercent)}% a month after ${c.lateGraceDays} days` : ''}</p>
        ${list.length ? `<div class="section-title">${icon('check')}Payments received</div><div class="cs-list">${list.map(p => `<div class="cs-row ${editing?.id === p.id ? 'active' : ''}">
            <span class="grow min-0"><b>${money(num(p.amount) + num(p.lateFee))}</b> <small class="muted">${esc(p.receiptNo || '')} · ${date(p.paidDate)} · ${esc(p.mode)}${p.accountName ? ` · into ${esc(p.accountName)}` : ''}${p.reference ? ' · ref ' + esc(p.reference) : ''}${num(p.lateFee) ? ` · incl. ${money(p.lateFee)} late interest` : ''}${p.note ? ' · ' + esc(p.note) : ''}</small></span>
            ${p.attachmentCount ? `<button type="button" class="btn sm ghost icon" data-entry="${p.journalEntryId}" title="${p.attachmentCount} file(s) of evidence">${icon('paperclip')}</button>` : ''}
            <button type="button" class="btn sm ghost" data-pay-receipt="${p.id}">${icon('receipt')}Receipt</button>
            <button type="button" class="btn sm ghost icon" data-pay-edit="${p.id}" title="Change">${icon('edit')}</button>
            <button type="button" class="btn sm ghost icon" data-pay-undo="${p.id}" title="Undo">${icon('undo')}</button>
        </div>`).join('')}</div>` : ''}
        <form class="form-grid two">
            <div class="section-title span-2">${icon(editing ? 'edit' : 'plus')}${editing ? `Change ${esc(editing.receiptNo || 'the payment')} of ${date(editing.paidDate)}` : 'Record a payment'}</div>
            <label class="field"><span>Towards the installment (₹)</span><input type="number" name="amount" step="any" min="0" class="num" data-type="number" inputmode="decimal" value="${amount}">
                <span class="ln-chips hc-amount-chips">${balance ? chip(`Full ${moneyShort(balance)}`, balance) : ''}${balance > 1 ? chip(`Half ${moneyShort(Math.round(balance / 2))}`, Math.round(balance / 2)) : ''}${chip('Nothing', 0)}</span></label>
            <label class="field"><span>Date</span><input type="date" name="paidDate" value="${editing ? editing.paidDate : isoDate()}"></label>
            ${lateOpen || num(c.lateFeePercent) ? `
            <label class="field"><span>Late interest collected (₹)</span><input type="number" name="lateFee" step="any" min="0" class="num" data-type="number" inputmode="decimal"
                value="${editing ? num(editing.lateFee) : lateOpen}"></label>
            <label class="field"><span>Let off (waive) late interest (₹)</span><input type="number" name="lateFeeWaived" step="any" min="0" class="num" data-type="number" inputmode="decimal"
                value="${editing ? num(editing.lateFeeWaived) : 0}"><small>${lateOpen ? `${money(lateOpen)} is due` : 'nothing due now'}</small></label>` : ''}
            ${winner || direct ? `<div class="field span-2"><span>Paid to</span><div class="seg-chips" data-to>
                <button type="button" class="seg-chip ${direct ? '' : 'active'}" data-direct="0">${icon('arrow-in')}Me</button>
                <button type="button" class="seg-chip ${direct ? 'active' : ''}" data-direct="1" ${winner ? '' : 'disabled'}>${icon('hand')}${
                    winner ? (winner.id === memberId ? 'Set off against the payout' : `${esc(winner.name)} directly (the winner)`) : 'The winner directly'}</button></div>
                <small data-direct-note ${direct ? '' : 'hidden'}>The money went straight to the winner and is taken off what you pay them. Attach their acknowledgement or the transfer screenshot as evidence.</small></div>` : ''}
            <div class="field ${c.postToBooks ? '' : 'span-2'}"><span>Paid by</span>${modeChips(editing?.mode || 'Cash')}</div>
            ${c.postToBooks ? `<label class="field" data-into ${direct ? 'hidden' : ''}><span>Received into</span><select name="accountId">${moneyAccountOptions(accounts,
                { chitId: c.id, chitName: c.name, selected: (!direct && editing?.accountId) || member?.payToAccountId || lastInto || c.payToAccountId || c.accountId })}</select>
                <small>The chit's account, or your own bank account if the member paid there</small></label>` : ''}
            <label class="field"><span>Transaction reference</span><input type="text" name="reference" maxlength="60" value="${esc(editing?.reference || '')}" placeholder="UPI ref, cheque or transfer no." data-plain></label>
            <label class="field"><span>Note <small class="muted">optional</small></span><input type="text" name="note" maxlength="255" value="${esc(editing?.note || '')}" data-plain></label>
            ${c.postToBooks ? `<div class="span-2">${evidenceFieldHtml({ label: 'Evidence', hint: 'UPI screenshot, cash receipt or cheque photo' })}</div>`
                : `<p class="muted hc-small span-2">${icon('info')}Turn on “record in my accounts” in Settings to keep evidence with payments.</p>`}
            ${editing ? '' : `<label class="check-line span-2"><input type="checkbox" name="showReceipt" checked> Show the receipt after saving (print or send it)</label>`}
        </form>`,
        actions: [
            { label: 'Cancel' },
            { label: editing ? 'Save change' : 'Save payment', kind: 'primary', iconName: 'check', onClick: async modal => {
                const form = modal.el.querySelector('form');
                const value = Number(form.amount.value || 0);
                const lateFee = Number(form.lateFee?.value || 0);
                const waived = Number(form.lateFeeWaived?.value || 0);
                if (value < 0 || lateFee < 0 || waived < 0) throw new Error('Amounts cannot be negative');
                if (form.paidDate.value && form.paidDate.value > isoDate()) throw new Error('The payment date cannot be in the future');
                if (c.postToBooks && !direct && form.accountId && !form.accountId.value) throw new Error('Pick the account the money came into');
                if (value + lateFee + waived <= 0) throw new Error('Enter the amount received');
                let allowExcess = false;
                if (paid + value > due || lateFee + waived > lateOpen) {
                    allowExcess = await confirmDialog(paid + value > due
                        ? `With this, ${member.name} will have paid ${money(paid + value)} for month ${monthNo}, more than the ${money(due)} due. Save anyway?`
                        : `That settles ${money(lateFee + waived)} of late interest, but only ${money(lateOpen)} is due. Save anyway?`,
                        { title: 'More than is due', confirmLabel: 'Save anyway', danger: false });
                    if (!allowExcess) return true;
                }
                const body = { memberId, monthNo, amount: value, lateFee, lateFeeWaived: waived, reference: form.reference.value.trim() || null,
                    paidDate: form.paidDate.value || null, mode: chosenMode(modal.el), note: form.note.value.trim() || null, allowExcess, version: editing?.version,
                    accountId: form.accountId?.value && !direct ? Number(form.accountId.value) : null,
                    paidToMemberId: direct ? (winner?.id ?? editing?.paidToMemberId) : null };
                if (direct && (lateFee || waived)) throw new Error('Late interest is yours: record it as a separate payment to you');
                const fresh = await (editing ? api.put(`/hosted-chits/${c.id}/payments/${editing.id}`, body) : api.post(`/hosted-chits/${c.id}/payments`, body));
                const saved = editing ? fresh.payments.find(p => p.id === editing.id)
                    : fresh.payments.filter(p => p.memberId === memberId && p.monthNo === monthNo).sort((a, b) => b.id - a.id)[0];
                let withFiles = fresh;
                if (evidence?.count && saved?.journalEntryId) {
                    await evidence.uploadTo(saved.journalEntryId);
                    withFiles = await api.get(`/hosted-chits/${c.id}`);
                }
                await afterChange(withFiles, editing ? 'Payment changed' : `${member.name} paid ${money(value + lateFee)} ✓ · ${saved?.receiptNo || ''}`);
                if (!editing && form.showReceipt?.checked && saved) openReceipt(withFiles, withFiles.payments.find(p => p.id === saved.id));
            } },
        ],
        onOpen: modal => {
            bindModeChips(modal.el);
            evidence = c.postToBooks ? bindEvidenceField(modal.el) : null;
            modal.el.addEventListener('click', e => {
                const amountChip = e.target.closest('[data-amount]');
                if (amountChip) { modal.el.querySelector('[name=amount]').value = amountChip.dataset.amount; return; }
                const to = e.target.closest('[data-direct]');
                if (to) {
                    direct = to.dataset.direct === '1';
                    modal.el.querySelectorAll('[data-to] [data-direct]').forEach(x => x.classList.toggle('active', x === to));
                    modal.el.querySelector('[data-direct-note]').hidden = !direct;
                    const intoField = modal.el.querySelector('[data-into]');
                    if (intoField) intoField.hidden = direct;
                    if (direct) ['lateFee', 'lateFeeWaived'].forEach(n => { const i = modal.el.querySelector(`[name=${n}]`); if (i) i.value = 0; });
                    return;
                }
                const edit = e.target.closest('[data-pay-edit]');
                const undo = e.target.closest('[data-pay-undo]');
                const receipt = e.target.closest('[data-pay-receipt]');
                const entry = e.target.closest('[data-entry]');
                if (edit) { modal.close(); openPayment(current, memberId, monthNo, current.payments.find(p => p.id === Number(edit.dataset.payEdit))); }
                else if (undo) { modal.close(); undoPayment(current, current.payments.find(p => p.id === Number(undo.dataset.payUndo))); }
                else if (receipt) openReceipt(current, current.payments.find(p => p.id === Number(receipt.dataset.payReceipt)));
                else if (entry) openEntryDetail(Number(entry.dataset.entry));
            });
        },
    });
}

async function undoPayment(d, p) {
    if (!p) return;
    if (!await confirmDialog(`Undo the ${money(p.amount)} that ${p.memberName} paid on ${date(p.paidDate)} for month ${p.monthNo}?`, { confirmLabel: 'Undo payment' })) return;
    try {
        await afterChange(await api.del(`/hosted-chits/${d.chit.id}/payments/${p.id}`), 'Payment undone');
    } catch (err) {
        toast(err.message, 'error');
    }
}

async function openCollectAll(d, monthNo) {
    const month = monthOf(d, monthNo);
    const owing = d.members.map(m => ({ m, rest: dueFor(d, m, month) - paidFor(d, m.id, monthNo) })).filter(x => x.rest > 0);
    if (!owing.length) { toast(`Everyone has paid month ${monthNo}`, 'info'); return; }
    const accounts = d.chit.postToBooks ? await loadAccounts(false, { all: true }).catch(() => []) : [];
    const winner = month.winnerMemberId && !month.payoutDate ? d.members.find(m => m.id === month.winnerMemberId) : null;
    const total = owing.reduce((s, x) => s + x.rest, 0);
    openModal({
        title: `Everyone has paid month ${monthNo}`, iconName: 'check-circle',
        body: `<p style="margin-top:0">This records <b>${money(total)}</b> from the <b>${plural(owing.length, 'member')}</b> who have not paid yet:</p>
            <p class="muted hc-owing">${owing.map(x => esc(x.m.name)).join(', ')}</p>
            <form class="form-grid two">
                <label class="field"><span>Date</span><input type="date" name="paidDate" value="${isoDate()}"></label>
                <div class="field"><span>Paid by</span>${modeChips()}</div>
                ${winner ? `<div class="field span-2"><span>Paid to</span><div class="seg-chips" data-to>
                    <button type="button" class="seg-chip active" data-direct="0">${icon('arrow-in')}Me</button>
                    <button type="button" class="seg-chip" data-direct="1" title="${esc(winner.name)}'s own installment is set off against the payout">${icon('hand')}${esc(winner.name)} directly (the winner)</button></div></div>` : ''}
                ${d.chit.postToBooks ? `<label class="field span-2" data-into><span>Received into</span><select name="accountId">${moneyAccountOptions(accounts,
                    { chitId: d.chit.id, chitName: d.chit.name, selected: d.chit.accountId })}</select></label>` : ''}
            </form>
            <p class="muted hc-small">${icon('undo')}You can revert all of them in one go from This month.</p>`,
        actions: [
            { label: 'Cancel' },
            { label: `Mark ${owing.length} as paid`, kind: 'primary', iconName: 'check', onClick: async modal => {
                const into = modal.el.querySelector('[name=accountId]')?.value;
                const direct = modal.el.querySelector('[data-to] .active')?.dataset.direct === '1';
                await afterChange(await api.post(`/hosted-chits/${d.chit.id}/months/${monthNo}/collect-all`,
                    { paidDate: modal.el.querySelector('[name=paidDate]').value || null, mode: chosenMode(modal.el), accountId: into && !direct ? Number(into) : null, direct }),
                    `${plural(owing.length, 'payment')} recorded`);
            } },
        ],
        onOpen: modal => {
            bindModeChips(modal.el);
            modal.el.querySelector('[data-to]')?.addEventListener('click', e => {
                const b = e.target.closest('[data-direct]');
                if (!b) return;
                modal.el.querySelectorAll('[data-to] [data-direct]').forEach(x => x.classList.toggle('active', x === b));
                const intoField = modal.el.querySelector('[data-into]');
                if (intoField) intoField.hidden = b.dataset.direct === '1';
            });
        },
    });
}

/** Fixed chits: pick the winner, or draw one at random. */
function openWinner(d, month, autoDraw = false) {
    const eligible = d.members.filter(m => !m.wonMonth || m.wonMonth === month.monthNo);
    let random = false;
    openModal({
        title: `Winner of month ${month.monthNo}`, iconName: 'crown',
        body: `
        <div class="hc-draw" data-draw>${month.winnerName ? `${icon('crown')}<b>${esc(month.winnerName)}</b>` : `<span>Who gets <b>${money(month.payout)}</b> this month?</span>`}</div>
        <div class="form-grid one">
            <label class="field"><span>Choose a member (only those who have not won yet)</span>
                <select name="memberId"><option value="">Select…</option>${eligible.map(m =>
                    `<option value="${m.id}" ${m.id === month.winnerMemberId ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
            <button type="button" class="btn hc-dice" data-random>${icon('dice')}Or pick one at random</button>
        </div>`,
        actions: [
            { label: 'Cancel' },
            { label: 'Confirm winner', kind: 'primary', iconName: 'check', onClick: async modal => {
                const id = Number(modal.el.querySelector('[name=memberId]').value);
                if (!id) throw new Error('Choose the winner first');
                const name = eligible.find(m => m.id === id).name;
                await afterChange(await api.post(`/hosted-chits/${d.chit.id}/months/${month.monthNo}/winner`, { memberId: id, random }), `${name} wins month ${month.monthNo}`);
            } },
        ],
        onOpen: modal => {
            const select = modal.el.querySelector('[name=memberId]');
            const show = modal.el.querySelector('[data-draw]');
            const showName = (name, final) => {
                show.innerHTML = `${icon('crown')}<b>${esc(name)}</b>${final && random ? '<small>random draw</small>' : ''}`;
                show.classList.toggle('rolling', !final);
            };
            select.addEventListener('change', () => {
                random = false;
                const m = eligible.find(x => x.id === Number(select.value));
                if (m) showName(m.name, true);
            });
            const button = modal.el.querySelector('[data-random]');
            button.addEventListener('click', () => {
                if (!eligible.length) return;
                button.disabled = true;
                const pick = eligible[Math.floor(Math.random() * eligible.length)];
                let ticks = 0;
                const timer = setInterval(() => {
                    if (++ticks < 18) { showName(eligible[Math.floor(Math.random() * eligible.length)].name, false); return; }
                    clearInterval(timer);
                    random = true;
                    showName(pick.name, true);
                    select.value = String(pick.id);
                    button.disabled = false;
                }, 70);
            });
            if (autoDraw) button.click();
        },
    });
}

/** Auction chits: the highest bidder and their bid, with what it means for everyone. */
function openAuction(d, month) {
    const c = d.chit;
    const eligible = d.members.filter(m => !m.wonMonth || m.wonMonth === month.monthNo);
    const n = d.members.length;
    const value = num(month.chitValue), min = num(c.minBid), max = num(c.maxBid);
    const last = eligible.length <= 1;
    const startBid = month.bid !== null ? num(month.bid) : last ? min : Math.round((min + max) / 2 / 1000) * 1000;
    openModal({
        title: `Auction · month ${month.monthNo}`, iconName: 'gavel',
        body: `
        <p class="book-note">${icon('info')}<span>${last ? `Only <b>${esc(eligible[0]?.name || '')}</b> is left: they take the chit at the lowest bid (your commission).`
            : `Members who have not won bid the discount they will give up. The highest bid wins. Bids run from <b>${money(min)}</b> (your commission) to <b>${money(max)}</b> (${num(c.maxBidPercent)}%).`}</span></p>
        <form class="form-grid two">
            <label class="field"><span>Highest bidder</span>
                <select name="memberId">${last ? '' : '<option value="">Select…</option>'}${eligible.map(m =>
                    `<option value="${m.id}" ${m.id === month.winnerMemberId || last ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}</select></label>
            <label class="field"><span>Winning bid (₹)</span><input type="number" name="bid" step="1000" min="${min}" max="${max}" class="num" data-type="number" value="${startBid}" ${last ? 'disabled' : ''}>
                <small data-bid-pct></small></label>
            ${last ? '' : `<div class="span-2"><input type="range" name="bidRange" min="${min}" max="${max}" step="1000" value="${startBid}" class="hc-range"></div>`}
        </form>
        <div class="hc-pay-sum" data-auction-sum></div>`,
        actions: [
            { label: 'Cancel' },
            { label: 'Save auction result', kind: 'primary', iconName: 'check', onClick: async modal => {
                const id = Number(modal.el.querySelector('[name=memberId]').value);
                const bid = last ? min : Number(modal.el.querySelector('[name=bid]').value);
                if (!id) throw new Error('Choose the highest bidder');
                if (!(bid >= min && bid <= max)) throw new Error(`The bid must be between ${money(min)} and ${money(max)}`);
                const name = eligible.find(m => m.id === id).name;
                await afterChange(await api.post(`/hosted-chits/${c.id}/months/${month.monthNo}/winner`, { memberId: id, bid }),
                    `${name} won month ${month.monthNo} at ${money(bid)}`);
            } },
        ],
        onOpen: modal => {
            const bidInput = modal.el.querySelector('[name=bid]');
            const range = modal.el.querySelector('[name=bidRange]');
            const update = () => {
                const bid = last ? min : Math.max(0, Number(bidInput.value || 0));
                const dividend = Math.max(0, Math.floor((bid - min) / n));
                modal.el.querySelector('[data-bid-pct]').textContent = `${((bid / value) * 100).toFixed(1).replace(/\.0$/, '')}% of the chit value`;
                modal.el.querySelector('[data-auction-sum]').innerHTML = `
                    <span><small>Winner gets</small><b class="pos">${money(value - bid)}</b></span>
                    <span><small>Dividend a member</small><b>${money(dividend)}</b></span>
                    <span><small>Everyone pays</small><b>${money(num(c.installment) - dividend)}</b></span>`;
            };
            bidInput.addEventListener('input', () => { if (range) range.value = bidInput.value; update(); });
            range?.addEventListener('input', () => { bidInput.value = range.value; update(); });
            update();
        },
    });
}

/**
 * Pay the winner: the payout can come from several accounts (the members' money may have come into the chit's
 * account and into your own bank accounts), each part with its own mode and UTR, into the winner's account. What
 * members paid the winner directly is a fixed part. The parts are suggested from where the chit's money is, the
 * money that came in this month can be tapped to pay from it, and the journal entry it posts can be previewed.
 */
async function openPayout(d, month) {
    const c = d.chit;
    const owing = d.members.map(m => ({ m, rest: dueFor(d, m, month) - paidFor(d, m.id, month.monthNo) })).filter(x => x.rest > 0);
    const dues = owing.reduce((s, x) => s + x.rest, 0);
    const winner = d.members.find(m => m.id === month.winnerMemberId);
    const books = c.postToBooks;
    const accounts = books ? await loadAccounts(false, { all: true }).catch(() => []) : [];
    const payout = num(month.payout);
    const nameOf = id => accounts.find(a => a.id === Number(id))?.name || '?';
    // what members paid the winner directly is already with the winner: it is a fixed part of the payout
    const directList = d.payments.filter(p => p.monthNo === month.monthNo && p.paidToMemberId === month.winnerMemberId);
    const direct = directList.reduce((s, p) => s + num(p.amount), 0);
    const toPay = Math.max(0, payout - direct);
    const spots = (d.money?.spots || []).filter(s => num(s.amount) > 0 && s.role !== 'DIRECT');
    const chitMoney = Object.fromEntries((d.money?.spots || []).map(s => [s.accountId, num(s.amount)]));
    // this month's payments (to me), by the account their money is in now: where it came in, or where a transfer moved it
    const movedOn = id => (d.transfers || []).find(t => t.from.some(l => (l.paymentIds || []).includes(id)));
    const received = new Map();
    d.payments.filter(p => p.monthNo === month.monthNo && num(p.amount) && !p.paidToMemberId && !p.paidOutMonth).forEach(p => {
        const k = movedOn(p.id)?.toAccountId ?? (p.accountId || c.accountId);
        received.set(k, (received.get(k) || 0) + num(p.amount));
    });
    // planned chits: a month that pays out more than it collects takes the difference out of the commission account
    const shortfall = isPlanned(c) && num(month.commission) < 0 && c.commissionAccountId ? Math.min(toPay, -num(month.commission)) : 0;
    // the members' payments not yet paid out, and where their money is now: moved by a transfer, else where it came in
    const movedBy = id => (d.transfers || []).find(t => t.from.some(l => (l.paymentIds || []).includes(id)));
    const whereNow = p => movedBy(p.id)?.toAccountId ?? (p.accountId || c.accountId);
    const open = d.payments.filter(p => !p.paidToMemberId && !p.paidOutMonth && num(p.amount) > 0)
        .sort((a, b) => a.paidDate.localeCompare(b.paidDate) || a.id - b.id);
    /** Up to `amount` of the payments now in an account (oldest first): their ids and the narrative for the line. */
    const carried = (accountId, amount) => {
        // what the account still holds of the chit: payments moved before transfers named them drop out (latest kept)
        let room = num(chitMoney[accountId]);
        const here = open.filter(p => whereNow(p) === accountId).reverse().filter(p => (room -= num(p.amount)) >= -0.005).reverse();
        const ids = [];
        let sum = 0;
        for (const p of here) {
            if (sum >= amount - 0.005) break;
            ids.push(p.id);
            sum += num(p.amount);
        }
        const list = here.filter(p => ids.includes(p.id));
        // short, every detail kept: "4×₹25,000: Jyothi #942, Mahesh #943 | [Own a/c ICICI Bank → TR-000008] Suresh #946/UTR77 ₹1,000"
        const note = paymentsNarrative(list, { members: d.members, chitName: c.name, accounts, lineAccountId: accountId, movedBy, fallbackAccountId: c.accountId });
        return { paymentIds: ids, note };
    };
    /**
     * Pay from where the chit's money is. First your own bank accounts (members paid into them; consolidated money
     * follows its transfer), then common chit accounts, then the chit's collections; the commission account only for a
     * month that pays out more than it collects. Each part names, and is linked to, the payments it pays out.
     */
    const suggest = () => {
        let left = toPay - shortfall;
        const legs = shortfall ? [{ accountId: c.commissionAccountId, amount: shortfall, mode: 'Bank', reference: '',
            paymentIds: [], note: `From my commission: ${payCode(c, month.monthNo)} pays out more than it collects` }] : [];
        const rank = x => !x.chitBook ? 0 : !x.own ? 1 : x.accountId === c.accountId ? 2 : 9;
        const ordered = spots.filter(x => rank(x) < 9).sort((a, b) => rank(a) - rank(b) || num(b.amount) - num(a.amount));
        for (const x of ordered) {
            if (left <= 0.005) break;
            const take = Math.min(left, num(x.amount));
            legs.push({ accountId: x.accountId, amount: take, mode: 'Bank', reference: '', ...carried(x.accountId, take) });
            left -= take;
        }
        if (left > 0.005) {
            const own = legs.find(l => l.accountId === c.accountId);
            if (own) own.amount += left;
            else legs.push({ accountId: c.accountId, amount: left, mode: 'Bank', reference: '', ...carried(c.accountId, left) });
        }
        return legs;
    };
    const s = { legs: books && toPay > 0 ? suggest() : [] };
    let evidence = null;
    openModal({
        title: `Pay the winner of month ${month.monthNo}`, iconName: 'crown', size: books ? 'xl hc-payout-modal' : 'lg',
        body: `<div class="hc-payout ${books ? 'two' : ''}"><div class="hc-pay-left">
        <div class="hc-payout-head">
            <span class="hc-avatar gold">${icon(isAuction(c) ? 'gavel' : 'crown')}</span>
            <div class="min-0 grow"><b>${esc(month.winnerName)}</b><small>${isPlanned(c)
                ? (num(month.commission) < 0 ? `collected ${money(month.chitValue)} + ${money(-num(month.commission))} from my commission` : `collected ${money(month.chitValue)} − commission ${money(month.commission)}`)
                : `chit value ${money(month.chitValue)} − ${isAuction(c) ? `bid ${money(month.bid)}` : `commission ${money(month.commission)}`}`}</small></div>
            <div class="hc-payout-amt"><small>Winner gets</small><b>${money(payout)}</b></div>
        </div>
        ${dues ? `<p class="hc-note warn">${icon('alert')}<span>${plural(owing.length, 'member')} still ${owing.length === 1 ? 'owes' : 'owe'} <b>${money(dues)}</b> for this month (${esc(owing.slice(0, 4).map(x => x.m.name).join(', '))}${owing.length > 4 ? ` and ${owing.length - 4} more` : ''}). You can collect it later.</span></p>` : ''}
        <form class="form-grid two" onsubmit="return false">
            <label class="field"><span>Paid on</span><input type="date" name="payoutDate" value="${isoDate()}" max="${isoDate()}"></label>
            <label class="field"><span>Into the winner's account</span><input type="text" name="payoutTo" maxlength="120"
                value="${esc(winner?.payoutAccount || '')}" placeholder="Bank, A/c no. & IFSC, or UPI ID" data-plain></label>
            ${books ? '' : `<div class="field"><span>Paid by</span>${modeChips('Bank')}</div>
                <label class="field"><span>Transaction reference</span><input type="text" name="reference" maxlength="60" placeholder="UPI ref, cheque or transfer no." data-plain></label>`}
        </form>
        ${books ? `
        <div class="section-title">${icon('split')}Paid from</div>
        ${direct ? `<div class="hc-src locked">
            <span class="chip-icon sm teal">${icon('hand')}</span>
            <div class="min-0 grow"><b>Already paid to ${esc(month.winnerName)} directly</b>
                <small class="ellipsis" title="${esc(directList.map(p => `${p.memberName}: ${money(p.amount)}`).join('\n'))}">${esc(directList.map(p => p.memberId === month.winnerMemberId ? `${p.memberName} (own, set off)` : p.memberName).join(', '))}</small></div>
            <b class="hc-src-amt">${money(direct)}</b></div>` : ''}
        ${received.size ? `<div class="ca-received"><small>${icon('arrow-in')}This month's payments are now in — tap to pay from it:</small>${[...received].map(([id, v]) =>
            `<button type="button" class="ca-mchip in clickable" data-add-from="${id}" data-amount="${v}"><span class="ellipsis">${esc(nameOf(id))}</span><b>${money(v)}</b></button>`).join('')}</div>` : ''}
        <div class="hc-srcs" data-legs></div>
        <div class="hc-srcs-foot">
            <button type="button" class="btn sm ghost" data-add-leg>${icon('plus')}Another account</button>
            <button type="button" class="btn sm ghost" data-suggest title="Split it over the accounts that hold this chit's money">${icon('sparkles')}Suggest</button>
            <span class="grow"></span>
            <span class="hc-alloc" data-alloc></span>
        </div>
        <i class="hc-alloc-bar"><em data-alloc-bar></em></i>
        ${shortfall ? `<p class="hc-note">${icon('piggy')}<span>This month pays the winner <b>${money(-num(month.commission))}</b> more than is collected: it is paid from your commission account and booked as commission given back.</span></p>` : ''}
        ${c.commissionAccountId && num(month.commission) > 0 ? `<label class="field hc-comm-from"><span>Move my commission (${money(month.commission)}) to ${esc(c.commissionAccountName || 'its account')} from</span>
            <select name="commissionFrom">${moneyAccountOptions(accounts, { chitId: c.id, chitName: c.name, selected: c.accountId, amounts: chitMoney })}</select></label>` : ''}
        ${evidenceFieldHtml({ label: 'Evidence', hint: 'Bank credit, cheque copy or a signed voucher' })}` : ''}
        <div class="hc-ag-box">
            <label class="check-line"><input type="checkbox" name="createAgreement" checked> Make a digital agreement for ${esc(month.winnerName)} to accept</label>
            <small class="muted">It records the full amount received${direct ? ' (including what members paid directly)' : ''} and that the remaining installments will be paid.</small>
            <div class="form-grid two" data-guarantor>
                <label class="field"><span>Guarantor <small class="muted">optional</small></span><input type="text" name="guarantorName" maxlength="100" data-plain></label>
                <label class="field"><span>Guarantor's phone</span><input type="tel" name="guarantorPhone" maxlength="14" inputmode="numeric" data-plain></label>
            </div>
        </div>
        <p class="muted hc-small">${icon('lock')}This closes month ${month.monthNo}. You can undo it from Months while the agreement is not accepted.</p>
        </div>
        ${books ? `<aside class="hc-pay-right">
            <div class="hc-pr-card">
                <div class="hc-pr-title">${icon('calendar')}Month ${month.monthNo} · ${monthName(month.dueDate)}</div>
                <div class="hc-pr-figs"><span><small>Collected</small><b>${money(month.collected)}</b></span><span><small>Expected</small><b>${money(month.expected)}</b></span>
                    <span><small>${num(month.commission) < 0 ? 'From my commission' : 'My commission'}</small><b class="${num(month.commission) < 0 ? 'neg' : 'gold-ink'}">${money(Math.abs(num(month.commission)))}</b></span></div>
                <i class="hc-alloc-bar"><em style="width:${num(month.expected) ? Math.min(100, (num(month.collected) / num(month.expected)) * 100) : 0}%"></em></i>
                <small class="muted">${month.paidCount} of ${d.members.length} members paid in full${direct ? ` · ${money(direct)} went to ${esc(month.winnerName)} directly` : ''}</small>
            </div>
            <div class="hc-pr-card"><div class="hc-pr-title">${icon('split')}How ${money(payout)} is paid</div><div class="hc-split" data-split></div><div class="hc-split-legend" data-split-legend></div></div>
            <div class="hc-pr-card"><div class="hc-pr-title">${icon('wallet')}${esc(c.name)}'s money by account <small>now → after</small></div><div class="hc-after" data-after></div></div>
            <div class="hc-pr-card"><div class="hc-pr-title">${icon('journal')}Journal entries it posts</div><div data-preview></div></div>
        </aside>` : ''}
        </div>`,
        actions: [
            { label: 'Cancel' },
            { label: 'Yes, winner is paid', kind: 'primary', iconName: 'check', onClick: async modal => {
                const el = modal.el;
                const legs = s.legs.filter(l => l.accountId || num(l.amount));
                const paidOn = el.querySelector('[name=payoutDate]').value;
                if (!paidOn) throw new Error('Enter the date the winner was paid');
                if (paidOn > isoDate()) throw new Error('The payout date cannot be in the future');
                if (paidOn < c.startMonth) throw new Error(`The payout date is before the chit starts (${date(c.startMonth)})`);
                if (el.querySelector('[name=payoutTo]').value.trim().length > 120) throw new Error('The winner’s account can be at most 120 characters');
                if (books) {
                    if (legs.some(l => !l.accountId)) throw new Error('Pick the account on every line');
                    if (legs.some(l => num(l.amount) <= 0)) throw new Error('Enter the amount on every line');
                    const total = legs.reduce((t, l) => t + num(l.amount), 0);
                    if (Math.abs(total - toPay) > 0.004) throw new Error(`The accounts add up to ${money(total)}; ${money(toPay)} is left to pay${direct ? ` after the ${money(direct)} paid directly` : ''}`);
                }
                let allowDues = false;
                if (dues) {
                    allowDues = await confirmDialog(`${money(dues)} is still owed for month ${month.monthNo}. Close the month anyway? You can collect it later.`,
                        { title: 'Some members have not paid', confirmLabel: 'Close the month' });
                    if (!allowDues) return true;
                }
                const v = name => el.querySelector(`[name=${name}]`);
                const agreement = v('createAgreement').checked;
                let fresh = await api.post(`/hosted-chits/${c.id}/months/${month.monthNo}/payout`, {
                    payoutDate: v('payoutDate').value || null, mode: books ? (legs[0]?.mode || 'Bank') : chosenMode(el),
                    reference: books ? null : v('reference').value.trim() || null, allowDues,
                    createAgreement: agreement, guarantorName: v('guarantorName').value.trim() || null, guarantorPhone: v('guarantorPhone').value.trim() || null,
                    legs: books ? legs.map(l => ({ accountId: Number(l.accountId), amount: num(l.amount), mode: l.mode, reference: (l.reference || '').trim() || null,
                        paymentIds: l.paymentIds || [], note: (l.note || '').trim() || null })) : null,
                    payoutTo: v('payoutTo').value.trim() || null,
                    commissionFromAccountId: v('commissionFrom')?.value ? Number(v('commissionFrom').value) : null,
                });
                const entryId = monthOf(fresh, month.monthNo)?.payoutEntryId;
                if (evidence?.count && entryId) {
                    await evidence.uploadTo(entryId);
                    fresh = await api.get(`/hosted-chits/${c.id}`);
                }
                await afterChange(fresh, `Month ${month.monthNo} done: ${month.winnerName} paid${legs.length + (direct ? 1 : 0) > 1 ? ` in ${legs.length + (direct ? 1 : 0)} parts` : ''}`);
                if (agreement) openAgreement(fresh, month.monthNo);
            } },
        ],
        onOpen: modal => {
            const el = modal.el;
            if (!books) bindModeChips(el);
            evidence = books ? bindEvidenceField(el) : null;
            const box = el.querySelector('[name=createAgreement]');
            box.addEventListener('change', () => { el.querySelector('[data-guarantor]').hidden = !box.checked; });
            if (!books) return;
            const legsEl = el.querySelector('[data-legs]');
            const left = () => toPay - s.legs.reduce((t, l) => t + num(l.amount), 0);
            const drawLegs = () => {
                legsEl.innerHTML = s.legs.length ? s.legs.map((l, i) => `<div class="hc-src" data-i="${i}">
                    <div class="hc-src-top"><select data-leg-account>${moneyAccountOptions(accounts, { chitId: c.id, chitName: c.name, selected: l.accountId, amounts: chitMoney })}</select>
                        <button type="button" class="btn sm ghost icon" data-remove title="Remove this part">${icon('x')}</button></div>
                    <div class="hc-src-bottom">
                        <label class="hc-src-field amt"><small>Amount</small><input type="number" class="num" step="any" min="0" value="${l.amount}" data-leg-amount data-type="number" inputmode="decimal"></label>
                        <label class="hc-src-field"><small>Mode</small><select data-leg-mode data-plain>${['Bank', 'UPI', 'Cash'].map(x => `<option ${l.mode === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
                        <label class="hc-src-field grow"><small>UTR / reference</small><input type="text" maxlength="60" value="${esc(l.reference || '')}" data-leg-ref data-plain></label>
                    </div>
                    <div class="hc-src-note">${(l.paymentIds || []).length ? `<span class="hc-lg-chip direct" title="Linked to these payments">${icon('link')}${l.paymentIds.length}</span>` : ''}
                        <textarea rows="1" maxlength="2000" placeholder="Narrative: whose payments these are (on the journal line)" data-leg-note data-plain>${esc(l.note || '')}</textarea>
                    </div>${l.note && /\[Own a\/c /.test(l.note) ? `<div class="hc-src-nv">${narrativeHtml(l.note)}</div>` : ''}</div>`).join('')
                    : `<p class="muted hc-small">${direct >= payout ? 'Members paid the whole amount to the winner directly: nothing more to pay.' : 'Add the account you paid from.'}</p>`;
            };
            const PALETTE = ['#0b7cbd', '#13a89a', '#c99a3b', '#5b4fc9', '#d9603c', '#13808f', '#7b8fa3'];
            const commission = num(month.commission);
            const separate = c.commissionAccountId && c.commissionAccountId !== c.accountId;
            /** The right-hand side, live: the split, each account now and after, and every journal entry it posts. */
            const preview = () => {
                const legs = s.legs.filter(l => l.accountId && num(l.amount) > 0);
                const total = legs.reduce((t, l) => t + num(l.amount), 0) + direct;
                const rest = payout - total;
                const ok = Math.abs(rest) < 0.005;
                const alloc = el.querySelector('[data-alloc]');
                alloc.innerHTML = ok ? `${icon('check')}${money(payout)} covered` : rest > 0 ? `<b>${money(rest)}</b> left to allocate` : `<b>${money(-rest)}</b> too much`;
                alloc.className = `hc-alloc ${ok ? 'pos' : 'neg'}`;
                const bar = el.querySelector('[data-alloc-bar]');
                bar.style.width = `${Math.min(100, payout ? (total / payout) * 100 : 0)}%`;
                bar.parentElement.classList.toggle('over', rest < -0.004);
                // how the payout is split, as a bar and a legend
                const parts = [...(direct ? [{ name: 'Paid directly by members', amount: direct }] : []),
                    ...legs.map(l => ({ name: nameOf(l.accountId), amount: num(l.amount), mode: l.mode }))];
                const scale = Math.max(payout, total) || 1;
                el.querySelector('[data-split]').innerHTML = parts.map((x, i) => `<span style="width:${(x.amount / scale) * 100}%;background:${PALETTE[i % PALETTE.length]}" title="${esc(x.name)}: ${money(x.amount)}"></span>`).join('')
                    + (rest > 0.004 ? `<span class="gap" style="width:${(rest / scale) * 100}%" title="Not allocated yet"></span>` : '');
                el.querySelector('[data-split-legend]').innerHTML = parts.map((x, i) => `<span><i style="background:${PALETTE[i % PALETTE.length]}"></i><span class="hc-split-name">${esc(x.name)}</span>
                    ${x.mode ? `<small>${esc(x.mode)}</small>` : ''}<b>${money(x.amount)}</b></span>`).join('') || '<small class="muted">Add the accounts it is paid from.</small>';
                // the chit's money in each account now, and after the payout (and the commission's move)
                const change = new Map();
                const add = (id, v) => change.set(Number(id), (change.get(Number(id)) || 0) + v);
                legs.forEach(l => add(l.accountId, -num(l.amount)));
                const directSpot = (d.money?.spots || []).find(x => x.role === 'DIRECT');
                if (direct && directSpot) add(directSpot.accountId, -direct);
                const commissionFrom = Number(el.querySelector('[name=commissionFrom]')?.value || c.accountId);
                if (commission > 0 && separate) { add(commissionFrom, -commission); add(c.commissionAccountId, commission); }
                const ids = [...new Set([...(d.money?.spots || []).map(x => x.accountId), ...change.keys()])];
                el.querySelector('[data-after]').innerHTML = ids.map(id => {
                    const now = num(chitMoney[id]);
                    const after = now + (change.get(id) || 0);
                    if (!now && Math.abs(after) < 0.005) return '';
                    return `<div class="hc-after-row ${change.get(id) ? 'moved' : ''}"><span class="hc-split-name">${esc(nameOf(id))}</span>
                        <span>${money(now)}</span>${icon('chevron-right')}<b class="${after < -0.004 ? 'neg' : ''}">${after < 0 ? '−' : ''}${money(Math.abs(after))}</b></div>`;
                }).join('') || '<small class="muted">No money recorded for this chit yet.</small>';
                // the journal entries
                const tag = `<span class="ca-tag">${esc(c.name)}</span>`;
                const je = (title, rows) => `<table class="ca-je"><thead><tr><th>${title}</th><th class="num">Dr</th><th class="num">Cr</th></tr></thead><tbody>${rows}</tbody></table>`;
                const dr = (name, v, note = '') => `<tr><td>${name}${note}</td><td class="num">${money(v)}</td><td></td></tr>`;
                const cr = (name, v, note = '') => `<tr><td class="ca-cr">${name}${note}</td><td></td><td class="num">${money(v)}</td></tr>`;
                el.querySelector('[data-preview]').innerHTML = je(`Chit payout ${esc(payCode(c, month.monthNo))} · ${esc(month.winnerName)}`, dr(`Hosted Chit Funds ${tag}`, payout)
                        + (direct ? cr('Paid directly to winners', direct, ` <small class="muted">${plural(directList.length, 'member')}</small>`) : '')
                        + legs.map(l => cr(esc(nameOf(l.accountId)) + (accounts.find(a => a.id === Number(l.accountId))?.chitBook === false ? ' <span class="nv-seg own">own a/c</span>' : ''),
                            num(l.amount), ` <small class="muted">${esc(l.mode)}${l.reference ? ' · ' + esc(l.reference) : ''}</small>`
                            + (l.note ? `<small class="ca-je-note">${narrativeHtml(l.note)}</small>` : ''))).join('')
                        + `<tr class="ca-je-total"><td>Total</td><td class="num">${money(payout)}</td><td class="num ${ok ? '' : 'neg'}">${money(total)}</td></tr>`)
                    + (commission > 0 ? je('Commission (income)', dr(`Hosted Chit Funds ${tag}`, commission) + cr('Income · commission', commission))
                        + (separate ? je('Commission to its account (transfer)', dr(esc(nameOf(c.commissionAccountId)), commission) + cr(esc(nameOf(commissionFrom)), commission)) : '')
                    : commission < 0 ? je('Commission given back', dr('Income · commission', -commission) + cr(`Hosted Chit Funds ${tag}`, -commission)) : '');
            };
            el.querySelector('[name=commissionFrom]')?.addEventListener('change', () => preview());
            const redraw = () => { drawLegs(); preview(); };
            redraw();
            el.querySelector('[data-add-leg]').addEventListener('click', () => {
                s.legs.push({ accountId: null, amount: Math.max(0, left()) || '', mode: 'Bank', reference: '' });
                redraw();
            });
            el.querySelector('[data-suggest]').addEventListener('click', () => { s.legs = toPay > 0 ? suggest() : []; redraw(); });
            el.querySelector('.ca-received')?.addEventListener('click', e => {
                const chip = e.target.closest('[data-add-from]');
                if (!chip) return;
                const id = Number(chip.dataset.addFrom);
                const existing = s.legs.find(l => l.accountId === id);
                // replace the suggestion when it does not match what is being built
                const amount = Math.min(num(chip.dataset.amount), Math.max(0, left() + (existing ? num(existing.amount) : 0)));
                if (existing) Object.assign(existing, { amount: amount || num(chip.dataset.amount) }, carried(id, amount || num(chip.dataset.amount)));
                else s.legs.push({ accountId: id, amount: amount || num(chip.dataset.amount), mode: 'Bank', reference: '', ...carried(id, amount || num(chip.dataset.amount)) });
                redraw();
            });
            legsEl.addEventListener('change', e => {
                const row = e.target.closest('[data-i]');
                if (!row) return;
                const leg = s.legs[Number(row.dataset.i)];
                if (e.target.matches('[data-leg-account]')) {
                    leg.accountId = e.target.value ? Number(e.target.value) : null;
                    Object.assign(leg, leg.accountId ? carried(leg.accountId, num(leg.amount) || num(chitMoney[leg.accountId])) : { paymentIds: [], note: '' });
                    drawLegs();
                }
                if (e.target.matches('[data-leg-mode]')) leg.mode = e.target.value;
                preview();
            });
            legsEl.addEventListener('input', e => {
                const row = e.target.closest('[data-i]');
                if (!row) return;
                const leg = s.legs[Number(row.dataset.i)];
                if (e.target.matches('[data-leg-amount]')) leg.amount = e.target.value;
                if (e.target.matches('[data-leg-ref]')) leg.reference = e.target.value;
                if (e.target.matches('[data-leg-note]')) leg.note = e.target.value;
                preview();
            });
            legsEl.addEventListener('click', e => {
                const rm = e.target.closest('[data-remove]');
                if (!rm) return;
                s.legs.splice(Number(rm.closest('[data-i]').dataset.i), 1);
                redraw();
            });
        },
    });
}

/** A bank or wallet account members can pay into: it has a UPI ID, or an account number and IFSC. */
const payReady = a => !!(a && (a.upiId || (a.accountNumber && a.ifsc)));

/** The accounts members can be asked to pay into (this chit's and common chit accounts, then mine), each with what it carries. */
function payToOptions(accounts, c, selected, emptyLabel) {
    const ok = a => a.active && ['BANK', 'WALLET'].includes(a.accountType) && (!a.chitBook || !a.hostedChitId || a.hostedChitId === c.id);
    const what = a => a.upiId ? `UPI ${a.upiId}` : a.accountNumber && a.ifsc ? `A/c ••${String(a.accountNumber).replace(/\s/g, '').slice(-4)} · ${a.ifsc}` : 'no bank details yet';
    const opt = a => `<option value="${a.id}" ${a.id === Number(selected) ? 'selected' : ''}>${esc(a.name)} · ${esc(what(a))}</option>`;
    const group = (label, list) => list.length ? `<optgroup label="${esc(label)}">${list.map(opt).join('')}</optgroup>` : '';
    return `<option value="">${esc(emptyLabel)}</option>${group('Chit accounts', accounts.filter(a => ok(a) && a.chitBook))}${group('My accounts', accounts.filter(a => ok(a) && !a.chitBook))}`;
}

/**
 * Asks for the bank details of an account picked for members to pay into (UPI ID, or account number and IFSC).
 * Resolves with the saved account, or null when cancelled.
 */
function askBankDetails(a) {
    return new Promise(resolve => {
        let saved = null;
        const bank = a.accountType === 'BANK';
        const modal = openModal({
            title: `Bank details · ${a.name}`, iconName: 'bank',
            body: `<p class="hc-note warn">${icon('alert')}<span><b>${esc(a.name)}</b> has no UPI ID${bank ? ' or bank details' : ''}. Members' payment links show these, so add them to use it.
                    A UPI ID gives members a “Pay now” button; ${bank ? 'with only the account number and IFSC they get the bank details to transfer to.' : 'a wallet needs one.'}</span></p>
                <form class="form-grid two" onsubmit="return false">
                    <label class="field span-2"><span>Account holder name</span><input type="text" name="holderName" value="${esc(a.holderName || '')}" maxlength="100" placeholder="As on the passbook" data-plain></label>
                    <label class="field span-2"><span>UPI ID</span><input type="text" name="upiId" value="${esc(a.upiId || '')}" maxlength="60" placeholder="name@okicici" data-plain></label>
                    ${bank ? `<label class="field"><span>Bank</span><input type="text" name="institution" value="${esc(a.institution || '')}" maxlength="100" placeholder="e.g. ICICI Bank" data-plain></label>
                    <label class="field"><span>Account number</span><input type="text" name="accountNumber" value="${esc(a.accountNumber || '')}" maxlength="40" inputmode="numeric" data-plain></label>
                    <label class="field"><span>IFSC</span><input type="text" name="ifsc" value="${esc(a.ifsc || '')}" maxlength="11" placeholder="ICIC0001234" style="text-transform:uppercase" data-plain></label>` : ''}
                </form>`,
            actions: [
                { label: 'Cancel' },
                { label: 'Save details', kind: 'primary', iconName: 'check', onClick: async m => {
                    const v = n => m.el.querySelector(`[name=${n}]`)?.value.trim() || '';
                    const upi = v('upiId'), ifsc = v('ifsc').toUpperCase(), number = v('accountNumber');
                    if (upi && !/^[\w.\-]{2,}@[A-Za-z][\w.]{1,}$/.test(upi)) throw new Error('The UPI ID looks like name@bank');
                    if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new Error('The IFSC is 4 letters, a zero, then 6 letters or digits');
                    if (number && !/^[A-Za-z0-9 \-]{4,40}$/.test(number)) throw new Error('The account number can have letters, digits, spaces and dashes');
                    if (!upi && !(number && ifsc)) throw new Error(bank ? 'Enter a UPI ID, or the account number and IFSC' : 'Enter the UPI ID');
                    saved = await api.put(`/accounts/${a.id}/bank-details`, { institution: bank ? v('institution') || null : a.institution,
                        accountNumber: bank ? number || null : a.accountNumber, holderName: v('holderName') || null, ifsc: ifsc || null, upiId: upi || null, version: a.version });
                    await loadAccounts(true, { all: true });
                    toast(`Bank details saved on ${saved.name}`);
                } },
            ],
        });
        // resolve once the dialog is gone (saved or cancelled)
        const gone = new MutationObserver(() => { if (!modal.el.isConnected) { gone.disconnect(); resolve(saved); } });
        gone.observe(document.body, { childList: true, subtree: true });
    });
}

/** Wires a pay-to select: picking an account without bank details asks for them, and goes back if they are not given. */
function bindPayTo(select, accounts) {
    if (!select) return;
    let before = select.value;
    select.addEventListener('change', async () => {
        const a = accounts.find(x => x.id === Number(select.value));
        if (a && !payReady(a)) {
            const saved = await askBankDetails(a);
            if (!saved || !payReady(saved)) { select.value = before; select.dispatchEvent(new Event('change')); return; }
            Object.assign(a, saved);
            const opt = select.querySelector(`option[value="${a.id}"]`);
            if (opt) opt.textContent = `${a.name} · ${a.upiId ? `UPI ${a.upiId}` : `A/c ••${String(a.accountNumber).replace(/\s/g, '').slice(-4)} · ${a.ifsc}`}`;
        }
        before = select.value;
    });
}

/**
 * Who a member pays: the chit's account (default), one of the organiser's accounts, or a fellow member who is a month's
 * winner not yet paid out (they pay them directly; it comes off the payout). Account values are ids, members "m:<id>".
 */
function memberPayToOptions(accounts, d, m, selectedAccount, selectedMember, emptyLabel) {
    const winners = d ? d.schedule.filter(x => x.winnerMemberId && !x.payoutDate && x.winnerMemberId !== m?.id)
        .map(x => ({ x, w: d.members.find(y => y.id === x.winnerMemberId) })).filter(o => o.w) : [];
    const memberGroup = winners.length ? `<optgroup label="A fellow member: a winner to pay directly">${winners.map(({ x, w }) =>
        `<option value="m:${w.id}" ${w.id === selectedMember ? 'selected' : ''} ${w.upiId || w.phone ? '' : 'disabled'}>${esc(w.name)} · month ${x.monthNo} winner · ${esc(w.upiId ? `UPI ${w.upiId}` : w.phone ? `mobile ${w.phone}` : 'no UPI ID or mobile')}</option>`).join('')}</optgroup>` : '';
    return payToOptions(accounts, d?.chit || { id: null }, selectedMember ? null : selectedAccount, emptyLabel) + memberGroup;
}

/** The pays-into choice as the request's two fields. */
function payToValue(v) {
    return v && v.startsWith('m:') ? { payToAccountId: null, payToMemberId: Number(v.slice(2)) }
        : { payToAccountId: v ? Number(v) : null, payToMemberId: null };
}

async function openMember(d, m) {
    const accounts = await loadAccounts(false, { all: true }).catch(() => []);
    const first = m.name.split(' ')[0];
    openModal({
        title: 'Edit member', sub: `${d.chit.name} · member ${m.slot}`, iconName: 'user',
        body: `<form class="form-grid two">
            <label class="field span-2"><span>Name</span><input type="text" name="name" value="${esc(m.name)}" maxlength="100" required></label>
            <label class="field"><span>Mobile</span><input type="tel" name="phone" value="${esc(m.phone || '')}" inputmode="numeric" maxlength="14" placeholder="10 digits, for WhatsApp reminders"></label>
            <label class="field"><span>E-mail</span><input type="email" name="email" value="${esc(m.email || '')}" maxlength="120" placeholder="for e-mailed reminders and receipts" data-plain></label>
            <label class="field"><span>${esc(first)}’s UPI ID</span><input type="text" name="upiId" value="${esc(m.upiId || '')}" maxlength="60" placeholder="name@okaxis" data-plain>
                <small>Fellow members pay ${esc(first)} on it in the month ${esc(first)} wins</small></label>
            <label class="field"><span>Payout to</span><input type="text" name="payoutAccount" value="${esc(m.payoutAccount || '')}" maxlength="120" placeholder="Bank, account no. and IFSC, or UPI ID" data-plain>
                <small>Filled in when you pay ${esc(first)} the chit</small></label>
            <label class="field span-2"><span>Pays into</span><select name="payTo" data-plain>${memberPayToOptions(accounts, d, m, m.payToAccountId, m.payToMemberId,
                d.chit.payToAccountName ? `The chit's account (${d.chit.payToAccountName})` : 'The chit’s account / UPI ID')}</select>
                <small>What ${esc(first)}’s signed payment link shows: an account’s UPI ID or bank details, or a winner to pay directly (until that month is paid out)</small></label>
        </form>`,
        onOpen: modal => bindPayTo(modal.el.querySelector('[name=payTo]'), accounts),
        actions: [
            { label: 'Cancel' },
            { label: 'Save', kind: 'primary', iconName: 'check', onClick: async modal => {
                const v = n => modal.el.querySelector(`[name=${n}]`).value.trim();
                const name = v('name');
                const phone = v('phone').replace(/[\s-]/g, '');
                const email = v('email');
                const upiId = v('upiId');
                if (!name) throw new Error('Enter the name');
                if (phone && !/^\d{10}$/.test(phone)) throw new Error('The mobile number should have 10 digits');
                if (email && !EMAIL.test(email)) throw new Error('The e-mail address does not look right');
                if (upiId && !UPI.test(upiId)) throw new Error('The UPI ID should look like name@bank');
                if (d.members.some(x => x.id !== m.id && x.name.trim().toLowerCase() === name.toLowerCase())) throw new Error(`Another member is already called ${name}`);
                await afterChange(await api.put(`/hosted-chits/${d.chit.id}/members/${m.id}`, { name, phone: phone || null, email: email || null,
                    payoutAccount: v('payoutAccount') || null, upiId: upiId || null, ...payToValue(v('payTo')) }), 'Saved');
            } },
        ],
    });
}

/** The chit's settings open on the same page as hosting one: its three steps, filled in. */
function openSettings(d) {
    openWizard(null, { edit: d });
}

// ---------------------------------------------------------------- sending reminders and receipts

/** Whether e-mail is set up (the household's account in Settings, or the installation's), asked each time. */
const mailReady = () => api.get('/hosted-chits/mail-status').catch(() => ({ configured: false }));
const phoneOf = m => (m?.phone ? m.phone.replace(/\D/g, '').slice(-10) : '');
const waLink = (m, text) => `https://wa.me/${phoneOf(m) ? '91' + phoneOf(m) : ''}?text=${encodeURIComponent(text)}`;
const shareUrl = token => `${location.origin}/chit-share.html#${token}`;

const REMINDER_TEXT = {
    OWING: 'Hi {name}, a reminder for {chit}: {amount} is due ({months}). Please pay by {date}, with the note {note}.{link} Thank you! – {me}',
    UPCOMING: 'Hi {name}, {chit}: your installment for {months} is {amount}, due on {date}. Please use the note {note} when you pay.{link} Thank you! – {me}',
};

/** A short code from a chit's name (as the server makes it): first letters, number-and-letter words whole, up to 4. */
function deriveShortCode(name) {
    let s = '';
    for (const word of String(name || '').split(/[^A-Za-z0-9]+/)) {
        if (!word) continue;
        s += /\d/.test(word) ? word.toUpperCase() : word[0].toUpperCase();
        if (s.length >= 4) break;
    }
    return s.slice(0, 4) || 'CHIT';
}

/** "AC5L-M03": the chit's short code and the installment, 8 characters, so it reads whole on a bank statement. */
export function payCode(c, monthNo) {
    const m = monthNo < 100 ? `M${String(monthNo).padStart(2, '0')}` : `M${monthNo}`;
    return `${String(c.shortCode || 'CHIT').slice(0, 7 - m.length)}-${m}`;
}
const RECEIPT_TEXT = 'Hi {name}, thank you! We received {amount} for {chit}, month {month}, on {date}. Your signed receipt {receipt}: {link} – {me}';

/** The signed receipt PDF of a payment, saved by the browser. */
async function downloadReceiptPdf(d, p) {
    const blob = await api.blob(`/hosted-chits/${d.chit.id}/payments/${p.id}/receipt.pdf`);
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `Receipt ${p.receiptNo || p.id}.pdf` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * The send centre: payment reminders (each with the member's own payment link) or receipts (signed, as a link, and
 * as a PDF by e-mail) to many members at once. E-mail goes out from the server in one go when e-mail is set up;
 * WhatsApp opens one chat after another with the message ready, because WhatsApp lets only the person press send.
 */
async function openSend(d, { kind = 'REMINDER', memberId = null, paymentIds = null } = {}) {
    const c = d.chit;
    const mail = await mailReady();
    const month = d.schedule.find(m => m.status === 'ONGOING');
    const st = { kind, scope: kind === 'REMINDER' ? 'OWING' : paymentIds ? 'PICKED' : month ? 'MONTH' : 'ALL', selected: null, done: {}, queue: null };
    const links = { REMINDER: {}, RECEIPT: {} };   // member id / payment id → link
    const me = c.receiptSigner || c.payeeName || state.user?.fullName || 'the organiser';
    const scopes = () => st.kind === 'REMINDER'
        ? [['OWING', 'Who owes now'], ...(month ? [['UPCOMING', `Month ${month.monthNo} installment`]] : [])]
        : [...(paymentIds ? [['PICKED', 'This receipt']] : []), ...(month ? [['MONTH', `Month ${month.monthNo} payments`]] : []), ['WEEK', 'Last 7 days'], ['ALL', 'All payments']];
    const defaultText = () => (st.kind === 'REMINDER' ? REMINDER_TEXT[st.scope] : RECEIPT_TEXT);

    const rows = () => {
        if (st.kind === 'REMINDER') {
            if (st.scope === 'OWING') {
                return owingList(d).filter(x => !memberId || x.m.id === memberId).map(x => {
                    const late = d.lateFees.filter(l => l.memberId === x.m.id).reduce((s, l) => s + num(l.due), 0);
                    const months = x.months.map(y => shortMonth(y.s.dueDate)).join(', ');
                    return { key: `m${x.m.id}`, m: x.m, amount: x.total + late, detail: months + (late ? ` · ${money(late)} late interest` : ''),
                        vars: { months: months + (late ? ` + ${money(late)} late interest` : ''), date: date(x.months.at(-1).s.dueDate),
                            note: payCode(c, x.months[0]?.s.monthNo || c.currentMonth) } };
                });
            }
            if (!month) return [];
            return d.members.filter(m => !memberId || m.id === memberId).map(m => ({ m, amount: Math.max(0, dueFor(d, m, month) - paidFor(d, m.id, month.monthNo)) }))
                .filter(x => x.amount > 0)
                .map(x => ({ key: `m${x.m.id}`, m: x.m, amount: x.amount, detail: `month ${month.monthNo} · due ${date(month.dueDate)}`,
                    vars: { months: monthName(month.dueDate), date: date(month.dueDate), note: payCode(c, month.monthNo) } }));
        }
        const weekAgo = isoDate(new Date(Date.now() - 7 * 86400000));
        return d.payments
            .filter(p => !memberId || p.memberId === memberId)
            .filter(p => st.scope === 'PICKED' ? paymentIds.includes(p.id) : st.scope === 'MONTH' ? p.monthNo === month?.monthNo
                : st.scope === 'WEEK' ? p.paidDate >= weekAgo : true)
            .sort((a, b) => b.paidDate.localeCompare(a.paidDate) || b.id - a.id)
            .map(p => ({ key: `p${p.id}`, p, m: d.members.find(x => x.id === p.memberId), amount: num(p.amount) + num(p.lateFee),
                detail: `${p.receiptNo || ''} · month ${p.monthNo} · ${date(p.paidDate)}`, vars: { date: date(p.paidDate), month: p.monthNo, receipt: p.receiptNo || '' } }));
    };
    const linkOf = r => (st.kind === 'REMINDER' ? links.REMINDER[r.m.id] : links.RECEIPT[r.p.id]);
    const fill = (text, r) => {
        const link = linkOf(r);
        const linkText = st.kind === 'REMINDER'
            ? (link ? ` ${(c.upiId || c.payToAccountId) ? 'Pay or see your statement here' : 'Your statement'}: ${link}` : ' [payment link]')
            : (link || '[receipt link]');
        return text.replaceAll('{name}', r.m.name.split(' ')[0]).replaceAll('{amount}', money(r.amount)).replaceAll('{months}', r.vars.months || '')
            .replaceAll('{date}', r.vars.date || '').replaceAll('{month}', String(r.vars.month ?? '')).replaceAll('{receipt}', r.vars.receipt || '')
            .replaceAll('{chit}', c.name).replaceAll('{me}', me).replaceAll('{link}', linkText).replaceAll('{note}', r.vars.note || payCode(c, r.vars.month || c.currentMonth));
    };
    /** Makes the links still missing for these rows, in one call. */
    const ensureLinks = async list => {
        const need = list.filter(r => !linkOf(r));
        if (!need.length) return;
        const body = st.kind === 'REMINDER' ? { memberIds: [...new Set(need.map(r => r.m.id))], hours: 24 * 30 } : { paymentIds: need.map(r => r.p.id), hours: 24 * 90 };
        const made = await api.post(`/hosted-chits/${c.id}/shares/batch`, body);
        made.forEach(l => { if (l.paymentId) links.RECEIPT[l.paymentId] = shareUrl(l.token); else links.REMINDER[l.memberId] = shareUrl(l.token); });
    };

    openModal({
        title: memberId ? `Send to ${d.members.find(m => m.id === memberId)?.name}` : 'Send reminders & receipts', iconName: 'send', size: 'xl',
        body: `<div class="hc-send">
            <div class="hc-send-top">
                <div class="seg-chips" data-kinds>
                    <button type="button" class="seg-chip" data-kind-v="REMINDER">${icon('bell')}Payment reminders</button>
                    <button type="button" class="seg-chip" data-kind-v="RECEIPT">${icon('receipt')}Receipts</button>
                </div>
                <div class="seg-chips sm" data-scopes></div>
            </div>
            <label class="field hc-send-msg"><span>Message <small class="muted" data-vars></small></span>
                <textarea name="template" rows="2" data-plain></textarea></label>
            <div class="hc-send-bar">
                <label class="check-line"><input type="checkbox" data-all> <b data-count></b></label>
                <span class="muted hc-small" data-reach></span>
            </div>
            <div class="hc-send-list" data-list></div>
            <div class="hc-queue" data-queue hidden></div>
            ${mail.configured ? `<p class="muted hc-small" style="margin:0">${icon('mail')} E-mails go out from <b>${esc(mail.from)}</b>${mail.source === 'SERVER' ? ' (the installation’s account)' : ''}.</p>`
                : `<p class="hc-note warn hc-small">${icon('mail')}<span>E-mail is not set up yet, so only WhatsApp and copy work. ${can('MANAGE_USERS')
                    ? 'Add your e-mail account in <a href="#/settings/email">Settings → E-mail</a> (for Gmail: an app password).' : 'Ask an admin to add an e-mail account in Settings → E-mail.'}</span></p>`}
        </div>`,
        actions: [
            { label: 'Copy all', left: true, iconName: 'copy', onClick: async modal => {
                const list = chosen();
                if (!list.length) throw new Error('Choose at least one member');
                await ensureLinks(list);
                draw(modal);
                const all = list.map(r => `${r.m.name}${r.m.phone ? ` (${r.m.phone})` : ''}: ${fill(text(modal), r)}`).join('\n\n');
                try { await navigator.clipboard.writeText(all); toast(`${plural(list.length, 'message')} copied`, 'info'); } catch { toast('Could not copy', 'error'); }
                return true;
            } },
            { label: 'E-mail', iconName: 'mail', onClick: async modal => { await sendMail(modal); return true; } },
            { label: 'WhatsApp one by one', kind: 'primary', iconName: 'phone', onClick: async modal => { await startQueue(modal); return true; } },
        ],
        onOpen: modal => {
            const area = modal.el.querySelector('[name=template]');
            area.value = defaultText();
            area.addEventListener('input', () => draw(modal));
            modal.el.querySelector('[data-kinds]').addEventListener('click', e => {
                const chip = e.target.closest('[data-kind-v]');
                if (!chip || chip.dataset.kindV === st.kind) return;
                st.kind = chip.dataset.kindV;
                st.scope = scopes()[0][0];
                st.selected = null;
                st.queue = null;
                area.value = defaultText();   // reminders and receipts say different things
                draw(modal);
            });
            modal.el.querySelector('[data-scopes]').addEventListener('click', e => {
                const chip = e.target.closest('[data-scope-v]');
                if (!chip) return;
                const wasDefault = area.value === defaultText();
                st.scope = chip.dataset.scopeV;
                st.selected = null;
                if (wasDefault) area.value = defaultText();
                draw(modal);
            });
            modal.el.querySelector('[data-all]').addEventListener('change', e => {
                st.selected = e.target.checked ? null : new Set();
                draw(modal);
            });
            modal.el.querySelector('[data-list]').addEventListener('change', e => {
                const box = e.target.closest('[data-pick]');
                if (!box) return;
                const key = box.closest('[data-key]').dataset.key;
                if (!st.selected) st.selected = new Set(rows().map(r => r.key));
                if (box.checked) st.selected.add(key); else st.selected.delete(key);
                draw(modal);
            });
            modal.el.querySelector('[data-list]').addEventListener('click', async e => {
                const rowEl = e.target.closest('[data-key]');
                if (!rowEl) return;
                const r = rows().find(x => x.key === rowEl.dataset.key);
                if (!r) return;
                if (e.target.closest('[data-wa]')) {
                    const win = window.open('', '_blank');   // opened during the click, then pointed at WhatsApp
                    try {
                        await ensureLinks([r]);
                        const href = waLink(r.m, fill(text(modal), r));
                        if (win) { win.opener = null; win.location.href = href; } else location.href = href;
                        mark(r.key, 'wa');
                        draw(modal);
                    } catch (err) { win?.close(); toast(err.message, 'error'); }
                } else if (e.target.closest('[data-copy]')) {
                    try { await ensureLinks([r]); await navigator.clipboard.writeText(fill(text(modal), r)); toast('Message copied', 'info'); draw(modal); } catch (err) { toast(err.message, 'error'); }
                } else if (e.target.closest('[data-pdf]')) {
                    try { await downloadReceiptPdf(d, r.p); } catch (err) { toast(err.message, 'error'); }
                }
            });
            modal.el.querySelector('[data-queue]').addEventListener('click', e => {
                if (e.target.closest('[data-q-open]')) {
                    const r = st.queue.list[st.queue.i];
                    mark(r.key, 'wa');
                    setTimeout(() => { st.queue.i++; drawQueue(modal); }, 0);   // after the link has opened
                } else if (e.target.closest('[data-q-skip]')) {
                    st.queue.i++;
                    drawQueue(modal);
                } else if (e.target.closest('[data-q-stop]')) {
                    st.queue = null;
                    draw(modal);
                }
            });
            draw(modal);
        },
    });

    function text(modal) { return modal.el.querySelector('[name=template]').value; }
    function chosen() { return rows().filter(r => !st.selected || st.selected.has(r.key)); }
    function mark(key, how, value = true) { st.done[`${st.kind}:${key}`] = { ...st.done[`${st.kind}:${key}`], [how]: value }; }

    function draw(modal) {
        const el = modal.el;
        el.querySelectorAll('[data-kind-v]').forEach(x => x.classList.toggle('active', x.dataset.kindV === st.kind));
        el.querySelector('[data-scopes]').innerHTML = scopes().map(([k, label]) => `<button type="button" class="seg-chip ${st.scope === k ? 'active' : ''}" data-scope-v="${k}">${label}</button>`).join('');
        el.querySelector('[data-vars]').textContent = st.kind === 'REMINDER' ? '{name} {amount} {months} {date} {note} {chit} {link} {me} are filled in'
            : '{name} {amount} {month} {date} {receipt} {chit} {link} {me} are filled in · e-mails carry the signed PDF';
        const list = rows();
        const picked = chosen();
        const box = el.querySelector('[data-all]');
        box.checked = picked.length === list.length && list.length > 0;
        box.indeterminate = picked.length > 0 && picked.length < list.length;
        el.querySelector('[data-count]').textContent = list.length ? `${picked.length} of ${plural(list.length, st.kind === 'REMINDER' ? 'member' : 'receipt')} chosen` : 'Nobody to send to';
        const withPhone = picked.filter(r => phoneOf(r.m)).length;
        const withMail = picked.filter(r => r.m.email).length;
        el.querySelector('[data-reach]').innerHTML = `${icon('phone')}${withPhone} on WhatsApp · ${icon('mail')}${mail.configured ? `${withMail} by e-mail` : 'e-mail not set up'}`
            + (picked.some(r => !phoneOf(r.m) && !r.m.email) ? ` · ${picked.filter(r => !phoneOf(r.m) && !r.m.email).length} without a phone or e-mail` : '');
        const t = text(modal);
        el.querySelector('[data-list]').innerHTML = list.length ? list.map(r => {
            const done = st.done[`${st.kind}:${r.key}`] || {};
            const on = !st.selected || st.selected.has(r.key);
            const msg = fill(t, r);
            return `<div class="hc-send-row ${on ? '' : 'off'} ${done.wa || done.mail === true ? 'sent' : ''}" data-key="${r.key}">
                <input type="checkbox" data-pick ${on ? 'checked' : ''} aria-label="Send to ${esc(r.m.name)}">
                <span class="hc-avatar sm">${esc(initials(r.m.name))}</span>
                <span class="grow min-0 hc-send-who"><span><b>${esc(r.m.name)}</b> <b class="${st.kind === 'REMINDER' ? 'neg' : 'pos'}">${money(r.amount)}</b> <small class="muted">${esc(r.detail)}</small></span>
                    <small class="muted ellipsis" title="${esc(msg)}">${esc(msg)}</small></span>
                <span class="hc-send-ch"><i class="${phoneOf(r.m) ? 'on' : ''}" title="${esc(r.m.phone || 'No phone number')}">${icon('phone')}</i><i class="${r.m.email ? 'on' : ''}" title="${esc(r.m.email || 'No e-mail: add it with Members → edit')}">${icon('mail')}</i></span>
                <span class="hc-send-status">${done.mail === true ? `<span class="badge good">${icon('mail')}e-mailed</span>` : done.mail ? `<span class="badge critical" title="${esc(done.mail)}">not e-mailed</span>` : ''}
                    ${done.wa ? `<span class="badge good">${icon('check')}WhatsApp</span>` : ''}</span>
                <span class="hc-send-acts">
                    ${phoneOf(r.m) ? `<button type="button" class="btn sm ghost" data-wa title="Open WhatsApp with this message">${icon('phone')}WhatsApp</button>` : ''}
                    ${st.kind === 'RECEIPT' ? `<button type="button" class="btn sm ghost icon" data-pdf title="Download the signed PDF">${icon('download')}</button>` : ''}
                    <button type="button" class="btn sm ghost icon" data-copy title="Copy the message">${icon('copy')}</button>
                </span>
            </div>`;
        }).join('') : emptyState(st.kind === 'REMINDER' ? (st.scope === 'OWING' ? 'Nobody owes anything right now' : 'Everyone has paid this month') : 'No payments in this list', 'check-circle');
        el.querySelector('[data-list]').hidden = !!st.queue;
        el.querySelector('[data-queue]').hidden = !st.queue;
        const [, mailBtn, waBtn] = el.querySelectorAll('.modal-foot [data-action-index]');
        mailBtn.innerHTML = `${icon('mail')}E-mail ${mail.configured ? withMail : ''}`;
        mailBtn.title = mail.configured ? `E-mail ${plural(withMail, 'member')} now, all at once${st.kind === 'RECEIPT' ? ', with the signed PDF' : ''}` : 'E-mail is not set up: Settings → E-mail';
        waBtn.innerHTML = `${icon('phone')}WhatsApp ${withPhone} one by one`;
        if (st.queue) drawQueue(modal);
    }

    async function sendMail(modal) {
        if (!mail.configured) throw new Error('E-mail is not set up yet: add your e-mail account in Settings → E-mail');
        const list = chosen().filter(r => r.m.email);
        if (!list.length) throw new Error('None of the chosen members has an e-mail address. Add it with Members → edit.');
        await ensureLinks(list);
        const t = text(modal);
        let sent = 0;
        const failed = [];
        for (let i = 0; i < list.length; i += 100) {
            const part = list.slice(i, i + 100);
            const result = await api.post(`/hosted-chits/${c.id}/send-email`, {
                kind: st.kind,
                items: part.map(r => ({
                    memberId: r.m.id, paymentId: st.kind === 'RECEIPT' ? r.p.id : null,
                    subject: st.kind === 'REMINDER' ? `${c.name}: installment reminder` : `${c.name}: receipt ${r.p.receiptNo || ''}`,
                    body: fill(t, r) + (st.kind === 'RECEIPT' ? '\n\nThe signed receipt is attached as a PDF.' : ''),
                })),
            });
            sent += result.sent;
            const bad = new Map(result.failed.map(f => [f.memberId, f.reason]));
            part.forEach(r => mark(r.key, 'mail', bad.has(r.m.id) ? bad.get(r.m.id) : true));
            failed.push(...result.failed);
        }
        draw(modal);
        toast(failed.length ? `E-mailed ${sent}; ${failed.length} not sent (${failed[0].name}: ${failed[0].reason})` : `E-mailed ${plural(sent, st.kind === 'REMINDER' ? 'reminder' : 'receipt')} ✓`,
            failed.length ? 'error' : 'success');
    }

    async function startQueue(modal) {
        const picked = chosen();
        const list = picked.filter(r => phoneOf(r.m));
        if (!list.length) throw new Error(picked.length ? 'None of the chosen members has a phone number' : 'Choose at least one member');
        await ensureLinks(list);
        st.queue = { list, i: 0, skipped: picked.length - list.length };
        draw(modal);
    }

    function drawQueue(modal) {
        const q = st.queue;
        const el = modal.el.querySelector('[data-queue]');
        const n = q.list.length;
        if (q.i >= n) {
            el.innerHTML = `<div class="hc-queue-done">${icon('check-circle')}<b>All ${plural(n, 'WhatsApp message')} opened</b>
                <small class="muted">${q.skipped ? `${plural(q.skipped, 'member')} without a phone number ${q.skipped === 1 ? 'was' : 'were'} left out · ` : ''}press send in each chat if you have not yet</small>
                <button type="button" class="btn sm" data-q-stop>${icon('chevron-left')}Back to the list</button></div>`;
            return;
        }
        const r = q.list[q.i];
        const msg = fill(text(modal), r);
        el.innerHTML = `<div class="hc-queue-head"><b>WhatsApp · ${q.i + 1} of ${n}</b>
                <i class="split-bar"><span class="paid" style="width:${(q.i / n) * 100}%"></span></i>
                <button type="button" class="btn sm ghost" data-q-stop>Stop</button></div>
            <div class="hc-queue-card">
                <span class="hc-avatar">${esc(initials(r.m.name))}</span>
                <div class="min-0 grow"><b>${esc(r.m.name)}</b> <small class="muted">${esc(r.m.phone || '')} · ${money(r.amount)}</small>
                    <p class="hc-queue-msg">${esc(msg)}</p></div>
            </div>
            <div class="row hc-queue-acts">
                <a class="btn primary" target="_blank" rel="noopener" href="${esc(waLink(r.m, msg))}" data-q-open>${icon('phone')}Open WhatsApp for ${esc(r.m.name.split(' ')[0])}</a>
                <button type="button" class="btn" data-q-skip>Skip${icon('chevron-right')}</button>
                <small class="muted">WhatsApp opens with the message and link ready: press send there, come back, and the next member is waiting.</small>
            </div>`;
    }
}

// ---------------------------------------------------------------- receipts, statements and agreements

/**
 * A payment's receipt, signed by the organiser (their drawn signature) and sealed (HMAC-SHA256 over every figure,
 * made by the server): printable, as a PDF, or sent to the member by e-mail or WhatsApp.
 */
async function openReceipt(d, p) {
    if (!p) return;
    const c = d.chit;
    const member = d.members.find(m => m.id === p.memberId);
    const r = await api.get(`/hosted-chits/${c.id}/payments/${p.id}/receipt`);
    const line = (label, value) => `<div class="hc-rc-line"><span>${label}</span><b>${value}</b></div>`;
    const receipt = `<div class="hc-receipt" data-receipt>
        <div class="hc-rc-head"><div><small>Payment receipt</small><h3>${esc(c.name)}</h3><span class="muted">${esc(r.signer || '')}</span></div>
            <div class="hc-rc-no"><b>${esc(r.receiptNo || '')}</b><span>${date(r.paidDate)}</span></div></div>
        <div class="hc-rc-amount"><small>Received from ${esc(r.memberName)}</small><b>${money(r.total)}</b></div>
        ${line('Towards', `month ${r.monthNo} installment (due ${date(r.monthDueDate)})`)}
        ${line('Installment paid', money(r.amount))}
        ${num(r.lateFee) ? line('Late payment interest', money(r.lateFee)) : ''}
        ${num(r.lateFeeWaived) ? line('Late interest let off', money(r.lateFeeWaived)) : ''}
        ${line('Paid by', `${esc(r.mode)}${r.reference ? ` · ref ${esc(r.reference)}` : ''}`)}
        ${line(`Month ${r.monthNo} so far`, `${money(r.paidForMonth)} of ${money(r.dueForMonth)}${num(r.balanceForMonth) ? ` · ${money(r.balanceForMonth)} still due` : ' · fully paid'}`)}
        ${p.note ? line('Note', esc(p.note)) : ''}
        <div class="hc-rc-sign">
            <div class="hc-rc-seal">${icon('shield')}<span><b>Digitally sealed</b><small>HMAC-SHA256 over every figure on this receipt</small><code class="hc-hash">${esc(r.seal)}</code></span></div>
            <div class="hc-rc-signer">${r.signature ? signatureSvg(r.signature)
                : manage() ? `<button type="button" class="btn sm" data-add-sign>${icon('signature')}Add my signature</button>` : ''}
                <b>${esc(r.signer || 'Organiser')}</b><small>${r.signature ? 'Digitally signed · organiser' : 'Organiser'}</small></div>
        </div>
        <p class="hc-rc-foot">Recorded by ${esc(p.createdBy || '')} on ${dateTime(p.createdAt)}. Any change to the figures changes the seal.</p>
    </div>`;
    openModal({
        title: `Receipt ${p.receiptNo || ''}`, iconName: 'receipt',
        body: receipt,
        actions: [
            { label: 'PDF', left: true, iconName: 'download', onClick: async () => { await downloadReceiptPdf(d, p); return true; } },
            { label: 'Print', iconName: 'printer', onClick: modal => { printElement(modal.el.querySelector('[data-receipt]'), `Receipt ${p.receiptNo}`); return true; } },
            ...(manage() ? [{ label: `Send to ${member.name.split(' ')[0]}`, kind: 'primary', iconName: 'send', onClick: () => {
                setTimeout(() => openSend(d, { kind: 'RECEIPT', paymentIds: [p.id] }), 0);
            } }] : []),
        ],
        onOpen: modal => modal.el.querySelector('[data-add-sign]')?.addEventListener('click', () => openSignature(d, fresh => {
            modal.close();
            openReceipt(fresh, fresh.payments.find(x => x.id === p.id));
        })),
    });
}

/** The organiser draws their signature once; it goes on every receipt of the chit (screen, PDF and links). */
function openSignature(d, done) {
    const c = d.chit;
    let pad;
    openModal({
        title: 'Signature for receipts', iconName: 'signature', size: 'lg',
        body: `<p class="muted" style="margin-top:0">Sign once: it is printed on every receipt of <b>${esc(c.name)}</b> (on screen, in the PDF and on receipt links), next to the digital seal.</p>
            ${c.receiptSignature ? `<div class="hc-sign-now">${signatureSvg(c.receiptSignature)}<small>Your signature now${c.receiptSigner ? ` · ${esc(c.receiptSigner)}` : ''}</small></div>` : ''}
            <div class="hc-sign-pad"><div class="hc-sign-head"><span>${c.receiptSignature ? 'Sign again to change it' : 'Sign here with your mouse or finger'}</span>
                <button type="button" class="btn sm ghost" data-sign-clear>${icon('x')}Clear</button></div>
                <canvas width="1000" height="300" data-sign-pad></canvas></div>
            <label class="field"><span>Name under the signature</span><input type="text" name="signer" maxlength="100" value="${esc(c.receiptSigner || c.payeeName || state.user?.fullName || '')}"></label>`,
        actions: [
            ...(c.receiptSignature ? [{ label: 'Remove', left: true, iconName: 'trash', onClick: async () => {
                const fresh = await api.put(`/hosted-chits/${c.id}/receipt-signature`, { signature: '' });
                await afterChange(fresh, 'Signature removed');
                done?.(fresh);
            } }] : []),
            { label: 'Cancel' },
            { label: 'Save signature', kind: 'primary', iconName: 'check', onClick: async modal => {
                if (pad.empty()) throw new Error('Sign in the box first');
                const fresh = await api.put(`/hosted-chits/${c.id}/receipt-signature`,
                    { signature: pad.path(), signer: modal.el.querySelector('[name=signer]').value.trim() || null });
                await afterChange(fresh, 'Signature saved: it is on every receipt now');
                done?.(fresh);
            } },
        ],
        onOpen: modal => {
            pad = signaturePad(modal.el.querySelector('[data-sign-pad]'));
            modal.el.querySelector('[data-sign-clear]').addEventListener('click', () => pad.clear());
        },
    });
}

/** A signature pad on a canvas; the strokes come back as an SVG path in a 1000 x 300 box. */
function signaturePad(canvas) {
    const ctx = canvas.getContext('2d');
    const strokes = [];
    let current = null;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0a2e4f';
    const point = e => {
        const box = canvas.getBoundingClientRect();
        return [Math.round(((e.clientX - box.left) / box.width) * 1000), Math.round(((e.clientY - box.top) / box.height) * 300)];
    };
    canvas.addEventListener('pointerdown', e => {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        current = [point(e)];
        strokes.push(current);
    });
    canvas.addEventListener('pointermove', e => {
        if (!current) return;
        const [x, y] = point(e);
        const [px, py] = current[current.length - 1];
        if (Math.abs(x - px) + Math.abs(y - py) < 4) return;
        current.push([x, y]);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(x, y);
        ctx.stroke();
    });
    const end = () => { current = null; };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    return {
        empty: () => strokes.reduce((n, s) => n + s.length, 0) < 6,
        clear: () => { strokes.length = 0; ctx.clearRect(0, 0, canvas.width, canvas.height); },
        path: () => strokes.filter(s => s.length > 1).map(s => 'M' + s.map(([x, y]) => `${x} ${y}`).join(' L')).join(' ').slice(0, 20000),
    };
}

/** A member's statement: every month, every payment, what is due; printable or sent as a link (with “Pay now”). */
function openStatement(d, m) {
    const c = d.chit;
    const rows = d.schedule.map(s => {
        const due = dueFor(d, m, s), paid = paidFor(d, m.id, s.monthNo), late = lateFor(d, m.id, s.monthNo);
        const st = paid >= due ? 'Paid' : paid > 0 ? 'Part paid' : s.due ? 'Due' : '—';
        return `<tr><td class="c">${s.monthNo}${m.wonMonth === s.monthNo ? ' 👑' : ''}</td><td>${date(s.dueDate)}</td><td class="r">${money(due)}</td>
            <td class="r">${paid ? money(paid) : '—'}</td><td class="r ${late ? 'neg' : 'muted'}">${late ? money(late.due) : '—'}</td><td>${st}</td></tr>`;
    }).join('');
    const pays = d.payments.filter(p => p.memberId === m.id).sort((a, b) => a.paidDate.localeCompare(b.paidDate) || a.id - b.id);
    const won = m.wonMonth ? monthOf(d, m.wonMonth) : null;
    const owe = num(m.balanceDue) + num(m.lateFeeDue);
    const html = `<div class="hc-statement" data-statement>
        <div class="hc-rc-head"><div><small>Member statement</small><h3>${esc(m.name)}</h3><span class="muted">${esc(c.name)} · as of ${date(isoDate())}</span></div>
            <div class="hc-rc-no"><b>${money(m.totalPaid)}</b><span>paid so far</span></div></div>
        <div class="hc-pay-sum">
            <span><small>Owes now</small><b class="${owe ? 'neg' : 'pos'}">${owe ? money(owe) : 'Nothing'}</b></span>
            <span><small>Late interest</small><b>${money(m.lateFeeDue)}</b></span>
            <span><small>Won</small><b>${won ? `month ${m.wonMonth} · ${money(won.payout)}` : 'not yet'}</b></span>
        </div>
        <table class="grid compact"><thead><tr><th class="c">Month</th><th>Pay by</th><th class="r">Due</th><th class="r">Paid</th><th class="r">Late int.</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
        ${pays.length ? `<div class="section-title">${icon('receipt')}Payments</div><table class="grid compact"><thead><tr><th>Receipt</th><th>Date</th><th class="c">Month</th><th class="r">Amount</th><th>How</th></tr></thead>
            <tbody>${pays.map(p => `<tr><td>${esc(p.receiptNo || '')}</td><td>${date(p.paidDate)}</td><td class="c">${p.monthNo}</td>
                <td class="r">${money(num(p.amount) + num(p.lateFee))}</td><td>${esc(p.mode)}${p.reference ? ` · ${esc(p.reference)}` : ''}</td></tr>`).join('')}</tbody></table>` : ''}
    </div>`;
    openModal({
        title: `Statement · ${m.name}`, iconName: 'file-text', size: 'lg',
        body: `${html}<div data-link-result></div>`,
        actions: [
            { label: 'Print / PDF', left: true, iconName: 'printer', onClick: modal => { printElement(modal.el.querySelector('[data-statement]'), `${m.name} · ${c.name}`); return true; } },
            { label: 'Close' },
            { label: (c.upiId || c.payToAccountId || m.payToAccountId) && owe ? 'Send statement with payment link' : 'Send statement', kind: 'primary', iconName: 'share', onClick: async modal => {
                const { url, share } = await makeLink(d, { memberId: m.id }, 24 * 30);
                const fp = (await api.get('/hosted-chits/settings').catch(() => ({}))).keyFingerprint;
                const into = m.payToAccountId && m.payToSummary ? ` Pay only into ${m.payToSummary.replace(/^UPI /, 'UPI ID ')}, as signed on the link${fp ? ` (signing key ${fp})` : ''}.` : '';
                const text = `Hi ${m.name.split(' ')[0]}, your statement for ${c.name}${owe ? `: ${money(owe)} is due` : ''}.${(c.upiId || c.payToAccountId || m.payToAccountId) && owe ? ' You can pay from the link.' : ''}${into} ${url}`;
                modal.el.querySelector('[data-link-result]').innerHTML = linkResultHtml(url, text, m, share.expiresAt);
                return true;
            } },
        ],
    });
}

/** The winner's digital agreement for a month: make it, send it to accept, print it, or record a paper signature. */
function openAgreement(d, monthNo) {
    const c = d.chit;
    const month = monthOf(d, monthNo);
    const a = (d.agreements || []).find(x => x.monthNo === monthNo);
    const member = d.members.find(x => x.id === (a?.memberId ?? month.winnerMemberId));
    if (!a) {
        openModal({
            title: `Agreement · month ${monthNo}`, iconName: 'file-text',
            body: `<p style="margin-top:0">A digital agreement records that <b>${esc(month.winnerName)}</b> received <b>${money(month.payout)}</b> and will pay the remaining installments.
                You send it as a link; they accept it by typing their name. The time, the device and a fingerprint (hash) of the text are kept.</p>
                <form class="form-grid two">
                    <label class="field"><span>Guarantor <small class="muted">optional</small></span><input type="text" name="guarantorName" maxlength="100" data-plain></label>
                    <label class="field"><span>Guarantor's phone</span><input type="tel" name="guarantorPhone" maxlength="14" inputmode="numeric" data-plain></label>
                </form>`,
            actions: [
                { label: 'Cancel' },
                { label: 'Make agreement', kind: 'primary', iconName: 'check', onClick: async modal => {
                    const form = modal.el.querySelector('form');
                    const fresh = await api.post(`/hosted-chits/${c.id}/months/${monthNo}/agreement`,
                        { guarantorName: form.guarantorName.value.trim() || null, guarantorPhone: form.guarantorPhone.value.trim() || null });
                    await afterChange(fresh, 'Agreement made');
                    openAgreement(fresh, monthNo);
                } },
            ],
        });
        return;
    }
    const [tone, ic, label] = AGREEMENT_STATUS[a.status] || ['gray', 'info', a.status];
    const draft = a.status === 'DRAFT';
    const doc = `<div class="hc-agreement" data-agreement>
        <div class="hc-rc-head"><div><small>Chit prize agreement</small><h3>${esc(c.name)} · month ${a.monthNo}</h3><span class="muted">${esc(a.memberName)} · ${esc(a.agreementNo)}</span></div>
            <div class="hc-rc-no"><span class="badge ${tone}">${icon(ic)}${label}</span></div></div>
        <div class="hc-pay-sum">
            <span><small>Chit value</small><b>${money(a.chitValue)}</b></span>
            <span><small>${isAuction(c) ? 'Winning bid' : 'Commission'}</small><b>${money(a.deduction)}</b></span>
            <span><small>Received</small><b class="pos">${money(a.payoutAmount)}</b></span>
            <span><small>Still to pay</small><b>${a.remainingInstallments} months · ${moneyShort(a.remainingAmount)}</b></span>
        </div>
        <div class="hc-terms">${esc(a.terms)}</div>
        ${evidenceHtml(a, member)}
    </div>`;
    openModal({
        title: `Agreement ${a.agreementNo}`, iconName: 'file-text', size: 'lg',
        body: `${doc}<div data-link-result></div>`,
        actions: [
            { label: 'Print / PDF', left: true, iconName: 'printer', onClick: modal => { printElement(modal.el.querySelector('[data-agreement]'), `Agreement ${a.agreementNo}`); return true; } },
            ...(draft && manage() ? [
                { label: 'Delete', iconName: 'trash', onClick: async () => {
                    if (!await confirmDialog(`Delete agreement ${a.agreementNo}? Links already sent stop working.`, { confirmLabel: 'Delete' })) return true;
                    await afterChange(await api.del(`/hosted-chits/${c.id}/agreements/${a.id}`), 'Agreement deleted');
                } },
                { label: 'Signed on paper', iconName: 'edit', onClick: async () => {
                    if (!await confirmDialog(`Record that ${a.memberName} signed a printed copy of ${a.agreementNo}?`, { title: 'Signed on paper', confirmLabel: 'Record signature', danger: false })) return true;
                    await afterChange(await api.post(`/hosted-chits/${c.id}/agreements/${a.id}/signed`, { name: a.memberName }), 'Signature recorded');
                } },
                { label: 'Send to accept', kind: 'primary', iconName: 'share', onClick: async modal => {
                    const { url, share } = await makeLink(d, { agreementId: a.id }, 24 * 30);
                    const text = `Hi ${a.memberName.split(' ')[0]}, please read and accept the agreement for the ${money(a.payoutAmount)} you received from ${c.name} (month ${a.monthNo}): ${url}`;
                    modal.el.querySelector('[data-link-result]').innerHTML = linkResultHtml(url, text, member, share.expiresAt);
                    return true;
                } },
            ] : [
                { label: 'Send a copy', kind: 'primary', iconName: 'share', onClick: async modal => {
                    const { url, share } = await makeLink(d, { agreementId: a.id }, 24 * 90);
                    modal.el.querySelector('[data-link-result]').innerHTML = linkResultHtml(url, `Your agreement ${a.agreementNo} for ${c.name}: ${url}`, member, share.expiresAt);
                    return true;
                } },
            ]),
        ],
    });
}

// ---------------------------------------------------------------- share links

/** A temporary link to the chit (or one member's status) that opens without an account. */
async function openShare(d, memberId = null) {
    const c = d.chit;
    const listHtml = shares => !shares.length ? '' : `
        <div class="section-title">${icon('link')} Links made</div>
        <div class="cs-list">${shares.map(s => {
            const tone = s.status === 'ACTIVE' ? ['good', `until ${dateTime(s.expiresAt)}`] : s.status === 'EXPIRED' ? ['gray', 'expired'] : ['critical', 'revoked'];
            return `<div class="cs-row ${s.status.toLowerCase()}">
                <span class="badge ${tone[0]}">${tone[1]}</span>
                <span class="grow min-0"><b>${esc(({ RECEIPT: `Receipt · ${s.memberName}`, AGREEMENT: `Agreement · ${s.memberName}`, MEMBER: `${s.memberName}'s statement` })[s.kind] || 'Whole chit')}${s.sharedWith && s.sharedWith !== s.memberName ? ` · ${esc(s.sharedWith)}` : ''}</b>
                    <small class="muted">made ${dateTime(s.createdAt)} · opened ${s.views}×${s.lastViewedAt ? `, last ${dateTime(s.lastViewedAt)}` : ''}${s.showEarnings ? ' · with my earnings' : ''}</small></span>
                ${s.status === 'ACTIVE' ? `<button type="button" class="btn sm ghost" data-revoke-share="${s.id}" title="Stop this link now">${icon('lock')}Revoke</button>` : ''}
            </div>`; }).join('')}</div>`;
    const shares = await api.get(`/hosted-chits/${c.id}/shares`);
    openModal({
        title: `Share · ${c.name}`, iconName: 'share', size: 'lg',
        body: `<div class="cs-dialog">
            <p class="hint" style="margin:0">The link opens on any phone, no sign-in, and is always up to date. It stops when it expires or you revoke it.
                Phone numbers and your accounts are never shown.</p>
            <form class="form-grid two" data-share-form onsubmit="return false">
                <label class="field"><span>What to share</span><select name="memberId">
                    <option value="">The whole chit (every month, collections)</option>
                    ${d.members.map(m => `<option value="${m.id}" ${m.id === memberId ? 'selected' : ''}>${esc(m.name)}'s status (their payments, dues, win)</option>`).join('')}</select></label>
                <div class="field"><span>Valid for</span><div class="ln-chips" data-share-hours>${SHARE_DURATIONS.map(([h, l]) =>
                    `<button type="button" class="date-chip ${h === 168 ? 'selected' : ''}" data-value="${h}">${l}</button>`).join('')}</div></div>
                <label class="field"><span>For <small class="muted">optional</small></span><input name="sharedWith" maxlength="80" data-plain placeholder="who you send it to"></label>
                <label class="field"><span>Message on top <small class="muted">optional</small></span><input name="message" maxlength="300" data-plain placeholder="e.g. Please pay by the 5th"></label>
                <label class="check-line span-2" data-earnings><input type="checkbox" name="showEarnings"> Include my earnings (commission and money with me)</label>
            </form>
            <div data-share-result></div>
            <div data-share-list>${listHtml(shares)}</div>
        </div>`,
        onOpen: m => {
            const form = m.el.querySelector('[data-share-form]');
            const sync = () => { m.el.querySelector('[data-earnings]').hidden = !!form.memberId.value; };
            form.memberId.addEventListener('change', sync);
            sync();
            m.el.querySelector('[data-share-hours]').addEventListener('click', e => {
                const chip = e.target.closest('[data-value]');
                if (chip) m.el.querySelectorAll('[data-share-hours] [data-value]').forEach(x => x.classList.toggle('selected', x === chip));
            });
            m.el.querySelector('[data-share-list]').addEventListener('click', async e => {
                const b = e.target.closest('[data-revoke-share]');
                if (!b) return;
                try {
                    await api.post(`/hosted-chits/${c.id}/shares/${b.dataset.revokeShare}/revoke`);
                    toast('Link stopped');
                    m.el.querySelector('[data-share-list]').innerHTML = listHtml(await api.get(`/hosted-chits/${c.id}/shares`));
                } catch (error) { toast(error.message, 'error'); }
            });
        },
        actions: [
            { label: 'Close' },
            { label: 'Make link', kind: 'primary', iconName: 'link', onClick: async m => {
                const form = m.el.querySelector('[data-share-form]');
                const hours = Number(m.el.querySelector('[data-share-hours] .selected')?.dataset.value || 168);
                const member = d.members.find(x => x.id === Number(form.memberId.value));
                const created = await api.post(`/hosted-chits/${c.id}/shares`, {
                    memberId: member?.id ?? null, sharedWith: form.sharedWith.value, hours, message: form.message.value, showEarnings: !!form.showEarnings.checked,
                });
                const url = `${location.origin}/chit-share.html#${created.token}`;
                const text = member
                    ? `Hi ${member.name.split(' ')[0]}, here is your status in ${c.name}: your payments, what is due and the winners so far, up to date whenever you open it. ${url}`
                    : `Here is the status of ${c.name}: every month, the winners and the collections, up to date whenever you open it. ${url}`;
                const phone = member?.phone ? member.phone.replace(/\D/g, '').slice(-10) : '';
                const result = m.el.querySelector('[data-share-result]');
                result.innerHTML = `<div class="ln-made cs-made">
                    <div class="ln-qr">${qrSvg(url, { size: 150 })}</div>
                    <div class="ln-made-main">
                        <p class="small muted" style="margin:0">Copy or send it now: the link is shown only once. It works until <b>${dateTime(created.share.expiresAt)}</b>.</p>
                        <div class="ln-url"><input value="${esc(url)}" readonly data-plain><button type="button" class="btn sm primary" data-copy>${icon('copy')}Copy</button></div>
                        <div class="row"><a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/${phone ? '91' + phone : ''}?text=${encodeURIComponent(text)}">${icon('phone')}Send on WhatsApp</a>
                            <a class="btn sm" target="_blank" rel="noopener" href="${esc(url)}">${icon('eye')}Preview</a></div>
                    </div></div>`;
                result.querySelector('[data-copy]').addEventListener('click', async () => {
                    try { await navigator.clipboard.writeText(url); toast('Link copied', 'info'); } catch { result.querySelector('input').select(); }
                });
                m.el.querySelector('[data-share-list]').innerHTML = listHtml(await api.get(`/hosted-chits/${c.id}/shares`));
                return true;   // stay open to copy / send
            } },
        ],
    });
}

// ===================================================================== download

/** Months, the payments grid, members and history; the tab on screen comes first (CSV takes the first). */
function exportReport(d) {
    const c = d.chit;
    const auction = isAuction(c);
    const months = {
        name: 'Months',
        columns: [{ label: 'Month', type: 'number' }, { label: 'Pay by', type: 'date' }, { label: 'Chit value', type: 'money' },
            ...(auction ? [{ label: 'Winning bid', type: 'money' }, { label: 'Dividend', type: 'money' }] : []),
            { label: 'Winner gets', type: 'money' }, { label: 'My commission', type: 'money' }, { label: 'Collected', type: 'money' },
            { label: 'Winner' }, { label: 'Status' }, { label: 'Winner paid on', type: 'date' }],
        rows: d.schedule.map(m => [m.monthNo, m.dueDate, num(m.chitValue), ...(auction ? [m.bid !== null ? num(m.bid) : '', num(m.dividend)] : []),
            num(m.payout), num(m.commission), num(m.collected), m.winnerName || '', STATUS[m.status]?.[2] || m.status, m.payoutDate || '']),
    };
    const grid = {
        name: 'Payments',
        columns: [{ label: 'Member' }, { label: 'Phone' }, ...d.schedule.map(m => ({ label: `M${m.monthNo} ${shortMonth(m.dueDate)}`, type: 'money' })),
            { label: 'Total paid', type: 'money' }, { label: 'Owes', type: 'money' }],
        rows: d.members.map(m => [m.name, m.phone || '', ...d.schedule.map(s => paidFor(d, m.id, s.monthNo)), num(m.totalPaid), num(m.balanceDue)]),
        totals: ['Collected', '', ...d.schedule.map(s => num(s.collected)), num(c.totalCollected), num(c.pendingDues)],
    };
    const members = {
        name: 'Members',
        columns: [{ label: '#', type: 'number' }, { label: 'Name' }, { label: 'Phone' }, { label: 'Won month' }, { label: 'Total paid', type: 'money' },
            { label: 'Owes', type: 'money' }],
        rows: d.members.map(m => [m.slot, m.name, m.phone || '', m.wonMonth ? String(m.wonMonth) : '', num(m.totalPaid), num(m.balanceDue)]),
    };
    const receipts = {
        name: 'Receipts',
        columns: [{ label: 'Receipt' }, { label: 'Date', type: 'date' }, { label: 'Member' }, { label: 'Month', type: 'number' }, { label: 'Installment', type: 'money' },
            { label: 'Late interest', type: 'money' }, { label: 'Waived', type: 'money' }, { label: 'How' }, { label: 'Reference' }, { label: 'Note' }],
        rows: d.payments.map(p => [p.receiptNo || '', p.paidDate, p.memberName, p.monthNo, num(p.amount), num(p.lateFee), num(p.lateFeeWaived), p.mode, p.reference || '', p.note || '']),
    };
    const kindLabel = { COLLECTION: 'Member paid', LATE_FEE: 'Late interest', PAYOUT: 'Paid winner', COMMISSION: 'My commission' };
    const history = {
        name: 'History',
        columns: [{ label: 'Date', type: 'date' }, { label: 'What' }, { label: 'Month', type: 'number' }, { label: 'Member' }, { label: 'How' },
            { label: 'Money in', type: 'money' }, { label: 'Money out', type: 'money' }, { label: 'Money with me', type: 'money' }, { label: 'Entry' }, { label: 'Note' }],
        rows: d.ledger.map(r => [r.date, kindLabel[r.kind], r.monthNo, r.kind === 'COMMISSION' ? '' : r.party || '', r.mode || '',
            num(r.moneyIn) || '', num(r.moneyOut) || '', num(r.held), r.entryNo || '', r.note || '']),
    };
    const order = { payments: [grid, receipts, months, members, history], members: [members, grid, receipts, months, history],
        history: [history, receipts, months, grid, members] }[view.tab] || [months, grid, receipts, members, history];
    return {
        title: c.name,
        subtitle: `${auction ? 'Auction chit' : 'Fixed chit'} · ${c.memberCount} members · ${money(c.installment)} a month · from ${monthName(c.startMonth)}`,
        filename: `chit-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
        summary: [['Collected so far', money(c.totalCollected)], ['Paid to winners', money(c.totalPaidOut)],
            ['My commission', money(c.commissionEarned)], ['Still to collect', money(c.pendingDues)]],
        sheets: order,
    };
}

