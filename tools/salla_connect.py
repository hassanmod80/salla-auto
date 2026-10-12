"""Official Salla OAuth, encrypted token storage, catalog sync, and webhooks.

Tokens never leave the server. Refresh tokens are single-use, so refresh is serialized.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from decimal import Decimal

TOKEN_URL = "https://accounts.salla.sa/oauth2/token"
AUTH_URL = "https://accounts.salla.sa/oauth2/auth"
USERINFO_URL = "https://accounts.salla.sa/oauth2/user/info"

_REFRESH_LOCK = threading.Lock()
_SYNC_LOCK = threading.Lock()
_SYNC_RUNNING = False

SKU_RE = re.compile(r"^QETAA-(\d+)$", re.I)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime | None = None) -> str:
    return (value or _now()).strftime("%Y-%m-%d %H:%M:%S")


def _parse_iso(value: str | None) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(raw[:19], fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    return None


def env_value(env: dict, key: str) -> str:
    return str(os.environ.get(key) or env.get(key) or "").strip()


def _fernet(env: dict):
    from cryptography.fernet import Fernet

    material = env_value(env, "SALLA_TOKEN_ENC_KEY") or env_value(env, "SALLA_CLIENT_SECRET")
    if len(material) < 16:
        raise RuntimeError("لا يمكن تخزين توكن سلة بدون مفتاح تشفير على الخادم.")
    key = base64.urlsafe_b64encode(hashlib.sha256(material.encode("utf-8")).digest())
    return Fernet(key)


def encrypt_secret(env: dict, value: str) -> str:
    if not value:
        return ""
    return _fernet(env).encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_secret(env: dict, value: str | None) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    return _fernet(env).decrypt(raw.encode("ascii")).decode("utf-8")


def ensure_salla_connect_schema(con: sqlite3.Connection) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS salla_oauth_tokens (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            access_token_enc TEXT,
            refresh_token_enc TEXT,
            scope TEXT,
            access_expires_at TEXT,
            connected_at TEXT,
            last_refresh_at TEXT,
            last_success_at TEXT,
            last_error TEXT,
            refresh_lock_until TEXT,
            merchant_id TEXT,
            store_name TEXT
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS salla_oauth_states (
            state TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS salla_sync_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            status TEXT NOT NULL,
            pulled INTEGER DEFAULT 0,
            linked INTEGER DEFAULT 0,
            unmatched INTEGER DEFAULT 0,
            price_updates INTEGER DEFAULT 0,
            stock_updates INTEGER DEFAULT 0,
            error TEXT
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS salla_webhook_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_key TEXT,
            event_name TEXT,
            received_at TEXT,
            status TEXT,
            error TEXT
        )
        """
    )
    webhook_columns = {str(row[1]) for row in con.execute("PRAGMA table_info(salla_webhook_events)").fetchall()}
    for name, ddl in (
        ("event_key", "TEXT"),
        ("event_name", "TEXT"),
        ("received_at", "TEXT"),
        ("status", "TEXT"),
        ("error", "TEXT"),
    ):
        if name not in webhook_columns:
            con.execute(f"ALTER TABLE salla_webhook_events ADD COLUMN {name} {ddl}")
    con.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_salla_webhook_event_key ON salla_webhook_events(event_key)"
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS salla_remote_orders (
            salla_order_id TEXT PRIMARY KEY,
            reference_id TEXT,
            status_name TEXT,
            payment_status TEXT,
            total_amount REAL,
            currency TEXT,
            updated_at TEXT NOT NULL,
            payload_json TEXT
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS salla_unmatched_products (
            salla_product_id TEXT PRIMARY KEY,
            sku TEXT,
            name TEXT,
            price REAL,
            quantity INTEGER,
            reason TEXT,
            seen_at TEXT NOT NULL
        )
        """
    )
    columns = {str(row[1]) for row in con.execute("PRAGMA table_info(salla_products)").fetchall()}
    if columns:
        for name, ddl in (
            ("sku", "TEXT"),
            ("sale_price", "REAL"),
            ("regular_price", "REAL"),
            ("remote_status", "TEXT"),
            ("unlimited_quantity", "INTEGER DEFAULT 0"),
        ):
            if name not in columns:
                con.execute(f"ALTER TABLE salla_products ADD COLUMN {name} {ddl}")
    con.commit()


def redirect_uri(base_url: str) -> str:
    return base_url.rstrip("/") + "/api/salla/oauth/callback"


def create_oauth_state(con: sqlite3.Connection) -> str:
    ensure_salla_connect_schema(con)
    state = secrets.token_urlsafe(32)
    now = _now()
    con.execute("DELETE FROM salla_oauth_states WHERE expires_at < ?", (_iso(now),))
    con.execute(
        "INSERT INTO salla_oauth_states (state, created_at, expires_at) VALUES (?, ?, ?)",
        (state, _iso(now), _iso(now + timedelta(minutes=10))),
    )
    con.commit()
    return state


def consume_oauth_state(con: sqlite3.Connection, state: str) -> bool:
    ensure_salla_connect_schema(con)
    row = con.execute(
        "SELECT expires_at FROM salla_oauth_states WHERE state=?",
        (state,),
    ).fetchone()
    con.execute("DELETE FROM salla_oauth_states WHERE state=?", (state,))
    con.commit()
    if row is None:
        return False
    expires = _parse_iso(row[0] if not isinstance(row, sqlite3.Row) else row["expires_at"])
    return bool(expires and expires >= _now())


def authorization_url(env: dict, base_url: str, state: str) -> str:
    client_id = env_value(env, "SALLA_CLIENT_ID")
    if not client_id:
        raise RuntimeError("SALLA_CLIENT_ID غير مضبوط على الخادم.")
    query = urllib.parse.urlencode(
        {
            "client_id": client_id,
            "redirect_uri": redirect_uri(base_url),
            "response_type": "code",
            "scope": "offline_access",
            "state": state,
        }
    )
    return f"{AUTH_URL}?{query}"


def _token_request(env: dict, fields: dict) -> dict:
    client_id = env_value(env, "SALLA_CLIENT_ID")
    client_secret = env_value(env, "SALLA_CLIENT_SECRET")
    if not client_id or not client_secret:
        raise RuntimeError("بيانات تطبيق سلة غير مكتملة على الخادم.")
    body = urllib.parse.urlencode(
        {**fields, "client_id": client_id, "client_secret": client_secret}
    ).encode("utf-8")
    req = urllib.request.Request(
        TOKEN_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": "CHINA-PARTS-Salla/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw or "{}")
        except json.JSONDecodeError:
            payload = {"error": "http_error", "status": exc.code}
        payload["_http_status"] = exc.code
        return payload if isinstance(payload, dict) else {"error": "invalid_response"}
    return payload if isinstance(payload, dict) else {}


def _save_token_payload(con: sqlite3.Connection, env: dict, payload: dict, *, replacing_refresh: bool) -> None:
    access = str(payload.get("access_token") or "").strip()
    refresh = str(payload.get("refresh_token") or "").strip()
    if not access:
        raise RuntimeError("رد سلة لا يحتوي على access token.")
    expires_in = payload.get("expires_in") or payload.get("expires") or 1209600
    try:
        seconds = int(expires_in)
    except (TypeError, ValueError):
        seconds = 1209600
    now = _now()
    current = con.execute("SELECT refresh_token_enc FROM salla_oauth_tokens WHERE id=1").fetchone()
    refresh_enc = encrypt_secret(env, refresh) if refresh else (
        (current["refresh_token_enc"] if isinstance(current, sqlite3.Row) else (current[0] if current else "")) or ""
    )
    if replacing_refresh and not refresh:
        refresh_enc = ""
    con.execute(
        """
        INSERT INTO salla_oauth_tokens (
            id, access_token_enc, refresh_token_enc, scope, access_expires_at,
            connected_at, last_refresh_at, last_success_at, last_error, refresh_lock_until
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET
            access_token_enc=excluded.access_token_enc,
            refresh_token_enc=excluded.refresh_token_enc,
            scope=excluded.scope,
            access_expires_at=excluded.access_expires_at,
            last_refresh_at=excluded.last_refresh_at,
            last_success_at=excluded.last_success_at,
            last_error=NULL,
            refresh_lock_until=NULL
        """,
        (
            encrypt_secret(env, access),
            refresh_enc,
            str(payload.get("scope") or ""),
            _iso(now + timedelta(seconds=max(60, seconds - 120))),
            _iso(now),
            _iso(now),
            _iso(now),
        ),
    )
    con.commit()


def exchange_authorization_code(con: sqlite3.Connection, env: dict, base_url: str, code: str) -> None:
    ensure_salla_connect_schema(con)
    payload = _token_request(
        env,
        {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri(base_url),
            "scope": "offline_access",
        },
    )
    if payload.get("error") or not payload.get("access_token"):
        raise RuntimeError("تعذر إكمال تفويض سلة. تأكد أن رابط العودة في لوحة الشركاء يطابق عنوان الموقع.")
    _save_token_payload(con, env, payload, replacing_refresh=True)


def access_token(con: sqlite3.Connection, env: dict) -> str:
    """Return a usable access token, refreshing once when it is near expiry."""
    ensure_salla_connect_schema(con)
    row = con.execute("SELECT * FROM salla_oauth_tokens WHERE id=1").fetchone()
    if row is None or not row["access_token_enc"]:
        legacy = env_value(env, "SALLA_ACCESS_TOKEN")
        if legacy:
            return legacy
        raise RuntimeError("authorization_missing")
    expires = _parse_iso(row["access_expires_at"])
    token = decrypt_secret(env, row["access_token_enc"])
    if expires and expires > _now() + timedelta(seconds=60):
        return token
    refresh = decrypt_secret(env, row["refresh_token_enc"])
    if not refresh:
        if expires and expires > _now():
            return token
        raise RuntimeError("reauthorization_required")
    with _REFRESH_LOCK:
        row = con.execute("SELECT * FROM salla_oauth_tokens WHERE id=1").fetchone()
        expires = _parse_iso(row["access_expires_at"]) if row else None
        if row and row["access_token_enc"] and expires and expires > _now() + timedelta(seconds=60):
            return decrypt_secret(env, row["access_token_enc"])
        lock_until = _parse_iso(row["refresh_lock_until"]) if row else None
        if lock_until and lock_until > _now():
            raise RuntimeError("token_refresh_in_progress")
        con.execute(
            "UPDATE salla_oauth_tokens SET refresh_lock_until=? WHERE id=1",
            (_iso(_now() + timedelta(seconds=45)),),
        )
        con.commit()
        refresh = decrypt_secret(env, row["refresh_token_enc"])
        payload = _token_request(env, {"grant_type": "refresh_token", "refresh_token": refresh})
        if payload.get("error") or not payload.get("access_token"):
            message = "reauthorization_required" if payload.get("error") == "invalid_grant" else "token_refresh_failed"
            con.execute(
                "UPDATE salla_oauth_tokens SET last_error=?, refresh_lock_until=NULL WHERE id=1",
                (message,),
            )
            if payload.get("error") == "invalid_grant":
                con.execute(
                    "UPDATE salla_oauth_tokens SET access_token_enc=NULL, refresh_token_enc=NULL WHERE id=1"
                )
            con.commit()
            raise RuntimeError(message)
        _save_token_payload(con, env, payload, replacing_refresh=True)
        return str(payload["access_token"])


def _api_json(method: str, url: str, token: str, body: dict | None = None) -> tuple[int, dict]:
    raw = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=raw, method=method.upper())
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "CHINA-PARTS-Salla/1.0")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
            return int(resp.status), payload if isinstance(payload, dict) else {}
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8", errors="replace") or "{}")
        except Exception:
            payload = {}
        return int(exc.code), payload if isinstance(payload, dict) else {}


def money_amount(value) -> float | None:
    if isinstance(value, dict):
        value = value.get("amount")
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return None
    if amount < 0:
        return None
    return round(amount, 2)


def probe_connection(con: sqlite3.Connection, env: dict) -> dict:
    try:
        token = access_token(con, env)
    except RuntimeError as exc:
        return {"ok": False, "reason": str(exc)}
    status, payload = _api_json("GET", "https://api.salla.dev/admin/v2/store/info", token)
    if status >= 400:
        con.execute(
            "UPDATE salla_oauth_tokens SET last_error=? WHERE id=1",
            (f"store_info_{status}",),
        )
        con.commit()
        return {"ok": False, "reason": f"store_info_{status}"}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    name = str(data.get("name") or "")[:120]
    merchant = str(data.get("id") or data.get("merchant") or "")[:40]
    con.execute(
        """
        UPDATE salla_oauth_tokens
        SET last_success_at=?, last_error=NULL, store_name=?, merchant_id=?
        WHERE id=1
        """,
        (_iso(), name, merchant),
    )
    con.commit()
    return {"ok": True, "store_name": name, "merchant_id": merchant}


def _match_local_part(con: sqlite3.Connection, salla_id: str, sku: str) -> tuple[int | None, str | None]:
    sku_match = SKU_RE.fullmatch(sku or "")
    if sku_match:
        part_id = int(sku_match.group(1))
        row = con.execute("SELECT id FROM parts WHERE id=?", (part_id,)).fetchone()
        if row:
            return int(row["id"] if isinstance(row, sqlite3.Row) else row[0]), None
        return None, "sku_points_to_missing_local_product"
    rows = con.execute(
        """
        SELECT id FROM parts
        WHERE salla_product_id=? OR sku=? OR oem_number=?
        """,
        (salla_id, sku, sku),
    ).fetchall() if sku else con.execute(
        "SELECT id FROM parts WHERE salla_product_id=?",
        (salla_id,),
    ).fetchall()
    ids = [int(row["id"] if isinstance(row, sqlite3.Row) else row[0]) for row in rows]
    unique = sorted(set(ids))
    if len(unique) == 1:
        return unique[0], None
    if len(unique) > 1:
        return None, "duplicate_local_match"
    return None, "unmatched"


def apply_remote_product(con: sqlite3.Connection, product: dict) -> str:
    """Link one Salla product. Returns linked, updated, or a review reason. Does not delete anything."""
    salla_id = str(product.get("id") or "").strip()
    if not salla_id:
        return "missing_remote_id"
    sku = str(product.get("sku") or "").strip()
    name = str(product.get("name") or "")[:180]
    regular = money_amount(product.get("price"))
    sale = money_amount(product.get("sale_price"))
    price = sale if sale not in (None, 0) else regular
    unlimited = bool(product.get("unlimited_quantity"))
    try:
        quantity = None if product.get("quantity") is None else int(product.get("quantity"))
    except (TypeError, ValueError):
        quantity = None
    status_name = str(product.get("status") or "")[:40]
    if status_name == "out":
        quantity = 0
        unlimited = False
    part_id, reason = _match_local_part(con, salla_id, sku)
    now = _iso()
    if part_id is None:
        con.execute(
            """
            INSERT INTO salla_unmatched_products (
                salla_product_id, sku, name, price, quantity, reason, seen_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(salla_product_id) DO UPDATE SET
                sku=excluded.sku, name=excluded.name, price=excluded.price,
                quantity=excluded.quantity, reason=excluded.reason, seen_at=excluded.seen_at
            """,
            (salla_id, sku, name, price, quantity, reason or "unmatched", now),
        )
        return reason or "unmatched"
    con.execute("DELETE FROM salla_unmatched_products WHERE salla_product_id=?", (salla_id,))
    local = con.execute("SELECT price FROM parts WHERE id=?", (part_id,)).fetchone()
    local_price = local["price"] if isinstance(local, sqlite3.Row) else local[0]
    if price is not None and (local_price is None or abs(Decimal(str(local_price)) - Decimal(str(price))) > Decimal("0.01")):
        con.execute("UPDATE parts SET price=?, updated_at=? WHERE id=?", (price, now, part_id))
    if "salla_product_id" in {str(r[1]) for r in con.execute("PRAGMA table_info(parts)").fetchall()}:
        con.execute("UPDATE parts SET salla_product_id=? WHERE id=?", (salla_id, part_id))
    existing = con.execute("SELECT id FROM salla_products WHERE product_id=?", (part_id,)).fetchone()
    values = (
        salla_id, "synced", price, quantity, now, now, sku, sale, regular, status_name, 1 if unlimited else 0,
        json.dumps({"id": salla_id, "sku": sku, "name": name, "status": status_name}, ensure_ascii=False),
    )
    if existing:
        con.execute(
            """
            UPDATE salla_products SET
                salla_product_id=?, sync_status=?, last_known_price=?, last_known_quantity=?,
                last_synced_at=?, updated_at=?, sku=?, sale_price=?, regular_price=?,
                remote_status=?, unlimited_quantity=?, payload_json=?
            WHERE product_id=?
            """,
            values + (part_id,),
        )
    else:
        con.execute(
            """
            INSERT INTO salla_products (
                product_id, salla_product_id, sync_status, last_known_price, last_known_quantity,
                last_synced_at, created_at, updated_at, sku, sale_price, regular_price,
                remote_status, unlimited_quantity, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (part_id, salla_id, "synced", price, quantity, now, now, now, sku, sale, regular, status_name, 1 if unlimited else 0,
             values[-1]),
        )
    return "linked"


def sync_catalog(con: sqlite3.Connection, env: dict) -> dict:
    global _SYNC_RUNNING
    if not _SYNC_LOCK.acquire(blocking=False):
        return {"started": False, "reason": "sync_already_running"}
    _SYNC_RUNNING = True
    ensure_salla_connect_schema(con)
    run_id = con.execute(
        "INSERT INTO salla_sync_runs (started_at, status) VALUES (?, 'running')",
        (_iso(),),
    ).lastrowid
    con.commit()
    pulled = linked = unmatched = 0
    try:
        token = access_token(con, env)
        page = 1
        while page <= 200:
            status, payload = _api_json(
                "GET",
                f"https://api.salla.dev/admin/v2/products?per_page=50&page={page}",
                token,
            )
            if status >= 400:
                raise RuntimeError(f"products_http_{status}")
            products = payload.get("data") if isinstance(payload.get("data"), list) else []
            if not products:
                break
            for product in products:
                if not isinstance(product, dict):
                    continue
                pulled += 1
                result = apply_remote_product(con, product)
                if result == "linked":
                    linked += 1
                else:
                    unmatched += 1
            pagination = payload.get("pagination") if isinstance(payload.get("pagination"), dict) else {}
            total_pages = int(pagination.get("totalPages") or pagination.get("total_pages") or page)
            con.commit()
            if page >= total_pages:
                break
            page += 1
        con.execute(
            """
            UPDATE salla_sync_runs
            SET finished_at=?, status='success', pulled=?, linked=?, unmatched=?
            WHERE id=?
            """,
            (_iso(), pulled, linked, unmatched, run_id),
        )
        con.execute(
            "UPDATE salla_oauth_tokens SET last_success_at=?, last_error=NULL WHERE id=1",
            (_iso(),),
        )
        con.commit()
        return {"started": True, "finished": True, "pulled": pulled, "linked": linked, "unmatched": unmatched}
    except Exception as exc:
        con.execute(
            "UPDATE salla_sync_runs SET finished_at=?, status='failed', error=?, pulled=?, linked=?, unmatched=? WHERE id=?",
            (_iso(), str(exc)[:300], pulled, linked, unmatched, run_id),
        )
        con.commit()
        return {"started": True, "finished": True, "ok": False, "error": str(exc)[:300]}
    finally:
        _SYNC_RUNNING = False
        _SYNC_LOCK.release()


def verify_webhook(env: dict, raw_body: bytes, signature: str) -> bool:
    secret = env_value(env, "SALLA_WEBHOOK_SECRET")
    if not secret or not signature:
        return False
    digest = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(digest, signature.strip())


def accept_webhook(con: sqlite3.Connection, env: dict, raw_body: bytes, signature: str) -> dict:
    ensure_salla_connect_schema(con)
    if not verify_webhook(env, raw_body, signature):
        return {"ok": False, "status": 401}
    try:
        payload = json.loads(raw_body.decode("utf-8") or "{}")
    except json.JSONDecodeError:
        return {"ok": False, "status": 400}
    if not isinstance(payload, dict):
        return {"ok": False, "status": 422}
    event_name = str(payload.get("event") or "")[:80]
    event_key = hashlib.sha256(raw_body).hexdigest()
    inserted = con.execute(
        """
        INSERT OR IGNORE INTO salla_webhook_events (event_key, event_name, received_at, status)
        VALUES (?, ?, ?, 'received')
        """,
        (event_key, event_name, _iso()),
    ).rowcount
    if not inserted:
        con.commit()
        return {"ok": True, "duplicate": True}
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    try:
        if event_name.startswith("product."):
            apply_remote_product(con, data)
        elif event_name.startswith("order."):
            _apply_order(con, data)
        con.execute(
            "UPDATE salla_webhook_events SET status='processed' WHERE event_key=?",
            (event_key,),
        )
    except Exception as exc:
        con.execute(
            "UPDATE salla_webhook_events SET status='failed', error=? WHERE event_key=?",
            (str(exc)[:300], event_key),
        )
    con.commit()
    return {"ok": True, "duplicate": False}


def _apply_order(con: sqlite3.Connection, data: dict) -> None:
    order_id = str(data.get("id") or data.get("reference_id") or "").strip()
    if not order_id:
        return
    payment = data.get("payment") if isinstance(data.get("payment"), dict) else {}
    status_block = data.get("status") if isinstance(data.get("status"), dict) else {}
    payment_status = str(payment.get("status") or data.get("payment_status") or status_block.get("slug") or "")[:40]
    total = money_amount(data.get("total") if "total" in data else data.get("amounts"))
    con.execute(
        """
        INSERT INTO salla_remote_orders (
            salla_order_id, reference_id, status_name, payment_status, total_amount, currency, updated_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, 'SAR', ?, ?)
        ON CONFLICT(salla_order_id) DO UPDATE SET
            reference_id=excluded.reference_id,
            status_name=excluded.status_name,
            payment_status=excluded.payment_status,
            total_amount=excluded.total_amount,
            updated_at=excluded.updated_at,
            payload_json=excluded.payload_json
        """,
        (
            order_id,
            str(data.get("reference_id") or "")[:80],
            str(status_block.get("name") or data.get("status") or "")[:80],
            payment_status,
            total,
            _iso(),
            json.dumps({"id": order_id, "payment_status": payment_status, "total": total}, ensure_ascii=False),
        ),
    )
    if payment_status.lower() in {"paid", "completed", "succeeded"}:
        con.execute(
            """
            CREATE TABLE IF NOT EXISTS purchase_tracking_confirmations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                transaction_id TEXT NOT NULL UNIQUE,
                payment_status TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                confirmed_at TEXT NOT NULL
            )
            """
        )
        con.execute(
            """
            INSERT OR IGNORE INTO purchase_tracking_confirmations (
                transaction_id, payment_status, payload_json, confirmed_at
            ) VALUES (?, ?, ?, ?)
            """,
            (
                order_id,
                payment_status.lower(),
                json.dumps(
                    {
                        "tracking_confirmed": True,
                        "payment_status": "paid",
                        "transaction_id": order_id,
                        "currency": "SAR",
                        "value": total,
                        "items": [],
                    },
                    ensure_ascii=False,
                ),
                _iso(),
            ),
        )


def integration_status(con: sqlite3.Connection, env: dict, base_url: str) -> dict:
    ensure_salla_connect_schema(con)
    token_row = con.execute("SELECT * FROM salla_oauth_tokens WHERE id=1").fetchone()
    has_access = bool(token_row and token_row["access_token_enc"]) or bool(env_value(env, "SALLA_ACCESS_TOKEN"))
    has_refresh = bool(token_row and token_row["refresh_token_enc"]) or bool(env_value(env, "SALLA_REFRESH_TOKEN"))
    published = con.execute("SELECT COUNT(*) FROM parts WHERE status='published'").fetchone()[0]
    linked = con.execute(
        "SELECT COUNT(*) FROM salla_products WHERE sync_status='synced' AND salla_product_id IS NOT NULL AND trim(salla_product_id)!=''"
    ).fetchone()[0]
    unmatched = con.execute("SELECT COUNT(*) FROM salla_unmatched_products").fetchone()[0]
    price_conflicts = con.execute(
        """
        SELECT COUNT(*) FROM salla_products sp
        JOIN parts p ON p.id=sp.product_id
        WHERE sp.sync_status='synced'
          AND sp.last_known_price IS NOT NULL
          AND p.price IS NOT NULL
          AND ABS(p.price - sp.last_known_price) > 0.01
        """
    ).fetchone()[0]
    stock_conflicts = con.execute(
        """
        SELECT COUNT(*) FROM salla_products
        WHERE sync_status='synced' AND last_known_quantity IS NOT NULL AND last_known_quantity <= 0
        """
    ).fetchone()[0]
    last_run = con.execute(
        "SELECT started_at, finished_at, status, pulled, linked, unmatched, error FROM salla_sync_runs ORDER BY id DESC LIMIT 1"
    ).fetchone()
    recent_errors = [
        {"event": row["event_name"], "error": row["error"], "at": row["received_at"]}
        for row in con.execute(
            """
            SELECT event_name, error, received_at FROM salla_webhook_events
            WHERE status='failed' ORDER BY id DESC LIMIT 8
            """
        ).fetchall()
    ]
    connected = has_access or has_refresh
    return {
        "connected": connected,
        "needs_reauthorization": not connected,
        "reason": None if connected else "missing_access_and_refresh_token",
        "has_client": bool(env_value(env, "SALLA_CLIENT_ID") and env_value(env, "SALLA_CLIENT_SECRET")),
        "has_webhook_secret": bool(env_value(env, "SALLA_WEBHOOK_SECRET")),
        "store_id_configured": bool(env_value(env, "SALLA_STORE_ID")),
        "store_domain": env_value(env, "SALLA_STORE_DOMAIN") or None,
        "merchant_id": (token_row["merchant_id"] if token_row else None),
        "store_name": (token_row["store_name"] if token_row else None),
        "connected_at": (token_row["connected_at"] if token_row else None),
        "last_success_at": (token_row["last_success_at"] if token_row else None),
        "access_expires_at": (token_row["access_expires_at"] if token_row else None),
        "last_error": (token_row["last_error"] if token_row else None),
        "published_products": int(published),
        "linked_products": int(linked),
        "unlinked_products": max(0, int(published) - int(linked)),
        "unmatched_remote_products": int(unmatched),
        "price_conflicts": int(price_conflicts),
        "out_of_stock_linked": int(stock_conflicts),
        "sync_running": _SYNC_RUNNING,
        "last_sync": None if last_run is None else {
            "started_at": last_run["started_at"],
            "finished_at": last_run["finished_at"],
            "status": last_run["status"],
            "pulled": last_run["pulled"],
            "linked": last_run["linked"],
            "unmatched": last_run["unmatched"],
            "error": last_run["error"],
        },
        "recent_errors": recent_errors,
        "oauth_start_path": "/api/salla/oauth/start",
        "webhook_path": "/api/salla/webhook",
        "redirect_uri": redirect_uri(base_url),
        "guest_checkout_ready": bool(env_value(env, "SALLA_STORE_ID") or env_value(env, "SALLA_STORE_DOMAIN")),
        "customers_sso": "not_available_until_salla_documents_storefront_sso",
        "shipping_and_tax": "confirmed_on_salla_checkout",
        "purchase_tracking": "server_webhook_only",
    }
