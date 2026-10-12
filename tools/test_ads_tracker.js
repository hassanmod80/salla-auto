'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'ads-tracker.js'), 'utf8');

class FakeNode {
    constructor(tagName, registry, scripts) {
        this.tagName = String(tagName || '').toUpperCase();
        this.registry = registry;
        this.scripts = scripts;
        this.children = [];
        this.listeners = {};
        this.attributes = {};
        this.parentNode = null;
        this.style = {};
        this.innerHTML = '';
        this.textContent = '';
        this.value = '';
    }

    set id(value) {
        this._id = value;
        if (value) this.registry.set(value, this);
    }

    get id() {
        return this._id || '';
    }

    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        if (child.tagName === 'SCRIPT') this.scripts.push(child.src || '');
        return child;
    }

    removeChild(child) {
        this.children = this.children.filter((entry) => entry !== child);
        if (child.id) this.registry.delete(child.id);
        child.parentNode = null;
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    getAttribute(name) {
        return this.attributes[name] || '';
    }

    addEventListener(name, callback) {
        this.listeners[name] = callback;
    }

    querySelector(selector) {
        if (!this._queryNodes) this._queryNodes = new Map();
        if (!this._queryNodes.has(selector)) this._queryNodes.set(selector, new FakeNode('button', this.registry, this.scripts));
        return this._queryNodes.get(selector);
    }
}

function response(data, ok = true) {
    return {
        ok,
        async json() { return data; },
    };
}

async function settle() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
}

async function buildEnvironment() {
    const registry = new Map();
    const scripts = [];
    const documentListeners = {};
    const windowListeners = {};
    const storage = new Map();
    const fetchCalls = [];

    storage.set('qetaa_cart', JSON.stringify([
        { id: 'SKU-1', title: 'فلتر زيت', price: 25, quantity: 2 },
        { id: 'SKU-2', title: 'فلتر هواء', price: 40, quantity: 1 },
    ]));

    const document = {
        head: new FakeNode('head', registry, scripts),
        body: new FakeNode('body', registry, scripts),
        createElement(tagName) { return new FakeNode(tagName, registry, scripts); },
        getElementById(id) { return registry.get(id) || null; },
        addEventListener(name, callback) { documentListeners[name] = callback; },
    };
    const quantityInput = new FakeNode('input', registry, scripts);
    quantityInput.id = 'p-qty';
    quantityInput.value = '3';

    const location = {
        origin: 'http://store.test',
        protocol: 'http:',
        href: 'http://store.test/product.html?id=SKU-1',
        reloadCalled: false,
        reload() { this.reloadCalled = true; },
    };

    const context = {
        console,
        document,
        location,
        navigator: { globalPrivacyControl: false },
        localStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(key, String(value)); },
        },
        addEventListener(name, callback) { windowListeners[name] = callback; },
        fetch: async (url) => {
            const href = String(url);
            fetchCalls.push(href);
            if (href.endsWith('/api/storefront/ads-config')) {
                return response({ data: { gtmId: 'GTM-TEST123', currency: 'SAR' } });
            }
            if (href === 'http://store.test/api/orders/42/tracking-confirmation') {
                return response({
                    data: {
                        tracking_confirmation: {
                            tracking_confirmed: true,
                            payment_status: 'paid',
                            transaction_id: 'ORDER-42',
                            items: [
                                { item_id: 'SKU-1', item_name: 'فلتر زيت', price: 25, quantity: 2 },
                                { item_id: 'SKU-2', item_name: 'فلتر هواء', price: 40, quantity: 1 },
                            ],
                        },
                    },
                });
            }
            return response({}, false);
        },
        URL,
        Date,
        Math,
        JSON,
        Promise,
        Set,
        Map,
        RegExp,
        String,
        Number,
        Boolean,
        Array,
        Object,
        encodeURIComponent,
        setImmediate,
        clearImmediate,
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(SOURCE, context, { filename: 'ads-tracker.js' });
    await settle();
    return { context, scripts, storage, fetchCalls, documentListeners, windowListeners };
}

