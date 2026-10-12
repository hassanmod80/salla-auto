// CHINA PARTS - Core Frontend Application
// Connects to Laravel Headless API & Salla Checkout

function resolveApiBase() {
    if (typeof window.API_BASE === 'string' && window.API_BASE.trim()) {
        return window.API_BASE.trim().replace(/\/$/, '');
    }
    // Same-origin whenever UI + API are served together (local or production HTTPS).
    if (typeof location !== 'undefined' && /^https?:$/i.test(location.protocol)) {
        return `${location.origin}/api`;
    }
    const stored = localStorage.getItem('qetaa_api_base');
    if (stored && /^https?:\/\//i.test(stored)) {
        return stored.replace(/\/$/, '');
    }
    return '/api';
}

const API_BASE = resolveApiBase();
const SALLA_CART_URL = window.SALLA_CART_URL || localStorage.getItem('qetaa_salla_cart_url') || '';
const WHATSAPP_NUMBER = (() => {
    const preferred = String(window.WHATSAPP_NUMBER || '966563156460').replace(/\D/g, '');
    const cached = String(localStorage.getItem('qetaa_whatsapp') || '').replace(/\D/g, '');
    // Drop stale wrong number if it was saved earlier.
    if (cached && cached !== '966503156460' && cached !== '0503156460' && cached !== '503156460') {
        return cached;
    }
    if (cached === '966503156460' || cached === '0503156460' || cached === '503156460') {
        localStorage.setItem('qetaa_whatsapp', preferred);
    }
    return preferred || '966563156460';
})();
let SALLA_LIVE = false;
let ZID_LIVE = window.ZID_LIVE === true || (window.ZID_LIVE !== false && localStorage.getItem('qetaa_zid_live') === '1');
if (window.ZID_LIVE === false) {
    ZID_LIVE = false;
    localStorage.setItem('qetaa_zid_live', '0');
}
async function refreshZidLiveFlag() {
    // Explicit page/HTML off wins (Salla-first storefront).
    if (window.ZID_LIVE === false || localStorage.getItem('qetaa_zid_live') === '0') {
        ZID_LIVE = false;
        window.ZID_LIVE = false;
        localStorage.setItem('qetaa_zid_live', '0');
        return false;
    }
    if (window.ZID_LIVE === true || localStorage.getItem('qetaa_zid_live') === '1') {
        ZID_LIVE = true;
        return true;
    }
    try {
        const status = await apiJson('/zid/status');
        if (status?.checkout_ready || status?.live_recommended) {
            localStorage.setItem('qetaa_zid_live', '1');
            ZID_LIVE = true;
            window.ZID_LIVE = true;
            return true;
        }
    } catch (error) {
        console.warn('zid status check failed', error);
    }
    return ZID_LIVE;
}

async function refreshSallaLiveFlag() {
    // Manual override: localStorage qetaa_salla_live=0 keeps WhatsApp-only mode.
    if (localStorage.getItem('qetaa_salla_live') === '0') {
        SALLA_LIVE = false;
        window.SALLA_LIVE = false;
        return false;
    }
    try {
        const status = await apiJson('/salla/status');
        if (status?.checkout_ready || status?.live_recommended) {
            localStorage.setItem('qetaa_salla_live', '1');
            SALLA_LIVE = true;
            window.SALLA_LIVE = true;
            return true;
        }
        localStorage.removeItem('qetaa_salla_live');
        SALLA_LIVE = false;
        window.SALLA_LIVE = false;
    } catch (error) {
        console.warn('salla status check failed', error);
        SALLA_LIVE = false;
        window.SALLA_LIVE = false;
    }
    return false;
}

function isOnlineCheckoutEnabled() {
    return Boolean(ZID_LIVE || SALLA_LIVE);
}

// Thin stroke icons (header + product actions)
const UI_ICON = {
    heart: `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12 20.25S3.75 14.9 3.75 9.6A4.35 4.35 0 0 1 8.2 5.2c1.45 0 2.72.66 3.8 1.9 1.08-1.24 2.35-1.9 3.8-1.9a4.35 4.35 0 0 1 4.45 4.4c0 5.3-8.25 10.65-8.25 10.65Z"/></svg>`,
    heartOutline: `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M12.001 20.25S3.75 14.9 3.75 9.6A4.35 4.35 0 0 1 8.2 5.2c1.45 0 2.72.66 3.8 1.9 1.08-1.24 2.35-1.9 3.8-1.9a4.35 4.35 0 0 1 4.45 4.4c0 5.3-8.25 10.65-8.25 10.65Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    heartCard: `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M12 20.2S4 14.9 4 9.7A4.2 4.2 0 0 1 8.3 5.4c1.4 0 2.6.65 3.7 1.9 1.1-1.25 2.3-1.9 3.7-1.9A4.2 4.2 0 0 1 20 9.7c0 5.2-8 10.5-8 10.5Z" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    compare: `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M7 19V9M12 19V5M17 19v-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M5 19h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    compareCard: `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M7 19V10M12 19V5M17 19v-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M4.5 19h15" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`,
    bag: `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M6.4 8.5h11.2l-.85 10.1a1.4 1.4 0 0 1-1.39 1.25H8.64a1.4 1.4 0 0 1-1.39-1.25L6.4 8.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9.2 8.5V7.4A2.8 2.8 0 0 1 12 4.6a2.8 2.8 0 0 1 2.8 2.8v1.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    cartPlus: `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M3.6 4.5h1.55l1.55 9.55a1.35 1.35 0 0 0 1.33 1.12h8.05a1.35 1.35 0 0 0 1.33-1.1L18.8 8.2H7.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9.4" cy="19.1" r="1.15" fill="currentColor"/><circle cx="16" cy="19.1" r="1.15" fill="currentColor"/><path d="M14.1 4.8v3.6M12.3 6.6h3.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    bolt: `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M13 2.8 5.8 13.2h5.1L10.2 21.2 18.2 10h-5.4L13 2.8Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    menu: `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M4.5 7h15M4.5 12h15M4.5 17h15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    globe: `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.5"/><path d="M4 12h16M12 4c2.2 2.5 3.3 5.1 3.3 8s-1.1 5.5-3.3 8c-2.2-2.5-3.3-5.1-3.3-8S9.8 6.5 12 4Z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    whatsapp: `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M12.04 2.2A9.7 9.7 0 0 0 2.3 14.9L1 22l7.3-1.9A9.7 9.7 0 1 0 12.04 2.2Zm0 1.7a8 8 0 0 1 6.8 12.2l-.3.45.4 1.5-1.5-.4-.44.26a8 8 0 0 1-11.8-6.8 8 8 0 0 1 6.84-7.21Zm4.5 10.2c-.2-.1-1.16-.57-1.34-.64-.18-.07-.31-.1-.44.1-.13.2-.5.64-.62.77-.11.13-.23.15-.42.05-.2-.1-.83-.3-1.58-.97-.58-.52-.97-1.16-1.08-1.36-.12-.2-.01-.3.09-.4.09-.09.2-.23.3-.34.1-.12.13-.2.2-.33.06-.13.03-.24-.02-.34-.05-.1-.44-1.06-.6-1.45-.16-.38-.32-.33-.44-.33h-.38c-.13 0-.34.05-.52.24-.18.2-.68.67-.68 1.63s.7 1.9.8 2.03c.1.13 1.38 2.11 3.35 2.96 1.97.85 1.97.57 2.33.53.36-.04 1.16-.47 1.32-.93.16-.46.16-.85.11-.93-.04-.08-.18-.13-.37-.23Z"/></svg>`,
    search: `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="6.1" stroke="currentColor" stroke-width="1.5"/><path d="m16.1 16.1 3.9 3.9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    car: `<svg class="ui-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><path d="M4.2 14.2 5.5 9.7A1.8 1.8 0 0 1 7.25 8.4h9.5a1.8 1.8 0 0 1 1.75 1.3l1.3 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M4.8 14.2h14.4a1.3 1.3 0 0 1 1.3 1.35v1a.9.9 0 0 1-.9.9h-.85a2 2 0 0 1-3.9 0H9.15a2 2 0 0 1-3.9 0h-.85a.9.9 0 0 1-.9-.9v-1a1.3 1.3 0 0 1 1.3-1.35Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
};

const UI_ICON_VERSION = 'v4';

function uiIcon(name) {
    return UI_ICON[name] || '';
}

function polishHeaderChromeIcons() {
    const map = [
        ['.cart-trigger', 'bag'],
        ['.mobile-menu-btn', 'menu'],
        ['.lang-switcher-btn', 'globe'],
        ['.favorites-trigger', 'heartOutline'],
        ['.compare-trigger', 'compare'],
        ['.global-search-input > i.fa-magnifying-glass, .global-search-input > .ui-icon', 'search'],
    ];
    map.forEach(([sel, icon]) => {
        document.querySelectorAll(sel).forEach((el) => {
            const existing = el.matches('svg.ui-icon') ? el : el.querySelector(':scope > .ui-icon');
            if (existing && existing.getAttribute('data-ui') === `${UI_ICON_VERSION}:${icon}`) return;
            // Search field: replace FA <i> (or old SVG) so ::before + SVG never both show.
            if (sel.includes('global-search')) {
                const wrap = document.createElement('span');
                wrap.innerHTML = uiIcon(icon);
                const next = wrap.firstElementChild;
                if (!next) return;
                next.setAttribute('data-ui', `${UI_ICON_VERSION}:${icon}`);
                el.replaceWith(next);
                return;
            }
            if (el.matches('svg.ui-icon')) {
                const wrap = document.createElement('span');
                wrap.innerHTML = uiIcon(icon);
                const next = wrap.firstElementChild;
                if (!next) return;
                next.setAttribute('data-ui', `${UI_ICON_VERSION}:${icon}`);
                el.replaceWith(next);
                return;
            }
            const badge = el.querySelector('.badge');
            const label = el.querySelector('.lang-label');
            el.innerHTML = uiIcon(icon) + (label ? label.outerHTML : '') + (badge ? badge.outerHTML : '');
            el.querySelector('.ui-icon')?.setAttribute('data-ui', `${UI_ICON_VERSION}:${icon}`);
        });
    });
    document.querySelectorAll('.header-wa-trigger').forEach((el) => el.remove());
}

// Chinese car brands showcase (homepage logos)
const CHINESE_BRANDS_CATALOG = [
    { slug: 'changan', name_ar: 'شانجان', name_en: 'Changan', domain: 'changan.com', logoFile: 'changan-logo.png' },
    { slug: 'geely', name_ar: 'جيلي', name_en: 'Geely', domain: 'geely.com', logoFile: 'geely-logo.png' },
    { slug: 'haval', name_ar: 'هافال', name_en: 'Haval', domain: 'haval.com', logoFile: 'haval-logo.png' },
    { slug: 'mg', name_ar: 'إم جي', name_en: 'MG', domain: 'mg.co.uk', logoFile: 'mg-logo.png' },
    { slug: 'chery', name_ar: 'شيري', name_en: 'Chery', domain: 'cheryinternational.com', logoFile: 'chery-logo.png' },
    { slug: 'byd', name_ar: 'بي واي دي', name_en: 'BYD', domain: 'byd.com', logoFile: 'byd-logo.png' },
    { slug: 'tank', name_ar: 'تانك', name_en: 'Tank', domain: 'haval.com', logoFile: 'great-wall-logo.png' },
    { slug: 'jetour', name_ar: 'جيتور', name_en: 'Jetour', domain: 'jetourglobal.com', logoFile: null },
    { slug: 'exeed', name_ar: 'إكسيد', name_en: 'Exeed', domain: 'exeedcars.com', logoFile: 'exeed-logo.png' },
    { slug: 'omoda', name_ar: 'أومودا', name_en: 'Omoda', domain: 'omodacars.com', logoFile: null },
    { slug: 'jaecoo', name_ar: 'جايكو', name_en: 'Jaecoo', domain: 'jaecoo.com', logoFile: null },
    { slug: 'gac', name_ar: 'جي أيه سي', name_en: 'GAC', domain: 'gac-motor.com', logoFile: 'gac-logo.png' },
    { slug: 'jac', name_ar: 'جاك', name_en: 'JAC', domain: 'jac.com.cn', logoFile: 'jac-logo.png' },
    { slug: 'maxus', name_ar: 'ماكسوس', name_en: 'Maxus', domain: 'saicmaxus.com', logoFile: 'maxus-logo.png' },
    { slug: 'great-wall', name_ar: 'جريت وول', name_en: 'Great Wall', domain: 'gwm.com.cn', logoFile: 'great-wall-logo.png' },
    { slug: 'gwm', name_ar: 'جي دبليو إم', name_en: 'GWM', domain: 'gwm.com.cn', logoFile: 'great-wall-logo.png' },
    { slug: 'baic', name_ar: 'بايك', name_en: 'BAIC', domain: 'baicgroup.com', logoFile: 'baic-logo.png' },
    { slug: 'dongfeng', name_ar: 'دونغفينغ', name_en: 'Dongfeng', domain: 'dfmc.com.cn', logoFile: 'dongfeng-logo.png' },
    { slug: 'bestune', name_ar: 'بيستون', name_en: 'Bestune', domain: 'bestune.com', logoFile: 'bestune-logo.png' },
    { slug: 'forthing', name_ar: 'فورثينغ', name_en: 'Forthing', domain: 'forthingmotor.com', logoFile: null },
    { slug: 'hongqi', name_ar: 'هونغتشي', name_en: 'Hongqi', domain: 'hongqi-auto.com', logoFile: 'hongqi-logo.png' },
    { slug: 'zeekr', name_ar: 'زيكر', name_en: 'Zeekr', domain: 'zeekr.com', logoFile: 'zeekr-logo.png' },
    { slug: 'lynk-co', name_ar: 'لينك آند كو', name_en: 'Lynk & Co', domain: 'lynkco.com', logoFile: 'lynk-co.png' },
    { slug: 'leapmotor', name_ar: 'ليب موتور', name_en: 'Leapmotor', domain: 'leapmotor.com', logoFile: 'leapmotor-logo.png' },
    { slug: 'wuling', name_ar: 'وولينغ', name_en: 'Wuling', domain: 'sgmw.com.cn', logoFile: 'wuling-logo.png' },
    { slug: 'kaiyi', name_ar: 'كايي', name_en: 'Kaiyi', domain: 'kaiyimotor.com', logoFile: null },
    { slug: 'swm', name_ar: 'إس دبليو إم', name_en: 'SWM', domain: 'swmmotors.com', logoFile: null },
    { slug: 'foton', name_ar: 'فوتون', name_en: 'Foton', domain: 'foton-global.com', logoFile: 'foton-logo.png' },
    { slug: 'dfsk', name_ar: 'دي إف إس كيه', name_en: 'DFSK', domain: 'dfsk.com', logoFile: null },
    { slug: 'soueast', name_ar: 'ساوث إيست', name_en: 'SOUEAST', domain: 'soueast-motor.com', logoFile: 'soueast-logo.png' },
    { slug: 'jmc', name_ar: 'جي إم سي', name_en: 'JMC', domain: 'jmc.com.cn', logoFile: null },
    { slug: 'zotye', name_ar: 'زوتي', name_en: 'Zotye', domain: 'zotye.com', logoFile: 'zotye-logo.png' },
    { slug: 'lifan', name_ar: 'ليفان', name_en: 'Lifan', domain: 'lifan.com', logoFile: 'lifan-logo.png' },
];

const HOME_BRANDS_INITIAL = 12;

// Curated shop departments — avoid dumping 500+ raw API categories on the homepage
// Official Material Design Icons (Pictogrammers) — automotive set
const CATEGORY_ICONS = {
    brakes: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M24,12C24,15.31 22.66,18.31 20.5,20.5L19.42,19.42C21.32,17.5 22.5,14.9 22.5,12C22.5,9.11 21.32,6.5 19.42,4.58L20.5,3.5C22.66,5.69 24,8.69 24,12M20,9.6V8H16.8C15.92,8 15.2,8.72 15.2,9.6V11.2A1.6,1.6 0 0,0 16.8,12.8H18.4V14.4H15.2V16H18.4C19.28,16 20,15.28 20,14.4V12.8A1.6,1.6 0 0,0 18.4,11.2H16.8V9.6H20M8.42,6C9.47,5.37 10.69,5 12,5C13.31,5 14.53,5.37 15.58,6H18.69C17.05,4.16 14.66,3 12,3C9.34,3 6.95,4.16 5.31,6H8.42M13.2,12C13.84,12 14.4,12.56 14.4,13.2V14.4A1.6,1.6 0 0,1 12.8,16H9.6V8H12.8A1.6,1.6 0 0,1 14.4,9.6V10.8C14.4,11.44 13.84,12 13.2,12M12.8,12.8H11.2V14.4H12.8V12.8M12.8,9.6H11.2V11.2H12.8V9.6M4.58,4.58L3.5,3.5C1.34,5.69 0,8.69 0,12C0,15.31 1.34,18.31 3.5,20.5L4.58,19.42C2.68,17.5 1.5,14.9 1.5,12C1.5,9.11 2.68,6.5 4.58,4.58M7.2,16V12.8H5.6V16H4V9.6A1.6,1.6 0 0,1 5.6,8H7.2C8.08,8 8.8,8.72 8.8,9.6V16H7.2M7.2,11.2V9.6H5.6V11.2H7.2M15.58,18C14.53,18.63 13.31,19 12,19C10.69,19 9.47,18.63 8.42,18H5.31C6.95,19.84 9.34,21 12,21C14.66,21 17.05,19.84 18.69,18H15.58Z"/></svg>`,
    engine: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7,4V6H10V8H7L5,10V13H3V10H1V18H3V15H5V18H8L10,20H18V16H20V19H23V9H20V12H18V8H12V6H15V4H7Z"/></svg>`,
    filters: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19,18.31V20A2,2 0 0,1 17,22H7A2,2 0 0,1 5,20V16.3C4.54,16.12 3.95,16 3,16A1,1 0 0,1 2,15A1,1 0 0,1 3,14C3.82,14 4.47,14.08 5,14.21V12.3C4.54,12.12 3.95,12 3,12A1,1 0 0,1 2,11A1,1 0 0,1 3,10C3.82,10 4.47,10.08 5,10.21V8.3C4.54,8.12 3.95,8 3,8A1,1 0 0,1 2,7A1,1 0 0,1 3,6C3.82,6 4.47,6.08 5,6.21V4A2,2 0 0,1 7,2H17A2,2 0 0,1 19,4V6.16C20.78,6.47 21.54,7.13 21.71,7.29C22.1,7.68 22.1,8.32 21.71,8.71C21.32,9.1 20.8,9.09 20.29,8.71V8.71C20.29,8.71 19.25,8 17,8C15.74,8 14.91,8.41 13.95,8.9C12.91,9.41 11.74,10 10,10C9.64,10 9.31,10 9,9.96V7.95C9.3,8 9.63,8 10,8C11.26,8 12.09,7.59 13.05,7.11C14.09,6.59 15.27,6 17,6V4H7V20H17V18C18.5,18 18.97,18.29 19,18.31M17,10C15.27,10 14.09,10.59 13.05,11.11C12.09,11.59 11.26,12 10,12C9.63,12 9.3,12 9,11.95V13.96C9.31,14 9.64,14 10,14C11.74,14 12.91,13.41 13.95,12.9C14.91,12.42 15.74,12 17,12C19.25,12 20.29,12.71 20.29,12.71V12.71C20.8,13.1 21.32,13.1 21.71,12.71C22.1,12.32 22.1,11.69 21.71,11.29C21.5,11.08 20.25,10 17,10M17,14C15.27,14 14.09,14.59 13.05,15.11C12.09,15.59 11.26,16 10,16C9.63,16 9.3,16 9,15.95V17.96C9.31,18 9.64,18 10,18C11.74,18 12.91,17.41 13.95,16.9C14.91,16.42 15.74,16 17,16C19.25,16 20.29,16.71 20.29,16.71V16.71C20.8,17.1 21.32,17.1 21.71,16.71C22.1,16.32 22.1,15.69 21.71,15.29C21.5,15.08 20.25,14 17,14Z"/></svg>`,
    suspension: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9.5,11H10.5C10.8,11 11,10.8 11,10.5V9H19V10.5C19,10.8 19.2,11 19.5,11H20.5C20.8,11 21,10.8 21,10.5V9L21,8.5V6L19.6,1.7C19.5,1.3 19.1,1 18.7,1H11.4C11,1 10.6,1.3 10.5,1.7L9,6V8.5L9,9V10.5C9,10.8 9.2,11 9.5,11M11.3,2H18.6L19.5,5H10.4L11.3,2M12,23H10C10,22.2 8.1,21.5 6.6,20.9C4.5,20.1 2,19.2 2,17C2,14.7 4.3,14.1 6.2,13.5C7.9,13.1 9,12.7 9,12H11C11,14.3 8.7,14.9 6.8,15.5C5.1,15.9 4,16.3 4,17C4,17.8 5.9,18.5 7.4,19.1C9.5,19.9 12,20.8 12,23M22,23H20C20,22.2 18.1,21.5 16.6,20.9C14.5,20.1 12,19.2 12,17C12,14.7 14.3,14.1 16.2,13.5C17.8,13 19,12.7 19,12H21C21,14.3 18.7,14.9 16.8,15.5C15.2,15.9 14,16.3 14,17C14,17.8 15.9,18.5 17.4,19.1C19.5,19.9 22,20.8 22,23Z"/></svg>`,
    cooling: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.95,3L6.53,5.19L7.95,7.4H7.94L5.95,10.5L4.22,9.6L5.64,7.39L4.22,5.19L6.22,2.09L7.95,3M13.95,2.89L12.53,5.1L13.95,7.3L13.94,7.31L11.95,10.4L10.22,9.5L11.64,7.3L10.22,5.1L12.22,2L13.95,2.89M20,2.89L18.56,5.1L20,7.3V7.31L18,10.4L16.25,9.5L17.67,7.3L16.25,5.1L18.25,2L20,2.89M2,22V14A2,2 0 0,1 4,12H20A2,2 0 0,1 22,14V22H20V20H4V22H2M6,14A1,1 0 0,0 5,15V17A1,1 0 0,0 6,18A1,1 0 0,0 7,17V15A1,1 0 0,0 6,14M10,14A1,1 0 0,0 9,15V17A1,1 0 0,0 10,18A1,1 0 0,0 11,17V15A1,1 0 0,0 10,14M14,14A1,1 0 0,0 13,15V17A1,1 0 0,0 14,18A1,1 0 0,0 15,17V15A1,1 0 0,0 14,14M18,14A1,1 0 0,0 17,15V17A1,1 0 0,0 18,18A1,1 0 0,0 19,17V15A1,1 0 0,0 18,14Z"/></svg>`,
    lighting: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13,4.8C9,4.8 9,19.2 13,19.2C17,19.2 22,16.5 22,12C22,7.5 17,4.8 13,4.8M13.1,17.2C12.7,16.8 12,15 12,12C12,9 12.7,7.2 13.1,6.8C16,6.9 20,8.7 20,12C20,15.3 16,17.1 13.1,17.2M2,5H9.5C9.3,5.4 9,5.8 8.9,6.4C8.8,6.6 8.8,6.8 8.7,7H2V5M8,11H2V9H8.2C8.1,9.6 8.1,10.3 8,11M8.7,17C8.9,17.8 9.2,18.4 9.6,19H2.1V17H8.7M8.2,15H2V13H8C8.1,13.7 8.1,14.4 8.2,15Z"/></svg>`,
    body: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M16,6L19,10H21C22.11,10 23,10.89 23,12V15H21A3,3 0 0,1 18,18A3,3 0 0,1 15,15H9A3,3 0 0,1 6,18A3,3 0 0,1 3,15H1V12C1,10.89 1.89,10 3,10L6,6H16M10.5,7.5H6.75L4.86,10H10.5V7.5M12,7.5V10H17.14L15.25,7.5H12M6,13.5A1.5,1.5 0 0,0 4.5,15A1.5,1.5 0 0,0 6,16.5A1.5,1.5 0 0,0 7.5,15A1.5,1.5 0 0,0 6,13.5M18,13.5A1.5,1.5 0 0,0 16.5,15A1.5,1.5 0 0,0 18,16.5A1.5,1.5 0 0,0 19.5,15A1.5,1.5 0 0,0 18,13.5Z"/></svg>`,
    ignition: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11 15H6L13 1V9H18L11 23V15Z"/></svg>`,
};

const HOME_FEATURED_CATEGORIES = [
    { key: 'brakes', name_ar: 'نظام الفرامل', short_ar: 'الفرامل', name_en: 'Brakes', match: ['brake-pads', 'brake-rotors', 'brake-disc', 'brake-sensor', 'brake-hose', 'fhmat-framl', 'brakes'] },
    { key: 'engine', name_ar: 'أجزاء المحرك', short_ar: 'المحرك', name_en: 'Engine', match: ['drive-belt', 'ac-compressor', 'engine-belts', 'water-pumps', 'syor-mhrk', 'engine'] },
    { key: 'filters', name_ar: 'الفلاتر', short_ar: 'الفلاتر', name_en: 'Filters', match: ['engine-oil-filter', 'engine-air-filter', 'cabin-air-filter', 'fuel-filter', 'oil-filters', 'air-filters', 'cabin-filters', 'flatr-zyt', 'flatr-hoaaa', 'filters'] },
    { key: 'suspension', name_ar: 'المساعدات والتعليق', short_ar: 'التعليق', name_en: 'Suspension', match: ['shock-absorber', 'stabilizer-bar-link', 'control-arm', 'shock-absorbers', 'msaaadat', 'suspension'] },
    { key: 'cooling', name_ar: 'التبريد والرديتر', short_ar: 'التبريد', name_en: 'Cooling', match: ['radiator', 'radiators', 'rdytrat', 'cooling'] },
    { key: 'lighting', name_ar: 'الإضاءة', short_ar: 'الإضاءة', name_en: 'Lighting', match: ['headlamp', 'tail-lamp', 'headlights', 'tail-lights', 'shmaaat-amamy', 'astbat-khlfy', 'lighting'] },
    { key: 'body', name_ar: 'الصدامات والهيكل', short_ar: 'الصدامات', name_en: 'Body', match: ['rear-bumper', 'door', 'bumpers', 'sdamat', 'mirrors', 'body'] },
    { key: 'ignition', name_ar: 'البواجي والإشعال', short_ar: 'البواجي والإشعال', name_en: 'Ignition', match: ['spark-plugs', 'boagy', 'sensors', 'electrical', 'ignition', 'spark-plug', 'ignition-coil'] },
];

let homeBrandsExpanded = false;

// Brands with clean official SVG emblems/wordmarks from manufacturer sources
// Prefer true vector emblems only (path-based). Fake text SVGs look blurry/low-quality.
// True path-based SVG emblems only (never fake text placeholders).
const OFFICIAL_BRAND_SVGS = new Set([
    'chery', 'geely', 'haval', 'jetour', 'foton', 'tank',
    'omoda', 'jaecoo', 'mg', 'dongfeng', 'byd',
]);

// Square cards: prefer crisp PNG badges for wordmarks / sparse SVGs.
const PREFER_PNG_LOGOS = new Set([
    'changan', 'gac', 'maxus', 'baic', 'exeed',
    'hongqi', 'jac', 'bestune', 'soueast', 'zotye', 'zeekr', 'wuling',
    'leapmotor', 'lifan', 'forthing', 'dfsk', 'kaiyi', 'jmc', 'swm', 'gwm',
    'lynk-co',
]);

// Duplicate / alternate slugs → logo file slug
const BRAND_LOGO_ALIASES = {
    'baic-2': 'baic',
    'foton-2': 'foton',
    'lynk-co-2': 'lynk-co',
    'faw-bestune': 'bestune',
    'great-wall': 'gwm',
    'generic': 'brand',
};

