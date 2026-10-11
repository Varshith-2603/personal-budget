/**
 * Agreements, on paper and on a phone. No app state: used by Host a Chit, Money lent, and the pages behind the
 * agreement links (chit-share.js, loan-agreement.js).
 *
 *   bondHtml(doc)            the agreement laid out as a stamp-paper deed: the stamp band (or space left for real
 *                            stamp paper), the parties, the terms, the particulars, signatures of both sides and the
 *                            witness, the organiser's round seal, and annexures: ID proof, photograph, the evidence
 *                            of the e-acceptance with its digital signature
 *   printBond(doc, title)    prints it (or saves a PDF) in a window of its own
 *   signaturePad(canvas)     a finger / mouse signature, returned as an SVG path in a 1000 x 300 box
 *   signatureSvg(path)       draws one
 *   deviceInfo(), locate()   what the device says about itself; the location when allowed
 *   openCamera(video)        the live camera (front camera for a selfie), capture() gives a JPEG stamped with the time
 *   shrinkImage(file)        a photo ready to send: upright, at most 1800 px, JPEG
 *   verifyEvidence(...)      checks the installation's ECDSA P-256 signature over the evidence, in this browser
 */

export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DAY = iso => iso ? new Date(String(iso).length === 10 ? iso + 'T00:00:00' : iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : '';
const WHEN = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
const inr = v => `₹${Math.round(Number(v || 0)).toLocaleString('en-IN')}`;

// ---------------------------------------------------------------- signatures

export function signatureSvg(path, { color = '#0a2e4f', cls = '' } = {}) {
    const safe = String(path || '').replace(/[^MLml0-9 .-]/g, '');
    return `<svg viewBox="0 0 1000 300" class="bond-sign ${cls}" role="img" aria-label="Signature"><path d="${safe}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** A signature pad on a canvas; the strokes come back as an SVG path in a 1000 x 300 box. onChange: after each stroke. */
export function signaturePad(canvas, { onChange } = {}) {
    const ctx = canvas.getContext('2d');
    const strokes = [];
    let current = null;
    const pen = () => { ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#0a2e4f'; };
    pen();
    const point = e => {
        const box = canvas.getBoundingClientRect();
        return [Math.round(((e.clientX - box.left) / box.width) * 1000), Math.round(((e.clientY - box.top) / box.height) * 300)];
    };
    canvas.style.touchAction = 'none';
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
    const end = () => { if (current) { current = null; onChange?.(); } };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    return {
        empty: () => strokes.reduce((n, s) => n + s.length, 0) < 6,
        clear: () => { strokes.length = 0; ctx.clearRect(0, 0, canvas.width, canvas.height); pen(); onChange?.(); },
        path: () => strokes.filter(s => s.length > 1).map(s => 'M' + s.map(([x, y]) => `${x} ${y}`).join(' L')).join(' ').slice(0, 20000),
    };
}

/** A pad with its label and a Clear button (markup); bind with bindPad(root, name). */
export function padHtml(name, label, { hint = '' } = {}) {
    return `<div class="bond-pad" data-pad="${esc(name)}">
        <div class="bond-pad-head"><span>${esc(label)}</span>${hint ? `<small>${esc(hint)}</small>` : ''}<button type="button" data-pad-clear>Clear</button></div>
        <canvas width="1000" height="300"></canvas></div>`;
}

export function bindPad(root, name, opts) {
    const box = root.querySelector(`[data-pad="${name}"]`);
    if (!box) return null;
    const pad = signaturePad(box.querySelector('canvas'), opts);
    box.querySelector('[data-pad-clear]').addEventListener('click', () => pad.clear());
    return pad;
}

// ---------------------------------------------------------------- device evidence

/** What this device reports about itself: kept with an acceptance as evidence. */
export function deviceInfo() {
    const n = navigator;
    return {
        userAgent: n.userAgent, platform: n.userAgentData?.platform || n.platform, mobile: n.userAgentData?.mobile ?? /Mobi|Android|iPhone/i.test(n.userAgent),
        language: n.language, languages: (n.languages || []).slice(0, 4), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        timeZoneOffset: new Date().getTimezoneOffset(), localTime: new Date().toString(),
        screen: `${screen.width}x${screen.height}@${window.devicePixelRatio || 1}`, viewport: `${innerWidth}x${innerHeight}`,
        touchPoints: n.maxTouchPoints || 0, cores: n.hardwareConcurrency || null, memoryGb: n.deviceMemory || null,
        connection: n.connection?.effectiveType || null, cookies: n.cookieEnabled, webdriver: !!n.webdriver,
    };
}

/** The location, when allowed (lat,lng,accuracy); null when refused or too slow. */
export function locate() {
    return new Promise(resolve => {
        if (!navigator.geolocation) { resolve(null); return; }
        navigator.geolocation.getCurrentPosition(
            p => resolve(`${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)},${Math.round(p.coords.accuracy)}`),
            () => resolve(null), { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    });
}

/** "Chrome 141 on Android 14" from a user agent. */
export function deviceName(ua = '') {
    const os = /Android ([\d.]+)/.exec(ua)?.[0] || (/iPhone|iPad/.test(ua) ? `iOS ${(/OS ([\d_]+)/.exec(ua)?.[1] || '').replace(/_/g, '.')}` : '')
        || (/Windows NT/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unknown system');
    const browser = /Edg\/(\d+)/.exec(ua) ? `Edge ${/Edg\/(\d+)/.exec(ua)[1]}` : /Chrome\/(\d+)/.exec(ua) ? `Chrome ${/Chrome\/(\d+)/.exec(ua)[1]}`
        : /Firefox\/(\d+)/.exec(ua) ? `Firefox ${/Firefox\/(\d+)/.exec(ua)[1]}` : /Safari\//.test(ua) ? 'Safari' : 'a browser';
    return `${browser} on ${os}`;
}

// ---------------------------------------------------------------- photos

/** A photo ready to upload: upright, at most `max` px, JPEG. PDFs pass as they are. */
export async function shrinkImage(file, max = 1800) {
    if (!file || file.type === 'application/pdf') return file;
    let bitmap;
    try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return file; }
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.86));
    return blob && blob.size < file.size ? blob : file;
}

/**
 * The live camera in a video element (the front camera for a selfie). capture(label) takes a frame as a JPEG with the
 * date, time and label burnt into its foot, so a selfie cannot be swapped for an old photo unnoticed.
 */
export async function openCamera(video, { facing = 'user' } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the camera. Open the link in Chrome or Safari on your phone.');
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false });
    } catch (e) {
        throw new Error(e?.name === 'NotAllowedError' ? 'Allow the camera when your phone asks (or in the browser settings), then try again.'
            : 'The camera could not start. Close other apps using it and try again.');
    }
    video.srcObject = stream;
    video.setAttribute('playsinline', '');
    video.muted = true;
    await video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    return {
        label: track?.label || 'camera',
        stop: () => stream.getTracks().forEach(t => t.stop()),
        capture: async (label = '') => {
            const w = video.videoWidth || 960, h = video.videoHeight || 720;
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d');
            if (facing === 'user') { ctx.translate(w, 0); ctx.scale(-1, 1); }   // as the person saw themselves
            ctx.drawImage(video, 0, 0, w, h);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            const band = Math.max(28, Math.round(h * 0.06));
            ctx.fillStyle = 'rgba(10, 46, 79, 0.72)';
            ctx.fillRect(0, h - band, w, band);
            ctx.fillStyle = '#fff';
            ctx.font = `600 ${Math.round(band * 0.5)}px system-ui, sans-serif`;
            ctx.textBaseline = 'middle';
            ctx.fillText(`${new Date().toLocaleString('en-GB')}${label ? ' · ' + label : ''}`, Math.round(band * 0.4), h - band / 2);
            return new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.88));
        },
    };
}

/** A Blob as a data: URL (images printed in another window). */
export const dataUrl = blob => new Promise(resolve => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => resolve(null);
    r.readAsDataURL(blob);
});

// ---------------------------------------------------------------- digital signature

const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

/** true / false when checked here (ECDSA P-256 with SHA-256, WebCrypto); null when this browser cannot check. */
export async function verifyEvidence(payload, signature, publicKey) {
    if (!payload || !signature || !publicKey || !window.crypto?.subtle) return null;
    try {
        const key = await crypto.subtle.importKey('spki', fromB64(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64(signature), new TextEncoder().encode(payload));
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------- the stamp-paper deed

/** "One Hundred" for the stamp's value (whole rupees up to 99,999). */
function words(n) {
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen',
        'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const two = x => x < 20 ? ones[x] : `${tens[Math.floor(x / 10)]}${x % 10 ? ' ' + ones[x % 10] : ''}`;
    n = Math.round(n);
    const parts = [];
    if (n >= 1000) { parts.push(`${two(Math.floor(n / 1000))} Thousand`); n %= 1000; }
    if (n >= 100) { parts.push(`${ones[Math.floor(n / 100)]} Hundred`); n %= 100; }
    if (n) parts.push(two(n));
    return parts.join(' ') || 'Zero';
}

/** The round rubber seal of the organiser / lender, in violet ink, with their name around the edge. */
export function sealSvg(name, centre = 'SEAL') {
    const text = esc(String(name || '').toUpperCase().slice(0, 34));
    const id = `seal-${Math.random().toString(36).slice(2, 8)}`;
    return `<svg class="bond-seal" viewBox="0 0 200 200" role="img" aria-label="Seal of ${text}">
        <defs><path id="${id}" d="M100,100 m-72,0 a72,72 0 1,1 144,0 a72,72 0 1,1 -144,0"/></defs>
        <circle cx="100" cy="100" r="94" fill="none" stroke="currentColor" stroke-width="5"/>
        <circle cx="100" cy="100" r="84" fill="none" stroke="currentColor" stroke-width="1.6"/>
        <circle cx="100" cy="100" r="50" fill="none" stroke="currentColor" stroke-width="1.6"/>
        <text font-size="15" font-weight="700" letter-spacing="2" fill="currentColor"><textPath href="#${id}" startOffset="50%" text-anchor="middle">★ ${text} ★</textPath></text>
        <text x="100" y="96" text-anchor="middle" font-size="16" font-weight="800" fill="currentColor" letter-spacing="1">${esc(centre)}</text>
        <text x="100" y="116" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">${esc(new Date().getFullYear())}</text>
    </svg>`;
}

/**
 * The deed. doc: { kind: 'LOAN' | 'CHIT', title, number, date, place, stampDuty, stampSerial, realStampPaper,
 *   firstParty: { role, name, address, phone, signature, seal }, secondParty: { role, name, address, phone, signature,
 *   accepted }, witness: { name, phone, address, signature }, intro, terms (text, one clause a line), particulars:
 *   [[label, value]], fingerprint, annexures: [{ title, images: [{ src, caption }] }], evidence: [[label, value]],
 *   digital: { payload, signature, fingerprint, verified }, footnote }
 */
export function bondHtml(doc) {
    const duty = Number(doc.stampDuty || 0);
    const stamp = doc.realStampPaper
        ? `<div class="bond-blank-top"><span>Space for the stamp${duty ? ` (₹${duty})` : ''}${doc.stampSerial ? ` · No. ${esc(doc.stampSerial)}` : ''}</span></div>`
        : `<div class="bond-stamp">
            <div class="bond-stamp-band">
                <div class="bond-stamp-left"><b>NON-JUDICIAL</b><small>STAMP PAPER · AGREEMENT</small></div>
                <div class="bond-stamp-value"><small>Rupees</small><b>${duty ? `₹${duty.toLocaleString('en-IN')}` : '₹ —'}</b><em>${duty ? `${words(duty)} only` : 'value not set'}</em></div>
                <div class="bond-stamp-right"><small>Serial no.</small><b>${esc(doc.stampSerial || '—')}</b><small>${esc(DAY(doc.date))}</small></div>
            </div>
            <div class="bond-stamp-note">${duty ? `Executed on non-judicial stamp paper of ₹${duty}` : 'Stamp-paper style copy'}${doc.stampSerial ? ` bearing serial no. ${esc(doc.stampSerial)}` : ''}.
                ${esc(doc.firstParty?.role || '')} and ${esc(doc.secondParty?.role || '')} have signed every page.</div>
        </div>`;
    const party = (p, label) => p ? `<div class="bond-party"><small>${esc(label)}</small><b>${esc(p.name || '')}</b>
        ${p.address ? `<span>${esc(p.address)}</span>` : ''}${p.phone ? `<span>Mobile ${esc(p.phone)}</span>` : ''}</div>` : '';
    const signBox = (p, label, { seal = null, thumb = false } = {}) => `<div class="bond-signbox">
        <div class="bond-signspace">${p?.signature ? signatureSvg(p.signature) : ''}${seal ? `<span class="bond-seal-wrap">${sealSvg(seal, label === 'Witness' ? 'WITNESS' : 'SEAL')}</span>` : ''}</div>
        <div class="bond-signline"><b>${esc(p?.name || '')}</b><small>${esc(label)}${p?.accepted ? ` · ${esc(p.accepted)}` : ''}</small></div>
        ${thumb ? '<div class="bond-thumb"><span>Left thumb impression</span></div>' : ''}
        ${p?.address ? `<small class="bond-signaddr">${esc(p.address)}</small>` : ''}
    </div>`;
    const clauses = String(doc.terms || '').split('\n').filter(l => l.trim()).map(l => {
        const m = /^(\d+)\.\s*(.*)$/.exec(l.trim());
        return m ? `<li value="${m[1]}">${esc(m[2])}</li>` : `<li>${esc(l.trim())}</li>`;
    }).join('');
    const annex = (doc.annexures || []).filter(a => a.images?.length || a.rows?.length);
    return `<article class="bond ${doc.realStampPaper ? 'real' : ''}">
        <section class="bond-page">
            ${stamp}
            <h1 class="bond-title">${esc(doc.title)}</h1>
            <p class="bond-no">${esc(doc.number || '')}${doc.date ? ` · ${esc(DAY(doc.date))}` : ''}${doc.place ? ` · ${esc(doc.place)}` : ''}</p>
            <p class="bond-intro">${esc(doc.intro || '')}</p>
            <div class="bond-parties">${party(doc.firstParty, doc.firstParty?.role)}<i>and</i>${party(doc.secondParty, doc.secondParty?.role)}</div>
            ${doc.particulars?.length ? `<table class="bond-facts"><tbody>${doc.particulars.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>` : ''}
            <p class="bond-sub">Now it is agreed as follows:</p>
            <ol class="bond-terms">${clauses}</ol>
            <p class="bond-witness-line">In witness whereof the parties have signed this agreement on the date and at the place written above, in the presence of the witness below.</p>
            <div class="bond-signs">
                ${signBox(doc.firstParty, doc.firstParty?.role || 'First party', { seal: doc.firstParty?.seal })}
                ${signBox(doc.secondParty, doc.secondParty?.role || 'Second party', { thumb: !doc.secondParty?.signature })}
            </div>
            <div class="bond-signs one">${signBox(doc.witness?.name ? doc.witness : { name: '' }, 'Witness')}</div>
            <p class="bond-foot">Agreement fingerprint (SHA-256): <code>${esc(doc.fingerprint || '')}</code>${doc.footnote ? `<br>${esc(doc.footnote)}` : ''}</p>
        </section>
        ${annex.map((a, i) => `<section class="bond-page bond-annex">
            <h2>Annexure ${String.fromCharCode(65 + i)} · ${esc(a.title)}</h2>
            ${a.note ? `<p class="bond-annex-note">${esc(a.note)}</p>` : ''}
            ${a.images?.length ? `<div class="bond-annex-imgs">${a.images.map(im => `<figure>${im.pdf
                ? `<div class="bond-annex-pdf">PDF · ${esc(im.caption)}<br><small>attached separately</small></div>`
                : `<img src="${esc(im.src)}" alt="${esc(im.caption)}">`}<figcaption>${esc(im.caption)}${im.hash ? `<br><code>SHA-256 ${esc(im.hash.slice(0, 32))}…</code>` : ''}</figcaption></figure>`).join('')}</div>` : ''}
            ${a.rows?.length ? `<table class="bond-facts ev"><tbody>${a.rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</tbody></table>` : ''}
            <div class="bond-annex-sign">${doc.secondParty?.signature ? signatureSvg(doc.secondParty.signature) : ''}<small>${esc(doc.secondParty?.name || '')} · self-attested</small></div>
        </section>`).join('')}
    </article>`;
}

/** The evidence of an e-acceptance as rows for an annexure (values are HTML-safe). */
export function evidenceRows(e) {
    const dev = (() => { try { return JSON.parse(e.device || '{}'); } catch { return {}; } })();
    const [lat, lng, acc] = String(e.location || '').split(',');
    const rows = [
        ['Accepted by', esc(e.name || '')],
        ['Accepted at (server time)', esc(WHEN(e.at))],
        e.phone ? ['Mobile number', `${esc(e.phone)}${e.phoneMatches === true ? ' · matches the number on record' : e.phoneMatches === false ? ' · differs from the record' : ''}`] : null,
        e.aadhaarLast4 ? ['Aadhaar', `XXXX XXXX ${esc(e.aadhaarLast4)} (verified check digit)`] : null,
        e.pan ? ['PAN', esc(e.pan)] : null,
        e.ip ? ['IP address', esc(e.ip)] : null,
        ['Device', esc(deviceName(dev.userAgent || e.userAgent || ''))],
        dev.screen ? ['Screen · language · time zone', `${esc(dev.screen)} · ${esc(dev.language || '')} · ${esc(dev.timeZone || '')}`] : null,
        dev.localTime ? ['Device clock', esc(String(dev.localTime).replace(/ \(.*\)$/, ''))] : null,
        ['Location', lat ? `${esc(lat)}, ${esc(lng)} (±${esc(acc || '?')} m)` : 'not shared'],
        e.deviceHash ? ['Device fingerprint', `<code>${esc(e.deviceHash)}</code>`] : null,
        e.seal ? ['Acceptance seal (SHA-256)', `<code>${esc(e.seal)}</code>`] : null,
        e.digitalSignature ? ['Digital signature (ECDSA P-256)', `<code>${esc(e.digitalSignature.slice(0, 44))}…</code>${e.keyFingerprint ? `<br>key ${esc(e.keyFingerprint)}` : ''}${e.verified === true ? ' · <b>verified</b>' : ''}`] : null,
    ];
    return rows.filter(Boolean);
}

/** Prints the deed in a window of its own (only the deed's stylesheet), once its images have loaded. */
export function printBond(doc, title) {
    const win = window.open('', '_blank', 'width=900,height=1000');
    if (!win) throw new Error('Allow pop-ups for this site to print the agreement');
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
        <link rel="stylesheet" href="${location.origin}/css/bond.css"></head><body class="bond-print">${bondHtml(doc)}</body></html>`);
    win.document.close();
    const go = () => {
        const imgs = [...win.document.images];
        Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; }))).then(() => setTimeout(() => win.print(), 250));
    };
    if (win.document.readyState === 'complete') go(); else win.addEventListener('load', go);
}

export { inr as bondMoney, DAY as bondDay, WHEN as bondWhen };
