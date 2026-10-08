/**
 * Host a Chit: chits the user runs as the organiser. Every month each member pays the monthly amount and one
 * member who has not won yet takes the chit value, less the organiser's commission:
 *     chit value(m) = month-1 value + (m − 1) × monthly increase,  winner gets(m) = chit value(m) − commission
 *
 *   #/host-chits               the hosted chits as cards
 *   #/host-chits/new           a 3-step wizard: chit details, members, check & create
 *   #/host-chits/<id>/<tab>    one chit: This month (collect → choose winner → pay winner), All months,
 *                              Payments (members × months grid), Members, History
 *
 * The figures come from the server (HostedChitService); every change answers with the whole chit, which is
 * redrawn in place. Chits a user is a member of stay on the Chits page.
 */
import { api } from '../core/api.js';
import { can, loadAccounts } from '../core/store.js';
import { esc, openModal, confirmDialog, toast, emptyState, accountOptions } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { money, moneyShort, date, isoDate, daysFromToday } from '../core/format.js';
import { exportButton, bindExport } from '../core/export.js';

const view = { tab: 'month', historyKind: 'ALL', memberQuery: '' };
/** The chit on screen (the last answer from the server). */
let current = null;
/** The wizard's draft: kept while moving between steps (and away and back). */
let wizard = null;

const TABS = [
    { key: 'month', label: 'This month', iconName: 'check-circle' },
    { key: 'months', label: 'All months', iconName: 'calendar' },
    { key: 'payments', label: 'Payments', iconName: 'grid' },
    { key: 'members', label: 'Members', iconName: 'users' },
    { key: 'history', label: 'History', iconName: 'history' },
];
const MODES = ['Cash', 'UPI', 'Bank'];
const SAMPLE_NAMES = ['Ravi Kumar', 'Lakshmi Devi', 'Suresh Reddy', 'Anitha Rao', 'Venkatesh', 'Priya Sharma', 'Kiran Babu',
    'Swathi', 'Ramesh Naidu', 'Divya', 'Srinivas', 'Kavitha', 'Mahesh', 'Sandhya', 'Naresh', 'Padma', 'Arjun', 'Revathi',
    'Prakash', 'Sunitha', 'Gopal', 'Madhavi', 'Raju', 'Shobha', 'Harish', 'Vani', 'Sekhar', 'Jyothi', 'Balaji', 'Rekha'];

export async function render(container, params, isCurrent) {
    const [first, second] = params;
    if (first === 'new') return renderWizard(container, isCurrent);
    if (/^\d+$/.test(first || '')) return renderDetail(container, Number(first), second, isCurrent);
    return renderList(container, isCurrent);
}

// ===================================================================== helpers

const num = v => Number(v || 0);
const manage = () => can('MANAGE_CHITS');
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

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

/** Due date of month no (1-based) for a start month "YYYY-MM" and a due day. */
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

/** The chit's months worked out from its settings (the wizard, before anything is saved). */
function scheduleOf(s) {
    const rows = [];
    for (let m = 1; m <= s.months; m++) {
        const value = num(s.baseValue) + (m - 1) * num(s.monthlyIncrement);
        rows.push({ monthNo: m, dueDate: dueDateOf(s.startMonth, s.dueDay, m), chitValue: value, payout: value - num(s.commission) });
    }
    return rows;
}

function randomPhone() {
    return String(6 + Math.floor(Math.random() * 4)) + String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
}

const STATUS = {
    ACTIVE: ['aqua', 'play', 'Running'], COMPLETED: ['good', 'check-circle', 'Finished'],
    ONGOING: ['aqua', 'clock', 'This month'], UPCOMING: ['gray', 'calendar', 'Coming up'],
};
function statusBadge(status) {
    const [tone, iconName, label] = STATUS[status] || ['gray', 'info', status];
    return `<span class="badge ${tone}">${icon(iconName)}${label}</span>`;
}

/** Paid so far by a member for a month (from the chit's payments). */
function paidFor(d, memberId, monthNo, exceptPaymentId = null) {
    return d.payments.filter(p => p.memberId === memberId && p.monthNo === monthNo && p.id !== exceptPaymentId)
        .reduce((s, p) => s + num(p.amount), 0);
}

/** PAID, PARTIAL, PENDING or NOTDUE for one box of the payments grid. */
function cellStatus(d, memberId, month) {
    const paid = paidFor(d, memberId, month.monthNo);
    if (paid >= num(d.chit.installment)) return 'PAID';
    if (paid > 0) return 'PARTIAL';
    return month.due ? 'PENDING' : 'NOTDUE';
}

const CELL = { PAID: ['✓', 'Paid'], PARTIAL: ['½', 'Part paid'], PENDING: ['✗', 'Not paid'], NOTDUE: ['', 'Not due yet'] };

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

function tile(iconName, label, value, sub, tone = '') {
    return `<div class="hc-tile ${tone}">
        <span class="hc-tile-ico">${icon(iconName)}</span>
        <div class="min-0"><small>${esc(label)}</small><b>${value}</b><span>${sub}</span></div>
    </div>`;
}

const bar = (pct, cls = '') => `<i class="hc-bar ${cls}"><em style="width:${Math.max(0, Math.min(100, pct))}%"></em></i>`;

// ===================================================================== list

async function renderList(container, isCurrent) {
    const chits = await api.get('/hosted-chits');
    if (!isCurrent()) return;
    const running = chits.filter(c => c.status === 'ACTIVE');
    const sum = key => running.reduce((s, c) => s + num(c[key]), 0);
    const hasDemo = chits.some(c => c.demo);

    container.innerHTML = `
    <div class="page hc-page">
        <header class="hc-head">
            <span class="hc-mark">${icon('hand-coins')}</span>
            <div class="min-0"><h2>Host a Chit</h2><small>Chits you run: members pay you every month and one of them wins the chit.</small></div>
            <span class="spacer"></span>
            ${manage() ? `<a class="btn primary hc-new" href="#/host-chits/new">${icon('plus')}Host a new chit</a>` : ''}
        </header>
        <div class="hc-scroll">
            ${chits.length ? `
            <div class="hc-tiles three">
                ${tile('alert', 'Still to collect', money(sum('pendingDues')), sum('pendingCount') ? `${plural(sum('pendingCount'), 'payment')} not received yet` : 'everyone has paid', sum('pendingCount') ? 'warn' : 'good')}
                ${tile('arrow-in', 'Collected this month', money(sum('collectedThisMonth')), `out of ${money(sum('expectedThisMonth'))}`)}
                ${tile('crown', 'My commission so far', money(chits.reduce((s, c) => s + num(c.commissionEarned), 0)), 'what you have earned', 'gold')}
            </div>
            <h3 class="hc-section-title">Your chits <small>${running.length} running${chits.length > running.length ? ` · ${chits.length - running.length} finished` : ''}</small></h3>
            <div class="hc-cards">${chits.map(chitCard).join('')}</div>`
            : `<div class="hc-empty">
                <span class="hc-empty-ico">${icon('hand-coins')}</span>
                <h3>Run a chit for family or friends</h3>
                <p>Add the members and the monthly amount. Each month you collect the money, pick a winner and pay them. This page keeps track of all of it.</p>
                ${manage() ? `<div class="row wrap"><a class="btn primary hc-new" href="#/host-chits/new">${icon('plus')}Host a new chit</a>
                    <button class="btn" data-act="load-demo">${icon('sparkles')}Show me an example</button></div>` : ''}
            </div>`}
            ${chits.length && manage() ? `<p class="hc-demo-line">${hasDemo
                ? `${icon('info')}“Family Chit 2026” is example data. <button class="btn sm ghost" data-act="clear-demo">${icon('trash')}Remove example</button>`
                : `<button class="btn sm ghost" data-act="load-demo">${icon('sparkles')}Add an example chit</button>`}</p>` : ''}
        </div>
    </div>`;

    container.querySelector('.hc-page').addEventListener('click', async e => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        try {
            if (act === 'load-demo') {
                await api.post('/hosted-chits/demo');
                toast('Example chit added: Family Chit 2026');
                renderList(container, isCurrent);
            } else if (act === 'clear-demo') {
                if (!await confirmDialog('Remove the example chit “Family Chit 2026” with its members and payments?', { confirmLabel: 'Remove example' })) return;
                await api.del('/hosted-chits/demo');
                toast('Example removed');
                renderList(container, isCurrent);
            }
        } catch (err) {
            toast(err.message, 'error');
        }
    });
}