function resolveBrandLogoSlug(brandOrSlug) {
    const raw = typeof brandOrSlug === 'string'
        ? brandOrSlug
        : (brandOrSlug?.slug || '');
    const slug = String(raw || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    return BRAND_LOGO_ALIASES[slug] || slug;
}

function getBrandLogoUrl(brand) {
    const slug = resolveBrandLogoSlug(brand);
    if (!slug) return 'images/brands/brand.svg?v=35';
    // Square cards: prefer crisp PNG badges; keep SVG only for true emblems that remain sharp.
    if (PREFER_PNG_LOGOS.has(slug) || !OFFICIAL_BRAND_SVGS.has(slug)) {
        return `images/brands/${slug}.png?v=35`;
    }
    return `images/brands/${slug}.svg?v=35`;
}

function getBrandLogoFallback(brand) {
    const slug = resolveBrandLogoSlug(brand);
    if (!slug || slug === 'brand') return 'images/brands/brand.svg?v=35';
    // Always fall back across format, then generic mark.
    if (PREFER_PNG_LOGOS.has(slug) || !OFFICIAL_BRAND_SVGS.has(slug)) {
        return `images/brands/${slug}.svg?v=35`;
    }
    return `images/brands/${slug}.png?v=35`;
}

function getMergedHomeBrands() {
    const bySlug = {};
    (cachedBrands || []).forEach(brand => {
        if (brand.slug) bySlug[String(brand.slug).toLowerCase()] = brand;
    });

    const merged = [];
    const seen = new Set();

    CHINESE_BRANDS_CATALOG.forEach(item => {
        const api = bySlug[item.slug];
        const productsCount = Number(api?.products_count || 0);
        const available = Boolean(api?.id) && (api?.has_products !== false) && (
            api?.products_count == null ? true : productsCount > 0
        );
        merged.push({
            id: api?.id || null,
            slug: item.slug,
            name_ar: api?.name_ar || item.name_ar,
            name_en: api?.name_en || item.name_en,
            logo: api?.logo || null,
            domain: item.domain,
            logoFile: item.logoFile,
            available,
            products_count: productsCount,
        });
        seen.add(item.slug);
    });

    (cachedBrands || []).forEach(brand => {
        const slug = String(brand.slug || '').toLowerCase();
        if (!slug || seen.has(slug)) return;
        // Skip duplicate slug variants (baic-2, foton-2, …) when base brand exists.
        const logoSlug = resolveBrandLogoSlug(slug);
        if (logoSlug !== slug && (seen.has(logoSlug) || bySlug[logoSlug])) return;
        if (slug === 'generic') return;
        const productsCount = Number(brand.products_count || 0);
        const available = Boolean(brand.id) && (brand.has_products !== false) && (
            brand.products_count == null ? true : productsCount > 0
        );
        const known = CHINESE_BRANDS_CATALOG.find(b => b.slug === slug || b.slug === logoSlug);
        merged.push({
            id: brand.id,
            slug,
            name_ar: brand.name_ar,
            name_en: brand.name_en,
            logo: brand.logo || null,
            domain: known?.domain || '',
            logoFile: known?.logoFile || null,
            available,
            products_count: productsCount,
        });
        seen.add(slug);
        seen.add(logoSlug);
    });

    // Lit brands first, keep catalog order within each group
    return merged.sort((a, b) => Number(b.available) - Number(a.available));
}

function renderHomeBrandsGrid() {
    const grid = document.getElementById('home-brands-grid');
    if (!grid) return;

    const merged = getMergedHomeBrands();
    const visible = homeBrandsExpanded ? merged : merged.slice(0, HOME_BRANDS_INITIAL);

    grid.innerHTML = visible.map(brand => {
        const label = currentLang === 'ar' ? (brand.name_ar || brand.name_en) : (brand.name_en || brand.name_ar);
        const logo = getBrandLogoUrl(brand);
        const fallback = getBrandLogoFallback(brand);
        const initials = escapeHtml((brand.name_en || brand.name_ar || '?').slice(0, 2).toUpperCase());
        const stateClass = brand.available ? 'is-available' : 'is-soon';
        const title = brand.available
            ? escapeHtml(label)
            : `${escapeHtml(label)} — قريباً`;

        if (brand.available && brand.id) {
            return `
            <a class="brand-logo-card ${stateClass}" href="/brands/${encodeURIComponent(brand.slug)}/" title="${title}">
                <div class="brand-logo-media">
                    <span class="brand-logo-frame">
                        <img
                            class="brand-logo-img"
                            src="${escapeHtml(logo)}"
                            alt="${escapeHtml(brand.name_en || label)}"
                            loading="lazy"
                            decoding="async"
                            width="76"
                            height="76"
                            data-fallback="${escapeHtml(fallback)}"
                            onerror="handleBrandLogoError(this)"
                        >
                        <div class="brand-logo-fallback" hidden><span>${initials}</span></div>
                    </span>
                </div>
                <div class="brand-logo-meta">
                    <strong>${escapeHtml(label)}</strong>
                </div>
            </a>`;
        }

        return `
            <div class="brand-logo-card ${stateClass}" title="${title}" aria-disabled="true">
                <div class="brand-logo-media">
                    <span class="brand-logo-frame">
                        <img
                            class="brand-logo-img"
                            src="${escapeHtml(logo)}"
                            alt="${escapeHtml(brand.name_en || label)}"
                            loading="lazy"
                            decoding="async"
                            width="76"
                            height="76"
                            data-fallback="${escapeHtml(fallback)}"
                            onerror="handleBrandLogoError(this)"
                        >
                        <div class="brand-logo-fallback" hidden><span>${initials}</span></div>
                    </span>
                </div>
                <div class="brand-logo-meta">
                    <strong>${escapeHtml(label)}</strong>
                    <span class="brand-soon-label">قريباً</span>
                </div>
            </div>`;
    }).join('');

    const moreWrap = document.getElementById('brands-more-wrap');
    const moreBtn = document.getElementById('brands-more-btn');
    if (moreWrap && moreBtn) {
        const hasMore = merged.length > HOME_BRANDS_INITIAL;
        moreWrap.hidden = !hasMore;
        moreBtn.textContent = homeBrandsExpanded
            ? 'عرض أقل'
            : `عرض المزيد (${merged.length - HOME_BRANDS_INITIAL})`;
        moreBtn.onclick = () => {
            homeBrandsExpanded = !homeBrandsExpanded;
            renderHomeBrandsGrid();
        };
    }
}

function resolveFeaturedCategory(featured) {
    const cats = cachedCategories || [];
    for (const slug of featured.match) {
        const hit = cats.find(c => String(c.slug || '').toLowerCase() === slug);
        if (hit) return hit;
    }
    // Fallback: match by Arabic/English name fragment
    const needle = (featured.name_ar || '').slice(0, 4);
    return cats.find(c => String(c.name_ar || '').includes(needle)) || null;
}

function renderHomeCategories() {
    const grid = document.getElementById('home-category-cards');
    if (!grid) return;

    const cards = HOME_FEATURED_CATEGORIES.map(featured => {
        const isAr = currentLang === 'ar';
        const label = isAr ? (featured.short_ar || featured.name_ar) : featured.name_en;
        const full = isAr ? featured.name_ar : featured.name_en;
        const href = `/categories/${encodeURIComponent(featured.key)}/`;
        const icon = CATEGORY_ICONS[featured.key] || CATEGORY_ICONS.engine;
        return `
            <a class="parts-dir-item" href="${href}" title="${escapeHtml(full)}">
                <span class="parts-dir-icon" aria-hidden="true">${icon}</span>
                <span class="parts-dir-name">${escapeHtml(label)}</span>
            </a>
        `;
    }).join('');

    grid.className = 'parts-dir';
    grid.setAttribute('aria-label', 'أقسام القطع');
    grid.innerHTML = cards;
}

function handleBrandLogoError(img) {
    if (!img) return;
    const stage = Number(img.dataset.stage || 0);
    const wrap = img.closest('.brand-mini-logo, .ui-picker-logo');

    if (stage === 0 && img.dataset.fallback) {
        img.dataset.stage = '1';
        img.src = img.dataset.fallback;
        return;
    }

    img.style.display = 'none';
    const fb = img.nextElementSibling;
    if (fb) fb.hidden = false;
    if (wrap) wrap.classList.add('is-empty');
}
window.handleBrandLogoError = handleBrandLogoError;

function brandLogoMarkup(slug, { sizeClass = '' } = {}) {
    const s = resolveBrandLogoSlug(slug);
    const cls = `brand-mini-logo${sizeClass ? ` ${sizeClass}` : ''}`;
    if (!s) {
        return `<span class="${cls} is-empty" aria-hidden="true"><i class="fa-solid fa-car-side"></i></span>`;
    }
    const meta = { slug: s };
    const primary = getBrandLogoUrl(meta);
    const fallback = getBrandLogoFallback(meta);
    return `
        <span class="${cls}" aria-hidden="true">
            <img src="${primary}" data-fallback="${fallback}" alt="" loading="lazy" decoding="async" onerror="handleBrandLogoError(this)">
            <i class="fa-solid fa-car-side" hidden></i>
        </span>
    `;
}

function findBrandMeta(idOrSlug) {
    const key = String(idOrSlug || '');
    return (cachedBrands || []).find(b => String(b.id) === key || String(b.slug || '').toLowerCase() === key.toLowerCase())
        || CHINESE_BRANDS_CATALOG.find(b => String(b.slug || '').toLowerCase() === key.toLowerCase())
        || null;
}

function getUiPicker() {
    let overlay = document.getElementById('ui-picker-overlay');
    if (overlay) return overlay;

    overlay = document.createElement('div');
    overlay.id = 'ui-picker-overlay';
    overlay.className = 'ui-picker-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
        <div class="ui-picker-sheet" role="dialog" aria-modal="true" aria-labelledby="ui-picker-title">
            <div class="ui-picker-head">
                <h3 id="ui-picker-title" class="ui-picker-title"></h3>
                <button type="button" class="ui-picker-close" aria-label="إغلاق"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="ui-picker-search-wrap" hidden>
                <i class="fa-solid fa-magnifying-glass"></i>
                <input type="text" id="ui-picker-search" class="ui-picker-search" autocomplete="off">
            </div>
            <div class="ui-picker-list" id="ui-picker-list" role="listbox"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeUiPicker();
    });
    overlay.querySelector('.ui-picker-close')?.addEventListener('click', closeUiPicker);
    overlay.querySelector('#ui-picker-search')?.addEventListener('input', (e) => {
        const q = String(e.target.value || '').trim().toLowerCase();
        overlay.querySelectorAll('.ui-picker-option').forEach((btn) => {
            const text = `${btn.dataset.label || ''} ${btn.textContent || ''}`.toLowerCase();
            btn.hidden = Boolean(q) && !text.includes(q);
        });
    });

    return overlay;
}

function closeUiPicker() {
    const overlay = document.getElementById('ui-picker-overlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.classList.remove('is-open');
    document.body.classList.remove('ui-picker-open');
    document.querySelectorAll('.ui-select.is-open').forEach((root) => {
        root.classList.remove('is-open');
        root.querySelector('.ui-select-trigger')?.setAttribute('aria-expanded', 'false');
    });
}

function closeAllUiSelects() {
    closeUiPicker();
}

function openUiPicker(select) {
    const root = select?.closest('.ui-select');
    if (!root || select.disabled) return;

    const overlay = getUiPicker();
    const titleEl = overlay.querySelector('#ui-picker-title');
    const searchWrap = overlay.querySelector('.ui-picker-search-wrap');
    const searchInput = overlay.querySelector('#ui-picker-search');
    const list = overlay.querySelector('#ui-picker-list');
    const withLogos = root.dataset.logos === '1';
    const searchable = root.dataset.searchable === '1';
    const labelEl = root.closest('.parts-finder-field')?.querySelector('.parts-finder-label');
    const title = labelEl?.textContent?.trim()
        || select.dataset.placeholder
        || (currentLang === 'ar' ? 'اختر' : 'Select');

    document.querySelectorAll('.ui-select.is-open').forEach((r) => {
        if (r !== root) {
            r.classList.remove('is-open');
            r.querySelector('.ui-select-trigger')?.setAttribute('aria-expanded', 'false');
        }
    });
    root.classList.add('is-open');
    root.querySelector('.ui-select-trigger')?.setAttribute('aria-expanded', 'true');

    if (titleEl) titleEl.textContent = title;
    if (searchWrap) searchWrap.hidden = !searchable;
    if (searchInput) {
        searchInput.value = '';
        searchInput.placeholder = currentLang === 'ar' ? 'ابحث...' : 'Search...';
    }

    const value = select.value;
    list.innerHTML = Array.from(select.options).map((opt, index) => {
        const optBrand = withLogos && opt.value ? findBrandMeta(opt.value) : null;
        const slug = optBrand?.slug || opt.dataset.slug || '';
        const isSelected = opt.value === value || (!value && index === 0 && !opt.value);
        const nameEn = withLogos && optBrand?.name_en ? `<small>${escapeHtml(optBrand.name_en)}</small>` : '';
        let logo = '';
        if (withLogos && opt.value && slug) {
            const meta = { slug };
            const primary = escapeHtml(getBrandLogoUrl(meta));
            const fallback = escapeHtml(getBrandLogoFallback(meta));
            logo = `
                <span class="ui-picker-logo" aria-hidden="true">
                    <img src="${primary}" data-fallback="${fallback}" alt=""
                         loading="eager" decoding="async" onerror="handleBrandLogoError(this)">
                </span>
            `;
        } else if (withLogos && opt.value) {
            logo = `<span class="ui-picker-logo is-empty" aria-hidden="true"><i class="fa-solid fa-car-side"></i></span>`;
        }
        return `
            <button type="button" class="ui-picker-option${withLogos && opt.value ? ' has-logo' : ''}${isSelected ? ' is-selected' : ''}${!opt.value ? ' is-placeholder' : ''}"
                data-value="${escapeHtml(opt.value)}" data-label="${escapeHtml(opt.textContent || '')}" role="option" aria-selected="${isSelected ? 'true' : 'false'}">
                ${logo}
                <span class="ui-picker-option-text">
                    <strong>${escapeHtml(opt.textContent || '')}</strong>
                    ${nameEn}
                </span>
                ${isSelected ? '<i class="fa-solid fa-check" aria-hidden="true"></i>' : ''}
            </button>
        `;
    }).join('');

    list.querySelectorAll('.ui-picker-option').forEach((btn) => {
        btn.addEventListener('click', () => {
            const next = btn.dataset.value ?? '';
            if (select.value !== next) {
                select.value = next;
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
            syncUiSelect(select);
            closeUiPicker();
        });
    });

    overlay.hidden = false;
    document.body.classList.add('ui-picker-open');
    // Force reflow so the open transition actually plays
    void overlay.offsetWidth;
    overlay.classList.add('is-open');
    if (searchable && searchInput) {
        setTimeout(() => searchInput.focus(), 40);
    }
}

function syncUiSelect(select) {
    const root = select?.closest('.ui-select');
    if (!root) return;

    const trigger = root.querySelector('.ui-select-trigger');
    if (!trigger) return;

    const withLogos = root.dataset.logos === '1';
    const selected = select.options[select.selectedIndex];
    const label = selected?.textContent?.trim() || select.dataset.placeholder || '';
    const value = select.value;
    const brand = withLogos && value ? findBrandMeta(value) : null;
    const logoHtml = withLogos && value
        ? brandLogoMarkup(brand?.slug || selected?.dataset?.slug || '', { sizeClass: 'is-trigger' })
        : '';

    trigger.innerHTML = `
        <span class="ui-select-value">${logoHtml}<span class="ui-select-value-text">${escapeHtml(label)}</span></span>
        <i class="fa-solid fa-chevron-down ui-select-caret" aria-hidden="true"></i>
    `;
    trigger.classList.toggle('is-placeholder', !value);
    trigger.disabled = select.disabled;
    root.classList.toggle('is-disabled', select.disabled);
}

function enhanceSelect(select, { logos = false, searchable = false } = {}) {
    if (!select || select.tagName !== 'SELECT') return;

    let root = select.closest('.ui-select');
    if (!root) {
        root = document.createElement('div');
        root.className = 'ui-select';
        select.parentNode.insertBefore(root, select);
        root.appendChild(select);
    }

    // Clean old dropdown panels if any
    root.querySelectorAll('.ui-select-panel').forEach((p) => p.remove());
    root.classList.remove('ui-select--brands', 'open-up');

    select.classList.add('ui-select-native');
    root.dataset.logos = logos ? '1' : '0';
    root.dataset.searchable = searchable ? '1' : '0';
    if (!select.dataset.placeholder) {
        select.dataset.placeholder = select.options[0]?.textContent?.trim() || '';
    }

    if (!root.querySelector('.ui-select-trigger')) {
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'ui-select-trigger';
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        root.appendChild(trigger);

        trigger.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (select.disabled) return;
            if (root.classList.contains('is-open')) closeUiPicker();
            else openUiPicker(select);
        });
    }

    syncUiSelect(select);
}

function enhanceStorefrontSelects() {
    const brand = document.getElementById('search-brand');
    const model = document.getElementById('search-model');
    const year = document.getElementById('search-year');
    const category = document.getElementById('search-category');
    const sort = document.getElementById('sort-select');

    if (brand) enhanceSelect(brand, { logos: true, searchable: true });
    if (model) enhanceSelect(model);
    if (year) enhanceSelect(year);
    if (category) enhanceSelect(category);
    if (sort) enhanceSelect(sort);
}

if (!window.__uiSelectDocBound) {
    window.__uiSelectDocBound = true;
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeUiPicker();
    });
}

window.closeUiPicker = closeUiPicker;
window.openUiPicker = openUiPicker;

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
window.escapeHtml = escapeHtml;

function isZidReadyForCart(cartItems = cart) {
    if (!ZID_LIVE) return false;
    return cartItems.length > 0 && cartItems.every(item => (
        item.in_stock === true
        && item.checkout_enabled === true
        && item.zid_product_id
    ));
}

function isSallaReadyForCart(cartItems = cart) {
    if (!SALLA_LIVE) return false;
    // Prefer Zid when both are live.
    if (ZID_LIVE && cartItems.some(item => item.zid_product_id)) return false;
    return cartItems.length > 0 && cartItems.every(item => (
        item.checkout_enabled === true
        && item.salla_product_id
        && item.in_stock !== false
    ));
}

function isOnlineCheckoutReadyForCart(cartItems = cart) {
    return isZidReadyForCart(cartItems) || isSallaReadyForCart(cartItems);
}

