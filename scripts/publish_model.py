from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import requests


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Publish a trained model to the local registry.")
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument("--version", required=True, help="Version ID, for example 1.0.0")
    parser.add_argument("--registry-url", default="http://localhost:8000")
    parser.add_argument("--activate", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.file.is_file():
        print(f"Không tìm thấy model: {args.file}")
        return 2

    try:
        bundle = joblib.load(args.file)
        metrics = {
            "feature_source": bundle.get("feature_source"),
            "train_subjects": bundle.get("train_subjects", []),
            "excluded_subjects": bundle.get("excluded_subjects", []),
            "loso_mean_metrics": bundle.get("loso_mean_metrics", {}),
            "heldout_metrics": bundle.get("heldout_metrics", {}),
        }
        with args.file.open("rb") as model_handle:
            response = requests.post(
                f"{args.registry_url.rstrip('/')}/models",
                data={
                    "version": args.version,
                    "activate": str(args.activate).lower(),
                    "metrics": json.dumps(metrics),
                },
                files={"file": (args.file.name, model_handle, "application/octet-stream")},
                timeout=120,
            )
        response.raise_for_status()
    except requests.RequestException as error:
        print(f"Không thể gửi model lên registry: {error}")
        if error.response is not None:
            print(error.response.text)
        return 1
    except (OSError, ValueError, KeyError) as error:
        print(f"Không đọc được model hoặc gửi metadata: {error}")
        return 1

    print(json.dumps(response.json(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
