"""Integration checks using a disposable SQLite backup, with no external checkout calls.

Run: python -m unittest discover -s tools -p test_storefront.py -v
"""
import json
import base64
from contextlib import closing
import io
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import bcrypt
from PIL import Image
import local_api_server as app


class StorefrontTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.original_db, cls.original_interactions = app.DB_PATH, app.INTERACTIONS_PATH
        cls.original_private_upload_dir = app.PRIVATE_UPLOAD_DIR
        app.DB_PATH = Path(cls.temp.name) / 'test.sqlite'
        app.INTERACTIONS_PATH = Path(cls.temp.name) / 'interactions.json'
        app.PRIVATE_UPLOAD_DIR = Path(cls.temp.name) / 'private' / 'checkout-verify'
        with closing(sqlite3.connect(cls.original_db)) as src, closing(sqlite3.connect(app.DB_PATH)) as dst:
            src.backup(dst)
            dst.execute("INSERT INTO users (name,email,password) VALUES ('Test Admin','test-admin@example.invalid',?)",
                        (bcrypt.hashpw(b'test-password-only', bcrypt.gensalt()).decode(),))
            uid = dst.execute("SELECT id FROM users WHERE email='test-admin@example.invalid'").fetchone()[0]
            dst.execute("INSERT INTO role_user (user_id,role_id) SELECT ?,id FROM roles WHERE name='super_admin'", (uid,))
            dst.commit()
        cls.server = app.ThreadingHTTPServer(('127.0.0.1', 0), app.Handler)
        cls.base = 'http://127.0.0.1:' + str(cls.server.server_port)
        cls.original_base = app.BASE_URL
        app.BASE_URL = cls.base
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        app.DB_PATH, app.INTERACTIONS_PATH = cls.original_db, cls.original_interactions
        app.PRIVATE_UPLOAD_DIR = cls.original_private_upload_dir
        app.BASE_URL = cls.original_base
        app._RESPONSE_CACHE.clear()
        app._RATE_LIMITS.clear()
        app._CUSTOMER_SCHEMA_READY = False
        cls.temp.cleanup()

    def request(self, path, method='GET', data=None, token=None, headers=None):
        request_headers = {'Content-Type': 'application/json', **(headers or {})}
        if token:
            request_headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request(self.base + path, method=method, headers=request_headers,
                                     data=json.dumps(data).encode() if data is not None else None)
        try:
            response = urllib.request.urlopen(req, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            return response.status, json.loads(raw) if 'application/json' in response.headers.get('Content-Type', '') else raw

    def test_vin_never_invents_compatibility(self):
        with closing(sqlite3.connect(app.DB_PATH)) as con:
            for vin in ['LHGAAAAA0T0000001', 'ZZZAAAAA0T0000001']:
                result = app.decode_vin_payload(con, vin)
                self.assertTrue(result['is_valid'])
                self.assertFalse(result['fitment_verified'])
                self.assertIsNone(result['brand'])
                self.assertEqual(result['matching_parts'], [])
                self.assertNotIn('estimated_year', result)
            for vin in ['short', 'LHGAAAAA0T000000I', 'Ａ'*17]:
                self.assertFalse(app.decode_vin_payload(con, vin)['is_valid'])

    def test_pages_and_assets(self):
        for path in ['/', '/collection.html', '/account.html', '/contact.html', '/faq.html',
                     '/about.html', '/privacy.html', '/terms.html', '/policy.html', '/admin-dashboard.html',
                     '/app.js', '/style.css', '/ads-tracker.js', '/robots.txt']:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 200)

    def test_catalog_search_and_filters(self):
        self.assertEqual(self.request('/api/health')[0], 200)
        status, home = self.request('/api/storefront/home')
        self.assertEqual(status, 200)
        self.assertTrue(home['latest_products'])
        status, listing = self.request('/api/storefront/products?per_page=2')
        self.assertEqual(status, 200)
        self.assertEqual(len(listing['data']), 2)
        product = listing['data'][0]
        self.assertEqual(self.request('/api/storefront/products/' + str(product['id']))[0], 200)
        if product.get('sku'):
            exact = self.request('/api/search?q=' + urllib.parse.quote(str(product['sku'])))[1]
            self.assertTrue(exact['results'])
            self.assertEqual(exact['results'][0]['id'], product['id'])
        status, product_html = self.request('/product.html?id=' + str(product['id']))
        self.assertEqual(status, 200)
        self.assertIn(b'product-jsonld', product_html)
        self.assertNotIn(b'"mpn":""', product_html)
        self.assertIn(b'id="loading-spinner" class="text-center" style="display:none;', product_html)
        brand = product.get('brand') or {}
        brand_slug = str(brand.get('slug') or '')
        if brand_slug and brand_slug not in {'generic', 'brand'}:
            self.assertIn(('/brands/' + brand_slug + '/').encode(), product_html)
        self.assertEqual(self.request('/api/storefront/products/999999999')[0], 404)
        for path in ['/api/brands','/api/categories','/api/models/1','/api/search?q=PC201132-1301-CH',
                     '/api/storefront/products?brand=1&sort=price_asc',
                     '/api/storefront/products?category_key=brakes&in_stock=true']:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 200)
        self.assertEqual(self.request('/api/search')[1]['results'], [])
        self.assertGreater(self.request('/api/search?q=%D8%B1%D8%A7%D8%AF%D9%8A%D8%AA%D9%8A%D8%B1')[1]['meta']['total'], 0)
        image = product.get('image_url')
        if image and image.startswith(self.base):
            self.assertEqual(self.request(image[len(self.base):])[0], 200)

    def test_bad_query_returns_json(self):
        for query in ['page=bad','page=0','page=-1','per_page=oops','min_price=NaN',
                      'max_price=inf','min_price=-2','min_price=20&max_price=10']:
            with self.subTest(query=query):
                status, body = self.request('/api/storefront/products?' + query)
                self.assertEqual(status, 422)
                self.assertIn('message', body)
        self.assertEqual(self.request('/api/search?limit=bad')[0], 422)
        self.assertEqual(self.request('/api/search?brand_id=abc')[0], 422)

    def test_admin_auth_and_revocation(self):
        for method in ['GET', 'POST', 'PATCH', 'PUT', 'DELETE']:
            with self.subTest(method=method):
                self.assertEqual(self.request('/api/admin/catalog/products/1', method, {} if method != 'GET' else None)[0], 401)
        self.assertEqual(self.request('/api/admin/auth/login','POST', {'email':'nobody@example.invalid','password':'wrong'})[0], 422)
        status, body = self.request('/api/admin/auth/login','POST', {'email':'test-admin@example.invalid','password':'test-password-only'})
        self.assertEqual(status, 200)
        token = body['token']
        self.assertEqual(self.request('/api/admin/auth/me', token=token)[1]['user']['email'], 'test-admin@example.invalid')
        self.assertEqual(self.request('/api/admin/stats', token=token)[0], 200)
        for path in ['catalog/products', 'catalog/brands', 'catalog/models', 'catalog/categories',
                     'catalog/vehicles', 'catalog/oem-numbers', 'catalog/fitments', 'customers',
                     'orders', 'contacts', 'imports', 'content/article-categories', 'content/articles',
                     'content/seo-pages', 'users', 'roles', 'permissions', 'sources', 'reports/operations']:
            with self.subTest(admin_path=path):
                self.assertEqual(self.request('/api/admin/' + path + '?per_page=2', token=token)[0], 200)
        product = self.request('/api/storefront/products?per_page=1')[1]['data'][0]
        original_price = float(product['price'])
        self.assertEqual(
            self.request(
                f"/api/admin/catalog/products/{product['id']}",
                'PATCH',
                {'price': max(0.01, original_price - 1)},
                token,
            )[0],
            422,
        )
        status, pricing = self.request(
            f"/api/admin/catalog/products/{product['id']}/pricing",
            'PATCH',
            {
                'unit_cost': original_price,
                'fulfillment_cost': 10,
                'payment_fee_percent': 2,
                'target_margin_percent': 10,
            },
            token,
        )
        self.assertEqual(status, 200)
        self.assertGreater(pricing['calculated_floor'], original_price)
        self.assertEqual(
            self.request(
                f"/api/admin/catalog/products/{product['id']}",
                'PATCH',
                {'price': pricing['calculated_floor'] - 1},
                token,
            )[0],
            422,
        )
        self.assertEqual(
            self.request(
                f"/api/admin/catalog/products/{product['id']}",
                'PATCH',
                {'price': pricing['calculated_floor'] + 1},
                token,
            )[0],
            200,
        )
        status, pricing_report = self.request(
            '/api/admin/reports/pricing?per_page=2',
            token=token,
        )
        self.assertEqual(status, 200)
        self.assertGreater(pricing_report['meta']['total'], 0)
        self.assertEqual(self.request('/api/admin/auth/logout', 'POST', {}, token)[0], 200)
        self.assertEqual(self.request('/api/admin/stats', token=token)[0], 401)
        self.assertEqual(self.request('/api/admin/stats', token='local-admin-token-secret-999')[0], 401)

    def test_private_files_unavailable(self):
        for path in ['/core/composer.json','/tools/.storefront_interactions.json','/core/resources/js/app.js',
                     '/core/database/database.sqlite','/salla_products_import_ready.csv',
                     '/images/checkout-verify/private-customer-photo.jpg']:
            with self.subTest(path=path):
                self.assertEqual(self.request(path)[0], 404)

    def test_security_limits_and_private_uploads(self):
        self.assertEqual(self.request('/api/salla/sync-batch')[0], 401)
        self.assertEqual(
            self.request(
                '/api/contact',
                'POST',
                {'name': 'Test', 'email': 'test@example.invalid', 'message': 'hello world'},
                headers={'Origin': 'https://evil.invalid', 'X-Forwarded-For': '198.51.100.60'},
            )[0],
            403,
        )
        image_buffer = io.BytesIO()
        Image.new('RGB', (2, 2), color=(240, 240, 240)).save(image_buffer, format='JPEG')
        encoded = base64.b64encode(image_buffer.getvalue()).decode('ascii')
        status, upload = self.request(
            '/api/checkout/vehicle-photo',
            'POST',
            {'image_base64': encoded, 'mime_type': 'image/jpeg', 'kind': 'car'},
            headers={'X-Forwarded-For': '198.51.100.62'},
        )
        self.assertEqual(status, 200)
        self.assertTrue(upload['path'].startswith('private://checkout-verify/'))
        self.assertNotIn('url', upload)
        filename = upload['upload_id']
        self.assertTrue((app.PRIVATE_UPLOAD_DIR / filename).is_file())
        private_url = '/api/admin/checkout-files/' + filename
        self.assertEqual(self.request(private_url)[0], 401)

        status, login = self.request(
            '/api/admin/auth/login',
            'POST',
            {'email': 'test-admin@example.invalid', 'password': 'test-password-only'},
            headers={'X-Forwarded-For': '198.51.100.63'},
        )
        self.assertEqual(status, 200)
        status, image = self.request(private_url, token=login['token'])
        self.assertEqual(status, 200)
        self.assertGreater(len(image), 10)

        for attempt in range(7):
            status, _ = self.request(
                '/api/contact',
                'POST',
                {},
                headers={'X-Forwarded-For': '198.51.100.77'},
            )
        self.assertEqual(status, 429)

    def test_truthful_commerce_and_seo_guards(self):
        listing = self.request('/api/storefront/products?per_page=100')[1]['data']
        for product in listing:
            if product.get('checkout_enabled'):
                self.assertIs(product.get('in_stock'), True)
                self.assertTrue(product.get('salla_product_id') or product.get('zid_product_id'))
                self.assertTrue(product.get('checkout_price_verified'))
            if product.get('stock_quantity') is None:
                self.assertIsNone(product.get('in_stock'))

        with closing(sqlite3.connect(app.DB_PATH)) as con:
            con.row_factory = sqlite3.Row
            candidate = con.execute(
                """
                SELECT p.id, p.price
                FROM parts p
                WHERE p.status='published'
                  AND NOT EXISTS (
                    SELECT 1 FROM salla_products sp WHERE sp.product_id=p.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM zid_products zp WHERE zp.product_id=p.id
                  )
                LIMIT 1
                """
            ).fetchone()
            con.execute(
                """
                INSERT INTO salla_products (
                    product_id, salla_product_id, sync_status,
                    last_known_price, last_known_quantity, created_at, updated_at
                ) VALUES (?, ?, 'synced', ?, 5, datetime('now'), datetime('now'))
                """,
                (candidate['id'], f"TEST-{candidate['id']}", float(candidate['price']) + 10),
            )
            con.commit()
        mismatched = self.request(
            '/api/storefront/products/' + str(candidate['id'])
        )[1]['data']
        self.assertFalse(mismatched['checkout_enabled'])
        self.assertIn('سعر منصة الدفع لا يطابق سعر المتجر', mismatched['checkout_blockers'])

        readiness = self.request('/api/storefront/merchant-readiness')[1]['data']
        self.assertFalse(readiness['ready'])
        self.assertEqual(readiness['published_feed_products'], 0)
        merchant_xml = self.request('/feed/google-merchant.xml')[1]
        self.assertNotIn(b'<item>', merchant_xml)

        status, filtered = self.request('/collection.html?q=test')
        self.assertEqual(status, 200)
        self.assertIn(b'noindex,follow', filtered)

        req = urllib.request.Request(self.base + '/api/health', headers={'Origin': 'https://evil.invalid'})
        with urllib.request.urlopen(req, timeout=30) as response:
            self.assertEqual(response.headers.get('X-Content-Type-Options'), 'nosniff')
            self.assertIsNone(response.headers.get('Access-Control-Allow-Origin'))

    def test_customer_validation_and_interactions(self):
        self.assertEqual(self.request('/api/storefront/auth/me')[0], 401)
        self.assertEqual(self.request('/api/storefront/auth/register','POST', {})[0], 422)
        self.assertEqual(
            self.request(
                '/api/storefront/auth/register',
                'POST',
                {'name': 'Test User', 'phone': '0500000001', 'password': 'short1'},
                headers={'X-Forwarded-For': '198.51.100.81'},
            )[0],
            422,
        )
        status, registered = self.request(
            '/api/storefront/auth/register',
            'POST',
            {'name': 'Test User', 'phone': '0500000001', 'password': 'long-test-password'},
            headers={'X-Forwarded-For': '198.51.100.81'},
        )
        self.assertEqual(status, 200)
        with closing(sqlite3.connect(app.DB_PATH)) as con:
            token_row = con.execute(
                "SELECT expires_at FROM customer_api_tokens WHERE token_hash=?",
                (app.hash_token(registered['token']),),
            ).fetchone()
            self.assertIsNotNone(token_row)
            self.assertIsNotNone(token_row[0])
        self.assertEqual(self.request('/api/contact','POST', {})[0], 422)
        self.assertEqual(self.request('/api/storefront/checkout-inquiry','POST', {})[0], 422)
        product = self.request('/api/storefront/products?per_page=1')[1]['data'][0]
        for kind in ['favorites', 'comparisons']:
            path = '/api/storefront/' + kind
            self.assertEqual(self.request(path,'POST', {'product_id':product['id'],'session_id':'integration-test'})[0], 200)
            self.assertEqual(self.request(path+'?session_id=integration-test')[0], 200)
            self.assertEqual(self.request(path+'/'+str(product['id'])+'?session_id=integration-test','DELETE')[0], 200)

    def test_order_uses_catalog_prices(self):
        product = self.request('/api/storefront/products?per_page=1')[1]['data'][0]
        body = {'customer_name':'Test Customer', 'customer_phone':'0500000000',
                'customer_city':'Test City', 'customer_address':'Test Address',
                'car_photo_path':'/images/checkout-verify/test-car.png',
                'istimara_photo_path':'/images/checkout-verify/test-registration.png',
                'items':[{'id':product['id'], 'quantity':2, 'price':0.01}], 'total_amount':0.02}
        status, result = self.request('/api/storefront/checkout-inquiry','POST',body)
        self.assertEqual(status, 200)
        with closing(sqlite3.connect(app.DB_PATH)) as con:
            total = con.execute('SELECT total_amount FROM checkout_inquiries WHERE id=?', (result['inquiry_id'],)).fetchone()[0]
        self.assertAlmostEqual(float(total), float(product['price'] or 0)*2, places=2)
        without_photos = {**body, 'car_photo_path': '', 'istimara_photo_path': ''}
        self.assertEqual(self.request('/api/storefront/checkout-inquiry','POST',without_photos)[0], 200)
        for items in [[], [{'id':product['id'],'quantity':-1}], [{'id':999999999,'quantity':1}]]:
            with self.subTest(items=items):
                self.assertEqual(self.request('/api/storefront/checkout-inquiry','POST',{**body,'items':items})[0], 422)

    def test_landing_pages_sitemap_and_purchase_gate(self):
        brands = self.request('/api/brands')[1]
        brand = next((item for item in brands if item.get('has_products') and item.get('slug')), None)
        self.assertIsNotNone(brand)
        status, html = self.request('/brands/' + brand['slug'] + '/')
        self.assertEqual(status, 200)
        self.assertIn(b'CollectionPage', html)
        self.assertIn(b'BreadcrumbList', html)
        self.assertIn(b'<base href="/">', html)
        self.assertIn(('/brands/' + brand['slug'] + '/').encode(), html)
        self.assertNotIn('شراء أونلاين'.encode('utf-8'), html)
        self.assertEqual(self.request('/brands/not-a-real-brand-xyz/')[0], 404)

        sitemap = self.request('/sitemap.xml')[1]
        self.assertIn(b'<lastmod>', sitemap)
        self.assertIn(('/brands/' + brand['slug'] + '/').encode(), sitemap)
        self.assertNotIn(b'seo_landing.html', sitemap)

        robots = self.request('/robots.txt')[1]
        self.assertIn(b'Disallow: /seo_landing.html', robots)
        status, retired = self.request('/seo_landing.html')
        self.assertEqual(status, 200)
        self.assertIn(b'noindex', retired)

        status, confirmation = self.request('/api/storefront/purchase-confirmation/ORDER-TEST')
        self.assertEqual(status, 404)
        self.assertFalse(confirmation['data']['tracking_confirmation']['tracking_confirmed'])
        self.assertEqual(
            self.request('/api/internal/payment-webhook', 'POST', {'transaction_id': 'ORDER-TEST'})[0],
            404,
        )


if __name__ == '__main__':
    unittest.main()