// --- Multi-Language System ---
const TRANSLATIONS = {
  ar: {
    logo_text: "CHINA PARTS",
    logo_tagline: "قطع الغيار الصينية في السعودية",
    site_title: "CHINA PARTS | قطع غيار السيارات الصينية في السعودية",
    home: "الرئيسية",
    brands: "الماركات",
    all_parts: "جميع القطع",
    about: "عن المتجر",
    contact: "تواصل معنا",
    search_placeholder: "ابحث برقم القطعة (OEM)، الاسم، أو رقم الهيكل (VIN)...",
    hero_badge: "متخصصون في قطع السيارات الصينية",
    hero_title: "قطع غيار سيارتك الصينية… في مكان واحد",
    hero_subtitle: "تسوق قطع شانجان، جيلي، هافال، إم جي وشيري. مش لاقي قطعتك؟ اطلب منا البحث عنها وتوفيرها.",
    tab_vehicle: "بالمركبة",
    tab_vin: "برقم الهيكل",
    select_brand: "اختر الماركة",
    select_model: "اختر الموديل",
    select_year: "اختر السنة",
    select_engine: "كل الأقسام",
    search_parts_btn: "ابحث",
    vin_input_placeholder: "رقم الهيكل المكوّن من 17 خانة",
    vin_btn: "ابحث",
    finder_hint: "اختيار المركبة يساعدك في التصفح؛ تأكيد التوافق النهائي برقم القطعة والهيكل.",
    feat_shipping_title: "توصيل داخل السعودية",
    feat_shipping_desc: "نوضح خيار الشحن وتكلفته قبل تأكيد الطلب.",
    feat_fitment_title: "اختيار مدروس",
    feat_fitment_desc: "راجع رقم القطعة وبيانات السيارة معنا لتأكيد التوافق قبل الطلب.",
    feat_support_title: "دعم متخصص",
    feat_support_desc: "نساعدك في تحديد القطعة المناسبة بدقة قبل إتمام الطلب.",
    latest_parts_title: "أحدث القطع المضافة",
    view_all: "عرض الكل",
    badge_new: "جديد",
    price_on_request: "السعر عند الطلب",
    footer_categories: "الأقسام",
    important_links: "روابط هامة",
    footer_policy_return: "سياسة الاسترجاع",
    footer_privacy: "سياسة الخصوصية",
    footer_terms: "الشروط والشحن",
    currency_sar: "ر.س",
    default_brand: "قطع غيار",
    cart_title: "قائمة الطلب",
    cart_empty: "السلة فارغة حالياً",
    checkout_btn: "إتمام الطلب",
    checkout_btn_zid: "الدفع عبر زد",
    checkout_btn_salla: "الدفع عبر سلة",
    total: "الإجمالي",
    copyright: "جميع الحقوق محفوظة لـ CHINA PARTS © 2026",
    page_all_parts: "جميع القطع",
    inquire_whatsapp: "اطلب عبر واتساب",
    cart_hint_wa: "إرفاق رقم الهيكل أو صورة الاستمارة اختياري، ويساعدنا في مراجعة بيانات المركبة.",
    checkout_btn_photo: "إتمام الطلب",
    vin_checkout_confirm_pay: "تأكيد الطلب والمتابعة للدفع",
    vin_checkout_title: "إتمام الطلب",
    vin_checkout_desc: "أدخل بيانات التواصل والعنوان. يمكنك إرفاق صور المركبة لمساعدتنا في مراجعة الطلب.",
    checkout_name_label: "الاسم",
    checkout_phone_label: "رقم الجوال",
    checkout_name_ph: "اسمك الكامل",
    checkout_phone_ph: "05xxxxxxxx",
    checkout_city_label: "المدينة",
    checkout_address_label: "تفاصيل العنوان",
    checkout_city_ph: "مثال: الرياض",
    checkout_address_ph: "الحي أو الشارع (اختياري إذا استخدمت موقعك)",
    checkout_city_other_ph: "اكتب اسم المدينة",
    checkout_use_location: "استخدم موقعي الحالي",
    checkout_location_hint: "أسهل طريقة: اضغط الزر ويحدد المدينة والعنوان تلقائيًا",
    vin_checkout_input_label: "رقم الهيكل (اختياري)",
    vin_checkout_input_ph: "17 خانة إن كان متوفراً لديك",
    vin_checkout_photo_benefit: "الصور اختيارية، وتساعد فريقنا في مراجعة بيانات المركبة قبل تأكيد الطلب.",
    vin_checkout_photo_label: "صورة الرخصة أو رقم الهيكل",
    vin_checkout_photo_hint: "ارفع صورة واضحة",
    vin_checkout_photo_required: "صور المركبة اختيارية",
    vin_checkout_car_label: "صورة السيارة (اختياري)",
    vin_checkout_car_hint: "صورة واضحة للسيارة من الخارج",
    vin_checkout_istimara_label: "صورة الاستمارة (اختياري)",
    vin_checkout_istimara_hint: "صورة واضحة لاستمارة المركبة",
    vin_checkout_kind_vin: "صورة رقم الهيكل",
    vin_checkout_kind_license: "صورة الرخصة / الاستمارة",
    vin_checkout_ack: "أتعهد أن الصورتين واضحتان وتخصان نفس السيارة",
    vin_checkout_confirm: "تأكيد الطلب",
    vin_checkout_back: "رجوع",
    vin_checkout_step1: "أدخل بياناتك، وأرفق صور المركبة إن توفرت",
    vin_checkout_step2: "نحتفظ بالطلب والصور عندنا",
    vin_checkout_step3: "نكمل الدفع أو نتواصل معك",
    vin_checkout_uploading: "جاري رفع الصور...",
    vin_checkout_remove_photo: "إزالة الصورة",
    add_inquiry: "أضف للطلب",
    filter_by: "تصفية حسب",
    filter_by_brand: "الماركات",
    filter_by_price: "نطاق السعر",
    price_min: "الحد الأدنى",
    price_max: "الحد الأقصى",
    apply_filters: "تطبيق الفلاتر",
    reset_filters: "إعادة ضبط",
    parts_found: "قطع غيار تم العثور عليها",
    no_parts_found: "لم يتم العثور على قطع تطابق هذا الاختيار.",
    show_details: "عرض التفاصيل",
    vin_results_title: "نتائج البحث برقم الهيكل (VIN)",
    matching_parts: "القطع المطابقة لسيارتك",
    about_title: "من نحن",
    about_desc1: "CHINA PARTS متجر متخصص في قطع غيار السيارات الصينية في المملكة العربية السعودية.",
    about_desc2: "نساعدك في البحث عن القطعة واختيارها، مع توضيح السعر والتوفر وخيارات التوصيل قبل تأكيد الطلب.",
    contact_title: "تواصل معنا",
    contact_desc1: "تحتاج قطعة أو مساعدة في الاختيار؟ أرسل رقمها أو صورتها وبيانات سيارتك، ونراجع طلبك معك.",
    contact_email: "البريد الإلكتروني",
    contact_whatsapp: "واتساب",
    policy_title: "سياسة الاسترجاع",
    policy_desc: "يرجى التواصل معنا قبل الشراء لمراجعة شروط الاسترجاع والاستبدال المعتمدة للقطعة.",
    sim_checkout_title: "تم تحويلك لصفحة الدفع (محاكاة)",
    sim_checkout_desc: "يتم هنا الربط مع منصة سلة (Salla) أو بوابة الدفع لاستكمال الشراء.",
    sort_latest: "الأحدث",
    sort_price_asc: "السعر: من الأقل للأعلى",
    sort_price_desc: "السعر: من الأعلى للأقل",
    btn_apply_filters: "تطبيق الفلاتر",
    page_all_parts_desc: "تصفح أحدث قطع الغيار المتوفرة لدينا",
    search_title: "البحث",
    loading_msg: "جاري التحميل...",
    error_loading_product: "حدث خطأ أثناء تحميل تفاصيل القطعة",
    back_to_search: "العودة للبحث",
    oem_label: "رقم القطعة (OEM)",
    category_label: "القسم",
    warranty_label: "بيانات القطعة",
    warranty_value: "بحسب البيانات المتاحة",
    wishlist_btn: "المفضلة",
    compare_btn: "المقارنة",
    tooltip_wishlist: "المفضلة",
    tooltip_compare: "المقارنة",
    car_brand: "ماركة السيارة",
    vin_error: "فشل التحقق من رقم الهيكل. يرجى التأكد من الرقم والمحاولة مرة أخرى.",
    vin_success_title: "تم التعرف على سيارتك بنجاح",
    vin_info_brand: "الماركة:",
    vin_info_model: "الموديل:",
    vin_info_year: "سنة الصنع:",
    vin_info_engine: "المحرك:",
    vin_no_match: "لم يتم العثور على قطع متطابقة حالياً.",
    vin_exact_match: "نتيجة مرتبطة ببيانات المركبة",
    add_to_cart: "إضافة للسلة",
    buy_now: "شراء الآن",
    breadcrumb_home: "الرئيسية",
    breadcrumb_parts: "جميع القطع",
    specs_title: "المواصفات الفنية",
    quantity: "الكمية",
    in_stock: "متوفر",
    out_of_stock: "غير متوفر حالياً",
    stock_needs_confirmation: "التوفر يحتاج تأكيد",
    vin_verified: "راجع رقم القطعة وبيانات المركبة قبل الطلب",
    whatsapp_inquiry: "استفسر عبر الواتساب",
    cart_drawer_title: "عربة التسوق",
    checkout_proceed: "إتمام الطلب عبر سلة",
    contact_form_name: "الاسم الكامل",
    contact_form_email: "البريد الإلكتروني",
    contact_form_msg: "رسالتك",
    contact_send_btn: "إرسال الرسالة",
  },
  en: {
    logo_text: "CHINA PARTS",
    logo_tagline: "Auto Parts from China to Saudi Arabia",
    site_title: "CHINA PARTS | Premier Chinese Auto Parts Store",
    home: "Home",
    brands: "Brands",
    all_parts: "All Parts",
    about: "About Us",
    contact: "Contact Us",
    search_placeholder: "Search by OEM, part name, or VIN...",
    hero_badge: "Specialists in Chinese car parts",
    hero_title: "The right part for your Chinese car",
    hero_subtitle: "Browse parts for Chinese cars or ask us to help source your missing part.",
    tab_vehicle: "By vehicle",
    tab_vin: "By VIN",
    select_brand: "Brand",
    select_model: "Model",
    select_year: "Year",
    select_engine: "Category",
    search_parts_btn: "Search",
    vin_input_placeholder: "17-character VIN",
    vin_btn: "Search",
    finder_hint: "VIN is most accurate — otherwise choose brand, model, and year.",
    feat_shipping_title: "Shipping details before checkout",
    feat_shipping_desc: "We confirm the available shipping option and cost before the order is finalized.",
    feat_fitment_title: "Help choosing your part",
    feat_fitment_desc: "Share the part number and vehicle details so we can help review compatibility before ordering.",
    feat_support_title: "Expert Tech Support",
    feat_support_desc: "Contact our store team on WhatsApp for help choosing or sourcing a part.",
    latest_parts_title: "Latest Added Parts",
    view_all: "View All",
    badge_new: "New",
    price_on_request: "Price on Request",
    footer_categories: "Categories",
    important_links: "Important Links",
    footer_policy_return: "Return Policy",
    currency_sar: "SAR",
    default_brand: "Spare Parts",
    cart_title: "Shopping Cart",
    cart_empty: "Your cart is empty",
    checkout_btn: "Proceed to Checkout on Salla",
    total: "Total",
    copyright: "All Rights Reserved for CHINA PARTS © 2026",
    page_all_parts: "All Spare Parts",
    cart_hint_wa: "VIN or registration photos are optional and help us review the vehicle details.",
    checkout_btn_photo: "Complete order",
    vin_checkout_confirm_pay: "Confirm order and continue to payment",
    vin_checkout_title: "Complete order",
    vin_checkout_desc: "Enter your contact details and address. Vehicle photos are optional and can help us review your request.",
    checkout_name_label: "Name",
    checkout_phone_label: "Phone",
    checkout_name_ph: "Your full name",
    checkout_phone_ph: "05xxxxxxxx",
    checkout_city_label: "City",
    checkout_address_label: "Address details",
    checkout_city_ph: "Example: Riyadh",
    checkout_address_ph: "District or street (optional if you used location)",
    checkout_city_other_ph: "Type city name",
    checkout_use_location: "Use my current location",
    checkout_location_hint: "Easiest: tap the button to auto-fill city and address",
    vin_checkout_input_label: "VIN (optional)",
    vin_checkout_input_ph: "17 characters if you have it",
    vin_checkout_photo_benefit: "Photos are optional and help our team review the vehicle details before confirming the request.",
    vin_checkout_photo_label: "License or VIN photo",
    vin_checkout_photo_hint: "Upload a clear photo",
    vin_checkout_photo_required: "Vehicle photos are optional",
    vin_checkout_car_label: "Car photo (optional)",
    vin_checkout_car_hint: "Clear exterior photo of the vehicle",
    vin_checkout_istimara_label: "Registration photo (optional)",
    vin_checkout_istimara_hint: "Clear photo of the vehicle registration",
    vin_checkout_kind_vin: "VIN photo",
    vin_checkout_kind_license: "Registration / license photo",
    vin_checkout_ack: "I confirm both photos are clear and for the same vehicle",
    vin_checkout_confirm: "Confirm order",
    vin_checkout_back: "Back",
    vin_checkout_step1: "Enter your details and add vehicle photos if available",
    vin_checkout_step2: "We save the order and photos",
    vin_checkout_step3: "Continue to payment or we contact you",
    vin_checkout_uploading: "Uploading photos...",
    vin_checkout_remove_photo: "Remove photo",
    filter_by: "Filter By",
    filter_by_brand: "Brands",
    filter_by_price: "Price Range",
    price_min: "Min Price",
    price_max: "Max Price",
    apply_filters: "Apply Filters",
    reset_filters: "Reset",
    parts_found: "Spare Parts Found",
    no_parts_found: "No parts match this selection.",
    show_details: "Show Details",
    vin_results_title: "VIN Search Results",
    matching_parts: "Matching Parts for your Vehicle",
    about_title: "About Us",
    about_desc1: "CHINA PARTS is a Saudi store specializing in parts for Chinese vehicles.",
    about_desc2: "We help you choose and source parts, with pricing, availability and delivery options clarified before order confirmation.",
    contact_title: "Contact Us",
    contact_desc1: "Our technical team is ready to answer all your inquiries about spare parts.",
    contact_email: "Email",
    contact_whatsapp: "WhatsApp",
    policy_title: "Return Policy",
    policy_desc: "Please contact us before purchase to review the approved return and exchange terms for the part.",
    sim_checkout_title: "Redirected to Payment Page (Simulation)",
    sim_checkout_desc: "Integration with Salla or a payment gateway occurs here to complete the purchase.",
    sort_latest: "Latest",
    sort_price_asc: "Price: Low to High",
    sort_price_desc: "Price: High to Low",
    btn_apply_filters: "Apply Filters",
    page_all_parts_desc: "Browse our latest available spare parts",
    search_title: "Search",
    loading_msg: "Loading...",
    error_loading_product: "An error occurred while loading part details",
    back_to_search: "Back to Search",
    oem_label: "Part Number (OEM)",
    category_label: "Category",
    warranty_label: "Part details",
    warranty_value: "Based on available product data",
    wishlist_btn: "Wishlist",
    compare_btn: "Compare",
    tooltip_wishlist: "Wishlist",
    tooltip_compare: "Compare",
    car_brand: "Car Brand",
    vin_error: "Failed to verify VIN. Please check the number and try again.",
    vin_success_title: "Your car has been successfully identified",
    vin_info_brand: "Brand:",
    vin_info_model: "Model:",
    vin_info_year: "Year:",
    vin_info_engine: "Engine:",
    vin_no_match: "No matching parts found currently.",
    vin_exact_match: "Result linked to vehicle data",
    add_to_cart: "Add to Cart",
    buy_now: "Buy now",
    breadcrumb_home: "Home",
    breadcrumb_parts: "All Parts",
    specs_title: "Technical Specifications",
    quantity: "Quantity",
    in_stock: "In Stock",
    out_of_stock: "Out of Stock",
    stock_needs_confirmation: "Availability needs confirmation",
    vin_verified: "Review the part number and vehicle details before ordering",
    whatsapp_inquiry: "Inquire via WhatsApp",
    cart_drawer_title: "Shopping Cart",
    checkout_proceed: "Proceed to Checkout on Salla",
    contact_form_name: "Full Name",
    contact_form_email: "Email Address",
    contact_form_msg: "Your Message",
    contact_send_btn: "Send Message",
  },
  ur: {
    logo_text: "CHINA PARTS",
    logo_tagline: "Auto Parts from China to Saudi Arabia",
    site_title: "CHINA PARTS | چائنیز کار کے پرزوں کی دکان",
    home: "ہوم",
    brands: "برانڈز",
    all_parts: "تمام پرزے",
    about: "ہمارے بارے میں",
    contact: "ہم سے رابطہ کریں",
    search_placeholder: "OEM، حصے کا نام، یا VIN سے تلاش کریں...",
    hero_badge: "سعودی عرب اور خلیج میں اولین منزل",
    hero_title: "اپنا وقت بچائیں، ایک کلک میں <span>چینی کار کے پرزے</span> آرڈر کریں۔",
    hero_subtitle: "چانگان، ایم جی، جیلی اور ہاول کے پرزے تلاش کریں، اور آرڈر سے پہلے دستیابی اور مطابقت کی تصدیق کریں۔",
    tab_vehicle: "گاڑی کے ذریعے تلاش کریں",
    tab_vin: "VIN کے ذریعے تلاش کریں",
    select_brand: "برانڈ منتخب کریں",
    select_model: "ماڈل منتخب کریں",
    select_year: "سال منتخب کریں",
    select_engine: "زمرہ منتخب کریں",
    search_parts_btn: "پرزے تلاش کریں",
    vin_input_placeholder: "17 ہندسوں کا VIN درج کریں...",
    vin_btn: "پرزوں کی جانچ اور میچ کریں",
    feat_shipping_title: "پورے سعودی عرب میں تیز ترسیل",
    feat_shipping_desc: "سعودی عرب کے تمام شہروں میں آپ کے دہلیز یا ورکشاپ تک محفوظ اور تیز ترسیل۔",
    feat_fitment_title: "مطابقت کی جانچ",
    feat_fitment_desc: "ہم شپنگ سے پہلے کامل فٹمنٹ کو یقینی بنانے کے لیے آپ کے VIN کا استعمال کرتے ہوئے ہر آرڈر की دستی طور پر تصدیق کرتے ہیں۔",
    feat_support_title: "ماہر تکنیکی مدد",
    feat_support_desc: "واٹس ایپ کے ذریعے صحیح پرزہ منتخب کرنے میں آپ کی مدد کے لیے انجینئرز اور ماہرین تیار ہیں۔",
    latest_parts_title: "تازہ ترین شامل کردہ پرزے",
    view_all: "سب دیکھیں",
    badge_new: "نیا",
    price_on_request: "قیمت کی درخواست کریں",
    footer_categories: "زمرے",
    important_links: "اہم لنکس",
    footer_policy_return: "واپسی کی پالیسی",
    currency_sar: "SAR",
    default_brand: "اسپیئر پارٹس",
    cart_title: "خریداری کی ٹوکری",
    cart_empty: "آپ کی ٹوکری خالی ہے",
    checkout_btn: "سلہ پر ادائیگی کے لیے آگے بڑھیں",
    total: "کل رقم",
    copyright: "تمام حقوق محفوظ ہیں CHINA PARTS © 2026",
    page_all_parts: "تمام اسپیئر پارٹس",
    filter_by: "فلٹر کریں",
    filter_by_brand: "برانڈز",
    filter_by_price: "قیمت کی حد",
    price_min: "کم از کم قیمت",
    price_max: "زیادہ سے زیادہ قیمت",
    apply_filters: "فلٹرز لاگو کریں",
    reset_filters: "ری سیٹ کریں",
    parts_found: "اسپیئر پارٹس مل گئے",
    no_parts_found: "اس انتخاب سے کوئی پرزہ مطابقت نہیں رکھتا۔",
    show_details: "تفصیلات دیکھیں",
    vin_results_title: "VIN تلاش کے نتائج",
    matching_parts: "آپ کی گاڑی کے لیے مماثل پرزے",
    about_title: "ہمارے بارے میں",
    about_desc1: "ہم 'CHINA PARTS' پلیٹ فارم ہیں جو سعودی عرب میں تمام چینی کاروں کے اسپیئر پارٹس فراہم کرنے کے لیے وقف ہیں۔",
    about_desc2: "ہمارا مقصد آرڈر سے پہلے دستیابی، مطابقت اور شپنگ کی تفصیلات واضح کرنا ہے۔",
    contact_title: "ہم سے رابطہ کریں",
    contact_desc1: "ہماری تکنیکی ٹیم اسپیئر پارٹس کے بارے میں آپ کے تمام سوالات کے جوابات دینے کے لیے تیار ہے۔",
    contact_email: "ای میل",
    contact_whatsapp: "واٹس ایپ",
    policy_title: "واپسی کی پالیسی",
    policy_desc: "صارف کو خریداری کے 14 دنوں کے اندر پرزے واپس یا تبدیل کرنے کا حق حاصل ہے، بشرطیکہ پرزہ اپنی اصل حالت میں ہو اور اسے نصب نہ کیا گیا ہو۔",
    sim_checkout_title: "آپ کو ادائیگی کے صفحے پر بھیج دیا گیا ہے (سمولیشن)",
    sim_checkout_desc: "خریداری مکمل کرنے کے لیے یہاں سلہ یا پیمنٹ گیٹ وے کے ساتھ انٹیگریشن ہوتی ہے۔",
    sort_latest: "تازہ ترین",
    sort_price_asc: "قیمت: کم سے زیادہ",
    sort_price_desc: "قیمت: زیادہ سے کم",
    btn_apply_filters: "فلٹرز لاگو کریں",
    page_all_parts_desc: "ہمارے دستیاب تازہ ترین اسپیئر پارٹس براؤز کریں",
    search_title: "تلاش",
    loading_msg: "لوڈ ہو رہا ہے...",
    error_loading_product: "پرزے کی تفصیلات لوڈ کرتے وقت ایک خرابی پیش آ گئی",
    back_to_search: "تلاش پر واپس جائیں",
    oem_label: "پارٹ نمبر (OEM)",
    category_label: "زمرہ",
    warranty_label: "وارنٹی",
    warranty_value: "تفصیلات آرڈر سے پہلے تصدیق کی جاتی ہیں",
    wishlist_btn: "پسندیدہ",
    compare_btn: "موازنہ",
    tooltip_wishlist: "پسندیدہ",
    tooltip_compare: "موازنہ",
    car_brand: "کار برانڈ",
    vin_error: "VIN کی تصدیق ناکام ہو گئی۔ براہ کرم نمبر چیک کریں اور دوبارہ کوشش کریں۔",
    vin_success_title: "آپ کی گاڑی کی کامیابی سے شناخت ہو گئی ہے",
    vin_info_brand: "برانڈ:",
    vin_info_model: "ماڈل:",
    vin_info_year: "سال:",
    vin_info_engine: "انجن:",
    vin_no_match: "فی الحال کوئی مماثل پرزے نہیں ملے۔",
    vin_exact_match: "ڈیٹا کی تصدیق درکار ہے",
    add_to_cart: "ٹوکری میں شامل کریں",
    breadcrumb_home: "ہوم",
    breadcrumb_parts: "تمام پرزے",
    specs_title: "تکنیکی خصوصیات",
    quantity: "مقدار",
    in_stock: "اسٹاک میں دستیاب",
    out_of_stock: "فی الحال دستیاب نہیں",
    vin_verified: "کمپنی کے کیٹلاگ سے تصدیق درکار ہے",
    whatsapp_inquiry: "واٹس ایپ پر پوچھیں",
    cart_drawer_title: "خریداری کی ٹوکری",
    checkout_proceed: "سلہ کے ذریعے آرڈر مکمل کریں",
    contact_form_name: "پورا نام",
    contact_form_email: "ای میل ایڈریس",
    contact_form_msg: "آپ کا پیغام",
    contact_send_btn: "پیغام بھیجیں",
  },
  fr: {
    logo_text: "CHINA PARTS",
    logo_tagline: "Auto Parts from China to Saudi Arabia",
    site_title: "CHINA PARTS | Magasin de Pièces Auto Chinoises",
    home: "Accueil",
    brands: "Marques",
    all_parts: "Toutes les Pièces",
    about: "À propos",
    contact: "Contactez-nous",
    search_placeholder: "Rechercher par OEM, nom de pièce ou VIN...",
    hero_badge: "La première destination en KSA et Golfe",
    hero_title: "Gagnez du temps, commandez vos <span>pièces auto chinoises</span> en un clic.",
    hero_subtitle: "Recherchez des pièces pour Changan, MG, Geely, Haval et confirmez disponibilité et compatibilité avant commande.",
    tab_vehicle: "Par Véhicule",
    tab_vin: "Par VIN",
    select_brand: "Sélectionner Marque",
    select_model: "Sélectionner Modèle",
    select_year: "Sélectionner Année",
    select_engine: "Sélectionner Catégorie",
    search_parts_btn: "Rechercher",
    vin_input_placeholder: "Entrez le VIN à 17 caractères...",
    vin_btn: "Vérifier le VIN",
    feat_shipping_title: "Livraison Rapide en KSA",
    feat_shipping_desc: "Livraison sûre et rapide à domicile ou à l'atelier dans toutes les villes d'Arabie Saoudite.",
    feat_fitment_title: "Vérification de compatibilité",
    feat_fitment_desc: "Nous vérifions chaque commande manuellement avec le VIN avant l'expédition.",
    feat_support_title: "Support Technique Expert",
    feat_support_desc: "Nos ingénieurs et experts sont disponibles via WhatsApp.",
    latest_parts_title: "Dernières pièces ajoutées",
    view_all: "Voir tout",
    badge_new: "Nouveau",
    price_on_request: "Prix sur demande",
    footer_categories: "Catégories",
    important_links: "Liens importants",
    footer_policy_return: "Politique de retour",
    currency_sar: "SAR",
    default_brand: "Pièces détachées",
    cart_title: "Panier",
    cart_empty: "Votre panier est vide",
    checkout_btn: "Procéder au paiement sur Salla",
    total: "Total",
    copyright: "Tous droits réservés © CHINA PARTS 2026",
    page_all_parts: "Toutes les pièces détachées",
    filter_by: "Filtrer par",
    filter_by_brand: "Marques",
    filter_by_price: "Gamme de prix",
    price_min: "Prix min",
    price_max: "Prix max",
    apply_filters: "Appliquer",
    reset_filters: "Réinitialiser",
    parts_found: "Pièces trouvées",
    no_parts_found: "Aucune pièce ne correspond à cette sélection.",
    show_details: "Voir détails",
    vin_results_title: "Résultats de recherche VIN",
    matching_parts: "Pièces compatibles avec votre véhicule",
    about_title: "À propos de nous",
    about_desc1: "Nous sommes la plateforme 'CHINA PARTS' spécialisée dans les pièces détachées auto chinoises en Arabie Saoudite.",
    about_desc2: "Notre objectif est de clarifier disponibilité, compatibilité et livraison avant la commande.",
    contact_title: "Contactez-nous",
    contact_desc1: "Notre équipe technique est prête à répondre à toutes vos questions.",
    contact_email: "E-mail",
    contact_whatsapp: "WhatsApp",
    policy_title: "Politique de retour",
    policy_desc: "Le client a le droit de retourner ou d'échanger des pièces dans les 14 jours suivant l'achat.",
    sim_checkout_title: "Redirigé vers la page de paiement (Simulation)",
    sim_checkout_desc: "L'intégration avec Salla s'effectue ici pour finaliser l'achat.",
    sort_latest: "Plus récents",
    sort_price_asc: "Prix : croissant",
    sort_price_desc: "Prix : décroissant",
    btn_apply_filters: "Appliquer",
    page_all_parts_desc: "Parcourez nos dernières pièces disponibles",
    search_title: "Recherche",
    loading_msg: "Chargement...",
    error_loading_product: "Une erreur est survenue lors du chargement des détails",
    back_to_search: "Retour à la recherche",
    oem_label: "Référence OEM",
    category_label: "Catégorie",
    warranty_label: "Garantie",
    warranty_value: "Original Garanti",
    wishlist_btn: "Favoris",
    compare_btn: "Comparer",
    tooltip_wishlist: "Favoris",
    tooltip_compare: "Comparer",
    car_brand: "Marque Automobile",
    vin_error: "Échec de la vérification du VIN. Veuillez réessayer.",
    vin_success_title: "Votre véhicule a été identifié avec succès",
    vin_info_brand: "Marque :",
    vin_info_model: "Modèle :",
    vin_info_year: "Année :",
    vin_info_engine: "Moteur :",
    vin_no_match: "Aucune pièce compatible trouvée actuellement.",
    vin_exact_match: "Vérification requise",
    add_to_cart: "Ajouter au panier",
    breadcrumb_home: "Accueil",
    breadcrumb_parts: "Toutes les pièces",
    specs_title: "Spécifications techniques",
    quantity: "Quantité",
    in_stock: "En stock",
    out_of_stock: "Rupture de stock",
    vin_verified: "À confirmer avec le catalogue constructeur",
    whatsapp_inquiry: "Demander via WhatsApp",
    cart_drawer_title: "Panier d'achat",
    checkout_proceed: "Commander via Salla",
    contact_form_name: "Nom complet",
    contact_form_email: "Adresse e-mail",
    contact_form_msg: "Votre message",
    contact_send_btn: "Envoyer le message",
  },
  tr: {
    logo_text: "CHINA PARTS",
    logo_tagline: "Auto Parts from China to Saudi Arabia",
    site_title: "CHINA PARTS | Çin Araba Yedek Parça Mağazası",
    home: "Anasayfa",
    brands: "Markalar",
    all_parts: "Tüm Parçalar",
    about: "Hakkımızda",
    contact: "İletişim",
    search_placeholder: "OEM no, parça adı veya VIN ile arayın...",
    hero_badge: "Suudi Arabistan ve Körfez'deki 1 Numaralı Adres",
    hero_title: "Zaman kazanın, <span>Çin araba yedek parçalarını</span> tek tıkla sipariş edin.",
    hero_subtitle: "Changan, MG, Geely, Haval ve daha fazlası için orijinal ve eşdeğer parçalar. %100 uyum.",
    tab_vehicle: "Araçla Ara",
    tab_vin: "VIN ile Ara",
    select_brand: "Marka Seç",
    select_model: "Model Seç",
    select_year: "Yıl Seç",
    select_engine: "Kategori Seç",
    search_parts_btn: "Parça Ara",
    vin_input_placeholder: "17 haneli VIN kodunu girin...",
    vin_btn: "VIN Kontrol Et",
    feat_shipping_title: "Tüm KSA'ya Hızlı Kargo",
    feat_shipping_desc: "Suudi Arabistan'ın tüm şehirlerine kapınıza veya tamirhanenize güvenli teslimat.",
    feat_fitment_title: "%100 Uyum Garantisi",
    feat_fitment_desc: "Kargolamadan önce VIN kodunuzla her siparişi manuel olarak doğruluyoruz.",
    feat_support_title: "Uzman Teknik Destek",
    feat_support_desc: "Mühendislerimiz WhatsApp üzerinden yardımcı olmaya hazır.",
    latest_parts_title: "Son Eklenen Parçalar",
    view_all: "Tümünü Gör",
    badge_new: "Yeni",
    price_on_request: "Fiyat Talep Üzerine",
    footer_categories: "Kategoriler",
    important_links: "Önemli Bağlantılar",
    footer_policy_return: "İade Politikası",
    currency_sar: "SAR",
    default_brand: "Yedek Parça",
    cart_title: "Alışveriş Sepeti",
    cart_empty: "Sepetiniz boş",
    checkout_btn: "Salla İle Ödemeye Geç",
    total: "Toplam",
    copyright: "Tüm Hakları Saklıdır © CHINA PARTS 2026",
    page_all_parts: "Tüm Yedek Parçalar",
    filter_by: "Filtrele",
    filter_by_brand: "Markalar",
    filter_by_price: "Fiyat Aralığı",
    price_min: "Min Fiyat",
    price_max: "Max Fiyat",
    apply_filters: "Filtreleri Uygula",
    reset_filters: "Sıfırla",
    parts_found: "Bulunan Parçalar",
    no_parts_found: "Bu seçime uygun parça bulunamadı.",
    show_details: "Detayları Göster",
    vin_results_title: "VIN Arama Sonuçları",
    matching_parts: "Aracınıza Uyumlu Parçalar",
    about_title: "Hakkımızda",
    about_desc1: "Suudi Arabistan'daki tüm Çin araçları için yedek parça sağlayan uzman platformuz.",
    about_desc2: "Hızlı kargo ve %100 uyum garantisi sunmayı hedefliyoruz.",
    contact_title: "İletişim",
    contact_desc1: "Teknik ekibimiz sorularınızı yanıtlamaya hazır.",
    contact_email: "E-posta",
    contact_whatsapp: "WhatsApp",
    policy_title: "İade Politikası",
    policy_desc: "Müşteri, satın alma tarihinden itibaren 14 gün içinde parçaları iade etme veya değiştirme hakkına sahiptir.",
    sim_checkout_title: "Ödeme Sayfasına Yönlendirildiniz (Simülasyon)",
    sim_checkout_desc: "Satın alma işlemini tamamlamak için Salla entegrasyonu kullanılır.",
    sort_latest: "En Yeniler",
    sort_price_asc: "Fiyat: Düşükten Yükseğe",
    sort_price_desc: "Fiyat: Yüksekten Düşüğe",
    btn_apply_filters: "Filtreleri Uygula",
    page_all_parts_desc: "Mevcut en son parçalarımıza göz atın",
    search_title: "Arama",
    loading_msg: "Yükleniyor...",
    error_loading_product: "Parça detayları yüklenirken hata oluştu",
    back_to_search: "Aramaya Dön",
    oem_label: "OEM Numarası",
    category_label: "Kategori",
    warranty_label: "Garanti",
    warranty_value: "Orijinal Garantili",
    wishlist_btn: "Favoriler",
    compare_btn: "Karşılaştır",
    tooltip_wishlist: "Favoriler",
    tooltip_compare: "Karşılaştır",
    car_brand: "Araç Markası",
    vin_error: "VIN doğrulanamadı. Lütfen tekrar deneyin.",
    vin_success_title: "Aracınız Başarıyla Tanımlandı",
    vin_info_brand: "Marka:",
    vin_info_model: "Model:",
    vin_info_year: "Yıl:",
    vin_info_engine: "Motor:",
    vin_no_match: "Şu anda uyumlu parça bulunamadı.",
    vin_exact_match: "%100 Uyumlu",
    add_to_cart: "Sepete Ekle",
    breadcrumb_home: "Anasayfa",
    breadcrumb_parts: "Tüm Parçalar",
    specs_title: "Teknik Özellikler",
    quantity: "Miktar",
    in_stock: "Stokta Var",
    out_of_stock: "Stokta Yok",
    vin_verified: "VIN ile %100 Uyum Garantisi",
    whatsapp_inquiry: "WhatsApp ile Sor",
    cart_drawer_title: "Alışveriş Sepeti",
    checkout_proceed: "Salla ile Öde",
    contact_form_name: "Ad Soyad",
    contact_form_email: "E-posta Adresi",
    contact_form_msg: "Mesajınız",
    contact_send_btn: "Mesaj Gönder",
  },
  hi: {
    logo_text: "CHINA PARTS",
    logo_tagline: "Auto Parts from China to Saudi Arabia",
    site_title: "CHINA PARTS | चीनी कार स्पेयर पार्ट्स स्टोर",
    home: "होम",
    brands: "ब्रांड्स",
    all_parts: "सभी पुर्जे",
    about: "हमारे बारे में",
    contact: "संपर्क करें",
    search_placeholder: "OEM नंबर, नाम या VIN से खोजें...",
    hero_badge: "सऊदी अरब और खाड़ी में नंबर 1 गंतव्य",
    hero_title: "अपना समय बचाएं, <span>चीनी कार के स्पेयर पार्ट्स</span> एक क्लिक में ऑर्डर करें।",
    hero_subtitle: "चंगन, एमजी, गीली और हावल के पार्ट्स खोजें; ऑर्डर से पहले उपलब्धता और अनुकूलता की पुष्टि करें।",
    tab_vehicle: "वाहन से खोजें",
    tab_vin: "VIN से खोजें",
    select_brand: "ब्रांड चुनें",
    select_model: "मॉडल चुनें",
    select_year: "वर्ष चुनें",
    select_engine: "श्रेणी चुनें",
    search_parts_btn: "पुर्जे खोजें",
    vin_input_placeholder: "17 अंकों का VIN दर्ज करें...",
    vin_btn: "VIN जांचें",
    feat_shipping_title: "पूरे सऊदी में तेज़ डिलीवरी",
    feat_shipping_desc: "सऊदी अरब के सभी शहरों में सुरक्षित और तेज़ डिलीवरी।",
    feat_fitment_title: "अनुकूलता जाँच",
    feat_fitment_desc: "हम शिपिंग से पहले आपकी VIN से हर ऑर्डर की मैन्युअल जांच करते हैं।",
    feat_support_title: "विशेषज्ञ तकनीकी सहायता",
    feat_support_desc: "हमारे इंजीनियर WhatsApp पर सहायता के लिए तैयार हैं।",
    latest_parts_title: "नवीनतम जोड़े गए पुर्जे",
    view_all: "सभी देखें",
    badge_new: "नया",
    price_on_request: "अनुरोध पर मूल्य",
    footer_categories: "श्रेणियां",
    important_links: "महत्वपूर्ण लिंक",
    footer_policy_return: "वापसी नीति",
    currency_sar: "SAR",
    default_brand: "स्पेयर पार्ट्स",
    cart_title: "शॉपिंग कार्ट",
    cart_empty: "आपकी कार्ट खाली है",
    checkout_btn: "सल्ला पर चेकआउट करें",
    total: "कुल",
    copyright: "सर्वाधिकार सुरक्षित © CHINA PARTS 2026",
    page_all_parts: "सभी स्पेयर पार्ट्स",
    filter_by: "फ़िल्टर करें",
    filter_by_brand: "ब्रांड्स",
    filter_by_price: "मूल्य सीमा",
    price_min: "न्यूनतम मूल्य",
    price_max: "अधिकतम मूल्य",
    apply_filters: "फ़िल्टर लागू करें",
    reset_filters: "रीसेट करें",
    parts_found: "पुर्जे मिले",
    no_parts_found: "कोई पुर्जा नहीं मिला।",
    show_details: "विवरण देखें",
    vin_results_title: "VIN खोज परिणाम",
    matching_parts: "आपके वाहन के लिए उपयुक्त पुर्जे",
    about_title: "हमारे बारे में",
    about_desc1: "हम सऊदी अरब में चीनी कारों के लिए स्पेयर पार्ट्स प्रदान करने वाला प्रमुख मंच हैं।",
    about_desc2: "हम ऑर्डर से पहले उपलब्धता, अनुकूलता और शिपिंग विवरण स्पष्ट करते हैं।",
    contact_title: "संपर्क करें",
    contact_desc1: "हमारी टीम आपके प्रश्नों का उत्तर देने के लिए तैयार है।",
    contact_email: "ईमेल",
    contact_whatsapp: "व्हाट्सएप",
    policy_title: "वापसी नीति",
    policy_desc: "ग्राहक खरीद के 14 दिनों के भीतर पुर्जे बदल सकते हैं।",
    sim_checkout_title: "भुगतान पृष्ठ पर पुनर्निर्देशित किया गया",
    sim_checkout_desc: "खरीद पूरी करने के लिएल्ला एकीकरण का उपयोग किया जाता है।",
    sort_latest: "नवीनतम",
    sort_price_asc: "मूल्य: कम से अधिक",
    sort_price_desc: "मूल्य: अधिक से कम",
    btn_apply_filters: "फ़िल्टर लागू करें",
    page_all_parts_desc: "हमारे नवीनतम उपलब्ध स्पेयर पार्ट्स देखें",
    search_title: "खोज",
    loading_msg: "लोड हो रहा है...",
    error_loading_product: "विवरण लोड करने में त्रुटि हुई",
    back_to_search: "खोज पर वापस जाएं",
    oem_label: "OEM नंबर",
    category_label: "श्रेणी",
    warranty_label: "वारंटी",
    warranty_value: "गारंटीकृत असली",
    wishlist_btn: "पसंदीदा",
    compare_btn: "तुलना करें",
    tooltip_wishlist: "पसंदीदा",
    tooltip_compare: "तुलना करें",
    car_brand: "कार ब्रांड",
    vin_error: "VIN सत्यापन विफल। कृपया पुनः प्रयास करें।",
    vin_success_title: "आपके वाहन की सफलतापूर्वक पहचान की गई",
    vin_info_brand: "ब्रांड:",
    vin_info_model: "मॉडल:",
    vin_info_year: "वर्ष:",
    vin_info_engine: "इंजन:",
    vin_no_match: "फिलहाल कोई उपयुक्त पुर्जे नहीं मिले।",
    vin_exact_match: "सत्यापन आवश्यक",
    add_to_cart: "कार्ट में जोड़ें",
    breadcrumb_home: "होम",
    breadcrumb_parts: "सभी पुर्जे",
    specs_title: "तकनीकी विवरण",
    quantity: "मात्रा",
    in_stock: "स्टॉक में उपलब्ध",
    out_of_stock: "स्टॉक में नहीं",
    vin_verified: "निर्माता कैटलॉग से पुष्टि आवश्यक",
    whatsapp_inquiry: "WhatsApp पर पूछें",
    cart_drawer_title: "शॉपिंग कार्ट",
    checkout_proceed: "सल्ला के माध्यम से चेकआउट",
    contact_form_name: "पूरा नाम",
    contact_form_email: "ईमेल पता",
    contact_form_msg: "आपका संदेश",
    contact_send_btn: "संदेश भेजें",
  },
  bn: {
    logo_text: "CHINA PARTS",
    logo_tagline: "Auto Parts from China to Saudi Arabia",
    site_title: "CHINA PARTS | চাইনিজ কার স্পেয়ার পার্টস স্টোর",
    home: "হোম",
    brands: "ব্র্যান্ডসমূহ",
    all_parts: "সকল পার্টস",
    about: "আমাদের সম্পর্কে",
    contact: "যোগাযোগ",
    search_placeholder: "OEM নম্বর, পার্টসের নাম বা VIN দিয়ে খুঁজুন...",
    hero_badge: "সৌদি আরব এবং উপসাগরীয় অঞ্চলে ১ নম্বর গন্তব্য",
    hero_title: "সময় বাঁচান, এক ক্লিকে <span>চাইনিজ কার পার্টস</span> অর্ডার করুন।",
    hero_subtitle: "চাঙ্গান, এমজি, গিলি, হাভাল ইত্যাদির জন্য আসল পার্টসের বৃহত্তম সংগ্রহ। ১০০% মিল।",
    tab_vehicle: "যানবাহন দিয়ে খুঁজুন",
    tab_vin: "VIN দিয়ে খুঁজুন",
    select_brand: "ব্র্যান্ড নির্বাচন করুন",
    select_model: "মডেল নির্বাচন করুন",
    select_year: "বছর নির্বাচন করুন",
    select_engine: "ক্যাটাগরি নির্বাচন করুন",
    search_parts_btn: "পার্টস খুঁজুন",
    vin_input_placeholder: "১৭ ডিজিটের VIN প্রবেশ করান...",
    vin_btn: "VIN যাচাই করুন",
    feat_shipping_title: "সারা সৌদিতে দ্রুত ডেলিভারি",
    feat_shipping_desc: "সৌদি আরবের সমস্ত শহরে আপনার দরজায় বা ওয়ার্কশপে দ্রুত ডেলিভারি।",
    feat_fitment_title: "১০০% ফিটমেন্ট গ্যারান্টি",
    feat_fitment_desc: "আমরা শিপিংয়ের আগে আপনার VIN দিয়ে প্রতিটি অর্ডার ম্যানুয়ালি যাচাই করি।",
    feat_support_title: "বিশেষজ্ঞ প্রযুক্তিগত সহায়তা",
    feat_support_desc: "আমাদের ইঞ্জিনিয়াররা WhatsApp-এ সাহায্য করার জন্য প্রস্তুত।",
    latest_parts_title: "সর্বশেষ সংযুক্ত যন্ত্রাংশ",
    view_all: "সব দেখুন",
    badge_new: "নতুন",
    price_on_request: "অনুরোধে মূল্য",
    footer_categories: "বিভাগসমূহ",
    important_links: "গুরুত্বপূর্ণ লিঙ্ক",
    footer_policy_return: "রিটার্ন নীতি",
    currency_sar: "SAR",
    default_brand: "স্পেয়ার পার্টস",
    cart_title: "শপিং কার্ট",
    cart_empty: "আপনার কার্ট খালি",
    checkout_btn: "সালাহ-তে পেমেন্ট করুন",
    total: "মোট",
    copyright: "সর্বস্বত্ব সংরক্ষিত © CHINA PARTS 2026",
    page_all_parts: "সমস্ত স্পেয়ার পার্টস",
    filter_by: "ফিল্টার করুন",
    filter_by_brand: "ব্র্যান্ডসমূহ",
    filter_by_price: "মূল্য সীমানা",
    price_min: "সর্বনিম্ন মূল্য",
    price_max: "সর্বোচ্চ মূল্য",
    apply_filters: "ফিল্টার প্রয়োগ করুন",
    reset_filters: "রিসেট করুন",
    parts_found: "পার্টস পাওয়া গেছে",
    no_parts_found: "কোনো পার্টস পাওয়া যায়নি।",
    show_details: "বিস্তারিত দেখুন",
    vin_results_title: "VIN অনুসন্ধানের ফলাফল",
    matching_parts: "আপনার গাড়ির জন্য উপযুক্ত পার্টস",
    about_title: "আমাদের সম্পর্কে",
    about_desc1: "আমরা সৌদি আরবে চাইনিজ গাড়ির স্পেয়ার পার্টস সরবরাহকারী শীর্ষস্থানীয় প্ল্যাটফর্ম।",
    about_desc2: "আমরা ১০০% গ্যারান্টিযুক্ত অভিজ্ঞতা প্রদানের লক্ষ্য রাখি।",
    contact_title: "যোগাযোগ",
    contact_desc1: "আমাদের টিম আপনার প্রশ্নের উত্তর দিতে প্রস্তুত।",
    contact_email: "ইমেইল",
    contact_whatsapp: "হোয়াটসঅ্যাপ",
    policy_title: "রিটার্ন নীতি",
    policy_desc: "ক্রেতা ১৪ দিনের মধ্যে পার্টস ফেরত বা পরিবর্তন করতে পারেন।",
    sim_checkout_title: "পেমেন্ট পেজে রিডাইরেক্ট করা হয়েছে",
    sim_checkout_desc: "কেনাকাটা সম্পন্ন করতে সালাহ ইন্টিগ্রেশন ব্যবহৃত হয়।",
    sort_latest: "সর্বশেষ",
    sort_price_asc: "মূল্য: কম থেকে বেশি",
    sort_price_desc: "মূল্য: বেশি থেকে কম",
    btn_apply_filters: "ফিল্টার প্রয়োগ করুন",
    page_all_parts_desc: "আমাদের সর্বশেষ উপলব্ধ স্পেয়ার পার্টস দেখুন",
    search_title: "অনুসন্ধান",
    loading_msg: "লোড হচ্ছে...",
    error_loading_product: "বিস্তারিত লোড করতে ত্রুটি হয়েছে",
    back_to_search: "অনুসন্ধানে ফিরে যান",
    oem_label: "OEM নম্বর",
    category_label: "ক্যাটাগরি",
    warranty_label: "ওয়ারেন্টি",
    warranty_value: "গ্যারান্টিযুক্ত আসল",
    wishlist_btn: "পছন্দসই",
    compare_btn: "তুলনা করুন",
    tooltip_wishlist: "পছন্দসই",
    tooltip_compare: "তুলনা করুন",
    car_brand: "গাড়ির ব্র্যান্ড",
    vin_error: "VIN যাচাইকরণ ব্যর্থ হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।",
    vin_success_title: "আপনার গাড়ি সফলভাবে সনাক্ত করা হয়েছে",
    vin_info_brand: "ব্র্যান্ড:",
    vin_info_model: "মডেল:",
    vin_info_year: "বছর:",
    vin_info_engine: "ইঞ্জিন:",
    vin_no_match: "বর্তমানে কোনো উপযুক্ত পার্টস পাওয়া যায়নি।",
    vin_exact_match: "১০০% মিল",
    add_to_cart: "কার্টে যোগ করুন",
    breadcrumb_home: "হোম",
    breadcrumb_parts: "সকল পার্টস",
    specs_title: "প্রযুক্তিগত বৈশিষ্ট্য",
    quantity: "পরিমাণ",
    in_stock: "স্টকে আছে",
    out_of_stock: "স্টকে নেই",
    vin_verified: "VIN দ্বারা ১০০% নিশ্চিত ফিটমেন্ট",
    whatsapp_inquiry: "WhatsApp-এ জিজ্ঞাসা করুন",
    cart_drawer_title: "শপিং কার্ট",
    checkout_proceed: "সালাহ-র মাধ্যমে অর্ডার করুন",
    contact_form_name: "পূর্ণ নাম",
    contact_form_email: "ইমেইল ঠিকানা",
    contact_form_msg: "আপনার বার্তা",
    contact_send_btn: "বার্তা পাঠান",
  },
  tl: {
    logo_text: "CHINA PARTS",
    logo_tagline: "Auto Parts from China to Saudi Arabia",
    site_title: "CHINA PARTS | Premier Chinese Auto Parts Store",
    home: "Tahanan",
    brands: "Mga Brand",
    all_parts: "Lahat ng Bahagi",
    about: "Tungkol sa Amin",
    contact: "Makipag-ugnayan",
    search_placeholder: "Maghanap sa pamamagitan ng OEM, pangalan, o VIN...",
    hero_badge: "Ang Pangunahing Destinasyon sa KSA & Gulf",
    hero_title: "Makatipid sa oras, umorder ng <span>mga ekstrang bahagi ng kotse</span> sa isang click.",
    hero_subtitle: "Maghanap ng piyesa para sa Changan, MG, Geely at Haval; kumpirmahin ang stock at compatibility bago umorder.",
    tab_vehicle: "Maghanap sa Kotse",
    tab_vin: "Maghanap sa VIN",
    select_brand: "Pumili ng Brand",
    select_model: "Pumili ng Modelo",
    select_year: "Pumili ng Taon",
    select_engine: "Pumili ng Kategorya",
    search_parts_btn: "Maghanap",
    vin_input_placeholder: "Ilagay ang 17-digit na VIN...",
    vin_btn: "Tukuyin ang VIN",
    feat_shipping_title: "Mabilis na Pagpapadala sa KSA",
    feat_shipping_desc: "Ligtas at mabilis na pagpapadala sa iyong pintuan o pagawaan sa lahat ng lungsod sa Saudi.",
    feat_fitment_title: "Pagsuri ng compatibility",
    feat_fitment_desc: "Bawat order ay sinusuri bago ipadala gamit ang iyong VIN.",
    feat_support_title: "Tulong ng Eksperto",
    feat_support_desc: "Handang tumulong ang aming mga inhinyero sa WhatsApp.",
    latest_parts_title: "Pinakabagong Idinagdag na Mga Bahagi",
    view_all: "Tingnan Lahat",
    badge_new: "Bago",
    price_on_request: "Presyo kapag hiniling",
    footer_categories: "Mga Kategorya",
    important_links: "Mahalagang Links",
    footer_policy_return: "Patakaran sa Pagsasauli",
    currency_sar: "SAR",
    default_brand: "Mga Bahagi",
    cart_title: "Cart ng Pamimili",
    cart_empty: "Walang laman ang iyong cart",
    checkout_btn: "Magpatuloy sa Pagbabayad sa Salla",
    total: "Kabuuan",
    copyright: "Lahat ng Karapatan ay Rezervado © CHINA PARTS 2026",
    page_all_parts: "Lahat ng Ekstrang Bahagi",
    filter_by: "I-filter Ayon sa",
    filter_by_brand: "Mga Brand",
    filter_by_price: "Presyo",
    price_min: "Min Presyo",
    price_max: "Max Presyo",
    apply_filters: "I-apply ang Filter",
    reset_filters: "I-reset",
    parts_found: "Nahanap na Mga Bahagi",
    no_parts_found: "Walang bahagi na tumutugma.",
    show_details: "Ipakita ang Detalye",
    vin_results_title: "Resulta ng Paghahanap sa VIN",
    matching_parts: "Mga Bahagi na Tumutugma sa Kotse",
    about_title: "Tungkol sa Amin",
    about_desc1: "Kami ay ang platform na nakatutok sa mga ekstrang bahagi ng mga kotseng Tsino sa Saudi Arabia.",
    about_desc2: "Nililinaw namin ang stock, compatibility at shipping bago kumpirmahin ang order.",
    contact_title: "Makipag-ugnayan sa Amin",
    contact_desc1: "Handa ang aming team na sagutin ang iyong mga tanong.",
    contact_email: "Email",
    contact_whatsapp: "WhatsApp",
    policy_title: "Patakaran sa Pagsasauli",
    policy_desc: "Maaaring mag-sauli o magpalit ng mga bahagi sa loob ng 14 na araw.",
    sim_checkout_title: "Nailipat sa Pahina ng Pagbabayad (Simulation)",
    sim_checkout_desc: "Ginagamit ang Salla integration para kumpletuhin ang pagbili.",
    sort_latest: "Pinakabago",
    sort_price_asc: "Presyo: Mababa hanggang Mataas",
    sort_price_desc: "Presyo: Mataas hanggang Mababa",
    btn_apply_filters: "I-apply ang Filter",
    page_all_parts_desc: "Tingnan ang aming pinakabagong magagamit na mga bahagi",
    search_title: "Paghahanap",
    loading_msg: "Naglo-load...",
    error_loading_product: "Nagkaroon ng error sa pag-load ng mga detalye",
    back_to_search: "Bumalik sa Paghahanap",
    oem_label: "Numero ng OEM",
    category_label: "Kategorya",
    warranty_label: "Warrantya",
    warranty_value: "Garantisadong Orihinal",
    wishlist_btn: "Mga Paborito",
    compare_btn: "Ipaghambing",
    tooltip_wishlist: "Mga Paborito",
    tooltip_compare: "Ipaghambing",
    car_brand: "Brand ng Kotse",
    vin_error: "Bumagsak ang pagpapatunay sa VIN. Mangyaring subukang muli.",
    vin_success_title: "Matagumpay na Natukoy ang Iyong Kotse",
    vin_info_brand: "Brand:",
    vin_info_model: "Modelo:",
    vin_info_year: "Taon:",
    vin_info_engine: "Makina:",
    vin_no_match: "Walang nahanap na katugmang bahagi sa ngayon.",
    vin_exact_match: "Kailangan ng beripikasyon",
    add_to_cart: "Idagdag sa Cart",
    breadcrumb_home: "Tahanan",
    breadcrumb_parts: "Lahat ng Bahagi",
    specs_title: "Mga Teknikal na Detalye",
    quantity: "Dami",
    in_stock: "May Stock",
    out_of_stock: "Walang Stock",
    vin_verified: "Kailangang kumpirmahin sa katalogo ng manufacturer",
    whatsapp_inquiry: "Magtanong sa WhatsApp",
    cart_drawer_title: "Cart ng Pamimili",
    checkout_proceed: "Mag-checkout sa Salla",
    contact_form_name: "Buong Pangalan",
    contact_form_email: "Email Address",
    contact_form_msg: "Iyong Mensahe",
    contact_send_btn: "Ipadala ang Mensahe",
  }
};

