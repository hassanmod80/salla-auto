#!/usr/bin/env python3
"""
Lightweight local storefront & admin API (no PHP required).
Serves Laravel-compatible JSON from SQLite + public images.
"""

from __future__ import annotations

import base64
from collections import deque
import csv
from decimal import Decimal
import difflib
import gzip
import hashlib
import io
import json
import mimetypes
import math
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from salla_connect import (
    accept_webhook,
    authorization_url,
    consume_oauth_state,
    create_oauth_state,
    exchange_authorization_code,
    integration_status,
    probe_connection,
    sync_catalog,
)
from storefront_html import collection_page, metadata as html_metadata, product_page

ROOT = Path(os.environ.get("APP_ROOT") or Path(__file__).resolve().parents[1]).resolve()
DB_PATH = Path(os.environ.get("DB_PATH") or (ROOT / "core" / "database" / "database.sqlite"))
PUBLIC = Path(os.environ.get("PUBLIC_DIR") or (ROOT / "core" / "public"))
PRIVATE_UPLOAD_DIR = Path(
    os.environ.get("PRIVATE_UPLOAD_DIR")
    or (ROOT / "private" / "checkout-verify")
).resolve()
INTERACTIONS_PATH = Path(
    os.environ.get("INTERACTIONS_PATH") or (ROOT / "tools" / ".storefront_interactions.json")
)
ENV_PATH = Path(os.environ.get("ENV_PATH") or (ROOT / "core" / ".env"))
HOST = os.environ.get("HOST", "0.0.0.0").strip() or "0.0.0.0"
PORT = int(os.environ.get("PORT", "8000"))


def _resolve_base_url() -> str:
    explicit = (
        os.environ.get("PUBLIC_BASE_URL")
        or os.environ.get("BASE_URL")
        or os.environ.get("APP_URL")
        or ""
    ).strip().rstrip("/")
    if explicit:
        return explicit
    railway_domain = (os.environ.get("RAILWAY_PUBLIC_DOMAIN") or "").strip().rstrip("/")
    if railway_domain:
        if railway_domain.startswith("http://") or railway_domain.startswith("https://"):
            return railway_domain
        return f"https://{railway_domain}"
    # Local / container fallback
    display_host = "127.0.0.1" if HOST in {"0.0.0.0", "::"} else HOST
    return f"http://{display_host}:{PORT}"


BASE_URL = _resolve_base_url()
SALLA_HTTP_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")

# Duplicate brand slugs that should appear as one storefront brand.
BRAND_SLUG_GROUPS = (
    ("baic", "baic-2"),
    ("foton", "foton-2"),
    ("lynk-co", "lynk-co-2"),
    ("bestune", "faw-bestune"),
)

_INTERACTIONS_LOCK = threading.Lock()

_RESPONSE_CACHE: dict[str, tuple[float, object]] = {}
_RESPONSE_CACHE_LOCK = threading.Lock()
_CUSTOMER_SCHEMA_READY = False
_RATE_LIMIT_LOCK = threading.Lock()
_RATE_LIMITS: dict[tuple[str, str], deque[float]] = {}

PBKDF2_ROUNDS = 600_000
MAX_JSON_BODY_BYTES = 1 * 1024 * 1024
MAX_UPLOAD_JSON_BYTES = 6 * 1024 * 1024
MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
MAX_IMAGE_SIDE = 8_000

RATE_LIMIT_POLICIES: dict[str, tuple[int, int]] = {
    "admin_login": (8, 15 * 60),
    "customer_auth": (12, 15 * 60),
    "contact": (6, 10 * 60),
    "checkout_inquiry": (10, 10 * 60),
    "vehicle_upload": (12, 10 * 60),
    "external_checkout": (20, 5 * 60),
    "interaction": (120, 5 * 60),
    "payment_webhook": (30, 5 * 60),
}

POST_RATE_BUCKETS = {
    "/api/admin/auth/login": "admin_login",
    "/api/storefront/auth/register": "customer_auth",
    "/api/storefront/auth/login": "customer_auth",
    "/api/storefront/auth/google": "customer_auth",
    "/api/contact": "contact",
    "/api/storefront/checkout-inquiry": "checkout_inquiry",
    "/api/checkout/vehicle-photo": "vehicle_upload",
    "/api/salla/checkout": "external_checkout",
    "/api/zid/checkout": "external_checkout",
    "/api/storefront/favorites": "interaction",
    "/api/storefront/comparisons": "interaction",
    "/api/internal/payment-webhook": "payment_webhook",
}


def cache_get(key: str):
    with _RESPONSE_CACHE_LOCK:
        item = _RESPONSE_CACHE.get(key)
        if not item:
            return None
        expires, value = item
        if expires < time.time():
            _RESPONSE_CACHE.pop(key, None)
            return None
        return value


def cache_set(key: str, value, ttl: float = 60.0) -> None:
    with _RESPONSE_CACHE_LOCK:
        _RESPONSE_CACHE[key] = (time.time() + ttl, value)


def normalize_sa_phone(raw: str) -> str:
    digits = re.sub(r"\D+", "", str(raw or ""))
    if digits.startswith("00"):
        digits = digits[2:]
    if digits.startswith("0") and len(digits) == 10:
        digits = "966" + digits[1:]
    if digits.startswith("5") and len(digits) == 9:
        digits = "966" + digits
    return digits


def hash_password(password: str, salt: str | None = None, rounds: int = PBKDF2_ROUNDS) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        rounds,
    )
    return f"pbkdf2_sha256${rounds}${salt}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, rounds, salt, digest = encoded.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        check = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt.encode("utf-8"), int(rounds)
        )
        return secrets.compare_digest(check.hex(), digest)
    except Exception:
        return False


def password_needs_rehash(encoded: str) -> bool:
    try:
        algo, rounds, _salt, _digest = encoded.split("$", 3)
        return algo != "pbkdf2_sha256" or int(rounds) < PBKDF2_ROUNDS
    except Exception:
        return True


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def ensure_customer_schema(con: sqlite3.Connection) -> None:
    global _CUSTOMER_SCHEMA_READY
    if _CUSTOMER_SCHEMA_READY:
        return
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS customer_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL UNIQUE,
            email TEXT,
            password_hash TEXT NOT NULL,
            city TEXT,
            address TEXT,
            created_at TEXT,
            updated_at TEXT
        )
        """
    )
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS customer_api_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            created_at TEXT,
            last_used_at TEXT,
            expires_at TEXT,
            revoked_at TEXT
        )
        """
    )
    cols = {str(r[1]) for r in con.execute("PRAGMA table_info(customer_accounts)").fetchall()}
    if "google_sub" not in cols:
        try:
            con.execute("ALTER TABLE customer_accounts ADD COLUMN google_sub TEXT")
        except Exception:
            pass
    try:
        con.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_accounts_google_sub "
            "ON customer_accounts(google_sub) WHERE google_sub IS NOT NULL AND google_sub != ''"
        )
    except Exception:
        pass
    try:
        con.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_accounts_email "
            "ON customer_accounts(email) WHERE email IS NOT NULL AND email != ''"
        )
    except Exception:
        pass
    token_cols = {
        str(r[1]) for r in con.execute("PRAGMA table_info(customer_api_tokens)").fetchall()
    }
    if "expires_at" not in token_cols:
        try:
            con.execute("ALTER TABLE customer_api_tokens ADD COLUMN expires_at TEXT")
        except Exception:
            pass
    # Legacy non-expiring sessions receive a short grace window instead of
    # remaining valid forever.
    try:
        con.execute(
            """
            UPDATE customer_api_tokens
            SET expires_at=datetime('now','+7 days')
            WHERE expires_at IS NULL AND revoked_at IS NULL
            """
        )
    except Exception:
        pass
    cols = {str(r[1]) for r in con.execute("PRAGMA table_info(checkout_inquiries)").fetchall()}
    if cols and "customer_id" not in cols:
        try:
            con.execute("ALTER TABLE checkout_inquiries ADD COLUMN customer_id INTEGER")
        except Exception:
            pass
    con.commit()
    _CUSTOMER_SCHEMA_READY = True


def customer_public(row) -> dict:
    phone = row["phone"] if "phone" in row.keys() else None
    google_sub = None
    try:
        google_sub = row["google_sub"]
    except Exception:
        google_sub = None
    return {
        "id": row["id"],
        "name": row["name"],
        "phone": phone if is_real_customer_phone(phone) else "",
        "email": row["email"],
        "city": row["city"],
        "address": row["address"],
        "auth_provider": "google" if google_sub else "phone",
        "needs_phone": False,
    }


def issue_customer_token(con: sqlite3.Connection, customer_id: int) -> str:
    token = secrets.token_urlsafe(32)
    con.execute(
        """
        INSERT INTO customer_api_tokens
            (customer_id, token_hash, created_at, last_used_at, expires_at)
        VALUES (?, ?, datetime('now'), datetime('now'), datetime('now','+30 days'))
        """,
        (customer_id, hash_token(token)),
    )
    con.commit()
    return token


def customer_from_auth_header(con: sqlite3.Connection, auth_header: str | None):
    if not auth_header:
        return None
    raw = auth_header.strip()
    if raw.lower().startswith("bearer "):
        raw = raw[7:].strip()
    if not raw:
        return None
    ensure_customer_schema(con)
    th = hash_token(raw)
    row = con.execute(
        """
        SELECT c.*
        FROM customer_api_tokens t
        JOIN customer_accounts c ON c.id = t.customer_id
        WHERE t.token_hash = ? AND t.revoked_at IS NULL
          AND t.expires_at IS NOT NULL
          AND datetime(t.expires_at) > datetime('now')
        LIMIT 1
        """,
        (th,),
    ).fetchone()
    if row:
        con.execute(
            "UPDATE customer_api_tokens SET last_used_at=datetime('now') WHERE token_hash=?",
            (th,),
        )
        con.commit()
    return row



def load_interactions_store() -> dict:
    with _INTERACTIONS_LOCK:
        if not INTERACTIONS_PATH.exists():
            return {"sessions": {}}
        try:
            data = json.loads(INTERACTIONS_PATH.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return {"sessions": {}}
            sessions = data.get("sessions")
            if not isinstance(sessions, dict):
                data["sessions"] = {}
            return data
        except Exception:
            return {"sessions": {}}


def save_interactions_store(data: dict) -> None:
    with _INTERACTIONS_LOCK:
        INTERACTIONS_PATH.parent.mkdir(parents=True, exist_ok=True)
        INTERACTIONS_PATH.write_text(
            json.dumps(data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


def session_bucket(store: dict, session_id: str) -> dict:
    sessions = store.setdefault("sessions", {})
    bucket = sessions.get(session_id)
    if not isinstance(bucket, dict):
        bucket = {"favorites": [], "comparisons": []}
        sessions[session_id] = bucket
    bucket.setdefault("favorites", [])
    bucket.setdefault("comparisons", [])
    bucket["favorites"] = [int(x) for x in bucket["favorites"] if str(x).isdigit() or isinstance(x, int)]
    bucket["comparisons"] = [int(x) for x in bucket["comparisons"] if str(x).isdigit() or isinstance(x, int)]
    return bucket


def products_by_ids(con: sqlite3.Connection, ids: list[int]) -> list[dict]:
    out: list[dict] = []
    for pid in ids:
        row = con.execute("SELECT * FROM parts WHERE id=?", (pid,)).fetchone()
        if row:
            out.append(product_payload(con, row))
    return out


def load_env_map() -> dict[str, str]:
    out: dict[str, str] = {}
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip().strip('"').strip("'")
    # Process/Railway environment wins over local .env file.
    for key, value in os.environ.items():
        if key.startswith(("SALLA_", "ZID_", "PUBLIC_", "BASE_", "APP_", "GOOGLE_")) and str(value).strip():
            out[key] = str(value).strip()
    return out


def configured_allowed_origins() -> set[str]:
    values = {
        _resolve_base_url().rstrip("/"),
        "https://chinapartsksa.com",
    }
    raw = str(
        os.environ.get("ALLOWED_ORIGINS")
        or load_env_map().get("ALLOWED_ORIGINS")
        or ""
    ).strip()
    for value in raw.split(","):
        origin = value.strip().rstrip("/")
        if origin.startswith(("http://", "https://")):
            values.add(origin)
    if _resolve_base_url().startswith("http://"):
        values.update(
            {
                f"http://127.0.0.1:{PORT}",
                f"http://localhost:{PORT}",
            }
        )
    return values


def rate_limit_check(client_key: str, bucket: str) -> tuple[bool, int]:
    limit, window_seconds = RATE_LIMIT_POLICIES[bucket]
    now = time.monotonic()
    key = (client_key, bucket)
    with _RATE_LIMIT_LOCK:
        entries = _RATE_LIMITS.setdefault(key, deque())
        cutoff = now - window_seconds
        while entries and entries[0] <= cutoff:
            entries.popleft()
        if len(entries) >= limit:
            retry_after = max(1, int(window_seconds - (now - entries[0])) + 1)
            return False, retry_after
        entries.append(now)
        if len(_RATE_LIMITS) > 10_000:
            stale = [
                old_key
                for old_key, old_entries in _RATE_LIMITS.items()
                if not old_entries or old_entries[-1] <= cutoff
            ][:2_000]
            for old_key in stale:
                _RATE_LIMITS.pop(old_key, None)
    return True, 0


def checkout_upload_filename(value: str | None) -> str | None:
    raw = str(value or "").strip()
    if raw.startswith(("http://", "https://")):
        try:
            raw = urllib.parse.urlparse(raw).path
        except Exception:
            return None
    prefixes = (
        "private://checkout-verify/",
        "/images/checkout-verify/",
        "images/checkout-verify/",
    )
    for prefix in prefixes:
        if raw.startswith(prefix):
            raw = raw[len(prefix):]
            break
    else:
        return None
    filename = Path(urllib.parse.unquote(raw)).name
    if filename != urllib.parse.unquote(raw) or not re.fullmatch(
        r"[a-z0-9][a-z0-9._-]{10,180}\.(?:jpe?g|png|webp)",
        filename,
        re.I,
    ):
        return None
    return filename


def private_checkout_path(filename: str) -> str:
    return f"private://checkout-verify/{filename}"


def admin_checkout_file_url(value: str | None) -> str | None:
    filename = checkout_upload_filename(value)
    if not filename:
        return None
    return f"{_resolve_base_url()}/api/admin/checkout-files/{urllib.parse.quote(filename)}"


def google_client_id() -> str:
    return (load_env_map().get("GOOGLE_CLIENT_ID") or os.environ.get("GOOGLE_CLIENT_ID") or "").strip()


def google_auth_config_payload() -> dict:
    client_id = google_client_id()
    return {
        "success": True,
        "enabled": bool(client_id),
        "client_id": client_id or None,
    }


def verify_google_id_token(id_token: str, audience: str) -> dict:
    """Verify Google Identity Services ID token via Google tokeninfo endpoint."""
    import urllib.error
    import urllib.request

    token = str(id_token or "").strip()
    if not token or not audience:
        raise ValueError("missing_token")
    url = "https://oauth2.googleapis.com/tokeninfo?" + urllib.parse.urlencode({"id_token": token})
    req = urllib.request.Request(url, method="GET")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
    except urllib.error.HTTPError as exc:
        raise ValueError("invalid_google_token") from exc
    except Exception as exc:
        raise ValueError("google_verify_failed") from exc
    if not isinstance(data, dict):
        raise ValueError("invalid_google_payload")
    aud = str(data.get("aud") or "")
    if aud != audience:
        raise ValueError("invalid_audience")
    email = str(data.get("email") or "").strip().lower()
    sub = str(data.get("sub") or "").strip()
    if not sub or not email:
        raise ValueError("missing_google_profile")
    verified = str(data.get("email_verified") or "").lower() in {"true", "1", "yes"}
    if not verified:
        raise ValueError("email_not_verified")
    return {
        "sub": sub,
        "email": email,
        "name": str(data.get("name") or data.get("given_name") or email.split("@")[0]).strip()[:120],
        "picture": str(data.get("picture") or "").strip() or None,
    }


def verify_google_access_token(access_token: str) -> dict:
    """Resolve Google profile from an OAuth access token."""
    import urllib.error
    import urllib.request

    token = str(access_token or "").strip()
    if not token:
        raise ValueError("missing_token")
    req = urllib.request.Request("https://www.googleapis.com/oauth2/v3/userinfo")
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
    except urllib.error.HTTPError as exc:
        raise ValueError("invalid_google_token") from exc
    except Exception as exc:
        raise ValueError("google_verify_failed") from exc
    if not isinstance(data, dict):
        raise ValueError("invalid_google_payload")
    email = str(data.get("email") or "").strip().lower()
    sub = str(data.get("sub") or "").strip()
    if not sub or not email:
        raise ValueError("missing_google_profile")
    verified = data.get("email_verified")
    if verified not in (True, "true", "1", 1):
        raise ValueError("email_not_verified")
    return {
        "sub": sub,
        "email": email,
        "name": str(data.get("name") or data.get("given_name") or email.split("@")[0]).strip()[:120],
        "picture": str(data.get("picture") or "").strip() or None,
    }


def is_real_customer_phone(phone: str | None) -> bool:
    raw = str(phone or "").strip()
    if not raw or raw.startswith("ggl"):
        return False
    normalized = normalize_sa_phone(raw)
    return normalized.startswith("966") and len(normalized) == 12


def google_placeholder_phone(sub: str) -> str:
    digest = hashlib.sha256(f"google:{sub}".encode("utf-8")).hexdigest()[:12]
    return f"ggl{digest}"


def salla_config() -> dict[str, str]:
    env = load_env_map()
    return {
        "access_token": env.get("SALLA_ACCESS_TOKEN", "").strip(),
        "store_id": env.get("SALLA_STORE_ID", "").strip(),
        "store_domain": env.get("SALLA_STORE_DOMAIN", "").rstrip("/"),
        "base_url": (env.get("SALLA_BASE_URL") or "https://api.salla.dev/admin/v2").rstrip("/"),
        "checkout_base_url": (env.get("SALLA_CHECKOUT_BASE_URL") or "https://api.salla.dev/store/v2/checkout").rstrip("/"),
    }


def salla_checkout_sku(product_id: int | str) -> str:
    """Deterministic SKU used in Salla Excel import and Guest Checkout."""
    return f"QETAA-{int(product_id)}"


def salla_checkout_by_sku_enabled() -> bool:
    """
    Link every local product to Salla via SKU QETAA-{id} after bulk import.
    Default ON when Store-Identifier exists and Partners token does not.
    Override with SALLA_CHECKOUT_BY_SKU=0/1.
    """
    env = load_env_map()
    raw = (env.get("SALLA_CHECKOUT_BY_SKU") or "").strip().lower()
    if raw in {"0", "false", "no", "off"}:
        return False
    if raw in {"1", "true", "yes", "on"}:
        return True
    cfg = salla_config()
    return bool(cfg.get("store_id")) and not bool(cfg.get("access_token"))


def resolve_salla_checkout_id(product_id: int | str, mapped_salla_id: str | None) -> str | None:
    mapped = str(mapped_salla_id or "").strip()
    if mapped:
        return mapped
    # Guest Checkout identifies imported products by QETAA-{id} when no Partners token exists.
    cfg = salla_config()
    if salla_checkout_by_sku_enabled() and (cfg.get("store_id") or cfg.get("store_domain")):
        return salla_checkout_sku(product_id)
    return None


def salla_item_identifier(salla_ref: str) -> tuple[str, str]:
    """Return (identifier_type, identifier) for Guest Checkout add-item."""
    ref = str(salla_ref or "").strip()
    if ref.upper().startswith("QETAA-"):
        return "sku", ref
    return "id", ref


def salla_status_payload() -> dict:
    cfg = salla_config()
    has_token = bool(cfg["access_token"])
    has_store_id = bool(cfg["store_id"])
    has_domain = bool(cfg["store_domain"])
    sku_mode = salla_checkout_by_sku_enabled()
    # Guest Checkout API works with Store-Identifier alone (no Partners token).
    if has_store_id:
        mode = "salla_checkout_api" if has_token else "salla_guest_checkout_api"
        if sku_mode and not has_token:
            mode = "salla_guest_checkout_by_sku"
    elif has_domain:
        mode = "salla_store_deeplink"
    else:
        mode = "unavailable"
    return {
        "success": True,
        "checkout_ready": bool(has_store_id or has_domain),
        "live_recommended": bool(has_store_id or has_domain),
        "has_access_token": has_token,
        "has_store_id": has_store_id,
        "has_store_domain": has_domain,
        "checkout_by_sku": sku_mode,
        "mode": mode,
        "store_domain": cfg["store_domain"] or None,
        "partners_required": False,
    }


def ensure_salla_product_mappings(con: sqlite3.Connection) -> dict:
    """
    Keep only known-good Salla product IDs and seed one local product so
    storefront → Salla payment works without Partners sync.
    Env: SALLA_KNOWN_PRODUCT_IDS=1232198681
    Skipped when SALLA_CHECKOUT_BY_SKU is active (full catalog links via SKU).
    """
    if salla_checkout_by_sku_enabled():
        return {"skipped": True, "reason": "salla_checkout_by_sku"}
    env = load_env_map()
    raw = (env.get("SALLA_KNOWN_PRODUCT_IDS") or env.get("SALLA_SEED_PRODUCT_ID") or "").strip()
    known = [x.strip() for x in raw.split(",") if x.strip()]
    if not known:
        return {"skipped": True, "reason": "no SALLA_KNOWN_PRODUCT_IDS"}

    known_set = set(known)
    try:
        cols = {str(r[1]) for r in con.execute("PRAGMA table_info(parts)").fetchall()}
    except Exception:
        return {"skipped": True, "reason": "no parts table"}

    removed = 0
    has_salla_table = bool(
        con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='salla_products'"
        ).fetchone()
    )
    if has_salla_table:
        for row in con.execute("SELECT id, salla_product_id FROM salla_products").fetchall():
            sid = str(row["salla_product_id"] or "").strip()
            if sid not in known_set:
                con.execute("DELETE FROM salla_products WHERE id=?", (row["id"],))
                removed += 1

    if "salla_product_id" in cols:
        placeholders = ",".join("?" for _ in known)
        con.execute(
            f"""
            UPDATE parts
            SET salla_product_id=NULL
            WHERE salla_product_id IS NOT NULL
              AND trim(salla_product_id) != ''
              AND salla_product_id NOT IN ({placeholders})
            """,
            known,
        )

    mapped_count = 0
    if "salla_product_id" in cols:
        mapped_count = int(
            con.execute(
                """
                SELECT count(*) FROM parts
                WHERE salla_product_id IS NOT NULL AND trim(salla_product_id) != ''
                """
            ).fetchone()[0]
        )

    seeded = None
    if mapped_count == 0:
        seed_id = known[0]
        row = con.execute(
            """
            SELECT id FROM parts
            WHERE status='published'
            ORDER BY id DESC
            LIMIT 1
            """
        ).fetchone()
        if row:
            pid = int(row["id"])
            if "salla_product_id" in cols:
                con.execute("UPDATE parts SET salla_product_id=? WHERE id=?", (seed_id, pid))
            if has_salla_table:
                existing = con.execute(
                    "SELECT id FROM salla_products WHERE product_id=? LIMIT 1", (pid,)
                ).fetchone()
                if existing:
                    con.execute(
                        """
                        UPDATE salla_products
                        SET salla_product_id=?, sync_status='synced',
                            last_known_quantity=10, updated_at=datetime('now')
                        WHERE product_id=?
                        """,
                        (seed_id, pid),
                    )
                else:
                    con.execute(
                        """
                        INSERT INTO salla_products
                        (product_id, salla_product_id, sync_status, last_known_price,
                         last_known_quantity, last_synced_at, payload_json, created_at, updated_at)
                        VALUES (?, ?, 'synced', 50, 10, datetime('now'), '{}', datetime('now'), datetime('now'))
                        """,
                        (pid, seed_id),
                    )
            seeded = {"product_id": pid, "salla_product_id": seed_id}
            mapped_count = 1

    con.commit()
    return {
        "removed_stale": removed,
        "mapped_count": mapped_count,
        "seeded": seeded,
        "known": known,
    }


def _salla_http_json(method: str, url: str, *, headers: dict | None = None, body: dict | None = None) -> tuple[int, dict]:
    import urllib.error
    import urllib.request

    raw = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=raw, method=method.upper())
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", SALLA_HTTP_UA)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        if value:
            req.add_header(key, str(value))
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
            return int(resp.status), payload if isinstance(payload, dict) else {}
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8", errors="replace") or "{}")
        except Exception:
            payload = {"message": str(exc)}
        return int(exc.code), payload if isinstance(payload, dict) else {"message": str(exc)}


def salla_checkout_headers(cfg: dict[str, str]) -> dict[str, str]:
    headers = {
        "Store-Identifier": cfg["store_id"],
        "s-source": "app",
        "s-app-name": "qetaa-aljanoob",
        "s-app-version": "1.0.0",
    }
    if cfg.get("access_token"):
        headers["Authorization"] = f"Bearer {cfg['access_token']}"
    return headers


def create_salla_deeplink_checkout(cfg: dict[str, str], items: list[dict]) -> dict:
    domain = cfg.get("store_domain") or ""
    if not domain:
        raise RuntimeError("إعدادات سلة غير مكتملة. أضف SALLA_STORE_DOMAIN.")
    query: dict[str, str | int] = {}
    for index, item in enumerate(items):
        query[f"products[{index}][id]"] = item["salla_product_id"]
        query[f"products[{index}][quantity]"] = item["quantity"]
    return {
        "checkout_url": f"{domain}/cart/multi-product?{urllib.parse.urlencode(query)}",
        "cart_id": None,
        "mode": "salla_store_deeplink",
    }


def create_salla_api_checkout(cfg: dict[str, str], items: list[dict], con: sqlite3.Connection) -> dict:
    if not cfg.get("store_id"):
        raise RuntimeError("SALLA_STORE_ID غير مضبوط.")

    status, generate = _salla_http_json(
        "POST",
        f"{cfg['checkout_base_url']}/generate",
        headers=salla_checkout_headers(cfg),
        body={},
    )
    if status >= 400 or not generate.get("success", True):
        raise RuntimeError(
            (generate.get("error") or {}).get("message")
            or generate.get("message")
            or "تعذر إنشاء سلة مشتريات في منصة سلة."
        )

    data = generate.get("data") if isinstance(generate.get("data"), dict) else generate
    cart_id = str(data.get("id") or "")
    checkout_url = str(data.get("checkout_url") or data.get("url") or "")
    if not cart_id:
        raise RuntimeError("استجابة سلة لا تحتوي على معرف السلة.")

    for item in items:
        id_type, identifier = salla_item_identifier(str(item["salla_product_id"]))
        add_body = {
            "identifier_type": id_type,
            "identifier": identifier,
            "quantity": item["quantity"],
        }
        add_status, add_payload = _salla_http_json(
            "POST",
            f"{cfg['checkout_base_url']}/{cart_id}/items",
            headers=salla_checkout_headers(cfg),
            body=add_body,
        )
        if add_status < 400:
            continue

        # If we already tried SKU, don't invent another identifier.
        if id_type == "sku":
            msg = (
                ((add_payload.get("error") or {}).get("message") if isinstance(add_payload, dict) else None)
                or add_payload.get("message")
                or "تعذر إضافة أحد المنتجات إلى سلة سلة."
            )
            raise RuntimeError(str(msg))

        mapping = con.execute(
            "SELECT payload_json FROM salla_products WHERE salla_product_id=? LIMIT 1",
            (str(item["salla_product_id"]),),
        ).fetchone()
        sku = ""
        if mapping and mapping["payload_json"]:
            try:
                payload = json.loads(mapping["payload_json"])
                sku = str(
                    (payload.get("sku") if isinstance(payload, dict) else None)
                    or ((payload.get("data") or {}).get("sku") if isinstance(payload, dict) else None)
                    or ""
                )
            except Exception:
                sku = ""
        if not sku:
            msg = (
                ((add_payload.get("error") or {}).get("message") if isinstance(add_payload, dict) else None)
                or add_payload.get("message")
                or "تعذر إضافة أحد المنتجات إلى سلة سلة."
            )
            raise RuntimeError(str(msg))

        retry_status, retry_payload = _salla_http_json(
            "POST",
            f"{cfg['checkout_base_url']}/{cart_id}/items",
            headers=salla_checkout_headers(cfg),
            body={
                "identifier_type": "sku",
                "identifier": sku,
                "quantity": item["quantity"],
            },
        )
        if retry_status >= 400:
            msg = (
                ((retry_payload.get("error") or {}).get("message") if isinstance(retry_payload, dict) else None)
                or retry_payload.get("message")
                or "تعذر إضافة أحد المنتجات إلى سلة سلة."
            )
            raise RuntimeError(str(msg))

    if not checkout_url:
        get_status, cart_payload = _salla_http_json(
            "GET",
            f"{cfg['checkout_base_url']}/{cart_id}?include_items=true",
            headers=salla_checkout_headers(cfg),
        )
        if get_status < 400:
            cart_data = cart_payload.get("data") if isinstance(cart_payload.get("data"), dict) else cart_payload
            checkout_url = str((cart_data or {}).get("checkout_url") or "")

    if not checkout_url and cfg.get("store_domain"):
        checkout_url = f"{cfg['store_domain']}/checkout/{cart_id}"

    if not checkout_url:
        raise RuntimeError("تعذر الحصول على رابط الدفع من سلة.")

    return {
        "checkout_url": checkout_url,
        "cart_id": cart_id,
        "mode": "salla_checkout_api",
    }


def handle_salla_checkout(con: sqlite3.Connection, body: dict) -> dict:
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise RuntimeError("السلة فارغة.")

    items: list[dict] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        local_pid = raw.get("product_id") or raw.get("id")
        try:
            local_pid = int(local_pid)
            qty = int(raw.get("quantity") or 1)
        except (TypeError, ValueError):
            raise RuntimeError("معرف أو كمية غير صالحة لأحد المنتجات.")
        if qty < 1 or qty > 50:
            raise RuntimeError("كمية غير صالحة لأحد المنتجات.")
        mapped = con.execute(
            """
            SELECT sp.salla_product_id, sp.sync_status, sp.last_known_quantity,
                   sp.last_known_price, p.price AS local_price
            FROM salla_products sp
            JOIN parts p ON p.id=sp.product_id
            WHERE sp.product_id=? AND sp.sync_status='synced'
              AND p.status='published'
            LIMIT 1
            """,
            (local_pid,),
        ).fetchone()
        if not mapped or not mapped["salla_product_id"]:
            if salla_checkout_by_sku_enabled() and salla_config().get("store_id"):
                published = con.execute(
                    "SELECT status FROM parts WHERE id=? AND status='published'",
                    (local_pid,),
                ).fetchone()
                if published is None:
                    raise RuntimeError("أحد المنتجات غير منشور ولا يمكن إتمام الدفع.")
                items.append({"salla_product_id": salla_checkout_sku(local_pid), "quantity": qty})
                continue
            raise RuntimeError("أحد المنتجات غير متزامن مع سلة ولا يمكن إتمام الدفع.")
        stock = mapped["last_known_quantity"]
        if stock is None or int(stock) < qty:
            raise RuntimeError("المخزون المؤكد لا يغطي الكمية المطلوبة.")
        remote_price = mapped["last_known_price"]
        if mapped["local_price"] is None or remote_price is None or abs(
            Decimal(str(mapped["local_price"])) - Decimal(str(remote_price))
        ) > Decimal("0.01"):
            raise RuntimeError("سعر أحد المنتجات في سلة لا يطابق سعر المتجر.")
        sid = (
            salla_checkout_sku(local_pid)
            if salla_checkout_by_sku_enabled()
            else str(mapped["salla_product_id"]).strip()
        )
        items.append({"salla_product_id": sid, "quantity": qty})

    if not items:
        raise RuntimeError("السلة فارغة.")

    cfg = salla_config()
    has_store_id = bool(cfg.get("store_id"))

    # Prefer Checkout API whenever Store-Identifier is available (works without Partners token).
    if has_store_id:
        try:
            return create_salla_api_checkout(cfg, items, con)
        except RuntimeError as api_error:
            sku_items = any(str(i["salla_product_id"]).upper().startswith("QETAA-") for i in items)
            # Deeplink only accepts numeric Salla product IDs.
            if cfg.get("store_domain") and not sku_items:
                deeplink = create_salla_deeplink_checkout(cfg, items)
                deeplink["warning"] = str(api_error)
                return deeplink
            raise

    if not cfg.get("store_domain"):
        raise RuntimeError("أضف SALLA_STORE_ID أو SALLA_STORE_DOMAIN لإتمام الدفع عبر سلة.")
    if any(str(i["salla_product_id"]).upper().startswith("QETAA-") for i in items):
        raise RuntimeError("الدفع عبر SKU يتطلب SALLA_STORE_ID وواجهة Checkout API.")
    return create_salla_deeplink_checkout(cfg, items)


def zid_config() -> dict[str, str]:
    env = load_env_map()
    mock = env.get("ZID_MOCK", "").strip().lower() in {"1", "true", "yes", "on"}
    return {
        "client_id": env.get("ZID_CLIENT_ID", "").strip(),
        "client_secret": env.get("ZID_CLIENT_SECRET", "").strip(),
        "authorization": env.get("ZID_AUTHORIZATION", "").strip(),
        "manager_token": env.get("ZID_MANAGER_TOKEN", "").strip(),
        "store_id": env.get("ZID_STORE_ID", "").strip(),
        "base_url": (env.get("ZID_BASE_URL") or "https://api.zid.sa/v1").rstrip("/"),
        "oauth_url": (env.get("ZID_OAUTH_URL") or "https://oauth.zid.sa").rstrip("/"),
        "redirect_uri": env.get("ZID_REDIRECT_URI", "").strip(),
        "payment_method_id": env.get("ZID_PAYMENT_METHOD_ID", "").strip(),
        "shipping_method_id": env.get("ZID_SHIPPING_METHOD_ID", "").strip(),
        "store_domain": env.get("ZID_STORE_DOMAIN", "").rstrip("/"),
        "mock": "1" if mock else "",
    }


def zid_status_payload() -> dict:
    cfg = zid_config()
    ready = bool(cfg["mock"]) or bool(cfg["authorization"] and cfg["manager_token"] and cfg["store_id"])
    return {
        "success": True,
        "checkout_ready": ready,
        "live_recommended": ready and not bool(cfg["mock"]),
        "has_authorization": bool(cfg["authorization"]),
        "has_manager_token": bool(cfg["manager_token"]),
        "has_store_id": bool(cfg["store_id"]),
        "has_client_id": bool(cfg["client_id"]),
        "mock": bool(cfg["mock"]),
        "mode": ("zid_mock" if cfg["mock"] else ("zid_payment_link" if ready else "unavailable")),
        "oauth_start_url": "http://127.0.0.1:8766/oauth/start",
    }


def zid_headers(cfg: dict[str, str], *, include_store: bool = True) -> dict[str, str]:
    auth = cfg.get("authorization") or ""
    if auth and not auth.lower().startswith("bearer "):
        auth = f"Bearer {auth}"
    headers = {
        "Accept": "application/json",
        "Accept-Language": "ar",
        "Authorization": auth,
        "X-MANAGER-TOKEN": cfg.get("manager_token") or "",
        "Role": "Manager",
        "User-Agent": SALLA_HTTP_UA,
    }
    if include_store and cfg.get("store_id"):
        headers["Store-Id"] = cfg["store_id"]
    return headers


def _zid_http_json(method: str, url: str, *, headers: dict | None = None, body: dict | None = None) -> tuple[int, dict]:
    import urllib.error
    import urllib.request

    raw = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=raw, method=method.upper())
    if body is not None:
        req.add_header("Content-Type", "application/json")
    for key, value in (headers or {}).items():
        if value:
            req.add_header(key, str(value))
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace") or "{}")
            return int(resp.status), payload if isinstance(payload, dict) else {}
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read().decode("utf-8", errors="replace") or "{}")
        except Exception:
            payload = {"message": str(exc)}
        return int(exc.code), payload if isinstance(payload, dict) else {"message": str(exc)}


