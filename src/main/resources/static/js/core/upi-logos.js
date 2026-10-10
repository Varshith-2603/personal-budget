/**
 * Brand marks of the UPI apps (as inline SVG), for "Pay with …" buttons and "accepted here" strips.
 * Each is drawn in the app's colours: Google Pay's four-colour G, PhonePe's purple mark, Paytm's two-tone
 * wordmark, BHIM's saffron-and-green arrow, and the UPI mark.
 */

const G = `<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>`;

/** The UPI arrow: a saffron and a green chevron. */
const ARROW = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})">
<path fill="#F47920" d="M10 0 22 24 10 48 14 24z"/><path fill="#1E8F3C" d="M0 0 12 24 0 48 4 24z"/></g>`;

const FONT = `font-family="'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"`;

export const UPI_LOGOS = {
    gpay: { name: 'Google Pay', svg: `<svg viewBox="0 0 112 48" role="img" aria-label="Google Pay">${G}
        <text x="56" y="36" ${FONT} font-size="31" font-weight="500" fill="#5F6368">Pay</text></svg>` },
    phonepe: { name: 'PhonePe', svg: `<svg viewBox="0 0 168 48" role="img" aria-label="PhonePe">
        <circle cx="24" cy="24" r="23" fill="#5F259F"/>
        <path fill="#fff" d="M15 15h19v4.2h-5.6v15.6c0 2.6-1.8 4.2-4.6 4.2h-1.6v-4.1h.9c.8 0 1.2-.4 1.2-1.2V30.4c-1.3.6-2.7.9-4.2.9-4 0-6.6-2.4-6.6-6.3V19.2H11V15zm8.6 4.2v5.6c0 1.8 1 2.8 2.7 2.8.8 0 1.6-.2 2.2-.6V19.2z"/>
        <text x="54" y="34" ${FONT} font-size="26" font-weight="700" fill="#5F259F">PhonePe</text></svg>` },
    paytm: { name: 'Paytm', svg: `<svg viewBox="0 0 116 48" role="img" aria-label="Paytm">
        <text x="2" y="35" ${FONT} font-size="34" font-weight="800" letter-spacing="-1" fill="#002E6E">pay<tspan fill="#00BAF2">tm</tspan></text></svg>` },
    bhim: { name: 'BHIM', svg: `<svg viewBox="0 0 128 48" role="img" aria-label="BHIM UPI">${ARROW(2, 4, 0.83)}
        <text x="30" y="35" ${FONT} font-size="30" font-weight="800" letter-spacing="1" fill="#1D3557">BHIM</text></svg>` },
    upi: { name: 'UPI', svg: `<svg viewBox="0 0 96 48" role="img" aria-label="UPI">
        <text x="2" y="36" ${FONT} font-size="33" font-style="italic" font-weight="800" fill="#5F6368">UPI</text>${ARROW(64, 6, 0.75)}</svg>` },
};

/** One app's mark, e.g. logo('gpay'). */
export function upiLogo(key, cls = '') {
    const l = UPI_LOGOS[key];
    return l ? `<span class="upi-logo ${key} ${cls}" title="${l.name}">${l.svg}</span>` : '';
}

/** "Pay with any UPI app" strip: the marks side by side. */
export function upiLogoStrip(keys = ['gpay', 'phonepe', 'paytm', 'bhim', 'upi']) {
    return `<span class="upi-logos">${keys.map(k => upiLogo(k)).join('')}</span>`;
}