function chitCard(c) {
    const done = c.status === 'COMPLETED';
    const yetToPay = c.memberCount - c.paidThisMonth;
    return `<a class="hc-card ${done ? 'done' : ''}" href="#/host-chits/${c.id}">
        <div class="hc-card-top">
            <div class="min-0"><b class="ellipsis">${esc(c.name)}</b>
                <small>${c.memberCount} members · ${money(c.installment)} a month</small></div>
            <span class="hc-badges">${c.demo ? '<span class="badge gray">Example</span>' : ''}${statusBadge(c.status)}</span>
        </div>
        ${done ? `<div class="hc-card-big"><b>All ${c.months} months done</b><small>You earned ${money(c.commissionEarned)} in commission</small></div>` : `
        <div class="hc-card-big"><b>Month ${c.currentMonth} <span>of ${c.months}</span></b>${bar((c.completedMonths / c.months) * 100, 'gold')}</div>
        <div class="hc-card-line"><span>This month</span><b>${money(c.collectedThisMonth)} <small>of ${money(c.expectedThisMonth)}</small></b></div>
        ${bar(num(c.expectedThisMonth) ? (num(c.collectedThisMonth) / num(c.expectedThisMonth)) * 100 : 0)}
        <div class="hc-card-foot">
            ${yetToPay ? `<span class="hc-pill warn">${icon('clock')}${plural(yetToPay, 'member')} yet to pay</span>` : `<span class="hc-pill good">${icon('check')}Everyone paid</span>`}
            <span class="hc-open">Open ${icon('chevron-right')}</span>
        </div>`}
    </a>`;
}

// ===================================================================== wizard

function newDraft() {
    const now = new Date();
    return {
        step: 1, name: '', startMonth: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, dueDay: 5,
        memberCount: 20, installment: 25000, baseValue: 500000, monthlyIncrement: 5000, commission: 25000,
        postToBooks: false, accountId: null, baseTouched: false, members: [],
    };
}

async function renderWizard(container, isCurrent) {
    if (!manage()) { location.hash = '#/host-chits'; return; }
    wizard = wizard || newDraft();
    const accounts = await loadAccounts().catch(() => []);
    if (!isCurrent()) return;
    const w = wizard;
    const steps = ['Chit details', 'Members', 'Check & create'];

    container.innerHTML = `
    <div class="page hc-page">
        <header class="hc-head">
            <a class="btn sm ghost icon" href="#/host-chits" data-act="cancel" title="Back">${icon('chevron-left')}</a>
            <div class="min-0"><h2>Host a new chit</h2><small>Step ${w.step} of 3 · ${steps[w.step - 1]}</small></div>
            <span class="spacer"></span>
            <ol class="hc-steps">${steps.map((s, i) =>
                `<li class="${w.step === i + 1 ? 'active' : w.step > i + 1 ? 'done' : ''}" data-step="${i + 1}"><i>${w.step > i + 1 ? icon('check') : i + 1}</i><span>${s}</span></li>`).join('')}</ol>
        </header>
        <div class="hc-scroll"><div class="hc-wizard" id="hc-step"></div></div>
        <footer class="hc-wiz-foot">
            <p class="form-error" id="hc-wiz-error"></p>
            <span class="spacer"></span>
            ${w.step > 1 ? `<button class="btn" data-act="back">${icon('chevron-left')}Back</button>` : `<button class="btn" data-act="cancel">Cancel</button>`}
            ${w.step < 3 ? `<button class="btn primary" data-act="next">Next${icon('chevron-right')}</button>`
                         : `<button class="btn primary" data-act="create">${icon('check')}Create the chit</button>`}
        </footer>
    </div>`;

    const page = container.querySelector('.hc-page');
    const host = page.querySelector('#hc-step');
    const error = msg => { page.querySelector('#hc-wiz-error').textContent = msg || ''; };
    const redraw = () => renderWizard(container, isCurrent);

    if (w.step === 1) drawDetails(host, w, accounts);
    else if (w.step === 2) drawMembers(host, w);
    else drawReview(host, w);

    page.addEventListener('click', async e => {
        const target = e.target.closest('[data-act], [data-step]');
        if (!target || host.contains(target)) return;
        if (target.dataset.step) {
            const step = Number(target.dataset.step);
            if (step < w.step) { w.step = step; redraw(); }
            return;
        }
        const act = target.dataset.act;
        if (act === 'cancel') {
            e.preventDefault();
            const dirty = w.name || w.members.some(m => m.name);
            if (dirty && !await confirmDialog('Leave without creating this chit? What you typed will be lost.', { confirmLabel: 'Leave' })) return;
            wizard = null;
            location.hash = '#/host-chits';
        } else if (act === 'back') {
            w.step--;
            redraw();
        } else if (act === 'next') {
            const problem = w.step === 1 ? checkDetails(w) : checkMembers(w);
            if (problem) { error(problem); return; }
            w.step++;
            redraw();
        } else if (act === 'create') {
            const problem = checkDetails(w) || checkMembers(w);
            if (problem) { error(problem); return; }
            target.disabled = true;
            try {
                const n = num(w.memberCount);
                const d = await api.post('/hosted-chits', {
                    name: w.name.trim(), startMonth: `${w.startMonth}-01`, dueDay: num(w.dueDay), memberCount: n, months: n,
                    installment: num(w.installment), baseValue: num(w.baseValue), monthlyIncrement: num(w.monthlyIncrement),
                    commission: num(w.commission), postToBooks: w.postToBooks, accountId: w.postToBooks ? w.accountId : null,
                    members: w.members.slice(0, n).map(m => ({ name: m.name.trim(), phone: m.phone.replace(/[\s-]/g, '') || null })),
                });
                wizard = null;
                view.tab = 'month';
                toast(`${d.chit.name} is ready`);
                location.hash = `#/host-chits/${d.chit.id}`;
            } catch (err) {
                error(err.message);
                target.disabled = false;
            }
        }
    });
}

function checkDetails(w) {
    if (!w.name.trim()) return 'Give the chit a name';
    if (!/^\d{4}-\d{2}$/.test(w.startMonth)) return 'Pick the month the chit starts';
    if (!(num(w.dueDay) >= 1 && num(w.dueDay) <= 28)) return 'The payment day must be between 1 and 28';
    if (!(num(w.memberCount) >= 2 && num(w.memberCount) <= 100)) return 'The number of members must be between 2 and 100';
    if (!(num(w.installment) > 0)) return 'Enter how much each member pays a month';
    if (!(num(w.baseValue) > 0)) return 'Enter the chit value for month 1';
    if (num(w.monthlyIncrement) < 0 || num(w.commission) < 0) return 'Amounts cannot be negative';
    if (num(w.commission) >= num(w.baseValue)) return 'Your commission must be less than the chit value';
    return null;
}

function checkMembers(w) {
    const n = num(w.memberCount);
    const list = w.members.slice(0, n);
    const filled = list.filter(m => m.name.trim());
    if (filled.length < n) return `Enter all ${n} names (${filled.length} done so far)`;
    const bad = list.find(m => m.phone.trim() && !/^\d{10}$/.test(m.phone.replace(/[\s-]/g, '')));
    if (bad) return `${bad.name}: the phone number should have 10 digits`;
    const seen = new Set();
    for (const m of list) {
        const key = m.name.trim().toLowerCase();
        if (seen.has(key)) return `Two members are called “${m.name.trim()}”. Add a surname or initial to tell them apart.`;
        seen.add(key);
    }
    return null;
}