def ensure_zid_schema(con: sqlite3.Connection) -> None:
    cols = {row[1] for row in con.execute("PRAGMA table_info(parts)")}
    if "zid_product_id" not in cols:
        con.execute("ALTER TABLE parts ADD COLUMN zid_product_id TEXT")
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS zid_products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            zid_product_id TEXT NOT NULL,
            zid_sku TEXT,
            sync_status TEXT DEFAULT 'pending',
            last_known_price REAL,
            last_known_quantity INTEGER,
            last_synced_at TEXT,
            payload_json TEXT,
            created_at TEXT,
            updated_at TEXT
        )
        """
    )
    con.execute("CREATE INDEX IF NOT EXISTS idx_zid_products_product_id ON zid_products(product_id)")
    con.execute("CREATE INDEX IF NOT EXISTS idx_zid_products_zid_id ON zid_products(zid_product_id)")
    con.commit()


def _zid_list_rows(payload: dict) -> list:
    """Normalize Zid list responses (payload / results / data wrappers)."""
    if not isinstance(payload, dict):
        return []
    for key in ("payload", "results", "data", "payment_methods", "shipping_methods"):
        rows = payload.get(key)
        if isinstance(rows, list):
            return rows
        if isinstance(rows, dict):
            for nested in ("payment_methods", "shipping_methods", "data", "results", "payload"):
                inner = rows.get(nested)
                if isinstance(inner, list):
                    return inner
    return []


def resolve_zid_payment_method_id(cfg: dict[str, str]) -> int:
    if cfg.get("payment_method_id") and str(cfg["payment_method_id"]).isdigit():
        return int(cfg["payment_method_id"])
    status, payload = _zid_http_json(
        "GET",
        f"{cfg['base_url']}/managers/store/payment-methods",
        headers=zid_headers(cfg),
    )
    if status >= 400:
        raise RuntimeError(
            (payload.get("message") if isinstance(payload, dict) else None)
            or "تعذر جلب طرق الدفع من زد."
        )
    rows = _zid_list_rows(payload if isinstance(payload, dict) else {})
    preferred = None
    for row in rows:
        if not isinstance(row, dict) or row.get("id") is None:
            continue
        if row.get("enabled") is False:
            continue
        code = str(row.get("code") or "")
        if code == "payment_link.zidpay" or row.get("type") == "payment_link":
            return int(row["id"])
        if preferred is None and code.startswith("payment_link"):
            preferred = int(row["id"])
    if preferred is not None:
        return preferred
    raise RuntimeError("لم يتم العثور على طريقة دفع payment_link.zidpay في متجر زد.")


def resolve_zid_shipping_method_id(cfg: dict[str, str]) -> int:
    if cfg.get("shipping_method_id") and str(cfg["shipping_method_id"]).isdigit():
        return int(cfg["shipping_method_id"])
    status, payload = _zid_http_json(
        "GET",
        f"{cfg['base_url']}/managers/store/shipping-methods",
        headers=zid_headers(cfg),
    )
    if status >= 400:
        # Fallback to inventory pickup style id if shipping list unavailable.
        raise RuntimeError(
            (payload.get("message") if isinstance(payload, dict) else None)
            or "تعذر جلب طرق الشحن من زد. أضف ZID_SHIPPING_METHOD_ID في .env"
        )
    rows = _zid_list_rows(payload if isinstance(payload, dict) else {})
    for row in rows:
        if isinstance(row, dict) and row.get("id") is not None:
            if row.get("enabled") is False:
                continue
            return int(row["id"])
    raise RuntimeError("لا توجد طرق شحن مفعلة في متجر زد.")


def extract_zid_payment_url(payload: dict) -> str:
    order = payload.get("order") if isinstance(payload.get("order"), dict) else payload
    if not isinstance(order, dict):
        return ""
    for key in ("payment_link", "payment_url", "checkout_url", "invoice_url"):
        value = order.get(key)
        if isinstance(value, str) and value.startswith("http"):
            return value
        if isinstance(value, dict):
            for nested in ("url", "link", "href"):
                n = value.get(nested)
                if isinstance(n, str) and n.startswith("http"):
                    return n
    payment = order.get("payment") if isinstance(order.get("payment"), dict) else {}
    for key in ("url", "link", "payment_link"):
        value = payment.get(key)
        if isinstance(value, str) and value.startswith("http"):
            return value
    return ""


def handle_zid_checkout(con: sqlite3.Connection, body: dict) -> dict:
    ensure_zid_schema(con)
    raw_items = body.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        raise RuntimeError("السلة فارغة.")

    items: list[dict] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        zid_id = str(raw.get("zid_product_id") or "").strip()
        sku = str(raw.get("zid_sku") or raw.get("sku") or "").strip()
        local_id = raw.get("id") or raw.get("product_id")
        try:
            qty = int(raw.get("quantity") or 1)
        except (TypeError, ValueError):
            qty = 1
        if qty < 1 or qty > 50:
            raise RuntimeError("كمية غير صالحة لأحد المنتجات.")
        mapped = None
        if zid_id:
            mapped = con.execute(
                """
                SELECT product_id, zid_product_id, zid_sku, sync_status,
                       last_known_quantity, last_known_price
                FROM zid_products
                WHERE zid_product_id=? AND sync_status='synced'
                LIMIT 1
                """,
                (zid_id,),
            ).fetchone()
        if not mapped and sku:
            mapped = con.execute(
                """
                SELECT product_id, zid_product_id, zid_sku, sync_status,
                       last_known_quantity, last_known_price
                FROM zid_products
                WHERE zid_sku=? AND sync_status='synced'
                LIMIT 1
                """,
                (sku,),
            ).fetchone()
        if not mapped and local_id is not None and str(local_id).isdigit():
            mapped = con.execute(
                """
                SELECT product_id, zid_product_id, zid_sku, sync_status,
                       last_known_quantity, last_known_price
                FROM zid_products
                WHERE product_id=? AND sync_status='synced'
                LIMIT 1
                """,
                (int(local_id),),
            ).fetchone()
        if not mapped:
            raise RuntimeError("أحد المنتجات غير مرتبط بزد.")
        stock = mapped["last_known_quantity"]
        if stock is None or int(stock) < qty:
            raise RuntimeError("المخزون المؤكد لا يغطي الكمية المطلوبة.")
        local = con.execute(
            "SELECT price FROM parts WHERE id=? AND status='published' LIMIT 1",
            (int(mapped["product_id"]),),
        ).fetchone()
        if (
            not local
            or local["price"] is None
            or mapped["last_known_price"] is None
            or abs(
                Decimal(str(local["price"]))
                - Decimal(str(mapped["last_known_price"]))
            ) > Decimal("0.01")
        ):
            raise RuntimeError("سعر أحد المنتجات في زد لا يطابق سعر المتجر.")
        items.append(
            {
                "zid_product_id": str(mapped["zid_product_id"]),
                "sku": str(mapped["zid_sku"] or sku or mapped["zid_product_id"]),
                "quantity": qty,
            }
        )

    if not items:
        raise RuntimeError("السلة فارغة.")

    cfg = zid_config()
    if cfg.get("mock"):
        skus = ",".join(item["sku"] for item in items)
        return {
            "checkout_url": f"http://127.0.0.1:8000/zid-mock-pay.html?skus={skus}",
            "order_id": f"mock-{items[0]['zid_product_id']}",
            "mode": "zid_mock",
            "provider": "zid",
        }

    if not (cfg["authorization"] and cfg["manager_token"] and cfg["store_id"]):
        raise RuntimeError("إعدادات زد غير مكتملة. أكمل OAuth أولاً.")

    customer = body.get("customer") if isinstance(body.get("customer"), dict) else {}
    full_name = str(customer.get("full_name") or body.get("customer_name") or "عميل قطع الجنوب").strip()
    mobile = str(customer.get("mobile_number") or body.get("customer_phone") or "500000000").strip()
    email = str(customer.get("email") or body.get("customer_email") or "orders@qetaa-aljanoob.sa").strip()
    city = str(customer.get("city_name") or body.get("city") or "Riyadh").strip()

    payment_method_id = resolve_zid_payment_method_id(cfg)
    shipping_method_id = resolve_zid_shipping_method_id(cfg)

    from datetime import datetime, timedelta, timezone

    expiry = (datetime.now(timezone.utc) + timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    draft = {
        "currency_code": "SAR",
        "coupon_code": None,
        "created_by": "api",
        "customer": {
            "full_name": full_name,
            "mobile_country_code": "966",
            "mobile_number": mobile.lstrip("0"),
            "email": email,
        },
        "consignee": {
            "contact": {
                "full_name": full_name,
                "mobile_country_code": "966",
                "mobile_number": mobile.lstrip("0"),
                "email": email,
            },
            "address": {
                "line_1": str(customer.get("line_1") or "عنوان التوصيل"),
                "line_2": str(customer.get("line_2") or "حي / شارع"),
                "city_name": city,
                "country_code": "SA",
            },
        },
        "is_gift": False,
        "is_gifted_consignee_notifiable": True,
        "products": [{"sku": item["sku"], "quantity": item["quantity"]} for item in items],
        "shipping_method": {"type": "delivery", "id": shipping_method_id},
        "payment_method": {
            "id": payment_method_id,
            "payment_link_configs": {"expiryDateTime": expiry},
        },
        "customer_comment": str(body.get("customer_comment") or "طلب من موقع قطع الجنوب"),
    }

    status, payload = _zid_http_json(
        "POST",
        f"{cfg['base_url']}/managers/store/drafts",
        headers=zid_headers(cfg),
        body=draft,
    )
    if status >= 400:
        msg = (
            (payload.get("message") if isinstance(payload, dict) else None)
            or ((payload.get("error") or {}).get("message") if isinstance(payload, dict) else None)
            or "تعذر إنشاء طلب الدفع عبر زد."
        )
        if isinstance(msg, dict):
            validations = msg.get("validations")
            if isinstance(validations, list) and validations:
                details = []
                for item in validations:
                    if not isinstance(item, dict):
                        continue
                    field = item.get("field") or ""
                    errs = item.get("errors") or []
                    if isinstance(errs, list) and errs:
                        details.append(f"{field}: {errs[0]}")
                    elif field:
                        details.append(str(field))
                if details:
                    msg = " | ".join(details)
                else:
                    msg = msg.get("description") or msg.get("name") or str(msg)
            else:
                msg = msg.get("description") or msg.get("name") or str(msg)
        raise RuntimeError(str(msg))

    checkout_url = extract_zid_payment_url(payload)
    order = payload.get("order") if isinstance(payload.get("order"), dict) else payload
    order_id = None
    if isinstance(order, dict):
        order_id = order.get("id") or order.get("code") or order.get("order_id")
    if not checkout_url:
        # Some responses nest payment link under data.
        data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
        checkout_url = extract_zid_payment_url(data) if data else ""
    if not checkout_url:
        raise RuntimeError("تم إنشاء الطلب في زد لكن بدون رابط دفع.")

    return {
        "checkout_url": checkout_url,
        "order_id": order_id,
        "mode": "zid_payment_link",
        "provider": "zid",
    }


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(str(DB_PATH), timeout=10.0, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA busy_timeout=10000")
    con.execute("PRAGMA foreign_keys=ON")
    ensure_zid_schema(con)
    return con


def ensure_pricing_schema(con: sqlite3.Connection) -> None:
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS product_pricing_controls (
            product_id INTEGER PRIMARY KEY,
            unit_cost REAL,
            fulfillment_cost REAL DEFAULT 0,
            payment_fee_percent REAL DEFAULT 0,
            target_margin_percent REAL,
            minimum_sale_price REAL,
            updated_at TEXT
        )
        """
    )
    con.commit()


def calculated_price_floor(control) -> Decimal | None:
    if not control:
        return None
    explicit = control["minimum_sale_price"]
    floors: list[Decimal] = []
    if explicit is not None:
        floors.append(Decimal(str(explicit)))
    if control["unit_cost"] is not None:
        cost = Decimal(str(control["unit_cost"])) + Decimal(
            str(control["fulfillment_cost"] or 0)
        )
        fee = Decimal(str(control["payment_fee_percent"] or 0)) / Decimal("100")
        margin = Decimal(str(control["target_margin_percent"] or 0)) / Decimal("100")
        denominator = Decimal("1") - fee - margin
        if denominator > Decimal("0.01"):
            floors.append(cost / denominator)
    return max(floors).quantize(Decimal("0.01")) if floors else None


READY_WHERE = """
p.status = 'published'
AND p.description IS NOT NULL AND trim(p.description) != ''
AND (
  (
    p.oem_number IS NOT NULL AND trim(p.oem_number) != ''
    AND p.oem_number NOT LIKE 'MISSING-%'
    AND p.oem_number NOT LIKE 'PENDING-%'
  )
  OR EXISTS (SELECT 1 FROM product_oem_numbers pon WHERE pon.product_id = p.id)
)
AND EXISTS (
  SELECT 1 FROM product_images i
  WHERE i.product_id = p.id
    AND i.source_type IN ('owned','licensed','official')
    AND i.oem_number_id IS NOT NULL
    AND i.license_reference IS NOT NULL
    AND i.license_owner IS NOT NULL
    AND i.license_status = 'approved'
    AND i.quality_status = 'approved'
    AND i.optimized_format IN ('webp','avif')
    AND (COALESCE(i.has_watermark,0)=0 OR i.watermark_usage_status='licensed')
)
AND EXISTS (
  SELECT 1 FROM fitments f
  WHERE f.part_id = p.id AND f.review_status = 'approved'
)
AND (
  COALESCE(p.is_seo_indexed,0)=1
  OR EXISTS (
    SELECT 1 FROM seo_metadata s
    WHERE s.product_id = p.id
      AND s.is_indexable = 1
      AND s.meta_title_ar IS NOT NULL
      AND s.meta_description_ar IS NOT NULL
  )
)
"""


def image_url(path: str | None) -> str | None:
    if not path:
        return None
    base = _resolve_base_url()
    if path.startswith("http://") or path.startswith("https://"):
        parsed = urllib.parse.urlparse(path)
        if parsed.netloc.endswith(".up.railway.app"):
            return f"{base}{parsed.path}{('?' + parsed.query) if parsed.query else ''}"
        return path
    return f"{base}/{path.lstrip('/')}"


def ads_public_config() -> dict:
    env = load_env_map()
    return {
        "metaPixelId": (os.environ.get("META_PIXEL_ID") or env.get("META_PIXEL_ID") or "").strip(),
        "gtmId": (os.environ.get("GTM_CONTAINER_ID") or env.get("GTM_CONTAINER_ID") or "").strip(),
        "ga4Id": (os.environ.get("GA4_MEASUREMENT_ID") or env.get("GA4_MEASUREMENT_ID") or "").strip(),
        "googleAdsId": (os.environ.get("GOOGLE_ADS_ID") or env.get("GOOGLE_ADS_ID") or "").strip(),
        "googleAdsPurchaseLabel": (
            os.environ.get("GOOGLE_ADS_CONVERSION_LABEL")
            or env.get("GOOGLE_ADS_CONVERSION_LABEL")
            or ""
        ).strip(),
        "currency": "SAR",
    }


def default_share_image() -> str:
    return f"{_resolve_base_url()}/images/brand/china-parts-mark.png"


def product_internal_crumbs(con: sqlite3.Connection, product: dict) -> list[dict]:
    """Crawlable brand/section links only when that landing is eligible."""
    crumbs = []
    brand = product.get("brand") if isinstance(product.get("brand"), dict) else {}
    slug = str(brand.get("slug") or "").strip().lower()
    name = str(brand.get("name_ar") or brand.get("name_en") or "").strip()
    if slug and slug not in {"generic", "brand"} and name not in {"", "عام", "عامة"}:
        ready = con.execute(
            f"""
            SELECT 1
            FROM brands b
            WHERE lower(b.slug)=?
              AND COALESCE(b.is_active,1)=1
              AND EXISTS (
                SELECT 1 FROM parts p
                WHERE p.brand_id = b.id AND {READY_WHERE}
              )
            LIMIT 1
            """,
            (slug,),
        ).fetchone()
        if ready:
            crumbs.append({"name": name, "path": brand_landing_path(slug)})
    category = product.get("category") if isinstance(product.get("category"), dict) else {}
    key = str(category.get("slug") or "").strip().lower()
    labels = FEATURED_CATEGORY_LANDINGS.get(key)
    if labels:
        key_sql, key_params = category_key_clause(key)
        ready_category = con.execute(
            f"SELECT 1 FROM parts p WHERE {READY_WHERE} AND {key_sql} LIMIT 1",
            key_params,
        ).fetchone() if key_sql else None
        if ready_category:
            crumbs.append({"name": labels["name_ar"], "path": category_landing_path(key)})
    return crumbs


def product_seo_payload(product: dict, extra_crumbs: list[dict] | None = None) -> dict:
    title = f"{product.get('name_ar') or product.get('name_en') or 'قطعة غيار'} | CHINA PARTS"
    raw_desc = product.get("short_description_ar") or product.get("description") or title
    desc = re.sub(r"\s+", " ", str(raw_desc)).strip()[:160]
    url = f"{_resolve_base_url()}/product.html?id={product['id']}"
    image = product.get("image_url") or default_share_image()
    product_schema = {
        "@type": "Product",
        "@id": f"{url}#product",
        "name": product.get("name_ar") or product.get("name_en"),
        "description": desc,
        "sku": product.get("sku") or f"CP-{product['id']}",
        "image": [image],
        "url": url,
    }
    # Publish MPN only when the reference is backed by an official published source.
    if product.get("manufacturer_number"):
        product_schema["mpn"] = product["manufacturer_number"]
    if (
        product.get("price") is not None
        and product.get("checkout_enabled") is True
        and product.get("in_stock") is True
    ):
        product_schema["offers"] = {
            "@type": "Offer",
            "url": url,
            "priceCurrency": "SAR",
            "price": f"{float(product['price']):.2f}",
            "availability": "https://schema.org/InStock",
            "seller": {"@type": "Organization", "name": "CHINA PARTS"},
        }
    structured = {
        "@context": "https://schema.org",
        "@graph": [
            product_schema,
            {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    {
                        "@type": "ListItem",
                        "position": index,
                        "name": crumb["name"],
                        "item": crumb["item"],
                    }
                    for index, crumb in enumerate(
                        [
                            {"name": "الرئيسية", "item": f"{_resolve_base_url()}/"},
                            {"name": "الكتالوج", "item": f"{_resolve_base_url()}/collection.html"},
                            *[
                                {"name": crumb["name"], "item": f"{_resolve_base_url()}{crumb['path']}"}
                                for crumb in (extra_crumbs or [])
                            ],
                            {"name": product.get("name_ar") or product.get("name_en"), "item": url},
                        ],
                        start=1,
                    )
                ],
            },
        ],
    }
    visible_crumbs = [
        {"name": "الرئيسية", "path": "/"},
        {"name": "الكتالوج", "path": "/collection.html"},
        *[{"name": crumb["name"], "path": crumb["path"]} for crumb in (extra_crumbs or [])],
        {"name": product.get("name_ar") or product.get("name_en") or "تفاصيل القطعة", "path": f"/product.html?id={product['id']}"},
    ]
    return {
        "title": title,
        "meta_title_ar": title,
        "meta_description": desc,
        "meta_description_ar": desc,
        "canonical_url": url,
        "og_image": image,
        "open_graph": {"title": title, "description": desc, "image": image, "url": url},
        "structured_data": structured,
        "breadcrumbs": visible_crumbs,
    }


