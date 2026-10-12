#!/usr/bin/env python3
"""Container entrypoint: seed volume paths then start the storefront API."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

APP = Path("/app")
DATA = Path("/data")


def _env_enabled(name: str) -> bool:
    return str(os.environ.get(name) or "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
        "enabled",
    }


def _copy_tree(src: Path, dst: Path) -> int:
    if not src.exists():
        return 0
    count = 0
    dst.mkdir(parents=True, exist_ok=True)
    for path in src.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(src)
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copy2(path, target)
            count += 1
    return count


def _extract_tar_into_public(tar_path: Path, public_dir: Path, *, delete_after: bool = False) -> int:
    import tarfile

    extracted = 0
    print(f"Extracting {tar_path}...")
    try:
        with tarfile.open(tar_path, "r:gz") as tf:
            for member in tf.getmembers():
                if not member.isfile():
                    continue
                name = member.name.lstrip("./")
                if name.startswith("public/"):
                    name = name[len("public/") :]
                target = public_dir / name
                try:
                    if not str(target.resolve()).startswith(str(public_dir.resolve())):
                        continue
                except OSError:
                    continue
                if target.exists():
                    continue
                source = tf.extractfile(member)
                if source is None:
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("wb") as out:
                    shutil.copyfileobj(source, out)
                extracted += 1
        if delete_after:
            tar_path.unlink(missing_ok=True)
        print(f"Extracted {extracted} files from {tar_path.name}")
    except Exception as exc:
        print(f"extract failed for {tar_path.name}: {exc}")
        # Remove corrupt archives so restarts don't loop on the same failure.
        if delete_after and tar_path.exists():
            try:
                tar_path.unlink()
                print(f"Removed corrupt archive {tar_path.name}")
            except OSError:
                pass
    return extracted


def _repair_public_layout(public_dir: Path) -> None:
    """Fix nested volume uploads and extract packed catalog when present."""
    waste = public_dir / "public"
    if waste.exists():
        shutil.rmtree(waste, ignore_errors=True)
        print(f"Removed nested waste {waste}")

    # Flatten accidental nested uploads: images/images/... and images/catalog/catalog/...
    for nested, dest_root in (
        (public_dir / "images" / "images", public_dir / "images"),
        (public_dir / "images" / "catalog" / "catalog", public_dir / "images" / "catalog"),
    ):
        if not nested.is_dir():
            continue
        moved = 0
        for path in nested.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(nested)
            dest = dest_root / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            if dest.exists():
                path.unlink(missing_ok=True)
            else:
                shutil.move(str(path), str(dest))
                moved += 1
        shutil.rmtree(nested, ignore_errors=True)
        print(f"Repaired {moved} nested paths under {nested}")

    usage = shutil.disk_usage(public_dir)
    free_mb = usage.free // (1024 * 1024)
    print(f"Volume free space: {free_mb} MB")

    # Prefer small missing-pack extracts from the image, then any volume archives.
    for archive in (
        APP / "deploy_seed" / "missing_catalog.tar.gz",
        public_dir / "missing_catalog.tar.gz",
        public_dir / "catalog.tar.gz",
    ):
        if not archive.exists():
            continue
        if free_mb < 80 and archive.name == "catalog.tar.gz":
            size_mb = archive.stat().st_size // (1024 * 1024)
            archive.unlink(missing_ok=True)
            print(f"Removed {archive.name} ({size_mb} MB) to recover free space")
            usage = shutil.disk_usage(public_dir)
            free_mb = usage.free // (1024 * 1024)
            print(f"Volume free space after cleanup: {free_mb} MB")
            continue
        delete_after = archive.parent == public_dir
        _extract_tar_into_public(archive, public_dir, delete_after=delete_after)
        usage = shutil.disk_usage(public_dir)
        free_mb = usage.free // (1024 * 1024)
        print(f"Volume free space: {free_mb} MB")


def main() -> int:
    db_dir = DATA / "database"
    public_dir = DATA / "public"
    private_upload_dir = DATA / "private" / "checkout-verify"
    db_dir.mkdir(parents=True, exist_ok=True)
    public_dir.mkdir(parents=True, exist_ok=True)
    private_upload_dir.mkdir(parents=True, exist_ok=True)

    volume_db = db_dir / "database.sqlite"
    candidates = [
        APP / "deploy_seed" / "database.sqlite",
        APP / "core" / "database" / "database.sqlite",
    ]
    if not volume_db.exists():
        for src in candidates:
            if src.exists():
                shutil.copy2(src, volume_db)
                print(f"Seeded {volume_db} from {src}")
                break

    _repair_public_layout(public_dir)

    seed_public = APP / "deploy_seed" / "public"
    copied = _copy_tree(seed_public, public_dir)
    if copied:
        print(f"Seeded {copied} public files into {public_dir}")

    # Brand/category logos live under /app/images (served by serve_site).
    site_images = APP / "images"
    seed_site = APP / "deploy_seed" / "site_images"
    if seed_site.exists():
        for sub in ("brands", "categories"):
            src = seed_site / sub
            dst = site_images / sub
            n = _copy_tree(src, dst)
            if n:
                print(f"Seeded {n} {sub} logos into {dst}")

    db_path = volume_db if volume_db.exists() else next((p for p in candidates if p.exists()), volume_db)

    os.environ.setdefault("APP_ROOT", str(APP))
    os.environ.setdefault("HOST", "0.0.0.0")
    os.environ["DB_PATH"] = os.environ.get("DB_PATH") or str(db_path)
    if not Path(os.environ["DB_PATH"]).exists() and Path(db_path).exists():
        os.environ["DB_PATH"] = str(db_path)

    os.environ["PUBLIC_DIR"] = os.environ.get("PUBLIC_DIR") or str(public_dir)
    os.environ["PRIVATE_UPLOAD_DIR"] = (
        os.environ.get("PRIVATE_UPLOAD_DIR") or str(private_upload_dir)
    )
    os.environ["INTERACTIONS_PATH"] = os.environ.get("INTERACTIONS_PATH") or str(
        DATA / "storefront_interactions.json"
    )

    public = Path(os.environ["PUBLIC_DIR"])
    image_public = APP / "core" / "public"
    if not (public / "images").exists() and (image_public / "images").exists():
        os.environ["PUBLIC_DIR"] = str(image_public)
        print(f"Using image public dir fallback: {image_public}")

    print(f"DB_PATH={os.environ['DB_PATH']}")
    print(f"PUBLIC_DIR={os.environ['PUBLIC_DIR']}")

    # Catalog cleanup writes to the persistent production database. It is an
    # explicit maintenance task, never an automatic side effect of a deploy.
    cleaner = APP / "tools" / "clean_car_model_brands.py"
    if (
        _env_enabled("RUN_STARTUP_CATALOG_CLEANUP")
        and cleaner.exists()
        and Path(os.environ["DB_PATH"]).exists()
    ):
        try:
            import subprocess

            print("Running car model brand cleanup...")
            subprocess.run([sys.executable, str(cleaner)], check=False, env=os.environ.copy())
        except Exception as exc:
            print(f"car model cleanup skipped: {exc}")
    else:
        print("Catalog cleanup disabled at startup")

    server = APP / "tools" / "local_api_server.py"
    os.execve(sys.executable, [sys.executable, str(server)], os.environ)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