function drawDetails(host, w, accounts) {
    const input = (label, key, hint = '', attrs = '', type = 'number') => `<label class="field"><span>${label}</span>
        <input type="${type}" data-k="${key}" value="${esc(w[key] ?? '')}" ${type === 'number' ? 'step="any" min="0" class="num" inputmode="numeric"' : ''} ${attrs}>
        ${hint ? `<small>${hint}</small>` : ''}</label>`;
    const cashLike = a => a.accountClass === 'ASSET' && a.accountType !== 'CHIT_FUND';
    host.innerHTML = `
    <div class="hc-two">
        <div class="hc-col">
            <section class="panel hc-form">
                <header class="panel-head"><h3><span class="ico">${icon('edit')}</span>About the chit</h3></header>
                <div class="panel-body"><div class="form-grid two">
                    <label class="field span-2"><span>Chit name</span><input type="text" data-k="name" value="${esc(w.name)}" placeholder="e.g. Family Chit 2026" maxlength="100"></label>
                    ${input('Starts in', 'startMonth', '', '', 'month')}
                    ${input('Members pay by day', 'dueDay', 'of every month (1–28)', 'min="1" max="28"')}
                </div></div>
            </section>
            <section class="panel hc-form">
                <header class="panel-head"><h3><span class="ico">${icon('coins')}</span>Money</h3></header>
                <div class="panel-body"><div class="form-grid two">
                    ${input('Number of members', 'memberCount', 'The chit runs this many months; each member wins once.', 'min="2" max="100"')}
                    ${input('Each member pays a month', 'installment', '₹ per member')}
                    ${input('Chit value in month 1', 'baseValue', `<span data-base-hint></span>`)}
                    ${input('Chit value goes up each month by', 'monthlyIncrement', 'enter 0 if it stays the same')}
                    ${input('Your commission each month', 'commission', 'you keep this; the winner gets the rest')}
                </div></div>
            </section>
            <details class="hc-advanced" ${w.postToBooks ? 'open' : ''}>
                <summary>${icon('settings')}More options</summary>
                <label class="field check"><input type="checkbox" data-k="postToBooks" ${w.postToBooks ? 'checked' : ''}>
                    <span>Also record this chit's money in my accounts (journal, income, balance sheet)</span></label>
                <label class="field" ${w.postToBooks ? '' : 'hidden'} data-books><span>Money is kept in</span>
                    <select data-k="accountId">${accountOptions(accounts, cashLike, w.accountId, 'Cash in Hand')}</select></label>
                <small class="muted">Leave this off to keep track of the chit only on this page. You can change it later in the chit's settings.</small>
            </details>
        </div>
        <section class="panel hc-preview">
            <header class="panel-head"><h3><span class="ico">${icon('bulb')}</span>How your chit works</h3></header>
            <div class="panel-body" data-preview></div>
        </section>
    </div>`;

    const preview = () => {
        const n = num(w.memberCount);
        const ok = n >= 2 && n <= 100 && /^\d{4}-\d{2}$/.test(w.startMonth);
        host.querySelector('[data-base-hint]').innerHTML = w.baseTouched
            ? `<a href="#" data-base-auto>Use ${money(n * num(w.installment))} (members × amount)</a>`
            : '= members × monthly amount';
        if (!ok) { host.querySelector('[data-preview]').innerHTML = emptyState('Fill in the members and the start month to see how it works', 'calendar'); return; }
        const rows = scheduleOf({ ...w, months: n, dueDay: num(w.dueDay) || 1 });
        const perMonth = n * num(w.installment);
        const net = perMonth * n - rows.reduce((s, r) => s + r.payout, 0);
        const first = rows[0], last = rows.at(-1);
        host.querySelector('[data-preview]').innerHTML = `
            <ul class="hc-explain">
                <li>${icon('users')}<span><b>${n} members</b> each pay <b>${money(w.installment)}</b> every month for <b>${n} months</b>, from ${monthName(w.startMonth + '-01')} to ${monthName(last.dueDate)}.</span></li>
                <li>${icon('arrow-in')}<span>You collect <b>${money(perMonth)}</b> every month.</span></li>
                <li>${icon('crown')}<span>Each month one member wins. The month-1 winner gets <b>${money(first.payout)}</b>, the last winner gets <b>${money(last.payout)}</b>.</span></li>
                <li>${icon('piggy')}<span>You keep <b>${money(w.commission)}</b> a month: <b>${money(num(w.commission) * n)}</b> in total.</span></li>
            </ul>
            ${net < 0 ? `<p class="hc-note warn">${icon('alert')}<span>Careful: over the whole chit you would pay winners <b>${money(-net)}</b> more than you collect, because the chit value rises while the monthly amount stays the same. Lower the monthly increase or raise the monthly amount.</span></p>` : ''}
            <details class="hc-sched-toggle">
                <summary>${icon('calendar')}See all ${n} months</summary>
                ${planTable(rows)}
            </details>`;
    };

    host.addEventListener('input', e => {
        const k = e.target.dataset.k;
        if (!k) return;
        w[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
        if (k === 'baseValue') w.baseTouched = true;
        if ((k === 'memberCount' || k === 'installment') && !w.baseTouched) {
            w.baseValue = num(w.memberCount) * num(w.installment);
            host.querySelector('[data-k="baseValue"]').value = w.baseValue;
        }
        if (k === 'postToBooks') host.querySelector('[data-books]').hidden = !w.postToBooks;
        if (k === 'accountId') w.accountId = e.target.value ? Number(e.target.value) : null;
        preview();
    });
    host.addEventListener('click', e => {
        if (!e.target.closest('[data-base-auto]')) return;
        e.preventDefault();
        w.baseTouched = false;
        w.baseValue = num(w.memberCount) * num(w.installment);
        host.querySelector('[data-k="baseValue"]').value = w.baseValue;
        preview();
    });
    preview();
}

function planTable(rows) {
    return `<div class="hc-table-wrap"><table class="grid compact">
        <thead><tr><th class="c">Month</th><th>Pay by</th><th class="r">Chit value</th><th class="r">Winner gets</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td class="c"><b>${r.monthNo}</b></td><td>${date(r.dueDate)}</td>
            <td class="r">${money(r.chitValue)}</td><td class="r"><b>${money(r.payout)}</b></td></tr>`).join('')}</tbody>
    </table></div>`;
}

function drawMembers(host, w) {
    const n = num(w.memberCount);
    while (w.members.length < n) w.members.push({ name: '', phone: '' });
    w.members.length = n;
    const filled = () => w.members.filter(m => m.name.trim()).length;

    host.innerHTML = `
    <section class="panel hc-members-step">
        <header class="panel-head"><h3><span class="ico">${icon('users')}</span>Who is in the chit?</h3>
            <span class="sub"><span class="hc-count" data-count></span></span></header>
        <div class="panel-body">
            <div class="hc-mem-tools">
                <span class="muted">Type the ${n} names (phone is optional), or:</span>
                <button class="btn sm" data-m="paste">${icon('copy')}Paste a list</button>
                <button class="btn sm" data-m="sample">${icon('sparkles')}Fill example names</button>
                ${filled() ? `<button class="btn sm ghost" data-m="clear">${icon('x')}Clear all</button>` : ''}
            </div>
            <div class="hc-mem-list">${w.members.map((m, i) => `
                <div class="hc-mem-row" data-i="${i}">
                    <span class="hc-slot">${i + 1}</span>
                    <input type="text" data-f="name" value="${esc(m.name)}" placeholder="Name" maxlength="100" autocomplete="off">
                    <input type="tel" data-f="phone" value="${esc(m.phone)}" placeholder="Phone (optional)" inputmode="numeric" maxlength="14" autocomplete="off">
                    <button type="button" class="btn sm ghost icon" data-del title="Remove this name">${icon('x')}</button>
                </div>`).join('')}
            </div>
        </div>
    </section>`;

    const count = () => {
        const f = filled();
        const el = host.querySelector('[data-count]');
        el.textContent = f === n ? `All ${n} members added ✓` : `${f} of ${n} added`;
        el.classList.toggle('ok', f === n);
    };
    const redraw = () => drawMembers(host, w);
    count();

    host.oninput = e => {
        const row = e.target.closest('[data-i]');
        if (!row) return;
        w.members[Number(row.dataset.i)][e.target.dataset.f] = e.target.value;
        count();
    };
    host.onkeydown = e => {
        // Enter in a name box moves to the next name
        if (e.key !== 'Enter' || e.target.dataset.f !== 'name') return;
        e.preventDefault();
        host.querySelector(`[data-i="${Number(e.target.closest('[data-i]').dataset.i) + 1}"] [data-f="name"]`)?.focus();
    };
    host.onclick = e => {
        const del = e.target.closest('[data-del]');
        if (del) {
            w.members.splice(Number(del.closest('[data-i]').dataset.i), 1);
            w.members.push({ name: '', phone: '' });
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

/** "Ravi Kumar 9876543210", "Ravi Kumar, 98765 43210" or just "Ravi Kumar", one per line. */
function parseMemberLines(text) {
    return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
        const match = line.match(/^(.*?)[\s,;:\t-]*((?:\+?91[\s-]?)?\d[\d\s-]{8,}\d)\s*$/);
        if (!match) return { name: line.replace(/^\d+[.)]\s*/, ''), phone: '' };
        return { name: match[1].replace(/^\d+[.)]\s*/, '').trim(), phone: match[2].replace(/\D/g, '').slice(-10) };
    }).filter(m => m.name);
}

function openPasteList(w, done) {
    openModal({
        title: 'Paste a list of members', iconName: 'copy', size: 'lg',
        body: `<p class="muted" style="margin-top:0">One person per line. If a phone number is at the end of the line, it is picked up too.</p>
            <textarea class="hc-paste" name="list" rows="12" placeholder="Ravi Kumar 9876543210&#10;Lakshmi Devi&#10;Suresh Reddy, 9123456780"></textarea>
            <label class="field check"><input type="checkbox" name="replace"><span>Replace the names already entered</span></label>`,
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
                toast(extra > 0 ? `Added ${list.length - extra}. ${plural(extra, 'name')} did not fit (the chit has ${n} members).`
                    : `Added ${plural(list.length, 'name')}`, extra > 0 ? 'info' : 'success');
                done();
            } },
        ],
    });
}

function drawReview(host, w) {
    const n = num(w.memberCount);
    const rows = scheduleOf({ ...w, months: n, dueDay: num(w.dueDay) });
    const row = (label, value) => `<div class="hc-review-row"><span>${label}</span><b>${value}</b></div>`;
    host.innerHTML = `
    <div class="hc-two">
        <section class="panel">
            <header class="panel-head"><h3><span class="ico">${icon('check-circle')}</span>${esc(w.name)}</h3></header>
            <div class="panel-body">
                ${row('Runs', `${monthName(w.startMonth + '-01')} – ${monthName(rows.at(-1).dueDate)} (${n} months)`)}
                ${row('Members pay', `${money(w.installment)} each, by the ${ordinal(num(w.dueDay))} of every month`)}
                ${row('You collect', `${money(n * num(w.installment))} a month`)}
                ${row('Winner gets', `${money(rows[0].payout)} in month 1 → ${money(rows.at(-1).payout)} in month ${n}`)}
                ${row('Your commission', `${money(w.commission)} a month · ${money(num(w.commission) * n)} in total`)}
                ${row('In my accounts', w.postToBooks ? 'Yes, recorded in the journal' : 'No, tracked on this page only')}
                <p class="hc-note">${icon('info')}<span>You can change the amounts later in the chit's settings.</span></p>
            </div>
        </section>
        <section class="panel">
            <header class="panel-head"><h3><span class="ico">${icon('users')}</span>${n} members</h3></header>
            <div class="panel-body"><ol class="hc-review-members">${w.members.slice(0, n).map(m =>
                `<li><span class="hc-avatar sm">${esc(initials(m.name))}</span><b>${esc(m.name)}</b>${m.phone ? `<small>${esc(m.phone)}</small>` : ''}</li>`).join('')}</ol></div>
        </section>
    </div>`;
}

// ===================================================================== one chit

async function renderDetail(container, id, tab, isCurrent) {
    const d = await api.get(`/hosted-chits/${id}`);
    if (!isCurrent()) return;
    if (tab && TABS.some(t => t.key === tab)) view.tab = tab;
    else if (current?.chit.id !== id) view.tab = 'month';
    current = d;
    drawDetail(container, d);
}

/** Saves through the server, then shows the chit as it now is. */
async function apply(container, request, message) {
    const d = await request;
    current = d;
    drawDetail(container, d);
    if (message) toast(message);
    return d;
}

function drawDetail(container, d) {
    const c = d.chit;
    const keepScroll = container.querySelector('#hc-tab')?.scrollTop || 0;
    const done = c.status === 'COMPLETED';
    container.innerHTML = `
    <div class="page hc-page hc-detail">
        <header class="hc-banner">
            <a class="btn sm icon hc-back" href="#/host-chits" title="All my hosted chits">${icon('chevron-left')}</a>
            <div class="min-0 hc-banner-id">
                <div class="hc-title"><b class="ellipsis">${esc(c.name)}</b>${c.demo ? '<span class="badge gray">Example</span>' : ''}</div>
                <div class="hc-meta">${c.memberCount} members · ${money(c.installment)} a month · ${done ? 'finished' : `month ${c.currentMonth} of ${c.months}`}</div>
            </div>
            <div class="hc-banner-actions">
                ${exportButton({ cls: 'sm on-dark', label: 'Download' })}
                ${manage() ? `<button class="btn sm on-dark" data-act="settings">${icon('settings')}Settings</button>` : ''}
            </div>
        </header>
        <div class="hc-tiles four">
            ${tile('arrow-in', 'Collected so far', money(c.totalCollected), `from ${plural(c.memberCount, 'member')}`)}
            ${tile('crown', 'Paid to winners', money(c.totalPaidOut), `${plural(c.completedMonths, 'winner')} paid`)}
            ${tile('piggy', 'My commission', money(c.commissionEarned), `${money(c.commission)} each month`, 'gold')}
            ${tile('alert', 'Still to collect', money(c.pendingDues), c.pendingCount ? `${plural(c.pendingCount, 'payment')} pending` : 'nothing pending', c.pendingCount ? 'warn' : 'good')}
        </div>
        <nav class="tabs hc-tabs" role="tablist">${TABS.map(t =>
            `<button class="tab ${view.tab === t.key ? 'active' : ''}" data-tab="${t.key}" role="tab">${icon(t.iconName)}<span>${t.label}</span></button>`).join('')}</nav>
        <div class="hc-scroll" id="hc-tab"></div>
    </div>`;

    const page = container.querySelector('.hc-page');
    const body = page.querySelector('#hc-tab');
    const drawTab = () => {
        const draw = { month: drawThisMonth, months: drawAllMonths, payments: drawPayments, members: drawMembersTab, history: drawHistory }[view.tab];
        body.innerHTML = draw(d);
    };
    drawTab();
    body.scrollTop = keepScroll;
    bindExport(page, () => exportReport(d));

    page.addEventListener('click', async e => {
        const tabBtn = e.target.closest('[data-tab]');
        if (tabBtn) {
            view.tab = tabBtn.dataset.tab;
            history.replaceState(null, '', `#/host-chits/${c.id}/${view.tab}`);
            page.querySelectorAll('[data-tab]').forEach(t => t.classList.toggle('active', t === tabBtn));
            drawTab();
            body.scrollTop = 0;
            return;
        }
        const el = e.target.closest('[data-act]');
        if (!el) return;
        const act = el.dataset.act;
        const month = el.dataset.month ? d.schedule.find(m => m.monthNo === Number(el.dataset.month)) : null;
        const memberId = Number(el.dataset.member);
        const monthNo = Number(el.dataset.no);
        try {
            if (act === 'settings') openSettings(container, d);
            else if (act === 'goto') page.querySelector(`[data-tab="${el.dataset.to}"]`).click();
            else if (act === 'quick-paid') {
                el.disabled = true;
                const member = d.members.find(m => m.id === memberId);
                const rest = num(c.installment) - paidFor(d, memberId, monthNo);
                await apply(container, api.post(`/hosted-chits/${c.id}/payments`, { memberId, monthNo, amount: rest, mode: 'Cash', paidDate: isoDate() }),
                    `${member.name} paid ${money(rest)} ✓`);
            }
            else if (act === 'pay') openPayment(container, d, memberId, monthNo);
            else if (act === 'collect-all') openCollectAll(container, d, monthNo);
            else if (act === 'winner') openWinner(container, d, month, el.dataset.random === '1');
            else if (act === 'clear-winner') {
                if (!await confirmDialog(`Remove ${month.winnerName} as the winner of month ${month.monthNo}?`, { confirmLabel: 'Remove winner' })) return;
                await apply(container, api.del(`/hosted-chits/${c.id}/months/${month.monthNo}/winner`), 'Winner removed');
            }
            else if (act === 'payout') openPayout(container, d, month);
            else if (act === 'undo-payout') {
                if (!await confirmDialog(`Undo paying ${money(month.payout)} to ${month.winnerName} for month ${month.monthNo}? The month opens again.`, { confirmLabel: 'Undo' })) return;
                await apply(container, api.del(`/hosted-chits/${c.id}/months/${month.monthNo}/payout`), `Month ${month.monthNo} is open again`);
            }
            else if (act === 'edit-payment') {
                const p = d.payments.find(x => x.id === Number(el.dataset.payment));
                openPayment(container, d, p.memberId, p.monthNo, p);
            }
            else if (act === 'undo-payment') undoPayment(container, d, d.payments.find(x => x.id === Number(el.dataset.payment)));
            else if (act === 'edit-member') openMember(container, d, d.members.find(m => m.id === memberId));
            else if (act === 'history-kind') { view.historyKind = el.dataset.kind; drawTab(); }
        } catch (err) {
            el.disabled = false;
            toast(err.message, 'error');
        }
    });
    page.addEventListener('input', e => {
        if (e.target.id !== 'hc-member-search') return;
        view.memberQuery = e.target.value;
        const q = view.memberQuery.trim().toLowerCase();
        page.querySelectorAll('[data-member-row]').forEach(r => { r.hidden = !!q && !r.dataset.memberRow.includes(q); });
    });
}

