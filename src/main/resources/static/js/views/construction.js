/**
 * Construction: the builder's business. Contract works (building on an owner's site for a stage-wise price, with
 * extra works and late interest) and developments (an apartment project on an own plot or under a joint development
 * agreement, its flats sold to buyers on payment plans), each with its own books, partners, loans and agreements.
 *
 *   #/construction            the projects, and the selected one
 *   #/construction/<id>/<tab> a project and a tab
 *   #/construction/new        start a project
 */
import { api } from '../core/api.js';
import { can, invalidateAccounts } from '../core/store.js';
import { esc, toast, panel, emptyState, confirmDialog } from '../core/ui.js';
import { icon } from '../core/icons.js';
import { money, moneyShort, date, shortDate, daysFromToday } from '../core/format.js';
import { setPageKeys, listNavigator } from '../core/keys.js';
import { openWizard, openSettings, openStage, openStageDone, openExtra, openReceipt, printReceipt, openCost, openPartner, openShares, openCapital,
    openLoan, openLoanTxn, openParty, openUnits, openUnit, openTransfer, openCommonAccount, openStatus, confirmDelete, num, headName, HEAD_ICONS } from '../components/construction-forms.js';
import { openBook, openSale, DUE_TONE } from '../components/construction-sale.js';
import { openProjectAgreement, AGREEMENT_KINDS } from '../components/construction-agreement.js';

const view = { selectedId: null, tab: 'overview', costHead: null };
const manage = () => can('MANAGE_PROJECTS');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const STATUS = { PLANNING: ['gray', 'Planning'], ACTIVE: ['aqua', 'Running'], COMPLETED: ['good', 'Completed'], CLOSED: ['gray', 'Closed'] };
const STAGE = { PENDING: ['gray', 'Not started', 'clock'], IN_PROGRESS: ['warning', 'In progress', 'play'], DONE: ['good', 'Done', 'check'] };
const EXTRA = { PROPOSED: ['warning', 'Proposed'], AGREED: ['aqua', 'Agreed'], DONE: ['good', 'Done'], CANCELLED: ['gray', 'Cancelled'] };
const UNIT = { AVAILABLE: ['avail', 'Available'], BOOKED: ['booked', 'Booked'], SOLD: ['sold', 'Sold'], HANDED_OVER: ['handed', 'Handed over'], LANDOWNER: ['owner', 'Landowner’s'] };
const ROLE = { BANK: 'Bank', COST: 'Construction cost', LAND: 'Land', ADVANCES: 'Received (advances)', INTEREST: 'Late interest received', PROFIT: 'My profit',
    LOAN: 'Loan', CAPITAL: 'Partner capital', COMMON: 'Common' };
const kindName = p => p.kind === 'CONTRACT' ? 'Contract work' : p.landMode === 'JOINT' ? 'Joint development' : 'Own plot development';
const kindIcon = p => p.kind === 'CONTRACT' ? 'hard-hat' : p.landMode === 'JOINT' ? 'layers' : 'building';
const tabsOf = p => p.kind === 'CONTRACT'
    ? [['overview', 'Overview', 'dashboard'], ['stages', 'Work & payments', 'layers'], ['extras', 'Extra works', 'plus'], ['receipts', 'Receipts', 'arrow-in'],
        ['costs', 'Costs', 'receipt'], ['partners', 'Partners', 'users'], ['loans', 'Loans', 'bank'], ['agreements', 'Agreements', 'file-text'], ['accounts', 'Accounts', 'wallet']]
    : [['overview', 'Overview', 'dashboard'], ['flats', 'Flats & sales', 'grid'], ['land', 'Land', 'home'], ['stages', 'Construction', 'layers'],
        ['receipts', 'Receipts', 'arrow-in'], ['costs', 'Costs', 'receipt'], ['partners', 'Partners', 'users'], ['loans', 'Loans', 'bank'],
        ['agreements', 'Agreements', 'file-text'], ['accounts', 'Accounts', 'wallet']];

let current = null;

export async function render(container, params, isCurrent) {
    const overview = await api.get('/construction');
    if (!isCurrent()) return;
    const [first, second] = params;
    if (/^\d+$/.test(first || '')) view.selectedId = Number(first);
    if (second) view.tab = second;
    if (!overview.projects.some(p => p.id === view.selectedId)) view.selectedId = overview.projects[0]?.id ?? null;

    container.innerHTML = `
    <div class="page chits-page cn-page">
        <section class="cp-card cn-brand" id="cn-brand"></section>
        <div class="cs-cards" id="cn-cards"></div>
        ${panel({
            title: 'Projects', iconName: 'hard-hat', cls: 'p-chit-list', bodyClass: 'flush',
            sub: `${overview.projects.filter(p => p.status !== 'CLOSED').length} running`,
            actions: manage() ? `<button class="btn sm primary icon hc-add" id="cn-new" title="Start a project" aria-label="Start a project">${icon('plus')}</button>` : '',
            body: `<div class="chit-rows scroll" id="cn-list" tabindex="0"></div>`,
        })}
        <div class="chit-detail" id="cn-detail"></div>
    </div>`;
    drawPortfolio(container, overview);
    container.querySelector('#cn-new')?.addEventListener('click', () => openWizard((d, m) => afterChange(d, m, true)));
    const listEl = container.querySelector('#cn-list');
    listEl.addEventListener('click', e => {
        const row = e.target.closest('[data-id]');
        if (row) show(Number(row.dataset.id));
    });
    container.querySelector('#cn-brand').addEventListener('click', e => {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        if (b.dataset.act === 'new') openWizard((d, m) => afterChange(d, m, true));
        if (b.dataset.act === 'common') openCommonAccount(async (_, m) => { toast(m); invalidateAccounts(); drawPortfolio(container, await api.get('/construction')); });
    });
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

    async function show(id) {
        view.selectedId = id;
        listEl.querySelectorAll('[data-id]').forEach(el => el.classList.toggle('selected', Number(el.dataset.id) === id));
        const d = await api.get(`/construction/${id}`);
        if (view.selectedId !== id) return;
        if (!tabsOf(d.project).some(([k]) => k === view.tab)) view.tab = 'overview';
        history.replaceState(null, '', `#/construction/${id}/${view.tab}`);
        current = d;
        drawDetail(container, d);
    }
    if (first === 'new' && manage()) openWizard((d, m) => afterChange(d, m, true));
    if (view.selectedId) await show(view.selectedId);
    else container.querySelector('#cn-detail').innerHTML = welcomeHtml();
    container.querySelector('#cn-detail').addEventListener('click', e => {
        if (e.target.closest('[data-act="welcome-new"]')) openWizard((d, m) => afterChange(d, m, true));
    });
}

/** After a change: the project as the server returned it, and fresh figures for the list. */
async function afterChange(d, message, select = false) {
    invalidateAccounts();
    const container = document.querySelector('.cn-page')?.parentElement;
    if (!container) return;
    if (d) {
        current = d;
        if (select) { view.selectedId = d.project.id; view.tab = 'overview'; history.replaceState(null, '', `#/construction/${d.project.id}/overview`); }
        drawDetail(container, d);
    }
    if (message) toast(message);
    try {
        drawPortfolio(container, await api.get('/construction'));
    } catch { /* the detail is already right */ }
}

function welcomeHtml() {
    return panel({ title: 'Construction', iconName: 'hard-hat', body: `
        <div class="hc-welcome">
            <span class="hc-welcome-ico">${icon('hard-hat')}</span>
            <h3>Run your construction business here</h3>
            <p><b>Contract works</b>: build on an owner's site for an agreed, stage-wise price, with extra works, late interest and a proper construction agreement.
                <b>Developments</b>: your own apartment project on a plot you buy or under a joint development agreement, with flats, buyers, home loans,
                registration and handover. Every project keeps its own accounts, partners and loans.</p>
            ${manage() ? `<div class="row wrap"><button class="btn primary" data-act="welcome-new">${icon('plus')}Start a project</button></div>` : ''}
        </div>` });
}

// ===================================================================== the portfolio and the list

