const API_BASE = (() => {
    if (typeof window.API_BASE === 'string' && window.API_BASE.trim()) {
        return window.API_BASE.trim().replace(/\/$/, '');
    }
    if (typeof location !== 'undefined' && /^https?:$/i.test(location.protocol)) {
        return `${location.origin}/api`;
    }
    return '/api';
})();

const WHATSAPP_NUMBER = '966563156460';
const STORE_URL = typeof location !== 'undefined' ? location.origin : 'https://qetaa-store-production.up.railway.app';

let adminToken = sessionStorage.getItem('qetaa_admin_token') || '';
let currentTab = 'orders';
let productSearchTimer = null;
let privateImageObjectUrls = [];

document.addEventListener('DOMContentLoaded', () => {
    if (!adminToken) {
        renderLogin();
        return;
    }
    renderApp();
    switchTab('orders');
});

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function toast(message) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2800);
}

async function fetchJson(path, options = {}) {
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.skipAuth ? {} : { Authorization: `Bearer ${adminToken}` }),
        ...(options.headers || {}),
    };
    delete options.skipAuth;

    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        if (response.status === 401 && adminToken) {
            sessionStorage.removeItem('qetaa_admin_token');
            adminToken = '';
            renderLogin();
        }
        throw new Error(data.message || 'تعذر تنفيذ العملية.');
    }
    return data;
}