let currentLang = localStorage.getItem('qetaa_lang') || 'ar';
let cachedBrands = [];
let cachedCategories = [];

function getTranslation(key) {
    const dict = TRANSLATIONS[currentLang] || TRANSLATIONS['ar'];
    return dict[key] || TRANSLATIONS['ar'][key] || key;
}
window.getTranslation = getTranslation;

function cleanDisplayText(value) {
    return String(value ?? '')
        .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getLocalizedName(item, field = 'name') {
    if (!item) return '';
    if (typeof item === 'string') return cleanDisplayText(item);
    if (field === 'name') {
        const ar = cleanDisplayText(item.name_ar || item.nameAr || '');
        const en = cleanDisplayText(item.name_en || item.nameEn || '');
        if (currentLang === 'ar') return ar || en || cleanDisplayText(item.name) || '';
        return en || ar || cleanDisplayText(item.name) || '';
    }
    const arKey = `${field}_ar`;
    const enKey = `${field}_en`;
    const ar = cleanDisplayText(item[arKey] || '');
    const en = cleanDisplayText(item[enKey] || '');
    if (currentLang === 'ar') return ar || en || cleanDisplayText(item[field]) || '';
    return en || ar || cleanDisplayText(item[field]) || '';
}
window.getLocalizedName = getLocalizedName;

function resolveProductBrand(p) {
    const brand = p?.brand && typeof p.brand === 'object' ? p.brand : null;
    const meta = brand
        ? (findBrandMeta(brand.id) || findBrandMeta(brand.slug) || brand)
        : (findBrandMeta(p?.brand_id) || null);
    const slug = String(meta?.slug || brand?.slug || '').toLowerCase();
    // Prefer Arabic brand name on the storefront card
    const nameAr = meta?.name_ar || brand?.name_ar || '';
    const nameEn = meta?.name_en || brand?.name_en || '';
    const label = nameAr || nameEn || (typeof p?.brand === 'string' ? p.brand : '') || getTranslation('default_brand');
    return { slug, label, nameAr, nameEn };
}

function createProductCardHtml(p) {
    cacheProductSnapshot(p);
    const title = getLocalizedName(p, 'name');
    const { slug: brandSlug, label: brandName } = resolveProductBrand(p);
    const brandLogo = brandLogoMarkup(brandSlug, { sizeClass: 'is-card' });
    const wishlistTooltip = getTranslation('tooltip_wishlist');
    const compareTooltip = getTranslation('tooltip_compare');
    const canBuy = Boolean(
        p.checkout_enabled === true
        && p.in_stock !== false
        && (
            (ZID_LIVE && p.zid_product_id && p.in_stock === true)
            || (SALLA_LIVE && p.salla_product_id)
        )
    );
    const addLabel = canBuy ? getTranslation('add_to_cart') : (getTranslation('add_inquiry') || 'أضف للطلب');
    const buyLabel = getTranslation('buy_now') || 'شراء الآن';
    const priceAmount = p.price_amount || p.price;
    const priceText = priceAmount ? `${parseFloat(priceAmount).toFixed(2)} ${getTranslation('currency_sar')}` : getTranslation('price_on_request');
    const gallery = Array.isArray(p.images)
        ? p.images.map(img => (typeof img === 'string' ? img : (img?.url || ''))).filter(Boolean)
        : [];
    const imageUrl = p.image_url || p.image || gallery[0] || '';
    const secondUrl = gallery.find(url => url && url !== imageUrl) || '';
    const safeTitle = escapeHtml(title);
    const oem = p.oem_number ? String(p.oem_number) : '';
    const waText = encodeURIComponent(`مرحباً CHINA PARTS، أريد الاستفسار عن:\n${title}\nOEM: ${p.oem_number || '-'}`);
    const stockState = p.in_stock === true ? 'available' : (p.in_stock === false ? 'unavailable' : 'unknown');
    const stockLabel = stockState === 'available'
        ? `<span class="product-stock is-in">${escapeHtml(getTranslation('in_stock') || 'متوفر')}</span>`
        : (stockState === 'unavailable'
            ? `<span class="product-stock is-out">${escapeHtml(getTranslation('out_of_stock') || 'غير متوفر')}</span>`
            : `<span class="product-stock is-check">${escapeHtml(getTranslation('stock_needs_confirmation') || 'التوفر يحتاج تأكيد')}</span>`);
    const productArg = JSON.stringify(p).replace(/'/g, "&#39;");
    const primaryAction = canBuy
        ? `<div class="product-cta-row">
                <button class="product-cta" type="button" onclick='addToCart(${productArg})'>
                    ${uiIcon('cartPlus')}<span>${escapeHtml(addLabel)}</span>
                </button>
                <button class="product-cta is-buy-now" type="button" onclick='buyNow(${productArg})'>
                    ${uiIcon('bolt')}<span>${escapeHtml(buyLabel)}</span>
                </button>
           </div>`
        : `<a class="product-cta is-wa" href="https://wa.me/${WHATSAPP_NUMBER}?text=${waText}" target="_blank" rel="noopener noreferrer">
                ${uiIcon('whatsapp')}<span>اطلب عبر واتساب</span>
           </a>`;
    const dualClass = secondUrl ? ' has-dual' : '';
    const dualImages = imageUrl
        ? (secondUrl
            ? `<img class="product-img is-primary" src="${escapeHtml(imageUrl)}" alt="${safeTitle}" loading="lazy" decoding="async" width="320" height="320" onerror="handleProductImageError(this)">
               <img class="product-img is-secondary" src="${escapeHtml(secondUrl)}" alt="${safeTitle}" loading="lazy" decoding="async" width="320" height="320" onerror="this.remove()">
               <div class="img-fallback" hidden><i class="fa-solid fa-image"></i></div>`
            : `<img class="product-img is-primary" src="${escapeHtml(imageUrl)}" alt="${safeTitle}" loading="lazy" decoding="async" width="320" height="320" onerror="handleProductImageError(this)">
               <div class="img-fallback" hidden><i class="fa-solid fa-image"></i></div>`)
        : `<div class="img-fallback"><i class="fa-solid fa-image"></i></div>`;

    return `
        <article class="product-card">
            <a href="product.html?id=${p.id}" class="product-card-img-wrap${dualClass}" aria-label="${safeTitle}">
                ${stockState === 'unavailable' ? `<span class="product-ribbon">${escapeHtml(getTranslation('out_of_stock') || 'غير متوفر')}</span>` : ''}
                ${gallery.length > 1 ? `<span class="product-image-count" aria-hidden="true"><i class="fa-solid fa-images"></i> ${gallery.length}</span>` : ''}
                <span class="product-brand-badge" title="${escapeHtml(brandName)}" aria-label="${escapeHtml(brandName)}">
                    ${brandLogoMarkup(brandSlug, { sizeClass: 'is-overlay' })}
                </span>
                ${dualImages}
            </a>
            <div class="product-card-body">
                <div class="product-brand-line">
                    ${brandLogo}
                    <span class="product-brand-name">${escapeHtml(brandName)}</span>
                </div>
                <a href="product.html?id=${p.id}" class="product-title">${safeTitle}</a>
                ${oem ? `<div class="product-oem">${escapeHtml(oem)}</div>` : ''}
                <div class="product-card-tools is-under-card" onclick="event.preventDefault(); event.stopPropagation();">
                    <button class="product-tool-btn" type="button" data-favorite-product="${p.id}" onclick="event.stopPropagation(); toggleFavorite(${p.id})" title="${escapeHtml(wishlistTooltip)}" aria-label="${escapeHtml(wishlistTooltip)}" aria-pressed="false">
                        ${uiIcon('heartCard')}
                        <span class="product-tool-label">${escapeHtml(getTranslation('wishlist_btn') || 'المفضلة')}</span>
                    </button>
                    <button class="product-tool-btn" type="button" data-compare-product="${p.id}" onclick="event.stopPropagation(); toggleComparison(${p.id})" title="${escapeHtml(compareTooltip)}" aria-label="${escapeHtml(compareTooltip)}" aria-pressed="false">
                        ${uiIcon('compareCard')}
                        <span class="product-tool-label">${escapeHtml(getTranslation('compare_btn') || 'المقارنة')}</span>
                    </button>
                </div>
                <div class="product-footer">
                    <div class="product-price-block">
                        <div class="product-price">${escapeHtml(priceText)}</div>
                        ${stockLabel}
                    </div>
                    ${primaryAction}
                </div>
            </div>
        </article>
    `;
}

function handleProductImageError(img) {
    if (!img) return;
    img.style.display = 'none';
    img.removeAttribute('src');
    const fb = img.nextElementSibling;
    if (fb && fb.classList.contains('img-fallback')) {
        fb.hidden = false;
    } else {
        const fallback = document.createElement('div');
        fallback.className = 'img-fallback';
        fallback.innerHTML = '<i class="fa-solid fa-image"></i>';
        img.parentElement?.appendChild(fallback);
    }
}
window.handleProductImageError = handleProductImageError;
window.createProductCardHtml = createProductCardHtml;

function setLanguage(lang) {
    if (!TRANSLATIONS[lang]) return;
    currentLang = lang;
    localStorage.setItem('qetaa_lang', lang);
    applyTranslations();
}

function applyTranslations() {
    const dict = TRANSLATIONS[currentLang] || TRANSLATIONS['ar'];
    
    // Set html attributes
    const htmlEl = document.documentElement;
    htmlEl.setAttribute('lang', currentLang);
    
    if (currentLang === 'ar' || currentLang === 'ur') {
        htmlEl.setAttribute('dir', 'rtl');
    } else {
        htmlEl.setAttribute('dir', 'ltr');
    }

    // Update document title if data-translate is attached to title tag
    const titleEl = document.querySelector('title[data-translate]');
    if (titleEl && dict[titleEl.dataset.translate]) {
        document.title = dict[titleEl.dataset.translate];
    }
    
    // Translate data-translate elements
    document.querySelectorAll('[data-translate]').forEach(el => {
        const key = el.dataset.translate;
        if (dict[key]) {
            const icon = el.querySelector('i');
            if (icon) {
                el.innerHTML = `${dict[key]} ${icon.outerHTML}`;
            } else {
                el.innerHTML = dict[key];
            }
        }
    });
    
    // Translate placeholders
    document.querySelectorAll('[data-translate-placeholder]').forEach(el => {
        const key = el.dataset.translatePlaceholder;
        if (dict[key]) {
            el.setAttribute('placeholder', dict[key]);
        }
    });

    // Translate title attributes
    document.querySelectorAll('[data-translate-title]').forEach(el => {
        const key = el.dataset.translateTitle;
        if (dict[key]) {
            el.setAttribute('title', dict[key]);
        }
    });

    // Update Language Button Label
    const btnLabel = document.querySelector('#lang-switcher .lang-label');
    if (btnLabel) {
        btnLabel.innerText = currentLang.toUpperCase();
    }

    // Update Floating WhatsApp Tooltip
    const waTooltip = document.querySelector('.floating-wa-btn .wa-tooltip');
    if (waTooltip && typeof WA_TOOLTIPS !== 'undefined') {
        waTooltip.innerText = WA_TOOLTIPS[currentLang] || WA_TOOLTIPS['ar'];
    }

    // Re-render cached header and footer data
    renderHeaderAndFooterData();

    // Trigger page product re-render if available
    if (typeof window.renderCurrentPageProducts === 'function') {
        window.renderCurrentPageProducts();
    }
    if (typeof window.renderHomeBrandsGrid === 'function') {
        window.renderHomeBrandsGrid();
    }
    if (typeof window.renderHomeCategories === 'function') {
        window.renderHomeCategories();
    }
}

function getCustomerToken() {
    return localStorage.getItem('qetaa_customer_token') || '';
}

function setCustomerSession(token, customer) {
    if (token) localStorage.setItem('qetaa_customer_token', token);
    if (customer) {
        localStorage.setItem('qetaa_customer_profile', JSON.stringify(customer));
        if (customer.name) localStorage.setItem('qetaa_customer_name', customer.name);
        if (customer.phone) localStorage.setItem('qetaa_customer_phone', customer.phone);
        if (customer.city) localStorage.setItem('qetaa_customer_city', customer.city);
        if (customer.address) localStorage.setItem('qetaa_customer_address', customer.address);
    }
}

function clearCustomerSession() {
    localStorage.removeItem('qetaa_customer_token');
    localStorage.removeItem('qetaa_customer_profile');
}

function getCustomerSession() {
    try {
        return {
            token: getCustomerToken(),
            customer: JSON.parse(localStorage.getItem('qetaa_customer_profile') || 'null'),
        };
    } catch (_) {
        return { token: getCustomerToken(), customer: null };
    }
}

function injectAccountUI() {
    const actions = document.querySelector('.header-actions');
    if (!actions) return;
    const token = getCustomerToken();
    const customer = getCustomerSession()?.customer || null;
    let wrap = document.getElementById('account-nav-wrap');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.id = 'account-nav-wrap';
        wrap.className = 'account-nav-wrap';
        const cartBtn = actions.querySelector('.cart-trigger');
        const mobileBtn = actions.querySelector('.mobile-menu-btn');
        const before = cartBtn || mobileBtn;
        if (before) actions.insertBefore(wrap, before);
        else actions.appendChild(wrap);
    }

    const guestLinks = `
        <a href="account.html"><i class="fa-solid fa-right-to-bracket"></i> تسجيل الدخول</a>
        <a href="account.html#register"><i class="fa-solid fa-user-plus"></i> إنشاء حساب</a>
        <a href="account.html#orders"><i class="fa-solid fa-box"></i> طلباتي</a>
        <button type="button" data-account-action="wishlist"><i class="fa-solid fa-heart"></i> قائمة الأمنيات</button>
        <a href="account.html#addresses"><i class="fa-solid fa-location-dot"></i> عناويني</a>
        <a href="account.html#settings"><i class="fa-solid fa-gear"></i> إعدادات الحساب</a>
    `;
    const authedLinks = `
        <div class="account-menu-head">${escapeHtml(customer?.name || 'حسابي')}</div>
        <a href="account.html#orders"><i class="fa-solid fa-box"></i> طلباتي</a>
        <button type="button" data-account-action="wishlist"><i class="fa-solid fa-heart"></i> قائمة الأمنيات</button>
        <a href="account.html#addresses"><i class="fa-solid fa-location-dot"></i> عناويني</a>
        <a href="account.html#settings"><i class="fa-solid fa-gear"></i> إعدادات الحساب</a>
        <button type="button" data-account-action="logout" class="is-danger"><i class="fa-solid fa-right-from-bracket"></i> تسجيل الخروج</button>
    `;

    wrap.innerHTML = `
        <button type="button" id="account-nav-btn" class="btn-icon account-nav-btn" aria-haspopup="true" aria-expanded="false" aria-label="${token ? 'حسابي' : 'تسجيل الدخول'}" title="${token ? 'حسابي' : 'تسجيل الدخول'}">
            <i class="fa-solid ${token ? 'fa-user-check' : 'fa-user'}"></i>
        </button>
        <div class="account-dropdown" id="account-dropdown" hidden role="menu">
            ${token ? authedLinks : guestLinks}
        </div>
    `;

    const btn = wrap.querySelector('#account-nav-btn');
    const menu = wrap.querySelector('#account-dropdown');
    const closeMenu = () => {
        if (!menu) return;
        menu.hidden = true;
        btn?.setAttribute('aria-expanded', 'false');
    };
    btn?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const open = menu?.hidden;
        document.querySelectorAll('.account-dropdown').forEach((el) => { el.hidden = true; });
        if (menu) menu.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    menu?.addEventListener('click', async (e) => {
        const actionBtn = e.target.closest('[data-account-action]');
        if (!actionBtn) return;
        e.preventDefault();
        const action = actionBtn.getAttribute('data-account-action');
        closeMenu();
        if (action === 'wishlist') {
            try {
                if (typeof openFavoritesDrawer === 'function') openFavoritesDrawer();
                else window.location.href = 'account.html#wishlist';
            } catch (_) {
                window.location.href = 'account.html#wishlist';
            }
            return;
        }
        if (action === 'logout') {
            try { await apiJson('/storefront/auth/logout', { method: 'POST', body: '{}' }); } catch (_) {}
            clearCustomerSession();
            injectAccountUI();
            showToast(currentLang === 'ar' ? 'تم تسجيل الخروج' : 'Signed out');
            if (location.pathname.includes('account.html')) location.reload();
        }
    });
    if (!window.__accountMenuOutsideBound) {
        window.__accountMenuOutsideBound = true;
        document.addEventListener('click', (e) => {
            if (e.target.closest('#account-nav-wrap')) return;
            document.querySelectorAll('.account-dropdown').forEach((el) => { el.hidden = true; });
            document.querySelectorAll('#account-nav-btn').forEach((b) => b.setAttribute('aria-expanded', 'false'));
        });
    }

    const footerLinks = document.querySelector('.footer-links-inline');
    if (footerLinks && !footerLinks.querySelector('a[href="account.html"]')) {
        const li = document.createElement('li');
        li.innerHTML = `<a href="account.html">${token ? 'حسابي' : 'تسجيل الدخول'}</a>`;
        footerLinks.appendChild(li);
    }
}

async function initAccountPage() {
    const guest = document.getElementById('account-guest');
    const authed = document.getElementById('account-authed');
    if (!guest || !authed) return;

    const loginForm = document.getElementById('account-login-form');
    const registerForm = document.getElementById('account-register-form');
    const profileForm = document.getElementById('account-profile-form');
    const ordersBox = document.getElementById('account-orders');
    const title = document.getElementById('account-page-title');
    const desc = document.getElementById('account-page-desc');

    document.querySelectorAll('[data-account-tab]').forEach((tab) => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('[data-account-tab]').forEach((t) => t.classList.remove('is-active'));
            tab.classList.add('is-active');
            const mode = tab.getAttribute('data-account-tab');
            if (loginForm) loginForm.hidden = mode !== 'login';
            if (registerForm) registerForm.hidden = mode !== 'register';
        });
    });

    const showAuthed = (customer) => {
        guest.hidden = true;
        authed.hidden = false;
        if (title) title.textContent = `مرحباً، ${customer.name || 'عميلنا'}`;
        if (desc) desc.textContent = 'إدارة بياناتك ومتابعة طلباتك السابقة.';
        const setVal = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.value = val || '';
        };
        setVal('profile-name', customer.name);
        setVal('profile-phone', customer.phone);
        setVal('profile-email', customer.email);
        setVal('profile-city', customer.city);
        setVal('profile-address', customer.address);
        const phoneInput = document.getElementById('profile-phone');
        if (phoneInput) {
            phoneInput.required = false;
            phoneInput.classList.remove('is-required-highlight');
        }
        const addrPreview = document.getElementById('account-address-preview');
        if (addrPreview) {
            const bits = [customer.city, customer.address].filter(Boolean).join(' — ');
            addrPreview.textContent = bits || 'لا يوجد عنوان محفوظ بعد. حدّث بياناتك أعلاه.';
        }
        loadAccountOrders();
    };

    const showGuest = () => {
        guest.hidden = false;
        authed.hidden = true;
        if (title) title.textContent = 'حسابي';
        if (desc) desc.textContent = 'سجّل الدخول لمتابعة طلباتك وحفظ بيانات الشحن.';
    };

    async function loadAccountOrders() {
        if (!ordersBox) return;
        const setOrderMessage = (message, className = 'text-muted') => {
            const p = document.createElement('p');
            p.className = className;
            p.textContent = message;
            ordersBox.replaceChildren(p);
        };
        setOrderMessage('جاري تحميل الطلبات...');
        try {
            const data = await apiJson('/storefront/account/orders');
            const orders = Array.isArray(data.orders) ? data.orders : [];
            if (!orders.length) {
                setOrderMessage('لا توجد طلبات بعد. ابدأ التسوق من صفحة القطع.');
                return;
            }
            const cards = orders.map((o) => {
                const article = document.createElement('article');
                article.className = 'account-order-card';

                const top = document.createElement('div');
                top.className = 'account-order-top';
                const orderNumber = document.createElement('strong');
                orderNumber.textContent = `طلب #${String(o.id ?? '')}`;
                const status = document.createElement('span');
                status.textContent = String(o.status || 'received');
                top.append(orderNumber, status);

                const summary = document.createElement('p');
                const amount = Number(o.total_amount || 0);
                summary.textContent = `${String(o.created_at || '')} · ${Number(o.items_count || 0)} قطعة · ${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'} ر.س`;

                const address = document.createElement('p');
                address.className = 'text-muted';
                address.textContent = [o.customer_city, o.customer_address].filter(Boolean).join(' — ');
                article.append(top, summary, address);
                return article;
            });
            ordersBox.replaceChildren(...cards);
        } catch (e) {
            setOrderMessage(String(e.message || 'تعذر تحميل الطلبات'), 'text-error');
        }
    }

    if (getCustomerToken()) {
        try {
            const me = await apiJson('/storefront/auth/me');
            setCustomerSession(getCustomerToken(), me.customer);
            showAuthed(me.customer);
        } catch (e) {
            clearCustomerSession();
            showGuest();
        }
    } else {
        showGuest();
    }

    document.getElementById('account-open-wishlist')?.addEventListener('click', () => {
        try { openFavoritesDrawer(); } catch (_) {}
    });

    const applyAccountHash = () => {
        const hash = (location.hash || '').replace('#', '');
        if (hash === 'register') {
            document.querySelector('[data-account-tab="register"]')?.click();
            return;
        }
        if (hash === 'login') {
            document.querySelector('[data-account-tab="login"]')?.click();
            return;
        }
        if (['orders', 'wishlist', 'addresses', 'settings'].includes(hash)) {
            const el = document.getElementById(hash);
            if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120);
        }
    };
    applyAccountHash();
    window.addEventListener('hashchange', applyAccountHash);

    loginForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const data = await apiJson('/storefront/auth/login', {
                method: 'POST',
                body: JSON.stringify({
                    phone: document.getElementById('login-phone')?.value || '',
                    password: document.getElementById('login-password')?.value || '',
                }),
            });
            setCustomerSession(data.token, data.customer);
            showToast('تم تسجيل الدخول بنجاح', 'success');
            injectAccountUI();
            const btn = document.getElementById('account-nav-btn');
            if (btn) {
                btn.innerHTML = '<i class="fa-solid fa-user-check"></i>';
                btn.title = 'حسابي';
            }
            showAuthed(data.customer);
        } catch (err) {
            showToast(err.message || 'تعذر تسجيل الدخول', 'error');
        }
    });

    registerForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const data = await apiJson('/storefront/auth/register', {
                method: 'POST',
                body: JSON.stringify({
                    name: document.getElementById('register-name')?.value || '',
                    phone: document.getElementById('register-phone')?.value || '',
                    email: document.getElementById('register-email')?.value || '',
                    city: document.getElementById('register-city')?.value || '',
                    password: document.getElementById('register-password')?.value || '',
                }),
            });
            setCustomerSession(data.token, data.customer);
            showToast('تم إنشاء الحساب بنجاح', 'success');
            showAuthed(data.customer);
        } catch (err) {
            showToast(err.message || 'تعذر إنشاء الحساب', 'error');
        }
    });

    profileForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
            const data = await apiJson('/storefront/account/profile', {
                method: 'POST',
                body: JSON.stringify({
                    name: document.getElementById('profile-name')?.value || '',
                    phone: document.getElementById('profile-phone')?.value || '',
                    email: document.getElementById('profile-email')?.value || '',
                    city: document.getElementById('profile-city')?.value || '',
                    address: document.getElementById('profile-address')?.value || '',
                    password: document.getElementById('profile-password')?.value || '',
                }),
            });
            setCustomerSession(getCustomerToken(), data.customer);
            document.getElementById('profile-password').value = '';
            showToast('تم حفظ البيانات', 'success');
            showAuthed(data.customer);
            injectAccountUI();
        } catch (err) {
            showToast(err.message || 'تعذر الحفظ', 'error');
        }
    });

    document.getElementById('account-logout-btn')?.addEventListener('click', async () => {
        try {
            await apiJson('/storefront/auth/logout', { method: 'POST', body: '{}' });
        } catch (e) {}
        clearCustomerSession();
        showToast('تم تسجيل الخروج');
        showGuest();
        injectAccountUI();
    });

    initGoogleSignIn({
        onSuccess: (customer) => {
            showAuthed(customer);
            injectAccountUI();
        },
    });
}