// ---------------------------------------------------------------- This month: collect → choose winner → pay winner

function drawThisMonth(d) {
    const c = d.chit;
    const month = d.schedule.find(m => m.status === 'ONGOING');
    const canManage = manage();
    const inst = num(c.installment);
    const olderDues = [];
    d.schedule.filter(m => !month || m.monthNo < month.monthNo).forEach(m => d.members.forEach(mem => {
        const rest = inst - paidFor(d, mem.id, m.monthNo);
        if (rest > 0) olderDues.push({ mem, m, rest });
    }));
    const olderHtml = olderDues.length ? `
        <section class="panel hc-older">
            <header class="panel-head"><h3><span class="ico">${icon('alert')}</span>Still owed from earlier months</h3>
                <span class="sub">${money(olderDues.reduce((s, x) => s + x.rest, 0))}</span></header>
            <div class="panel-body flush"><div class="hc-people">${olderDues.map(x => personRow(x.mem, `for month ${x.m.monthNo} (${shortMonth(x.m.dueDate)})`, x.rest, x.m.monthNo, canManage)).join('')}</div></div>
        </section>` : '';

    if (!month) {
        return `<div class="hc-finished">${icon('check-circle')}<h3>This chit is finished</h3>
            <p>All ${c.months} months are done and every member has won once. You earned <b>${money(c.commissionEarned)}</b> in commission.</p></div>${olderHtml}`;
    }

    const rows = d.members.map(m => ({ m, paid: paidFor(d, m.id, month.monthNo) }));
    const unpaid = rows.filter(r => r.paid < inst);
    const paid = rows.filter(r => r.paid >= inst);
    const collected = rows.reduce((s, r) => s + r.paid, 0);
    const expected = inst * d.members.length;
    const step1Done = !unpaid.length;
    const step2Done = !!month.winnerMemberId;
    const late = daysFromToday(month.dueDate) < 0 && !step1Done;

    return `
    <section class="hc-month-intro">
        <div class="min-0">
            <small>Month ${month.monthNo} of ${c.months}</small>
            <h3>${monthName(month.dueDate)}</h3>
            <p>Members pay by <b>${date(month.dueDate)}</b> <span class="${late ? 'neg' : 'muted'}">(${relDays(month.dueDate)})</span></p>
        </div>
        <div class="hc-pot">
            <span><small>Chit value</small><b>${money(month.chitValue)}</b></span>
            <i>−</i>
            <span><small>My commission</small><b class="gold-ink">${money(month.commission)}</b></span>
            <i>=</i>
            <span class="win"><small>Winner gets</small><b>${money(month.payout)}</b></span>
        </div>
    </section>

    <ol class="hc-flow">
        <li class="hc-step ${step1Done ? 'done' : 'active'}">
            <div class="hc-step-head">
                <span class="hc-step-no">${step1Done ? icon('check') : '1'}</span>
                <div class="min-0"><b>Collect ${money(inst)} from each member</b>
                    <small>${paid.length} of ${d.members.length} paid · ${money(collected)} of ${money(expected)}</small></div>
                ${canManage && unpaid.length > 1 ? `<button class="btn sm" data-act="collect-all" data-no="${month.monthNo}">${icon('check-circle')}Everyone has paid</button>` : ''}
            </div>
            ${bar((collected / expected) * 100)}
            ${unpaid.length ? `<h4 class="hc-list-title">Yet to pay · ${unpaid.length}</h4>
                <div class="hc-people">${unpaid.map(r => personRow(r.m, r.paid ? `paid ${money(r.paid)} so far` : (r.m.phone || ''), inst - r.paid, month.monthNo, canManage)).join('')}</div>`
                : `<p class="hc-ok">${icon('check-circle')}Everyone has paid this month.</p>`}
            ${paid.length ? `<details class="hc-paid-list" ${unpaid.length ? '' : 'open'}><summary>Paid · ${paid.length}</summary>
                <div class="hc-people">${paid.map(r => {
                    const last = d.payments.filter(p => p.memberId === r.m.id && p.monthNo === month.monthNo).at(-1);
                    return `<div class="hc-person paid ${canManage ? 'clickable' : ''}" ${canManage ? `data-act="pay" data-member="${r.m.id}" data-no="${month.monthNo}" title="Change or undo"` : ''}>
                        <span class="hc-avatar">${esc(initials(r.m.name))}</span>
                        <div class="min-0"><b class="ellipsis">${esc(r.m.name)}</b><small>${last ? `${date(last.paidDate)} · ${esc(last.mode)}` : ''}</small></div>
                        <span class="hc-paid-amt">${icon('check')}${money(r.paid)}</span>
                    </div>`;
                }).join('')}</div></details>` : ''}
        </li>

        <li class="hc-step ${step2Done ? 'done' : 'active'}">
            <div class="hc-step-head">
                <span class="hc-step-no">${step2Done ? icon('check') : '2'}</span>
                <div class="min-0"><b>Choose this month's winner</b>
                    <small>${step2Done ? (month.drawMethod === 'Random draw' ? 'Picked by random draw' : 'Picked by you') : `${d.members.filter(m => !m.wonMonth).length} members have not won yet`}</small></div>
            </div>
            ${step2Done ? `<div class="hc-winner-box"><span class="hc-avatar gold">${icon('crown')}</span><b>${esc(month.winnerName)}</b>
                    ${canManage ? `<span class="spacer"></span><button class="btn sm ghost" data-act="clear-winner" data-month="${month.monthNo}">Remove</button>
                    <button class="btn sm" data-act="winner" data-month="${month.monthNo}">${icon('refresh')}Change</button>` : ''}</div>`
                : canManage ? `<div class="row wrap hc-step-actions">
                    <button class="btn primary" data-act="winner" data-month="${month.monthNo}">${icon('users')}Pick a member</button>
                    <button class="btn" data-act="winner" data-random="1" data-month="${month.monthNo}">${icon('dice')}Random draw</button></div>` : ''}
        </li>

        <li class="hc-step ${step2Done ? 'active' : 'waiting'}">
            <div class="hc-step-head">
                <span class="hc-step-no">3</span>
                <div class="min-0"><b>Pay the winner</b>
                    <small>${step2Done ? `Give ${money(month.payout)} to ${esc(month.winnerName)}, then mark it done. This closes month ${month.monthNo}.` : 'Choose the winner first'}</small></div>
            </div>
            ${canManage && step2Done ? `<div class="row wrap hc-step-actions"><button class="btn primary" data-act="payout" data-month="${month.monthNo}">${icon('check')}I paid ${money(month.payout)} to ${esc(month.winnerName)}</button>
                ${!step1Done ? `<small class="neg">${plural(unpaid.length, 'member')} still to pay</small>` : ''}</div>` : ''}
        </li>
    </ol>
    ${olderHtml}`;
}