def _env_confirmed(value: str | None) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on", "confirmed"}


def merchant_feed_settings() -> dict:
    env = load_env_map()
    get = lambda key: os.environ.get(key) or env.get(key) or ""
    condition = str(get("MERCHANT_PRODUCT_CONDITION")).strip().lower()
    return {
        "enabled": _env_confirmed(get("MERCHANT_FEED_ENABLED")),
        "condition": condition if condition in {"new", "used", "refurbished"} else None,
        "shipping_confirmed": _env_confirmed(get("MERCHANT_SHIPPING_CONFIRMED")),
        "tax_treatment_confirmed": _env_confirmed(get("MERCHANT_TAX_TREATMENT_CONFIRMED")),
        "return_policy_confirmed": _env_confirmed(get("MERCHANT_RETURN_POLICY_CONFIRMED")),
    }


def catalog_feed_candidates(con: sqlite3.Connection) -> list[sqlite3.Row]:
    """Return only products with factual identifiers, checkout mapping and known stock."""
    required_tables = {"storefront_part_reference_evidence", "salla_products", "zid_products"}
    existing = {
        str(r[0])
        for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    }
    if not required_tables.issubset(existing):
        return []
    return con.execute(
        f"""
        SELECT * FROM (
            SELECT
                p.id,
                p.name_ar,
                p.name_en,
                p.sku,
                p.price,
                p.description,
                (SELECT b.name_ar FROM brands b WHERE b.id = p.brand_id LIMIT 1) AS brand_name,
                (
                    SELECT e.number
                    FROM storefront_part_reference_evidence e
                    WHERE e.part_id = p.id
                      AND e.verification_scope = 'official_published_reference'
                      AND e.number IS NOT NULL AND trim(e.number) != ''
                    ORDER BY e.rowid ASC
                    LIMIT 1
                ) AS manufacturer_number,
                (
                    SELECT i.file_path
                    FROM product_images i
                    WHERE i.product_id = p.id
                      AND i.source_type IN ('owned','licensed','official')
                      AND i.oem_number_id IS NOT NULL
                      AND i.license_reference IS NOT NULL
                      AND i.license_owner IS NOT NULL
                      AND i.license_status = 'approved'
                      AND i.quality_status = 'approved'
                      AND i.optimized_format IN ('webp','avif')
                      AND (COALESCE(i.has_watermark,0)=0 OR i.watermark_usage_status='licensed')
                    ORDER BY i.is_primary DESC, i.id ASC
                    LIMIT 1
                ) AS image_path,
                COALESCE(
                    (
                        SELECT zp.last_known_quantity FROM zid_products zp
                        WHERE zp.product_id=p.id AND zp.sync_status='synced'
                          AND zp.zid_product_id IS NOT NULL AND trim(zp.zid_product_id)!=''
                          AND zp.last_known_quantity IS NOT NULL
                        LIMIT 1
                    ),
                    (
                        SELECT sp.last_known_quantity FROM salla_products sp
                        WHERE sp.product_id=p.id AND sp.sync_status='synced'
                          AND sp.salla_product_id IS NOT NULL AND trim(sp.salla_product_id)!=''
                          AND sp.last_known_quantity IS NOT NULL
                        LIMIT 1
                    )
                ) AS stock_quantity
            FROM parts p
            WHERE {READY_WHERE}
              AND p.price IS NOT NULL AND p.price > 0
        ) eligible
        WHERE eligible.image_path IS NOT NULL
          AND eligible.manufacturer_number IS NOT NULL
          AND eligible.brand_name IS NOT NULL
          AND eligible.stock_quantity > 0
        ORDER BY eligible.id DESC
        """
    ).fetchall()


def merchant_feed_readiness(con: sqlite3.Connection) -> dict:
    settings = merchant_feed_settings()
    candidate_count = len(catalog_feed_candidates(con))
    blockers = []
    if not settings["condition"]:
        blockers.append("تأكيد حالة المنتجات: جديد أو مستعمل أو مجدد")
    if not settings["shipping_confirmed"]:
        blockers.append("اعتماد تكلفة ومدة وسياسة الشحن")
    if not settings["tax_treatment_confirmed"]:
        blockers.append("تأكيد معالجة ضريبة القيمة المضافة في الأسعار")
    if not settings["return_policy_confirmed"]:
        blockers.append("اعتماد مدة وشروط الإرجاع")
    if candidate_count == 0:
        blockers.append("لا توجد حاليًا منتجات تجمع رقم مصنع موثقًا وربط شراء ومخزونًا معلومًا")
    if not settings["enabled"]:
        blockers.append("تفعيل خلاصة Merchant بعد مراجعة البيانات")
    return {
        "ready": not blockers,
        "eligible_products": candidate_count,
        "published_feed_products": candidate_count if not blockers else 0,
        "settings": settings,
        "blockers": blockers,
    }


def catalog_feed_rows(con: sqlite3.Connection) -> list[sqlite3.Row]:
    readiness = merchant_feed_readiness(con)
    return catalog_feed_candidates(con) if readiness["ready"] else []


def _iso_lastmod(value: str | None) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    match = re.match(r"^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}:\d{2}))?", raw)
    if not match:
        return None
    if match.group(2):
        return f"{match.group(1)}T{match.group(2)}+03:00"
    return match.group(1)


def catalog_lastmod(con: sqlite3.Connection, extra_where: str = "", params: list | None = None) -> str | None:
    try:
        row = con.execute(
            f"SELECT MAX(p.updated_at) FROM parts p WHERE {READY_WHERE} {extra_where}",
            params or [],
        ).fetchone()
    except sqlite3.Error:
        return None
    return _iso_lastmod(row[0] if row else None)


def brand_landing_path(slug: str, page: int = 1) -> str:
    slug = str(slug or "").strip().lower()
    if page > 1:
        return f"/brands/{slug}/page/{int(page)}/"
    return f"/brands/{slug}/"


def category_landing_path(key: str, page: int = 1) -> str:
    key = str(key or "").strip().lower()
    if page > 1:
        return f"/categories/{key}/page/{int(page)}/"
    return f"/categories/{key}/"


def model_landing_path(model_id: int, page: int = 1) -> str:
    if page > 1:
        return f"/models/{int(model_id)}/page/{int(page)}/"
    return f"/models/{int(model_id)}/"


def parse_storefront_landing(path: str) -> dict | None:
    normalized = str(path or "").strip()
    if normalized != "/" and normalized.endswith("/"):
        normalized = normalized.rstrip("/") + "/"
    match = LANDING_BRAND_RE.fullmatch(normalized.rstrip("/") or normalized)
    if match:
        page = int(match.group(2) or 1)
        return {"kind": "brand", "slug": match.group(1), "page": page, "raw_path": path}
    match = LANDING_CATEGORY_RE.fullmatch(normalized.rstrip("/") or normalized)
    if match:
        page = int(match.group(2) or 1)
        return {"kind": "category", "slug": match.group(1), "page": page, "raw_path": path}
    match = LANDING_MODEL_RE.fullmatch(normalized.rstrip("/") or normalized)
    if match:
        page = int(match.group(2) or 1)
        return {"kind": "model", "model_id": int(match.group(1)), "page": page, "raw_path": path}
    return None


def indexable_brand_landings(con: sqlite3.Connection) -> list[dict]:
    return [
        brand
        for brand in brands_payload(con)
        if brand.get("has_products")
        and brand.get("slug")
        and str(brand["slug"]).lower() not in {"generic", "brand"}
    ]


def indexable_category_landings(con: sqlite3.Connection) -> list[dict]:
    out = []
    for key, labels in FEATURED_CATEGORY_LANDINGS.items():
        key_sql, key_params = category_key_clause(key)
        if not key_sql:
            continue
        row = con.execute(
            f"SELECT COUNT(*) FROM parts p WHERE {READY_WHERE} AND {key_sql}",
            key_params,
        ).fetchone()
        total = int(row[0] if row else 0)
        if total <= 0:
            continue
        out.append({
            "key": key,
            "name_ar": labels["name_ar"],
            "short_ar": labels["short_ar"],
            "products_count": total,
        })
    return out


def indexable_model_landings(con: sqlite3.Connection) -> list[dict]:
    try:
        rows = con.execute(
            f"""
            SELECT m.id, m.name_ar, m.name_en, m.slug, b.name_ar AS brand_name, b.slug AS brand_slug
            FROM car_models m
            JOIN brands b ON b.id = m.brand_id
            WHERE EXISTS (
                SELECT 1
                FROM vehicles v
                JOIN fitments f ON f.vehicle_id = v.id
                JOIN parts p ON p.id = f.part_id
                WHERE v.car_model_id = m.id
                  AND f.review_status = 'approved'
                  AND f.verified_at IS NOT NULL
                  AND trim(f.verified_at) != ''
                  AND f.verified_by IS NOT NULL
                  AND trim(CAST(f.verified_by AS TEXT)) != ''
                  AND {READY_WHERE}
            )
            ORDER BY b.name_ar, m.name_ar
            """
        ).fetchall()
    except sqlite3.Error:
        return []
    return [
        {
            "id": int(row["id"]),
            "name_ar": row["name_ar"] or row["name_en"],
            "name_en": row["name_en"],
            "slug": row["slug"],
            "brand_name": row["brand_name"],
            "brand_slug": row["brand_slug"],
        }
        for row in rows
    ]


def collection_filter_redirect(con: sqlite3.Connection, qs: dict) -> str | None:
    meaningful: set[str] = set()
    for key, values in qs.items():
        if not any(str(value).strip() for value in values):
            continue
        if key in {"per_page"}:
            continue
        if key == "sort" and str((values or [""])[0]).strip().lower() in {"", "latest", "newest", "new", "id_desc"}:
            continue
        if key == "page" and str((values or ["1"])[0]).strip() in {"", "1"}:
            continue
        meaningful.add(key)
    page_raw = str((qs.get("page") or ["1"])[0]).strip()
    page = int(page_raw) if page_raw.isdigit() and int(page_raw) > 0 else 1
    brand_keys = {"brand", "brand_id", "brand_slug", "slug"}
    category_keys = {"category", "category_id", "category_key", "section"}
    if meaningful <= (brand_keys | {"page"}) and meaningful & brand_keys:
        options = storefront_query_options(con, qs)
        brand_id = options.get("brand_id")
        if not brand_id:
            return None
        brand = next((item for item in indexable_brand_landings(con) if int(item["id"]) == int(brand_id)), None)
        if not brand:
            return None
        return brand_landing_path(brand["slug"], page)
    if meaningful <= (category_keys | {"page"}) and meaningful & category_keys:
        options = storefront_query_options(con, qs)
        key = str(options.get("category_key") or "").strip().lower()
        if key not in FEATURED_CATEGORY_LANDINGS:
            return None
        if not any(item["key"] == key for item in indexable_category_landings(con)):
            return None
        return category_landing_path(key, page)
    if meaningful <= {"model", "model_id", "page"} and meaningful & {"model", "model_id"}:
        options = storefront_query_options(con, qs)
        model_id = options.get("model_id")
        if not model_id:
            return None
        if not any(int(item["id"]) == int(model_id) for item in indexable_model_landings(con)):
            return None
        return model_landing_path(int(model_id), page)
    return None


def ensure_purchase_tracking_schema(con: sqlite3.Connection) -> None:
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
    con.commit()


def purchase_confirmation_payload(con: sqlite3.Connection, transaction_id: str) -> tuple[dict, int]:
    txid = re.sub(r"[^A-Za-z0-9._:-]", "", str(transaction_id or ""))[:128]
    if not txid:
        return {"success": False, "message": "معرّف العملية غير صالح"}, 404
    ensure_purchase_tracking_schema(con)
    row = con.execute(
        "SELECT payload_json FROM purchase_tracking_confirmations WHERE transaction_id=?",
        (txid,),
    ).fetchone()
    if row is None:
        return {
            "success": False,
            "data": {"tracking_confirmation": {"tracking_confirmed": False}},
        }, 404
    try:
        payload = json.loads(row["payload_json"] if isinstance(row, sqlite3.Row) else row[0])
    except json.JSONDecodeError:
        return {"success": False, "message": "تأكيد غير صالح"}, 404
    if not isinstance(payload, dict) or payload.get("tracking_confirmed") is not True:
        return {"success": False, "data": {"tracking_confirmation": {"tracking_confirmed": False}}}, 404
    return {"success": True, "data": {"tracking_confirmation": payload}}, 200


def build_sitemap_xml(con: sqlite3.Connection) -> str:
    base = _resolve_base_url()
    catalog_mod = catalog_lastmod(con)
    pages = [
        ("/", "1.0", "daily", catalog_mod),
        ("/collection.html", "0.9", "daily", catalog_mod),
        ("/about.html", "0.6", "monthly", None),
        ("/contact.html", "0.7", "monthly", None),
        ("/faq.html", "0.7", "monthly", None),
        ("/policy.html", "0.6", "monthly", None),
        ("/privacy.html", "0.8", "monthly", None),
        ("/terms.html", "0.8", "monthly", None),
    ]
    for brand in indexable_brand_landings(con):
        pages.append((
            brand_landing_path(brand["slug"]),
            "0.8",
            "weekly",
            catalog_lastmod(con, "AND p.brand_id=?", [int(brand["id"])]),
        ))
    for category in indexable_category_landings(con):
        pages.append((category_landing_path(category["key"]), "0.75", "weekly", catalog_mod))
    for model in indexable_model_landings(con):
        pages.append((model_landing_path(model["id"]), "0.7", "weekly", catalog_mod))
    product_rows = con.execute(
        f"SELECT p.id, p.updated_at FROM parts p WHERE {READY_WHERE} ORDER BY p.id DESC"
    ).fetchall()
    chunks = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
    for path, priority, freq, lastmod in pages:
        lastmod_xml = f"<lastmod>{lastmod}</lastmod>" if lastmod else ""
        chunks.append(
            f"<url><loc>{base}{path}</loc>{lastmod_xml}<changefreq>{freq}</changefreq><priority>{priority}</priority></url>"
        )
    for row in product_rows:
        lastmod = _iso_lastmod(row["updated_at"] if "updated_at" in row.keys() else None)
        lastmod_xml = f"<lastmod>{lastmod}</lastmod>" if lastmod else ""
        chunks.append(
            f"<url><loc>{base}/product.html?id={int(row['id'])}</loc>{lastmod_xml}<changefreq>weekly</changefreq><priority>0.7</priority></url>"
        )
    chunks.append("</urlset>")
    return "\n".join(chunks)


def xml_escape(value: str) -> str:
    return (
        str(value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def build_meta_catalog_csv(con: sqlite3.Connection) -> str:
    base = _resolve_base_url()
    condition = merchant_feed_settings()["condition"] or ""
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "id",
        "title",
        "description",
        "availability",
        "condition",
        "price",
        "link",
        "image_link",
        "brand",
        "mpn",
    ])
    for row in catalog_feed_rows(con):
        title = public_product_name(row["name_ar"] or row["name_en"] or f"قطعة {row['id']}")
        desc = public_product_description({
            "name_ar": title,
            "brand": {"name_ar": row["brand_name"]},
            "manufacturer_number": row["manufacturer_number"],
        })
        price = float(row["price"]) if row["price"] is not None else 0.0
        writer.writerow([
            row["id"],
            title,
            re.sub(r"\s+", " ", desc)[:5000],
            "in stock",
            condition,
            f"{price:.2f} SAR",
            f"{base}/product.html?id={row['id']}",
            image_url(row["image_path"]) or default_share_image(),
            row["brand_name"] or "CHINA PARTS",
            row["manufacturer_number"],
        ])
    return output.getvalue()


def build_google_merchant_xml(con: sqlite3.Connection) -> str:
    base = _resolve_base_url()
    condition = merchant_feed_settings()["condition"] or ""
    items = []
    for row in catalog_feed_rows(con):
        title = xml_escape(public_product_name(row["name_ar"] or row["name_en"] or f"قطعة {row['id']}"))
        desc = xml_escape(public_product_description({
            "name_ar": row["name_ar"] or row["name_en"] or f"قطعة {row['id']}",
            "brand": {"name_ar": row["brand_name"]},
            "manufacturer_number": row["manufacturer_number"],
        })[:5000])
        price = float(row["price"]) if row["price"] is not None else 0.0
        items.append(
            "\n".join([
                "<item>",
                f"<g:id>{row['id']}</g:id>",
                f"<g:title>{title}</g:title>",
                f"<g:description>{desc}</g:description>",
                f"<g:link>{base}/product.html?id={row['id']}</g:link>",
                f"<g:image_link>{xml_escape(image_url(row['image_path']) or default_share_image())}</g:image_link>",
                "<g:availability>in stock</g:availability>",
                f"<g:condition>{xml_escape(condition)}</g:condition>",
                f"<g:price>{price:.2f} SAR</g:price>",
                f"<g:brand>{xml_escape(row['brand_name'] or 'CHINA PARTS')}</g:brand>",
                f"<g:mpn>{xml_escape(row['manufacturer_number'])}</g:mpn>",
                "<g:identifier_exists>yes</g:identifier_exists>",
                "</item>",
            ])
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n'
        "<channel>\n"
        "<title>CHINA PARTS</title>\n"
        f"<link>{base}/</link>\n"
        "<description>كتالوج قطع غيار السيارات الصينية</description>\n"
        + "\n".join(items)
        + "\n</channel>\n</rss>\n"
    )


def product_images(con: sqlite3.Connection, product_id: int) -> list[dict]:
    rows = con.execute(
        """
        SELECT id, file_path, alt_text_ar, alt_text_en, is_primary, optimized_format, license_status
        FROM product_images
        WHERE product_id=?
          AND source_type IN ('owned','licensed','official')
          AND oem_number_id IS NOT NULL
          AND license_reference IS NOT NULL
          AND license_owner IS NOT NULL
          AND license_status='approved'
          AND quality_status='approved'
          AND optimized_format IN ('webp','avif')
          AND (COALESCE(has_watermark,0)=0 OR watermark_usage_status='licensed')
        ORDER BY is_primary DESC, sort_order ASC, id ASC
        """,
        (product_id,),
    ).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "url": image_url(r["file_path"]),
                "alt_ar": r["alt_text_ar"],
                "alt_en": r["alt_text_en"],
                "is_primary": bool(r["is_primary"]),
                "format": r["optimized_format"],
                "license_status": r["license_status"],
            }
        )
    return out


def infer_part_type(oem: str | None) -> str:
    if not oem:
        return "قطع غيار ميكانيكية"
    o = oem.upper()
    if any(k in o for k in ["BRAKE", "PAD", "DISC", "PADS"]):
        return "قطع الفرامل والصيانة"
    if any(k in o for k in ["FILTER", "OIL", "AIR", "CABIN"]):
        return "الفلاتر والزيوت"
    if any(k in o for k in ["BUMPER", "LAMP", "LIGHT", "MIRROR", "DOOR", "FENDER"]):
        return "قطع الهيكل والإضاءة"
    return "قطع غيار ميكانيكية"


# Storefront "أقسام" filters — products are often tagged under vehicle-model
# categories, so we match by product name/description keywords instead.
FEATURED_CATEGORY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "brakes": ("فرامل", "فحمات", "ديسك", "brake", "pad", "disc"),
    "engine": ("محرك", "كمبروسر", "سير", "مضخة", "engine", "belt", "compressor", "pump"),
    "filters": ("فلتر", "filter", "زيت"),
    "suspension": ("مساعد", "تعليق", "مقص", "ذراع", "قلب", "shock", "arm", "stabilizer"),
    "cooling": ("رديتر", "ردياتير", "راديتير", "راديتر", "تبريد", "ثرموستات", "ثيرموستات", "radiator", "cooling", "thermostat"),
    "lighting": ("إضاءة", "كشاف", "فانوس", "استب", "شمعة أمام", "lamp", "light", "headlamp", "tail"),
    "body": ("صدام", "هيكل", "باب", "مراية", "غطاء", "bumper", "door", "mirror", "fender", "hood"),
    "ignition": ("بواجي", "إشعال", "حساس", "spark", "sensor", "coil", "ignition"),
}

FEATURED_CATEGORY_LANDINGS: dict[str, dict[str, str]] = {
    "brakes": {"name_ar": "نظام الفرامل", "short_ar": "الفرامل"},
    "engine": {"name_ar": "أجزاء المحرك", "short_ar": "المحرك"},
    "filters": {"name_ar": "الفلاتر", "short_ar": "الفلاتر"},
    "suspension": {"name_ar": "المساعدات والتعليق", "short_ar": "التعليق"},
    "cooling": {"name_ar": "التبريد والرديتر", "short_ar": "التبريد"},
    "lighting": {"name_ar": "الإضاءة", "short_ar": "الإضاءة"},
    "body": {"name_ar": "الصدامات والهيكل", "short_ar": "الصدامات"},
    "ignition": {"name_ar": "البواجي والإشعال", "short_ar": "البواجي والإشعال"},
}

# Arabic keyword map used only for titles/descriptions. Do not target
# "شراء أونلاين" as a purchase conversion before checkout is verified.
LANDING_KEYWORD_MAP = {
    "home": {
        "intent": "browse",
        "keywords": ("قطع غيار السيارات الصينية", "قطع غيار سيارات صينية في السعودية"),
    },
    "collection": {
        "intent": "browse",
        "keywords": ("كتالوج قطع غيار السيارات الصينية", "فلاتر فرامل رديتر تعليق"),
    },
    "brand": {
        "intent": "browse",
        "title": "قطع غيار {name} | CHINA PARTS",
        "description": "تصفح قطع غيار {name} المتوفرة في كتالوج CHINA PARTS، وراجع رقم القطعة والتوافق قبل طلب التحقق.",
        "keywords": ("قطع غيار {name}", "قطع {name} في السعودية"),
    },
    "category": {
        "intent": "browse",
        "title": "{name} للسيارات الصينية | CHINA PARTS",
        "description": "تصفح {name} للسيارات الصينية وراجع رقم القطعة والتوفر قبل طلب التحقق.",
        "keywords": ("{name} سيارات صينية",),
    },
    "model": {
        "intent": "browse",
        "title": "قطع متوافقة مع {name} | CHINA PARTS",
        "description": "قطع غيار موثقة التوافق مع {name}. راجع رقم القطعة قبل طلب التحقق.",
    },
}

LANDING_BRAND_RE = re.compile(
    r"^/brands/([a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?)(?:/page/(\d+))?/?$"
)
LANDING_CATEGORY_RE = re.compile(
    r"^/categories/([a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?)(?:/page/(\d+))?/?$"
)
LANDING_MODEL_RE = re.compile(r"^/models/(\d+)(?:/page/(\d+))?/?$")


SEARCH_STOPWORDS = {
    "قطع", "قطعه", "قطعة", "غيار", "غيارات", "سياره", "سيارة", "سيارات",
    "اجزاء", "أجزاء", "جزء", "لل", "من", "في", "علي", "على", "و", "او", "أو",
    "parts", "part", "car", "cars", "auto", "spare", "spares", "for", "the",
}

BRAND_SEARCH_ALIASES = {
    "جيلي": "geely",
    "geely": "geely",
    "شانجان": "changan",
    "changan": "changan",
    "شيري": "chery",
    "chery": "chery",
    "هافال": "haval",
    "haval": "haval",
    "ام جي": "mg",
    "امجي": "mg",
    "ام.جي": "mg",
    "mg": "mg",
    "جيتور": "jetour",
    "jetour": "jetour",
    "بي واي دي": "byd",
    "byd": "byd",
    "جاك": "jac",
    "jac": "jac",
    "جي ايه سي": "gac",
    "جي اي سي": "gac",
    "gac": "gac",
    "تانك": "tank",
    "tank": "tank",
    "اكسيد": "exeed",
    "exeed": "exeed",
    "اومودا": "omoda",
    "omoda": "omoda",
    "جايكو": "jaecoo",
    "jaecoo": "jaecoo",
    "بايك": "baic",
    "baic": "baic",
    "ماكسوس": "maxus",
    "maxus": "maxus",
    "هونغتشي": "hongqi",
    "هونجتشي": "hongqi",
    "hongqi": "hongqi",
    "دونغفنغ": "dongfeng",
    "دونجفنغ": "dongfeng",
    "dongfeng": "dongfeng",
    "لينك": "lynk-co",
    "لينك اند كو": "lynk-co",
    "lynk": "lynk-co",
    "زيكر": "zeekr",
    "zeekr": "zeekr",
    "فوتون": "foton",
    "foton": "foton",
}

CATEGORY_SEARCH_ALIASES = {
    "محرك": "engine",
    "المحرك": "engine",
    "كمبروسر": "engine",
    "سير": "engine",
    "مضخه": "engine",
    "مضخة": "engine",
    "engine": "engine",
    "belt": "engine",
    "compressor": "engine",
    "pump": "engine",
    "فرامل": "brakes",
    "الفرامل": "brakes",
    "فحمات": "brakes",
    "ديسك": "brakes",
    "brake": "brakes",
    "brakes": "brakes",
    "pad": "brakes",
    "disc": "brakes",
    "فلتر": "filters",
    "فلاتر": "filters",
    "الفلاتر": "filters",
    "filter": "filters",
    "filters": "filters",
    "زيت": "filters",
    "مساعد": "suspension",
    "مساعدات": "suspension",
    "تعليق": "suspension",
    "المساعدات": "suspension",
    "مقص": "suspension",
    "ذراع": "suspension",
    "shock": "suspension",
    "suspension": "suspension",
    "رديتر": "cooling",
    "ردياتير": "cooling",
    "راديتير": "cooling",
    "راديتر": "cooling",
    "تبريد": "cooling",
    "التبريد": "cooling",
    "ثرموستات": "cooling",
    "ثيرموستات": "cooling",
    "radiator": "cooling",
    "cooling": "cooling",
    "اضاءه": "lighting",
    "اضاءة": "lighting",
    "الإضاءة": "lighting",
    "الاضاءه": "lighting",
    "كشاف": "lighting",
    "فانوس": "lighting",
    "استب": "lighting",
    "lamp": "lighting",
    "light": "lighting",
    "lighting": "lighting",
    "صدام": "body",
    "صدامات": "body",
    "هيكل": "body",
    "باب": "body",
    "مرايه": "body",
    "مراية": "body",
    "bumper": "body",
    "door": "body",
    "mirror": "body",
    "body": "body",
    "بواجي": "ignition",
    "اشعال": "ignition",
    "إشعال": "ignition",
    "حساس": "ignition",
    "spark": "ignition",
    "ignition": "ignition",
    "sensor": "ignition",
    "coil": "ignition",
}


def normalize_search_text(value: str) -> str:
    text = (value or "").strip().lower()
    repl = str.maketrans({
        "أ": "ا",
        "إ": "ا",
        "آ": "ا",
        "ة": "ه",
        "ى": "ي",
        "ؤ": "و",
        "ئ": "ي",
    })
    text = text.translate(repl).replace("ـ", "")
    text = re.sub(r"[^\w\u0600-\u06ff]+", " ", text, flags=re.UNICODE)
    return re.sub(r"\s+", " ", text).strip()


def strip_al(token: str) -> str:
    if token.startswith("ال") and len(token) > 3:
        return token[2:]
    return token