function loadGoogleIdentityScript() {
    return new Promise((resolve, reject) => {
        if (window.google?.accounts?.id) {
            resolve();
            return;
        }
        const existing = document.querySelector('script[data-google-gsi]');
        if (existing) {
            existing.addEventListener('load', () => resolve());
            existing.addEventListener('error', () => reject(new Error('gsi_load_failed')));
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://accounts.google.com/gsi/client';
        script.async = true;
        script.defer = true;
        script.dataset.googleGsi = '1';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('gsi_load_failed'));
        document.head.appendChild(script);
    });
}

async function initGoogleSignIn({ onSuccess } = {}) {
    const wrap = document.getElementById('google-auth-wrap');
    const btnHost = document.getElementById('google-signin-btn');
    const cta = document.getElementById('google-auth-cta');
    if (!wrap || (!btnHost && !cta)) return;

    let cfg = null;
    try {
        cfg = await apiJson('/storefront/auth/google/config');
    } catch (_) {
        wrap.hidden = true;
        return;
    }
    if (!cfg?.enabled || !cfg.client_id) {
        wrap.hidden = true;
        return;
    }

    try {
        await loadGoogleIdentityScript();
    } catch (_) {
        wrap.hidden = true;
        return;
    }
    if (!window.google?.accounts) {
        wrap.hidden = true;
        return;
    }

    const setBusy = (busy) => {
        if (!cta) return;
        cta.disabled = Boolean(busy);
        const spinner = cta.querySelector('.google-auth-cta-spinner');
        const text = cta.querySelector('.google-auth-cta-text');
        if (spinner) spinner.hidden = !busy;
        if (text) text.textContent = busy ? 'جاري فتح Google...' : 'المتابعة باستخدام Google';
    };

    const handleCredential = async (response) => {
        try {
            setBusy(true);
            const data = await apiJson('/storefront/auth/google', {
                method: 'POST',
                body: JSON.stringify({ id_token: response.credential }),
            });
            setCustomerSession(data.token, data.customer);
            showToast('تم تسجيل الدخول عبر Google', 'success');
            if (typeof onSuccess === 'function') onSuccess(data.customer);
            else injectAccountUI();
        } catch (err) {
            showToast(err.message || 'تعذر الدخول عبر Google', 'error');
        } finally {
            setBusy(false);
        }
    };

    const handleAccessToken = async (tokenResponse) => {
        if (!tokenResponse || tokenResponse.error || !tokenResponse.access_token) {
            if (tokenResponse?.error && tokenResponse.error !== 'popup_closed_by_user') {
                showToast('تعذر إكمال الدخول عبر Google', 'error');
            }
            setBusy(false);
            return;
        }
        try {
            setBusy(true);
            const data = await apiJson('/storefront/auth/google', {
                method: 'POST',
                body: JSON.stringify({ access_token: tokenResponse.access_token }),
            });
            setCustomerSession(data.token, data.customer);
            showToast('تم تسجيل الدخول عبر Google', 'success');
            if (typeof onSuccess === 'function') onSuccess(data.customer);
            else injectAccountUI();
        } catch (err) {
            showToast(err.message || 'تعذر الدخول عبر Google', 'error');
        } finally {
            setBusy(false);
        }
    };

    if (window.google.accounts.id) {
        window.google.accounts.id.initialize({
            client_id: cfg.client_id,
            callback: handleCredential,
            auto_select: false,
            cancel_on_tap_outside: true,
            context: 'signin',
            ux_mode: 'popup',
        });
    }

    wrap.hidden = false;

    if (cta && window.google.accounts.oauth2?.initTokenClient) {
        const tokenClient = window.google.accounts.oauth2.initTokenClient({
            client_id: cfg.client_id,
            scope: 'openid email profile',
            callback: handleAccessToken,
            error_callback: () => setBusy(false),
        });
        cta.addEventListener('click', () => {
            setBusy(true);
            try {
                tokenClient.requestAccessToken({ prompt: 'select_account' });
            } catch (_) {
                setBusy(false);
                showToast('تعذر فتح نافذة Google', 'error');
            }
        });
        return;
    }

    // Fallback: official Google button if oauth2 token client is unavailable.
    if (btnHost && window.google.accounts.id?.renderButton) {
        btnHost.hidden = false;
        btnHost.style.display = 'flex';
        btnHost.innerHTML = '';
        if (cta) cta.hidden = true;
        window.google.accounts.id.renderButton(btnHost, {
            type: 'standard',
            theme: 'outline',
            size: 'large',
            text: 'continue_with',
            shape: 'rectangular',
            logo_alignment: 'left',
            width: Math.min(400, Math.max(280, wrap.clientWidth || 320)),
            locale: currentLang === 'ar' ? 'ar' : 'en',
        });
    }
}

function injectLanguageSwitcher() {
    const actions = document.querySelector('.header-actions');
    const target = actions || document.querySelector('.header-main, .header-wrapper');
    if (!target) return;

    // Find or create language switcher container
    let switcher = document.getElementById('lang-switcher-container');
    if (!switcher) {
        switcher = document.createElement('div');
        switcher.id = 'lang-switcher-container';
        switcher.className = 'lang-switcher-container';
        switcher.innerHTML = `
            <button class="btn-icon lang-switcher-btn" id="lang-switcher" type="button" aria-label="تبديل اللغة" aria-haspopup="listbox" aria-expanded="false">
                ${uiIcon('globe')}
                <span class="lang-label">${currentLang.toUpperCase()}</span>
            </button>
            <div class="lang-dropdown" id="lang-dropdown" hidden role="listbox" aria-label="اختر اللغة">
                <button type="button" role="option" data-lang="ar">العربية</button>
                <button type="button" role="option" data-lang="en">English</button>
                <button type="button" role="option" data-lang="ur">اردو</button>
                <button type="button" role="option" data-lang="fr">Français</button>
                <button type="button" role="option" data-lang="tr">Türkçe</button>
                <button type="button" role="option" data-lang="hi">हिन्दी</button>
                <button type="button" role="option" data-lang="bn">বাংলা</button>
                <button type="button" role="option" data-lang="tl">Tagalog</button>
            </div>
        `;

        if (actions) {
            const cartBtn = actions.querySelector('.cart-trigger');
            const mobileBtn = actions.querySelector('.mobile-menu-btn');
            const before = cartBtn || mobileBtn;
            if (before) actions.insertBefore(switcher, before);
            else actions.appendChild(switcher);
        } else {
            target.appendChild(switcher);
        }

        const btn = document.getElementById('lang-switcher');
        const dropdown = document.getElementById('lang-dropdown');
        if (btn && dropdown) {
            const closeLangMenu = () => {
                dropdown.hidden = true;
                btn.setAttribute('aria-expanded', 'false');
            };
            const openLangMenu = () => {
                dropdown.hidden = false;
                btn.setAttribute('aria-expanded', 'true');
            };

            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (dropdown.hidden) openLangMenu();
                else closeLangMenu();
            });

            dropdown.addEventListener('click', (e) => {
                const opt = e.target.closest('[data-lang]');
                if (!opt) return;
                e.preventDefault();
                e.stopPropagation();
                window.setLanguage(opt.dataset.lang);
                closeLangMenu();
            });

            document.addEventListener('click', closeLangMenu);
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') closeLangMenu();
            });
        }
    }
}

// State
let cart = [];
let buyNowPreviousCart = null;
let favoriteItems = [];
let comparisonItems = [];
// Legacy aliases used by button checks
let favorites = [];
let comparisons = [];
let interactionsReady = false;
let interactionsSeq = 0;
const productSnapshotCache = new Map();
const interactionInFlight = new Set();
const interactionIntent = new Map(); // fav:/cmp: -> 'on' | 'off'

function cacheProductSnapshot(product) {
    if (!product || product.id == null) return;
    const id = Number(product.id);
    productSnapshotCache.set(id, normalizeInteractionItem(product));
}

function normalizeInteractionItem(product) {
    const id = Number(product.id);
    const priceAmount = product.price_amount ?? product.price ?? null;
    return {
        id,
        name_ar: product.name_ar || product.name || '',
        name_en: product.name_en || product.name_ar || '',
        oem_number: product.oem_number || null,
        price: priceAmount != null && priceAmount !== '' ? Number(priceAmount) : null,
        price_label: product.price_label || (priceAmount ? `${parseFloat(priceAmount).toFixed(2)} ر.س` : 'السعر عند الطلب'),
        brand: product.brand || null,
        category: product.category || null,
        image_url: resolveProductImage(product) || null,
        can_checkout: product.can_checkout === true,
        checkout_enabled: product.checkout_enabled === true,
        in_stock: product.in_stock === true ? true : (product.in_stock === false ? false : null),
        salla_product_id: product.salla_product_id || null,
        zid_product_id: product.zid_product_id || null,
        zid_sku: product.zid_sku || null,
        checkout_provider: product.checkout_provider || null,
    };
}

function paintInteractionChrome() {
    syncInteractionAliases();
    refreshInteractionButtons();
    updateInteractionBadges();
    persistInteractionsCache();
}

function applyInteractionUi({ renderLists = true } = {}) {
    paintInteractionChrome();
    if (!renderLists) return;
    // Only rebuild open panels so clicks stay snappy
    if (document.getElementById('favorites-drawer')?.classList.contains('open')) {
        renderFavoritesDrawer();
    }
    if (document.getElementById('compare-panel')?.classList.contains('open')) {
        renderComparePanel();
    }
}

function hydrateInteractionsFromCache() {
    try {
        const fav = JSON.parse(localStorage.getItem('qetaa_favorites') || '[]');
        const cmp = JSON.parse(localStorage.getItem('qetaa_comparisons') || '[]');
        if (Array.isArray(fav)) favoriteItems = fav.map(normalizeInteractionItem);
        if (Array.isArray(cmp)) comparisonItems = cmp.map(normalizeInteractionItem);
        syncInteractionAliases();
    } catch (e) {
        favoriteItems = [];
        comparisonItems = [];
    }
}

function persistInteractionsCache() {
    try {
        localStorage.setItem('qetaa_favorites', JSON.stringify(favoriteItems));
        localStorage.setItem('qetaa_comparisons', JSON.stringify(comparisonItems));
    } catch (e) {}
}

function queueInteractionSync(task) {
    // Let the browser paint the drawer/badge first, then talk to the API.
    setTimeout(() => {
        Promise.resolve()
            .then(task)
            .catch(() => {});
    }, 0);
}

function resolveInteractionHint(productId, productHint) {
    const id = Number(productId);
    if (productHint && typeof productHint === 'object') {
        cacheProductSnapshot(productHint);
        return normalizeInteractionItem({ ...productHint, id });
    }
    if (productSnapshotCache.has(id)) return { ...productSnapshotCache.get(id) };
    const existing = favoriteItems.find(i => Number(i.id) === id) || comparisonItems.find(i => Number(i.id) === id);
    if (existing) return { ...existing };
    return { id, name_ar: `منتج #${id}`, name_en: `Product #${id}`, price_label: 'السعر عند الطلب', image_url: null };
}

const WA_TOOLTIPS = {
    ar: "تواصل معنا مباشرة",
    en: "Chat with us",
    ur: "ہم سے رابطہ کریں",
    fr: "Contactez-nous",
    tr: "Bizimle iletişime geçin",
    hi: "हमसे बात करें",
    bn: "আমাদের সাথে যোগাযোগ করুন",
    tl: "Kausapin kami"
};

function injectFloatingWhatsApp() {
    let waBtn = document.getElementById('floating-whatsapp');
    if (waBtn) {
        waBtn.href = `https://wa.me/${WHATSAPP_NUMBER}?text=` + encodeURIComponent('مرحباً CHINA PARTS، أود الاستفسار عن قطع غيار لسيارتي.');
        const tip = waBtn.querySelector('.wa-tooltip');
        if (tip) tip.textContent = WA_TOOLTIPS[currentLang] || WA_TOOLTIPS.ar;
        if (!waBtn.querySelector('.ui-icon')) {
            const tipHtml = tip ? tip.outerHTML : `<span class="wa-tooltip">${WA_TOOLTIPS[currentLang] || WA_TOOLTIPS.ar}</span>`;
            waBtn.innerHTML = `${uiIcon('whatsapp')}${tipHtml}`;
        }
        return;
    }

    waBtn = document.createElement('a');
    waBtn.id = 'floating-whatsapp';
    waBtn.href = `https://wa.me/${WHATSAPP_NUMBER}?text=` + encodeURIComponent('مرحباً CHINA PARTS، أود الاستفسار عن قطع غيار لسيارتي.');
    waBtn.target = '_blank';
    waBtn.rel = 'noopener noreferrer';
    waBtn.setAttribute('aria-label', 'WhatsApp');
    waBtn.className = 'floating-wa-btn';
    waBtn.innerHTML = `
        ${uiIcon('whatsapp')}
        <span class="wa-tooltip">${WA_TOOLTIPS[currentLang] || WA_TOOLTIPS.ar}</span>
    `;
    document.body.appendChild(waBtn);
}

function renderHeaderAndFooterData() {
    if (!cachedBrands.length && !cachedCategories.length) return;

    // Populate Brands Dropdown Menu in Navbar
    const menu = document.getElementById('brands-dropdown-menu');
    if (menu) {
        menu.classList.add('brands-list-menu');
        const brandsForMenu = cachedBrands.slice(0, 24);
        const tiles = brandsForMenu.map(brand => {
            const label = escapeHtml(getLocalizedName(brand));
            const slug = String(brand.slug || '').toLowerCase();
            return `
                <a href="${slug ? `/brands/${encodeURIComponent(slug)}/` : `collection.html?brand=${brand.id}`}" class="brand-menu-tile" title="${label}">
                    ${brandLogoMarkup(slug, { sizeClass: 'is-menu' })}
                    <span class="brand-menu-tile-name">${label}</span>
                </a>
            `;
        }).join('');
        menu.innerHTML = `
            <div class="brands-dropdown-head">
                <span>الماركات</span>
                <a href="collection.html" class="brands-dropdown-all">عرض الكل</a>
            </div>
            <div class="brands-dropdown-grid">${tiles}</div>
        `;
    }

    // Footer no longer lists brands/categories — keep hooks empty-safe
    const footerBrands = document.getElementById('footer-brands-list');
    if (footerBrands) footerBrands.innerHTML = '';
    const footerCats = document.getElementById('footer-categories-list');
    if (footerCats) footerCats.innerHTML = '';

    // Populate Homepage Search Dropdown (if present)
    const brandSelect = document.getElementById('search-brand');
    if (brandSelect) {
        const placeholder = brandSelect.querySelector('option[value=""]');
        brandSelect.innerHTML = '';
        if (placeholder) {
            placeholder.textContent = getTranslation('select_brand');
            brandSelect.appendChild(placeholder);
        } else {
            brandSelect.innerHTML = `<option value="">${getTranslation('select_brand')}</option>`;
        }
        cachedBrands.forEach(brand => {
            const opt = document.createElement('option');
            opt.value = brand.id;
            opt.textContent = getLocalizedName(brand);
            if (brand.slug) opt.dataset.slug = brand.slug;
            brandSelect.appendChild(opt);
        });
    }

    // Populate Homepage Search Categories (featured only — avoid 500+ noise)
    const catSelect = document.getElementById('search-category');
    if (catSelect) {
        catSelect.innerHTML = `<option value="">${getTranslation('select_engine')}</option>`;
        HOME_FEATURED_CATEGORIES.forEach(featured => {
            const opt = document.createElement('option');
            opt.value = featured.key;
            opt.dataset.categoryKey = featured.key;
            opt.textContent = currentLang === 'ar' ? featured.name_ar : featured.name_en;
            catSelect.appendChild(opt);
        });
    }

    enhanceStorefrontSelects();

    // Setup Brand Marquee (if present)
    const marquee = document.getElementById('brands-marquee-content');
    if (marquee) {
        const marqueeItems = (cachedBrands.length ? cachedBrands : CHINESE_BRANDS_CATALOG).map(brand => {
            const slug = String(brand.slug || '').toLowerCase();
            const label = escapeHtml(getLocalizedName(brand) || brand.name_ar || brand.name_en || slug);
            const logo = escapeHtml(getBrandLogoUrl(brand));
            const fallback = escapeHtml(getBrandLogoFallback(brand));
            return `
            <div class="marquee-item" title="${label}">
                <img src="${logo}" alt="${label}" loading="lazy" decoding="async"
                     onerror="if(!this.dataset.s){this.dataset.s=1;this.src='${fallback}';}else{this.style.display='none';this.nextElementSibling.hidden=false;}">
                <span hidden>${label}</span>
            </div>`;
        }).join('');
        marquee.innerHTML = marqueeItems + marqueeItems;
    }

    const quickBrands = document.getElementById('quick-brands');
    if (quickBrands) {
        quickBrands.innerHTML = cachedBrands.slice(0, 10).map(brand => `
            <button type="button" class="chip-btn" data-brand-id="${brand.id}">${escapeHtml(getLocalizedName(brand))}</button>
        `).join('');
        quickBrands.querySelectorAll('[data-brand-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const brandSelect = document.getElementById('search-brand');
                if (brandSelect) {
                    brandSelect.value = btn.dataset.brandId;
                    brandSelect.dispatchEvent(new Event('change'));
                }
                btn.classList.add('active');
                quickBrands.querySelectorAll('.chip-btn').forEach(b => {
                    if (b !== btn) b.classList.remove('active');
                });
            });
        });
    }

    const homeCats = document.getElementById('home-category-cards');
    if (homeCats) {
        renderHomeCategories();
    }

    renderHomeBrandsGrid();
}

async function initGlobalHeaderAndFooter() {
    try {
        // Session cache avoids re-hitting slow endpoints on every navigation.
        const cacheKey = 'qetaa_catalog_cache_v3';
        const cached = (() => {
            try {
                const raw = sessionStorage.getItem(cacheKey);
                if (!raw) return null;
                const parsed = JSON.parse(raw);
                if (!parsed || !Array.isArray(parsed.brands)) return null;
                if (Date.now() - Number(parsed.ts || 0) > 10 * 60 * 1000) return null;
                return parsed;
            } catch (e) {
                return null;
            }
        })();

        if (cached) {
            cachedBrands = cached.brands || [];
            cachedCategories = cached.categories || [];
            renderHeaderAndFooterData();
        }

        const [resBrands, resCats] = await Promise.all([
            fetch(`${API_BASE}/brands`).then(r => r.json().catch(() => [])),
            fetch(`${API_BASE}/categories`).then(r => r.json().catch(() => []))
        ]);

        cachedBrands = Array.isArray(resBrands) ? resBrands : [];
        cachedCategories = Array.isArray(resCats) ? resCats : [];
        try {
            sessionStorage.setItem(cacheKey, JSON.stringify({
                ts: Date.now(),
                brands: cachedBrands,
                categories: cachedCategories,
            }));
        } catch (e) {}
        renderHeaderAndFooterData();

    } catch (e) {
        console.error("Error populating header/footer: ", e);
    }

    initGlobalSearchBar();
}

let globalSearchBarReady = false;
function goToSearchResults(q) {
    const term = String(q || '').trim();
    if (term.length < 2) return;
    if (typeof window.trackAdsEvent === 'function') {
        window.trackAdsEvent('search', { search_string: term, search_term: term });
    }
    window.location.href = `collection.html?q=${encodeURIComponent(term)}`;
}