/** A member who owes money: name, a hint, the amount and the buttons to record it. */
function personRow(m, hint, rest, monthNo, canManage) {
    return `<div class="hc-person">
        <span class="hc-avatar">${esc(initials(m.name))}</span>
        <div class="min-0"><b class="ellipsis">${esc(m.name)}</b><small>${esc(hint || '')}</small></div>
        <b class="hc-owe">${money(rest)}</b>
        ${canManage ? `<span class="hc-person-acts"><button class="btn sm ghost" data-act="pay" data-member="${m.id}" data-no="${monthNo}" title="Record a different amount, date or mode">${icon('edit')}<span class="hc-lbl">Other amount</span></button>
            <button class="btn sm primary" data-act="quick-paid" data-member="${m.id}" data-no="${monthNo}" title="Record ${money(rest)} in cash, today">${icon('check')}Paid</button></span>` : ''}
    </div>`;
}

// ---------------------------------------------------------------- all months

function drawAllMonths(d) {
    const c = d.chit;
    const lastDone = c.completedMonths;
    return `<section class="panel">
        <header class="panel-head"><h3><span class="ico">${icon('calendar')}</span>All ${c.months} months</h3>
            <span class="sub">every member pays ${money(c.installment)} a month · you keep ${money(c.commission)} a month</span></header>
        <div class="panel-body flush"><div class="hc-table-wrap"><table class="grid hc-months">
            <thead><tr><th class="c">Month</th><th>Pay by</th><th class="r">Chit value</th><th class="r">Winner gets</th><th>Winner</th><th>Status</th><th></th></tr></thead>
            <tbody>${d.schedule.map(m => `<tr class="${m.status === 'ONGOING' ? 'hc-now' : m.status === 'COMPLETED' ? 'hc-past' : ''}">
                <td class="c"><b>${m.monthNo}</b></td>
                <td>${date(m.dueDate)}</td>
                <td class="r">${money(m.chitValue)}</td>
                <td class="r"><b>${money(m.payout)}</b></td>
                <td>${m.winnerName ? `<span class="hc-winner">${icon('crown')}${esc(m.winnerName)}</span>` : '<span class="muted">—</span>'}</td>
                <td>${statusBadge(m.status)}${m.payoutDate ? `<small class="muted hc-when">paid ${date(m.payoutDate)}</small>` : ''}</td>
                <td class="r">${m.status === 'ONGOING' ? `<button class="btn sm" data-act="goto" data-to="month">Open${icon('chevron-right')}</button>`
                    : manage() && m.status === 'COMPLETED' && m.monthNo === lastDone
                        ? `<button class="btn sm ghost" data-act="undo-payout" data-month="${m.monthNo}" title="Undo the payment to the winner">${icon('undo')}Undo</button>` : ''}</td>
            </tr>`).join('')}</tbody>
        </table></div></div>
    </section>`;
}