def _brand_search_keys(con: sqlite3.Connection) -> list[tuple[str, int]]:
    rows = con.execute(
        """
        SELECT id, slug, name_ar, name_en
        FROM brands
        WHERE COALESCE(is_active,1)=1
        """
    ).fetchall()
    slug_to_id = {}
    keys: list[tuple[str, int]] = []
    for r in rows:
        slug = str(r["slug"] or "").strip().lower()
        if not slug or slug == "generic":
            continue
        slug_to_id[slug] = int(r["id"])
        for label in (slug, r["name_ar"], r["name_en"], slug.replace("-", " ")):
            norm = normalize_search_text(str(label or ""))
            if len(norm) >= 2:
                keys.append((norm, int(r["id"])))
    for alias, slug in BRAND_SEARCH_ALIASES.items():
        bid = slug_to_id.get(slug)
        if bid:
            keys.append((normalize_search_text(alias), bid))
    keys.sort(key=lambda item: len(item[0]), reverse=True)
    return keys


def parse_search_intent(
    con: sqlite3.Connection,
    q: str | None,
    brand_id: int | None = None,
    category_key: str | None = None,
) -> tuple[int | None, str | None, list[str]]:
    raw = (q or "").strip()
    if not raw:
        return brand_id, category_key, []
    if re.search(r"\d", raw) and len(raw.split()) == 1:
        return brand_id, category_key, [raw]

    words = normalize_search_text(raw).split()
    if not words:
        return brand_id, category_key, []

    used = [False] * len(words)
    brand_keys = _brand_search_keys(con)
    cat_keys = sorted(
        ((normalize_search_text(alias), key) for alias, key in CATEGORY_SEARCH_ALIASES.items()),
        key=lambda item: len(item[0]),
        reverse=True,
    )

    def match_span(matchers, current):
        if current is not None:
            return current
        for n in (3, 2, 1):
            for i in range(len(words) - n + 1):
                if any(used[i:i + n]):
                    continue
                phrase = " ".join(words[i:i + n])
                variants = {phrase, strip_al(phrase)}
                for key, val in matchers:
                    if key in variants:
                        for j in range(i, i + n):
                            used[j] = True
                        return val
        return current

    brand_id = match_span(brand_keys, brand_id)
    category_key = match_span(cat_keys, category_key)

    leftover: list[str] = []
    for i, word in enumerate(words):
        if used[i]:
            continue
        bare = strip_al(word)
        if word in SEARCH_STOPWORDS or bare in SEARCH_STOPWORDS:
            continue
        leftover.append(word)
    return brand_id, category_key, leftover


def search_suggestions(con: sqlite3.Connection, query: str, limit: int = 5) -> list[str]:
    normalized = normalize_search_text(query)
    if len(normalized) < 3 or normalized.isdigit():
        return []
    labels: dict[str, str] = {}
    for row in con.execute(
        """
        SELECT p.name_ar, p.name_en
        FROM parts p
        WHERE {ready_where}
        ORDER BY p.id DESC
        LIMIT 2000
        """.format(ready_where=READY_WHERE)
    ).fetchall():
        for value in (row["name_ar"], row["name_en"]):
            label = re.sub(r"\s+", " ", str(value or "")).strip()
            key = normalize_search_text(label)
            if len(key) >= 3 and key not in labels:
                labels[key] = label
    for key, _brand_id in _brand_search_keys(con):
        labels.setdefault(key, key)
    matches = difflib.get_close_matches(
        normalized,
        list(labels),
        n=max(1, min(limit, 8)),
        cutoff=0.62,
    )
    return [labels[key] for key in matches if key != normalized][:limit]


def text_match_clause(term: str) -> tuple[str, list]:
    like = f"%{term}%"
    compact = f"%{''.join(term.split())}%"
    sql = """
            (
                p.name_ar LIKE ? OR p.name_en LIKE ? OR p.slug LIKE ? OR p.sku LIKE ? OR p.manufacturer_number LIKE ?
                OR p.oem_number LIKE ? OR REPLACE(COALESCE(p.oem_number,''), ' ', '') LIKE ?
                OR COALESCE(p.description, '') LIKE ?
                OR EXISTS (
                    SELECT 1 FROM brands b
                    WHERE b.id = p.brand_id
                      AND (b.name_ar LIKE ? OR b.name_en LIKE ? OR b.slug LIKE ?)
                )
                OR EXISTS (
                    SELECT 1 FROM product_oem_numbers pon
                    JOIN oem_numbers o ON o.id = pon.oem_number_id
                    WHERE pon.product_id = p.id
                      AND (
                        o.number LIKE ?
                        OR COALESCE(o.normalized_number, '') LIKE ?
                        OR REPLACE(COALESCE(o.number,''), ' ', '') LIKE ?
                      )
                )
                OR EXISTS (
                    SELECT 1
                    FROM fitments f
                    JOIN vehicles v ON v.id = f.vehicle_id
                    JOIN car_models m ON m.id = v.car_model_id
                    JOIN brands b ON b.id = m.brand_id
                    WHERE f.part_id = p.id AND f.verified_at IS NOT NULL AND f.verified_by IS NOT NULL
                      AND (
                        m.name_ar LIKE ? OR m.name_en LIKE ? OR m.slug LIKE ?
                        OR b.name_ar LIKE ? OR b.name_en LIKE ? OR b.slug LIKE ?
                      )
                )
            )
    """
    params = [
        like, like, like, like, like,
        like, compact,
        like,
        like, like, like,
        like, like, compact,
        like, like, like,
        like, like, like,
    ]
    return sql, params


def category_key_clause(category_key: str | None) -> tuple[str | None, list]:
    key = (category_key or "").strip().lower()
    words = FEATURED_CATEGORY_KEYWORDS.get(key)
    if not words:
        return None, []
    parts = []
    params: list = []
    for word in words:
        like = f"%{word}%"
        parts.append(
            """(
                p.name_ar LIKE ? OR p.name_en LIKE ? OR COALESCE(p.description,'') LIKE ?
                OR COALESCE(p.slug,'') LIKE ?
            )"""
        )
        params.extend([like, like, like, like])
    return "(" + " OR ".join(parts) + ")", params


def is_placeholder_oem(oem: str | None) -> bool:
    if not oem or not str(oem).strip():
        return True
    o = str(oem).strip().upper()
    return o.startswith("MISSING-") or o.startswith("PENDING-") or o.startswith("SALLA-")


def public_product_name(value: str | None) -> str:
    """Remove authenticity claims that are not proven by the local catalog."""
    name = str(value or "").strip()
    name = re.sub(r"\b(?:أصلي|الأصلي|اصلي|الاصلي|وكالة|وكاله)\b", "", name, flags=re.I)
    name = re.sub(r"\b(?:original|genuine)\b", "", name, flags=re.I)
    return re.sub(r"\s+", " ", name).strip()


def public_product_description(product: dict) -> str:
    name = product.get("name_ar") or product.get("name_en") or "قطعة غيار"
    brand = product.get("brand") or {}
    brand_name = brand.get("name_ar") if isinstance(brand, dict) else ""
    brand_slug = str(brand.get("slug") or "").strip().lower() if isinstance(brand, dict) else ""
    reference = product.get("manufacturer_number") or product.get("oem_number")
    parts = [f"{name} مدرجة ضمن كتالوج قطع غيار السيارات الصينية."]
    if brand_name and brand_slug != "generic" and str(brand_name).strip() not in {"عام", "عامة"}:
        parts.append(f"مصنفة في الكتالوج ضمن قطع {brand_name}.")
    if reference:
        label = "رقم قطعة منشور لدى المصدر الرسمي" if product.get("manufacturer_number") else "رقم مرجعي لدى المورد يحتاج مراجعة المصدر"
        parts.append(f"{label}: {reference}.")
    parts.append("طابق رقم القطعة وبيانات المركبة أو رقم الهيكل قبل اعتماد التوافق.")
    parts.append("يُؤكد التوفر ونوع القطعة والضمان والشحن قبل إرسال الطلب.")
    return " ".join(parts)


def build_product_specs(p: dict, years: list[int]) -> list[dict]:
    specs = []
    if p.get("oem_number"):
        specs.append({"label": "رقم القطعة لدى المورد (يحتاج توثيق)", "value": p["oem_number"]})
    if p.get("brand") and p["brand"].get("name_ar"):
        specs.append({"label": "الماركة", "value": p["brand"]["name_ar"]})
    if p.get("category") and p["category"].get("name_ar"):
        specs.append({"label": "القسم الرئيسي", "value": p["category"]["name_ar"]})
    if years:
        specs.append({"label": "سنوات التوافق", "value": f"{min(years)} - {max(years)}"})
    
    specs.append({"label": "توثيق التوافق", "value": "يلزم التأكد من كتالوج الشركة باستخدام رقم الهيكل"})
    return specs


def product_oem_numbers(con: sqlite3.Connection, product_id: int, primary_oem: str | None) -> list[dict]:
    rows = con.execute(
        """
        SELECT o.number AS number, pon.relation_type, o.verification_status
        FROM product_oem_numbers pon
        JOIN oem_numbers o ON o.id = pon.oem_number_id
        WHERE pon.product_id=?
        """,
        (product_id,),
    ).fetchall()
    out = []
    seen = set()
    if primary_oem:
        out.append({
            "number": primary_oem,
            "relation_type": "primary",
            "verification_status": None,
        })
        seen.add(primary_oem)
    for r in rows:
        number = r["number"]
        if not number or number in seen:
            continue
        seen.add(number)
        out.append(
            {
                "number": number,
                "relation_type": r["relation_type"] or "alternate",
                "verification_status": r["verification_status"],
            }
        )
    return out


def product_fitments(con: sqlite3.Connection, product_id: int) -> list[dict]:
    rows = con.execute(
        """
        SELECT f.id, v.year, v.engine_code, v.trim, b.name_ar as brand_name_ar, b.slug as brand_slug,
               m.name_ar as model_name_ar, m.slug as model_slug
        FROM fitments f
        JOIN vehicles v ON v.id = f.vehicle_id
        JOIN car_models m ON m.id = v.car_model_id
        JOIN brands b ON b.id = m.brand_id
        WHERE f.part_id=? AND f.review_status='approved'
          AND f.verified_at IS NOT NULL AND f.verified_by IS NOT NULL
        ORDER BY b.name_ar, m.name_ar, v.year DESC
        """,
        (product_id,),
    ).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "year": r["year"],
                "engine": r["engine_code"],
                "engine_code": r["engine_code"],
                "trim": r["trim"],
                "notes": r["trim"],
                "brand": r["brand_name_ar"],
                "brand_name_ar": r["brand_name_ar"],
                "brand_slug": r["brand_slug"],
                "model": r["model_name_ar"],
                "model_name_ar": r["model_name_ar"],
                "model_slug": r["model_slug"],
            }
        )
    return out


def checkout_truth_state(
    local_price: float | None,
    *,
    salla_id: str | None,
    salla_stock,
    salla_price,
    zid_id: str | None,
    zid_stock,
    zid_price,
    allow_unverified_sku: bool = False,
) -> dict:
    provider = "zid" if zid_id else ("salla" if salla_id else None)
    stock_qty = zid_stock if zid_id else (salla_stock if salla_id else None)
    remote_price = zid_price if zid_id else (salla_price if salla_id else None)
    in_stock = (int(stock_qty) > 0) if stock_qty is not None else None
    price_verified = False
    if local_price is not None and remote_price is not None:
        try:
            price_verified = abs(Decimal(str(local_price)) - Decimal(str(remote_price))) <= Decimal("0.01")
        except Exception:
            price_verified = False
    blockers = []
    if not provider:
        blockers.append("لا يوجد ربط شراء مؤكد لهذا المنتج")
    if stock_qty is None:
        blockers.append("المخزون غير مؤكد")
    elif in_stock is False:
        blockers.append("المنتج غير متوفر في منصة الدفع")
    if remote_price is None:
        blockers.append("سعر منصة الدفع غير متحقق")
    elif not price_verified:
        blockers.append("سعر منصة الدفع لا يطابق سعر المتجر")
    sku_guest = (
        allow_unverified_sku
        and str(salla_id or "").upper().startswith("QETAA-")
        and stock_qty is None
        and remote_price is None
        and not zid_id
    )
    if sku_guest:
        return {
            "provider": "salla",
            "stock_quantity": None,
            "in_stock": None,
            "price_verified": False,
            "can_checkout": True,
            "blockers": [],
            "checkout_mode": "salla_guest_sku",
        }
    can_checkout = bool(provider and in_stock is True and price_verified)
    return {
        "provider": provider if can_checkout else None,
        "stock_quantity": stock_qty,
        "in_stock": in_stock,
        "price_verified": price_verified,
        "can_checkout": can_checkout,
        "blockers": blockers,
        "checkout_mode": "verified" if can_checkout else None,
    }


def product_payload(con: sqlite3.Connection, row: sqlite3.Row, detailed: bool = False) -> dict:
    images = product_images(con, row["id"])
    price = float(row["price"]) if row["price"] is not None else None
    brand = None
    if row["brand_id"]:
        b = con.execute(
            "SELECT id, name_ar, name_en, slug FROM brands WHERE id=?",
            (row["brand_id"],),
        ).fetchone()
        if b:
            brand = {
                "id": b["id"],
                "name_ar": b["name_ar"],
                "name_en": b["name_en"],
                "slug": b["slug"],
            }
    category = None
    if row["category_id"]:
        c = con.execute(
            "SELECT id, name_ar, name_en, slug FROM categories WHERE id=?",
            (row["category_id"],),
        ).fetchone()
        if c:
            category = {
                "id": c["id"],
                "name_ar": c["name_ar"],
                "name_en": c["name_en"],
                "slug": c["slug"],
            }

    salla = con.execute(
        """
        SELECT salla_product_id, sync_status, last_known_quantity, last_known_price
        FROM salla_products
        WHERE product_id=?
        LIMIT 1
        """,
        (row["id"],),
    ).fetchone()
    salla_sync = salla["sync_status"] if salla else None
    salla_stock = salla["last_known_quantity"] if salla else None
    salla_price = salla["last_known_price"] if salla else None
    salla_id = None
    if salla_sync == "synced" and salla and salla["salla_product_id"]:
        salla_id = str(salla["salla_product_id"]).strip() or None
    elif ("salla_product_id" in row.keys()) and row["salla_product_id"] and salla_sync == "synced":
        salla_id = str(row["salla_product_id"]).strip() or None
    salla_id = resolve_salla_checkout_id(row["id"], salla_id)
    try:
        zid = con.execute(
            """
            SELECT zid_product_id, zid_sku, sync_status, last_known_quantity, last_known_price
            FROM zid_products
            WHERE product_id=?
            LIMIT 1
            """,
            (row["id"],),
        ).fetchone()
    except sqlite3.OperationalError:
        zid = None
    zid_sync = zid["sync_status"] if zid else None
    zid_stock = zid["last_known_quantity"] if zid else None
    zid_price = zid["last_known_price"] if zid else None
    zid_id = None
    zid_sku = None
    if zid_sync == "synced" and zid and zid["zid_product_id"]:
        zid_id = str(zid["zid_product_id"]).strip() or None
        zid_sku = str(zid["zid_sku"] or "").strip() or None
    elif ("zid_product_id" in row.keys()) and row["zid_product_id"] and zid_sync == "synced":
        zid_id = str(row["zid_product_id"]).strip() or None

    checkout_truth = checkout_truth_state(
        price,
        salla_id=salla_id,
        salla_stock=salla_stock,
        salla_price=salla_price,
        zid_id=zid_id,
        zid_stock=zid_stock,
        zid_price=zid_price,
        allow_unverified_sku=salla_checkout_by_sku_enabled(),
    )
    stock_qty = checkout_truth["stock_quantity"]
    in_stock = checkout_truth["in_stock"]
    can_checkout = checkout_truth["can_checkout"]

    list_images = images if detailed else images[:2]
    payload = {
        "id": row["id"],
        "slug": row["slug"],
        "name_ar": public_product_name(row["name_ar"]),
        "name_en": public_product_name(row["name_en"]),
        "short_description_ar": None,
        "description": None,
        "oem_number": None if str(row["oem_number"] or "").startswith("SALLA-") else row["oem_number"],
        "oem_verification_status": "unverified_supplier_reference",
        "price": price,
        "price_label": f"{price:.2f} ر.س" if price is not None else "السعر عند الطلب",
        "brand": brand,
        "category": category,
        "image_url": images[0]["url"] if images else None,
        "images": list_images,
        "image_count": len(images),
        "is_ready_for_publishing": True,
        "salla_product_id": salla_id,
        "zid_product_id": zid_id,
        "zid_sku": zid_sku,
        "checkout_provider": checkout_truth["provider"],
        "can_checkout": can_checkout,
        "checkout_enabled": can_checkout,
        "checkout_price_verified": checkout_truth["price_verified"],
        "checkout_blockers": checkout_truth["blockers"],
        "stock_quantity": stock_qty,
        "in_stock": in_stock,
        "availability_label": ("متوفر" if in_stock else "غير متوفر") if in_stock is not None else "التوفر يحتاج تأكيد",
        "availability_status": ("in_stock" if in_stock else "out_of_stock") if in_stock is not None else "unknown",
        "part_type": None,
        "sku": row["sku"] if "sku" in row.keys() else None,
        "country_of_origin": None,
        "manufacturer": None,
    }
    try:
        reference = con.execute(
            "SELECT number,verification_scope,source_url FROM storefront_part_reference_evidence WHERE part_id=? AND number=?",
            (row["id"], row["oem_number"]),
        ).fetchone()
    except sqlite3.OperationalError:
        reference = None
    payload["part_number_label"] = "رقم المورد (يحتاج توثيق)"
    payload["manufacturer_number"] = None
    if reference:
        payload["oem_verification_status"] = reference["verification_scope"]
        payload["part_number_source_url"] = reference["source_url"]
        if reference["verification_scope"] == "official_published_reference":
            payload["part_number_label"] = "رقم القطعة المنشور لدى الوكيل"
            payload["manufacturer_number"] = reference["number"]
    payload["short_description_ar"] = public_product_description(payload)
    if detailed:
        payload["description"] = payload["short_description_ar"]
    if detailed:
        payload["warranty_text"] = "تُؤكد تفاصيل الضمان الخاصة بهذه القطعة قبل إتمام الطلب."
        payload["return_policy"] = (
            "تُعرض شروط الإرجاع المعتمدة للعميل قبل إتمام الطلب، وتختلف أهلية الإرجاع "
            "بحسب حالة القطعة وسياسة البيع التي يعتمدها المتجر."
        )
        payload["oem_numbers"] = product_oem_numbers(con, row["id"], row["oem_number"])
        payload["oem_numbers"] = [o for o in payload["oem_numbers"]
                                  if not re.match(r"^(?:SALLA-|QETAA-|CAP\d+$)", str(o.get("number", "")), re.I)]
        if reference:
            payload["oem_numbers"] = [{"number": reference["number"], "relation_type": "primary",
                                       "verification_status": reference["verification_scope"]}]
        payload["fitments"] = product_fitments(con, row["id"])
        years = sorted({int(f["year"]) for f in payload["fitments"] if f.get("year")})
        payload["compatible_years"] = years
        payload["specs"] = build_product_specs(payload, years)
    return payload



def product_payloads_batch(con: sqlite3.Connection, rows: list, detailed: bool = False) -> list[dict]:
    """Build list payloads with batched lookups to avoid N+1 queries."""
    if not rows:
        return []
    if detailed:
        return [product_payload(con, r, detailed=True) for r in rows]

    ids = [int(r["id"]) for r in rows]
    placeholders = ",".join("?" for _ in ids)

    images_by_pid: dict[int, list[dict]] = {i: [] for i in ids}
    for r in con.execute(
        f"""
        SELECT product_id, id, file_path, alt_text_ar, alt_text_en, is_primary, optimized_format, license_status
        FROM product_images
        WHERE product_id IN ({placeholders})
          AND source_type IN ('owned','licensed','official')
          AND oem_number_id IS NOT NULL
          AND license_reference IS NOT NULL
          AND license_owner IS NOT NULL
          AND license_status='approved'
          AND quality_status='approved'
          AND optimized_format IN ('webp','avif')
          AND (COALESCE(has_watermark,0)=0 OR watermark_usage_status='licensed')
        ORDER BY is_primary DESC, sort_order ASC, id ASC
        """,
        ids,
    ).fetchall():
        pid = int(r["product_id"])
        if len(images_by_pid[pid]) >= 2:
            continue
        images_by_pid[pid].append(
            {
                "id": r["id"],
                "url": image_url(r["file_path"]),
                "alt_ar": r["alt_text_ar"],
                "alt_en": r["alt_text_en"],
                "is_primary": bool(r["is_primary"]),
                "format": r["optimized_format"],
                "license_status": r["license_status"],
            }
        )

    brand_ids = sorted({int(r["brand_id"]) for r in rows if r["brand_id"]})
    brands_map: dict[int, dict] = {}
    if brand_ids:
        bph = ",".join("?" for _ in brand_ids)
        for b in con.execute(
            f"SELECT id, name_ar, name_en, slug FROM brands WHERE id IN ({bph})",
            brand_ids,
        ).fetchall():
            brands_map[int(b["id"])] = {
                "id": b["id"],
                "name_ar": b["name_ar"],
                "name_en": b["name_en"],
                "slug": b["slug"],
            }

    cat_ids = sorted({int(r["category_id"]) for r in rows if r["category_id"]})
    cats_map: dict[int, dict] = {}
    if cat_ids:
        cph = ",".join("?" for _ in cat_ids)
        for c in con.execute(
            f"SELECT id, name_ar, name_en, slug FROM categories WHERE id IN ({cph})",
            cat_ids,
        ).fetchall():
            cats_map[int(c["id"])] = {
                "id": c["id"],
                "name_ar": c["name_ar"],
                "name_en": c["name_en"],
                "slug": c["slug"],
            }

    salla_map: dict[int, sqlite3.Row] = {}
    for s in con.execute(
        f"""
        SELECT product_id, salla_product_id, sync_status, last_known_quantity, last_known_price
        FROM salla_products
        WHERE product_id IN ({placeholders})
        """,
        ids,
    ).fetchall():
        salla_map[int(s["product_id"])] = s

    zid_map: dict[int, sqlite3.Row] = {}
    try:
        for z in con.execute(
            f"""
            SELECT product_id, zid_product_id, zid_sku, sync_status, last_known_quantity, last_known_price
            FROM zid_products
            WHERE product_id IN ({placeholders})
            """,
            ids,
        ).fetchall():
            zid_map[int(z["product_id"])] = z
    except sqlite3.OperationalError:
        pass

    out = []
    for row in rows:
        pid = int(row["id"])
        images = images_by_pid.get(pid) or []
        brand = brands_map.get(int(row["brand_id"])) if row["brand_id"] else None
        category = cats_map.get(int(row["category_id"])) if row["category_id"] else None
        salla = salla_map.get(pid)
        salla_sync = salla["sync_status"] if salla else None
        salla_stock = salla["last_known_quantity"] if salla else None
        salla_price = salla["last_known_price"] if salla else None
        salla_id = None
        if salla_sync == "synced" and salla and salla["salla_product_id"]:
            salla_id = str(salla["salla_product_id"]).strip() or None
        salla_id = resolve_salla_checkout_id(pid, salla_id)

        zid = zid_map.get(pid)
        zid_sync = zid["sync_status"] if zid else None
        zid_stock = zid["last_known_quantity"] if zid else None
        zid_price = zid["last_known_price"] if zid else None
        zid_id = None
        zid_sku = None
        if zid_sync == "synced" and zid and zid["zid_product_id"]:
            zid_id = str(zid["zid_product_id"]).strip() or None
            zid_sku = str(zid["zid_sku"] or "").strip() or None

        price = float(row["price"]) if row["price"] is not None else None
        checkout_truth = checkout_truth_state(
            price,
            salla_id=salla_id,
            salla_stock=salla_stock,
            salla_price=salla_price,
            zid_id=zid_id,
            zid_stock=zid_stock,
            zid_price=zid_price,
            allow_unverified_sku=salla_checkout_by_sku_enabled(),
        )
        stock_qty = checkout_truth["stock_quantity"]
        in_stock = checkout_truth["in_stock"]
        can_checkout = checkout_truth["can_checkout"]
        out.append(
            {
                "id": row["id"],
                "slug": row["slug"],
                "name_ar": public_product_name(row["name_ar"]),
                "name_en": public_product_name(row["name_en"]),
                "short_description_ar": None,
                "description": None,
                "oem_number": None if is_placeholder_oem(row["oem_number"]) else row["oem_number"],
                "price": price,
                "price_label": f"{price:.2f} ر.س" if price is not None else "السعر عند الطلب",
                "brand": brand,
                "category": category,
                "image_url": images[0]["url"] if images else None,
                "images": images,
                "image_count": len(images),
                "is_ready_for_publishing": True,
                "salla_product_id": salla_id,
                "zid_product_id": zid_id,
                "zid_sku": zid_sku,
                "checkout_provider": checkout_truth["provider"],
                "can_checkout": can_checkout,
                "checkout_enabled": can_checkout,
                "checkout_price_verified": checkout_truth["price_verified"],
                "checkout_blockers": checkout_truth["blockers"],
                "stock_quantity": stock_qty,
                "in_stock": in_stock,
                "availability_label": ("متوفر" if in_stock else "غير متوفر") if in_stock is not None else "التوفر يحتاج تأكيد",
                "availability_status": ("in_stock" if in_stock else "out_of_stock") if in_stock is not None else "unknown",
                "part_type": None,
                "sku": row["sku"] if "sku" in row.keys() else None,
                "country_of_origin": None,
                "manufacturer": None,
            }
        )
        out[-1]["short_description_ar"] = public_product_description(out[-1])
    return out


def brands_payload(con: sqlite3.Connection) -> list[dict]:
    rows = con.execute(
        f"""
        SELECT b.id, b.name_ar, b.name_en, b.slug, b.logo,
               (
                 SELECT COUNT(*)
                 FROM parts p
                 WHERE {READY_WHERE}
                   AND (
                     p.brand_id = b.id
                     OR EXISTS (
                       SELECT 1
                       FROM fitments f
                       JOIN vehicles v ON v.id = f.vehicle_id
                       JOIN car_models m ON m.id = v.car_model_id
                       WHERE f.part_id = p.id
                         AND f.review_status = 'approved'
                         AND f.verified_at IS NOT NULL
                         AND f.verified_by IS NOT NULL
                         AND m.brand_id = b.id
                     )
                   )
               ) AS products_count
        FROM brands b
        WHERE COALESCE(b.is_active,1)=1
        ORDER BY b.name_ar ASC
        """
    ).fetchall()

    seen_slugs = set()
    out = []
    for r in rows:
        slug = r["slug"]
        if slug in seen_slugs:
            continue
        skip = False
        for primary, sec in BRAND_SLUG_GROUPS:
            if slug == sec and primary in seen_slugs:
                skip = True
                break
        if skip:
            continue

        products_count = int(r["products_count"] or 0)

        logo = r["logo"]
        logo_url = image_url(logo) if logo else None

        seen_slugs.add(slug)
        out.append(
            {
                "id": r["id"],
                "name_ar": r["name_ar"],
                "name_en": r["name_en"],
                "slug": slug,
                "country": "الصين",
                "logo": logo_url,
                "logo_url": logo_url,
                "products_count": products_count,
                "has_products": products_count > 0,
            }
        )
    return out


def categories_payload(con: sqlite3.Connection) -> list[dict]:
    rows = con.execute(
        """
        SELECT c.id, c.name_ar, c.name_en, c.slug, c.icon, c.parent_id
        FROM categories c
        ORDER BY c.name_ar ASC
        """
    ).fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "name_ar": r["name_ar"],
                "name_en": r["name_en"],
                "slug": r["slug"],
                "icon": r["icon"],
                "parent_id": r["parent_id"],
            }
        )
    return out