function initGlobalSearchBar() {
    if (globalSearchBarReady) return;
    const searchInput = document.getElementById('global-search-input');
    const searchResults = document.getElementById('global-search-results');
    const searchList = document.getElementById('global-search-list');
    const searchLoading = document.getElementById('global-search-loading');
    const vinNotice = document.getElementById('global-search-vin-notice');
    const vinVehicleName = document.getElementById('vin-vehicle-name');
    if (!searchInput || !searchResults || !searchList) return;

    globalSearchBarReady = true;
    let searchTimeout;
    let searchSeq = 0;
    let activeSearchController = null;

    const searchIcon = searchInput.parentElement?.querySelector('i.fa-magnifying-glass, :scope > .ui-icon');
    if (searchIcon) {
        searchIcon.style.pointerEvents = 'auto';
        searchIcon.style.cursor = 'pointer';
        searchIcon.title = 'بحث';
        searchIcon.addEventListener('click', () => goToSearchResults(searchInput.value));
    }

    searchInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        const q = searchInput.value.trim();
        if (q.length < 2) return;
        e.preventDefault();
        goToSearchResults(q);
    });

    searchInput.addEventListener('input', (e) => {
        const q = e.target.value.trim();

        clearTimeout(searchTimeout);
        searchSeq += 1;
        if (activeSearchController) {
            activeSearchController.abort();
            activeSearchController = null;
        }

        if (q.length < 2) {
            searchList.replaceChildren();
            if (searchLoading) {
                searchLoading.hidden = true;
                searchLoading.style.display = 'none';
            }
            if (vinNotice) {
                vinNotice.hidden = true;
                vinNotice.style.display = 'none';
            }
            searchResults.hidden = true;
            searchResults.style.display = 'none';
            return;
        }

        searchResults.hidden = false;
        searchResults.style.display = 'block';
        searchList.innerHTML = '';
        if (vinNotice) {
            vinNotice.hidden = true;
            vinNotice.style.display = 'none';
        }
        if (searchLoading) {
            searchLoading.hidden = false;
            searchLoading.style.display = 'block';
        }

        const seq = searchSeq;
        searchTimeout = setTimeout(async () => {
            const controller = new AbortController();
            activeSearchController = controller;
            try {
                const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(q)}&limit=10`, {
                    signal: controller.signal,
                });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json();
                if (seq !== searchSeq) return;

                if (searchLoading) {
                    searchLoading.hidden = true;
                    searchLoading.style.display = 'none';
                }

                if (data.type === 'vin' && data.vehicle && vinNotice && vinVehicleName) {
                    vinNotice.hidden = false;
                    vinNotice.style.display = 'flex';
                    vinVehicleName.textContent = `تم التعرف على سيارتك: ${data.vehicle.name} - القطع المتوافقة:`;
                }

                if (!data.results || data.results.length === 0) {
                    const suggestions = Array.isArray(data.suggestions)
                        ? data.suggestions.slice(0, 5)
                        : [];
                    searchList.innerHTML = `
                        <div style="padding: 15px; text-align: center; color: var(--color-text-muted);">لم يتم العثور على نتائج.</div>
                        ${suggestions.length ? `
                            <div class="global-search-suggestions" aria-label="اقتراحات البحث">
                                ${suggestions.map((label) => `
                                    <a href="collection.html?q=${encodeURIComponent(label)}">${escapeHtml(label)}</a>
                                `).join('')}
                            </div>` : ''}
                        <a href="collection.html?q=${encodeURIComponent(q)}" class="global-search-more">عرض صفحة البحث</a>`;
                    return;
                }

                const items = data.results.slice(0, 8).map(p => {
                    const title = p.name_ar || p.name_en || '';
                    const brandLabel = typeof p.brand === 'object' && p.brand
                        ? (p.brand.name_ar || p.brand.name_en || '')
                        : (p.brand_name || p.brand || '');
                    const priceLabel = p.price_label
                        || (p.price != null && p.price !== '' ? `${parseFloat(p.price).toFixed(2)} ${getTranslation('currency_sar')}` : getTranslation('price_on_request'));
                    const image = p.image || p.image_url || '';
                    return `
                    <a href="product.html?id=${p.id}" class="global-search-item">
                        <img src="${escapeHtml(image)}" alt="" loading="lazy" width="50" height="50" onerror="this.style.opacity='0.25'">
                        <div class="global-search-item-body">
                            <h4>${escapeHtml(title)}</h4>
                            <div class="global-search-item-meta">
                                <span><i class="fa-solid fa-car"></i> ${escapeHtml(brandLabel)}</span>
                                <span><i class="fa-solid fa-barcode"></i> ${escapeHtml(p.oem_number || '')}</span>
                            </div>
                        </div>
                        <div class="global-search-item-price">${escapeHtml(priceLabel)}</div>
                    </a>`;
                }).join('');
                searchList.innerHTML = `${items}<a href="collection.html?q=${encodeURIComponent(q)}" class="global-search-more">عرض كل النتائج</a>`;
            } catch (err) {
                if (err?.name === 'AbortError') return;
                console.error(err);
                if (seq !== searchSeq) return;
                if (searchLoading) {
                    searchLoading.hidden = true;
                    searchLoading.style.display = 'none';
                }
                searchList.innerHTML = `
                    <div style="padding: 15px; text-align: center; color: var(--color-error);">
                        تعذر الاتصال بخادم البحث.<br>
                        تأكد أن الموقع يعمل عبر السيرفر ثم أعد تحميل الصفحة
                        (<a href="${location.origin}/" style="color:inherit;text-decoration:underline">${location.origin}/</a>).
                    </div>`;
                showApiDownBanner();
            } finally {
                if (activeSearchController === controller) activeSearchController = null;
            }
        }, 280);
    });

    document.addEventListener('click', (e) => {
        if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
            searchResults.hidden = true;
            searchResults.style.display = 'none';
        }
    });
}

// --- Toast System ---
function showToast(message, type = 'success') {
    let container = document.getElementById('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? 'fa-circle-check' : (type === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info');

    const iconEl = document.createElement('i');
    iconEl.className = `fa-solid ${icon}`;
    iconEl.setAttribute('aria-hidden', 'true');
    const messageEl = document.createElement('span');
    messageEl.textContent = String(message ?? '');
    toast.append(iconEl, messageEl);
    
    container.appendChild(toast);
    
    // Trigger animation
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Auto remove
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// --- Cart System ---
function initCart() {
    const saved = localStorage.getItem('qetaa_cart');
    if (saved) {
        try { cart = JSON.parse(saved); } catch (e) { cart = []; }
    }
    cart = Array.isArray(cart) ? cart.filter(item => item && item.id != null) : [];
    saveCart();
}

function saveCart() {
    localStorage.setItem('qetaa_cart', JSON.stringify(cart));
}

function buildCartItem(product, quantity = 1) {
    const image = product.image_url || product.image || (Array.isArray(product.images) && product.images.length ? (product.images[0].url || product.images[0]) : null) || '';
    const price = product.price !== null && product.price !== undefined ? parseFloat(product.price) : 0;
    return {
        id: product.id,
        title: product.title || product.name_ar || product.name_en,
        price: Number.isFinite(price) ? price : 0,
        image: image || '',
        quantity: quantity,
        brand: product.brand?.name_ar || (typeof product.brand === 'string' ? product.brand : '') || 'قطع غيار',
        oem_number: product.oem_number || '',
        salla_product_id: product.salla_product_id || null,
        zid_product_id: product.zid_product_id || null,
        zid_sku: product.zid_sku || null,
        checkout_provider: product.checkout_provider || (product.zid_product_id ? 'zid' : (product.salla_product_id ? 'salla' : null)),
        in_stock: product.in_stock === true ? true : (product.in_stock === false ? false : null),
        checkout_enabled: product.checkout_enabled === true,
        can_checkout: product.checkout_enabled === true,
    };
}

function addToCart(product, quantity = 1) {
    if (!product || product.id == null) {
        showToast('تعذر إضافة المنتج', 'error');
        return;
    }
    const image = product.image_url || product.image || (Array.isArray(product.images) && product.images.length ? (product.images[0].url || product.images[0]) : null) || '';
    const qty = Math.max(1, parseInt(quantity, 10) || 1);

    const itemIndex = cart.findIndex(item => item.id === product.id);
    if (itemIndex > -1) {
        cart[itemIndex].quantity += qty;
        if (!cart[itemIndex].image && image) cart[itemIndex].image = image;
    } else {
        cart.push(buildCartItem(product, qty));
    }

    saveCart();
    renderCart();
    showToast(`تم إضافة "${product.title || product.name_ar}" للطلب`);
    if (typeof window.trackAdsEvent === 'function') {
        const price = Number(product.price || product.price_amount || 0);
        window.trackAdsEvent('add_to_cart', {
            content_ids: [String(product.id)],
            content_name: product.name_ar || product.title || '',
            content_type: 'product',
            value: Number.isFinite(price) ? price : 0,
            currency: 'SAR',
        });
    }
}

function releaseBuyNowCart() {
    if (!buyNowPreviousCart) return;
    cart = buyNowPreviousCart;
    buyNowPreviousCart = null;
    saveCart();
    renderCart();
}

function settleBuyNowCart(removePurchased) {
    const purchasedIds = new Set(cart.map(item => item.id));
    if (buyNowPreviousCart) {
        cart = removePurchased
            ? buyNowPreviousCart.filter(item => !purchasedIds.has(item.id))
            : buyNowPreviousCart.map(item => ({ ...item }));
        buyNowPreviousCart = null;
    } else if (removePurchased) {
        cart = [];
    } else {
        return;
    }
    saveCart();
    renderCart();
}

function preserveCartForExternalCheckout() {
    if (!buyNowPreviousCart) return;
    const merged = buyNowPreviousCart.map(item => ({ ...item }));
    cart.forEach((item) => {
        const existing = merged.find(candidate => String(candidate.id) === String(item.id));
        if (existing) {
            existing.quantity = Math.max(Number(existing.quantity) || 0, Number(item.quantity) || 1);
            if (!existing.image && item.image) existing.image = item.image;
        } else {
            merged.push({ ...item });
        }
    });
    cart = merged;
    buyNowPreviousCart = null;
    saveCart();
    renderCart();
}

function buyNow(product, quantity = 1) {
    if (!product || product.id == null) {
        showToast('تعذر بدء الشراء', 'error');
        return;
    }
    const qty = Math.max(1, parseInt(quantity, 10) || 1);
    if (!buyNowPreviousCart) {
        buyNowPreviousCart = cart.map(item => ({ ...item }));
    }
    cart = [buildCartItem(product, qty)];
    saveCart();
    renderCart();
    proceedToCheckout();
}

function removeFromCart(id) {
    const removed = cart.find(item => item.id === id);
    cart = cart.filter(item => item.id !== id);
    saveCart();
    renderCart();
    if (removed && typeof window.trackAdsEvent === 'function') {
        window.trackAdsEvent('remove_from_cart', {
            item_id: String(removed.id),
            item_name: removed.title || removed.name_ar || '',
            price: Number(removed.price || 0),
            quantity: Number(removed.quantity || 1),
        });
    }
}

function updateQuantity(id, change) {
    const item = cart.find(i => i.id === id);
    if (item) {
        item.quantity += change;
        if (item.quantity <= 0) removeFromCart(id);
        else {
            saveCart();
            renderCart();
        }
    }
}

function clearCart() {
    cart = [];
    saveCart();
    renderCart();
    showToast('تم إلغاء السلة');
}

function ensureCartDock() {
    let dock = document.getElementById('cart-dock');
    if (!dock) {
        dock = document.createElement('div');
        dock.id = 'cart-dock';
        dock.className = 'cart-dock';
        dock.hidden = true;
        document.body.appendChild(dock);
    }

    if (!dock.dataset.ready) {
        dock.innerHTML = `
            <button type="button" class="cart-dock-main" id="cart-dock-open" aria-label="فتح السلة">
                <span class="cart-dock-icon" aria-hidden="true">${uiIcon('bag')}</span>
                <span class="cart-dock-badge" id="cart-dock-badge">0</span>
                <span class="cart-dock-copy">
                    <strong id="cart-dock-count">0 قطع</strong>
                    <small id="cart-dock-total">0.00 ر.س</small>
                </span>
            </button>
            <button type="button" class="btn btn-primary cart-dock-checkout" id="cart-dock-checkout">عرض السلة</button>
            <button type="button" class="cart-dock-cancel" id="cart-dock-cancel" aria-label="إلغاء السلة" title="إلغاء">
                <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                <span>إلغاء</span>
            </button>
        `;
        dock.dataset.ready = '1';

        dock.querySelector('#cart-dock-open')?.addEventListener('click', (e) => {
            e.preventDefault();
            openCartDrawer();
        });
        dock.querySelector('#cart-dock-checkout')?.addEventListener('click', (e) => {
            e.preventDefault();
            openCartDrawer();
        });
        dock.querySelector('#cart-dock-cancel')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            clearCart();
        });
    }
    return dock;
}

function updateCartDock(count, total) {
    const dock = ensureCartDock();
    const hasItems = count > 0;
    dock.hidden = !hasItems;
    dock.classList.toggle('show', hasItems);
    document.body.classList.toggle('has-cart-dock', hasItems);

    const badge = document.getElementById('cart-dock-badge');
    const countEl = document.getElementById('cart-dock-count');
    const totalEl = document.getElementById('cart-dock-total');
    if (badge) badge.textContent = String(count);
    if (countEl) countEl.textContent = count === 1 ? 'منتج واحد' : `${count} منتجات`;
    if (totalEl) totalEl.textContent = `${Number(total || 0).toFixed(2)} ر.س`;
}

function renderCart() {
    const container = document.getElementById('cart-items-container');
    const totalEl = document.getElementById('cart-total-price');
    const badges = document.querySelectorAll('.cart-badge');
    
    let total = 0;
    let count = 0;
    cart.forEach(item => {
        total += (item.price || 0) * item.quantity;
        count += item.quantity;
    });

    badges.forEach(badge => {
        badge.innerText = count;
        badge.style.display = count > 0 ? 'block' : 'none';
    });
    updateCartDock(count, total);

    if (!container) return;
    
    container.innerHTML = '';
    
    if (cart.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding: 2rem; color: var(--color-text-muted);">السلة فارغة حالياً</div>';
    } else {
        cart.forEach(item => {
            container.innerHTML += `
                <div class="cart-item">
                    <div class="cart-item-img">
                        <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.title)}" loading="lazy">
                    </div>
                    <div class="cart-item-info">
                        <div class="cart-item-title">${escapeHtml(item.title)}</div>
                        <div class="cart-item-price">${((item.price || 0) * item.quantity).toFixed(2)} ر.س</div>
                        <div class="cart-qty-ctrl">
                            <button class="cart-qty-btn" type="button" onclick="updateQuantity(${item.id}, -1)">-</button>
                            <span>${item.quantity}</span>
                            <button class="cart-qty-btn" type="button" onclick="updateQuantity(${item.id}, 1)">+</button>
                            <button class="cart-remove" type="button" onclick="removeFromCart(${item.id})" style="margin-right:auto; margin-left:5px;"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>
                </div>
            `;
        });
    }

    if (totalEl) totalEl.innerText = `${total.toFixed(2)} ر.س`;

    const hint = document.getElementById('cart-hint');
    const checkoutBtn = document.querySelector('.btn-checkout');
    if (hint) {
        hint.textContent = getTranslation('cart_hint_wa')
            || 'يمكنك إرفاق رقم الهيكل أو صورة الاستمارة اختيارياً لمساعدتنا في مراجعة الطلب.';
    }
    if (checkoutBtn && !checkoutBtn.dataset.originalText) {
        checkoutBtn.dataset.originalText = checkoutBtn.innerHTML;
    }
    if (checkoutBtn) {
        const onlineReady = isZidReadyForCart() || isSallaReadyForCart();
        const sallaReady = isSallaReadyForCart();
        checkoutBtn.innerHTML = onlineReady
            ? (sallaReady
                ? `<i class="fa-solid fa-credit-card"></i> ${getTranslation('checkout_proceed') || 'إتمام الطلب عبر سلة'}`
                : `<i class="fa-solid fa-camera"></i> ${getTranslation('checkout_btn_photo') || 'إتمام الطلب'}`)
            : `<i class="fa-solid fa-clipboard-check"></i> ${
                currentLang === 'ar' ? 'إرسال طلب التحقق' : 'Send verification request'
            }`;
    }
}

// --- Drawers (Mobile Menu & Cart) ---
function initDrawers() {
    const cartOverlay = document.getElementById('drawer-overlay');
    const cartDrawer = document.getElementById('cart-drawer');
    
    document.querySelectorAll('.cart-trigger').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            openCartDrawer();
        });
    });
    
    document.querySelectorAll('.close-drawer').forEach(btn => {
        btn.addEventListener('click', closeDrawers);
    });
    
    if (cartOverlay) {
        cartOverlay.addEventListener('click', closeDrawers);
    }

    // Mobile Menu Toggling
    document.querySelectorAll('.mobile-menu-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const navLinks = document.querySelector('.nav-links');
            if (navLinks) {
                navLinks.classList.toggle('active');
            }
        });
    });

    // Brands dropdown: open only on click (not hover)
    document.querySelectorAll('.dropdown').forEach(dropdown => {
        const trigger = dropdown.querySelector(':scope > .nav-link, :scope > a.nav-link, :scope > button');
        if (!trigger) return;

        trigger.setAttribute('aria-expanded', 'false');
        trigger.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const willOpen = !dropdown.classList.contains('is-open');
            document.querySelectorAll('.dropdown.is-open').forEach(openDropdown => {
                if (openDropdown !== dropdown) {
                    openDropdown.classList.remove('is-open');
                    openDropdown.querySelector(':scope > .nav-link, :scope > a.nav-link, :scope > button')
                        ?.setAttribute('aria-expanded', 'false');
                }
            });
            dropdown.classList.toggle('is-open', willOpen);
            trigger.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        });
    });

    document.addEventListener('click', (e) => {
        if (e.target.closest('.dropdown')) return;
        document.querySelectorAll('.dropdown.is-open').forEach(dropdown => {
            dropdown.classList.remove('is-open');
            dropdown.querySelector(':scope > .nav-link, :scope > a.nav-link, :scope > button')
                ?.setAttribute('aria-expanded', 'false');
        });
    });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        document.querySelectorAll('.dropdown.is-open').forEach(dropdown => {
            dropdown.classList.remove('is-open');
            dropdown.querySelector(':scope > .nav-link, :scope > a.nav-link, :scope > button')
                ?.setAttribute('aria-expanded', 'false');
        });
    });
}

function openCartDrawer() {
    closeUtilityPanels(false);
    document.getElementById('cart-drawer')?.classList.add('open');
    document.getElementById('drawer-overlay')?.classList.add('active');
    document.body.classList.add('drawer-open');
}

function closeUtilityPanels(closeOverlay = true) {
    document.getElementById('cart-drawer')?.classList.remove('open');
    document.getElementById('favorites-drawer')?.classList.remove('open');
    document.getElementById('compare-panel')?.classList.remove('open');
    if (closeOverlay) {
        document.getElementById('drawer-overlay')?.classList.remove('active');
        document.body.classList.remove('drawer-open');
    }
}

function closeDrawers() {
    closeUtilityPanels(true);
    closeLightbox();
}

function openFavoritesDrawer({ immediate = false } = {}) {
    closeUtilityPanels(false);
    const drawer = document.getElementById('favorites-drawer');
    document.getElementById('drawer-overlay')?.classList.add('active');
    document.body.classList.add('drawer-open');
    drawer?.classList.add('open');
    if (immediate) {
        renderFavoritesDrawer();
    } else {
        requestAnimationFrame(() => renderFavoritesDrawer());
    }
}

function openComparePanel({ immediate = false } = {}) {
    closeUtilityPanels(false);
    const panel = document.getElementById('compare-panel');
    const dock = document.getElementById('compare-dock');
    if (dock) dock.classList.remove('show');
    document.getElementById('drawer-overlay')?.classList.add('active');
    document.body.classList.add('drawer-open');
    panel?.classList.add('open');
    if (immediate) {
        renderComparePanel();
    } else {
        requestAnimationFrame(() => renderComparePanel());
    }
    if (panel && !panel.dataset.bound) {
        panel.dataset.bound = '1';
        panel.addEventListener('click', (e) => {
            if (e.target === panel) closeDrawers();
        });
    }
}

function syncInteractionAliases() {
    favorites = favoriteItems.map(item => Number(item.id));
    comparisons = comparisonItems.map(item => Number(item.id));
}

function updateInteractionBadges() {
    const favBadge = document.querySelector('.fav-badge');
    const cmpBadge = document.querySelector('.cmp-badge');
    if (favBadge) {
        favBadge.textContent = String(favoriteItems.length);
        favBadge.style.display = favoriteItems.length ? 'flex' : 'none';
    }
    if (cmpBadge) {
        cmpBadge.textContent = String(comparisonItems.length);
        cmpBadge.style.display = comparisonItems.length ? 'flex' : 'none';
    }
    updateCompareDock();
}

function updateCompareDock() {
    let dock = document.getElementById('compare-dock');
    if (!dock) {
        dock = document.createElement('div');
        dock.id = 'compare-dock';
        dock.className = 'compare-dock';
        dock.innerHTML = `
            <span class="compare-dock-text"></span>
            <button type="button" class="btn btn-primary btn-sm compare-dock-open">عرض المقارنة</button>
            <button type="button" class="compare-dock-close" aria-label="إخفاء" title="إخفاء">&times;</button>
        `;
        document.body.appendChild(dock);
        dock.querySelector('.compare-dock-open').addEventListener('click', () => openComparePanel({ immediate: true }));
        dock.querySelector('.compare-dock-close').addEventListener('click', () => {
            dock.classList.remove('show');
            dock.dataset.dismissed = '1';
        });
    }

    const count = comparisonItems.length;
    const text = dock.querySelector('.compare-dock-text');
    if (text) text.textContent = count ? `${count} قطع في المقارنة` : '';

    if (count > 0 && dock.dataset.dismissed !== '1') {
        dock.classList.add('show');
    } else if (count === 0) {
        dock.classList.remove('show');
        delete dock.dataset.dismissed;
    }
}

function formatInteractionPrice(item) {
    if (item.price_label) return item.price_label;
    if (item.price || item.price_amount) {
        return `${parseFloat(item.price || item.price_amount).toFixed(2)} ${getTranslation('currency_sar')}`;
    }
    return getTranslation('price_on_request');
}

function rewritePublicAssetUrl(url) {
    if (!url) return '';
    const raw = String(url);
    try {
        const parsed = new URL(raw, typeof location !== 'undefined' ? location.origin : 'https://chinapartsksa.com');
        if (parsed.hostname.endsWith('.up.railway.app')) {
            const origin = typeof location !== 'undefined' && location.origin
                ? location.origin
                : 'https://chinapartsksa.com';
            return `${origin}${parsed.pathname}${parsed.search}`;
        }
        return raw;
    } catch (_err) {
        return raw;
    }
}

function resolveProductImage(item) {
    if (!item) return '';
    if (item.image_url) return rewritePublicAssetUrl(item.image_url);
    if (item.image) return rewritePublicAssetUrl(item.image);
    if (Array.isArray(item.images) && item.images.length) {
        const first = item.images[0];
        return rewritePublicAssetUrl(first?.url || first || '');
    }
    return '';
}

function renderFavoritesDrawer() {
    const body = document.getElementById('favorites-items');
    if (!body) return;

    if (!favoriteItems.length) {
        body.innerHTML = `
            <div class="utility-empty">
                <i class="fa-regular fa-heart"></i>
                <h4>المفضلة فارغة</h4>
                <p>أضف القطع التي تهمك لتجدها بسرعة لاحقاً.</p>
                <a class="btn btn-outline" href="collection.html">تصفح القطع</a>
            </div>`;
        return;
    }

    body.innerHTML = favoriteItems.map(item => {
        const title = escapeHtml(getLocalizedName(item, 'name') || item.name_ar || '');
        const brand = item.brand ? escapeHtml(getLocalizedName(item.brand, 'name')) : '';
        const img = escapeHtml(resolveProductImage(item));
        return `
            <article class="utility-item">
                <a class="utility-item-media" href="product.html?id=${item.id}">
                    ${img
                        ? `<img src="${img}" alt="${title}" loading="eager" decoding="async" referrerpolicy="no-referrer" onerror="this.onerror=null;const fb=this.nextElementSibling;this.remove();if(fb){fb.hidden=false;}">
                           <span class="utility-img-fallback" hidden><i class="fa-solid fa-image"></i></span>`
                        : `<span class="utility-img-fallback"><i class="fa-solid fa-image"></i></span>`}
                </a>
                <div class="utility-item-body">
                    <a href="product.html?id=${item.id}" class="utility-item-title">${title}</a>
                    <div class="utility-item-meta">${brand}${item.oem_number ? ` · ${escapeHtml(item.oem_number)}` : ''}</div>
                    <div class="utility-item-price">${escapeHtml(formatInteractionPrice(item))}</div>
                    <div class="utility-item-actions">
                        <button type="button" class="btn btn-outline btn-sm" onclick="addFavoriteToCart(${item.id})">أضف للطلب</button>
                        <button type="button" class="btn-icon-danger" onclick="toggleFavorite(${item.id})" title="حذف"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </article>`;
    }).join('');

    // Force paint for images that were previously off-screen
    body.querySelectorAll('img').forEach(img => {
        if (!img.complete) img.loading = 'eager';
    });
}

function renderComparePanel() {
    const body = document.getElementById('compare-items');
    if (!body) return;

    if (!comparisonItems.length) {
        body.innerHTML = `
            <div class="utility-empty">
                <i class="fa-solid fa-code-compare"></i>
                <h4>لا توجد قطع للمقارنة</h4>
                <p>أضف حتى 4 قطع لمقارنة السعر ورقم OEM والماركة جنباً إلى جنب.</p>
                <a class="btn btn-outline" href="collection.html">تصفح القطع</a>
            </div>`;
        return;
    }

    const rows = [
        { key: 'image', label: 'الصورة' },
        { key: 'name', label: 'الاسم' },
        { key: 'brand', label: 'الماركة' },
        { key: 'oem', label: 'رقم OEM' },
        { key: 'category', label: 'القسم' },
        { key: 'price', label: 'السعر' },
        { key: 'actions', label: 'إجراء' },
    ];

    body.innerHTML = `
        <div class="compare-table-wrap">
            <table class="compare-table">
                <tbody>
                    ${rows.map(row => `
                        <tr>
                            <th>${row.label}</th>
                            ${comparisonItems.map(item => {
                                const title = escapeHtml(getLocalizedName(item, 'name') || item.name_ar || '');
                                if (row.key === 'image') {
                                    const img = escapeHtml(resolveProductImage(item));
                                    return `<td><a href="product.html?id=${item.id}" class="compare-thumb">${img ? `<img src="${img}" alt="${title}" loading="eager" decoding="async" referrerpolicy="no-referrer">` : '<span class="utility-img-fallback"><i class="fa-solid fa-image"></i></span>'}</a></td>`;
                                }
                                if (row.key === 'name') return `<td><a href="product.html?id=${item.id}">${title}</a></td>`;
                                if (row.key === 'brand') return `<td>${item.brand ? escapeHtml(getLocalizedName(item.brand, 'name')) : '-'}</td>`;
                                if (row.key === 'oem') return `<td class="mono">${escapeHtml(item.oem_number || '-')}</td>`;
                                if (row.key === 'category') return `<td>${item.category ? escapeHtml(getLocalizedName(item.category, 'name')) : '-'}</td>`;
                                if (row.key === 'price') return `<td class="price">${escapeHtml(formatInteractionPrice(item))}</td>`;
                                return `<td>
                                    <div class="compare-actions">
                                        <button type="button" class="btn btn-primary btn-sm" data-compare-add="${item.id}">أضف</button>
                                        <button type="button" class="btn btn-outline btn-sm" data-compare-remove="${item.id}">إزالة</button>
                                    </div>
                                </td>`;
                            }).join('')}
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>`;

    body.querySelectorAll('[data-compare-add]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            addCompareItemToCart(btn.getAttribute('data-compare-add'));
        });
    });
    body.querySelectorAll('[data-compare-remove]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleComparison(btn.getAttribute('data-compare-remove'));
        });
    });
}

function injectInteractionUI() {
    const actions = document.querySelector('.header-actions');
    if (actions && !document.querySelector('.favorites-trigger')) {
        const wrap = document.createElement('div');
        wrap.className = 'header-utility-btns';
        wrap.innerHTML = `
            <button class="btn-icon favorites-trigger" type="button" title="المفضلة" aria-label="المفضلة">
                ${uiIcon('heartOutline')}
                <span class="badge fav-badge" style="display:none">0</span>
            </button>
            <button class="btn-icon compare-trigger" type="button" title="المقارنة" aria-label="المقارنة">
                ${uiIcon('compare')}
                <span class="badge cmp-badge" style="display:none">0</span>
            </button>`;
        const cartBtn = actions.querySelector('.cart-trigger');
        if (cartBtn) actions.insertBefore(wrap, cartBtn);
        else actions.appendChild(wrap);
    } else if (actions) {
        document.querySelectorAll('.header-wa-trigger').forEach((el) => el.remove());
    }

    if (!document.getElementById('favorites-drawer')) {
        const fav = document.createElement('div');
        fav.id = 'favorites-drawer';
        fav.className = 'cart-drawer utility-drawer';
        fav.innerHTML = `
            <div class="cart-header">
                <h3><i class="fa-regular fa-heart"></i> المفضلة</h3>
                <button class="close-drawer" type="button" aria-label="إغلاق"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="cart-body" id="favorites-items"></div>
            <div class="cart-footer">
                <button class="btn btn-outline" type="button" style="width:100%" onclick="closeDrawers()">متابعة التصفح</button>
            </div>`;
        document.body.appendChild(fav);
    }

    if (!document.getElementById('compare-panel')) {
        const cmp = document.createElement('div');
        cmp.id = 'compare-panel';
        cmp.className = 'compare-panel';
        cmp.innerHTML = `
            <div class="compare-panel-inner">
                <div class="cart-header">
                    <h3><i class="fa-solid fa-code-compare"></i> مقارنة القطع</h3>
                    <button class="close-drawer" type="button" aria-label="إغلاق"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="compare-body" id="compare-items"></div>
            </div>`;
        document.body.appendChild(cmp);
    }

    if (!document.getElementById('image-lightbox')) {
        const lb = document.createElement('div');
        lb.id = 'image-lightbox';
        lb.className = 'image-lightbox';
        lb.innerHTML = `
            <button type="button" class="lightbox-close" aria-label="إغلاق"><i class="fa-solid fa-xmark"></i></button>
            <button type="button" class="lightbox-nav prev" aria-label="السابق"><i class="fa-solid fa-chevron-right"></i></button>
            <img src="" alt="">
            <button type="button" class="lightbox-nav next" aria-label="التالي"><i class="fa-solid fa-chevron-left"></i></button>
            <div class="lightbox-counter"></div>`;
        document.body.appendChild(lb);
        lb.querySelector('.lightbox-close').addEventListener('click', closeLightbox);
        lb.addEventListener('click', (e) => { if (e.target === lb) closeLightbox(); });
        lb.querySelector('.lightbox-nav.prev').addEventListener('click', () => stepLightbox(-1));
        lb.querySelector('.lightbox-nav.next').addEventListener('click', () => stepLightbox(1));
    }

    document.querySelectorAll('.favorites-trigger').forEach(btn => {
        btn.onclick = (e) => { e.preventDefault(); openFavoritesDrawer(); };
    });
    document.querySelectorAll('.compare-trigger').forEach(btn => {
        btn.onclick = (e) => { e.preventDefault(); openComparePanel(); };
    });
    document.querySelectorAll('#favorites-drawer .close-drawer, #compare-panel .close-drawer').forEach(btn => {
        btn.onclick = closeDrawers;
    });

    // Pre-fill panels from cache so opening feels instant
    renderFavoritesDrawer();
    renderComparePanel();
    updateInteractionBadges();
}

let lightboxImages = [];
let lightboxIndex = 0;

function openLightbox(images, index = 0) {
    lightboxImages = images || [];
    lightboxIndex = index;
    const lb = document.getElementById('image-lightbox');
    if (!lb || !lightboxImages.length) return;
    renderLightbox();
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
}

function renderLightbox() {
    const lb = document.getElementById('image-lightbox');
    if (!lb) return;
    const item = lightboxImages[lightboxIndex];
    const img = lb.querySelector('img');
    img.src = item.url || item;
    img.alt = item.alt || 'صورة القطعة';
    lb.querySelector('.lightbox-counter').textContent = `${lightboxIndex + 1} / ${lightboxImages.length}`;
    lb.querySelector('.lightbox-nav.prev').style.display = lightboxImages.length > 1 ? 'grid' : 'none';
    lb.querySelector('.lightbox-nav.next').style.display = lightboxImages.length > 1 ? 'grid' : 'none';
}

function stepLightbox(delta) {
    if (!lightboxImages.length) return;
    lightboxIndex = (lightboxIndex + delta + lightboxImages.length) % lightboxImages.length;
    renderLightbox();
}

function closeLightbox() {
    document.getElementById('image-lightbox')?.classList.remove('open');
    document.body.style.overflow = '';
}