function drawPortfolio(container, o) {
    const running = o.projects.filter(p => p.status !== 'CLOSED');
    const sum = (list, k) => list.reduce((s, p) => s + num(p.figures[k]), 0);
    container.querySelector('#cn-brand').innerHTML = `
        <div class="cp-head"><span class="cp-mark">${icon('hard-hat')}</span>
            <div class="min-0"><small>Construction business</small><b>${moneyShort(o.moneyBalance)} <em>in its accounts</em></b></div>
            <span class="cp-rate" title="Received so far across the projects">${moneyShort(o.received)}<small>received</small></span></div>
        <div class="cp-foot">
            <span class="cp-pill run">${icon('play')}${running.length} running</span>
            ${o.projects.length - running.length ? `<span class="cp-pill done">${icon('lock')}${o.projects.length - running.length} closed</span>` : ''}
            ${o.commonAccounts.length ? `<span class="cp-pill done" title="${esc(o.commonAccounts.map(a => `${a.name}: ${money(a.balance)}`).join('\n'))}">${icon('bank')}${plural(o.commonAccounts.length, 'common account')}</span>` : ''}
            ${manage() ? `<button type="button" class="cp-pill done cn-pill-btn" data-act="common" title="A bank account or cash shared by every project">${icon('plus')}Common account</button>` : ''}
        </div>`;
    const cell = (iconName, label, value, sub, cls = '') => `<div class="ov-card cs-card ${cls}"><span class="ov-ico">${icon(iconName)}</span>
        <div class="min-0"><span class="ov-label">${label}</span><b>${value}</b><small>${sub}</small></div></div>`;
    container.querySelector('#cn-cards').innerHTML = `
        ${o.overdue ? cell('alert', 'Overdue', `<span class="down">${moneyShort(o.overdue)}</span>`, `of ${moneyShort(o.due)} due`, 'warn') : cell('check-circle', 'Due now', moneyShort(o.due), 'nothing overdue', 'good')}
        ${cell('arrow-in', 'Received', moneyShort(o.received), 'from owners and buyers')}
        ${cell('receipt', 'Spent', moneyShort(o.costs), 'costs and land')}
        ${cell('trending', 'So far', `<span class="${num(o.received) - num(o.costs) >= 0 ? 'gold' : 'down'}">${moneyShort(num(o.received) - num(o.costs))}</span>`, 'received less spent', 'highlight')}
        ${cell('bank', 'Loans', moneyShort(o.loanOutstanding), 'outstanding')}
        ${cell('grid', 'Flats', `${sum(running, 'unitsSold')}<small> / ${sum(running, 'unitsTotal')}</small>`, `${sum(running, 'unitsBooked')} booked · ${sum(running, 'unitsAvailable')} available`)}`;
    const listEl = container.querySelector('#cn-list');
    const row = s => {
        const f = s.figures;
        const closed = s.status === 'CLOSED';
        const dev = s.kind === 'DEVELOPMENT';
        const pct = dev ? (f.unitsTotal ? Math.round((f.unitsSold + f.unitsBooked) * 100 / Math.max(1, f.unitsTotal - f.unitsLandowner)) : 0) : f.progressPercent;
        return `<div class="acct-item rich chit-item accent-${closed ? 'slate' : dev ? 'aqua' : 'gold'} ${s.id === view.selectedId ? 'selected' : ''}" data-id="${s.id}">
            <span class="chip-icon sm ${dev ? 'aqua' : 'gold'}">${icon(kindIcon(s))}</span>
            <div class="acct-main">
                <div class="acct-line"><span class="acct-name">${esc(s.name)}</span><b class="acct-bal" title="${dev ? 'Sales value' : 'Contract value with extras'}">${moneyShort(f.totalValue)}</b></div>
                <div class="acct-line sub"><span class="acct-meta">${esc(kindName(s))}${s.clientName ? ` · ${esc(s.clientName)}` : s.city ? ` · ${esc(s.city)}` : ''}</span>
                    <span class="acct-facts">${num(f.overdue) ? `<span class="fact bad" title="Overdue">${moneyShort(f.overdue)} late</span>` : num(f.due) ? `<span class="fact warn">${moneyShort(f.due)} due</span>` : '<span class="fact good">nothing due</span>'}</span></div>
                <div class="chit-prog"><div class="acct-util good"><span style="width:${pct}%"></span></div>
                    <small>${closed ? `${icon('lock')}closed` : dev ? `${f.unitsSold + f.unitsBooked} of ${Math.max(0, f.unitsTotal - f.unitsLandowner)} flats sold` : `${f.progressPercent}% built`}</small></div>
            </div></div>`;
    };
    const groups = [['Contract works', o.projects.filter(p => p.kind === 'CONTRACT' && p.status !== 'CLOSED')],
        ['Developments', o.projects.filter(p => p.kind === 'DEVELOPMENT' && p.status !== 'CLOSED')], ['Closed', o.projects.filter(p => p.status === 'CLOSED')]];
    listEl.innerHTML = o.projects.length ? groups.filter(([, l]) => l.length).map(([label, l]) =>
        `<div class="group-label"><span>${label} <i>${l.length}</i></span><b>${moneyShort(l.reduce((s, p) => s + num(p.figures.totalValue), 0))}</b></div>${l.map(row).join('')}`).join('')
        : emptyState('No projects yet', 'hard-hat');
}

// ===================================================================== the selected project

function keyTile(ic, label, value, sub, cls = '') {
    return `<div class="ck-tile ${cls}"><span class="ck-icon">${icon(ic)}</span>
        <div class="min-0 grow"><small>${esc(label)}</small><b>${value}</b><span class="ck-note">${sub}</span></div></div>`;
}