async function fetchPrivateImage(url) {
    if (!url || !adminToken) return '';
    try {
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${adminToken}` },
            cache: 'no-store',
        });
        if (!response.ok) return '';
        const objectUrl = URL.createObjectURL(await response.blob());
        privateImageObjectUrls.push(objectUrl);
        return objectUrl;
    } catch (_error) {
        return '';
    }
}

function renderLogin() {
    document.getElementById('app').innerHTML = `
        <main class="auth-screen">
            <form class="auth-card" onsubmit="adminLogin(event)">
                <div class="admin-brand">
                    <i class="fa-solid fa-car-side"></i>
                    <span>CHINA PARTS</span>
                </div>
                <h1>دخول لوحة الإدارة</h1>
                <p>الطلبات، المنتجات، الرسائل، والماركات في مكان واحد.</p>
                <div class="field">
                    <label>البريد الإلكتروني</label>
                    <input name="email" type="email" autocomplete="username" required>
                </div>
                <div class="field">
                    <label>كلمة المرور</label>
                    <input name="password" type="password" autocomplete="current-password" required>
                </div>
                <button class="btn" type="submit">
                    <i class="fa-solid fa-right-to-bracket"></i>
                    دخول
                </button>
            </form>
        </main>
    `;
}

async function adminLogin(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(new FormData(form).entries());
    try {
        const data = await fetchJson('/admin/auth/login', {
            method: 'POST',
            body: JSON.stringify(payload),
            skipAuth: true,
        });
        adminToken = data.token;
        sessionStorage.setItem('qetaa_admin_token', adminToken);
        renderApp();
        switchTab('orders');
    } catch (error) {
        toast(error.message);
    }
}

async function adminLogout() {
    try {
        await fetchJson('/admin/auth/logout', { method: 'POST' });
    } catch (error) {
        if (adminToken) {
            toast(error.message);
            return;
        }
    }
    sessionStorage.removeItem('qetaa_admin_token');
    adminToken = '';
    renderLogin();
}

function renderApp() {
    document.getElementById('app').innerHTML = `
        <div class="admin-shell">
            <aside class="admin-side">
                <div class="admin-brand">
                    <i class="fa-solid fa-car-side"></i>
                    <span>قطع الجنوب</span>
                </div>
                <nav class="admin-nav">
                    <button id="nav-orders" type="button" onclick="switchTab('orders')">
                        <i class="fa-solid fa-receipt"></i> الطلبات
                    </button>
                    <button id="nav-products" type="button" onclick="switchTab('products')">
                        <i class="fa-solid fa-box-open"></i> المنتجات
                    </button>
                    <button id="nav-messages" type="button" onclick="switchTab('messages')">
                        <i class="fa-solid fa-envelope"></i> رسائل التواصل
                    </button>
                    <button id="nav-brands" type="button" onclick="switchTab('brands')">
                        <i class="fa-solid fa-tags"></i> الماركات
                    </button>
                    <button id="nav-salla" type="button" onclick="switchTab('salla')">
                        <i class="fa-solid fa-link"></i> تكامل سلة
                    </button>
                    <button id="nav-settings" type="button" onclick="switchTab('settings')">
                        <i class="fa-solid fa-gear"></i> الإعدادات
                    </button>
                    <button id="nav-home" type="button" onclick="switchTab('home')">
                        <i class="fa-solid fa-chart-simple"></i> الملخص
                    </button>
                </nav>
                <div class="admin-side-footer">
                    <a class="btn btn-ghost" href="index.html" target="_blank" rel="noopener">
                        <i class="fa-solid fa-store"></i> فتح الموقع
                    </a>
                    <button class="btn btn-ghost" type="button" onclick="adminLogout()">
                        <i class="fa-solid fa-right-from-bracket"></i> خروج
                    </button>
                </div>
            </aside>

            <main class="admin-main">
                <section id="tab-orders" class="section">
                    <div class="admin-head">
                        <div>
                            <h1>الطلبات</h1>
                            <p>طلبات العملاء مع صورة الرخصة أو رقم الهيكل.</p>
                        </div>
                        <button class="btn" type="button" onclick="loadOrders()">
                            <i class="fa-solid fa-rotate"></i> تحديث
                        </button>
                    </div>
                    <div class="panel">
                        <div class="panel-head">
                            <h2>أحدث الطلبات</h2>
                            <span id="orders-count" class="badge">0</span>
                        </div>
                        <div id="orders-list" class="orders-list">
                            <div class="empty">جاري التحميل...</div>
                        </div>
                    </div>
                </section>

                <section id="tab-products" class="section">
                    <div class="admin-head">
                        <div>
                            <h1>المنتجات</h1>
                            <p>ابحث بالاسم أو رقم OEM وتأكد من الصور والأسعار.</p>
                        </div>
                        <button class="btn" type="button" onclick="loadProducts()">
                            <i class="fa-solid fa-rotate"></i> تحديث
                        </button>
                    </div>
                    <div class="toolbar">
                        <input id="product-search" class="search-input" type="search" placeholder="ابحث باسم القطعة أو OEM..." oninput="onProductSearch()">
                    </div>
                    <div class="panel">
                        <div class="panel-head">
                            <h2>قائمة المنتجات</h2>
                            <span id="products-count" class="badge">0</span>
                        </div>
                        <div id="products-list" class="products-list">
                            <div class="empty">جاري التحميل...</div>
                        </div>
                    </div>
                </section>

                <section id="tab-messages" class="section">
                    <div class="admin-head">
                        <div>
                            <h1>رسائل التواصل</h1>
                            <p>الرسائل القادمة من صفحة تواصل معنا.</p>
                        </div>
                        <button class="btn" type="button" onclick="loadMessages()">
                            <i class="fa-solid fa-rotate"></i> تحديث
                        </button>
                    </div>
                    <div class="panel">
                        <div class="panel-head">
                            <h2>الرسائل</h2>
                            <span id="messages-count" class="badge">0</span>
                        </div>
                        <div id="messages-list" class="msg-list">
                            <div class="empty">جاري التحميل...</div>
                        </div>
                    </div>
                </section>

                <section id="tab-brands" class="section">
                    <div class="admin-head">
                        <div>
                            <h1>الماركات</h1>
                            <p>الماركات الظاهرة في الموقع.</p>
                        </div>
                        <button class="btn" type="button" onclick="loadBrands()">
                            <i class="fa-solid fa-rotate"></i> تحديث
                        </button>
                    </div>
                    <div class="panel">
                        <div id="brands-list" class="brands-wrap">
                            <div class="empty">جاري التحميل...</div>
                        </div>
                    </div>
                </section>

                <section id="tab-salla" class="section">
                    <div class="panel">
                        <div class="panel-head">
                            <h2>تكامل سلة | Salla Integration</h2>
                            <span id="salla-state" class="badge">...</span>
                        </div>
                        <div id="salla-status" class="simple-box">جارٍ فحص الاتصال.</div>
                        <div class="toolbar">
                            <button class="btn" type="button" onclick="probeSalla()">فحص الاتصال</button>
                            <button class="btn" type="button" onclick="syncSalla()">إعادة المزامنة</button>
                            <a class="btn btn-ghost" href="/api/salla/oauth/start">إعادة ربط الحساب</a>
                        </div>
                    </div>
                </section>

                <section id="tab-settings" class="section">
                    <div class="admin-head">
                        <div>
                            <h1>الإعدادات السريعة</h1>
                            <p>المعلومات اللي تستخدمها يوميًا.</p>
                        </div>
                    </div>
                    <div class="settings-grid">
                        <div class="simple-box">
                            <strong>رابط الموقع</strong><br>
                            <a href="${STORE_URL}/" target="_blank" rel="noopener">${STORE_URL}/</a>
                        </div>
                        <div class="simple-box">
                            <strong>رقم واتساب المتجر</strong><br>
                            ${WHATSAPP_NUMBER}<br>
                            <a href="https://wa.me/${WHATSAPP_NUMBER}" target="_blank" rel="noopener">فتح واتساب</a>
                        </div>
                        <div class="simple-box">
                            <strong>لوحة الإدارة</strong><br>
                            <a href="${STORE_URL}/admin-dashboard.html" target="_blank" rel="noopener">${STORE_URL}/admin-dashboard.html</a>
                        </div>
                        <div class="simple-box">
                            <strong>بيانات الدخول</strong><br>
                            الإيميل: admin@qetaa-aljanoob.sa<br>
                            كلمة السر الحالية: 12345678
                        </div>
                    </div>
                    <div class="simple-box">
                        <strong>شو تستخدم من اللوحة؟</strong><br>
                        1) <strong>الطلبات</strong>: شوف الطلب + الصورة وتواصل مع العميل<br>
                        2) <strong>المنتجات</strong>: تأكد القطعة موجودة وصورة وسعرها<br>
                        3) <strong>رسائل التواصل</strong>: رد على استفسارات صفحة التواصل<br>
                        4) <strong>الماركات</strong>: تأكد شعارات الماركات ظاهرة
                    </div>
                </section>

                <section id="tab-home" class="section">
                    <div class="admin-head">
                        <div>
                            <h1>الملخص</h1>
                            <p>أرقام سريعة عن المتجر.</p>
                        </div>
                        <button class="btn" type="button" onclick="loadStats()">
                            <i class="fa-solid fa-rotate"></i> تحديث
                        </button>
                    </div>
                    <div class="stats">
                        <div class="stat"><div class="label">الطلبات</div><div class="value" id="stat-orders">-</div></div>
                        <div class="stat"><div class="label">المنتجات</div><div class="value" id="stat-products">-</div></div>
                        <div class="stat"><div class="label">المنشور</div><div class="value" id="stat-published">-</div></div>
                        <div class="stat"><div class="label">الرسائل</div><div class="value" id="stat-messages">-</div></div>
                    </div>
                    <div class="simple-box">
                        ابدأ من <strong>الطلبات</strong> — هذا أهم قسم يوميًا.
                    </div>
                </section>
            </main>
        </div>
    `;
}

function switchTab(tab) {
    currentTab = tab;
    ['orders', 'products', 'messages', 'brands', 'salla', 'settings', 'home'].forEach((name) => {
        document.getElementById(`tab-${name}`)?.classList.toggle('active', name === tab);
        document.getElementById(`nav-${name}`)?.classList.toggle('active', name === tab);
    });
    if (tab === 'orders') loadOrders();
    if (tab === 'products') loadProducts();
    if (tab === 'messages') loadMessages();
    if (tab === 'brands') loadBrands();
    if (tab === 'salla') loadSallaIntegration();
    if (tab === 'home') loadStats();
}

function renderSallaStatus(data) {
    const state = document.getElementById('salla-state');
    const box = document.getElementById('salla-status');
    if (!state || !box || !data) return;
    state.textContent = data.connected ? 'متصل' : 'غير متصل';
    state.className = data.connected ? 'badge ok' : 'badge';
    const last = data.last_sync || {};
    box.innerHTML = `
        <strong>المتجر:</strong> ${escapeHtml(data.store_domain || '-')} · رقم الإعداد: ${data.store_id_configured ? 'موجود' : 'غير موجود'}<br>
        <strong>آخر نجاح:</strong> ${escapeHtml(data.last_success_at || 'لا يوجد')}<br>
        <strong>انتهاء التفويض:</strong> ${escapeHtml(data.access_expires_at || 'غير متصل')}<br>
        <strong>منتجات منشورة:</strong> ${data.published_products} · <strong>مرتبطة:</strong> ${data.linked_products} · <strong>غير مرتبطة:</strong> ${data.unlinked_products}<br>
        <strong>تعارض سعر:</strong> ${data.price_conflicts} · <strong>مخزون نفد في الربط:</strong> ${data.out_of_stock_linked} · <strong>من سلة بلا مقابل:</strong> ${data.unmatched_remote_products}<br>
        <strong>آخر مزامنة:</strong> ${escapeHtml(last.status || 'لم تبدأ')} ${escapeHtml(last.finished_at || '')}<br>
        <strong>رابط العودة المطلوب في شركاء سلة:</strong> ${escapeHtml(data.redirect_uri || '')}<br>
        <strong>السبب:</strong> ${escapeHtml(data.reason || data.last_error || 'لا يوجد')}
    `;
}

async function loadSallaIntegration() {
    try {
        const res = await fetchJson('/admin/salla/status');
        renderSallaStatus(res.data);
    } catch (error) {
        toast(error.message || 'تعذر قراءة حالة سلة');
    }
}

async function probeSalla() {
    try {
        const res = await fetchJson('/admin/salla/probe', { method: 'POST', body: '{}' });
        toast(res.data && res.data.ok ? 'الاتصال ناجح' : 'الاتصال غير مكتمل');
    } catch (error) {
        toast(error.message || 'تعذر فحص سلة');
    }
    loadSallaIntegration();
}

async function syncSalla() {
    try {
        const res = await fetchJson('/admin/salla/sync', { method: 'POST', body: '{}' });
        toast(res.started ? 'بدأت المزامنة' : 'تعذر بدء المزامنة');
    } catch (error) {
        toast(error.message || 'تعذر بدء المزامنة');
    }
    setTimeout(loadSallaIntegration, 1500);
}

function formatDate(value) {
    if (!value) return '';
    try {
        return new Date(value).toLocaleString('ar-SA');
    } catch (_) {
        return String(value);
    }
}

function formatItems(items) {
    if (!Array.isArray(items)) return 'لا توجد قطع';
    const real = items.filter((item) => item && !item._meta);
    if (!real.length) return 'لا توجد قطع';
    return real.map((item) => {
        const title = item.title || item.name || item.name_ar || 'قطعة';
        const qty = Number(item.quantity || 1);
        const oem = item.oem_number ? ` (OEM: ${item.oem_number})` : '';
        return `• ${escapeHtml(title)} ×${qty}${escapeHtml(oem)}`;
    }).join('<br>');
}

function waLinkFromPhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    const normalized = digits.startsWith('966') ? digits : (`966${digits.replace(/^0/, '')}`);
    return `<a class="btn btn-ghost" style="padding:8px 12px;font-size:0.82rem" href="https://wa.me/${normalized}" target="_blank" rel="noopener"><i class="fa-brands fa-whatsapp"></i> واتساب</a>`;
}

function productImage(product) {
    const img = product.image_url
        || product.primary_image_url
        || product.thumbnail_url
        || (Array.isArray(product.images) && product.images[0] && (product.images[0].url || product.images[0].image_url))
        || '';
    if (!img) return '<div class="product-thumb-empty">بدون<br>صورة</div>';
    return `<img class="product-thumb" src="${escapeHtml(img)}" alt="">`;
}

async function loadOrders() {
    const list = document.getElementById('orders-list');
    const countEl = document.getElementById('orders-count');
    if (!list) return;
    list.innerHTML = '<div class="empty">جاري التحميل...</div>';
    try {
        const data = await fetchJson('/admin/orders?per_page=100');
        const orders = data.data || [];
        if (countEl) countEl.textContent = String(orders.length);
        if (!orders.length) {
            list.innerHTML = '<div class="empty">ما فيه طلبات بعد.</div>';
            return;
        }
        privateImageObjectUrls.forEach((url) => URL.revokeObjectURL(url));
        privateImageObjectUrls = [];
        const protectedUrls = [...new Set(orders.flatMap((order) => [
            order.car_photo_url,
            order.istimara_photo_url,
            order.vin_photo_url,
        ]).filter(Boolean))];
        const resolvedPhotos = new Map(await Promise.all(
            protectedUrls.map(async (url) => [url, await fetchPrivateImage(url)])
        ));
        list.innerHTML = orders.map((order) => {
            const carPhoto = resolvedPhotos.get(order.car_photo_url) || '';
            const istimaraPhoto = resolvedPhotos.get(order.istimara_photo_url) || '';
            const legacyPhoto = resolvedPhotos.get(order.vin_photo_url) || '';
            const photos = [];
            if (carPhoto) photos.push({ url: carPhoto, label: 'السيارة' });
            if (istimaraPhoto) photos.push({ url: istimaraPhoto, label: 'الاستمارة' });
            if (!photos.length && legacyPhoto) photos.push({ url: legacyPhoto, label: 'مركبة' });
            const photoHtml = photos.length
                ? `<div class="order-photos">${photos.map((p) => `
                    <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" title="${escapeHtml(p.label)}">
                        <img class="order-photo" src="${escapeHtml(p.url)}" alt="${escapeHtml(p.label)}">
                        <span class="order-photo-label">${escapeHtml(p.label)}</span>
                    </a>`).join('')}</div>`
                : '<div class="order-photo-empty">بدون<br>صور</div>';
            const phone = order.customer_phone || '';
            const phoneLink = phone ? `<a href="tel:${escapeHtml(phone)}">${escapeHtml(phone)}</a>` : '-';
            return `
                <article class="order-card">
                    ${photoHtml}
                    <div class="order-main">
                        <h3>#${escapeHtml(order.id)} — ${escapeHtml(order.customer_name || 'عميل')}</h3>
                        <div class="meta">
                            الجوال: ${phoneLink}<br>
                            المدينة: ${escapeHtml(order.customer_city || '-')}<br>
                            العنوان: ${escapeHtml(order.customer_address || '-')}<br>
                            ${order.maps_url ? `الموقع: <a href="${escapeHtml(order.maps_url)}" target="_blank" rel="noopener">فتح على الخريطة</a><br>` : ''}
                            رقم الهيكل: ${escapeHtml(order.vin_code || 'غير مذكور')}<br>
                            التاريخ: ${escapeHtml(formatDate(order.created_at))}
                        </div>
                        <div class="order-items">${formatItems(order.items)}</div>
                    </div>
                    <div class="order-side">
                        <span class="badge">${escapeHtml(order.whatsapp_status || 'received')}</span>
                        <div class="price">${Number(order.total_amount || 0).toLocaleString('ar-SA')} ر.س</div>
                        ${waLinkFromPhone(phone)}
                        <button class="btn btn-ghost" style="padding:8px 12px;font-size:0.82rem;color:#ff8d8d;border-color:rgba(255,100,100,0.35)" type="button" onclick="deleteOrder(${Number(order.id)})">
                            <i class="fa-solid fa-trash"></i> حذف
                        </button>
                    </div>
                </article>
            `;
        }).join('');
    } catch (error) {
        list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
        toast(error.message);
    }
}

function onProductSearch() {
    clearTimeout(productSearchTimer);
    productSearchTimer = setTimeout(() => loadProducts(), 350);
}

async function loadProducts() {
    const list = document.getElementById('products-list');
    const countEl = document.getElementById('products-count');
    if (!list) return;
    list.innerHTML = '<div class="empty">جاري التحميل...</div>';
    try {
        const q = (document.getElementById('product-search')?.value || '').trim();
        const params = new URLSearchParams({ per_page: '50', page: '1' });
        if (q) params.set('q', q);
        const data = await fetchJson(`/admin/catalog/products?${params.toString()}`);
        const products = data.data || [];
        if (countEl) countEl.textContent = String(data.meta?.total || products.length);
        if (!products.length) {
            list.innerHTML = '<div class="empty">ما فيه منتجات مطابقة.</div>';
            return;
        }
        list.innerHTML = products.map((p) => {
            const title = p.name_ar || p.name_en || p.title || `منتج #${p.id}`;
            const oem = p.oem_number || p.oem || '-';
            const price = Number(p.price || 0).toLocaleString('ar-SA');
            const status = p.status || '-';
            const statusClass = status === 'published' ? 'badge ok' : 'badge';
            return `
                <article class="product-row">
                    ${productImage(p)}
                    <div>
                        <h3>${escapeHtml(title)}</h3>
                        <div class="meta">
                            OEM: ${escapeHtml(oem)}<br>
                            الماركة: ${escapeHtml(p.brand_name_ar || p.brand_name || p.brand?.name_ar || '-')}
                        </div>
                    </div>
                    <div class="product-side">
                        <span class="${statusClass}">${escapeHtml(status)}</span>
                        <div class="price">${price} ر.س</div>
                        <a class="btn btn-ghost" style="padding:8px 12px;font-size:0.82rem" href="product.html?id=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">عرض</a>
                        <button class="btn btn-ghost" style="padding:8px 12px;font-size:0.82rem;color:#ff8d8d;border-color:rgba(255,100,100,0.35)" type="button" onclick="deleteProduct(${Number(p.id)}, '${escapeHtml(title).replace(/'/g, '')}')">
                            <i class="fa-solid fa-trash"></i> حذف
                        </button>
                    </div>
                </article>
            `;
        }).join('');
    } catch (error) {
        list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
        toast(error.message);
    }
}