document.addEventListener('keydown', (e) => {
    const lb = document.getElementById('image-lightbox');
    if (!lb?.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') stepLightbox(1);
    if (e.key === 'ArrowRight') stepLightbox(-1);
});

async function loadInteractions() {
    const sessionId = getStorefrontSessionId();
    const seq = ++interactionsSeq;
    try {
        const [fav, cmp] = await Promise.all([
            apiJson(`/storefront/favorites?session_id=${encodeURIComponent(sessionId)}`),
            apiJson(`/storefront/comparisons?session_id=${encodeURIComponent(sessionId)}`),
        ]);
        if (seq !== interactionsSeq) return; // newer local update won
        favoriteItems = (fav.data || []).map(normalizeInteractionItem);
        comparisonItems = (cmp.data || []).map(normalizeInteractionItem);
        syncInteractionAliases();
        refreshInteractionButtons();
        updateInteractionBadges();
        persistInteractionsCache();
        renderFavoritesDrawer();
        renderComparePanel();
    } catch (error) {
        // Optional storefront state; shopping remains usable if this fails.
    } finally {
        if (seq === interactionsSeq) interactionsReady = true;
    }
}

function addFavoriteToCart(productId) {
    const item = favoriteItems.find(i => Number(i.id) === Number(productId));
    if (item) addToCart(item);
}

function addCompareItemToCart(productId) {
    const id = Number(productId);
    const item = comparisonItems.find(i => Number(i.id) === id)
        || productSnapshotCache.get(id)
        || null;
    if (!item) {
        showToast('تعذر العثور على المنتج', 'error');
        return;
    }
    addToCart(item);
}

function toggleFavorite(productId, productHint = null) {
    const id = Number(productId);
    const key = `fav:${id}`;
    const exists = favoriteItems.some(item => Number(item.id) === id);
    const previous = favoriteItems.slice();
    interactionsSeq += 1;
    interactionsReady = true;

    if (exists) {
        favoriteItems = favoriteItems.filter(item => Number(item.id) !== id);
        interactionIntent.set(key, 'off');
        paintInteractionChrome();
        if (document.getElementById('favorites-drawer')?.classList.contains('open')) {
            renderFavoritesDrawer();
        }
        showToast('تم الحذف من المفضلة');
        queueInteractionSync(async () => {
            try {
                await apiJson(`/storefront/favorites/${id}?session_id=${encodeURIComponent(getStorefrontSessionId())}`, { method: 'DELETE' });
            } catch (error) {
                // Local-first: keep the removal even if the API is offline.
                console.warn('favorites delete sync failed', error);
            }
        });
        return;
    }

    const hint = resolveInteractionHint(id, productHint);
    favoriteItems = [hint, ...favoriteItems.filter(item => Number(item.id) !== id)];
    interactionIntent.set(key, 'on');
    paintInteractionChrome();
    // لا نفتح الدرج تلقائياً حتى تظل النقرات على المنتجات شغالة
    showToast('تمت الإضافة إلى المفضلة');

    queueInteractionSync(async () => {
        try {
            const res = await apiJson('/storefront/favorites', {
                method: 'POST',
                body: JSON.stringify({ product_id: id, session_id: getStorefrontSessionId() }),
            });
            if (interactionIntent.get(key) !== 'on') return;
            if (res?.data) {
                cacheProductSnapshot(res.data);
                favoriteItems = [normalizeInteractionItem(res.data), ...favoriteItems.filter(item => Number(item.id) !== id)];
                paintInteractionChrome();
                if (document.getElementById('favorites-drawer')?.classList.contains('open')) {
                    renderFavoritesDrawer();
                }
            }
        } catch (error) {
            // Local-first: keep the optimistic add if the API endpoint is unavailable.
            console.warn('favorites add sync failed', error);
        }
    });
}

function toggleComparison(productId, productHint = null) {
    const id = Number(productId);
    const key = `cmp:${id}`;
    const exists = comparisonItems.some(item => Number(item.id) === id);
    const previous = comparisonItems.slice();
    interactionsSeq += 1;
    interactionsReady = true;

    if (exists) {
        comparisonItems = comparisonItems.filter(item => Number(item.id) !== id);
        interactionIntent.set(key, 'off');
        paintInteractionChrome();
        if (document.getElementById('compare-panel')?.classList.contains('open')) {
            renderComparePanel();
        }
        showToast('تم الحذف من المقارنة');
        queueInteractionSync(async () => {
            try {
                await apiJson(`/storefront/comparisons/${id}?session_id=${encodeURIComponent(getStorefrontSessionId())}`, { method: 'DELETE' });
            } catch (error) {
                console.warn('comparisons delete sync failed', error);
            }
        });
        return;
    }

    if (comparisonItems.length >= 4) {
        showToast('يمكنك مقارنة 4 قطع كحد أقصى', 'error');
        openComparePanel({ immediate: true });
        return;
    }

    const hint = resolveInteractionHint(id, productHint);
    comparisonItems = [hint, ...comparisonItems.filter(item => Number(item.id) !== id)];
    interactionIntent.set(key, 'on');
    const dock = document.getElementById('compare-dock');
    if (dock) delete dock.dataset.dismissed;
    paintInteractionChrome();
    // مهم: لا نفتح لوحة المقارنة هنا — كانت تغطي الصفحة وتمنع النقرة التالية
    showToast(comparisonItems.length >= 2
        ? `تمت الإضافة (${comparisonItems.length}/4) — افتح المقارنة من الأسفل أو الأعلى`
        : 'تمت الإضافة إلى المقارنة');

    queueInteractionSync(async () => {
        try {
            const res = await apiJson('/storefront/comparisons', {
                method: 'POST',
                body: JSON.stringify({ product_id: id, session_id: getStorefrontSessionId() }),
            });
            if (interactionIntent.get(key) !== 'on') return;
            if (res?.data) {
                cacheProductSnapshot(res.data);
                comparisonItems = [normalizeInteractionItem(res.data), ...comparisonItems.filter(item => Number(item.id) !== id)];
                paintInteractionChrome();
                if (document.getElementById('compare-panel')?.classList.contains('open')) {
                    renderComparePanel();
                }
            }
        } catch (error) {
            console.warn('comparisons add sync failed', error);
        }
    });
}

function refreshInteractionButtons() {
    syncInteractionAliases();
    document.querySelectorAll('[data-favorite-product]').forEach((button) => {
        const id = Number(button.dataset.favoriteProduct);
        const active = favorites.includes(id);
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        const removeLabel = currentLang === 'ar' ? 'إزالة من المفضلة' : 'Remove from favorites';
        const addLabel = getTranslation('tooltip_wishlist') || getTranslation('wishlist_btn') || 'المفضلة';
        button.title = active ? removeLabel : addLabel;
        button.setAttribute('aria-label', active ? removeLabel : addLabel);
        const label = button.querySelector('.product-tool-label');
        if (label) label.textContent = active ? (currentLang === 'ar' ? 'مضافة' : 'Saved') : (getTranslation('wishlist_btn') || 'المفضلة');
        const icon = button.querySelector('i');
        if (icon && icon.classList.contains('fa-heart')) {
            icon.classList.toggle('fa-solid', active);
            icon.classList.toggle('fa-regular', !active);
        }
        const svg = button.querySelector('.ui-icon');
        if (svg) {
            const wrap = document.createElement('span');
            const onCard = button.classList.contains('product-tool-btn');
            wrap.innerHTML = active
                ? uiIcon('heart')
                : uiIcon(onCard ? 'heartCard' : 'heartOutline');
            svg.replaceWith(wrap.firstElementChild);
        }
    });
    document.querySelectorAll('[data-compare-product]').forEach((button) => {
        const id = Number(button.dataset.compareProduct);
        const active = comparisons.includes(id);
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
        const removeLabel = currentLang === 'ar' ? 'إزالة من المقارنة' : 'Remove from compare';
        const addLabel = getTranslation('tooltip_compare') || getTranslation('compare_btn') || 'المقارنة';
        button.title = active ? removeLabel : addLabel;
        button.setAttribute('aria-label', active ? removeLabel : addLabel);
        const label = button.querySelector('.product-tool-label');
        if (label) label.textContent = active ? (currentLang === 'ar' ? 'بالمقارنة' : 'In compare') : (getTranslation('compare_btn') || 'المقارنة');
    });
}

// --- Checkout (photo verification first, then WhatsApp / Salla / Zid) ---
async function proceedToCheckout() {
    if (cart.length === 0) {
        showToast(currentLang === 'ar' ? 'السلة فارغة!' : 'Your cart is empty!', 'error');
        return;
    }
    if (isOnlineCheckoutReadyForCart()) {
        await startOnlineCheckout();
        return;
    }
    openCheckoutVerificationModal();
}

async function startOnlineCheckout() {
    const checkoutBtn = document.querySelector('.btn-checkout');
    const useZid = isZidReadyForCart();
    const useSalla = !useZid && isSallaReadyForCart();
    if (!useZid && !useSalla) {
        releaseBuyNowCart();
        return false;
    }

    if (checkoutBtn) {
        checkoutBtn.disabled = true;
        checkoutBtn.dataset.originalText = checkoutBtn.innerHTML;
        checkoutBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> جاري التحويل للدفع...`;
    }

    try {
        const endpoint = useZid ? '/zid/checkout' : '/salla/checkout';
        const items = useZid
            ? cart.map(item => ({
                zid_product_id: item.zid_product_id,
                zid_sku: item.zid_sku,
                sku: item.zid_sku,
                quantity: item.quantity,
            }))
            : cart.map(item => ({
                id: item.id,
                product_id: item.id,
                salla_product_id: item.salla_product_id,
                quantity: item.quantity,
            }));
        const payload = await apiJson(endpoint, {
            method: 'POST',
            body: JSON.stringify({ items }),
        });

        if (!payload.checkout_url) {
            throw new Error(payload.message || 'تعذر الحصول على رابط الدفع.');
        }

        if (typeof window.trackAdsEvent === 'function') {
            const value = cart.reduce((sum, item) => sum + (Number(item.price) || 0) * (item.quantity || 1), 0);
            const commerce = {
                content_ids: cart.map((item) => String(item.id)),
                content_type: 'product',
                num_items: cart.reduce((sum, item) => sum + (item.quantity || 1), 0),
                value,
                currency: 'SAR',
                items: cart,
            };
            window.trackAdsEvent('begin_checkout', commerce);
            window.trackAdsEvent('add_payment_info', Object.assign({ payment_type: useZid ? 'zid' : 'salla' }, commerce));
        }

        preserveCartForExternalCheckout();
        closeDrawers();
        window.location.href = payload.checkout_url;
        return true;
    } catch (err) {
        preserveCartForExternalCheckout();
        showToast(err.message || (useZid ? 'تعذر بدء الدفع عبر زد.' : 'تعذر بدء الدفع عبر سلة.'), 'error');
        if (checkoutBtn) {
            checkoutBtn.disabled = false;
            checkoutBtn.innerHTML = checkoutBtn.dataset.originalText || getTranslation('checkout_btn');
        }
        return false;
    }
}

function ensureCheckoutVerificationModal() {
    let modal = document.getElementById('checkout-verification-modal');
    if (modal) {
        // Rebuild broken/old modals (especially ones created before close handlers existed)
        if (
            !modal.querySelector('#checkout-use-location')
            || !modal.querySelector('#checkout-vin-close')
            || !modal.querySelector('#checkout-car-photo')
            || !modal.querySelector('#checkout-istimara-photo')
            || modal.dataset.eventsBound !== '1'
        ) {
            modal.remove();
            modal = null;
        } else {
            return modal;
        }
    }

    modal = document.createElement('div');
    modal.id = 'checkout-verification-modal';
    modal.className = 'checkout-modal-overlay';
    modal.innerHTML = `
        <div class="checkout-modal-card vin-checkout-card checkout-steps-card" role="dialog" aria-modal="true" aria-labelledby="vin-checkout-title">
            <button type="button" class="checkout-modal-close" id="checkout-vin-close" aria-label="إغلاق">
                <i class="fa-solid fa-xmark"></i>
            </button>
            <h3 class="checkout-modal-title" id="vin-checkout-title">إتمام الطلب</h3>
            <p class="checkout-modal-desc" id="vin-checkout-desc">أدخل بيانات التواصل والعنوان. صور المركبة اختيارية.</p>

            <ol class="checkout-steps" id="checkout-steps" aria-label="خطوات إتمام الطلب">
                <li class="checkout-step is-active" data-step="1"><span>1</span><em>الشحن</em></li>
                <li class="checkout-step" data-step="2"><span>2</span><em>المركبة</em></li>
                <li class="checkout-step" data-step="3"><span>3</span><em>المراجعة</em></li>
            </ol>

            <div class="checkout-step-panel is-active" data-step-panel="1">
                <label class="vin-checkout-label" for="checkout-customer-name" id="checkout-name-label">الاسم <span class="req-star" aria-hidden="true">*</span></label>
                <input type="text" id="checkout-customer-name" class="vin-checkout-input" autocomplete="name" placeholder="اسمك الكامل" required>

                <label class="vin-checkout-label" for="checkout-customer-phone" id="checkout-phone-label">رقم الجوال <span class="req-star" aria-hidden="true">*</span></label>
                <input type="tel" id="checkout-customer-phone" class="vin-checkout-input" autocomplete="tel" inputmode="tel" placeholder="05xxxxxxxx" required>

                <label class="vin-checkout-label" for="checkout-customer-city" id="checkout-city-label">المدينة <span class="req-star" aria-hidden="true">*</span></label>
                <select id="checkout-customer-city" class="vin-checkout-input" autocomplete="address-level2" required>
                    <option value="">اختر المدينة</option>
                    <option>الرياض</option>
                    <option>جدة</option>
                    <option>مكة المكرمة</option>
                    <option>المدينة المنورة</option>
                    <option>الدمام</option>
                    <option>الخبر</option>
                    <option>الظهران</option>
                    <option>الأحساء</option>
                    <option>الطائف</option>
                    <option>تبوك</option>
                    <option>أبها</option>
                    <option>خميس مشيط</option>
                    <option>جازان</option>
                    <option>نجران</option>
                    <option>حائل</option>
                    <option>بريدة</option>
                    <option>عنيزة</option>
                    <option>ينبع</option>
                    <option>الجبيل</option>
                    <option>القطيف</option>
                    <option>سكاكا</option>
                    <option>عرعر</option>
                    <option>الباحة</option>
                    <option value="__other__">مدينة أخرى...</option>
                </select>
                <input type="text" id="checkout-customer-city-other" class="vin-checkout-input" placeholder="اكتب اسم المدينة" hidden>

                <button type="button" class="checkout-location-btn" id="checkout-use-location">
                    <i class="fa-solid fa-location-crosshairs"></i>
                    <span id="checkout-location-btn-text">استخدم موقعي الحالي</span>
                </button>
                <small class="checkout-location-hint" id="checkout-location-hint">أسهل طريقة: اضغط الزر ويحدد المدينة والعنوان تلقائيًا</small>

                <label class="vin-checkout-label" for="checkout-customer-address" id="checkout-address-label">تفاصيل العنوان <span class="req-star" aria-hidden="true">*</span></label>
                <input type="text" id="checkout-customer-address" class="vin-checkout-input" autocomplete="street-address" placeholder="الحي أو الشارع (أو استخدم موقعك)">
                <input type="hidden" id="checkout-customer-lat" value="">
                <input type="hidden" id="checkout-customer-lng" value="">
                <p class="checkout-field-hint">الحقول بعلامة <span class="req-star">*</span> إلزامية. العنوان أو الموقع الجغرافي مطلوب.</p>
            </div>

            <div class="checkout-step-panel" data-step-panel="2" hidden>
                <p class="checkout-photo-benefit" id="checkout-photo-benefit">الصور اختيارية، وتساعد فريقنا في مراجعة بيانات المركبة.</p>

                <div class="checkout-photo-grid">
                    <div class="checkout-photo-slot" data-photo-slot="car">
                        <label class="vin-checkout-label" id="checkout-car-label">صورة السيارة (اختياري)</label>
                        <label class="vin-photo-drop" id="checkout-car-drop" for="checkout-car-photo">
                            <input type="file" id="checkout-car-photo" accept="image/*" capture="environment" hidden>
                            <div class="vin-photo-placeholder" id="checkout-car-placeholder">
                                <i class="fa-solid fa-car"></i>
                                <strong id="checkout-car-title">صورة السيارة (اختياري)</strong>
                                <small id="checkout-car-hint">صورة واضحة للسيارة من الخارج</small>
                            </div>
                            <img class="vin-photo-preview" id="checkout-car-preview" alt="" hidden>
                        </label>
                        <button type="button" class="vin-photo-remove" id="checkout-car-remove" hidden>إزالة الصورة</button>
                    </div>
                    <div class="checkout-photo-slot" data-photo-slot="istimara">
                        <label class="vin-checkout-label" id="checkout-istimara-label">صورة الاستمارة (اختياري)</label>
                        <label class="vin-photo-drop" id="checkout-istimara-drop" for="checkout-istimara-photo">
                            <input type="file" id="checkout-istimara-photo" accept="image/*" capture="environment" hidden>
                            <div class="vin-photo-placeholder" id="checkout-istimara-placeholder">
                                <i class="fa-solid fa-id-card"></i>
                                <strong id="checkout-istimara-title">صورة الاستمارة (اختياري)</strong>
                                <small id="checkout-istimara-hint">صورة واضحة لاستمارة المركبة</small>
                            </div>
                            <img class="vin-photo-preview" id="checkout-istimara-preview" alt="" hidden>
                        </label>
                        <button type="button" class="vin-photo-remove" id="checkout-istimara-remove" hidden>إزالة الصورة</button>
                    </div>
                </div>

                <label class="vin-checkout-label" for="checkout-vin-input" id="vin-input-label">رقم الهيكل (اختياري)</label>
                <input type="text" id="checkout-vin-input" class="vin-checkout-input" maxlength="17" autocomplete="off" spellcheck="false" placeholder="17 خانة إن كان متوفراً لديك">

                <label class="vin-checkout-ack" id="checkout-vin-ack-wrap" hidden>
                    <input type="checkbox" id="checkout-vin-ack">
                    <span id="vin-ack-text">أتعهد أن الصورتين واضحتان وتخصان نفس السيارة</span>
                </label>
            </div>

            <div class="checkout-step-panel" data-step-panel="3" hidden>
                <div class="checkout-review" id="checkout-review-box">
                    <p class="text-muted">جاري تجهيز الملخص...</p>
                </div>
            </div>

            <div class="checkout-modal-actions checkout-step-actions">
                <button type="button" class="checkout-modal-btn checkout-modal-btn-wa" id="checkout-vin-confirm">
                    <i class="fa-solid fa-arrow-left"></i>
                    التالي
                </button>
                <button type="button" class="checkout-modal-btn checkout-modal-btn-cancel" id="checkout-vin-cancel">رجوع</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal._checkoutStep = 1;
    bindCheckoutVerificationModalEvents(modal);
    return modal;
}

function clearCheckoutPhotoSlot(modal, slot) {
    const root = modal || document.getElementById('checkout-verification-modal');
    if (!root || !slot) return;
    const fileInput = root.querySelector(`#checkout-${slot}-photo`);
    const preview = root.querySelector(`#checkout-${slot}-preview`);
    const placeholder = root.querySelector(`#checkout-${slot}-placeholder`);
    const removeBtn = root.querySelector(`#checkout-${slot}-remove`);
    if (fileInput) fileInput.value = '';
    if (preview) {
        if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
        preview.removeAttribute('src');
        delete preview.dataset.objectUrl;
        preview.hidden = true;
    }
    if (placeholder) placeholder.hidden = false;
    if (removeBtn) removeBtn.hidden = true;
    if (slot === 'car') root._carPhotoFile = null;
    if (slot === 'istimara') root._istimaraPhotoFile = null;
}

function clearCheckoutVehiclePhoto(modal) {
    const root = modal || document.getElementById('checkout-verification-modal');
    if (!root) return;
    clearCheckoutPhotoSlot(root, 'car');
    clearCheckoutPhotoSlot(root, 'istimara');
    root._vehiclePhotoFile = null;
}

function setCheckoutPhotoFile(modal, slot, file) {
    const root = modal || document.getElementById('checkout-verification-modal');
    if (!root || !slot || !file) return;
    const preview = root.querySelector(`#checkout-${slot}-preview`);
    const placeholder = root.querySelector(`#checkout-${slot}-placeholder`);
    const removeBtn = root.querySelector(`#checkout-${slot}-remove`);
    if (preview?.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    const objectUrl = URL.createObjectURL(file);
    if (preview) {
        preview.src = objectUrl;
        preview.dataset.objectUrl = objectUrl;
        preview.hidden = false;
    }
    if (placeholder) placeholder.hidden = true;
    if (removeBtn) removeBtn.hidden = false;
    if (slot === 'car') root._carPhotoFile = file;
    if (slot === 'istimara') root._istimaraPhotoFile = file;
}

function closeCheckoutVerificationModal(options = {}) {
    const modal = document.getElementById('checkout-verification-modal');
    if (modal) {
        modal.classList.remove('open');
    }
    // Keep cart/utility drawers closed; only clear body lock if nothing else is open.
    const anyDrawerOpen = Boolean(
        document.getElementById('cart-drawer')?.classList.contains('open')
        || document.getElementById('favorites-drawer')?.classList.contains('open')
        || document.getElementById('compare-panel')?.classList.contains('open')
    );
    if (!anyDrawerOpen) {
        document.body.classList.remove('drawer-open');
        document.getElementById('drawer-overlay')?.classList.remove('active');
    }
    if (!options.keepIsolatedCart) releaseBuyNowCart();
}

function setCheckoutStep(modal, step) {
    if (!modal) return;
    const total = 3;
    const next = Math.max(1, Math.min(total, Number(step) || 1));
    modal._checkoutStep = next;

    modal.querySelectorAll('[data-step-panel]').forEach((panel) => {
        const isActive = Number(panel.getAttribute('data-step-panel')) === next;
        panel.hidden = !isActive;
        panel.classList.toggle('is-active', isActive);
    });
    modal.querySelectorAll('.checkout-step').forEach((el) => {
        const n = Number(el.getAttribute('data-step'));
        el.classList.toggle('is-active', n === next);
        el.classList.toggle('is-done', n < next);
    });

    const confirmBtn = modal.querySelector('#checkout-vin-confirm');
    const cancelBtn = modal.querySelector('#checkout-vin-cancel');
    if (cancelBtn) {
        cancelBtn.textContent = next === 1
            ? (getTranslation('vin_checkout_back') || 'رجوع')
            : (currentLang === 'ar' ? 'السابق' : 'Back');
    }
    if (confirmBtn) {
        confirmBtn.disabled = false;
        if (next < 3) {
            confirmBtn.innerHTML = `<i class="fa-solid fa-arrow-left"></i> ${currentLang === 'ar' ? 'التالي' : 'Next'}`;
        } else {
            const onlineReady = isZidReadyForCart() || isSallaReadyForCart();
            const label = onlineReady
                ? (getTranslation('vin_checkout_confirm_pay') || 'تأكيد الطلب والمتابعة للدفع')
                : (getTranslation('vin_checkout_confirm') || 'تأكيد الطلب');
            confirmBtn.innerHTML = `<i class="fa-solid fa-check"></i> ${label}`;
            renderCheckoutReview(modal);
        }
    }
}

function validateCheckoutStep(step) {
    if (step === 1) {
        const customerName = (document.getElementById('checkout-customer-name')?.value || '').trim();
        const customerPhone = (document.getElementById('checkout-customer-phone')?.value || '').trim();
        const customerCity = getCheckoutCityValue();
        const customerAddress = (document.getElementById('checkout-customer-address')?.value || '').trim();
        const customerLat = (document.getElementById('checkout-customer-lat')?.value || '').trim();
        const customerLng = (document.getElementById('checkout-customer-lng')?.value || '').trim();
        const hasGps = Boolean(customerLat && customerLng);

        if (!customerName || customerName.length < 2) {
            showToast(currentLang === 'ar' ? 'اكتب اسمك من فضلك' : 'Please enter your name', 'error');
            document.getElementById('checkout-customer-name')?.focus();
            return false;
        }
        const phoneDigits = customerPhone.replace(/\D/g, '');
        if (phoneDigits.length < 9) {
            showToast(currentLang === 'ar' ? 'اكتب رقم جوال صحيح' : 'Please enter a valid phone number', 'error');
            document.getElementById('checkout-customer-phone')?.focus();
            return false;
        }
        if (!customerCity || customerCity.length < 2) {
            showToast(currentLang === 'ar' ? 'اختر المدينة أو استخدم موقعك' : 'Choose a city or use your location', 'error');
            document.getElementById('checkout-customer-city')?.focus();
            return false;
        }
        if (!hasGps && (!customerAddress || customerAddress.length < 3)) {
            showToast(currentLang === 'ar' ? 'اكتب تفاصيل العنوان أو استخدم موقعك الحالي' : 'Enter address details or use your current location', 'error');
            document.getElementById('checkout-customer-address')?.focus();
            return false;
        }
        return true;
    }

    if (step === 2) {
        const vinRaw = (document.getElementById('checkout-vin-input')?.value || '').trim().toUpperCase();
        if (vinRaw && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vinRaw)) {
            showToast(currentLang === 'ar'
                ? 'رقم الهيكل غير صحيح — 17 خانة أو اتركه فارغاً'
                : 'Invalid VIN — 17 characters or leave empty', 'error');
            document.getElementById('checkout-vin-input')?.focus();
            return false;
        }
        return true;
    }
    return true;
}

function renderCheckoutReview(modal) {
    const box = modal?.querySelector('#checkout-review-box');
    if (!box) return;
    const name = (document.getElementById('checkout-customer-name')?.value || '').trim();
    const phone = (document.getElementById('checkout-customer-phone')?.value || '').trim();
    const city = getCheckoutCityValue();
    const address = (document.getElementById('checkout-customer-address')?.value || '').trim();
    const lat = (document.getElementById('checkout-customer-lat')?.value || '').trim();
    const lng = (document.getElementById('checkout-customer-lng')?.value || '').trim();
    const vin = (document.getElementById('checkout-vin-input')?.value || '').trim().toUpperCase();
    const carFile = modal?._carPhotoFile;
    const istimaraFile = modal?._istimaraPhotoFile;
    const total = cart.reduce((sum, item) => sum + (item.price || 0) * item.quantity, 0);
    const itemsHtml = cart.map((item) => `
        <li>
            <strong>${escapeHtml(item.title || '')}</strong>
            <span>× ${item.quantity} — ${Number(item.price || 0).toFixed(2)} ر.س</span>
        </li>
    `).join('');
    const payNote = (isZidReadyForCart() || isSallaReadyForCart())
        ? 'بعد التأكيد ستنتقل لبوابة الدفع الإلكتروني إن توفّرت.'
        : 'بعد التأكيد يُسجَّل طلبك ونتواصل معك لإتمام الدفع والتوصيل.';
    const photosLabel = [
        carFile ? (currentLang === 'ar' ? 'صورة السيارة' : 'Car photo') : null,
        istimaraFile ? (currentLang === 'ar' ? 'صورة الاستمارة' : 'Registration photo') : null,
    ].filter(Boolean).join(' + ');

    box.innerHTML = `
        <div class="checkout-review-block">
            <h4>بيانات الشحن</h4>
            <p>${escapeHtml(name)} · ${escapeHtml(phone)}</p>
            <p>${escapeHtml(city)}${address ? ' — ' + escapeHtml(address) : ''}${lat && lng ? ' · موقع GPS محفوظ' : ''}</p>
        </div>
        <div class="checkout-review-block">
            <h4>المركبة</h4>
            <p>${photosLabel ? `مرفقة: ${photosLabel}` : (currentLang === 'ar' ? 'لم تُرفق صور (اختياري)' : 'No photos attached (optional)')}${vin ? ` · VIN: ${escapeHtml(vin)}` : ''}</p>
        </div>
        <div class="checkout-review-block">
            <h4>ملخص الطلب (${cart.length})</h4>
            <ul class="checkout-review-items">${itemsHtml}</ul>
            <p class="checkout-review-total"><strong>الإجمالي التقريبي:</strong> ${total.toFixed(2)} ر.س</p>
            <p class="checkout-field-hint">${payNote}</p>
        </div>
    `;
}

function handleCheckoutStepAction(direction) {
    const modal = document.getElementById('checkout-verification-modal');
    if (!modal) return;
    const step = Number(modal._checkoutStep || 1);

    if (direction === 'back') {
        if (step <= 1) {
            closeCheckoutVerificationModal();
            return;
        }
        setCheckoutStep(modal, step - 1);
        return;
    }

    if (step < 3) {
        if (!validateCheckoutStep(step)) return;
        setCheckoutStep(modal, step + 1);
        return;
    }
    confirmCheckoutOrder();
}

function bindCheckoutVerificationModalEvents(modal) {
    if (!modal || modal.dataset.eventsBound === '1') return;
    modal.dataset.eventsBound = '1';

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeCheckoutVerificationModal();
    });
    modal.querySelector('#checkout-vin-cancel')?.addEventListener('click', (e) => {
        e.preventDefault();
        handleCheckoutStepAction('back');
    });
    modal.querySelector('#checkout-vin-close')?.addEventListener('click', (e) => {
        e.preventDefault();
        closeCheckoutVerificationModal();
    });
    modal.querySelector('#checkout-vin-confirm')?.addEventListener('click', (e) => {
        e.preventDefault();
        handleCheckoutStepAction('next');
    });
    modal.querySelector('#checkout-use-location')?.addEventListener('click', (e) => {
        e.preventDefault();
        useCheckoutCurrentLocation();
    });
    modal.querySelector('#checkout-customer-city')?.addEventListener('change', () => {
        const citySelect = modal.querySelector('#checkout-customer-city');
        const other = modal.querySelector('#checkout-customer-city-other');
        if (!citySelect || !other) return;
        const isOther = citySelect.value === '__other__';
        other.hidden = !isOther;
        if (isOther) other.focus();
    });
    modal.querySelector('#checkout-car-remove')?.addEventListener('click', (e) => {
        e.preventDefault();
        clearCheckoutPhotoSlot(modal, 'car');
    });
    modal.querySelector('#checkout-istimara-remove')?.addEventListener('click', (e) => {
        e.preventDefault();
        clearCheckoutPhotoSlot(modal, 'istimara');
    });

    const vinInput = modal.querySelector('#checkout-vin-input');
    vinInput?.addEventListener('input', () => {
        vinInput.value = vinInput.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17);
    });

    const bindPhotoInput = (slot) => {
        const fileInput = modal.querySelector(`#checkout-${slot}-photo`);
        fileInput?.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (!file) return;
            if (!String(file.type || '').startsWith('image/')) {
                showToast(currentLang === 'ar' ? 'اختر صورة فقط' : 'Please choose an image file', 'error');
                fileInput.value = '';
                return;
            }
            setCheckoutPhotoFile(modal, slot, file);
        });
    };
    bindPhotoInput('car');
    bindPhotoInput('istimara');

    if (!window.__checkoutEscBound) {
        window.__checkoutEscBound = true;
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const openModal = document.getElementById('checkout-verification-modal');
            if (openModal?.classList.contains('open')) {
                closeCheckoutVerificationModal();
            }
        });
    }
}

function openCheckoutVerificationModal() {
    if (cart.length === 0) {
        showToast(currentLang === 'ar' ? 'السلة فارغة!' : 'Your cart is empty!', 'error');
        return;
    }

    closeDrawers();
    const modal = ensureCheckoutVerificationModal();

    const title = modal.querySelector('#vin-checkout-title');
    const desc = modal.querySelector('#vin-checkout-desc');
    const ackText = modal.querySelector('#vin-ack-text');
    const cancelBtn = modal.querySelector('#checkout-vin-cancel');
    const vinInput = modal.querySelector('#checkout-vin-input');
    const vinLabel = modal.querySelector('#vin-input-label');
    const nameInput = modal.querySelector('#checkout-customer-name');
    const phoneInput = modal.querySelector('#checkout-customer-phone');
    const cityInput = modal.querySelector('#checkout-customer-city');
    const cityOther = modal.querySelector('#checkout-customer-city-other');
    const addressInput = modal.querySelector('#checkout-customer-address');
    const latInput = modal.querySelector('#checkout-customer-lat');
    const lngInput = modal.querySelector('#checkout-customer-lng');
    const locationBtnText = modal.querySelector('#checkout-location-btn-text');
    const locationHint = modal.querySelector('#checkout-location-hint');
    const nameLabel = modal.querySelector('#checkout-name-label');
    const phoneLabel = modal.querySelector('#checkout-phone-label');
    const cityLabel = modal.querySelector('#checkout-city-label');
    const addressLabel = modal.querySelector('#checkout-address-label');
    const ack = modal.querySelector('#checkout-vin-ack');
    const ackWrap = modal.querySelector('#checkout-vin-ack-wrap');
    const photoBenefit = modal.querySelector('#checkout-photo-benefit');
    const carTitle = modal.querySelector('#checkout-car-title');
    const carHint = modal.querySelector('#checkout-car-hint');
    const istimaraTitle = modal.querySelector('#checkout-istimara-title');
    const istimaraHint = modal.querySelector('#checkout-istimara-hint');
    const carRemove = modal.querySelector('#checkout-car-remove');
    const istimaraRemove = modal.querySelector('#checkout-istimara-remove');

    const reqStar = ' <span class="req-star" aria-hidden="true">*</span>';
    if (title) title.textContent = getTranslation('vin_checkout_title') || 'إتمام الطلب';
    if (desc) desc.textContent = getTranslation('vin_checkout_desc') || 'أدخل بيانات التواصل والعنوان. صور المركبة اختيارية.';
    if (ackText) ackText.textContent = getTranslation('vin_checkout_ack') || '';
    if (vinLabel) vinLabel.textContent = getTranslation('vin_checkout_input_label') || 'رقم الهيكل (اختياري)';
    if (nameLabel) nameLabel.innerHTML = `${getTranslation('checkout_name_label') || 'الاسم'}${reqStar}`;
    if (phoneLabel) phoneLabel.innerHTML = `${getTranslation('checkout_phone_label') || 'رقم الجوال'}${reqStar}`;
    if (cityLabel) cityLabel.innerHTML = `${getTranslation('checkout_city_label') || 'المدينة'}${reqStar}`;
    if (addressLabel) addressLabel.innerHTML = `${getTranslation('checkout_address_label') || 'تفاصيل العنوان'}${reqStar}`;
    if (locationBtnText) locationBtnText.textContent = getTranslation('checkout_use_location') || 'استخدم موقعي الحالي';
    if (locationHint) locationHint.textContent = getTranslation('checkout_location_hint') || 'أسهل طريقة: اضغط الزر ويحدد المدينة والعنوان تلقائيًا';
    if (photoBenefit) {
        photoBenefit.textContent = getTranslation('vin_checkout_photo_benefit')
            || 'الصور اختيارية، وتساعد فريقنا في مراجعة بيانات المركبة.';
    }
    if (carTitle) carTitle.textContent = getTranslation('vin_checkout_car_label') || 'صورة السيارة (اختياري)';
    if (carHint) carHint.textContent = getTranslation('vin_checkout_car_hint') || 'صورة واضحة للسيارة من الخارج';
    if (istimaraTitle) istimaraTitle.textContent = getTranslation('vin_checkout_istimara_label') || 'صورة الاستمارة (اختياري)';
    if (istimaraHint) istimaraHint.textContent = getTranslation('vin_checkout_istimara_hint') || 'صورة واضحة لاستمارة المركبة';
    if (carRemove) carRemove.textContent = getTranslation('vin_checkout_remove_photo') || 'إزالة الصورة';
    if (istimaraRemove) istimaraRemove.textContent = getTranslation('vin_checkout_remove_photo') || 'إزالة الصورة';
    if (cancelBtn) cancelBtn.textContent = getTranslation('vin_checkout_back') || 'رجوع';
    if (vinInput) {
        vinInput.value = '';
        vinInput.placeholder = getTranslation('vin_checkout_input_ph') || '';
    }
    if (nameInput) {
        nameInput.value = localStorage.getItem('qetaa_customer_name') || '';
        nameInput.placeholder = getTranslation('checkout_name_ph') || 'اسمك الكامل';
    }
    if (phoneInput) {
        phoneInput.value = localStorage.getItem('qetaa_customer_phone') || '';
        phoneInput.placeholder = getTranslation('checkout_phone_ph') || '05xxxxxxxx';
    }
    if (cityOther) {
        cityOther.value = '';
        cityOther.hidden = true;
        cityOther.placeholder = getTranslation('checkout_city_other_ph') || 'اكتب اسم المدينة';
    }
    if (cityInput) {
        const savedCity = localStorage.getItem('qetaa_customer_city') || '';
        const options = Array.from(cityInput.options || []).map((o) => o.value);
        if (savedCity && options.includes(savedCity)) {
            cityInput.value = savedCity;
        } else if (savedCity) {
            cityInput.value = '__other__';
            if (cityOther) {
                cityOther.hidden = false;
                cityOther.value = savedCity;
            }
        } else {
            cityInput.value = '';
        }
    }
    if (addressInput) {
        addressInput.value = localStorage.getItem('qetaa_customer_address') || '';
        addressInput.placeholder = getTranslation('checkout_address_ph') || 'الحي أو الشارع (اختياري إذا استخدمت موقعك)';
    }
    if (latInput) latInput.value = localStorage.getItem('qetaa_customer_lat') || '';
    if (lngInput) lngInput.value = localStorage.getItem('qetaa_customer_lng') || '';
    if (ack) ack.checked = false;
    if (ackWrap) ackWrap.hidden = true;
    clearCheckoutVehiclePhoto(modal);
    setCheckoutStep(modal, 1);

    requestAnimationFrame(() => modal.classList.add('open'));
    document.body.classList.add('drawer-open');
}

