(function () {
    'use strict';

    const DEFAULTS = {
        metaPixelId: '',
        gtmId: '',
        ga4Id: '',
        googleAdsId: '',
        googleAdsPurchaseLabel: '',
        currency: 'SAR',
    };
    const CONSENT_KEY = 'qetaa_analytics_consent_v1';
    const PURCHASE_DEDUPE_KEY = 'qetaa_ads_purchase_dedupe_v1';
    const CONSENT_VERSION = 1;
    const MAX_QUEUE_SIZE = 50;
    const COMMERCE_EVENTS = new Set([
        'view_item',
        'select_item',
        'add_to_cart',
        'remove_from_cart',
        'begin_checkout',
        'add_shipping_info',
        'add_payment_info',
        'purchase',
    ]);
    const ALLOWED_PUBLIC_EVENTS = new Set([
        'view_item',
        'select_item',
        'add_to_cart',
        'remove_from_cart',
        'begin_checkout',
        'add_shipping_info',
        'add_payment_info',
        'search',
        'generate_lead',
        'whatsapp_click',
        'phone_click',
    ]);
    const PURCHASE_STATUSES = new Set(['paid', 'completed', 'succeeded', 'fulfilled']);

    let publicConfig = Object.assign({}, DEFAULTS, window.ADS_CONFIG || {});
    let configLoaded = false;
    let activated = false;
    let consentState = readConsent();
    let resolveConfigReady;
    const configReady = new Promise((resolve) => { resolveConfigReady = resolve; });
    const eventQueue = [];
    const pendingPurchaseHashes = new Set();

    window.ADS_CONFIG = publicConfig;
    window._adsQueue = window._adsQueue || [];
    window._adsReady = false;

    function safeStorageGet(key) {
        try {
            return window.localStorage ? window.localStorage.getItem(key) : null;
        } catch (_err) {
            return null;
        }
    }

    function safeStorageSet(key, value) {
        try {
            if (window.localStorage) window.localStorage.setItem(key, value);
        } catch (_err) {}
    }

    function readConsent() {
        const saved = safeStorageGet(CONSENT_KEY);
        if (!saved) {
            if (window.navigator && window.navigator.globalPrivacyControl === true) return 'denied';
            return 'pending';
        }
        if (saved === 'granted' || saved === 'denied') return saved;
        try {
            const parsed = JSON.parse(saved);
            return parsed && parsed.version === CONSENT_VERSION && parsed.choice === 'granted'
                ? 'granted'
                : (parsed && parsed.version === CONSENT_VERSION && parsed.choice === 'denied' ? 'denied' : 'pending');
        } catch (_err) {
            return 'pending';
        }
    }

    function saveConsent(choice) {
        safeStorageSet(CONSENT_KEY, JSON.stringify({
            version: CONSENT_VERSION,
            choice,
            updatedAt: new Date().toISOString(),
        }));
    }

    function cleanText(value, maxLength) {
        return String(value == null ? '' : value)
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxLength || 160);
    }

    function finiteNumber(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : (fallback == null ? 0 : fallback);
    }

    function positiveQuantity(value, fallback) {
        const number = Math.floor(Number(value));
        return Number.isFinite(number) && number > 0 ? Math.min(number, 999) : (fallback || 1);
    }

    function validConfig(config) {
        const raw = Object.assign({}, DEFAULTS, config || {});
        return {
            metaPixelId: /^\d{5,25}$/.test(String(raw.metaPixelId || '').trim()) ? String(raw.metaPixelId).trim() : '',
            gtmId: /^GTM-[A-Z0-9]+$/i.test(String(raw.gtmId || '').trim()) ? String(raw.gtmId).trim().toUpperCase() : '',
            ga4Id: /^G-[A-Z0-9]+$/i.test(String(raw.ga4Id || '').trim()) ? String(raw.ga4Id).trim().toUpperCase() : '',
            googleAdsId: /^AW-\d+$/i.test(String(raw.googleAdsId || '').trim()) ? String(raw.googleAdsId).trim().toUpperCase() : '',
            googleAdsPurchaseLabel: /^[A-Za-z0-9_-]{3,100}$/.test(String(raw.googleAdsPurchaseLabel || '').trim())
                ? String(raw.googleAdsPurchaseLabel).trim()
                : '',
            currency: 'SAR',
        };
    }

    function hasTrackingConfig() {
        return Boolean(publicConfig.metaPixelId || publicConfig.gtmId || publicConfig.ga4Id || publicConfig.googleAdsId);
    }

    function appendScript(src) {
        const script = document.createElement('script');
        script.async = true;
        script.src = src;
        script.referrerPolicy = 'no-referrer';
        document.head.appendChild(script);
    }

    function loadMeta(pixelId) {
        if (!pixelId || typeof window.fbq === 'function') return;
        const fbq = window.fbq = function () {
            fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments);
        };
        if (!window._fbq) window._fbq = fbq;
        fbq.push = fbq;
        fbq.loaded = true;
        fbq.version = '2.0';
        fbq.queue = [];
        appendScript('https://connect.facebook.net/en_US/fbevents.js');
        window.fbq('consent', 'grant');
        window.fbq('init', pixelId);
        window.fbq('track', 'PageView');
    }

    function ensureDataLayer() {
        window.dataLayer = window.dataLayer || [];
        return window.dataLayer;
    }

    function loadGoogleTagManager(containerId) {
        if (!containerId) return;
        const layer = ensureDataLayer();
        layer.push({
            'gtm.start': Date.now(),
            event: 'gtm.js',
            qetaa_consent: 'granted',
        });
        appendScript('https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(containerId));
    }

    function loadDirectGoogle(ga4Id, adsId) {
        const loaderId = ga4Id || adsId;
        if (!loaderId) return;
        ensureDataLayer();
        window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
        window.gtag('consent', 'default', {
            analytics_storage: 'granted',
            ad_storage: 'granted',
            ad_user_data: 'granted',
            ad_personalization: 'granted',
        });
        window.gtag('js', new Date());
        if (ga4Id) {
            window.gtag('config', ga4Id, {
                allow_google_signals: false,
                allow_ad_personalization_signals: false,
            });
        }
        if (adsId) window.gtag('config', adsId);
        appendScript('https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(loaderId));
    }

    function readCart() {
        try {
            const parsed = JSON.parse(safeStorageGet('qetaa_cart') || '[]');
            return Array.isArray(parsed) ? parsed : [];
        } catch (_err) {
            return [];
        }
    }

    function itemFromRaw(raw, index) {
        if (!raw || typeof raw !== 'object') return null;
        const itemId = cleanText(raw.item_id || raw.id || raw.sku || raw.product_id, 128);
        if (!itemId) return null;
        const item = {
            item_id: itemId,
            item_name: cleanText(raw.item_name || raw.name_ar || raw.name || raw.title || itemId, 160),
            price: finiteNumber(raw.price != null ? raw.price : raw.price_amount, 0),
            quantity: positiveQuantity(raw.quantity, 1),
        };
        const brand = cleanText(raw.item_brand || raw.brand_name || (raw.brand && (raw.brand.name_ar || raw.brand.name_en)), 80);
        const category = cleanText(raw.item_category || raw.category_name || (raw.category && (raw.category.name_ar || raw.category.name_en)), 80);
        const variant = cleanText(raw.item_variant || raw.variant, 80);
        if (brand) item.item_brand = brand;
        if (category) item.item_category = category;
        if (variant) item.item_variant = variant;
        if (Number.isFinite(Number(index))) item.index = Number(index);
        return item;
    }

    function quantityFromProductPage() {
        try {
            const input = document.getElementById('p-qty');
            return input ? positiveQuantity(input.value, 1) : 1;
        } catch (_err) {
            return 1;
        }
    }

    function legacyItems(name, params) {
        const explicit = Array.isArray(params.items)
            ? params.items.map(itemFromRaw).filter(Boolean)
            : [];
        if (explicit.length) return explicit;

        const cart = readCart();
        if (name === 'begin_checkout' || name === 'add_shipping_info' || name === 'add_payment_info') {
            return cart.map(itemFromRaw).filter(Boolean);
        }

        const ids = Array.isArray(params.content_ids)
            ? params.content_ids
            : [params.item_id || params.content_id].filter(Boolean);
        return ids.map((id, index) => {
            const cartItem = cart.find((item) => String(item && item.id) === String(id));
            const quantity = params.quantity != null
                ? positiveQuantity(params.quantity, 1)
                : (name === 'add_to_cart' ? quantityFromProductPage() : 1);
            return itemFromRaw({
                item_id: id,
                item_name: params.content_name || (cartItem && (cartItem.name_ar || cartItem.title || cartItem.name)),
                price: params.price != null ? params.price : (cartItem && cartItem.price != null ? cartItem.price : params.value),
                quantity,
                item_brand: params.item_brand || (cartItem && cartItem.brand),
                item_category: params.item_category || (cartItem && cartItem.category),
            }, index);
        }).filter(Boolean);
    }

    function normalizeEvent(name, params) {
        const source = params && typeof params === 'object' ? params : {};
        if (name === 'search') {
            // A search can contain a VIN, phone number, or another identifier.
            return { search_term: 'catalog_search' };
        }
        if (name === 'generate_lead' || name === 'whatsapp_click' || name === 'phone_click') {
            const requested = cleanText(source.contact_method || source.content_name, 20).toLowerCase();
            const method = name === 'phone_click' || requested === 'phone'
                ? 'phone'
                : (requested === 'form' || requested === 'contact_form' ? 'form' : 'whatsapp');
            return { contact_method: method };
        }
        if (!COMMERCE_EVENTS.has(name)) return null;

        const items = legacyItems(name, source);
        if (!items.length) return null;
        const calculatedValue = items.reduce((sum, item) => sum + finiteNumber(item.price, 0) * positiveQuantity(item.quantity, 1), 0);
        const payload = {
            currency: 'SAR',
            value: Math.round(calculatedValue * 100) / 100,
            items,
        };
        if (name === 'purchase') {
            const transactionId = cleanText(source.transaction_id, 128);
            if (!transactionId) return null;
            payload.transaction_id = transactionId;
            if (source.shipping != null) payload.shipping = finiteNumber(source.shipping, 0);
            if (source.tax != null) payload.tax = finiteNumber(source.tax, 0);
            if (source.coupon) payload.coupon = cleanText(source.coupon, 80);
        }
        if (name === 'add_shipping_info') {
            const tier = cleanText(source.shipping_tier, 40).toLowerCase();
            payload.shipping_tier = tier === 'to_be_confirmed' || tier === 'inquiry' ? tier : 'to_be_confirmed';
        }
        if (name === 'add_payment_info') {
            const method = cleanText(source.payment_type, 20).toLowerCase();
            payload.payment_type = ['zid', 'salla', 'external_checkout'].includes(method) ? method : 'external_checkout';
        }
        return payload;
    }

    function metaEventName(name) {
        return ({
            view_item: 'ViewContent',
            select_item: 'ViewContent',
            add_to_cart: 'AddToCart',
            remove_from_cart: 'RemoveFromCart',
            begin_checkout: 'InitiateCheckout',
            add_shipping_info: 'AddToCart',
            add_payment_info: 'AddPaymentInfo',
            purchase: 'Purchase',
            search: 'Search',
            generate_lead: 'Lead',
            whatsapp_click: 'Lead',
            phone_click: 'Lead',
        })[name] || name;
    }

    function metaPayload(name, payload) {
        if (!COMMERCE_EVENTS.has(name)) {
            return ['generate_lead', 'whatsapp_click', 'phone_click'].includes(name)
                ? { content_category: payload.contact_method }
                : {};
        }
        const result = {
            currency: 'SAR',
            value: payload.value,
            content_type: 'product',
            content_ids: payload.items.map((item) => item.item_id),
            contents: payload.items.map((item) => ({
                id: item.item_id,
                quantity: item.quantity,
                item_price: item.price,
            })),
            num_items: payload.items.reduce((sum, item) => sum + item.quantity, 0),
        };
        if (payload.transaction_id) result.order_id = payload.transaction_id;
        return result;
    }

    function dispatchGtm(name, payload) {
        const layer = ensureDataLayer();
        if (COMMERCE_EVENTS.has(name)) {
            layer.push({ ecommerce: null });
            layer.push({ event: name, ecommerce: payload });
        } else {
            layer.push(Object.assign({ event: name }, payload));
        }
    }

    function dispatch(name, params) {
        const payload = normalizeEvent(name, params);
        if (!payload) return false;

        try {
            if (publicConfig.gtmId) {
                dispatchGtm(name, payload);
            } else if (typeof window.gtag === 'function') {
                window.gtag('event', name, payload);
                if (name === 'purchase' && publicConfig.googleAdsId && publicConfig.googleAdsPurchaseLabel) {
                    window.gtag('event', 'conversion', {
                        send_to: publicConfig.googleAdsId + '/' + publicConfig.googleAdsPurchaseLabel,
                        value: payload.value,
                        currency: 'SAR',
                        transaction_id: payload.transaction_id,
                    });
                }
            }
        } catch (_err) {}

        try {
            if (typeof window.fbq === 'function') {
                window.fbq('track', metaEventName(name), metaPayload(name, payload));
            }
        } catch (_err) {}
        return true;
    }

    function purchaseHash(transactionId) {
        const input = 'qetaa-purchase:' + String(transactionId);
        let hash = 2166136261;
        for (let index = 0; index < input.length; index += 1) {
            hash ^= input.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(36);
    }

    function purchaseHistory() {
        try {
            const history = JSON.parse(safeStorageGet(PURCHASE_DEDUPE_KEY) || '[]');
            return Array.isArray(history) ? history.filter((entry) => entry && entry.hash).slice(-50) : [];
        } catch (_err) {
            return [];
        }
    }

    function wasPurchaseTracked(hash) {
        return purchaseHistory().some((entry) => entry.hash === hash);
    }

    function rememberPurchase(hash) {
        const cutoff = Date.now() - (180 * 24 * 60 * 60 * 1000);
        const history = purchaseHistory().filter((entry) => Number(entry.at) >= cutoff && entry.hash !== hash);
        history.push({ hash, at: Date.now() });
        safeStorageSet(PURCHASE_DEDUPE_KEY, JSON.stringify(history.slice(-50)));
    }

    function enqueue(name, params, options) {
        const entry = { name, params, trustedPurchase: Boolean(options && options.trustedPurchase) };
        if (entry.trustedPurchase) entry.purchaseHash = options.purchaseHash;
        if (eventQueue.length >= MAX_QUEUE_SIZE) eventQueue.shift();
        eventQueue.push(entry);
    }

    function sendEntry(entry) {
        if (entry.name === 'purchase') {
            if (!entry.trustedPurchase || !entry.purchaseHash || wasPurchaseTracked(entry.purchaseHash)) return false;
            const sent = dispatch(entry.name, entry.params);
            if (sent) rememberPurchase(entry.purchaseHash);
            pendingPurchaseHashes.delete(entry.purchaseHash);
            return sent;
        }
        return dispatch(entry.name, entry.params);
    }

    function flushQueue() {
        const queued = eventQueue.splice(0, eventQueue.length);
        const legacy = window._adsQueue.splice(0, window._adsQueue.length);
        legacy.forEach((entry) => {
            if (Array.isArray(entry) && entry[0] !== 'purchase' && ALLOWED_PUBLIC_EVENTS.has(entry[0])) {
                queued.push({ name: entry[0], params: entry[1], trustedPurchase: false });
            }
        });
        queued.forEach(sendEntry);
    }

    function activate() {
        if (activated || consentState !== 'granted' || !configLoaded || !hasTrackingConfig()) return;
        activated = true;
        if (publicConfig.gtmId) loadGoogleTagManager(publicConfig.gtmId);
        else loadDirectGoogle(publicConfig.ga4Id, publicConfig.googleAdsId);
        loadMeta(publicConfig.metaPixelId);
        window._adsReady = true;
        flushQueue();
    }

    window.trackAdsEvent = function (name, params) {
        const eventName = cleanText(name, 40);
        // A browser-side purchase call is never sufficient proof of payment.
        if (!ALLOWED_PUBLIC_EVENTS.has(eventName)) return false;
        if (consentState === 'denied') return false;
        if (!configLoaded) {
            enqueue(eventName, params || {}, {});
            return true;
        }
        if (!hasTrackingConfig()) return false;
        if (!activated) {
            enqueue(eventName, params || {}, {});
            return true;
        }
        return dispatch(eventName, params || {});
    };

    function confirmationPayload(raw) {
        const outer = raw && raw.data && typeof raw.data === 'object' ? raw.data : raw;
        const confirmation = outer && outer.tracking_confirmation && typeof outer.tracking_confirmation === 'object'
            ? outer.tracking_confirmation
            : outer;
        if (!confirmation || confirmation.tracking_confirmed !== true) return null;
        const status = cleanText(confirmation.payment_status || confirmation.status, 30).toLowerCase();
        if (!PURCHASE_STATUSES.has(status)) return null;
        const transactionId = cleanText(confirmation.transaction_id || confirmation.order_id, 128);
        if (!transactionId || !Array.isArray(confirmation.items) || !confirmation.items.length) return null;
        return {
            transaction_id: transactionId,
            currency: 'SAR',
            value: confirmation.value,
            shipping: confirmation.shipping,
            tax: confirmation.tax,
            coupon: confirmation.coupon,
            items: confirmation.items,
        };
    }

    window.confirmAdsPurchase = async function (confirmationUrl) {
        if (consentState === 'denied') return false;
        if (!configLoaded) await configReady;
        if (!hasTrackingConfig()) return false;
        let url;
        try {
            url = new URL(String(confirmationUrl || ''), window.location.origin);
        } catch (_err) {
            return false;
        }
        if (url.origin !== window.location.origin || !url.pathname.startsWith('/api/') || url.username || url.password) return false;

        try {
            const response = await fetch(url.href, {
                method: 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                headers: { Accept: 'application/json' },
            });
            if (!response.ok) return false;
            const params = confirmationPayload(await response.json());
            if (!params) return false;
            const hash = purchaseHash(params.transaction_id);
            if (wasPurchaseTracked(hash) || pendingPurchaseHashes.has(hash)) return false;
            pendingPurchaseHashes.add(hash);
            const entry = { name: 'purchase', params, trustedPurchase: true, purchaseHash: hash };
            if (!activated) {
                enqueue(entry.name, entry.params, entry);
                return true;
            }
            return sendEntry(entry);
        } catch (_err) {
            return false;
        }
    };

    function removeConsentBanner() {
        const banner = document.getElementById('qetaa-cookie-banner');
        if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    }

    function ensureConsentStyle() {
        if (document.getElementById('qetaa-cookie-style')) return;
        const style = document.createElement('style');
        style.id = 'qetaa-cookie-style';
        style.textContent = [
            '#qetaa-cookie-banner{position:fixed;z-index:2147483000;left:16px;right:16px;bottom:16px;max-width:720px;margin:auto;background:#fff;color:#17212b;border:1px solid #d9e1e8;border-radius:18px;box-shadow:0 18px 55px rgba(0,0,0,.2);padding:18px;font-family:inherit;direction:rtl}',
            '#qetaa-cookie-banner p{margin:0 0 14px;line-height:1.75;font-size:14px}',
            '#qetaa-cookie-banner a{color:#146c5a;text-decoration:underline}',
            '#qetaa-cookie-banner .qetaa-cookie-actions{display:flex;gap:10px;flex-wrap:wrap}',
            '#qetaa-cookie-banner button{border:1px solid #146c5a;border-radius:12px;padding:10px 18px;font:inherit;font-weight:700;cursor:pointer}',
            '#qetaa-cookie-accept{background:#146c5a;color:#fff}',
            '#qetaa-cookie-reject{background:#fff;color:#146c5a}',
            '#qetaa-cookie-settings{position:fixed;z-index:2147482999;left:12px;bottom:12px;border:1px solid #cbd5df;border-radius:999px;background:#fff;color:#314154;padding:7px 11px;font:600 12px/1.2 inherit;box-shadow:0 6px 20px rgba(0,0,0,.1);cursor:pointer}',
            '@media(max-width:520px){#qetaa-cookie-banner{left:10px;right:10px;bottom:10px;padding:15px}#qetaa-cookie-banner button{flex:1}}',
        ].join('');
        document.head.appendChild(style);
    }

    function showConsentBanner(force) {
        if (!hasTrackingConfig() || (!force && consentState !== 'pending')) return;
        const render = function () {
            removeConsentBanner();
            ensureConsentStyle();
            const banner = document.createElement('section');
            banner.id = 'qetaa-cookie-banner';
            banner.setAttribute('role', 'region');
            banner.setAttribute('aria-label', 'إعدادات ملفات الارتباط');
            banner.innerHTML = '<p>نستخدم ملفات قياس اختيارية لمعرفة أداء المتجر والإعلانات. لن نحمّل أدوات Google أو Meta قبل موافقتك. يمكنك القراءة في <a href="privacy.html">سياسة الخصوصية</a>.</p><div class="qetaa-cookie-actions"><button type="button" id="qetaa-cookie-accept">موافقة</button><button type="button" id="qetaa-cookie-reject">رفض</button></div>';
            document.body.appendChild(banner);
            banner.querySelector('#qetaa-cookie-accept').addEventListener('click', function () { setConsent(true); });
            banner.querySelector('#qetaa-cookie-reject').addEventListener('click', function () { setConsent(false); });
        };
        if (document.body) render();
        else document.addEventListener('DOMContentLoaded', render, { once: true });
    }

    function ensureSettingsButton() {
        if (!hasTrackingConfig()) return;
        const render = function () {
            if (document.getElementById('qetaa-cookie-settings')) return;
            ensureConsentStyle();
            const button = document.createElement('button');
            button.type = 'button';
            button.id = 'qetaa-cookie-settings';
            button.textContent = 'الخصوصية';
            button.setAttribute('aria-label', 'تعديل إعدادات ملفات الارتباط');
            button.addEventListener('click', function () { showConsentBanner(true); });
            document.body.appendChild(button);
        };
        if (document.body) render();
        else document.addEventListener('DOMContentLoaded', render, { once: true });
    }

    function setConsent(granted) {
        const previous = consentState;
        consentState = granted ? 'granted' : 'denied';
        saveConsent(consentState);
        removeConsentBanner();
        if (!granted) {
            eventQueue.splice(0, eventQueue.length);
            window._adsQueue.splice(0, window._adsQueue.length);
            pendingPurchaseHashes.clear();
            window._adsReady = false;
            try {
                if (typeof window.gtag === 'function') {
                    window.gtag('consent', 'update', {
                        analytics_storage: 'denied',
                        ad_storage: 'denied',
                        ad_user_data: 'denied',
                        ad_personalization: 'denied',
                    });
                }
                if (typeof window.fbq === 'function') window.fbq('consent', 'revoke');
            } catch (_err) {}
            if (previous === 'granted' && activated && window.location && typeof window.location.reload === 'function') {
                window.location.reload();
            }
            return;
        }
        activate();
    }

    window.setAdsConsent = setConsent;
    window.showAdsConsentSettings = function () { showConsentBanner(true); };

    function bindContactClicks() {
        document.addEventListener('click', function (event) {
            const target = event.target && typeof event.target.closest === 'function'
                ? event.target.closest('a[href]')
                : null;
            if (!target) return;
            const rawHref = String(target.getAttribute('href') || '').trim();
            let method = '';
            if (/^tel:/i.test(rawHref)) {
                method = 'phone';
            } else {
                try {
                    const url = new URL(rawHref, window.location.href);
                    if (/^(wa\.me|api\.whatsapp\.com|web\.whatsapp\.com)$/i.test(url.hostname)) method = 'whatsapp';
                } catch (_err) {}
            }
            if (method) {
                window.trackAdsEvent(method === 'phone' ? 'phone_click' : 'whatsapp_click', { contact_method: method });
                window.trackAdsEvent('generate_lead', { contact_method: method });
            }
        }, true);
    }

    window.addEventListener('qetaa:purchase-confirmation', function (event) {
        const detail = event && event.detail && typeof event.detail === 'object' ? event.detail : {};
        if (detail.confirmationUrl) window.confirmAdsPurchase(detail.confirmationUrl);
    });

    bindContactClicks();

    const apiBase = (window.location && /^https?:$/i.test(window.location.protocol))
        ? window.location.origin + '/api'
        : '/api';

    fetch(apiBase + '/storefront/ads-config', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
    })
        .then((response) => (response.ok ? response.json() : {}))
        .then((payload) => {
            publicConfig = validConfig(Object.assign({}, window.ADS_CONFIG || {}, payload.data || payload));
            window.ADS_CONFIG = publicConfig;
            configLoaded = true;
            resolveConfigReady();
            if (!hasTrackingConfig()) {
                eventQueue.splice(0, eventQueue.length);
                window._adsQueue.splice(0, window._adsQueue.length);
                return;
            }
            ensureSettingsButton();
            if (consentState === 'granted') activate();
            else if (consentState === 'pending') showConsentBanner(false);
        })
        .catch(() => {
            publicConfig = validConfig(window.ADS_CONFIG || {});
            window.ADS_CONFIG = publicConfig;
            configLoaded = true;
            resolveConfigReady();
            if (!hasTrackingConfig()) return;
            ensureSettingsButton();
            if (consentState === 'granted') activate();
            else if (consentState === 'pending') showConsentBanner(false);
        });
})();