function drawDetail(container, d) {
    const old = container.querySelector('#cn-detail');
    const keepScroll = old.querySelector('#cn-tab')?.scrollTop || 0;
    const target = old.cloneNode(false);
    old.replaceWith(target);
    const p = d.project;
    const f = d.figures;
    const dev = p.kind === 'DEVELOPMENT';
    const closed = p.status === 'CLOSED';
    const [tone, label] = STATUS[p.status] || ['gray', p.status];
    const days = f.daysLeft;
    const timeLeft = days == null ? '' : days >= 0 ? `${days} days left` : `<span class="neg">${-days} days late</span>`;
    const statusBtn = !manage() ? '' : closed ? `<button class="btn sm gold-btn" data-act="status">${icon('unlock')}Re-open</button>`
        : p.status === 'COMPLETED' ? `<button class="btn sm gold-btn" data-act="status">${icon('lock')}Close the books</button>`
        : `<button class="btn sm on-dark" data-act="status">${icon('check-circle')}Completed</button>`;
    target.innerHTML = `
        <section class="panel p-chit-head cn-head">
            <div class="chit-banner">
                <span class="hero-icon">${icon(kindIcon(p))}</span>
                <div class="ab-id">
                    <div class="ab-name">${esc(p.name)} <span class="badge ${dev ? 'aqua' : 'gold'}">${esc(kindName(p))}</span> <span class="badge ${tone}">${label}</span></div>
                    <div class="ab-meta">${[p.clientName ? `for ${p.clientName}` : null, p.siteAddress || p.city, p.surveyNo ? `Sy. No. ${p.surveyNo}` : null,
                        p.floors ? `${p.floors} floors` : null, p.builtUpArea ? `${num(p.builtUpArea).toLocaleString('en-IN')} sq ft` : null].filter(Boolean).map(esc).join('<i>·</i>')}</div>
                    <div class="cb-progress"><i class="split-bar on-dark"><span class="paid" style="width:${f.progressPercent}%"></span></i>
                        <small>${f.stagesDone} of ${f.stagesTotal} stages done · ${p.startDate ? shortDate(p.startDate) : '—'} → ${f.revisedEndDate ? shortDate(f.revisedEndDate) : '—'}${f.extraDays ? ` (+${f.extraDays} days for extra works)` : ''}${timeLeft ? ` · ${timeLeft}` : ''}</small></div>
                </div>
                <div class="ab-bal"><small>${dev ? 'Sales value' : 'Contract value'}</small><b>${money(f.totalValue)}</b>
                    <span class="ab-change">${dev ? `${f.unitsSold + f.unitsBooked} sold · ${f.unitsAvailable} available` : num(f.extrasValue) ? `incl. ${money(f.extrasValue)} extra works` : 'as agreed'}</span></div>
                <div class="ab-actions chit-actions">
                    ${manage() && !closed ? `<button class="btn sm gold-btn" data-act="receive">${icon('arrow-in')}Money received</button>
                        <button class="btn sm on-dark" data-act="cost">${icon('receipt')}Add a cost</button>` : ''}
                    ${statusBtn}
                    ${manage() ? `<button class="btn sm on-dark icon" data-act="settings" title="Settings">${icon('settings')}</button>
                        <button class="btn sm on-dark icon" data-act="delete-project" title="Delete the project">${icon('trash')}</button>` : ''}
                </div>
            </div>
            <div class="chit-key">
                ${keyTile('arrow-in', 'Received', money(num(f.received) + num(f.interestReceived)), `${num(f.totalValue) ? Math.round(num(f.received) * 100 / num(f.totalValue)) : 0}% of the value${num(f.interestReceived) ? ` · ${moneyShort(f.interestReceived)} interest` : ''}`)}
                ${keyTile(num(f.overdue) ? 'alert' : 'clock', 'Due now', num(f.due) ? `<span class="${num(f.overdue) ? 'neg' : ''}">${money(f.due)}</span>` : money(0),
                    `${num(f.overdue) ? `${moneyShort(f.overdue)} overdue` : 'nothing overdue'}${num(f.interestDue) ? ` · +${moneyShort(f.interestDue)} interest` : ''}`, num(f.overdue) ? 'alert' : '')}
                ${keyTile('receipt', 'Spent', money(f.totalCost), `${num(f.estimatedCost) ? `of ${moneyShort(f.estimatedCost)} estimated` : 'costs'}${num(f.land) ? ` · land ${moneyShort(f.land)}` : ''}`,
                    num(f.estimatedCost) && num(f.totalCost) > num(f.estimatedCost) ? 'alert' : '')}
                ${keyTile('trending', 'Profit so far', `<span class="${num(f.profit) >= 0 ? 'gold-ink' : 'neg'}">${money(f.profit)}</span>`, `expected ${moneyShort(f.expectedProfit)}`, 'gold')}
            </div>
            <div class="chit-statline">
                <span title="The project's own cash and bank accounts">${icon('wallet')}In its accounts <b>${money(f.moneyBalance)}</b></span>
                ${num(f.loanOutstanding) || num(f.loanSanctioned) ? `<span>${icon('bank')}Loans <b>${money(f.loanOutstanding)}</b><small> of ${moneyShort(f.loanSanctioned)}</small></span>` : ''}
                ${num(f.capitalIn) ? `<span>${icon('users')}Partners’ capital <b>${money(f.capitalIn)}</b></span>` : ''}
                <span>${icon('clock')}Late interest <b>${num(p.lateInterestPercent) ? `${num(p.lateInterestPercent)}%` : 'none'}</b>${num(p.lateInterestPercent) ? `<small>/month${num(p.lateGraceDays) ? ` after ${p.lateGraceDays} days` : ''}</small>` : ''}</span>
                ${p.permitNo ? `<span>${icon('stamp')}Permit <b>${esc(p.permitNo)}</b></span>` : ''}${p.reraNo ? `<span>${icon('shield')}RERA <b>${esc(p.reraNo)}</b></span>` : ''}
                ${closed ? `<span class="hc-closed-chip">${icon('lock')}<b>Closed${p.closedAt ? ` ${shortDate(p.closedAt.slice(0, 10))}` : ''}</b></span>` : ''}
            </div>
        </section>
        <div class="hc-detail-rest">${panel({
            title: 'Project book', iconName: 'journal', cls: 'p-chit-tabs', bodyClass: 'flush',
            actions: `<div class="tabs sm" id="cn-tabs">${tabsOf(p).map(([k, l, i]) =>
                `<button class="tab ${view.tab === k ? 'active' : ''}" data-tab="${k}">${icon(i)}<span class="hc-tab-label">${l}</span></button>`).join('')}</div>`,
            body: '<div class="scroll chit-tab-body" id="cn-tab"></div>',
        })}</div>`;
    const body = target.querySelector('#cn-tab');
    const drawTab = () => { body.innerHTML = TABS[view.tab](d); };
    drawTab();
    body.scrollTop = keepScroll;
    target.addEventListener('click', e => onClick(e, d, target, body, drawTab));
}

const after = (d, m, receipt) => { afterChange(d, m); if (receipt) setTimeout(() => offerPrint(d, receipt), 50); };
async function offerPrint(d, r) {
    if (await confirmDialog(`Receipt ${r.receiptNo} for ${money(r.amount)} recorded. Print it now?`, { title: 'Print the receipt', confirmLabel: 'Print', danger: false })) printReceipt(d, r);
}

async function onClick(e, d, target, body, drawTab) {
    const tab = e.target.closest('[data-tab]');
    if (tab && tab.closest('#cn-tabs')) {
        view.tab = tab.dataset.tab;
        history.replaceState(null, '', `#/construction/${d.project.id}/${view.tab}`);
        target.querySelectorAll('#cn-tabs .tab').forEach(t => t.classList.toggle('active', t === tab));
        drawTab();
        body.scrollTop = 0;
        return;
    }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const p = d.project;
    const id = Number(el.dataset.id) || null;
    const reload = async () => afterChange(await api.get(`/construction/${p.id}`));
    try {
        switch (el.dataset.act) {
            case 'receive': openReceipt(d, { saleId: id }, after); break;
            case 'cost': openCost(d, null, after); break;
            case 'settings': openSettings(d, after); break;
            case 'status': openStatus(d, after); break;
            case 'delete-project':
                confirmDelete(`Delete the project ${p.name}? Only a project with no money, sales or signed agreements can be deleted.`, async () => {
                    await api.del(`/construction/${p.id}`);
                    view.selectedId = null;
                    toast('Project deleted');
                    location.hash = '#/construction';
                });
                break;
            case 'add-stage': openStage(d, null, after); break;
            case 'edit-stage': openStage(d, d.stages.find(s => s.id === id), after); break;
            case 'start-stage': afterChange(await api.post(`/construction/${p.id}/stages/${id}/progress`, { status: 'IN_PROGRESS' }), 'Started'); break;
            case 'done-stage': openStageDone(d, d.stages.find(s => s.id === id), after); break;
            case 'undo-stage': afterChange(await api.post(`/construction/${p.id}/stages/${id}/progress`, { status: 'PENDING' }), 'Back to not started'); break;
            case 'del-stage': confirmDelete('Remove this stage?', async () => afterChange(await api.del(`/construction/${p.id}/stages/${id}`), 'Removed')); break;
            case 'move-stage': {
                const ids = d.stages.map(s => s.id);
                const i = ids.indexOf(id);
                const j = i + Number(el.dataset.dir);
                if (j < 0 || j >= ids.length) return;
                [ids[i], ids[j]] = [ids[j], ids[i]];
                afterChange(await api.put(`/construction/${p.id}/stages-order`, ids));
                break;
            }
            case 'add-extra': openExtra(d, null, after); break;
            case 'edit-extra': openExtra(d, d.extras.find(x => x.id === id), after); break;
            case 'extra-status': afterChange(await api.post(`/construction/${p.id}/extras/${id}/status`, { status: el.dataset.to }), 'Saved'); break;
            case 'del-extra': confirmDelete('Remove this extra work?', async () => afterChange(await api.del(`/construction/${p.id}/extras/${id}`), 'Removed')); break;
            case 'print-receipt': printReceipt(d, d.receipts.find(r => r.id === id)); break;
            case 'edit-receipt': openReceipt(d, { receipt: d.receipts.find(r => r.id === id) }, after); break;
            case 'del-receipt': {
                const r = d.receipts.find(x => x.id === id);
                confirmDelete(`Delete the receipt ${r.receiptNo} for ${money(r.amount)}? Its entry in the books goes with it.`, async () => afterChange(await api.del(`/construction/${p.id}/receipts/${id}`), 'Receipt deleted'));
                break;
            }
            case 'edit-cost': openCost(d, d.costs.find(c => c.id === id), after); break;
            case 'del-cost': confirmDelete('Delete this cost? Its entry in the books goes with it.', async () => afterChange(await api.del(`/construction/${p.id}/costs/${id}`), 'Cost deleted')); break;
            case 'head': view.costHead = el.dataset.head || null; drawTab(); break;
            case 'add-partner': openPartner(d, null, after); break;
            case 'edit-partner': openPartner(d, d.partners.find(v => v.partner.id === id).partner, after); break;
            case 'del-partner': confirmDelete('Remove this partner? Their share goes back to you.', async () => afterChange(await api.del(`/construction/${p.id}/partners/${id}`), 'Removed')); break;
            case 'shares': openShares(d, after); break;
            case 'capital-in': openCapital(d, id, 'INVEST', after); break;
            case 'capital-out': openCapital(d, id, 'WITHDRAW', after); break;
            case 'del-capital': confirmDelete('Delete this movement? Its entry in the books goes with it.', async () => afterChange(await api.del(`/construction/${p.id}/capital/${id}`), 'Deleted')); break;
            case 'add-loan': openLoan(d, null, after); break;
            case 'edit-loan': openLoan(d, d.loans.find(v => v.loan.id === id).loan, after); break;
            case 'del-loan': confirmDelete('Remove this loan?', async () => afterChange(await api.del(`/construction/${p.id}/loans/${id}`), 'Removed')); break;
            case 'loan-txn': openLoanTxn(d, d.loans.find(v => v.loan.id === id).loan, el.dataset.kind, after); break;
            case 'del-loan-txn': confirmDelete('Delete this loan movement? Its entry in the books goes with it.', async () => afterChange(await api.del(`/construction/${p.id}/loan-txns/${id}`), 'Deleted')); break;
            case 'add-party': openParty(d, null, el.dataset.role, after); break;
            case 'edit-party': { const x = d.parties.find(q => q.id === id); openParty(d, x, x.role, after); break; }
            case 'del-party': confirmDelete('Remove them?', async () => afterChange(await api.del(`/construction/${p.id}/parties/${id}`), 'Removed')); break;
            case 'add-units': openUnits(d, after); break;
            case 'add-unit': openUnit(d, null, after); break;
            case 'unit': {
                const u = d.units.find(x => x.id === id);
                const sale = d.sales.find(s => s.sale.unitId === id && s.sale.status !== 'CANCELLED');
                if (sale) openSale(d, sale.sale.id, (fresh, m) => afterChange(fresh, m));
                else if (u.status === 'AVAILABLE' && manage()) openBook(d, u, after);
                else openUnit(d, u, after);
                break;
            }
            case 'edit-unit': openUnit(d, d.units.find(x => x.id === id), after); break;
            case 'del-unit': confirmDelete('Remove this flat?', async () => afterChange(await api.del(`/construction/${p.id}/units/${id}`), 'Removed')); break;
            case 'book': openBook(d, null, after); break;
            case 'sale': openSale(d, id, (fresh, m) => afterChange(fresh, m)); break;
            case 'agreement': openProjectAgreement(p, { id }, reload); break;
            case 'make-agreement': openProjectAgreement(p, { kind: el.dataset.kind, refId: id, defaults: agreementDefaults(d, el.dataset.kind, id) }, reload); break;
            case 'transfer': openTransfer(d, after); break;
            case 'common': openCommonAccount(async (_, m) => { toast(m); reload(); }); break;
            default:
        }
    } catch (err) { toast(err.message, 'error'); }
}