(async () => {
    const env = await buildEnvironment();
    const { context, scripts, storage, fetchCalls, documentListeners } = env;

    assert.strictEqual(scripts.length, 0, 'third-party scripts must not load before consent');
    assert.strictEqual(context._adsReady, false, 'tracker must remain inactive before consent');

    assert.strictEqual(context.trackAdsEvent('add_to_cart', {
        content_ids: ['SKU-1'],
        content_name: 'فلتر زيت',
        value: 25,
        currency: 'SAR',
    }), true);
    assert.strictEqual(scripts.length, 0, 'queued commerce events must not load a tag');

    context.setAdsConsent(true);
    assert.strictEqual(scripts.length, 1, 'consent should load exactly the configured route');
    assert.ok(scripts[0].startsWith('https://www.googletagmanager.com/gtm.js?id=GTM-TEST123'));
    assert.strictEqual(context._adsReady, true);

    const addEvent = context.dataLayer.find((entry) => entry && entry.event === 'add_to_cart');
    assert.ok(addEvent, 'add_to_cart should reach the data layer after consent');
    assert.strictEqual(addEvent.ecommerce.currency, 'SAR');
    assert.strictEqual(addEvent.ecommerce.items[0].quantity, 3);
    assert.strictEqual(addEvent.ecommerce.value, 75);

    context.trackAdsEvent('select_item', {
        item_id: 'SKU-1',
        item_name: 'فلتر زيت',
        price: 25,
        quantity: 1,
    });
    const selectEvent = context.dataLayer.find((entry) => entry && entry.event === 'select_item');
    assert.ok(selectEvent, 'select_item should reach the data layer');
    assert.strictEqual(selectEvent.ecommerce.currency, 'SAR');
    assert.strictEqual(selectEvent.ecommerce.items[0].item_id, 'SKU-1');

    context.trackAdsEvent('remove_from_cart', {
        item_id: 'SKU-2',
        item_name: 'فلتر هواء',
        price: 40,
        quantity: 1,
    });
    const removeEvent = context.dataLayer.find((entry) => entry && entry.event === 'remove_from_cart');
    assert.ok(removeEvent, 'remove_from_cart should reach the data layer');
    assert.strictEqual(removeEvent.ecommerce.value, 40);

    context.trackAdsEvent('add_shipping_info', { shipping_tier: 'to_be_confirmed', currency: 'SAR' });
    const shippingEvent = context.dataLayer.find((entry) => entry && entry.event === 'add_shipping_info');
    assert.strictEqual(shippingEvent.ecommerce.shipping_tier, 'to_be_confirmed');
    assert.strictEqual(shippingEvent.ecommerce.currency, 'SAR');

    context.trackAdsEvent('add_payment_info', { payment_type: 'salla', currency: 'SAR' });
    const paymentEvent = context.dataLayer.find((entry) => entry && entry.event === 'add_payment_info');
    assert.strictEqual(paymentEvent.ecommerce.payment_type, 'salla');

    context.trackAdsEvent('begin_checkout', { currency: 'SAR' });
    const checkoutEvent = context.dataLayer.find((entry) => entry && entry.event === 'begin_checkout');
    assert.deepStrictEqual(
        Array.from(checkoutEvent.ecommerce.items, (item) => item.quantity),
        [2, 1],
        'begin_checkout should preserve per-item quantities'
    );
    assert.strictEqual(checkoutEvent.ecommerce.value, 90);

    const directPurchase = context.trackAdsEvent('purchase', {
        transaction_id: 'UNTRUSTED',
        items: [{ item_id: 'SKU-1', price: 25, quantity: 1 }],
    });
    assert.strictEqual(directPurchase, false, 'client-side purchase calls must be rejected');
    assert.strictEqual(context.dataLayer.filter((entry) => entry && entry.event === 'purchase').length, 0);

    assert.strictEqual(await context.confirmAdsPurchase('https://evil.example/api/order/42'), false);
    assert.ok(!fetchCalls.some((url) => url.startsWith('https://evil.example')), 'cross-origin confirmation must not be fetched');

    assert.strictEqual(await context.confirmAdsPurchase('/api/orders/42/tracking-confirmation'), true);
    assert.strictEqual(await context.confirmAdsPurchase('/api/orders/42/tracking-confirmation'), false);
    const purchaseEvents = context.dataLayer.filter((entry) => entry && entry.event === 'purchase');
    assert.strictEqual(purchaseEvents.length, 1, 'the same transaction must be tracked once');
    assert.strictEqual(purchaseEvents[0].ecommerce.value, 90);
    assert.strictEqual(purchaseEvents[0].ecommerce.currency, 'SAR');
    assert.ok(!storage.get('qetaa_ads_purchase_dedupe_v1').includes('ORDER-42'), 'dedupe storage must not retain the raw order reference');

    context.trackAdsEvent('search', { search_term: 'LDC12345678901234' });
    const searchEvent = context.dataLayer.find((entry) => entry && entry.event === 'search');
    assert.strictEqual(searchEvent.search_term, 'catalog_search');

    const whatsappLink = {
        getAttribute() { return 'https://wa.me/966500000000?text=hello'; },
    };
    documentListeners.click({
        target: { closest() { return whatsappLink; } },
    });
    const leadEvent = context.dataLayer.find((entry) => entry && entry.event === 'generate_lead');
    const whatsappEvent = context.dataLayer.find((entry) => entry && entry.event === 'whatsapp_click');
    assert.deepStrictEqual(
        { event: leadEvent.event, contact_method: leadEvent.contact_method },
        { event: 'generate_lead', contact_method: 'whatsapp' }
    );
    assert.deepStrictEqual(
        { event: whatsappEvent.event, contact_method: whatsappEvent.contact_method },
        { event: 'whatsapp_click', contact_method: 'whatsapp' }
    );
    assert.ok(!JSON.stringify(leadEvent).includes('966500000000'), 'contact events must not contain the destination number');
    assert.ok(!JSON.stringify(whatsappEvent).includes('966500000000'), 'whatsapp_click must not contain the destination number');

    console.log('ads tracker tests: PASS');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