// ---------------------------------------------------------------- payments grid

function drawPayments(d) {
    const c = d.chit;
    const inst = num(c.installment);
    return `<section class="panel">
        <header class="panel-head"><h3><span class="ico">${icon('grid')}</span>Who paid which month</h3>
            <span class="sub">${manage() ? 'tap a box to add or change a payment' : ''}</span></header>
        <div class="hc-legend">${Object.entries(CELL).map(([k, [sym, label]]) => `<span><i class="hc-cell ${k.toLowerCase()}">${sym}</i>${label}</span>`).join('')}
            <span><span class="hc-crown">${icon('crown')}</span>Has won</span></div>
        <div class="panel-body flush"><div class="hc-grid-wrap"><table class="hc-grid">
            <thead><tr><th class="hc-name-col">Member</th>${d.schedule.map(m =>
                `<th class="${m.status === 'ONGOING' ? 'now' : ''}" title="Month ${m.monthNo} · pay by ${date(m.dueDate)}">${m.monthNo}<small>${shortMonth(m.dueDate)}</small></th>`).join('')}
                <th class="r">Owes</th></tr></thead>
            <tbody>${d.members.map(mem => `<tr>
                <th class="hc-name-col" title="${esc(mem.name)}${mem.phone ? ' · ' + esc(mem.phone) : ''}">${mem.wonMonth ? `<span class="hc-crown" title="Won month ${mem.wonMonth}">${icon('crown')}</span>` : ''}<span class="ellipsis">${esc(mem.name)}</span></th>
                ${d.schedule.map(m => {
                    const st = cellStatus(d, mem.id, m);
                    const paid = paidFor(d, mem.id, m.monthNo);
                    const [sym, label] = CELL[st];
                    return `<td class="${m.status === 'ONGOING' ? 'now' : ''}"><button type="button" class="hc-cell ${st.toLowerCase()}"
                        ${manage() ? `data-act="pay" data-member="${mem.id}" data-no="${m.monthNo}"` : 'disabled'}
                        title="${esc(mem.name)} · month ${m.monthNo}: ${label}${paid ? ` (${money(paid)} of ${money(inst)})` : ''}">${st === 'PARTIAL' ? moneyShort(paid).replace('₹', '') : sym}</button></td>`;
                }).join('')}
                <td class="r ${num(mem.balanceDue) ? 'neg' : 'muted'}"><b>${num(mem.balanceDue) ? money(mem.balanceDue) : '—'}</b></td>
            </tr>`).join('')}</tbody>
            <tfoot><tr><th class="hc-name-col">Collected</th>${d.schedule.map(m =>
                `<td class="${m.status === 'ONGOING' ? 'now' : ''}" title="${money(m.collected)} of ${money(m.expected)}">${num(m.collected) ? moneyShort(m.collected) : ''}</td>`).join('')}
                <td class="r neg">${num(c.pendingDues) ? money(c.pendingDues) : '—'}</td></tr></tfoot>
        </table></div></div>
    </section>`;
}

// ---------------------------------------------------------------- members

function drawMembersTab(d) {
    const q = view.memberQuery.trim().toLowerCase();
    return `<section class="panel">
        <header class="panel-head"><h3><span class="ico">${icon('users')}</span>${d.members.length} members</h3>
            <span class="sub">${d.members.filter(m => m.wonMonth).length} have won</span>
            <div class="actions"><label class="hc-search">${icon('search')}<input type="search" id="hc-member-search" placeholder="Find a member" value="${esc(view.memberQuery)}"></label></div></header>
        <div class="panel-body flush"><div class="hc-member-cards">${d.members.map(m => {
            const key = (m.name + ' ' + (m.phone || '')).toLowerCase();
            return `<div class="hc-member" data-member-row="${esc(key)}" ${q && !key.includes(q) ? 'hidden' : ''}>
                <span class="hc-avatar ${m.wonMonth ? 'gold' : ''}">${m.wonMonth ? icon('crown') : esc(initials(m.name))}</span>
                <div class="min-0">
                    <b class="ellipsis">${esc(m.name)}</b>
                    <small>${m.phone ? `<a href="tel:${esc(m.phone)}">${esc(m.phone)}</a>` : 'no phone'} · ${m.wonMonth ? `won month ${m.wonMonth}` : 'not won yet'}</small>
                </div>
                <div class="hc-member-money"><small>Paid ${money(m.totalPaid)}</small>
                    ${num(m.balanceDue) ? `<b class="neg">Owes ${money(m.balanceDue)}</b>` : `<b class="pos">Up to date</b>`}</div>
                ${manage() ? `<button class="btn sm ghost icon" data-act="edit-member" data-member="${m.id}" title="Edit name or phone">${icon('edit')}</button>` : ''}
            </div>`;
        }).join('')}</div></div>
    </section>`;
}

// ---------------------------------------------------------------- history

function drawHistory(d) {
    const kinds = [['ALL', 'Everything'], ['IN', 'Money in'], ['OUT', 'Money out']];
    const rows = d.ledger.filter(r => view.historyKind === 'ALL' || (view.historyKind === 'IN' ? r.kind === 'COLLECTION' : r.kind !== 'COLLECTION'))
        .slice().reverse();
    const canManage = manage();
    const what = r => r.kind === 'COLLECTION' ? `<b>${esc(r.party)}</b> paid for month ${r.monthNo}`
        : r.kind === 'PAYOUT' ? `Paid winner <b>${esc(r.party)}</b> (month ${r.monthNo})` : `My commission (month ${r.monthNo})`;
    return `<section class="panel">
        <header class="panel-head"><h3><span class="ico">${icon('history')}</span>History</h3><span class="sub">newest first</span>
            <div class="actions"><div class="seg-chips sm">${kinds.map(([k, label]) =>
                `<button class="seg-chip ${view.historyKind === k ? 'active' : ''}" data-act="history-kind" data-kind="${k}">${label}</button>`).join('')}</div></div></header>
        <div class="panel-body flush">${rows.length ? `<div class="hc-table-wrap"><table class="grid hc-history">
            <thead><tr><th>Date</th><th>What happened</th><th>How</th><th class="r">Amount</th><th class="r" title="Collected minus paid out, after this entry">Money with you</th>${canManage ? '<th></th>' : ''}</tr></thead>
            <tbody>${rows.map(r => {
                const isIn = num(r.moneyIn) > 0;
                const tone = r.kind === 'COLLECTION' ? 'aqua' : r.kind === 'PAYOUT' ? 'gold' : 'violet';
                const ico = r.kind === 'COLLECTION' ? 'arrow-in' : r.kind === 'PAYOUT' ? 'crown' : 'piggy';
                return `<tr>
                    <td class="hc-nowrap">${date(r.date)}</td>
                    <td><span class="hc-kind"><span class="chip-icon sm ${tone}">${icon(ico)}</span><span>${what(r)}${r.note ? `<small class="muted hc-sub-note">${esc(r.note)}</small>` : ''}</span></span></td>
                    <td>${esc(r.mode || '—')}</td>
                    <td class="r hc-nowrap"><b class="${isIn ? 'pos' : 'neg'}">${isIn ? '+' : '−'}${money(isIn ? r.moneyIn : r.moneyOut)}</b></td>
                    <td class="r hc-nowrap muted">${money(r.held)}</td>
                    ${canManage ? `<td class="r hc-nowrap">${r.paymentId ? `<button class="btn sm ghost icon" data-act="edit-payment" data-payment="${r.paymentId}" title="Change this payment">${icon('edit')}</button>
                        <button class="btn sm ghost icon" data-act="undo-payment" data-payment="${r.paymentId}" title="Undo this payment">${icon('undo')}</button>` : ''}</td>` : ''}
                </tr>`;
            }).join('')}</tbody>
        </table></div>` : emptyState('Nothing recorded yet', 'history')}</div>
    </section>`;
}

// ===================================================================== dialogs