function agreementDefaults(d, kind, refId) {
    const p = d.project;
    if (kind === 'CONTRACT' || kind === 'EXTRA') return { partyName: p.clientName, partyPhone: p.clientPhone, partyAddress: p.clientAddress, partyRelation: p.clientRelation };
    if (kind === 'PLOT_PURCHASE' || kind === 'JDA') { const x = d.parties.find(q => q.id === refId); return x ? { partyName: x.name, partyPhone: x.phone, partyAddress: x.address, partyRelation: x.relation } : {}; }
    if (kind === 'PARTNERSHIP') { const x = d.partners.find(v => v.partner.id === refId)?.partner; return x ? { partyName: x.name, partyPhone: x.phone, partyAddress: x.address } : {}; }
    return {};
}

// ===================================================================== tabs

const btn = (act, ic, label, extra = '', cls = 'ghost') => manage() ? `<button type="button" class="btn sm ${cls}" data-act="${act}" ${extra}>${icon(ic)}${label}</button>` : '';
const ibtn = (act, ic, title, extra = '') => manage() ? `<button type="button" class="btn xs ghost icon" data-act="${act}" title="${esc(title)}" ${extra}>${icon(ic)}</button>` : '';
const section = (ic, title, actions = '', sub = '') => `<div class="cn-sec"><h4>${icon(ic)}${title}${sub ? ` <small>${sub}</small>` : ''}</h4><span class="grow"></span>${actions}</div>`;
const agreementOf = (d, kind, refId = null) => d.agreements.filter(a => a.kind === kind && (refId == null || a.refId === refId))[0];
function agreementChip(d, kind, refId = null, label = null) {
    const a = agreementOf(d, kind, refId);
    if (a) {
        const done = a.status !== 'DRAFT';
        return `<button type="button" class="cn-agchip ${done ? 'done' : 'draft'}" data-act="agreement" data-id="${a.id}" title="${esc(a.title)} ${esc(a.agreementNo)}">${icon(done ? 'check-circle' : 'file-text')}${esc(label || a.agreementNo)}${done ? '' : ' · draft'}</button>`;
    }
    return manage() ? `<button type="button" class="cn-agchip make" data-act="make-agreement" data-kind="${kind}" ${refId != null ? `data-id="${refId}"` : ''}>${icon('plus')}${esc(label || 'Agreement')}</button>` : '';
}