async function loadMessages() {
    const list = document.getElementById('messages-list');
    const countEl = document.getElementById('messages-count');
    if (!list) return;
    list.innerHTML = '<div class="empty">جاري التحميل...</div>';
    try {
        const data = await fetchJson('/admin/contacts?per_page=100');
        const rows = data.data || [];
        if (countEl) countEl.textContent = String(rows.length);
        if (!rows.length) {
            list.innerHTML = '<div class="empty">ما فيه رسائل بعد.</div>';
            return;
        }
        list.innerHTML = rows.map((row) => `
            <article class="msg-card">
                <div>
                    <h3>${escapeHtml(row.name || 'زائر')}</h3>
                    <div class="meta">
                        ${escapeHtml(row.email || '-')}<br>
                        ${escapeHtml(formatDate(row.created_at))}
                    </div>
                    <div class="order-items">${escapeHtml(row.message || '')}</div>
                </div>
                <div class="msg-side">
                    <span class="badge">${escapeHtml(row.status || 'new')}</span>
                    ${row.email ? `<a class="btn btn-ghost" style="padding:8px 12px;font-size:0.82rem" href="mailto:${escapeHtml(row.email)}">رد</a>` : ''}
                    <button class="btn btn-ghost" style="padding:8px 12px;font-size:0.82rem;color:#ff8d8d;border-color:rgba(255,100,100,0.35)" type="button" onclick="deleteMessage(${Number(row.id)})">
                        <i class="fa-solid fa-trash"></i> حذف
                    </button>
                </div>
            </article>
        `).join('');
    } catch (error) {
        list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
        toast(error.message);
    }
}