/** A member's payment for one month: what is paid so far (change / undo) and a new or changed payment. */
function openPayment(container, d, memberId, monthNo, editing = null) {
    const c = d.chit;
    const member = d.members.find(m => m.id === memberId);
    const month = d.schedule.find(m => m.monthNo === monthNo);
    const inst = num(c.installment);
    const list = d.payments.filter(p => p.memberId === memberId && p.monthNo === monthNo);
    const paid = list.reduce((s, p) => s + num(p.amount), 0);
    const balance = Math.max(0, inst - paid);
    const amount = editing ? num(editing.amount) : balance || inst;
    openModal({
        title: `${member.name} · month ${monthNo}`, iconName: 'hand-coins',
        body: `
        <div class="hc-pay-sum">
            <span><small>Should pay</small><b>${money(inst)}</b></span>
            <span><small>Paid</small><b class="pos">${money(paid)}</b></span>
            <span><small>Still owes</small><b class="${balance ? 'neg' : 'pos'}">${balance ? money(balance) : 'Nothing'}</b></span>
        </div>
        <p class="muted hc-small" style="margin:0 0 8px">Pay by ${date(month.dueDate)}</p>
        ${list.length ? `<h4 class="hc-sub">Payments received</h4><div class="hc-pay-list">${list.map(p => `<div class="hc-pay-row ${editing?.id === p.id ? 'editing' : ''}">
            <span class="chip-icon sm aqua">${icon('check')}</span>
            <div class="min-0"><b>${money(p.amount)}</b><small>${date(p.paidDate)} · ${esc(p.mode)}${p.note ? ' · ' + esc(p.note) : ''}</small></div>
            <button type="button" class="btn sm ghost" data-pay-edit="${p.id}">${icon('edit')}Change</button>
            <button type="button" class="btn sm ghost" data-pay-undo="${p.id}">${icon('undo')}Undo</button>
        </div>`).join('')}</div>` : ''}
        <form class="form-grid two hc-pay-form">
            <h4 class="hc-sub span-2">${editing ? `Change the payment of ${date(editing.paidDate)}` : balance ? 'Record a payment' : 'Record an extra payment'}</h4>
            <label class="field"><span>Amount (₹)</span><input type="number" name="amount" step="any" min="0" class="num" data-type="number" inputmode="numeric" value="${amount}" required></label>
            <label class="field"><span>Date</span><input type="date" name="paidDate" value="${editing ? editing.paidDate : isoDate()}"></label>
            <label class="field span-2"><span>Paid by</span>${modeChips(editing?.mode || 'Cash')}</label>
            <label class="field span-2"><span>Note (optional)</span><input type="text" name="note" maxlength="255" value="${esc(editing?.note || '')}" placeholder="e.g. UPI reference"></label>
        </form>`,
        actions: [
            { label: 'Cancel' },
            { label: editing ? 'Save change' : 'Save payment', kind: 'primary', iconName: 'check', onClick: async modal => {
                const form = modal.el.querySelector('form');
                const value = Number(form.amount.value);
                if (!(value > 0)) throw new Error('Enter the amount received');
                const others = paidFor(d, memberId, monthNo, editing?.id ?? null);
                let allowExcess = false;
                if (others + value > inst) {
                    allowExcess = await confirmDialog(`With this, ${member.name} will have paid ${money(others + value)} for month ${monthNo}, which is more than ${money(inst)}. Save anyway?`,
                        { title: 'More than the monthly amount', confirmLabel: 'Save anyway', danger: false });
                    if (!allowExcess) return true;
                }
                const body = { memberId, monthNo, amount: value, paidDate: form.paidDate.value || null, mode: chosenMode(modal.el),
                    note: form.note.value.trim() || null, allowExcess, version: editing?.version };
                await apply(container, editing ? api.put(`/hosted-chits/${c.id}/payments/${editing.id}`, body) : api.post(`/hosted-chits/${c.id}/payments`, body),
                    editing ? 'Payment changed' : `${member.name} paid ${money(value)} ✓`);
            } },
        ],
        onOpen: modal => {
            bindModeChips(modal.el);
            modal.el.addEventListener('click', e => {
                const edit = e.target.closest('[data-pay-edit]');
                const undo = e.target.closest('[data-pay-undo]');
                if (edit) {
                    modal.close();
                    openPayment(container, current, memberId, monthNo, current.payments.find(p => p.id === Number(edit.dataset.payEdit)));
                } else if (undo) {
                    modal.close();
                    undoPayment(container, current, current.payments.find(p => p.id === Number(undo.dataset.payUndo)));
                }
            });
        },
    });
}

async function undoPayment(container, d, p) {
    if (!p) return;
    if (!await confirmDialog(`Undo the ${money(p.amount)} that ${p.memberName} paid on ${date(p.paidDate)} for month ${p.monthNo}?`, { confirmLabel: 'Undo payment' })) return;
    try {
        await apply(container, api.del(`/hosted-chits/${d.chit.id}/payments/${p.id}`), 'Payment undone');
    } catch (err) {
        toast(err.message, 'error');
    }
}

function openCollectAll(container, d, monthNo) {
    const c = d.chit;
    const inst = num(c.installment);
    const owing = d.members.map(m => ({ m, rest: inst - paidFor(d, m.id, monthNo) })).filter(x => x.rest > 0);
    if (!owing.length) { toast(`Everyone has paid month ${monthNo}`, 'info'); return; }
    const total = owing.reduce((s, x) => s + x.rest, 0);
    openModal({
        title: `Everyone has paid month ${monthNo}`, iconName: 'check-circle',
        body: `<p style="margin-top:0">This records <b>${money(total)}</b> from the <b>${plural(owing.length, 'member')}</b> who have not paid yet:</p>
            <p class="muted hc-owing">${owing.map(x => esc(x.m.name)).join(', ')}</p>
            <form class="form-grid two">
                <label class="field"><span>Date</span><input type="date" name="paidDate" value="${isoDate()}"></label>
                <label class="field"><span>Paid by</span>${modeChips()}</label>
            </form>`,
        actions: [
            { label: 'Cancel' },
            { label: `Mark ${owing.length} as paid`, kind: 'primary', iconName: 'check', onClick: modal =>
                apply(container, api.post(`/hosted-chits/${c.id}/months/${monthNo}/collect-all`,
                    { paidDate: modal.el.querySelector('[name=paidDate]').value || null, mode: chosenMode(modal.el) }),
                    `${plural(owing.length, 'payment')} recorded`).then(() => {}) },
        ],
        onOpen: modal => bindModeChips(modal.el),
    });
}

function openWinner(container, d, month, autoDraw = false) {
    const eligible = d.members.filter(m => !m.wonMonth || m.wonMonth === month.monthNo);
    let random = false;
    openModal({
        title: `Winner of month ${month.monthNo}`, iconName: 'crown',
        body: `
        <div class="hc-draw" data-draw>${month.winnerName ? `${icon('crown')}<b>${esc(month.winnerName)}</b>` : `<span>Who wins <b>${money(month.payout)}</b> this month?</span>`}</div>
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
                await apply(container, api.post(`/hosted-chits/${d.chit.id}/months/${month.monthNo}/winner`, { memberId: id, random }),
                    `${name} wins month ${month.monthNo}`);
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

function openPayout(container, d, month) {
    const c = d.chit;
    const inst = num(c.installment);
    const owing = d.members.map(m => ({ m, rest: inst - paidFor(d, m.id, month.monthNo) })).filter(x => x.rest > 0);
    const dues = owing.reduce((s, x) => s + x.rest, 0);
    openModal({
        title: `Pay the winner of month ${month.monthNo}`, iconName: 'crown',
        body: `
        <div class="hc-draw">${icon('crown')}<b>${esc(month.winnerName)}</b><small>gets ${money(month.payout)}</small></div>
        <div class="hc-pay-sum">
            <span><small>Chit value</small><b>${money(month.chitValue)}</b></span>
            <span><small>My commission</small><b class="gold-ink">${money(month.commission)}</b></span>
            <span><small>Winner gets</small><b class="pos">${money(month.payout)}</b></span>
        </div>
        ${dues ? `<p class="hc-note warn">${icon('alert')}<span>${plural(owing.length, 'member')} still ${owing.length === 1 ? 'owes' : 'owe'} <b>${money(dues)}</b> for this month (${owing.map(x => esc(x.m.name)).join(', ')}). You can still collect it later.</span></p>` : ''}
        <form class="form-grid two">
            <label class="field"><span>Paid on</span><input type="date" name="payoutDate" value="${isoDate()}"></label>
            <label class="field"><span>Paid by</span>${modeChips()}</label>
        </form>
        <p class="muted hc-small">${icon('lock')}After this, month ${month.monthNo} is closed and the winner can't be changed. You can undo it from “All months” if needed.</p>`,
        actions: [
            { label: 'Cancel' },
            { label: 'Yes, winner is paid', kind: 'primary', iconName: 'check', onClick: async modal => {
                let allowDues = false;
                if (dues) {
                    allowDues = await confirmDialog(`${money(dues)} is still owed for month ${month.monthNo}. Close the month anyway? You can collect it later.`,
                        { title: 'Some members have not paid', confirmLabel: 'Close the month' });
                    if (!allowDues) return true;
                }
                await apply(container, api.post(`/hosted-chits/${c.id}/months/${month.monthNo}/payout`,
                    { payoutDate: modal.el.querySelector('[name=payoutDate]').value || null, mode: chosenMode(modal.el), allowDues }),
                    `Month ${month.monthNo} done: ${month.winnerName} paid`);
            } },
        ],
        onOpen: modal => bindModeChips(modal.el),
    });
}