const TABS = {
    overview(d) {
        const p = d.project;
        const f = d.figures;
        const dev = p.kind === 'DEVELOPMENT';
        const heads = d.costHeads.slice(0, 6);
        const maxHead = Math.max(1, ...heads.map(h => num(h.amount)));
        const unitsBar = dev && f.unitsTotal ? `<div class="cn-unitbar">${[['sold', f.unitsSold], ['booked', f.unitsBooked], ['avail', f.unitsAvailable], ['owner', f.unitsLandowner]]
            .filter(([, n]) => n).map(([k, n]) => `<span class="u-${k}" style="flex:${n}" title="${n}">${n}</span>`).join('')}</div>
            <div class="cn-legend"><i class="u-sold"></i>sold / handed over <i class="u-booked"></i>booked <i class="u-avail"></i>available ${f.unitsLandowner ? '<i class="u-owner"></i>landowners’' : ''}</div>` : '';
        return `<div class="cn-ov">
            <div class="cn-card">${section('timeline', 'Timeline')}
                <div class="cn-timeline">${d.stages.map(s => { const [tone, l, ic] = STAGE[s.status]; return `<span class="cn-tl ${s.status.toLowerCase()}" title="${esc(`${s.name} · ${l}${s.completedOn ? ` ${date(s.completedOn)}` : s.plannedEnd ? ` · planned ${date(s.plannedEnd)}` : ''}`)}">${icon(ic)}<small>${esc(s.name)}</small></span>`; }).join('') || '<span class="muted">No stages yet</span>'}</div>
                <p class="muted small">${p.startDate ? `Started ${date(p.startDate)}` : 'Not started'} · completion ${f.revisedEndDate ? date(f.revisedEndDate) : 'not set'}${f.extraDays ? ` (${f.extraDays} days added for extra works)` : ''}${f.daysLeft != null ? ` · ${f.daysLeft >= 0 ? `${f.daysLeft} days left` : `${-f.daysLeft} days late`}` : ''}</p></div>
            <div class="cn-card">${section('wallet', 'Money')}
                <table class="cn-figs"><tbody>
                    <tr><th>${dev ? 'Flats sold for' : 'Contract price'}</th><td>${money(f.contractValue)}</td></tr>
                    ${!dev && num(f.extrasValue) ? `<tr><th>Extra works agreed</th><td>${money(f.extrasValue)}</td></tr>` : ''}
                    ${dev && num(f.unsoldValue) ? `<tr><th>Unsold flats (list price)</th><td>${money(f.unsoldValue)}</td></tr>` : ''}
                    <tr><th>Received</th><td class="pos">${money(f.received)}</td></tr>
                    ${num(f.interestReceived) ? `<tr><th>Late interest received</th><td class="pos">${money(f.interestReceived)}</td></tr>` : ''}
                    <tr><th>Due now</th><td>${money(f.due)}${num(f.overdue) ? ` <small class="neg">${moneyShort(f.overdue)} overdue</small>` : ''}</td></tr>
                    ${num(f.interestDue) ? `<tr><th>Late interest due</th><td class="neg">${money(f.interestDue)}</td></tr>` : ''}
                    <tr><th>Spent</th><td class="neg">${money(f.totalCost)}${num(f.estimatedCost) ? ` <small class="muted">of ${moneyShort(f.estimatedCost)}</small>` : ''}</td></tr>
                    <tr class="cn-total"><th>Profit so far</th><td class="${num(f.profit) >= 0 ? 'pos' : 'neg'}">${money(f.profit)}</td></tr>
                    <tr><th>Expected profit</th><td>${money(f.expectedProfit)}</td></tr>
                </tbody></table></div>
            ${dev ? `<div class="cn-card">${section('grid', 'Flats', btn('book', 'tag', 'Book a flat', '', 'primary'))}${unitsBar || '<p class="muted">No flats yet</p>'}
                <p class="muted small">${f.unitsTotal} flats · sales ${money(f.salesValue)}</p></div>` : ''}
            <div class="cn-card">${section('receipt', 'Where the money went', btn('cost', 'plus', 'Add a cost'))}
                ${heads.length ? `<div class="cn-bars">${heads.map(h => `<div class="cn-bar"><span>${icon(HEAD_ICONS[h.head] || 'layers')}${esc(headName(h.head))}</span>
                    <i><em style="width:${Math.max(2, num(h.amount) * 100 / maxHead)}%"></em></i><b>${moneyShort(h.amount)}</b></div>`).join('')}</div>` : '<p class="muted">No costs yet</p>'}</div>
            <div class="cn-card">${section('users', 'Partners')}
                <div class="cn-shares">${d.partners.map(v => `<span style="flex:${Math.max(1, num(v.partner.sharePercent))}" title="${esc(v.partner.name)}">${esc(v.partner.name.split(' ')[0])} ${num(v.partner.sharePercent)}%</span>`).join('')}</div></div>
            <div class="cn-card">${section('history', 'Lately')}
                <ul class="cn-recent">${[...d.receipts.slice(0, 4).map(r => ({ on: r.receivedOn, html: `${icon('arrow-in')}<span>${esc(r.payerName || '')}${r.towards ? ` · ${esc(r.towards)}` : ''}</span><b class="pos">+${moneyShort(r.amount)}</b>` })),
                    ...d.costs.slice(0, 4).map(c => ({ on: c.spentOn, html: `${icon('arrow-out')}<span>${esc(headName(c.head))}${c.vendor ? ` · ${esc(c.vendor)}` : ''}</span><b class="neg">−${moneyShort(c.amount)}</b>` }))]
                    .sort((a, b) => b.on.localeCompare(a.on)).slice(0, 6).map(x => `<li><small>${shortDate(x.on)}</small>${x.html}</li>`).join('') || '<li class="muted">Nothing yet</li>'}</ul></div>
        </div>`;
    },

    stages(d) {
        const p = d.project;
        const contract = p.kind === 'CONTRACT';
        const rows = d.stages.map((s, i) => {
            const [tone, label, ic] = STAGE[s.status];
            return `<tr><td class="nowrap">${manage() ? `${ibtn('move-stage', 'chevron-up', 'Up', `data-id="${s.id}" data-dir="-1" ${i ? '' : 'disabled'}`)}${ibtn('move-stage', 'chevron-down', 'Down', `data-id="${s.id}" data-dir="1" ${i < d.stages.length - 1 ? '' : 'disabled'}`)}` : ''}${i + 1}</td>
                <td><b>${esc(s.name)}</b>${s.description ? `<br><small class="muted">${esc(s.description)}</small>` : ''}</td>
                <td class="nowrap">${s.plannedStart || s.plannedEnd ? `${s.plannedStart ? shortDate(s.plannedStart) : '…'} → ${s.plannedEnd ? shortDate(s.plannedEnd) : '…'}` : '<span class="muted">—</span>'}</td>
                ${contract ? `<td class="r">${num(s.amount) ? money(s.amount) : ''}</td><td class="nowrap">${s.dueDate ? date(s.dueDate) : num(s.amount) ? '<small class="muted">7 days after done</small>' : ''}</td>` : ''}
                <td><span class="badge ${tone}">${icon(ic)}${label}${s.completedOn ? ` ${shortDate(s.completedOn)}` : ''}</span></td>
                <td class="r nowrap">${manage() && p.status !== 'CLOSED' ? `${s.status === 'PENDING' ? ibtn('start-stage', 'play', 'Started', `data-id="${s.id}"`) : ''}
                    ${s.status !== 'DONE' ? ibtn('done-stage', 'check', 'Done', `data-id="${s.id}"`) : ibtn('undo-stage', 'undo', 'Not done', `data-id="${s.id}"`)}
                    ${ibtn('edit-stage', 'edit', 'Edit', `data-id="${s.id}"`)}${ibtn('del-stage', 'trash', 'Remove', `data-id="${s.id}"`)}` : ''}</td></tr>`;
        }).join('');
        const sched = contract && d.schedule.length ? `${section('calendar', 'What the owner pays', btn('receive', 'arrow-in', 'Money received', '', 'primary'),
            'payments go to the oldest part first')}
            <table class="grid dense cn-dues"><thead><tr><th>For</th><th>Due</th><th class="r">Amount</th><th class="r">Paid</th><th class="r">Balance</th><th class="r">Interest</th><th></th></tr></thead>
            <tbody>${d.schedule.map(r => { const [tone, label] = DUE_TONE[r.status]; return `<tr><td>${esc(r.label)}</td><td>${r.dueDate ? date(r.dueDate) : '<span class="muted">when done</span>'}${r.daysLate ? ` <small class="neg">${r.daysLate}d late</small>` : ''}</td>
                <td class="r">${money(r.amount)}</td><td class="r">${num(r.paid) ? money(r.paid) : ''}</td><td class="r"><b>${num(r.balance) ? money(r.balance) : ''}</b></td><td class="r">${num(r.interest) ? money(r.interest) : ''}</td>
                <td><span class="badge ${tone}">${label}</span></td></tr>`; }).join('')}</tbody>
            <tfoot><tr><th colspan="2">Total</th><th class="r">${money(d.schedule.reduce((s, r) => s + num(r.amount), 0))}</th><th class="r">${money(d.schedule.reduce((s, r) => s + num(r.paid), 0))}</th>
                <th class="r">${money(d.schedule.reduce((s, r) => s + num(r.balance), 0))}</th><th class="r">${money(d.schedule.reduce((s, r) => s + num(r.interest), 0))}</th><th></th></tr></tfoot></table>` : '';
        return `<div class="cn-pad">${section('layers', contract ? 'Stages and their price' : 'Construction stages', `${contract ? agreementChip(d, 'CONTRACT', null, 'Construction agreement') : ''}${btn('add-stage', 'plus', 'Add a stage')}`,
                contract ? `contract price ${money(d.figures.contractValue)}` : 'buyers’ instalments follow them')}
            ${d.stages.length ? `<table class="grid dense"><thead><tr><th>#</th><th>Stage</th><th>Planned</th>${contract ? '<th class="r">Price</th><th>Paid by</th>' : ''}<th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
                : emptyState('No stages yet', 'layers')}
            ${sched}</div>`;
    },

    extras(d) {
        const list = d.extras;
        return `<div class="cn-pad">${section('plus', 'Extra works', btn('add-extra', 'plus', 'Add an extra work', '', 'primary'), 'each with its own price, days and supplementary agreement')}
            ${list.length ? `<div class="cn-extras">${list.map(x => { const [tone, label] = EXTRA[x.status]; return `<div class="cn-extra ${x.status.toLowerCase()}">
                <div class="cn-extra-main"><b>EX-${x.seq} · ${esc(x.title)}</b>${x.description ? `<small>${esc(x.description)}</small>` : ''}
                    <small class="muted">asked ${date(x.requestedOn)}${x.dueDate ? ` · paid by ${date(x.dueDate)}` : ''}${x.completedOn ? ` · done ${date(x.completedOn)}` : ''}</small></div>
                <div class="cn-extra-figs"><b>${money(x.amount)}</b><small>${x.extraDays ? `+${x.extraDays} days` : 'no extra time'}</small><span class="badge ${tone}">${label}</span></div>
                <div class="cn-extra-acts">${agreementChip(d, 'EXTRA', x.id, 'Supplementary agreement')}
                    ${manage() && d.project.status !== 'CLOSED' ? `${x.status === 'PROPOSED' ? ibtn('extra-status', 'check', 'Mark agreed (without an agreement)', `data-id="${x.id}" data-to="AGREED"`) : ''}
                    ${x.status === 'AGREED' ? ibtn('extra-status', 'check-circle', 'Done', `data-id="${x.id}" data-to="DONE"`) : ''}
                    ${['PROPOSED', 'AGREED'].includes(x.status) ? ibtn('extra-status', 'x', 'Cancel it', `data-id="${x.id}" data-to="CANCELLED"`) : ''}
                    ${x.status === 'PROPOSED' ? `${ibtn('edit-extra', 'edit', 'Edit', `data-id="${x.id}"`)}${ibtn('del-extra', 'trash', 'Remove', `data-id="${x.id}"`)}` : ''}` : ''}</div></div>`; }).join('')}</div>
                <p class="muted small">Agreed: ${money(d.figures.extrasValue)} and ${d.figures.extraDays} days added to the completion.</p>`
                : emptyState('No extra works. When the owner asks for more, add it here with its price and the days it adds.', 'plus')}</div>`;
    },

    receipts(d) {
        const list = d.receipts;
        const total = list.reduce((s, r) => s + num(r.amount), 0);
        const sale = id => d.sales.find(s => s.sale.id === id);
        return `<div class="cn-pad">${section('arrow-in', 'Money received', btn('receive', 'plus', 'Money received', '', 'primary'), `${plural(list.length, 'receipt')} · ${money(total)}`)}
            ${list.length ? `<table class="grid dense"><thead><tr><th>Receipt</th><th>Date</th><th>From</th><th>Towards</th><th>Into</th><th class="r">Amount</th><th></th></tr></thead><tbody>
                ${list.map(r => `<tr><td><b>${esc(r.receiptNo)}</b></td><td class="nowrap">${shortDate(r.receivedOn)}</td>
                    <td>${r.payer === 'BANK' ? icon('bank') : icon('user')}${esc(r.payerName || '')}${r.saleId ? `<small class="muted"> · ${esc(sale(r.saleId)?.unitLabel || '')}</small>` : ''}<br><small class="muted">${esc(r.mode || '')}${r.reference ? ` ${esc(r.reference)}` : ''}</small></td>
                    <td>${esc(r.towards || '')}</td><td><small>${esc(d.accountNames[r.accountId] || '')}</small></td>
                    <td class="r"><b>${money(r.amount)}</b>${num(r.interestAmount) ? `<br><small class="muted">incl. ${money(r.interestAmount)} interest</small>` : ''}</td>
                    <td class="r nowrap">${`<button type="button" class="btn xs ghost icon" data-act="print-receipt" data-id="${r.id}" title="Print the receipt">${icon('printer')}</button>`}
                        ${ibtn('edit-receipt', 'edit', 'Edit', `data-id="${r.id}"`)}${ibtn('del-receipt', 'trash', 'Delete', `data-id="${r.id}"`)}</td></tr>`).join('')}</tbody></table>`
                : emptyState('Nothing received yet', 'arrow-in')}</div>`;
    },

    costs(d) {
        const list = view.costHead ? d.costs.filter(c => c.head === view.costHead) : d.costs;
        const f = d.figures;
        const loanCosts = d.loanTxns.filter(t => ['INTEREST', 'CHARGES'].includes(t.kind)).reduce((s, t) => s + num(t.amount), 0);
        return `<div class="cn-pad">${section('receipt', 'Costs', btn('cost', 'plus', 'Add a cost', '', 'primary'),
                `${money(f.totalCost)} spent${num(f.estimatedCost) ? ` of ${money(f.estimatedCost)} estimated` : ''}${loanCosts ? ` · incl. ${money(loanCosts)} loan interest` : ''}`)}
            ${num(f.estimatedCost) ? `<div class="cn-budget"><i><em style="width:${Math.min(100, num(f.totalCost) * 100 / num(f.estimatedCost))}%" class="${num(f.totalCost) > num(f.estimatedCost) ? 'over' : ''}"></em></i>
                <small>${Math.round(num(f.totalCost) * 100 / num(f.estimatedCost))}% of the estimate</small></div>` : ''}
            <div class="cn-headchips"><button type="button" class="date-chip ${view.costHead ? '' : 'selected'}" data-act="head">All</button>${d.costHeads.map(h =>
                `<button type="button" class="date-chip ${view.costHead === h.head ? 'selected' : ''}" data-act="head" data-head="${h.head}">${icon(HEAD_ICONS[h.head] || 'layers')}${esc(headName(h.head))} <small>${moneyShort(h.amount)}</small></button>`).join('')}</div>
            ${list.length ? `<table class="grid dense"><thead><tr><th>Date</th><th>Head</th><th>What</th><th>Quantity</th><th>Paid from</th><th class="r">Amount</th><th></th></tr></thead><tbody>
                ${list.map(c => `<tr><td class="nowrap">${shortDate(c.spentOn)}</td><td>${icon(HEAD_ICONS[c.head] || 'layers')}${esc(headName(c.head))}</td>
                    <td>${esc(c.description || '')}${c.vendor ? `<br><small class="muted">${esc(c.vendor)}${c.billNo ? ` · bill ${esc(c.billNo)}` : ''}</small>` : ''}</td>
                    <td class="nowrap">${c.quantity != null ? `${num(c.quantity)} ${esc(c.unit || '')}${c.rate != null ? ` × ${money(c.rate)}` : ''}` : ''}</td>
                    <td><small>${esc(d.accountNames[c.accountId] || '')}</small></td><td class="r"><b>${money(c.amount)}</b></td>
                    <td class="r nowrap">${ibtn('edit-cost', 'edit', 'Edit', `data-id="${c.id}"`)}${ibtn('del-cost', 'trash', 'Delete', `data-id="${c.id}"`)}</td></tr>`).join('')}</tbody></table>`
                : emptyState('No costs recorded', 'receipt')}</div>`;
    },

    partners(d) {
        const p = d.project;
        return `<div class="cn-pad">${section('users', 'Partners', `${btn('shares', 'pie', 'Shares')}${btn('add-partner', 'plus', 'Add a partner', '', 'primary')}`, 'the profit is shared in these shares when the books close')}
            <div class="cn-partners">${d.partners.map(v => `<div class="cn-partner">
                <div class="cn-partner-head"><span class="chip-icon sm ${v.partner.me ? 'gold' : 'violet'}">${icon(v.partner.me ? 'user' : 'users')}</span>
                    <div class="min-0 grow"><b>${esc(v.partner.name)}${v.partner.me ? ' <small class="muted">(me)</small>' : ''}</b><small class="muted">${esc(v.partner.phone || '')}</small></div>
                    <b class="cn-share">${num(v.partner.sharePercent)}%</b></div>
                <table class="cn-figs"><tbody><tr><th>Put in</th><td>${money(v.invested)}</td></tr><tr><th>Taken out</th><td>${money(v.withdrawn)}</td></tr>
                    ${num(v.profit) ? `<tr><th>Share of the profit</th><td class="${num(v.profit) >= 0 ? 'pos' : 'neg'}">${money(v.profit)}</td></tr>` : ''}
                    <tr class="cn-total"><th>Balance</th><td>${money(v.balance)}</td></tr><tr><th>Of the capital</th><td>${num(v.capitalSharePercent)}%</td></tr></tbody></table>
                <div class="row wrap">${manage() && p.status !== 'CLOSED' ? `${btn('capital-in', 'arrow-in', 'Put in', `data-id="${v.partner.id}"`)}${btn('capital-out', 'arrow-out', 'Take out', `data-id="${v.partner.id}"`)}` : ''}
                    ${!v.partner.me ? agreementChip(d, 'PARTNERSHIP', v.partner.id, 'Agreement') : ''}
                    <span class="grow"></span>${ibtn('edit-partner', 'edit', 'Edit', `data-id="${v.partner.id}"`)}${d.partners.length > 1 ? ibtn('del-partner', 'trash', 'Remove', `data-id="${v.partner.id}"`) : ''}</div>
            </div>`).join('')}</div>
            ${d.capital.length ? `${section('history', 'Capital in and out')}<table class="grid dense"><thead><tr><th>Date</th><th>Partner</th><th>What</th><th class="r">Amount</th><th></th></tr></thead><tbody>
                ${d.capital.map(c => { const who = d.partners.find(v => v.partner.id === c.partnerId)?.partner; return `<tr><td>${shortDate(c.movedOn)}</td><td>${esc(who?.name || '')}</td>
                    <td>${c.kind === 'INVEST' ? `${icon('arrow-in')}Put in` : c.kind === 'WITHDRAW' ? `${icon('arrow-out')}Taken out` : `${icon('trending')}${esc(c.note || 'Profit share')}`}${c.note && c.kind !== 'PROFIT' ? ` · <small class="muted">${esc(c.note)}</small>` : ''}</td>
                    <td class="r"><b>${money(c.amount)}</b></td><td class="r">${c.kind !== 'PROFIT' ? ibtn('del-capital', 'trash', 'Delete', `data-id="${c.id}"`) : ''}</td></tr>`; }).join('')}</tbody></table>` : ''}</div>`;
    },

    loans(d) {
        return `<div class="cn-pad">${section('bank', 'Loans for the project', btn('add-loan', 'plus', 'Add a loan', '', 'primary'), 'interest and charges count as costs')}
            ${d.loans.length ? `<div class="cn-partners">${d.loans.map(v => `<div class="cn-partner">
                <div class="cn-partner-head"><span class="chip-icon sm gold">${icon('bank')}</span><div class="min-0 grow"><b>${esc(v.loan.lender)}</b>
                    <small class="muted">${esc(v.loan.loanNo || '')}${num(v.loan.ratePercent) ? ` · ${num(v.loan.ratePercent)}% a year` : ''}${v.loan.tenureMonths ? ` · ${v.loan.tenureMonths} months` : ''}</small></div>
                    <span class="badge ${v.loan.status === 'CLOSED' ? 'gray' : 'aqua'}">${v.loan.status === 'CLOSED' ? 'Repaid' : 'Running'}</span></div>
                <table class="cn-figs"><tbody><tr><th>Sanctioned</th><td>${money(v.loan.sanctioned)}</td></tr><tr><th>Disbursed</th><td>${money(v.disbursed)}</td></tr>
                    <tr><th>Repaid</th><td>${money(v.repaid)}</td></tr><tr><th>Interest paid</th><td>${money(v.interestPaid)}</td></tr>
                    <tr class="cn-total"><th>Outstanding</th><td>${money(v.outstanding)}</td></tr></tbody></table>
                ${manage() && d.project.status !== 'CLOSED' ? `<div class="row wrap">${btn('loan-txn', 'arrow-in', 'Disbursed', `data-id="${v.loan.id}" data-kind="DISBURSE"`)}${btn('loan-txn', 'percent', 'Interest', `data-id="${v.loan.id}" data-kind="INTEREST"`)}
                    ${btn('loan-txn', 'arrow-out', 'Repay', `data-id="${v.loan.id}" data-kind="REPAY"`)}${btn('loan-txn', 'receipt', 'Charges', `data-id="${v.loan.id}" data-kind="CHARGES"`)}
                    <span class="grow"></span>${ibtn('edit-loan', 'edit', 'Edit', `data-id="${v.loan.id}"`)}${ibtn('del-loan', 'trash', 'Remove', `data-id="${v.loan.id}"`)}</div>` : ''}
            </div>`).join('')}</div>` : emptyState('No loans. Add a construction finance or a private loan to track its money and interest.', 'bank')}
            ${d.loanTxns.length ? `${section('history', 'Loan movements')}<table class="grid dense"><thead><tr><th>Date</th><th>Loan</th><th>What</th><th>Account</th><th class="r">Amount</th><th></th></tr></thead><tbody>
                ${d.loanTxns.map(t => `<tr><td>${shortDate(t.movedOn)}</td><td>${esc(d.loans.find(v => v.loan.id === t.loanId)?.loan.lender || '')}</td>
                    <td>${{ DISBURSE: 'Disbursed', INTEREST: 'Interest', REPAY: 'Repaid', CHARGES: 'Charges' }[t.kind]}${t.note ? ` · <small class="muted">${esc(t.note)}</small>` : ''}</td>
                    <td><small>${esc(d.accountNames[t.accountId] || '')}</small></td><td class="r"><b>${money(t.amount)}</b></td><td class="r">${ibtn('del-loan-txn', 'trash', 'Delete', `data-id="${t.id}"`)}</td></tr>`).join('')}</tbody></table>` : ''}</div>`;
    },

    land(d) {
        const p = d.project;
        const joint = p.landMode === 'JOINT';
        const role = joint ? 'LANDOWNER' : 'SELLER';
        const unitsOf = id => d.units.filter(u => u.partyId === id);
        return `<div class="cn-pad">
            <div class="cn-card cn-plot">${section('home', 'The plot')}
                <table class="cn-figs"><tbody>
                    <tr><th>Address</th><td>${esc([p.siteAddress, p.city].filter(Boolean).join(', ') || '—')}</td></tr>
                    <tr><th>Survey / plot No.</th><td>${esc([p.surveyNo && `Sy. No. ${p.surveyNo}`, p.plotNo && `Plot ${p.plotNo}`].filter(Boolean).join(' · ') || '—')}</td></tr>
                    <tr><th>Extent</th><td>${p.plotArea ? `${num(p.plotArea)} ${esc({ SQ_YD: 'sq yards', SQ_FT: 'sq ft', SQ_M: 'sq m', ACRE: 'acres', GUNTA: 'guntas' }[p.areaUnit] || '')}` : '—'}</td></tr>
                    <tr><th>Boundaries</th><td>${esc(p.boundaries || '—')}</td></tr>
                    ${joint ? `<tr><th>Landowners’ share</th><td>${num(p.landownerSharePercent)}% of the flats / built area</td></tr><tr><th>Refundable deposit</th><td>${money(p.refundableDeposit)}</td></tr>`
                        : `<tr><th>Plot price</th><td>${money(p.plotPrice)}</td></tr>`}
                    <tr><th>Land costs paid</th><td>${money(d.figures.land)} <small class="muted">(costs under “Land”)</small></td></tr>
                </tbody></table></div>
            ${section(joint ? 'layers' : 'users', joint ? 'Landowners' : 'Sellers of the plot', btn('add-party', 'plus', joint ? 'Add a landowner' : 'Add a seller', `data-role="${role}"`, 'primary'),
                joint ? 'each signs the joint development agreement' : 'each signs an agreement of sale')}
            ${d.parties.length ? `<table class="grid dense"><thead><tr><th>Name</th><th>Mobile</th><th class="r">Share</th><th class="r">${joint ? 'Deposit' : 'Price'}</th>${joint ? '<th>Flats</th>' : ''}<th>Agreement</th><th></th></tr></thead><tbody>
                ${d.parties.map(x => `<tr><td><b>${esc(x.name)}</b>${x.relation ? `<br><small class="muted">${esc(x.relation)}</small>` : ''}</td><td>${esc(x.phone || '')}</td>
                    <td class="r">${x.sharePercent != null ? `${num(x.sharePercent)}%` : ''}</td><td class="r">${x.consideration != null ? money(x.consideration) : ''}</td>
                    ${joint ? `<td>${unitsOf(x.id).map(u => `${u.block ? `${u.block}-` : ''}${u.unitNo}`).join(', ') || '<span class="muted">—</span>'}</td>` : ''}
                    <td>${agreementChip(d, joint ? 'JDA' : 'PLOT_PURCHASE', x.id, joint ? 'JDA' : 'Agreement of sale')}</td>
                    <td class="r nowrap">${ibtn('edit-party', 'edit', 'Edit', `data-id="${x.id}"`)}${ibtn('del-party', 'trash', 'Remove', `data-id="${x.id}"`)}</td></tr>`).join('')}</tbody></table>`
                : emptyState(joint ? 'Add the landowners' : 'Add the seller(s) of the plot', 'users')}
            <p class="muted small">${icon('info')}Pay the plot price${joint ? ' or the deposit' : ''} as a cost under “Land”; registration and stamp duty too.</p></div>`;
    },

    flats(d) {
        const p = d.project;
        const byBlock = {};
        d.units.forEach(u => { (byBlock[u.block || ''] ||= {}); (byBlock[u.block || ''][u.floor ?? 0] ||= []).push(u); });
        const saleOf = u => d.sales.find(s => s.sale.unitId === u.id && s.sale.status !== 'CANCELLED');
        const grid = Object.entries(byBlock).map(([block, floors]) => `<div class="cn-block"><b>${block ? `Block ${esc(block)}` : 'Flats'}</b>
            ${Object.keys(floors).map(Number).sort((a, b) => b - a).map(fl => `<div class="cn-floor"><span class="cn-floor-no">${fl === 0 ? 'G' : fl}</span>${floors[fl].map(u => {
                const s = saleOf(u);
                const [cls, label] = UNIT[u.status] || ['avail', u.status];
                return `<button type="button" class="cn-unit ${cls} ${s && num(s.overdue) ? 'late' : ''}" data-act="unit" data-id="${u.id}" title="${esc(`${label}${u.unitType ? ` · ${u.unitType}` : ''}${u.price ? ` · ${money(u.price)}` : ''}${s ? ` · ${s.sale.buyerName}` : ''}`)}">
                    <b>${esc(u.unitNo)}</b><small>${s ? esc(s.sale.buyerName.split(' ')[0]) : esc(u.unitType || label)}</small></button>`;
            }).join('')}</div>`).join('')}</div>`).join('');
        const active = d.sales.filter(s => s.sale.status !== 'CANCELLED');
        return `<div class="cn-pad">${section('grid', 'Flats', `${btn('add-units', 'grid', 'Add flats')}${btn('add-unit', 'plus', 'One flat')}${btn('book', 'tag', 'Book a flat', '', 'primary')}`,
                `${d.units.length} flats · click one to book it or open its sale`)}
            ${d.units.length ? `<div class="cn-units">${grid}</div><div class="cn-legend"><i class="u-avail"></i>available <i class="u-booked"></i>booked <i class="u-sold"></i>sold <i class="u-handed"></i>handed over ${p.landMode === 'JOINT' ? '<i class="u-owner"></i>landowners’' : ''} <i class="u-late"></i>payment late</div>`
                : emptyState('No flats yet: add them a block at a time.', 'grid')}
            ${section('tag', 'Sales', '', `${active.length} sold or booked · ${money(active.reduce((s, x) => s + num(x.sale.totalPrice), 0))}`)}
            ${d.sales.length ? `<table class="grid dense"><thead><tr><th>Flat</th><th>Buyer</th><th class="r">Price</th><th class="r">Received</th><th class="r">Due</th><th>Home loan</th><th>Step</th></tr></thead><tbody>
                ${d.sales.map(s => `<tr class="clickable" data-act="sale" data-id="${s.sale.id}"><td><b>${esc(s.unitLabel)}</b></td><td>${esc(s.sale.buyerName)}<br><small class="muted">${esc(s.sale.buyerPhone || '')}</small></td>
                    <td class="r">${money(s.sale.totalPrice)}</td><td class="r pos">${money(s.received)}</td>
                    <td class="r">${num(s.due) ? `<b class="${num(s.overdue) ? 'neg' : ''}">${money(s.due)}</b>` : ''}${num(s.interestDue) ? `<br><small class="neg">+${money(s.interestDue)} interest</small>` : ''}</td>
                    <td>${s.sale.loanBank ? `${esc(s.sale.loanBank)}<br><small class="muted">${esc((s.sale.loanStatus || '').toLowerCase())}${num(s.bankReceived) ? ` · ${moneyShort(s.bankReceived)} in` : ''}</small>` : '<span class="muted">—</span>'}</td>
                    <td><span class="badge ${s.sale.status === 'CANCELLED' ? 'gray' : s.sale.status === 'CLOSED' ? 'good' : 'aqua'}">${esc(s.sale.status.replace('_', ' ').toLowerCase())}</span></td></tr>`).join('')}</tbody></table>`
                : '<p class="muted">No flat sold yet.</p>'}</div>`;
    },

    agreements(d) {
        const p = d.project;
        const make = [];
        if (p.kind === 'CONTRACT') make.push(['CONTRACT', null, 'Construction agreement with the owner']);
        d.parties.forEach(x => make.push([x.role === 'LANDOWNER' ? 'JDA' : 'PLOT_PURCHASE', x.id, `${x.role === 'LANDOWNER' ? 'Joint development agreement' : 'Agreement of sale'} · ${x.name}`]));
        d.partners.filter(v => !v.partner.me).forEach(v => make.push(['PARTNERSHIP', v.partner.id, `Partner’s agreement · ${v.partner.name}`]));
        const missing = make.filter(([k, id]) => !agreementOf(d, k, id));
        return `<div class="cn-pad">${section('file-text', 'Agreements', '', 'on stamp paper, signed online or in person')}
            ${d.agreements.length ? `<div class="cn-ag-list">${d.agreements.map(a => {
                const [name, , ic] = AGREEMENT_KINDS[a.kind] || [a.title, '', 'file-text'];
                const done = a.status !== 'DRAFT';
                return `<div class="cn-ag ${done ? 'done' : 'draft'}"><span class="chip-icon sm ${done ? 'teal' : 'gray'}">${icon(ic)}</span>
                    <div class="min-0 grow"><b>${esc(a.title)} · ${esc(a.agreementNo)}</b><small>${esc(a.partyName)} · ${done ? (a.status === 'ACCEPTED' ? `accepted online ${shortDate(String(a.acceptedAt).slice(0, 10))}` : `signed on paper ${shortDate(String(a.acceptedAt).slice(0, 10))}`) : `draft, made ${shortDate(String(a.createdAt).slice(0, 10))}`}</small></div>
                    <span class="badge ${done ? 'good' : 'warning'}">${done ? 'Signed' : 'Waiting'}</span>
                    <button type="button" class="btn sm ghost" data-act="agreement" data-id="${a.id}">${icon('eye')}Open</button></div>`;
            }).join('')}</div>` : '<p class="muted">No agreements yet.</p>'}
            ${manage() && missing.length ? `${section('plus', 'Make')}<div class="cn-ag-list">${missing.map(([k, id, label]) => `<div class="cn-ag"><span class="chip-icon sm gray">${icon(AGREEMENT_KINDS[k][2])}</span>
                <div class="min-0 grow"><b>${esc(label)}</b></div><button type="button" class="btn sm" data-act="make-agreement" data-kind="${k}" ${id != null ? `data-id="${id}"` : ''}>${icon('plus')}Make</button></div>`).join('')}</div>` : ''}
            <p class="muted small">${icon('info')}${p.kind === 'CONTRACT' ? 'Supplementary agreements for extra works are made on the Extra works tab.' : 'A flat’s agreements (for sale, tripartite, sale deed, possession) are made from its sale.'}
                Have the wording reviewed by your advocate for your State; stamp duty depends on the State and the kind of deed.</p></div>`;
    },

    accounts(d) {
        return `<div class="cn-pad">${section('wallet', 'The project’s accounts', `${btn('transfer', 'transfer', 'Move money')}${btn('common', 'plus', 'Common account')}`,
                'its own books, off your personal accounts')}
            <div class="cn-accounts">${d.accounts.map(a => `<div class="cn-account ${a.own ? '' : 'common'}"><span class="chip-icon sm ${['BANK', 'COMMON'].includes(a.role) ? 'aqua' : a.role === 'LOAN' || a.role === 'CAPITAL' || a.role === 'ADVANCES' ? 'coral' : 'gold'}">${icon(
                { BANK: 'bank', COST: 'layers', LAND: 'home', ADVANCES: 'arrow-in', INTEREST: 'percent', PROFIT: 'trending', LOAN: 'bank', CAPITAL: 'users', COMMON: 'bank' }[a.role] || 'wallet')}</span>
                <div class="min-0 grow"><b>${esc(a.name)}</b><small class="muted">${esc(ROLE[a.role] || (a.own ? '' : 'used by this project'))}</small></div><b class="${num(a.balance) < 0 ? 'neg' : ''}">${money(a.balance)}</b></div>`).join('')}</div>
            <p class="muted small">${icon('info')}Until the project closes, what it cost is held as “construction cost” and “land” (work in progress) and what was received as
                “received” (advances). Closing sets them off and shares the profit among the partners; your share becomes your income.
                Every entry is also in the Journal, marked as a project entry.</p></div>`;
    },
};