def fetch_checkoutable_products(con: sqlite3.Connection, limit: int = 24) -> list[dict]:
    """Products with verified Zid (preferred) or Salla mapping."""
    ensure_zid_schema(con)
    rows = con.execute(
        f"""
        SELECT p.*
        FROM parts p
        WHERE {READY_WHERE}
        AND (
          EXISTS (
            SELECT 1 FROM zid_products zp
            WHERE zp.product_id = p.id
              AND zp.sync_status = 'synced'
              AND zp.zid_product_id IS NOT NULL
              AND trim(zp.zid_product_id) != ''
              AND zp.last_known_quantity IS NOT NULL
              AND zp.last_known_quantity > 0
          )
          OR EXISTS (
            SELECT 1 FROM salla_products sp
            WHERE sp.product_id = p.id
              AND sp.sync_status = 'synced'
              AND sp.salla_product_id IS NOT NULL
              AND trim(sp.salla_product_id) != ''
              AND sp.last_known_quantity IS NOT NULL
              AND sp.last_known_quantity > 0
          )
        )
        ORDER BY
          CASE WHEN EXISTS (
            SELECT 1 FROM zid_products zp2
            WHERE zp2.product_id = p.id AND zp2.sync_status = 'synced'
          ) THEN 0 ELSE 1 END,
          p.id DESC
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    return [product_payload(con, r, detailed=False) for r in rows]


def fetch_ready_products(
    con: sqlite3.Connection,
    limit: int = 24,
    offset: int = 0,
    brand_id: int | None = None,
    category_id: int | None = None,
    category_key: str | None = None,
    model_id: int | None = None,
    year: int | None = None,
    vehicle_id: int | None = None,
    q: str | None = None,
    min_price: float | None = None,
    max_price: float | None = None,
    in_stock: str | None = None,
    part_type: str | None = None,
    sort: str = "newest",
    checkout_only: bool = False,
) -> tuple[list[dict], int]:
    if checkout_only:
        items = fetch_checkoutable_products(con, limit=limit + offset)
        total = len(items)
        return items[offset: offset + limit], total

    leftover_tokens: list[str] = []
    if q:
        brand_id, category_key, leftover_tokens = parse_search_intent(
            con, q, brand_id=brand_id, category_key=category_key
        )

    where_parts = [READY_WHERE]
    params: list = []

    if brand_id:
        where_parts.append(
            """
            (
                p.brand_id = ?
                OR EXISTS (
                    SELECT 1
                    FROM fitments f
                    JOIN vehicles v ON v.id = f.vehicle_id
                    JOIN car_models m ON m.id = v.car_model_id
                    WHERE f.part_id = p.id
                      AND f.review_status = 'approved' AND f.verified_at IS NOT NULL AND f.verified_by IS NOT NULL
                      AND m.brand_id = ?
                )
            )
            """
        )
        params.extend([brand_id, brand_id])

    key_sql, key_params = category_key_clause(category_key)
    if key_sql:
        # Featured storefront sections match by keywords — category_id in DB
        # often points at vehicle/model buckets, not part-type taxonomy.
        where_parts.append(key_sql)
        params.extend(key_params)
    elif category_id:
        where_parts.append("p.category_id = ?")
        params.append(category_id)

    if model_id:
        where_parts.append(
            "EXISTS (SELECT 1 FROM fitments f JOIN vehicles v ON v.id=f.vehicle_id WHERE f.part_id=p.id AND v.car_model_id=? AND f.review_status='approved' AND f.verified_at IS NOT NULL AND f.verified_by IS NOT NULL)"
        )
        params.append(model_id)
    if year:
        where_parts.append(
            "EXISTS (SELECT 1 FROM fitments f JOIN vehicles v ON v.id=f.vehicle_id WHERE f.part_id=p.id AND v.year=? AND f.review_status='approved' AND f.verified_at IS NOT NULL AND f.verified_by IS NOT NULL)"
        )
        params.append(year)
    if vehicle_id:
        where_parts.append(
            "EXISTS (SELECT 1 FROM fitments f WHERE f.part_id=p.id AND f.vehicle_id=? AND f.review_status='approved' AND f.verified_at IS NOT NULL AND f.verified_by IS NOT NULL)"
        )
        params.append(vehicle_id)
    if min_price is not None:
        where_parts.append("p.price >= ?")
        params.append(min_price)
    if max_price is not None:
        where_parts.append("p.price <= ?")
        params.append(max_price)

    # Unknown stock stays unknown; only explicit quantities enter availability filters.
    stock_expr = """
        COALESCE(
            (
                SELECT zp.last_known_quantity FROM zid_products zp
                WHERE zp.product_id = p.id AND zp.sync_status = 'synced'
                  AND zp.zid_product_id IS NOT NULL AND trim(zp.zid_product_id) != ''
                LIMIT 1
            ),
            (
                SELECT sp.last_known_quantity FROM salla_products sp
                WHERE sp.product_id = p.id
                  AND sp.salla_product_id IS NOT NULL AND trim(sp.salla_product_id) != ''
                LIMIT 1
            )
        )
    """
    if in_stock == "true":
        where_parts.append(f"({stock_expr} IS NOT NULL AND {stock_expr} > 0)")
    elif in_stock == "false":
        where_parts.append(f"({stock_expr} IS NOT NULL AND {stock_expr} <= 0)")

    # A part number alone cannot establish "original" versus "aftermarket".
    # Keep the legacy parameter accepted but deliberately do not classify by it.

    for token in leftover_tokens:
        token_sql, token_params = text_match_clause(token)
        where_parts.append(token_sql)
        params.extend(token_params)

    where_sql = " AND ".join(where_parts)

    count_sql = f"SELECT COUNT(*) FROM parts p WHERE {where_sql}"
    total = con.execute(count_sql, params).fetchone()[0]

    order_params: list = []
    order_sql = "ORDER BY p.id DESC"
    if sort == "price_asc":
        order_sql = "ORDER BY p.price ASC, p.id DESC"
    elif sort == "price_desc":
        order_sql = "ORDER BY p.price DESC, p.id DESC"
    elif q and str(q).strip():
        exact = str(q).strip()
        order_sql = """
            ORDER BY
              CASE
                WHEN lower(COALESCE(p.sku,'')) = lower(?) THEN 0
                WHEN lower(COALESCE(p.manufacturer_number,'')) = lower(?) THEN 1
                WHEN lower(COALESCE(p.oem_number,'')) = lower(?) THEN 2
                WHEN lower(COALESCE(p.name_ar,'')) = lower(?) THEN 3
                WHEN lower(COALESCE(p.name_en,'')) = lower(?) THEN 4
                ELSE 5
              END,
              p.id DESC
        """
        order_params = [exact, exact, exact, exact, exact]

    query_sql = f"""
        SELECT p.*
        FROM parts p
        WHERE {where_sql}
        {order_sql}
        LIMIT ? OFFSET ?
    """
    rows = con.execute(query_sql, params + order_params + [limit, offset]).fetchall()

    payloads = product_payloads_batch(con, rows, detailed=False)
    return payloads, total


def storefront_query_options(con: sqlite3.Connection, qs: dict, per_page_default: int = 24) -> dict:
    def positive_int(key: str, default: int | None = None) -> int | None:
        raw = (qs.get(key) or [""])[0]
        try:
            value = int(raw)
            return value if value > 0 else default
        except (TypeError, ValueError, OverflowError):
            return default

    def nonnegative_float(key: str) -> float | None:
        raw = (qs.get(key) or [""])[0]
        try:
            value = float(raw)
            return value if math.isfinite(value) and value >= 0 else None
        except (TypeError, ValueError, OverflowError):
            return None

    page = positive_int("page", 1) or 1
    per_page = min(positive_int("per_page", per_page_default) or per_page_default, 100)
    brand_raw = (qs.get("brand_id") or qs.get("brand") or [""])[0]
    brand_id = int(brand_raw) if str(brand_raw).isdigit() and int(brand_raw) > 0 else None
    if brand_id is None:
        brand_slug = (qs.get("brand_slug") or qs.get("slug") or [""])[0].strip().lower()
        if brand_slug:
            brand_row = con.execute(
                "SELECT id FROM brands WHERE lower(slug)=? AND COALESCE(is_active,1)=1 LIMIT 1",
                (brand_slug,),
            ).fetchone()
            brand_id = int(brand_row["id"]) if brand_row else None
    category_raw = (qs.get("category_id") or qs.get("category") or [""])[0]
    category_id = int(category_raw) if str(category_raw).isdigit() and int(category_raw) > 0 else None
    category_key = (qs.get("category_key") or qs.get("section") or [""])[0].strip().lower() or None
    if not category_key and category_raw and not str(category_raw).isdigit():
        category_key = str(category_raw).strip().lower()
    model_id = positive_int("model_id") or positive_int("model")
    year = positive_int("year")
    vehicle_id = positive_int("vehicle_id")
    in_stock = (qs.get("in_stock") or [None])[0]
    if in_stock in {"1", "yes"}:
        in_stock = "true"
    elif in_stock in {"0", "no"}:
        in_stock = "false"
    elif in_stock not in {"true", "false"}:
        in_stock = None
    sort = (qs.get("sort") or ["newest"])[0]
    if sort in {"latest", "new", "id_desc"}:
        sort = "newest"
    if sort not in {"newest", "price_asc", "price_desc"}:
        sort = "newest"
    return {
        "page": page,
        "per_page": per_page,
        "brand_id": brand_id,
        "category_id": category_id,
        "category_key": category_key,
        "model_id": model_id,
        "year": year,
        "vehicle_id": vehicle_id,
        "q": (qs.get("q") or qs.get("search") or [None])[0],
        "sort": sort,
        "in_stock": in_stock,
        "part_type": None,
        "checkout_only": str((qs.get("checkout") or qs.get("can_checkout") or [""])[0]).lower()
        in {"1", "true", "yes"},
        "min_price": nonnegative_float("min_price"),
        "max_price": nonnegative_float("max_price"),
    }


def _collection_query_is_indexable(qs: dict) -> bool:
    for key, values in qs.items():
        if key in {"page", "per_page"}:
            continue
        if key == "sort" and str((values or [""])[0]).strip().lower() in {"", "latest", "newest", "new", "id_desc"}:
            continue
        if any(str(value).strip() for value in values):
            return False
    return True


def _render_collection_listing(
    con: sqlite3.Connection,
    qs: dict,
    *,
    title: str,
    description: str,
    canonical_path: str,
    path_for_page,
    breadcrumbs: list[dict],
    landing: dict,
    index: bool = True,
    extra_options: dict | None = None,
) -> tuple[bytes, int]:
    template = (ROOT / "collection.html").read_text(encoding="utf-8")
    options = storefront_query_options(con, qs)
    options.update(extra_options or {})
    page = max(1, int(options.pop("page") or 1))
    per_page = options.pop("per_page")
    products, total = fetch_ready_products(
        con,
        limit=per_page,
        offset=(page - 1) * per_page,
        **options,
    )
    last_page = max(1, (int(total or 0) + per_page - 1) // per_page)
    if page > last_page and total:
        page = last_page
        products, total = fetch_ready_products(
            con,
            limit=per_page,
            offset=(page - 1) * per_page,
            **options,
        )
    source = collection_page(
        template,
        products,
        total,
        _resolve_base_url(),
        title=title,
        description=description,
        canonical_path=canonical_path,
        index=index,
        page=page,
        last_page=last_page,
        path_for_page=path_for_page,
        breadcrumbs=breadcrumbs,
        landing=landing,
    )
    return source.encode("utf-8"), 200


def render_storefront_document(con: sqlite3.Connection, path: str, qs: dict) -> tuple[bytes, int]:
    if path == "/product.html":
        template = (ROOT / "product.html").read_text(encoding="utf-8")
        key = str((qs.get("id") or qs.get("slug") or [""])[0]).strip()
        if key.isdigit():
            row = con.execute(
                f"SELECT p.* FROM parts p WHERE p.id=? AND {READY_WHERE}",
                (int(key),),
            ).fetchone()
        else:
            row = con.execute(
                f"SELECT p.* FROM parts p WHERE p.slug=? AND {READY_WHERE}",
                (key,),
            ).fetchone() if key else None
        if row is None:
            missing = html_metadata(
                template,
                "القطعة غير موجودة | CHINA PARTS",
                "تعذر العثور على القطعة المطلوبة. تصفح الكتالوج أو تواصل معنا لطلبها.",
                f"{_resolve_base_url()}/product.html",
                index=False,
            )
            return missing.encode("utf-8"), 404
        product = product_payload(con, row, detailed=True)
        crumbs = product_internal_crumbs(con, product)
        seo = product_seo_payload(product, crumbs)
        return product_page(template, product, seo).encode("utf-8"), 200

    landing = parse_storefront_landing(path)
    base = _resolve_base_url()
    crumbs_home = {"name": "الرئيسية", "item": f"{base}/"}
    crumbs_catalog = {"name": "الكتالوج", "item": f"{base}/collection.html"}

    if landing and landing["kind"] == "brand":
        brand = next(
            (item for item in indexable_brand_landings(con) if str(item["slug"]).lower() == landing["slug"]),
            None,
        )
        if brand is None:
            missing = html_metadata(
                (ROOT / "collection.html").read_text(encoding="utf-8"),
                "الماركة غير متاحة | CHINA PARTS",
                "لا توجد قطع مؤهلة للفهرسة لهذه الماركة حالياً.",
                f"{base}/collection.html",
                index=False,
            )
            return missing.encode("utf-8"), 404
        copy = LANDING_KEYWORD_MAP["brand"]
        name = brand["name_ar"] or brand["name_en"] or landing["slug"]
        page = landing["page"]
        canonical = brand_landing_path(brand["slug"], page)
        return _render_collection_listing(
            con,
            qs,
            title=copy["title"].format(name=name),
            description=copy["description"].format(name=name),
            canonical_path=canonical,
            path_for_page=lambda n, slug=brand["slug"]: brand_landing_path(slug, n),
            breadcrumbs=[crumbs_home, crumbs_catalog, {"name": name, "item": f"{base}{brand_landing_path(brand['slug'])}"}],
            landing={"kind": "brand", "slug": brand["slug"], "id": brand["id"], "name_ar": name},
            extra_options={"brand_id": int(brand["id"]), "page": page},
        )

    if landing and landing["kind"] == "category":
        category = next(
            (item for item in indexable_category_landings(con) if item["key"] == landing["slug"]),
            None,
        )
        if category is None:
            missing = html_metadata(
                (ROOT / "collection.html").read_text(encoding="utf-8"),
                "القسم غير متاح | CHINA PARTS",
                "لا توجد قطع مؤهلة للفهرسة لهذا القسم حالياً.",
                f"{base}/collection.html",
                index=False,
            )
            return missing.encode("utf-8"), 404
        copy = LANDING_KEYWORD_MAP["category"]
        name = category["name_ar"]
        page = landing["page"]
        canonical = category_landing_path(category["key"], page)
        return _render_collection_listing(
            con,
            qs,
            title=copy["title"].format(name=name),
            description=copy["description"].format(name=name),
            canonical_path=canonical,
            path_for_page=lambda n, key=category["key"]: category_landing_path(key, n),
            breadcrumbs=[crumbs_home, crumbs_catalog, {"name": name, "item": f"{base}{category_landing_path(category['key'])}"}],
            landing={"kind": "category", "key": category["key"], "name_ar": name},
            extra_options={"category_key": category["key"], "page": page},
        )

    if landing and landing["kind"] == "model":
        model = next(
            (item for item in indexable_model_landings(con) if int(item["id"]) == int(landing["model_id"])),
            None,
        )
        if model is None:
            missing = html_metadata(
                (ROOT / "collection.html").read_text(encoding="utf-8"),
                "الموديل غير موثق | CHINA PARTS",
                "لا ننشر صفحة موديل إلا عند وجود قطع بتوافق مراجع ومعتمد.",
                f"{base}/collection.html",
                index=False,
            )
            return missing.encode("utf-8"), 404
        copy = LANDING_KEYWORD_MAP["model"]
        name = f"{model['brand_name']} {model['name_ar']}".strip()
        page = landing["page"]
        canonical = model_landing_path(model["id"], page)
        return _render_collection_listing(
            con,
            qs,
            title=copy["title"].format(name=name),
            description=copy["description"].format(name=name),
            canonical_path=canonical,
            path_for_page=lambda n, mid=model["id"]: model_landing_path(mid, n),
            breadcrumbs=[crumbs_home, crumbs_catalog, {"name": name, "item": f"{base}{model_landing_path(model['id'])}"}],
            landing={"kind": "model", "id": model["id"], "name_ar": name},
            extra_options={"model_id": int(model["id"]), "page": page},
        )

    raw_query = str((qs.get("q") or qs.get("search") or [""])[0] or "").strip()
    title = f"نتائج البحث عن {raw_query}" if raw_query else "قطع غيار السيارات الصينية"
    description = (
        f"نتائج البحث عن {raw_query} في كتالوج CHINA PARTS."
        if raw_query
        else "تصفح كتالوج قطع غيار السيارات الصينية، وقارن رقم القطعة وتأكد من التوفر قبل طلب التحقق."
    )
    page = storefront_query_options(con, qs)["page"]
    canonical = "/collection.html" if page <= 1 else f"/collection.html?page={page}"
    return _render_collection_listing(
        con,
        qs,
        title=title,
        description=description,
        canonical_path=canonical if _collection_query_is_indexable(qs) else "/collection.html",
        path_for_page=lambda n: "/collection.html" if n <= 1 else f"/collection.html?page={n}",
        breadcrumbs=[crumbs_home, crumbs_catalog],
        landing={"kind": "catalog"},
        index=_collection_query_is_indexable(qs),
    )


def decode_vin_payload(con: sqlite3.Connection, vin: str) -> dict:
    """Never infer part compatibility from a VIN prefix or model-year character."""
    vin = vin.strip().upper()
    valid = bool(re.fullmatch(r"[A-HJ-NPR-Z0-9]{17}", vin))
    return {
        "vin": vin,
        "is_valid": valid,
        "validation_scope": "format_only",
        "verification_status": "provider_required" if valid else "invalid_format",
        "fitment_verified": False,
        "has_local_fitment": False,
        "brand": None,
        "model": None,
        "year": None,
        "vehicle": {"id": None, "matched": False},
        "decoded": {},
        "matching_parts": [],
        "matching_count": 0,
        "message": (
            "لم يتم تأكيد بيانات هذه السيارة أو قطعها من كتالوج الشركة. تواصل معنا للتحقق من رقم الهيكل قبل اختيار القطعة."
            if valid else "رقم الهيكل غير صحيح. يجب إدخال 17 خانة بدون الحروف I و O و Q."
        ),
    }


def handle_admin_stats(con: sqlite3.Connection) -> dict:
    total_parts = con.execute("SELECT COUNT(*) FROM parts").fetchone()[0]
    published_parts = con.execute("SELECT COUNT(*) FROM parts WHERE status='published'").fetchone()[0]
    draft_parts = con.execute("SELECT COUNT(*) FROM parts WHERE status!='published'").fetchone()[0]
    total_brands = con.execute("SELECT COUNT(*) FROM brands").fetchone()[0]
    total_models = con.execute("SELECT COUNT(*) FROM car_models").fetchone()[0]
    total_categories = con.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
    total_fitments = con.execute("SELECT COUNT(*) FROM fitments").fetchone()[0]
    total_oems = con.execute("SELECT COUNT(*) FROM product_oem_numbers").fetchone()[0]
    total_contact = con.execute("SELECT COUNT(*) FROM contact_messages").fetchone()[0]
    total_inquiries = con.execute("SELECT COUNT(*) FROM checkout_inquiries").fetchone()[0]

    stats_dict = {
        "total_products": total_parts,
        "published_products": published_parts,
        "draft_products": draft_parts,
        "total_brands": total_brands,
        "total_models": total_models,
        "total_categories": total_categories,
        "total_fitments": total_fitments,
        "total_oem_numbers": total_oems,
        "total_orders": total_inquiries,
        "pending_inquiries": total_inquiries,
        "total_contact_messages": total_contact,
    }

    return {
        "stats": stats_dict,
        "counts": stats_dict,
        "image_compliance": {
            "approved": published_parts,
            "pending": 0,
            "rejected": 0,
        }
    }


def handle_admin_products(con: sqlite3.Connection, qs: dict) -> dict:
    page = int((qs.get("page") or ["1"])[0])
    per_page = min(max(int((qs.get("per_page") or ["20"])[0]), 1), 100)
    search = (qs.get("search") or qs.get("q") or [""])[0].strip()
    status = (qs.get("status") or [""])[0].strip()
    brand_id = (qs.get("brand_id") or [""])[0].strip()
    category_id = (qs.get("category_id") or [""])[0].strip()

    where_clauses = ["1=1"]
    params = []
    if search:
        where_clauses.append("(p.name_ar LIKE ? OR p.name_en LIKE ? OR p.oem_number LIKE ? OR p.sku LIKE ?)")
        term = f"%{search}%"
        params.extend([term, term, term, term])
    if status and status != "all":
        where_clauses.append("p.status = ?")
        params.append(status)
    if brand_id and brand_id.isdigit():
        where_clauses.append("p.brand_id = ?")
        params.append(int(brand_id))
    if category_id and category_id.isdigit():
        where_clauses.append("p.category_id = ?")
        params.append(int(category_id))

    where_str = " AND ".join(where_clauses)
    total = con.execute(f"SELECT COUNT(*) FROM parts p WHERE {where_str}", params).fetchone()[0]

    offset = (page - 1) * per_page
    rows = con.execute(
        f"""
        SELECT p.*, b.name_ar as brand_name_ar, c.name_ar as category_name_ar
        FROM parts p
        LEFT JOIN brands b ON p.brand_id = b.id
        LEFT JOIN categories c ON p.category_id = c.id
        WHERE {where_str}
        ORDER BY p.id DESC
        LIMIT ? OFFSET ?
        """,
        params + [per_page, offset],
    ).fetchall()

    data = []
    for r in rows:
        dict_row = dict(r)
        dict_row["brand"] = {"id": r["brand_id"], "name_ar": r["brand_name_ar"]} if r["brand_id"] else None
        dict_row["category"] = {"id": r["category_id"], "name_ar": r["category_name_ar"]} if r["category_id"] else None
        imgs = product_images(con, r["id"])
        dict_row["image_url"] = imgs[0]["url"] if imgs else None
        dict_row["images"] = imgs
        dict_row["price_label"] = f"{float(r['price']):.2f} ر.س" if r["price"] is not None else "السعر عند الطلب"
        data.append(dict_row)

    last_page = max(1, (total + per_page - 1) // per_page)
    return {
        "data": data,
        "meta": {
            "current_page": page,
            "last_page": last_page,
            "per_page": per_page,
            "total": total,
        },
    }


def handle_admin_table_list(con: sqlite3.Connection, table_name: str, qs: dict, name_col: str = "name_ar", search_cols: list[str] | None = None) -> dict:
    if search_cols is None:
        search_cols = ["name_ar", "name_en", "slug"]
    page = int((qs.get("page") or ["1"])[0])
    per_page = min(max(int((qs.get("per_page") or ["50"])[0]), 1), 200)
    search = (qs.get("search") or qs.get("q") or [""])[0].strip()

    cols = [r[1] for r in con.execute(f"PRAGMA table_info({table_name})").fetchall()]
    valid_search = [c for c in search_cols if c in cols]

    where_clauses = ["1=1"]
    params = []
    if search and valid_search:
        clause = " OR ".join([f"{c} LIKE ?" for c in valid_search])
        where_clauses.append(f"({clause})")
        term = f"%{search}%"
        params.extend([term] * len(valid_search))

    where_str = " AND ".join(where_clauses)
    total = con.execute(f"SELECT COUNT(*) FROM {table_name} WHERE {where_str}", params).fetchone()[0]

    offset = (page - 1) * per_page
    order_col = name_col if name_col in cols else ("id" if "id" in cols else cols[0])
    rows = con.execute(
        f"SELECT * FROM {table_name} WHERE {where_str} ORDER BY {order_col} DESC LIMIT ? OFFSET ?",
        params + [per_page, offset],
    ).fetchall()

    last_page = max(1, (total + per_page - 1) // per_page)
    return {
        "data": [dict(r) for r in rows],
        "meta": {
            "current_page": page,
            "last_page": last_page,
            "per_page": per_page,
            "total": total,
        },
    }


class Handler(BaseHTTPRequestHandler):
    def parse_request(self) -> bool:
        if not super().parse_request():
            return False
        path, qs = self._get_clean_path()
        if path.startswith('/api/admin/') and path != '/api/admin/auth/login' and self.command != 'OPTIONS':
            con = connect()
            try:
                raw = self.headers.get('Authorization', '')
                token = raw[7:].strip() if raw.lower().startswith('bearer ') else ''
                user = con.execute('''
                    SELECT u.id, u.name, u.email FROM admin_api_tokens t
                    JOIN users u ON u.id=t.user_id
                    WHERE t.token_hash=? AND t.revoked_at IS NULL
                    AND (t.expires_at IS NULL OR datetime(t.expires_at)>datetime('now'))
                ''', (hash_token(token),)).fetchone() if token else None
                # The Python admin API currently supports the full-access dashboard only.
                if not user or not con.execute('''
                    SELECT 1 FROM role_user ru JOIN roles r ON r.id=ru.role_id
                    WHERE ru.user_id=? AND r.name='super_admin'
                ''', (user['id'],)).fetchone():
                    self.json({'message': 'يلزم تسجيل الدخول بحساب مدير صالح.'}, status=401)
                    return False
                self.admin_user = dict(user)
                self.admin_token_hash = hash_token(token)
            finally:
                con.close()
        if self.command == 'GET' and path.startswith('/api/'):
            try:
                for key in ('page', 'per_page', 'limit', 'brand_id', 'category_id', 'model_id', 'vehicle_id', 'year'):
                    if qs.get(key) and qs[key][0] != '' and int(qs[key][0]) < 1:
                        raise ValueError(key)
                for key in ('min_price', 'max_price'):
                    if qs.get(key) and qs[key][0] != '':
                        value = float(qs[key][0])
                        if not math.isfinite(value) or value < 0:
                            raise ValueError(key)
                if qs.get('min_price') and qs.get('max_price') and qs['min_price'][0] and qs['max_price'][0]:
                    if float(qs['min_price'][0]) > float(qs['max_price'][0]):
                        raise ValueError('price range')
            except (ValueError, OverflowError):
                self.json({'message': 'قيم البحث أو الترقيم غير صحيحة.'}, status=422)
                return False
        return True

    def _handle_admin_login(self, body: dict) -> None:
        try:
            import bcrypt
        except ImportError:
            self.json({'message': 'يلزم تثبيت متطلبات التشغيل: python -m pip install -r requirements.txt'}, status=503)
            return
        con = connect()
        try:
            user = con.execute('''
                SELECT u.* FROM users u WHERE lower(u.email)=lower(?)
                AND EXISTS (SELECT 1 FROM role_user ru JOIN roles r ON r.id=ru.role_id
                    WHERE ru.user_id=u.id AND r.name='super_admin')
            ''', (str(body.get('email') or '').strip(),)).fetchone()
            valid = False
            if user:
                try:
                    valid = bcrypt.checkpw(str(body.get('password') or '').encode(), user['password'].encode())
                except (ValueError, TypeError):
                    pass
            if not valid:
                self.json({'message': 'بيانات الدخول غير صحيحة أو لا تملك صلاحية الإدارة.'}, status=422)
                return
            token = secrets.token_hex(32)
            con.execute('''
                INSERT INTO admin_api_tokens (user_id,name,token_hash,abilities,expires_at,created_at,updated_at)
                VALUES (?,'admin-dashboard',?,'["admin:*"]',datetime('now','+12 hours'),datetime('now'),datetime('now'))
            ''', (user['id'], hash_token(token)))
            con.execute("UPDATE users SET last_login_at=datetime('now') WHERE id=?", (user['id'],))
            con.commit()
            self.json({'token': token, 'user': {key: user[key] for key in ('id','name','email')}})
        finally:
            con.close()

    server_version = "QetaaLocalAPI/1.0"

    def _get_clean_path(self) -> tuple[str, dict]:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("http://") or path.startswith("https://"):
            path = urllib.parse.urlparse(path).path
        qs = urllib.parse.parse_qs(parsed.query)
        return path, qs

    def _client_key(self) -> str:
        forwarded = str(self.headers.get("X-Forwarded-For") or "").split(",", 1)[0].strip()
        real_ip = str(self.headers.get("X-Real-IP") or "").strip()
        direct = str(self.client_address[0] if self.client_address else "unknown")
        candidate = forwarded or real_ip or direct
        return candidate[:80]

    def _enforce_rate_limit(self, path: str) -> bool:
        bucket = POST_RATE_BUCKETS.get(path)
        if not bucket:
            return True
        allowed, retry_after = rate_limit_check(self._client_key(), bucket)
        if allowed:
            return True
        self.json(
            {"message": "محاولات كثيرة. حاول مرة أخرى بعد قليل."},
            status=429,
            headers={"Retry-After": str(retry_after)},
        )
        return False

    def _write_origin_allowed(self) -> bool:
        origin = str(self.headers.get("Origin") or "").strip().rstrip("/")
        fetch_site = str(self.headers.get("Sec-Fetch-Site") or "").strip().lower()
        if fetch_site == "cross-site":
            return False
        return not origin or origin in configured_allowed_origins()

    def _cors(self) -> None:
        origin = str(self.headers.get("Origin") or "").strip().rstrip("/")
        if origin and origin in configured_allowed_origins():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
        self.send_header(
            "Access-Control-Allow-Headers",
            "Content-Type, Authorization, X-Requested-With, X-Sync-Token",
        )

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)")
        if _resolve_base_url().startswith("https://"):
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        self.send_header(
            "Content-Security-Policy-Report-Only",
            "default-src 'self'; "
            "base-uri 'self'; object-src 'none'; frame-ancestors 'self'; "
            "form-action 'self'; "
            "img-src 'self' data: https:; "
            "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; "
            "script-src 'self' 'unsafe-inline' https://accounts.google.com "
            "https://www.googletagmanager.com https://connect.facebook.net; "
            "connect-src 'self' https://accounts.google.com https://www.google-analytics.com "
            "https://region1.google-analytics.com https://www.facebook.com; "
            "frame-src https://accounts.google.com",
        )
        path, _ = self._get_clean_path()
        if (
            path.startswith("/api/")
            or             path in {
                "/admin-dashboard.html",
                "/account.html",
                "/vin-results.html",
                "/zid-mock-pay.html",
                "/zid-store-kit.html",
                "/seo_landing.html",
            }
        ):
            self.send_header("X-Robots-Tag", "noindex, nofollow, noarchive")

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self._security_headers()
        self.end_headers()

    def do_GET(self) -> None:
        path, qs = self._get_clean_path()

        if path == '/api/health':
            try:
                con = connect()
                try:
                    con.execute('SELECT id FROM parts LIMIT 1').fetchone()
                finally:
                    con.close()
                self.json({'success': True, 'status': 'ok'})
            except sqlite3.Error:
                self.json({'success': False, 'status': 'unavailable'}, status=503)
            return

        if path == "/api/storefront/ads-config":
            self.json({"success": True, "data": ads_public_config()})
            return

        if path.startswith("/api/storefront/purchase-confirmation/"):
            transaction_id = path.rsplit("/", 1)[-1]
            con = connect()
            try:
                payload, status = purchase_confirmation_payload(con, transaction_id)
                self.json(payload, status=status)
            finally:
                con.close()
            return

        if path == "/robots.txt":
            if self.serve_site(path):
                return

        if path == "/sitemap.xml":
            con = connect()
            try:
                self.send_bytes(build_sitemap_xml(con).encode("utf-8"), "application/xml; charset=utf-8", cache="public, max-age=600")
            finally:
                con.close()
            return

        if path in {"/feed/meta-catalog.csv", "/api/storefront/meta-catalog.csv"}:
            con = connect()
            try:
                self.send_bytes(build_meta_catalog_csv(con).encode("utf-8"), "text/csv; charset=utf-8", cache="public, max-age=1800")
            finally:
                con.close()
            return

        if path in {"/feed/google-merchant.xml", "/api/storefront/google-merchant.xml"}:
            con = connect()
            try:
                self.send_bytes(build_google_merchant_xml(con).encode("utf-8"), "application/xml; charset=utf-8", cache="public, max-age=1800")
            finally:
                con.close()
            return

        if path == "/api/storefront/merchant-readiness":
            con = connect()
            try:
                self.json({"success": True, "data": merchant_feed_readiness(con)})
            finally:
                con.close()
            return

        if path.startswith("/api/admin/checkout-files/"):
            filename = checkout_upload_filename(
                "private://checkout-verify/" + path.rsplit("/", 1)[-1]
            )
            if not filename:
                self.json({"message": "ملف غير صالح"}, status=404)
                return
            candidates = [
                (PRIVATE_UPLOAD_DIR / filename).resolve(),
                (PUBLIC / "images" / "checkout-verify" / filename).resolve(),
            ]
            file_path = next(
                (
                    candidate
                    for candidate in candidates
                    if candidate.is_file()
                    and (
                        candidate.is_relative_to(PRIVATE_UPLOAD_DIR)
                        or candidate.is_relative_to(
                            (PUBLIC / "images" / "checkout-verify").resolve()
                        )
                    )
                ),
                None,
            )
            if file_path is None:
                self.json({"message": "الملف غير موجود"}, status=404)
                return
            content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
            self.send_bytes(
                file_path.read_bytes(),
                content_type,
                cache="private, no-store",
                headers={
                    "Content-Disposition": f'inline; filename="{filename}"',
                    "Cross-Origin-Resource-Policy": "same-origin",
                },
            )
            return

        landing = parse_storefront_landing(path)
        if landing:
            wanted = {
                "brand": brand_landing_path(landing.get("slug") or "", landing["page"]),
                "category": category_landing_path(landing.get("slug") or "", landing["page"]),
                "model": model_landing_path(int(landing.get("model_id") or 0), landing["page"]),
            }[landing["kind"]]
            if path != wanted:
                self.send_redirect(wanted)
                return
            con = connect()
            try:
                document, status = render_storefront_document(con, wanted, qs)
                self.send_bytes(
                    document,
                    "text/html; charset=utf-8",
                    status=status,
                    cache="no-cache",
                )
            finally:
                con.close()
            return

        if path == "/collection.html":
            con = connect()
            try:
                redirect_to = collection_filter_redirect(con, qs)
                if redirect_to:
                    self.send_redirect(redirect_to)
                    return
                document, status = render_storefront_document(con, path, qs)
                self.send_bytes(
                    document,
                    "text/html; charset=utf-8",
                    status=status,
                    cache="no-cache",
                )
            finally:
                con.close()
            return

        if path == "/product.html":
            con = connect()
            try:
                document, status = render_storefront_document(con, path, qs)
                self.send_bytes(
                    document,
                    "text/html; charset=utf-8",
                    status=status,
                    cache="no-cache",
                )
            finally:
                con.close()
            return

        if (
            path.startswith("/images/brands")
            or path.startswith("/images/categories")
            or path.startswith("/images/brand/")
        ):
            if self.serve_site(path):
                return

        if path.startswith("/images/checkout-verify/"):
            self.json({"message": "File not found"}, status=404)
            return

        if path.startswith("/images/") or path.startswith("/storage/"):
            self.serve_public(path)
            return

        if path == "/" or path.endswith((
            ".html", ".js", ".css", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".txt", ".xml", ".csv", ".ico",
        )):
            if self.serve_site(path):
                return

        con = connect()
        try:
            # --- Storefront Endpoints ---
            if path == "/api/storefront/home":
                cached = cache_get("storefront:home")
                if cached is not None:
                    self.json(cached)
                    return
                products, total = fetch_ready_products(con, limit=16, offset=0)
                # Surface live Salla-checkout products first so buy flow is discoverable.
                checkoutable = fetch_checkoutable_products(con, limit=8)
                bestsellers = checkoutable[:] if checkoutable else products[:8]
                if checkoutable:
                    seen = {p["id"] for p in checkoutable}
                    merged = checkoutable + [p for p in products if p["id"] not in seen]
                    products = merged[:16]
                latest = products[:8]
                offers = (checkoutable or products)[:6]
                brands = brands_payload(con)
                categories = categories_payload(con)
                payload = {
                    "success": True,
                    "hero_banners": [{"id": 1, "title_ar": "قطع غيار السيارات الصينية", "image_url": f"{BASE_URL}/banner1.png"}],
                    "brands": brands,
                    "categories": categories,
                    "featured_products": products,
                    "bestselling_products": [],
                    "selected_products": bestsellers[:8],
                    "latest_products": latest,
                    "offer_products": [],
                    "browse_products": offers,
                    "promo_blocks": [
                        {
                            "id": "fitment",
                            "title_ar": "تأكيد التوافق قبل الشحن",
                            "desc_ar": "أرسل رقم الهيكل أو بيانات السيارة عند الحاجة حتى نراجع القطعة قبل تأكيد الطلب.",
                            "cta_ar": "تصفح القطع",
                            "href": "collection.html",
                            "tone": "blue",
                        },
                        {
                            "id": "shipping",
                            "title_ar": "خيارات شحن تُؤكد قبل الطلب",
                            "desc_ar": "نوضح تكلفة وموعد الشحن المتاح حسب العنوان وتوفر القطعة قبل الإتمام.",
                            "cta_ar": "تصفح الكتالوج",
                            "href": "collection.html?sort=newest",
                            "tone": "silver",
                        },
                        {
                            "id": "support",
                            "title_ar": "دعم متخصص لاختيار القطعة",
                            "desc_ar": "نساعدك في مقارنة رقم القطعة وبيانات السيارة قبل اعتماد الطلب.",
                            "cta_ar": "تواصل معنا",
                            "href": "contact.html",
                            "tone": "dark",
                        },
                    ],
                    "meta": {"total_published": total, "checkoutable_count": len(checkoutable)},
                    "salla": salla_status_payload(),
                    "zid": zid_status_payload(),
                }
                cache_set("storefront:home", payload, ttl=90.0)
                self.json(payload)
                return

            if path == "/api/salla/status":
                payload = salla_status_payload()
                payload["integration"] = integration_status(con, load_env_map(), _resolve_base_url())
                self.json(payload)
                return

            if path == "/api/salla/oauth/start":
                try:
                    state = create_oauth_state(con)
                    target = authorization_url(load_env_map(), _resolve_base_url(), state)
                except RuntimeError as exc:
                    self.json({"message": str(exc)}, status=503)
                    return
                self.send_redirect(target, status=302)
                return

            if path == "/api/salla/oauth/callback":
                code = str((qs.get("code") or [""])[0]).strip()
                state = str((qs.get("state") or [""])[0]).strip()
                if not code or not consume_oauth_state(con, state):
                    self.send_bytes(
                        "تعذر تأكيد طلب الربط. أعد المحاولة من لوحة الإدارة.".encode("utf-8"),
                        "text/plain; charset=utf-8",
                        status=400,
                    )
                    return
                try:
                    exchange_authorization_code(con, load_env_map(), _resolve_base_url(), code)
                except RuntimeError:
                    self.send_bytes(
                        "لم يكتمل تفويض سلة. حدّث رابط العودة في لوحة شركاء سلة ثم أعد الربط.".encode("utf-8"),
                        "text/plain; charset=utf-8",
                        status=502,
                    )
                    return
                self.send_bytes(
                    "تم حفظ ربط سلة على الخادم. يمكنك إغلاق هذه الصفحة والعودة إلى لوحة الإدارة.".encode("utf-8"),
                    "text/plain; charset=utf-8",
                )
                return

            if path == "/api/admin/salla/status":
                self.json({"success": True, "data": integration_status(con, load_env_map(), _resolve_base_url())})
                return

            if path in {"/api/salla/sync-batch", "/api/admin/salla/sync-batch"}:
                # The legacy public path is retained for sync tools but requires
                # a dedicated high-entropy secret. Admin dashboard requests use
                # the authenticated /api/admin alias.
                if path == "/api/salla/sync-batch":
                    expected = str(
                        os.environ.get("SALLA_SYNC_TOKEN")
                        or load_env_map().get("SALLA_SYNC_TOKEN")
                        or ""
                    ).strip()
                    provided = str(self.headers.get("X-Sync-Token") or "").strip()
                    if not expected or not provided or not secrets.compare_digest(expected, provided):
                        self.json({"message": "غير مصرح بمزامنة الكتالوج."}, status=401)
                        return
                try:
                    page = max(1, int((qs.get("page") or ["1"])[0]))
                except Exception:
                    page = 1
                try:
                    per_page = min(max(int((qs.get("per_page") or ["50"])[0]), 1), 100)
                except Exception:
                    per_page = 50
                offset = (page - 1) * per_page
                total = con.execute(
                    "SELECT COUNT(*) FROM parts WHERE COALESCE(status,'published')='published'"
                ).fetchone()[0]
                rows = con.execute(
                    """
                    SELECT id, name_ar, name_en, price
                    FROM parts
                    WHERE COALESCE(status,'published')='published'
                    ORDER BY id ASC
                    LIMIT ? OFFSET ?
                    """,
                    (per_page, offset),
                ).fetchall()
                data = []
                for r in rows:
                    name = (
                        " ".join(
                            str(r["name_ar"] or r["name_en"] or f"قطعة {r['id']}")
                            .replace("\u202b", "")
                            .replace("\u202c", "")
                            .replace("\u200f", "")
                            .split()
                        )
                    )[:100]
                    data.append(
                        {
                            "id": int(r["id"]),
                            "name": name,
                            "price": float(r["price"] or 1) or 1.0,
                            "sku": f"QETAA-{int(r['id'])}",
                        }
                    )
                last_page = max(1, (int(total) + per_page - 1) // per_page)
                self.json(
                    {
                        "data": data,
                        "meta": {
                            "current_page": page,
                            "last_page": last_page,
                            "per_page": per_page,
                            "total": int(total),
                        },
                    }
                )
                return

            if path == "/api/zid/status":
                self.json(zid_status_payload())
                return

            if path == "/api/storefront/products":
                page = int((qs.get("page") or ["1"])[0])
                per_page = min(max(int((qs.get("per_page") or ["24"])[0]), 1), 100)
                brand_raw = (qs.get("brand_id") or qs.get("brand") or [""])[0]
                brand_id = int(brand_raw) if str(brand_raw).isdigit() else None
                if brand_id is None:
                    brand_slug = (qs.get("brand_slug") or qs.get("slug") or [""])[0].strip().lower()
                    if brand_slug:
                        brow = con.execute(
                            "SELECT id FROM brands WHERE lower(slug)=? AND COALESCE(is_active,1)=1 LIMIT 1",
                            (brand_slug,),
                        ).fetchone()
                        if brow:
                            brand_id = int(brow["id"])
                category_raw = (qs.get("category_id") or qs.get("category") or [""])[0]
                category_id = int(category_raw) if str(category_raw).isdigit() else None
                category_key = (qs.get("category_key") or qs.get("section") or [""])[0].strip().lower() or None
                if not category_key and category_raw and not str(category_raw).isdigit():
                    # Allow ?category=brakes as a section key.
                    category_key = str(category_raw).strip().lower()
                model_id = int(qs["model_id"][0]) if qs.get("model_id") and str(qs["model_id"][0]).isdigit() else None
                if model_id is None and qs.get("model") and str(qs["model"][0]).isdigit():
                    model_id = int(qs["model"][0])
                year = int(qs["year"][0]) if qs.get("year") and str(qs["year"][0]).isdigit() else None
                vehicle_id = int(qs["vehicle_id"][0]) if qs.get("vehicle_id") and str(qs["vehicle_id"][0]).isdigit() else None
                q = (qs.get("q") or qs.get("search") or [None])[0]
                sort = (qs.get("sort") or ["newest"])[0]
                if sort in {"latest", "new", "id_desc"}:
                    sort = "newest"
                in_stock = (qs.get("in_stock") or [None])[0]
                if in_stock in {"1", "yes"}:
                    in_stock = "true"
                elif in_stock in {"0", "no"}:
                    in_stock = "false"
                part_type = (qs.get("part_type") or [None])[0]
                checkout_only = str((qs.get("checkout") or qs.get("can_checkout") or [""])[0]).lower() in {"1", "true", "yes"}
                min_price = float(qs["min_price"][0]) if qs.get("min_price") and qs["min_price"][0] != "" else None
                max_price = float(qs["max_price"][0]) if qs.get("max_price") and qs["max_price"][0] != "" else None
                offset = (page - 1) * per_page
                products, total = fetch_ready_products(
                    con, limit=per_page, offset=offset, brand_id=brand_id, category_id=category_id,
                    category_key=category_key, model_id=model_id, year=year, vehicle_id=vehicle_id, q=q,
                    min_price=min_price, max_price=max_price, in_stock=in_stock, part_type=part_type, sort=sort,
                    checkout_only=checkout_only,
                )
                last_page = max(1, (total + per_page - 1) // per_page)
                self.json({"data": products, "meta": {"current_page": page, "last_page": last_page, "per_page": per_page, "total": total}})
                return

            if path.startswith("/api/storefront/products/"):
                key = path.rsplit("/", 1)[-1]
                if key.isdigit():
                    row = con.execute(
                        f"SELECT * FROM parts p WHERE p.id=? AND {READY_WHERE}",
                        (int(key),),
                    ).fetchone()
                else:
                    row = con.execute(
                        f"SELECT * FROM parts p WHERE p.slug=? AND {READY_WHERE}",
                        (key,),
                    ).fetchone() if key else None
                if row is None:
                    self.json({"message": "Not found"}, status=404)
                    return
                self.json({"data": product_payload(con, row, detailed=True)})
                return

            if path == "/api/search":
                q = (qs.get("q") or [""])[0].strip()
                limit = min(max(int((qs.get("limit") or ["10"])[0]), 1), 24)
                brand_id = int(qs["brand_id"][0]) if qs.get("brand_id") and qs["brand_id"][0] else None
                category_id = int(qs["category_id"][0]) if qs.get("category_id") and qs["category_id"][0] else None
                model_id = int(qs["model_id"][0]) if qs.get("model_id") and str(qs["model_id"][0]).isdigit() else None
                year = int(qs["year"][0]) if qs.get("year") and str(qs["year"][0]).isdigit() else None
                vehicle_id = int(qs["vehicle_id"][0]) if qs.get("vehicle_id") and str(qs["vehicle_id"][0]).isdigit() else None
                result_type = "general"
                if len(q) == 17 and q.isalnum() and not any(ch in q.upper() for ch in "IOQ"):
                    result_type = "vin"
                if not q and not brand_id and not category_id and not model_id and not year and not vehicle_id:
                    self.json({"success": True, "type": "empty", "query": q, "results": [], "meta": {"total": 0, "limit": limit}})
                    return
                products, total = fetch_ready_products(con, limit=limit, offset=0, brand_id=brand_id, category_id=category_id, model_id=model_id, year=year, vehicle_id=vehicle_id, q=q or None)
                results = []
                for p in products:
                    if not p.get("image_url"):
                        continue
                    results.append({
                        "id": p["id"],
                        "slug": p["slug"],
                        "name_ar": p["name_ar"],
                        "name_en": p["name_en"],
                        "oem_number": p["oem_number"],
                        "price": p["price"],
                        "price_label": p["price_label"],
                        "image": p["image_url"],
                        "image_url": p["image_url"],
                        "images": p.get("images") or [],
                        "brand": p["brand"],
                        "category": p["category"],
                        "can_checkout": p.get("can_checkout"),
                        "checkout_enabled": p.get("checkout_enabled"),
                        "in_stock": p.get("in_stock"),
                        "availability_label": p.get("availability_label"),
                        "salla_product_id": p.get("salla_product_id"),
                        "zid_product_id": p.get("zid_product_id"),
                        "zid_sku": p.get("zid_sku"),
                        "checkout_provider": p.get("checkout_provider"),
                    })
                suggestions = search_suggestions(con, q, limit=5) if total < 3 else []
                self.json({
                    "success": True,
                    "type": result_type,
                    "query": q,
                    "results": results,
                    "suggestions": suggestions,
                    "meta": {"total": len(results), "matched_total": total, "limit": limit},
                })
                return

            if path == "/api/brands":
                self.json(brands_payload(con))
                return

            if path == "/api/categories":
                self.json(categories_payload(con))
                return

            if path.startswith("/api/models/"):
                brand_id = path.rsplit("/", 1)[-1]
                try:
                    brand_id_int = int(brand_id)
                except ValueError:
                    self.json([], status=400)
                    return
                brand = con.execute(
                    "SELECT id, name_ar, name_en, slug FROM brands WHERE id=? LIMIT 1",
                    (brand_id_int,),
                ).fetchone()
                brand_labels = []
                if brand:
                    brand_labels = [
                        str(brand["name_en"] or ""),
                        str(brand["name_ar"] or ""),
                        str(brand["slug"] or ""),
                    ]
                rows = con.execute(
                    """
                    SELECT cm.id, cm.name_ar, cm.name_en, cm.slug
                    FROM car_models cm
                    WHERE cm.brand_id=?
                      AND COALESCE(cm.is_active, 1)=1
                      AND EXISTS (
                          SELECT 1
                          FROM vehicles v
                          JOIN fitments f ON f.vehicle_id=v.id
                          JOIN parts p ON p.id=f.part_id
                          WHERE v.car_model_id=cm.id
                            AND f.review_status='approved'
                            AND f.verified_at IS NOT NULL
                            AND f.verified_by IS NOT NULL
                            AND ({ready})
                      )
                    ORDER BY cm.name_ar
                    """.format(ready=READY_WHERE),
                    (brand_id_int,),
                ).fetchall()
                # Defense-in-depth: hide placeholders / category / part names even if still active.
                try:
                    import sys as _sys
                    tools_dir = str(ROOT / "tools")
                    if tools_dir not in _sys.path:
                        _sys.path.insert(0, tools_dir)
                    from clean_car_model_brands import is_junk_model as _is_junk_model
                    from clean_car_model_brands import model_dedupe_key as _model_dedupe_key
                except Exception:
                    _is_junk_model = None
                    _model_dedupe_key = None
                out = []
                seen = {}
                brand_slug = str(brand["slug"] or "") if brand else ""

                def _name_score(label: str) -> tuple:
                    low = (label or "").lower()
                    has_brand = 1 if brand_slug and brand_slug.replace("-", " ") in low else 0
                    return (has_brand, len(label or ""))

                for r in rows:
                    name_ar = str(r["name_ar"] or "")
                    name_en = str(r["name_en"] or "")
                    if _is_junk_model:
                        if (
                            _is_junk_model(name_en or name_ar, brand_labels=brand_labels)
                            or _is_junk_model(name_ar, brand_labels=brand_labels)
                            or _is_junk_model(name_en, brand_labels=brand_labels)
                        ):
                            continue
                    label = name_en or name_ar
                    if _model_dedupe_key:
                        key = _model_dedupe_key(label, brand_slug)
                    else:
                        key = re.sub(r"\s+", "", (label or "").strip().lower())
                    if not key:
                        continue
                    item = {
                        "id": r["id"],
                        "name_ar": r["name_ar"],
                        "name_en": r["name_en"],
                        "slug": r["slug"],
                    }
                    prev = seen.get(key)
                    if prev is None or _name_score(label) > _name_score(prev.get("name_en") or prev.get("name_ar") or ""):
                        seen[key] = item
                out = list(seen.values())
                out.sort(key=lambda x: (str(x.get("name_en") or x.get("name_ar") or "").lower()))
                self.json(out)
                return

            if path.startswith("/api/years/"):
                model_id = path.rsplit("/", 1)[-1]
                rows = con.execute(
                    """
                    SELECT DISTINCT v.year AS year
                    FROM vehicles v
                    JOIN fitments f ON f.vehicle_id = v.id
                    JOIN parts p ON p.id = f.part_id
                    WHERE v.car_model_id = ?
                      AND v.year IS NOT NULL
                      AND COALESCE(v.is_active, 1) = 1
                      AND f.review_status='approved'
                      AND f.verified_at IS NOT NULL
                      AND f.verified_by IS NOT NULL
                      AND ({ready})
                    ORDER BY v.year DESC
                    """.format(ready=READY_WHERE),
                    (int(model_id),),
                ).fetchall()
                years = [int(r["year"]) for r in rows if r["year"] is not None]
                self.json([{"year": y, "id": y} for y in years])
                return


            if path == "/api/storefront/auth/me":
                ensure_customer_schema(con)
                customer = customer_from_auth_header(con, self.headers.get("Authorization"))
                if not customer:
                    self.json({"message": "يجب تسجيل الدخول"}, status=401)
                    return
                self.json({"success": True, "customer": customer_public(customer)})
                return

            if path == "/api/storefront/auth/google/config":
                self.json(google_auth_config_payload())
                return

            if path == "/api/storefront/account/orders":
                ensure_customer_schema(con)
                customer = customer_from_auth_header(con, self.headers.get("Authorization"))
                if not customer:
                    self.json({"message": "يجب تسجيل الدخول"}, status=401)
                    return
                cols = {str(r[1]) for r in con.execute("PRAGMA table_info(checkout_inquiries)").fetchall()}
                rows = []
                if "customer_id" in cols:
                    rows = con.execute(
                        """
                        SELECT id, customer_name, customer_phone, customer_city, customer_address,
                               vin_code, items, total_amount, whatsapp_status, created_at
                        FROM checkout_inquiries
                        WHERE customer_id = ?
                        ORDER BY id DESC
                        LIMIT 50
                        """,
                        (int(customer["id"]),),
                    ).fetchall()
                if not rows:
                    phone = str(customer["phone"] or "")
                    rows = con.execute(
                        """
                        SELECT id, customer_name, customer_phone, customer_city, customer_address,
                               vin_code, items, total_amount, whatsapp_status, created_at
                        FROM checkout_inquiries
                        WHERE customer_phone = ? OR customer_phone = ?
                        ORDER BY id DESC
                        LIMIT 50
                        """,
                        (phone, phone[3:] if phone.startswith("966") else ("0" + phone[3:] if phone.startswith("966") else phone)),
                    ).fetchall()
                orders = []
                for r in rows:
                    try:
                        items = json.loads(r["items"] or "[]")
                    except Exception:
                        items = []
                    if not isinstance(items, list):
                        items = []
                    visible = [i for i in items if isinstance(i, dict) and not i.get("_meta")]
                    orders.append(
                        {
                            "id": r["id"],
                            "customer_name": r["customer_name"],
                            "customer_phone": r["customer_phone"],
                            "customer_city": r["customer_city"] if "customer_city" in r.keys() else None,
                            "customer_address": r["customer_address"] if "customer_address" in r.keys() else None,
                            "vin_code": r["vin_code"],
                            "items": visible,
                            "items_count": len(visible),
                            "total_amount": r["total_amount"],
                            "status": r["whatsapp_status"],
                            "created_at": r["created_at"],
                        }
                    )
                self.json({"success": True, "orders": orders})
                return

            if path == "/api/storefront/favorites":
                session_id = (qs.get("session_id") or ["guest"])[0]
                store = load_interactions_store()
                bucket = session_bucket(store, session_id)
                self.json({"data": products_by_ids(con, bucket["favorites"])})
                return

            if path == "/api/storefront/comparisons":
                session_id = (qs.get("session_id") or ["guest"])[0]
                store = load_interactions_store()
                bucket = session_bucket(store, session_id)
                self.json({"data": products_by_ids(con, bucket["comparisons"])})
                return

            if path == "/api/vin/decode":
                vin = (qs.get("vin") or [""])[0].strip().upper()
                self.json(decode_vin_payload(con, vin))
                return

            if path.startswith("/api/seo-products/"):
                key = path.rsplit("/", 1)[-1]
                row = con.execute(
                    f"SELECT * FROM parts p WHERE p.id=? AND {READY_WHERE}",
                    (int(key),),
                ).fetchone() if key.isdigit() else con.execute(
                    f"SELECT * FROM parts p WHERE p.slug=? AND {READY_WHERE}",
                    (key,),
                ).fetchone()
                if row is None:
                    self.json({"message": "Not found"}, status=404)
                    return
                p = product_payload(con, row, detailed=False)
                self.json({"data": product_seo_payload(p, product_internal_crumbs(con, p))})
                return

            # --- Admin API GET Endpoints ---
            if path == "/api/admin/auth/me":
                self.json({'user': self.admin_user})
                return

            if path == "/api/admin/stats":
                self.json(handle_admin_stats(con))
                return

            if path == "/api/admin/catalog/products" or path == "/api/admin/products":
                self.json(handle_admin_products(con, qs))
                return

            if path.startswith("/api/admin/catalog/products/"):
                key = path.rsplit("/", 1)[-1]
                if key.isdigit():
                    row = con.execute("SELECT * FROM parts WHERE id=?", (int(key),)).fetchone()
                    if row:
                        self.json({"data": product_payload(con, row, detailed=True)})
                        return
                self.json({"message": "Product not found"}, status=404)
                return

            if path == "/api/admin/catalog/brands":
                self.json(handle_admin_table_list(con, "brands", qs, name_col="name_ar"))
                return

            if path == "/api/admin/catalog/models":
                self.json(handle_admin_table_list(con, "car_models", qs, name_col="name_ar"))
                return

            if path == "/api/admin/catalog/categories":
                self.json(handle_admin_table_list(con, "categories", qs, name_col="name_ar"))
                return

            if path == "/api/admin/catalog/vehicles":
                self.json(handle_admin_table_list(con, "vehicles", qs, name_col="id"))
                return

            if path == "/api/admin/catalog/oem-numbers":
                self.json(handle_admin_table_list(con, "product_oem_numbers", qs, name_col="id"))
                return

            if path == "/api/admin/catalog/fitments":
                self.json(handle_admin_table_list(con, "fitments", qs, name_col="id"))
                return

            if path == "/api/admin/customers":
                self.json(handle_admin_table_list(con, "customers", qs, name_col="id", search_cols=["name", "email", "phone"]))
                return

            if path == "/api/admin/orders":
                payload = handle_admin_table_list(
                    con,
                    "checkout_inquiries",
                    qs,
                    name_col="id",
                    search_cols=["customer_name", "customer_phone", "vin_code"],
                )
                for row in payload.get("data") or []:
                    def _photo_url(path: str):
                        return admin_checkout_file_url(path)

                    photo = str(row.get("vin_photo_path") or "").strip()
                    row["vin_photo_url"] = _photo_url(photo)
                    raw_items = row.get("items")
                    if isinstance(raw_items, str):
                        try:
                            row["items"] = json.loads(raw_items)
                        except Exception:
                            row["items"] = []
                    # Recover city/address/photos from meta if columns empty.
                    if isinstance(row.get("items"), list):
                        for entry in row["items"]:
                            if isinstance(entry, dict) and entry.get("_meta"):
                                if not row.get("customer_city") and entry.get("customer_city"):
                                    row["customer_city"] = entry.get("customer_city")
                                if not row.get("customer_address") and entry.get("customer_address"):
                                    row["customer_address"] = entry.get("customer_address")
                                if entry.get("customer_lat") and entry.get("customer_lng"):
                                    row["customer_lat"] = entry.get("customer_lat")
                                    row["customer_lng"] = entry.get("customer_lng")
                                    row["maps_url"] = entry.get("maps_url") or (
                                        f"https://www.google.com/maps?q={entry.get('customer_lat')},{entry.get('customer_lng')}"
                                    )
                                if entry.get("car_photo_path"):
                                    row["car_photo_path"] = entry.get("car_photo_path")
                                    row["car_photo_url"] = _photo_url(entry.get("car_photo_path"))
                                if entry.get("istimara_photo_path"):
                                    row["istimara_photo_path"] = entry.get("istimara_photo_path")
                                    row["istimara_photo_url"] = _photo_url(entry.get("istimara_photo_path"))
                                if entry.get("photo_kind"):
                                    row["photo_kind"] = entry.get("photo_kind")
                                if not row.get("vin_photo_url") and entry.get("photo_path"):
                                    row["vin_photo_url"] = _photo_url(entry.get("photo_path"))
                    if not row.get("car_photo_url") and row.get("vin_photo_url") and str(row.get("photo_kind") or "") == "car":
                        row["car_photo_url"] = row["vin_photo_url"]
                    if not row.get("istimara_photo_url") and row.get("vin_photo_url") and str(row.get("photo_kind") or "") in {"istimara", "license", "registration"}:
                        row["istimara_photo_url"] = row["vin_photo_url"]
                self.json(payload)
                return

            if path in {"/api/admin/contacts", "/api/admin/contact-messages", "/api/admin/messages"}:
                self.json(handle_admin_table_list(
                    con,
                    "contact_messages",
                    qs,
                    name_col="id",
                    search_cols=["name", "email", "message", "status"],
                ))
                return

            if path == "/api/admin/imports":
                self.json(handle_admin_table_list(con, "imports", qs, name_col="id", search_cols=["type", "status"]))
                return

            if path == "/api/admin/content/article-categories":
                self.json(handle_admin_table_list(con, "article_categories", qs, name_col="name_ar"))
                return

            if path == "/api/admin/content/articles":
                self.json(handle_admin_table_list(con, "articles", qs, name_col="title_ar"))
                return

            if path == "/api/admin/content/seo-pages":
                self.json(handle_admin_table_list(con, "seo_pages", qs, name_col="title_ar"))
                return

            if path == "/api/admin/users":
                self.json(handle_admin_table_list(con, "users", qs, name_col="name", search_cols=["name", "email"]))
                return

            if path == "/api/admin/roles":
                self.json(handle_admin_table_list(con, "roles", qs, name_col="name"))
                return

            if path == "/api/admin/permissions":
                self.json(handle_admin_table_list(con, "permissions", qs, name_col="name"))
                return

            if path == "/api/admin/sources":
                self.json(handle_admin_table_list(con, "data_sources", qs, name_col="name"))
                return

            if path == "/api/admin/reports/pricing":
                ensure_pricing_schema(con)
                page = max(1, int((qs.get("page") or ["1"])[0]))
                per_page = min(max(1, int((qs.get("per_page") or ["100"])[0])), 250)
                rows = con.execute(
                    """
                    SELECT p.id, p.name_ar, p.sku, p.price,
                           pc.unit_cost, pc.fulfillment_cost,
                           pc.payment_fee_percent, pc.target_margin_percent,
                           pc.minimum_sale_price, pc.updated_at
                    FROM parts p
                    LEFT JOIN product_pricing_controls pc ON pc.product_id=p.id
                    WHERE p.status='published'
                    ORDER BY p.id DESC
                    """
                ).fetchall()
                data = []
                counts = {"protected": 0, "below_floor": 0, "margin_unknown": 0}
                for row in rows:
                    floor = calculated_price_floor(row)
                    price = Decimal(str(row["price"])) if row["price"] is not None else None
                    if row["unit_cost"] is None and floor is None:
                        state = "margin_unknown"
                    elif price is None or (floor is not None and price < floor):
                        state = "below_floor"
                    else:
                        state = "protected"
                    counts[state] += 1
                    data.append({
                        **dict(row),
                        "calculated_floor": float(floor) if floor is not None else None,
                        "margin_state": state,
                    })
                offset = (page - 1) * per_page
                self.json({
                    "data": data[offset:offset + per_page],
                    "summary": counts,
                    "meta": {
                        "current_page": page,
                        "last_page": max(1, (len(data) + per_page - 1) // per_page),
                        "per_page": per_page,
                        "total": len(data),
                    },
                })
                return

            if path == "/api/admin/reports/operations":
                self.json({
                    "data": {
                        "total_products": con.execute("SELECT COUNT(*) FROM parts").fetchone()[0],
                        "published_products": con.execute("SELECT COUNT(*) FROM parts WHERE status='published'").fetchone()[0],
                        "total_inquiries": con.execute("SELECT COUNT(*) FROM checkout_inquiries").fetchone()[0],
                        "total_contacts": con.execute("SELECT COUNT(*) FROM contact_messages").fetchone()[0],
                    }
                })
                return

            self.json({"message": f"Not found: {path}"}, status=404)
        finally:
            con.close()

    def _read_json_body(self, max_bytes: int = MAX_JSON_BODY_BYTES) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            self.json({"message": "طول الطلب غير صالح."}, status=400)
            return None
        if length < 0:
            self.json({"message": "طول الطلب غير صالح."}, status=400)
            return None
        if length > max_bytes:
            self.close_connection = True
            self.json(
                {"message": "حجم الطلب أكبر من الحد المسموح."},
                status=413,
                headers={"Connection": "close"},
            )
            return None
        raw = self.rfile.read(length) if length > 0 else b"{}"
        if len(raw) != length:
            self.json({"message": "تعذر قراءة الطلب كاملًا."}, status=400)
            return None
        try:
            data = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.json({"message": "صيغة JSON غير صحيحة."}, status=400)
            return None
        if not isinstance(data, dict):
            self.json({"message": "يجب أن يكون الطلب كائن JSON."}, status=422)
            return None
        return data

    def _handle_payment_webhook(self, body: dict) -> None:
        env = load_env_map()
        secret = (
            os.environ.get("PAYMENT_WEBHOOK_SECRET")
            or env.get("PAYMENT_WEBHOOK_SECRET")
            or ""
        ).strip()
        if not secret:
            self.json({"message": "File not found"}, status=404)
            return
        provided = (
            str(self.headers.get("X-Webhook-Secret") or "")
            or str(self.headers.get("Authorization") or "").removeprefix("Bearer ")
        ).strip()
        if not provided or not secrets.compare_digest(provided, secret):
            self.json({"message": "غير مصرح"}, status=401)
            return
        txid = re.sub(r"[^A-Za-z0-9._:-]", "", str(body.get("transaction_id") or ""))[:128]
        status = str(body.get("payment_status") or body.get("status") or "").strip().lower()
        items = body.get("items") if isinstance(body.get("items"), list) else []
        if not txid or status not in {"paid", "completed", "succeeded", "fulfilled"} or not items:
            self.json({"message": "تأكيد الدفع غير مكتمل"}, status=422)
            return
        confirmation = {
            "tracking_confirmed": True,
            "payment_status": status,
            "transaction_id": txid,
            "currency": "SAR",
            "value": body.get("value"),
            "shipping": body.get("shipping"),
            "tax": body.get("tax"),
            "coupon": body.get("coupon"),
            "items": items,
        }
        con = connect()
        try:
            ensure_purchase_tracking_schema(con)
            con.execute(
                """
                INSERT OR IGNORE INTO purchase_tracking_confirmations (
                    transaction_id, payment_status, payload_json, confirmed_at
                ) VALUES (?, ?, ?, datetime('now'))
                """,
                (txid, status, json.dumps(confirmation, ensure_ascii=False)),
            )
            con.commit()
        finally:
            con.close()
        self.json({"success": True, "data": {"tracking_confirmation": confirmation}})

    def _handle_salla_webhook(self) -> None:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            self.json({"message": "طول الطلب غير صالح."}, status=400)
            return
        if length < 0 or length > MAX_JSON_BODY_BYTES:
            self.json({"message": "حجم الطلب أكبر من الحد المسموح."}, status=413)
            return
        raw = self.rfile.read(length) if length else b""
        signature = str(self.headers.get("X-Salla-Signature") or "")
        con = connect()
        try:
            result = accept_webhook(con, load_env_map(), raw, signature)
        finally:
            con.close()
        self.json(
            {"success": bool(result.get("ok")), "duplicate": bool(result.get("duplicate"))},
            status=200 if result.get("ok") else int(result.get("status") or 401),
        )

    def do_POST(self) -> None:
        path, _ = self._get_clean_path()
        if path == "/api/salla/webhook":
            self._handle_salla_webhook()
            return
        if path != "/api/internal/payment-webhook" and not self._write_origin_allowed():
            self.json({"message": "مصدر الطلب غير مسموح."}, status=403)
            return
        if not self._enforce_rate_limit(path):
            return
        max_bytes = (
            MAX_UPLOAD_JSON_BYTES
            if path == "/api/checkout/vehicle-photo"
            else MAX_JSON_BODY_BYTES
        )
        body = self._read_json_body(max_bytes=max_bytes)
        if body is None:
            return

        if path == "/api/internal/payment-webhook":
            self._handle_payment_webhook(body)
            return
        if path == "/api/admin/salla/probe":
            con = connect()
            try:
                self.json({"success": True, "data": probe_connection(con, load_env_map())})
            finally:
                con.close()
            return
        if path == "/api/admin/salla/sync":
            from salla_connect import _SYNC_RUNNING

            if _SYNC_RUNNING:
                self.json({"success": False, "reason": "sync_already_running"}, status=409)
                return

            def run_sync() -> None:
                db = connect()
                try:
                    sync_catalog(db, load_env_map())
                finally:
                    db.close()

            threading.Thread(target=run_sync, daemon=True).start()
            self.json({"success": True, "started": True})
            return
        if path == "/api/storefront/favorites":
            self._add_interaction("favorites", body, max_items=100)
            return
        if path == "/api/storefront/comparisons":
            self._add_interaction("comparisons", body, max_items=4)
            return
        if path == "/api/contact":
            self._handle_contact(body)
            return

        if path == "/api/storefront/auth/register":
            self._handle_customer_register(body)
            return
        if path == "/api/storefront/auth/login":
            self._handle_customer_login(body)
            return
        if path == "/api/storefront/auth/google":
            self._handle_customer_google_login(body)
            return
        if path == "/api/storefront/auth/logout":
            self._handle_customer_logout(body)
            return
        if path == "/api/storefront/account/profile":
            self._handle_customer_profile_update(body)
            return
        if path == "/api/storefront/checkout-inquiry":
            self._handle_checkout_inquiry(body)
            return
        if path == "/api/checkout/vehicle-photo":
            self._handle_vehicle_photo_upload(body)
            return
        if path == "/api/salla/checkout":
            con = connect()
            try:
                self.json(handle_salla_checkout(con, body))
            except RuntimeError as exc:
                self.json({"message": str(exc)}, status=422)
            except Exception as exc:
                self.json({"message": f"تعذر إنشاء جلسة الدفع عبر سلة: {exc}"}, status=502)
            finally:
                con.close()
            return
        if path == "/api/zid/checkout":
            con = connect()
            try:
                self.json(handle_zid_checkout(con, body))
            except RuntimeError as exc:
                self.json({"message": str(exc)}, status=422)
            except Exception as exc:
                self.json({"message": f"تعذر إنشاء جلسة الدفع عبر زد: {exc}"}, status=502)
            finally:
                con.close()
            return

        # --- Admin POST Endpoints ---
        if path == "/api/admin/auth/login":
            self._handle_admin_login(body)
            return

        if path == "/api/admin/auth/logout":
            con = connect()
            try:
                con.execute("UPDATE admin_api_tokens SET revoked_at=datetime('now') WHERE token_hash=?", (self.admin_token_hash,))
                con.commit()
            finally:
                con.close()
            self.json({"success": True, "message": "تم تسجيل الخروج"})
            return

        if path == "/api/admin/catalog/products" or path == "/api/admin/products":
            self._handle_create_product(body)
            return

        if path.startswith("/api/admin/catalog/products/") and path.endswith("/publish"):
            product_id = path.split("/")[-2]
            con = connect()
            try:
                con.execute("UPDATE parts SET status='published', updated_at=datetime('now') WHERE id=?", (product_id,))
                con.commit()
                self.json({"success": True, "message": "تم نشر المنتج بنجاح"})
            finally:
                con.close()
            return

        self.json({"message": f"Not found: {path}"}, status=404)

    def _auth_header(self) -> str | None:
        return self.headers.get("Authorization")

    def _handle_customer_register(self, body: dict) -> None:
        name = str(body.get("name") or "").strip()
        phone = normalize_sa_phone(str(body.get("phone") or ""))
        email = str(body.get("email") or "").strip() or None
        password = str(body.get("password") or "")
        city = str(body.get("city") or "").strip() or None
        address = str(body.get("address") or "").strip() or None
        if len(name) < 2:
            self.json({"message": "الاسم مطلوب"}, status=422)
            return
        if not (phone.startswith("966") and len(phone) == 12):
            self.json({"message": "رقم الجوال غير صحيح"}, status=422)
            return
        if len(password) < 10:
            self.json({"message": "كلمة المرور يجب أن تكون 10 أحرف على الأقل"}, status=422)
            return
        con = connect()
        try:
            ensure_customer_schema(con)
            exists = con.execute(
                "SELECT id FROM customer_accounts WHERE phone=?", (phone,)
            ).fetchone()
            if exists:
                self.json({"message": "هذا الرقم مسجّل مسبقاً — سجّل الدخول"}, status=409)
                return
            cur = con.execute(
                """
                INSERT INTO customer_accounts
                    (name, phone, email, password_hash, city, address, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                """,
                (name[:120], phone, email, hash_password(password), city, address),
            )
            con.commit()
            customer_id = int(cur.lastrowid)
            token = issue_customer_token(con, customer_id)
            row = con.execute("SELECT * FROM customer_accounts WHERE id=?", (customer_id,)).fetchone()
            self.json({"success": True, "token": token, "customer": customer_public(row)})
        except Exception as exc:
            self.json({"message": f"تعذر إنشاء الحساب: {exc}"}, status=500)
        finally:
            con.close()

    def _handle_customer_login(self, body: dict) -> None:
        phone = normalize_sa_phone(str(body.get("phone") or body.get("email") or ""))
        password = str(body.get("password") or "")
        if not phone or not password:
            self.json({"message": "الجوال وكلمة المرور مطلوبان"}, status=422)
            return
        con = connect()
        try:
            ensure_customer_schema(con)
            row = con.execute(
                "SELECT * FROM customer_accounts WHERE phone=?", (phone,)
            ).fetchone()
            if not row or not verify_password(password, str(row["password_hash"] or "")):
                self.json({"message": "بيانات الدخول غير صحيحة"}, status=401)
                return
            if password_needs_rehash(str(row["password_hash"] or "")):
                con.execute(
                    "UPDATE customer_accounts SET password_hash=?, updated_at=datetime('now') WHERE id=?",
                    (hash_password(password), int(row["id"])),
                )
                con.commit()
                row = con.execute(
                    "SELECT * FROM customer_accounts WHERE id=?",
                    (int(row["id"]),),
                ).fetchone()
            token = issue_customer_token(con, int(row["id"]))
            self.json({"success": True, "token": token, "customer": customer_public(row)})
        except Exception as exc:
            self.json({"message": f"تعذر تسجيل الدخول: {exc}"}, status=500)
        finally:
            con.close()

    def _handle_customer_google_login(self, body: dict) -> None:
        client_id = google_client_id()
        if not client_id:
            self.json({"message": "تسجيل Google غير مفعّل حالياً"}, status=503)
            return
        id_token = str(body.get("id_token") or body.get("credential") or "").strip()
        access_token = str(body.get("access_token") or "").strip()
        if not id_token and not access_token:
            self.json({"message": "رمز Google مفقود"}, status=422)
            return
        try:
            if id_token:
                profile = verify_google_id_token(id_token, client_id)
            else:
                profile = verify_google_access_token(access_token)
        except ValueError:
            self.json({"message": "تعذر التحقق من حساب Google"}, status=401)
            return
        except Exception as exc:
            self.json({"message": f"تعذر التحقق من Google: {exc}"}, status=502)
            return

        con = connect()
        try:
            ensure_customer_schema(con)
            sub = profile["sub"]
            email = profile["email"]
            name = profile["name"] or email.split("@")[0]
            row = con.execute(
                "SELECT * FROM customer_accounts WHERE google_sub=?", (sub,)
            ).fetchone()
            if not row:
                row = con.execute(
                    "SELECT * FROM customer_accounts WHERE lower(email)=? LIMIT 1",
                    (email,),
                ).fetchone()
                if row:
                    con.execute(
                        """
                        UPDATE customer_accounts
                        SET google_sub=?, name=COALESCE(NULLIF(name,''), ?),
                            email=?, updated_at=datetime('now')
                        WHERE id=?
                        """,
                        (sub, name, email, int(row["id"])),
                    )
                    con.commit()
                    row = con.execute(
                        "SELECT * FROM customer_accounts WHERE id=?", (int(row["id"]),)
                    ).fetchone()
            if not row:
                phone = google_placeholder_phone(sub)
                # Extremely unlikely collision; retry once.
                for _ in range(3):
                    exists = con.execute(
                        "SELECT id FROM customer_accounts WHERE phone=?", (phone,)
                    ).fetchone()
                    if not exists:
                        break
                    phone = google_placeholder_phone(f"{sub}:{secrets.token_hex(4)}")
                cur = con.execute(
                    """
                    INSERT INTO customer_accounts
                        (name, phone, email, password_hash, city, address, google_sub, created_at, updated_at)
                    VALUES (?, ?, ?, ?, NULL, NULL, ?, datetime('now'), datetime('now'))
                    """,
                    (
                        name[:120],
                        phone,
                        email,
                        hash_password(secrets.token_urlsafe(24)),
                        sub,
                    ),
                )
                con.commit()
                row = con.execute(
                    "SELECT * FROM customer_accounts WHERE id=?", (int(cur.lastrowid),)
                ).fetchone()
            token = issue_customer_token(con, int(row["id"]))
            self.json({
                "success": True,
                "token": token,
                "customer": customer_public(row),
                "created": bool(row),
            })
        except Exception as exc:
            self.json({"message": f"تعذر تسجيل الدخول عبر Google: {exc}"}, status=500)
        finally:
            con.close()

    def _handle_customer_logout(self, body: dict) -> None:
        auth = self._auth_header() or ""
        raw = auth[7:].strip() if auth.lower().startswith("bearer ") else auth.strip()
        con = connect()
        try:
            ensure_customer_schema(con)
            if raw:
                con.execute(
                    "UPDATE customer_api_tokens SET revoked_at=datetime('now') WHERE token_hash=?",
                    (hash_token(raw),),
                )
                con.commit()
            self.json({"success": True})
        except Exception as exc:
            self.json({"message": f"تعذر تسجيل الخروج: {exc}"}, status=500)
        finally:
            con.close()

    def _handle_customer_profile_update(self, body: dict) -> None:
        con = connect()
        try:
            ensure_customer_schema(con)
            customer = customer_from_auth_header(con, self._auth_header())
            if not customer:
                self.json({"message": "يجب تسجيل الدخول"}, status=401)
                return
            name = str(body.get("name") or customer["name"] or "").strip()
            email = str(body.get("email") or "").strip() or None
            city = str(body.get("city") or "").strip() or None
            address = str(body.get("address") or "").strip() or None
            phone_raw = str(body.get("phone") or "").strip()
            if len(name) < 2:
                self.json({"message": "الاسم مطلوب"}, status=422)
                return
            phone_update_sql = ""
            phone_params: list = []
            if phone_raw:
                phone = normalize_sa_phone(phone_raw)
                if not (phone.startswith("966") and len(phone) == 12):
                    self.json({"message": "رقم الجوال غير صحيح"}, status=422)
                    return
                taken = con.execute(
                    "SELECT id FROM customer_accounts WHERE phone=? AND id<>?",
                    (phone, int(customer["id"])),
                ).fetchone()
                if taken:
                    self.json({"message": "رقم الجوال مستخدم في حساب آخر"}, status=409)
                    return
                phone_update_sql = ", phone=?"
                phone_params = [phone]
            con.execute(
                f"""
                UPDATE customer_accounts
                SET name=?, email=?, city=?, address=?, updated_at=datetime('now'){phone_update_sql}
                WHERE id=?
                """,
                (name[:120], email, city, address, *phone_params, int(customer["id"])),
            )
            password = str(body.get("password") or "")
            if password:
                if len(password) < 10:
                    self.json({"message": "كلمة المرور يجب أن تكون 10 أحرف على الأقل"}, status=422)
                    return
                con.execute(
                    "UPDATE customer_accounts SET password_hash=? WHERE id=?",
                    (hash_password(password), int(customer["id"])),
                )
            con.commit()
            row = con.execute(
                "SELECT * FROM customer_accounts WHERE id=?", (int(customer["id"]),)
            ).fetchone()
            self.json({"success": True, "customer": customer_public(row)})
        except Exception as exc:
            self.json({"message": f"تعذر حفظ البيانات: {exc}"}, status=500)
        finally:
            con.close()

    def _ensure_checkout_inquiry_location_columns(self, con: sqlite3.Connection) -> None:
        cols = {str(r[1]) for r in con.execute("PRAGMA table_info(checkout_inquiries)").fetchall()}
        if "customer_city" not in cols:
            con.execute("ALTER TABLE checkout_inquiries ADD COLUMN customer_city TEXT")
        if "customer_address" not in cols:
            con.execute("ALTER TABLE checkout_inquiries ADD COLUMN customer_address TEXT")
        # Keep optional legacy photo column empty-safe.
        try:
            con.execute("UPDATE checkout_inquiries SET vin_photo_path='' WHERE vin_photo_path IS NULL")
        except Exception:
            pass

    def _normalize_checkout_photo_path(self, value: str) -> str:
        filename = checkout_upload_filename(value)
        if not filename:
            return ""
        private_file = (PRIVATE_UPLOAD_DIR / filename).resolve()
        if private_file.is_relative_to(PRIVATE_UPLOAD_DIR) and private_file.is_file():
            return private_checkout_path(filename)
        legacy_root = (PUBLIC / "images" / "checkout-verify").resolve()
        legacy_file = (legacy_root / filename).resolve()
        if legacy_file.is_relative_to(legacy_root) and legacy_file.is_file():
            return f"/images/checkout-verify/{filename}"
        return ""

    def _handle_checkout_inquiry(self, body: dict) -> None:
        name = str(body.get("customer_name") or body.get("name") or "").strip()
        phone = str(body.get("customer_phone") or body.get("phone") or "").strip()
        city = str(body.get("customer_city") or body.get("city") or "").strip()
        address = str(body.get("customer_address") or body.get("address") or "").strip()
        lat = str(body.get("customer_lat") or body.get("lat") or "").strip()
        lng = str(body.get("customer_lng") or body.get("lng") or "").strip()
        vin = str(body.get("vin_code") or body.get("vin") or "").strip()
        car_photo_path = self._normalize_checkout_photo_path(
            body.get("car_photo_path") or body.get("car_photo_url") or ""
        )
        istimara_photo_path = self._normalize_checkout_photo_path(
            body.get("istimara_photo_path")
            or body.get("istimara_photo_url")
            or body.get("license_photo_path")
            or body.get("registration_photo_path")
            or ""
        )
        photo_path = self._normalize_checkout_photo_path(
            body.get("vin_photo_path")
            or body.get("photo_path")
            or body.get("photo_url")
            or istimara_photo_path
            or car_photo_path
            or ""
        )
        photo_kind = str(body.get("photo_kind") or body.get("kind") or "").strip().lower()
        if car_photo_path and istimara_photo_path:
            photo_kind = photo_kind or "car_istimara"
        items = body.get("items") or []
        if not isinstance(items, list):
            items = []
        # Keep photo/location metadata with the order payload for admin display.
        meta = {"_meta": True}
        if photo_kind:
            meta["photo_kind"] = photo_kind
        if photo_path:
            meta["photo_path"] = photo_path
        if car_photo_path:
            meta["car_photo_path"] = car_photo_path
        if istimara_photo_path:
            meta["istimara_photo_path"] = istimara_photo_path
        if city:
            meta["customer_city"] = city
        if address:
            meta["customer_address"] = address
        if lat and lng:
            meta["customer_lat"] = lat
            meta["customer_lng"] = lng
            meta["maps_url"] = f"https://www.google.com/maps?q={lat},{lng}"
        if len(meta) > 1:
            items = list(items) + [meta]
        items_json = json.dumps(items, ensure_ascii=False)
        try:
            total = float(body.get("total_amount") or 0)
        except (TypeError, ValueError):
            total = 0.0

        if not name or not phone:
            self.json({"message": "الاسم ورقم الجوال مطلوبان"}, status=422)
            return
        if not city:
            self.json({"message": "المدينة مطلوبة للتوصيل"}, status=422)
            return
        if not address and not (lat and lng):
            self.json({"message": "عنوان التوصيل أو الموقع الجغرافي مطلوب"}, status=422)
            return
        if not address and lat and lng:
            address = f"GPS: {lat}, {lng}"
        # Vehicle photos and VIN are optional aids. They must never block a
        # customer from sending an inquiry when those documents are unavailable.
        if not photo_path:
            photo_path = istimara_photo_path or car_photo_path or ""

        con = connect()
        try:
            self._ensure_checkout_inquiry_location_columns(con)
            ensure_customer_schema(con)
            order_items = []
            total_value = Decimal('0')
            try:
                for item in items:
                    if not isinstance(item, dict) or item.get('_meta'):
                        continue
                    product_id = int(item.get('id'))
                    quantity_raw = item.get('quantity', 1)
                    quantity = int(quantity_raw)
                    if quantity < 1 or quantity > 999 or str(quantity) != str(quantity_raw):
                        raise ValueError('quantity')
                    row = con.execute("SELECT id,name_ar,price,oem_number FROM parts WHERE id=? AND status='published'", (product_id,)).fetchone()
                    if not row:
                        raise ValueError('product')
                    price = Decimal(str(row['price'] or 0))
                    if not price.is_finite() or price < 0:
                        raise ValueError('price')
                    total_value += price * quantity
                    order_items.append({**item, 'id': row['id'], 'title': row['name_ar'],
                                        'price': float(price), 'quantity': quantity, 'oem_number': row['oem_number']})
                if not order_items:
                    raise ValueError('empty cart')
            except (ValueError, TypeError, OverflowError):
                self.json({'message': 'السلة تحتوي على منتج أو كمية غير صحيحة.'}, status=422)
                return
            total = float(total_value.quantize(Decimal('0.01')))
            items_json = json.dumps(order_items + ([meta] if len(meta) > 1 else []), ensure_ascii=False)
            customer = customer_from_auth_header(con, self.headers.get("Authorization"))
            customer_id = int(customer["id"]) if customer else None
            cols = {str(r[1]) for r in con.execute("PRAGMA table_info(checkout_inquiries)").fetchall()}
            if "customer_id" in cols:
                cur = con.execute(
                    """
                    INSERT INTO checkout_inquiries (
                        customer_name, customer_phone, customer_city, customer_address,
                        vin_code, vin_photo_path, items, total_amount, whatsapp_status,
                        customer_id, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, datetime('now'), datetime('now'))
                    """,
                    (
                        name[:150],
                        phone[:50],
                        city[:120],
                        address[:400],
                        vin[:50] or None,
                        photo_path or "",
                        items_json,
                        total,
                        customer_id,
                    ),
                )
            else:
                cur = con.execute(
                    """
                    INSERT INTO checkout_inquiries (
                        customer_name, customer_phone, customer_city, customer_address,
                        vin_code, vin_photo_path, items, total_amount, whatsapp_status, created_at, updated_at
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', datetime('now'), datetime('now'))
                    """,
                    (
                        name[:150],
                        phone[:50],
                        city[:120],
                        address[:400],
                        vin[:50] or None,
                        photo_path or "",
                        items_json,
                        total,
                    ),
                )
            con.commit()
            inquiry_id = cur.lastrowid

            self.json({
                "success": True,
                "inquiry_id": inquiry_id,
                "photos_received": bool(photo_path or car_photo_path or istimara_photo_path),
                "message": "تم استلام الطلب بنجاح.",
            })
        except Exception as exc:
            self.json({"message": f"تعذر حفظ الطلب: {exc}"}, status=500)
        finally:
            con.close()

    def _handle_vehicle_photo_upload(self, body: dict) -> None:
        """Accept a base64 vehicle photo (VIN plate / registration) for WhatsApp checkout."""
        raw = str(body.get("image_base64") or body.get("image") or "").strip()
        if not raw:
            self.json({"message": "الصورة مطلوبة"}, status=422)
            return

        mime = str(body.get("mime_type") or body.get("mime") or "").strip().lower()
        data_url_match = re.match(r"^data:(image/(?:jpeg|jpg|png|webp));base64,(.+)$", raw, re.I | re.S)
        if data_url_match:
            mime = data_url_match.group(1).lower()
            raw = data_url_match.group(2).strip()
        if mime in {"image/jpg", "jpg"}:
            mime = "image/jpeg"
        if mime not in {"image/jpeg", "image/png", "image/webp"}:
            # Infer from payload when client omitted mime.
            if raw.startswith("/9j/"):
                mime = "image/jpeg"
            elif raw.startswith("iVBOR"):
                mime = "image/png"
            elif raw.startswith("UklGR"):
                mime = "image/webp"
            else:
                self.json({"message": "صيغة الصورة غير مدعومة (JPEG / PNG / WebP)"}, status=422)
                return

        try:
            compact = re.sub(r"\s+", "", raw)
            binary = base64.b64decode(compact, validate=True)
        except Exception:
            self.json({"message": "تعذر قراءة الصورة"}, status=422)
            return

        if not binary:
            self.json({"message": "الصورة فارغة"}, status=422)
            return
        if len(binary) > MAX_IMAGE_BYTES:
            self.json({"message": "حجم الصورة كبير جداً (الحد 4MB)"}, status=422)
            return

        try:
            from PIL import Image, UnidentifiedImageError
        except ImportError:
            self.json({"message": "خدمة التحقق من الصور غير متاحة حالياً"}, status=503)
            return
        try:
            with Image.open(io.BytesIO(binary)) as image:
                actual_format = str(image.format or "").upper()
                width, height = int(image.width), int(image.height)
                if (
                    width < 1
                    or height < 1
                    or width > MAX_IMAGE_SIDE
                    or height > MAX_IMAGE_SIDE
                    or width * height > MAX_IMAGE_PIXELS
                ):
                    raise ValueError("dimensions")
                image.verify()
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
            self.json({"message": "ملف الصورة غير صالح أو أبعاده كبيرة جداً"}, status=422)
            return
        format_map = {
            "JPEG": ("image/jpeg", ".jpg"),
            "PNG": ("image/png", ".png"),
            "WEBP": ("image/webp", ".webp"),
        }
        actual = format_map.get(actual_format)
        if not actual:
            self.json({"message": "صيغة الصورة الفعلية غير مدعومة"}, status=422)
            return
        mime, ext = actual
        kind = str(body.get("kind") or body.get("photo_kind") or "vin").strip().lower()
        if kind in {"plate", "registration", "license", "istimara", "form"}:
            kind = "istimara"
        elif kind in {"car", "vehicle", "auto"}:
            kind = "car"
        elif kind not in {"vin", "car", "istimara"}:
            kind = "vin"

        folder = PRIVATE_UPLOAD_DIR
        try:
            folder.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            self.json({"message": f"تعذر تجهيز مجلد الصور: {exc}"}, status=500)
            return

        filename = f"{kind}-{int(time.time())}-{uuid.uuid4().hex[:12]}{ext}"
        dest = folder / filename
        try:
            dest.write_bytes(binary)
        except OSError as exc:
            self.json({"message": f"تعذر حفظ الصورة: {exc}"}, status=500)
            return

        private_path = private_checkout_path(filename)
        self.json({
            "success": True,
            "path": private_path,
            "upload_id": filename,
            "kind": kind,
            "message": "تم رفع الصورة بنجاح",
        })

    def _handle_create_product(self, body: dict) -> None:
        name_ar = str(body.get("name_ar") or "").strip()
        name_en = str(body.get("name_en") or "").strip()
        oem = str(body.get("oem_number") or "").strip()
        price = body.get("price")

        if not name_ar or not oem:
            self.json({"message": "اسم القطعة ورقم OEM مطلوبان"}, status=422)
            return

        slug = f"part-{oem.lower().replace(' ', '-')}"
        con = connect()
        try:
            cur = con.execute(
                """
                INSERT INTO parts (oem_number, name_ar, name_en, slug, description, price, status, brand_id, category_id, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, datetime('now'), datetime('now'))
                """,
                (oem, name_ar, name_en or None, slug, body.get("description"), price, body.get("brand_id"), body.get("category_id")),
            )
            con.commit()
            self.json({"success": True, "product_id": cur.lastrowid, "message": "تم إضافة المنتج بنجاح"})
        except Exception as exc:
            self.json({"message": f"تعذر إضافة المنتج: {exc}"}, status=500)
        finally:
            con.close()

    def do_PATCH(self) -> None:
        path, _ = self._get_clean_path()
        if not self._write_origin_allowed():
            self.json({"message": "مصدر الطلب غير مسموح."}, status=403)
            return
        body = self._read_json_body()
        if body is None:
            return

        if path.startswith("/api/admin/catalog/products/") and path.endswith("/pricing"):
            product_id = path.split("/")[-2]
            if not product_id.isdigit():
                self.json({"message": "معرف المنتج غير صالح"}, status=422)
                return
            con = connect()
            try:
                ensure_pricing_schema(con)
                values = {}
                for key in (
                    "unit_cost",
                    "fulfillment_cost",
                    "payment_fee_percent",
                    "target_margin_percent",
                    "minimum_sale_price",
                ):
                    raw = body.get(key)
                    if raw in {None, ""}:
                        values[key] = None
                        continue
                    value = float(raw)
                    if not math.isfinite(value) or value < 0:
                        raise ValueError(key)
                    values[key] = value
                fee = values["payment_fee_percent"] or 0
                margin = values["target_margin_percent"] or 0
                if fee >= 100 or margin >= 100 or fee + margin >= 99:
                    raise ValueError("percent")
                con.execute(
                    """
                    INSERT INTO product_pricing_controls (
                        product_id, unit_cost, fulfillment_cost,
                        payment_fee_percent, target_margin_percent,
                        minimum_sale_price, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                    ON CONFLICT(product_id) DO UPDATE SET
                        unit_cost=excluded.unit_cost,
                        fulfillment_cost=excluded.fulfillment_cost,
                        payment_fee_percent=excluded.payment_fee_percent,
                        target_margin_percent=excluded.target_margin_percent,
                        minimum_sale_price=excluded.minimum_sale_price,
                        updated_at=datetime('now')
                    """,
                    (
                        int(product_id),
                        values["unit_cost"],
                        values["fulfillment_cost"],
                        values["payment_fee_percent"],
                        values["target_margin_percent"],
                        values["minimum_sale_price"],
                    ),
                )
                con.commit()
                control = con.execute(
                    "SELECT * FROM product_pricing_controls WHERE product_id=?",
                    (int(product_id),),
                ).fetchone()
                floor = calculated_price_floor(control)
                self.json({
                    "success": True,
                    "calculated_floor": float(floor) if floor is not None else None,
                    "message": "تم حفظ ضوابط التسعير.",
                })
            except (TypeError, ValueError, OverflowError):
                self.json({"message": "بيانات التكلفة أو الهامش غير صحيحة."}, status=422)
            finally:
                con.close()
            return

        if path.startswith("/api/admin/catalog/products/"):
            product_id = path.rsplit("/", 1)[-1]
            if not product_id.isdigit():
                self.json({"message": "معرف المنتج غير صالح"}, status=422)
                return
            con = connect()
            try:
                ensure_pricing_schema(con)
                warning = None
                if body.get("status"):
                    con.execute("UPDATE parts SET status=?, updated_at=datetime('now') WHERE id=?", (body["status"], product_id))
                if body.get("price") is not None:
                    new_price = Decimal(str(body["price"]))
                    if not new_price.is_finite() or new_price <= 0:
                        raise ValueError("price")
                    current = con.execute(
                        "SELECT price FROM parts WHERE id=?",
                        (int(product_id),),
                    ).fetchone()
                    if not current:
                        self.json({"message": "المنتج غير موجود"}, status=404)
                        return
                    control = con.execute(
                        "SELECT * FROM product_pricing_controls WHERE product_id=?",
                        (int(product_id),),
                    ).fetchone()
                    floor = calculated_price_floor(control)
                    if floor is not None and new_price < floor:
                        self.json({
                            "message": f"السعر أقل من الحد الأدنى المحسوب ({float(floor):.2f} ر.س)."
                        }, status=422)
                        return
                    current_price = (
                        Decimal(str(current["price"]))
                        if current["price"] is not None
                        else None
                    )
                    if (
                        floor is None
                        and current_price is not None
                        and new_price < current_price
                        and body.get("confirm_unverified_margin") is not True
                    ):
                        self.json({
                            "message": "لا توجد تكلفة موثقة؛ خفض السعر يحتاج تأكيد هامش صريح."
                        }, status=422)
                        return
                    if floor is None:
                        warning = "الهامش غير قابل للتحقق حتى إدخال التكلفة."
                    con.execute(
                        "UPDATE parts SET price=?, updated_at=datetime('now') WHERE id=?",
                        (float(new_price), int(product_id)),
                    )
                    con.execute(
                        "UPDATE salla_products SET sync_status='price_review', updated_at=datetime('now') WHERE product_id=?",
                        (int(product_id),),
                    )
                    con.execute(
                        "UPDATE zid_products SET sync_status='price_review', updated_at=datetime('now') WHERE product_id=?",
                        (int(product_id),),
                    )
                con.commit()
                self.json({
                    "success": True,
                    "message": "تم تحديث المنتج بنجاح",
                    "warning": warning,
                })
            except (ValueError, TypeError, OverflowError):
                self.json({"message": "السعر غير صالح."}, status=422)
            finally:
                con.close()
            return

        self.json({"message": "Not found"}, status=404)

    def do_PUT(self) -> None:
        self.do_PATCH()

    def _handle_contact(self, body: dict) -> None:
        name = str(body.get("name") or "").strip()
        email = str(body.get("email") or "").strip()
        message = str(body.get("message") or "").strip()
        if not name or not email or not message:
            self.json({"message": "يرجى تعبئة جميع الحقول المطلوبة."}, status=422)
            return
        if "@" not in email or "." not in email.split("@")[-1]:
            self.json({"message": "البريد الإلكتروني غير صحيح."}, status=422)
            return
        con = connect()
        try:
            con.execute(
                """
                INSERT INTO contact_messages (name, email, message, ip_address, user_agent, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'new', datetime('now'), datetime('now'))
                """,
                (
                    name[:120],
                    email[:180],
                    message[:5000],
                    self.client_address[0] if self.client_address else None,
                    (self.headers.get("User-Agent") or "")[:255],
                ),
            )
            con.commit()
            self.json({"success": True, "message": "تم إرسال رسالتك بنجاح. سنعود إليك قريباً."})
        except Exception as exc:
            self.json({"message": f"تعذر حفظ الرسالة: {exc}"}, status=500)
        finally:
            con.close()

    def do_DELETE(self) -> None:
        path, qs = self._get_clean_path()
        if not self._write_origin_allowed():
            self.json({"message": "مصدر الطلب غير مسموح."}, status=403)
            return
        if path.startswith(("/api/storefront/favorites/", "/api/storefront/comparisons/")):
            allowed, retry_after = rate_limit_check(self._client_key(), "interaction")
            if not allowed:
                self.json(
                    {"message": "محاولات كثيرة. حاول مرة أخرى بعد قليل."},
                    status=429,
                    headers={"Retry-After": str(retry_after)},
                )
                return

        if path.startswith("/api/storefront/favorites/"):
            self._remove_interaction("favorites", path, qs)
            return
        if path.startswith("/api/storefront/comparisons/"):
            self._remove_interaction("comparisons", path, qs)
            return

        if path.startswith("/api/admin/contacts/") or path.startswith("/api/admin/contact-messages/") or path.startswith("/api/admin/messages/"):
            key = path.rsplit("/", 1)[-1]
            if not key.isdigit():
                self.json({"message": "معرف الرسالة غير صالح"}, status=422)
                return
            con = connect()
            try:
                cur = con.execute("DELETE FROM contact_messages WHERE id=?", (int(key),))
                con.commit()
                if cur.rowcount <= 0:
                    self.json({"message": "الرسالة غير موجودة"}, status=404)
                    return
                self.json({"success": True, "message": "تم حذف الرسالة"})
            except Exception as exc:
                self.json({"message": f"تعذر حذف الرسالة: {exc}"}, status=500)
            finally:
                con.close()
            return

        if path.startswith("/api/admin/catalog/products/") or path.startswith("/api/admin/products/"):
            key = path.rsplit("/", 1)[-1]
            if not key.isdigit():
                self.json({"message": "معرف المنتج غير صالح"}, status=422)
                return
            product_id = int(key)
            con = connect()
            try:
                exists = con.execute("SELECT id FROM parts WHERE id=?", (product_id,)).fetchone()
                if exists is None:
                    self.json({"message": "المنتج غير موجود"}, status=404)
                    return
                # Clean related rows then delete the part.
                for sql, params in (
                    ("DELETE FROM product_images WHERE product_id=?", (product_id,)),
                    ("DELETE FROM product_specs WHERE product_id=?", (product_id,)),
                    ("DELETE FROM product_documents WHERE product_id=?", (product_id,)),
                    ("DELETE FROM product_suppliers WHERE product_id=?", (product_id,)),
                    ("DELETE FROM product_oem_numbers WHERE product_id=?", (product_id,)),
                    ("DELETE FROM fitments WHERE part_id=?", (product_id,)),
                    ("DELETE FROM favorites WHERE product_id=?", (product_id,)),
                    ("DELETE FROM comparisons WHERE product_id=?", (product_id,)),
                    ("DELETE FROM salla_products WHERE product_id=?", (product_id,)),
                    ("DELETE FROM zid_products WHERE product_id=?", (product_id,)),
                    ("DELETE FROM parts WHERE id=?", (product_id,)),
                ):
                    try:
                        con.execute(sql, params)
                    except sqlite3.Error:
                        # Ignore missing optional relation tables/columns.
                        pass
                con.commit()
                self.json({"success": True, "message": "تم حذف المنتج"})
            except Exception as exc:
                self.json({"message": f"تعذر حذف المنتج: {exc}"}, status=500)
            finally:
                con.close()
            return

        if path.startswith("/api/admin/orders/"):
            key = path.rsplit("/", 1)[-1]
            if not key.isdigit():
                self.json({"message": "معرف الطلب غير صالح"}, status=422)
                return
            con = connect()
            try:
                cur = con.execute("DELETE FROM checkout_inquiries WHERE id=?", (int(key),))
                con.commit()
                if cur.rowcount <= 0:
                    self.json({"message": "الطلب غير موجود"}, status=404)
                    return
                self.json({"success": True, "message": "تم حذف الطلب"})
            except Exception as exc:
                self.json({"message": f"تعذر حذف الطلب: {exc}"}, status=500)
            finally:
                con.close()
            return

        self.json({"message": f"Not found: {path}"}, status=404)

    def _add_interaction(self, kind: str, body: dict, *, max_items: int) -> None:
        session_id = str(body.get("session_id") or "guest").strip() or "guest"
        try:
            product_id = int(body.get("product_id"))
        except (TypeError, ValueError):
            self.json({"message": "product_id مطلوب"}, status=422)
            return

        con = connect()
        try:
            row = con.execute("SELECT * FROM parts WHERE id=?", (product_id,)).fetchone()
            if row is None:
                self.json({"message": "المنتج غير موجود"}, status=404)
                return

            store = load_interactions_store()
            bucket = session_bucket(store, session_id)
            ids: list[int] = list(bucket.get(kind) or [])
            if product_id in ids:
                ids = [product_id] + [x for x in ids if x != product_id]
            else:
                if len(ids) >= max_items:
                    self.json({"message": f"الحد الأقصى {max_items} عناصر"}, status=422)
                    return
                ids = [product_id] + ids
            bucket[kind] = ids[:max_items]
            save_interactions_store(store)
            self.json({"data": product_payload(con, row), "meta": {"count": len(ids)}})
        finally:
            con.close()

    def _remove_interaction(self, kind: str, path: str, qs: dict) -> None:
        session_id = (qs.get("session_id") or ["guest"])[0]
        key = path.rsplit("/", 1)[-1]
        try:
            product_id = int(key)
        except ValueError:
            self.json({"message": "معرف غير صالح"}, status=422)
            return

        store = load_interactions_store()
        bucket = session_bucket(store, session_id)
        ids = [x for x in (bucket.get(kind) or []) if int(x) != product_id]
        bucket[kind] = ids
        save_interactions_store(store)
        self.json({"success": True, "meta": {"count": len(ids)}})

    def serve_public(self, path: str) -> None:
        # Use POSIX-style relative paths so Linux containers resolve files correctly.
        rel = urllib.parse.unquote(path.lstrip("/"))
        if rel.replace("\\", "/").startswith("images/checkout-verify/"):
            self.json({"message": "File not found"}, status=404)
            return
        public_root = PUBLIC.resolve()
        candidates = [(PUBLIC / Path(rel)).resolve()]
        # Tolerate accidental nested uploads:
        # /public/images/images/<file> and /public/images/catalog/catalog/<file>
        if rel.startswith("images/"):
            candidates.append((PUBLIC / "images" / Path(rel)).resolve())
        if rel.startswith("images/catalog/"):
            name = rel[len("images/catalog/") :]
            candidates.append((PUBLIC / "images" / "catalog" / "catalog" / name).resolve())
        file_path = None
        for candidate in candidates:
            try:
                candidate.relative_to(public_root)
            except ValueError:
                continue
            if candidate.is_file():
                file_path = candidate
                break
        if file_path is None:
            self.json({"message": "File not found"}, status=404)
            return
        data = file_path.read_bytes()
        ctype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        cache = "public, max-age=604800, immutable"
        self.send_bytes(data, ctype, cache=cache)

    def serve_site(self, path: str) -> bool:
        rel = urllib.parse.unquote(path.lstrip("/"))
        if not rel or rel == "/":
            rel = "index.html"
        candidates = [ROOT / rel, PUBLIC / rel]
        for file_path in candidates:
            try:
                resolved = file_path.resolve()
            except OSError:
                continue
            allowed_root = PUBLIC.resolve() if file_path == PUBLIC / rel else ROOT.resolve()
            if not resolved.is_relative_to(allowed_root) or not resolved.is_file():
                continue
            # Only storefront assets are public; never expose tools, source, or database exports.
            relative = resolved.relative_to(allowed_root)
            if len(relative.parts) > 1 and relative.parts[0] not in {'images', 'storage'}:
                continue
            if resolved.suffix.lower() not in {'.html','.js','.css','.png','.jpg','.jpeg','.webp','.avif','.svg','.ico','.txt','.xml','.woff','.woff2'}:
                continue
            data = resolved.read_bytes()
            ctype = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
            if resolved.suffix.lower() == ".js":
                ctype = "application/javascript; charset=utf-8"
            elif resolved.suffix.lower() == ".css":
                ctype = "text/css; charset=utf-8"
            elif resolved.suffix.lower() == ".html":
                ctype = "text/html; charset=utf-8"
            elif resolved.suffix.lower() == ".txt":
                ctype = "text/plain; charset=utf-8"
            # Brand/category logos and other versioned assets cache; HTML stays fresh.
            if resolved.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".avif", ".svg", ".gif", ".ico", ".woff", ".woff2"}:
                cache = "public, max-age=604800, immutable"
            elif resolved.suffix.lower() in {".js", ".css"}:
                cache = "public, max-age=3600, must-revalidate"
            else:
                cache = "no-cache"
            self.send_bytes(data, ctype, cache=cache)
            return True
        return False

    def send_redirect(self, location: str, status: int = 301) -> None:
        target = str(location or "").strip()
        if not target.startswith("/"):
            target = "/" + target.lstrip("/")
        self.send_response(status)
        self._cors()
        self._security_headers()
        self.send_header("Location", target)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

    def send_bytes(
        self,
        data: bytes,
        content_type: str,
        status: int = 200,
        cache: str = "no-store",
        headers: dict[str, str] | None = None,
    ) -> None:
        raw = data
        compressible = (
            content_type.startswith("text/")
            or "javascript" in content_type
            or "json" in content_type
            or "xml" in content_type
        )
        if compressible and len(data) >= 1024 and "gzip" in str(self.headers.get("Accept-Encoding") or "").lower():
            data = gzip.compress(data, compresslevel=6)
        self.send_response(status)
        self._cors()
        self._security_headers()
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        for name, value in (headers or {}).items():
            if re.fullmatch(r"[A-Za-z0-9-]+", str(name)) and "\n" not in str(value) and "\r" not in str(value):
                self.send_header(str(name), str(value))
        if data is not raw:
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        self.wfile.write(data)

    def json(
        self,
        payload,
        status: int = 200,
        headers: dict[str, str] | None = None,
    ) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_bytes(
            body,
            "application/json; charset=utf-8",
            status=status,
            cache="no-store",
            headers=headers,
        )


def main() -> None:
    global BASE_URL
    BASE_URL = _resolve_base_url()
    if not DB_PATH.exists():
        raise SystemExit(f"DB not found: {DB_PATH}")
    if _env_confirmed(os.environ.get("RUN_STARTUP_SALLA_MAPPING_REPAIR")):
        con = connect()
        try:
            mapping_info = ensure_salla_product_mappings(con)
            if not mapping_info.get("skipped"):
                print(
                    "Salla mappings:",
                    f"removed={mapping_info.get('removed_stale')}",
                    f"mapped={mapping_info.get('mapped_count')}",
                    f"seeded={mapping_info.get('seeded')}",
                )
        finally:
            con.close()
    else:
        print("Salla mapping repair disabled at startup")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    salla = salla_status_payload()
    zid = zid_status_payload()
    print(f"ROOT:  {ROOT}")
    print(f"Site:  {BASE_URL}/")
    print(f"API:   {BASE_URL}/api")
    print(f"Listen: {HOST}:{PORT}")
    print(f"DB: {DB_PATH}")
    print(f"Images: {PUBLIC}")
    if zid.get("checkout_ready"):
        print(f"Zid checkout: READY ({zid.get('mode')})")
    else:
        print("Zid checkout: OFF (complete OAuth / set tokens)")
    if salla.get("checkout_ready"):
        print(f"Salla checkout: READY ({salla.get('mode')})")
    else:
        print("Salla checkout: OFF (missing store settings)")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