function openMember(container, d, m) {
    openModal({
        title: 'Edit member', iconName: 'user',
        body: `<form class="form-grid one">
            <label class="field"><span>Name</span><input type="text" name="name" value="${esc(m.name)}" maxlength="100" required></label>
            <label class="field"><span>Phone</span><input type="tel" name="phone" value="${esc(m.phone || '')}" inputmode="numeric" maxlength="14" placeholder="10 digits"></label>
        </form>`,
        actions: [
            { label: 'Cancel' },
            { label: 'Save', kind: 'primary', iconName: 'check', onClick: async modal => {
                const name = modal.el.querySelector('[name=name]').value.trim();
                const phone = modal.el.querySelector('[name=phone]').value.replace(/[\s-]/g, '');
                if (!name) throw new Error('Enter the name');
                if (phone && !/^\d{10}$/.test(phone)) throw new Error('The phone number should have 10 digits');
                if (d.members.some(x => x.id !== m.id && x.name.trim().toLowerCase() === name.toLowerCase())) throw new Error(`Another member is already called ${name}`);
                await apply(container, api.put(`/hosted-chits/${d.chit.id}/members/${m.id}`, { name, phone: phone || null }), 'Saved');
            } },
        ],
    });
}

async function openSettings(container, d) {
    const c = d.chit;
    const accounts = await loadAccounts().catch(() => []);
    const cashLike = a => a.accountClass === 'ASSET' && a.accountType !== 'CHIT_FUND';
    const locked = c.structureLocked;
    const f = (label, name, value, hint = '', attrs = '') => `<label class="field"><span>${label}</span>
        <input type="number" name="${name}" value="${value}" step="any" min="0" class="num" data-type="number" ${attrs}>${hint ? `<small>${hint}</small>` : ''}</label>`;
    openModal({
        title: 'Chit settings', iconName: 'settings', size: 'lg',
        body: `<form class="form-grid two">
            <label class="field span-2"><span>Chit name</span><input type="text" name="name" value="${esc(c.name)}" maxlength="100" required></label>
            <label class="field"><span>Starts in</span><input type="month" name="startMonth" value="${c.startMonth.slice(0, 7)}" ${locked ? 'disabled' : ''}>
                ${locked ? '<small>can’t change after payments are recorded</small>' : ''}</label>
            ${f('Members pay by day', 'dueDay', c.dueDay, 'of every month', 'min="1" max="28"')}
            ${f('Each member pays a month', 'installment', num(c.installment))}
            ${f('Chit value in month 1', 'baseValue', num(c.baseValue))}
            ${f('Chit value goes up each month by', 'monthlyIncrement', num(c.monthlyIncrement))}
            ${f('Your commission each month', 'commission', num(c.commission), 'finished months keep their amounts')}
            <label class="field span-2"><span>Notes</span><input type="text" name="notes" value="${esc(c.notes || '')}" maxlength="255"></label>
            <div class="span-2 hc-advanced-box">
                <label class="field check"><input type="checkbox" name="postToBooks" ${c.postToBooks ? 'checked' : ''}><span>Also record this chit's money in my accounts (journal, income, balance sheet)</span></label>
                <label class="field" data-books ${c.postToBooks ? '' : 'hidden'}><span>Money is kept in</span>
                    <select name="accountId">${accountOptions(accounts, cashLike, c.accountId, 'Cash in Hand')}</select></label>
                <small class="muted">This applies to payments recorded from now on.</small>
            </div>
            <p class="muted hc-small span-2">The number of members (${c.memberCount}) can’t be changed. To change it, delete this chit and host a new one.</p>
        </form>`,
        actions: [
            { label: 'Delete chit', kind: 'danger', left: true, iconName: 'trash', onClick: async () => {
                if (!await confirmDialog(`Delete “${c.name}” with all its members and payments? This can't be undone.`, { confirmLabel: 'Delete chit' })) return true;
                await api.del(`/hosted-chits/${c.id}`);
                toast(`${c.name} deleted`);
                location.hash = '#/host-chits';
            } },
            { label: 'Cancel' },
            { label: 'Save', kind: 'primary', iconName: 'check', onClick: async modal => {
                const form = modal.el.querySelector('form');
                const v = name => form[name].value;
                if (!v('name').trim()) throw new Error('Give the chit a name');
                await apply(container, api.put(`/hosted-chits/${c.id}`, {
                    name: v('name').trim(), startMonth: `${locked ? c.startMonth.slice(0, 7) : v('startMonth')}-01`, dueDay: Number(v('dueDay')),
                    memberCount: c.memberCount, months: c.months, installment: Number(v('installment')), baseValue: Number(v('baseValue')),
                    monthlyIncrement: Number(v('monthlyIncrement')), commission: Number(v('commission')), notes: v('notes').trim() || null,
                    postToBooks: form.postToBooks.checked, accountId: form.accountId.value ? Number(form.accountId.value) : null, version: c.version,
                }), 'Settings saved');
            } },
        ],
        onOpen: modal => {
            const form = modal.el.querySelector('form');
            form.postToBooks.addEventListener('change', () => { form.querySelector('[data-books]').hidden = !form.postToBooks.checked; });
        },
    });
}

// ===================================================================== download

/** All months, the payments grid, members and history; the tab on screen comes first (CSV takes the first). */
function exportReport(d) {
    const c = d.chit;
    const months = {
        name: 'All months',
        columns: [{ label: 'Month', type: 'number' }, { label: 'Pay by', type: 'date' }, { label: 'Monthly amount', type: 'money' },
            { label: 'Chit value', type: 'money' }, { label: 'Winner gets', type: 'money' }, { label: 'My commission', type: 'money' },
            { label: 'Collected', type: 'money' }, { label: 'Winner' }, { label: 'Status' }, { label: 'Winner paid on', type: 'date' }],
        rows: d.schedule.map(m => [m.monthNo, m.dueDate, num(m.installment), num(m.chitValue), num(m.payout), num(m.commission),
            num(m.collected), m.winnerName || '', STATUS[m.status]?.[2] || m.status, m.payoutDate || '']),
        totals: ['Total', '', '', d.schedule.reduce((s, m) => s + num(m.chitValue), 0), d.schedule.reduce((s, m) => s + num(m.payout), 0),
            d.schedule.reduce((s, m) => s + num(m.commission), 0), d.schedule.reduce((s, m) => s + num(m.collected), 0), '', '', ''],
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
    const kindLabel = { COLLECTION: 'Member paid', PAYOUT: 'Paid winner', COMMISSION: 'My commission' };
    const history = {
        name: 'History',
        columns: [{ label: 'Date', type: 'date' }, { label: 'What' }, { label: 'Month', type: 'number' }, { label: 'Member' }, { label: 'How' },
            { label: 'Money in', type: 'money' }, { label: 'Money out', type: 'money' }, { label: 'Money with you', type: 'money' }, { label: 'Note' }],
        rows: d.ledger.map(r => [r.date, kindLabel[r.kind], r.monthNo, r.kind === 'COMMISSION' ? '' : r.party || '', r.mode || '',
            num(r.moneyIn) || '', num(r.moneyOut) || '', num(r.held), r.note || '']),
    };
    const order = { payments: [grid, months, members, history], members: [members, grid, months, history],
        history: [history, months, grid, members] }[view.tab] || [months, grid, members, history];
    return {
        title: c.name,
        subtitle: `${c.memberCount} members · ${money(c.installment)} a month · from ${monthName(c.startMonth)}`,
        filename: `chit-${c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
        summary: [['Collected so far', money(c.totalCollected)], ['Paid to winners', money(c.totalPaidOut)],
            ['My commission', money(c.commissionEarned)], ['Still to collect', money(c.pendingDues)]],
        sheets: order,
    };
}