async function loadBrands() {
    const list = document.getElementById('brands-list');
    if (!list) return;
    list.innerHTML = '<div class="empty">جاري التحميل...</div>';
    try {
        const data = await fetchJson('/admin/catalog/brands?per_page=200');
        const brands = data.data || [];
        if (!brands.length) {
            list.innerHTML = '<div class="empty">ما فيه ماركات.</div>';
            return;
        }
        list.innerHTML = brands.map((b) => {
            const name = b.name_ar || b.name_en || b.slug || `ماركة #${b.id}`;
            const logo = b.logo_url || b.logo || '';
            const logoHtml = logo
                ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(name)}">`
                : `<i class="fa-solid fa-car" style="color:var(--muted);font-size:1.4rem"></i>`;
            return `
                <div class="brand-chip">
                    ${logoHtml}
                    <span>${escapeHtml(name)}</span>
                </div>
            `;
        }).join('');
    } catch (error) {
        list.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
        toast(error.message);
    }
}

async function loadStats() {
    try {
        const data = await fetchJson('/admin/stats');
        const stats = data.stats || data.counts || data.data || data;
        const set = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.textContent = Number(value || 0).toLocaleString('ar-SA');
        };
        set('stat-orders', stats.total_inquiries || stats.total_orders || stats.pending_inquiries);
        set('stat-products', stats.total_products);
        set('stat-published', stats.published_products);
        set('stat-messages', stats.total_contact_messages || stats.total_contacts || 0);
    } catch (error) {
        toast(error.message);
    }
}