function getCheckoutCityValue() {
    const citySelect = document.getElementById('checkout-customer-city');
    const cityOther = document.getElementById('checkout-customer-city-other');
    if (!citySelect) return '';
    if (citySelect.value === '__other__') {
        return (cityOther?.value || '').trim();
    }
    return (citySelect.value || '').trim();
}

function setCheckoutCityValue(cityName) {
    const citySelect = document.getElementById('checkout-customer-city');
    const cityOther = document.getElementById('checkout-customer-city-other');
    if (!citySelect || !cityName) return;
    const options = Array.from(citySelect.options).map((o) => o.value);
    const exact = options.find((v) => v && v !== '__other__' && v === cityName);
    const soft = options.find((v) => v && v !== '__other__' && (cityName.includes(v) || v.includes(cityName)));
    if (exact || soft) {
        citySelect.value = exact || soft;
        if (cityOther) {
            cityOther.hidden = true;
            cityOther.value = '';
        }
        return;
    }
    citySelect.value = '__other__';
    if (cityOther) {
        cityOther.hidden = false;
        cityOther.value = cityName;
    }
}

async function reverseGeocodeCheckoutLocation(lat, lng) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=ar`;
    const response = await fetch(url, {
        headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('geocode_failed');
    const data = await response.json();
    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || addr.state_district || addr.county || addr.state || '';
    const parts = [addr.suburb, addr.neighbourhood, addr.road, addr.quarter].filter(Boolean);
    const details = parts.join('، ') || data.display_name || '';
    return { city, details };
}

async function useCheckoutCurrentLocation() {
    const btn = document.getElementById('checkout-use-location');
    const btnText = document.getElementById('checkout-location-btn-text');
    if (!navigator.geolocation) {
        showToast(currentLang === 'ar' ? 'الجهاز لا يدعم تحديد الموقع' : 'Geolocation is not supported', 'error');
        return;
    }
    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = currentLang === 'ar' ? 'جاري تحديد موقعك...' : 'Detecting location...';

    try {
        const position = await new Promise((resolve, reject) => {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 15000,
                maximumAge: 60000,
            });
        });
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        const latInput = document.getElementById('checkout-customer-lat');
        const lngInput = document.getElementById('checkout-customer-lng');
        const addressInput = document.getElementById('checkout-customer-address');
        if (latInput) latInput.value = String(lat);
        if (lngInput) lngInput.value = String(lng);

        try {
            const geo = await reverseGeocodeCheckoutLocation(lat, lng);
            if (geo.city) setCheckoutCityValue(geo.city);
            if (addressInput && geo.details) addressInput.value = geo.details;
            showToast(currentLang === 'ar' ? 'تم تحديد موقعك بنجاح' : 'Location detected successfully');
        } catch (_) {
            if (addressInput && !addressInput.value.trim()) {
                addressInput.value = `موقع GPS: ${lat.toFixed(5)}, ${lng.toFixed(5)}`;
            }
            showToast(currentLang === 'ar' ? 'تم حفظ موقعك — أكمل المدينة إن لزم' : 'Location saved — complete city if needed');
        }
    } catch (err) {
        const denied = err && (err.code === 1 || /denied/i.test(String(err.message || '')));
        showToast(currentLang === 'ar'
            ? (denied ? 'اسمح بالوصول للموقع من إعدادات المتصفح' : 'تعذر تحديد الموقع، اكتب العنوان يدويًا')
            : (denied ? 'Allow location access in browser settings' : 'Could not detect location, enter address manually'), 'error');
    } finally {
        if (btn) btn.disabled = false;
        if (btnText) btnText.textContent = getTranslation('checkout_use_location') || 'استخدم موقعي الحالي';
    }
}
function buildWhatsAppOrderMessage(vinCode = '', photoUrl = '', photoKind = 'vin') {
    const lines = cart.map((item, index) =>
        `${index + 1}) ${item.title}\nالكمية: ${item.quantity}\nOEM: ${item.oem_number || '-'}`
    ).join('\n\n');
    const total = cart.reduce((sum, item) => sum + (item.price || 0) * item.quantity, 0);
    const vinLine = vinCode ? `\nرقم الهيكل (VIN): ${vinCode}` : '';
    const kindLabel = photoKind === 'license' ? 'صورة الرخصة / الاستمارة' : 'صورة رقم الهيكل';
    const photoLine = photoUrl
        ? `\n\n📷 ${kindLabel}:\n${photoUrl}`
        : '\n\nℹ️ لم تُرفق صورة المركبة (اختياري).';
    return `مرحباً CHINA PARTS، أود تأكيد الطلب التالي:\n\n${lines}\n\nالإجمالي التقريبي: ${total.toFixed(2)} ر.س${vinLine}${photoLine}\n\n${photoUrl ? '✅ أرفقت صورة المركبة لمساعدتكم في مراجعة بيانات الطلب.' : '✅ بانتظار تأكيدكم للطلب.'}`;
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('read_failed'));
        reader.readAsDataURL(file);
    });
}

function compressImageFile(file, maxSide = 1600, quality = 0.82) {
    return new Promise(async (resolve, reject) => {
        try {
            if (!file || !String(file.type || '').startsWith('image/')) {
                reject(new Error('invalid_image'));
                return;
            }
            // Keep small images as-is when already compact.
            if (file.size <= 700 * 1024 && /jpeg|jpg|png|webp/i.test(file.type)) {
                const dataUrl = await readFileAsDataUrl(file);
                resolve({ dataUrl, mime: file.type === 'image/jpg' ? 'image/jpeg' : file.type });
                return;
            }
            const dataUrl = await readFileAsDataUrl(file);
            const img = new Image();
            img.onload = () => {
                const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
                const w = Math.max(1, Math.round((img.width || 1) * scale));
                const h = Math.max(1, Math.round((img.height || 1) * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    resolve({ dataUrl, mime: file.type || 'image/jpeg' });
                    return;
                }
                ctx.drawImage(img, 0, 0, w, h);
                const out = canvas.toDataURL('image/jpeg', quality);
                resolve({ dataUrl: out, mime: 'image/jpeg' });
            };
            img.onerror = () => reject(new Error('image_load_failed'));
            img.src = dataUrl;
        } catch (err) {
            reject(err);
        }
    });
}

async function uploadCheckoutVehiclePhoto(file, kind = 'vin') {
    const compressed = await compressImageFile(file);
    const payload = await apiJson('/checkout/vehicle-photo', {
        method: 'POST',
        body: JSON.stringify({
            image_base64: compressed.dataUrl,
            mime_type: compressed.mime,
            kind,
        }),
    });
    if (!payload?.path) {
        throw new Error(payload?.message || 'upload_failed');
    }
    return payload;
}

async function confirmCheckoutOrder() {
    if (cart.length === 0) {
        showToast(currentLang === 'ar' ? 'السلة فارغة!' : 'Your cart is empty!', 'error');
        closeCheckoutVerificationModal();
        return;
    }

    const modal = document.getElementById('checkout-verification-modal');
    const confirmBtn = document.getElementById('checkout-vin-confirm');
    const carFile = modal?._carPhotoFile || document.getElementById('checkout-car-photo')?.files?.[0];
    const istimaraFile = modal?._istimaraPhotoFile || document.getElementById('checkout-istimara-photo')?.files?.[0];
    const customerName = (document.getElementById('checkout-customer-name')?.value || '').trim();
    const customerPhone = (document.getElementById('checkout-customer-phone')?.value || '').trim();
    const customerCity = getCheckoutCityValue();
    const customerAddress = (document.getElementById('checkout-customer-address')?.value || '').trim();
    const customerLat = (document.getElementById('checkout-customer-lat')?.value || '').trim();
    const customerLng = (document.getElementById('checkout-customer-lng')?.value || '').trim();
    const hasGps = Boolean(customerLat && customerLng);

    if (!customerName || customerName.length < 2) {
        showToast(currentLang === 'ar' ? 'اكتب اسمك من فضلك' : 'Please enter your name', 'error');
        return;
    }
    const phoneDigits = customerPhone.replace(/\D/g, '');
    if (phoneDigits.length < 9) {
        showToast(currentLang === 'ar' ? 'اكتب رقم جوال صحيح' : 'Please enter a valid phone number', 'error');
        return;
    }
    if (!customerCity || customerCity.length < 2) {
        showToast(currentLang === 'ar' ? 'اختر المدينة أو استخدم موقعك' : 'Choose a city or use your location', 'error');
        return;
    }
    if (!hasGps && (!customerAddress || customerAddress.length < 3)) {
        showToast(currentLang === 'ar' ? 'اكتب تفاصيل العنوان أو استخدم موقعك الحالي' : 'Enter address details or use your current location', 'error');
        return;
    }
    const vinRaw = (document.getElementById('checkout-vin-input')?.value || '').trim().toUpperCase();
    if (vinRaw && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vinRaw)) {
        showToast(currentLang === 'ar'
            ? 'رقم الهيكل غير صحيح — 17 خانة أو اتركه فارغاً'
            : 'Invalid VIN — 17 characters or leave empty', 'error');
        return;
    }

    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> ${currentLang === 'ar' ? 'جاري إرسال الطلب...' : 'Submitting request...'}`;
    }

    try {
        const [carUpload, istimaraUpload] = await Promise.all([
            carFile ? uploadCheckoutVehiclePhoto(carFile, 'car') : Promise.resolve(null),
            istimaraFile ? uploadCheckoutVehiclePhoto(istimaraFile, 'istimara') : Promise.resolve(null),
        ]);
        const carPhotoPath = carUpload?.path || carUpload?.url || '';
        const istimaraPhotoPath = istimaraUpload?.path || istimaraUpload?.url || '';
        const photoPath = istimaraPhotoPath || carPhotoPath;

        const items = cart.map((item) => ({
            id: item.id,
            title: item.title,
            quantity: item.quantity,
            price: item.price,
            oem_number: item.oem_number || null,
            salla_product_id: item.salla_product_id || null,
        }));
        const total = cart.reduce((sum, item) => sum + (item.price || 0) * item.quantity, 0);

        await apiJson('/storefront/checkout-inquiry', {
            method: 'POST',
            body: JSON.stringify({
                customer_name: customerName,
                customer_phone: customerPhone,
                customer_city: customerCity,
                customer_address: customerAddress || (hasGps ? `GPS: ${customerLat}, ${customerLng}` : ''),
                customer_lat: customerLat || null,
                customer_lng: customerLng || null,
                vin_code: vinRaw,
                vin_photo_path: photoPath,
                car_photo_path: carPhotoPath,
                istimara_photo_path: istimaraPhotoPath,
                photo_kind: carPhotoPath && istimaraPhotoPath
                    ? 'car_istimara'
                    : (carPhotoPath ? 'car' : (istimaraPhotoPath ? 'istimara' : null)),
                items,
                total_amount: total,
            }),
        });

        if (typeof window.trackAdsEvent === 'function') {
            window.trackAdsEvent('add_shipping_info', {
                shipping_tier: 'to_be_confirmed',
                items: cart,
                currency: 'SAR',
                value: total,
            });
        }
        localStorage.setItem('qetaa_customer_name', customerName);
        localStorage.setItem('qetaa_customer_phone', customerPhone);
        localStorage.setItem('qetaa_customer_city', customerCity);
        localStorage.setItem('qetaa_customer_address', customerAddress);
        if (hasGps) {
            localStorage.setItem('qetaa_customer_lat', customerLat);
            localStorage.setItem('qetaa_customer_lng', customerLng);
        }

        closeCheckoutVerificationModal({ keepIsolatedCart: true });

        const onlineReady = isZidReadyForCart() || isSallaReadyForCart();
        if (onlineReady) {
            showToast(currentLang === 'ar'
                ? 'تم حفظ الطلب — جاري التحويل للدفع'
                : 'Request saved — redirecting to payment');
            await startOnlineCheckout();
            return;
        }

        settleBuyNowCart(true);
        closeDrawers();
        showToast(currentLang === 'ar'
            ? 'تم استلام طلبك بنجاح — سنتواصل معك قريباً'
            : 'Order received — we will contact you soon');
    } catch (err) {
        showToast(err?.message || (currentLang === 'ar' ? 'تعذر إرسال الطلب' : 'Could not submit the order'), 'error');
        if (confirmBtn) {
            confirmBtn.disabled = false;
            const onlineReady = isZidReadyForCart() || isSallaReadyForCart();
            const label = onlineReady
                ? (getTranslation('vin_checkout_confirm_pay') || 'تأكيد الطلب والمتابعة للدفع')
                : (getTranslation('vin_checkout_confirm') || 'تأكيد الطلب');
            confirmBtn.innerHTML = `<i class="fa-solid fa-check"></i> ${label}`;
        }
    }
}

// Keep old name as alias for any leftover callers.
async function confirmWhatsAppCheckout() {
    return confirmCheckoutOrder();
}

function confirmSallaCheckout() {
    closeCheckoutVerificationModal();
    startOnlineCheckout();
}

// --- Favorites & Comparison ---
function getStorefrontSessionId() {
    let sessionId = localStorage.getItem('qetaa_session_id');
    if (!sessionId) {
        sessionId = `guest-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        localStorage.setItem('qetaa_session_id', sessionId);
    }
    return sessionId;
}

async function apiJson(path, options = {}) {
    const token = localStorage.getItem('qetaa_customer_token') || '';
    const response = await fetch(`${API_BASE}${path}`, {
        headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(options.headers || {}),
        },
        ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.message || 'تعذر تنفيذ العملية.');
    }
    return data;
}

// --- VIN Search & Tabs ---
function switchSearchTab(tab) {
    const btnVehicle = document.getElementById('tab-vehicle');
    const btnVin = document.getElementById('tab-vin');
    const formVehicle = document.getElementById('form-vehicle');
    const formVin = document.getElementById('form-vin');
    const hint = document.getElementById('parts-finder-hint');

    if (!btnVehicle || !btnVin || !formVehicle || !formVin) return;

    const setActive = (activeBtn, idleBtn, showForm, hideForm) => {
        activeBtn.classList.add('is-active');
        activeBtn.setAttribute('aria-selected', 'true');
        idleBtn.classList.remove('is-active');
        idleBtn.setAttribute('aria-selected', 'false');
        showForm.hidden = false;
        hideForm.hidden = true;
    };

    if (tab === 'vehicle') {
        setActive(btnVehicle, btnVin, formVehicle, formVin);
        if (hint) hint.textContent = getTranslation('finder_hint') || hint.textContent;
    } else {
        setActive(btnVin, btnVehicle, formVin, formVehicle);
        if (hint) {
            hint.textContent = currentLang === 'ar'
                ? 'أدخل الـ 17 خانة كاملة كما هي على لوحة المركبة أو الاستمارة.'
                : 'Enter all 17 characters exactly as on the vehicle plate or registration.';
        }
        document.getElementById('vin-input')?.focus();
    }
}

function initRevealOnScroll() {
    const items = document.querySelectorAll('.reveal-on-scroll');
    if (!items.length) return;
    items.forEach(el => el.classList.add('is-visible'));
}

async function initHomePage() {
    initRevealOnScroll();

    const grid = document.getElementById('latest-products-grid');
    const bestsellersGrid = document.getElementById('bestsellers-grid');
    const offerGrid = document.getElementById('offer-products-grid');
    const promoBlocks = document.getElementById('home-promo-blocks');
    const brandSelect = document.getElementById('search-brand');
    const modelSelect = document.getElementById('search-model');
    const yearSelect = document.getElementById('search-year');
    const searchBtn = document.getElementById('btn-submit-search');

    const renderProductStrip = (target, products, { allCard = false, emptyMsg = null } = {}) => {
        if (!target) return;
        const list = (Array.isArray(products) ? products : []).filter((p) => p && (p.image_url || p.image));
        if (!list.length) {
            target.innerHTML = `<div class="text-center text-muted" style="grid-column:1/-1">${emptyMsg || getTranslation('no_parts_found') || 'لا توجد منتجات حالياً'}</div>`;
            return;
        }
        let html = list.slice(0, 8).map(createProductCardHtml).join('');
        if (allCard) {
            html += `
                <a href="collection.html" class="product-card product-card-all" aria-label="جميع المنتجات">
                    <span class="product-card-all-icon" aria-hidden="true"><i class="fa-solid fa-border-all"></i></span>
                    <strong>جميع المنتجات</strong>
                    <span>تصفح كامل الكتالوج</span>
                </a>`;
        }
        target.innerHTML = html;
    };

    const renderPromoBlocks = (blocks) => {
        if (!promoBlocks) return;
        const list = Array.isArray(blocks) && blocks.length ? blocks : [
            { title_ar: 'مراجعة بيانات المركبة', desc_ar: 'يمكنك إرفاق رقم الهيكل أو صورة الاستمارة لمراجعة الطلب.', cta_ar: 'تصفح القطع', href: 'collection.html', tone: 'blue' },
            { title_ar: 'تفاصيل الشحن', desc_ar: 'نؤكد خيار الشحن وتكلفته قبل إتمام الطلب.', cta_ar: 'ابدأ الطلب', href: 'collection.html', tone: 'silver' },
            { title_ar: 'مساعدة في البحث', desc_ar: 'إذا لم تجد القطعة، أرسل لنا بياناتها لنراجع الخيارات المتاحة.', cta_ar: 'تواصل معنا', href: 'contact.html', tone: 'dark' },
        ];
        promoBlocks.innerHTML = list.map((b) => `
            <a class="promo-block tone-${escapeHtml(b.tone || 'blue')}" href="${escapeHtml(b.href || 'collection.html')}">
                <strong>${escapeHtml(b.title_ar || '')}</strong>
                <span>${escapeHtml(b.desc_ar || '')}</span>
                <em>${escapeHtml(b.cta_ar || 'عرض المزيد')} <i class="fa-solid fa-arrow-left"></i></em>
            </a>
        `).join('');
    };

    // One bundled home payload is faster than 3 separate API round-trips.
    let homePayload = null;
    try {
        const homeRes = await fetch(`${API_BASE}/storefront/home`);
        homePayload = await homeRes.json();
        if (Array.isArray(homePayload?.brands)) cachedBrands = homePayload.brands;
        if (Array.isArray(homePayload?.categories)) cachedCategories = homePayload.categories;
        renderHeaderAndFooterData();
        try {
            sessionStorage.setItem('qetaa_catalog_cache_v3', JSON.stringify({
                ts: Date.now(),
                brands: cachedBrands,
                categories: cachedCategories,
            }));
        } catch (e) {}
    } catch (e) {
        if (!cachedBrands.length) {
            try { await initGlobalHeaderAndFooter(); } catch (err) {}
        } else {
            renderHeaderAndFooterData();
        }
    }

    renderPromoBlocks(homePayload?.promo_blocks);

    const latest = Array.isArray(homePayload?.latest_products) ? homePayload.latest_products : [];
    const selected = Array.isArray(homePayload?.selected_products) ? homePayload.selected_products : [];
    const browse = Array.isArray(homePayload?.browse_products) ? homePayload.browse_products : [];

    try {
        if (!latest.length && grid) {
            const resProducts = await fetch(`${API_BASE}/storefront/products?per_page=8`);
            const productsData = await resProducts.json();
            const raw = productsData.data;
            renderProductStrip(grid, Array.isArray(raw) ? raw : [], { allCard: true });
        } else {
            renderProductStrip(grid, latest, { allCard: true });
        }
        renderProductStrip(bestsellersGrid, selected);
        renderProductStrip(offerGrid, browse);
        refreshInteractionButtons();
        initRevealOnScroll();
        window.renderCurrentPageProducts = () => {
            renderProductStrip(grid, latest.length ? latest : selected, { allCard: true });
            refreshInteractionButtons();
        };
    } catch (err) {
        if (grid) grid.innerHTML = '<div class="text-center text-error" style="grid-column: 1/-1">تعذر تحميل المنتجات. تأكد من تشغيل الخادم.</div>';
    }

    if (brandSelect && modelSelect) {
        const resetYears = () => {
            if (!yearSelect) return;
            yearSelect.innerHTML = `<option value="">${getTranslation('select_year') || 'اختر السنة'}</option>`;
            yearSelect.value = '';
            yearSelect.disabled = true;
            syncUiSelect(yearSelect);
        };

        const resetModels = () => {
            modelSelect.innerHTML = `<option value="">${getTranslation('select_model') || 'اختر الموديل'}</option>`;
            modelSelect.value = '';
            modelSelect.disabled = true;
            syncUiSelect(modelSelect);
            resetYears();
        };

        brandSelect.addEventListener('change', async () => {
            resetModels();
            syncUiSelect(brandSelect);
            const brandId = String(brandSelect.value || '').trim();
            if (!brandId) return;

            try {
                const models = await fetch(`${API_BASE}/models/${encodeURIComponent(brandId)}`).then((r) => r.json());
                const list = Array.isArray(models) ? models : (models.data || []);
                list.forEach((model) => {
                    const opt = document.createElement('option');
                    opt.value = model.id;
                    opt.textContent = model.name_ar || model.name_en;
                    modelSelect.appendChild(opt);
                });
                modelSelect.disabled = list.length === 0;
                syncUiSelect(modelSelect);
                if (!list.length) {
                    showToast(currentLang === 'ar' ? 'لا توجد موديلات لهذه الماركة' : 'No models for this brand', 'error');
                }
            } catch (e) {
                console.error(e);
                syncUiSelect(modelSelect);
            }
        });

        if (yearSelect) {
            modelSelect.addEventListener('change', async () => {
                resetYears();
                syncUiSelect(modelSelect);
                const modelId = String(modelSelect.value || '').trim();
                if (!modelId) return;
                try {
                    const years = await fetch(`${API_BASE}/years/${encodeURIComponent(modelId)}`).then((r) => r.json());
                    const list = Array.isArray(years) ? years : (years.data || []);
                    list.forEach((year) => {
                        const value = typeof year === 'object' ? (year.year || year.id) : year;
                        if (value == null || value === '') return;
                        const opt = document.createElement('option');
                        opt.value = value;
                        opt.textContent = value;
                        yearSelect.appendChild(opt);
                    });
                    yearSelect.disabled = list.length === 0;
                    syncUiSelect(yearSelect);
                    if (!list.length) {
                        showToast(currentLang === 'ar' ? 'لا توجد سنوات لهذا الموديل' : 'No years for this model', 'error');
                    }
                } catch (e) {
                    console.error(e);
                    syncUiSelect(yearSelect);
                }
            });
        }
    }

    if (searchBtn) {
        const runVehicleSearch = () => {
            const params = new URLSearchParams();
            const brand = document.getElementById('search-brand')?.value;
            const model = document.getElementById('search-model')?.value;
            const year = document.getElementById('search-year')?.value;
            const category = document.getElementById('search-category')?.value;
            if (!brand && !category) {
                showToast('اختر الماركة أو القسم أولاً للبحث', 'error');
                return;
            }
            if (brand) params.set('brand', brand);
            if (model) params.set('model', model);
            if (year) params.set('year', year);
            if (category) {
                if (/^\d+$/.test(String(category))) params.set('category', category);
                else params.set('category_key', category);
            }
            window.location.href = `collection.html?${params.toString()}`;
        };

        searchBtn.addEventListener('click', (e) => {
            e.preventDefault();
            runVehicleSearch();
        });

        const vehicleForm = document.getElementById('form-vehicle');
        if (vehicleForm) {
            vehicleForm.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                runVehicleSearch();
            });
        }
    }
}

function showApiDownBanner() {
    if (document.getElementById('api-down-banner')) return;
    const el = document.createElement('div');
    el.id = 'api-down-banner';
    el.className = 'api-down-banner';
    el.innerHTML = `
        <strong>خادم المنتجات غير متصل</strong>
        <span>أعد تحميل الصفحة أو تأكد أن الخدمة تعمل على
        <a href="${location.origin}/">${location.origin}/</a></span>
        <button type="button" aria-label="إغلاق" onclick="this.parentElement.remove()">×</button>
    `;
    document.body.prepend(el);
}

async function pingApiHealth() {
    try {
        const res = await fetch(`${API_BASE}/storefront/products?per_page=1`, { cache: 'no-store' });
        if (res.ok) {
            document.getElementById('api-down-banner')?.remove();
            return true;
        }
    } catch (e) {}
    try {
        const res = await fetch(`${API_BASE}/brands`, { cache: 'no-store' });
        if (res.ok) {
            document.getElementById('api-down-banner')?.remove();
            return true;
        }
    } catch (e) {}
    showApiDownBanner();
    return false;
}

function disableUnverifiedPartTypeFilters() {
    const controls = document.querySelectorAll([
        '[name="part_type"]',
        '[data-filter="part_type"]',
        '#part-type-filter',
        '#filter-part-type',
        '.part-type-filter',
    ].join(','));
    controls.forEach((control) => {
        if ('checked' in control) control.checked = false;
        if ('value' in control) control.value = '';
        if ('disabled' in control) control.disabled = true;
        const group = control.closest('.filter-group, .filter-section, .collection-filter-group');
        (group || control).hidden = true;
    });

    const url = new URL(window.location.href);
    if (url.searchParams.has('part_type')) {
        url.searchParams.delete('part_type');
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }
}

function initApp() {
    try { hydrateInteractionsFromCache(); } catch (e) {}
    try { initCart(); } catch (e) {}
    try { initDrawers(); } catch (e) {}
    try { ensureCartDock(); } catch (e) {}
    try { injectFloatingWhatsApp(); } catch (e) {}
    try { injectLanguageSwitcher(); } catch (e) {}
    try { injectAccountUI(); } catch (e) {}
    try { initAccountPage(); } catch (e) {}
    try { injectInteractionUI(); } catch (e) {}
    try { polishHeaderChromeIcons(); } catch (e) {}
    try {
        interactionsReady = true;
        paintInteractionChrome();
    } catch (e) {}
    try { applyTranslations(); } catch (e) {}
    try { disableUnverifiedPartTypeFilters(); } catch (e) {}
    refreshZidLiveFlag().then((live) => {
        if (live) {
            try { renderCart(); } catch (e) {}
        }
    }).catch(() => {});
    refreshSallaLiveFlag().then((live) => {
        if (live) {
            try { renderCart(); } catch (e) {}
        }
    }).catch(() => {});
    try {
        // Always wire header search (homepage skips catalog refetch below).
        initGlobalSearchBar();
    } catch (e) {}
    try {
        // Homepage loads catalog via /storefront/home — skip duplicate heavy fetches.
        if (!document.getElementById('latest-products-grid')) {
            initGlobalHeaderAndFooter();
        }
    } catch (e) {}
    try {
        setTimeout(() => { pingApiHealth(); }, 400);
    } catch (e) {}
    // Background sync after first paint — avoid blocking PHP on page load
    try {
        setTimeout(() => {
            loadInteractions().catch(() => {});
        }, 1200);
    } catch (e) {}
    try { initRevealOnScroll(); } catch (e) {}
    try { renderCart(); } catch (e) {}

    const btnVinSubmit = document.getElementById('btn-submit-vin');
    if (btnVinSubmit) {
        btnVinSubmit.addEventListener('click', async (e) => {
            e.preventDefault();
            const vinInput = (document.getElementById('vin-input')?.value || '').trim().toUpperCase();
            if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vinInput)) {
                showToast('الرجاء إدخال رقم هيكل صحيح مكون من 17 خانة', 'error');
                return;
            }
            window.location.href = `vin-results.html?vin=${encodeURIComponent(vinInput)}`;
        });
    }

    const vinInput = document.getElementById('vin-input');
    if (vinInput) {
        vinInput.addEventListener('input', () => {
            vinInput.value = vinInput.value.toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '').slice(0, 17);
        });
        vinInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') btnVinSubmit?.click();
        });
    }
}

document.addEventListener('click', (event) => {
    const link = event.target && event.target.closest && event.target.closest('a[href*="product.html?id="]');
    if (!link || typeof window.trackAdsEvent !== 'function') return;
    try {
        const href = new URL(link.getAttribute('href') || '', window.location.href);
        const itemId = href.searchParams.get('id');
        if (!itemId) return;
        window.trackAdsEvent('select_item', {
            item_id: itemId,
            item_name: (link.getAttribute('aria-label') || link.textContent || '').trim(),
        });
    } catch (_err) {}
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// Expose Global Functions
window.API_BASE = API_BASE;
window.addToCart = addToCart;
window.buyNow = buyNow;
window.removeFromCart = removeFromCart;
window.updateQuantity = updateQuantity;
window.proceedToCheckout = proceedToCheckout;
window.openCheckoutVerificationModal = openCheckoutVerificationModal;
window.closeCheckoutVerificationModal = closeCheckoutVerificationModal;
window.confirmWhatsAppCheckout = confirmWhatsAppCheckout;
window.confirmCheckoutOrder = confirmCheckoutOrder;
window.useCheckoutCurrentLocation = useCheckoutCurrentLocation;
window.confirmSallaCheckout = confirmSallaCheckout;
window.showToast = showToast;
window.switchSearchTab = switchSearchTab;
window.brandLogoMarkup = brandLogoMarkup;
window.enhanceStorefrontSelects = enhanceStorefrontSelects;
window.syncUiSelect = syncUiSelect;
window.toggleFavorite = toggleFavorite;
window.toggleComparison = toggleComparison;
window.addFavoriteToCart = addFavoriteToCart;
window.addCompareItemToCart = addCompareItemToCart;
window.refreshSallaLiveFlag = refreshSallaLiveFlag;
window.refreshZidLiveFlag = refreshZidLiveFlag;
window.isSallaLive = () => SALLA_LIVE;
window.isZidLive = () => ZID_LIVE;
window.isOnlineCheckoutReadyForCart = isOnlineCheckoutReadyForCart;
window.openFavoritesDrawer = openFavoritesDrawer;
window.openComparePanel = openComparePanel;
window.openLightbox = openLightbox;
window.closeLightbox = closeLightbox;
window.refreshInteractionButtons = refreshInteractionButtons;
window.setLanguage = setLanguage;
window.initHomePage = initHomePage;
window.initRevealOnScroll = initRevealOnScroll;
window.renderHomeBrandsGrid = renderHomeBrandsGrid;
window.renderHomeCategories = renderHomeCategories;
window.HOME_FEATURED_CATEGORIES = HOME_FEATURED_CATEGORIES;
window.CATEGORY_ICONS = CATEGORY_ICONS;