async function deleteMessage(id) {
    if (!id) return;
    if (!confirm('هل تريد حذف هذه الرسالة؟')) return;
    try {
        await fetchJson(`/admin/contacts/${id}`, { method: 'DELETE' });
        toast('تم حذف الرسالة');
        loadMessages();
        if (currentTab === 'home') loadStats();
    } catch (error) {
        toast(error.message);
    }
}

async function deleteProduct(id, title = '') {
    if (!id) return;
    const label = title ? `\n${title}` : '';
    if (!confirm(`هل تريد حذف هذا المنتج نهائيًا؟${label}`)) return;
    try {
        await fetchJson(`/admin/catalog/products/${id}`, { method: 'DELETE' });
        toast('تم حذف المنتج');
        loadProducts();
        if (currentTab === 'home') loadStats();
    } catch (error) {
        toast(error.message);
    }
}

async function deleteOrder(id) {
    if (!id) return;
    if (!confirm('هل تريد حذف هذا الطلب؟')) return;
    try {
        await fetchJson(`/admin/orders/${id}`, { method: 'DELETE' });
        toast('تم حذف الطلب');
        loadOrders();
        if (currentTab === 'home') loadStats();
    } catch (error) {
        toast(error.message);
    }
}

window.adminLogin = adminLogin;
window.adminLogout = adminLogout;
window.switchTab = switchTab;
window.loadOrders = loadOrders;
window.loadProducts = loadProducts;
window.loadMessages = loadMessages;
window.loadBrands = loadBrands;
window.loadStats = loadStats;
window.onProductSearch = onProductSearch;
window.deleteMessage = deleteMessage;
window.deleteProduct = deleteProduct;
window.deleteOrder = deleteOrder;
