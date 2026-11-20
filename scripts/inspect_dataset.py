from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "src"))

from wesad.e4_reader import SENSORS, iter_sensor_samples  # noqa: E402


def count_samples(csv_path: Path, subject_id: str, sensor: str) -> int:
    return sum(1 for _ in iter_sensor_samples(csv_path, subject_id, sensor))


def main() -> int:
    data_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"D:\btldll\archive\WESAD")
    if not data_root.is_dir():
        print(f"Không tìm thấy thư mục dữ liệu: {data_root}")
        return 2

    subjects = sorted(
        (path for path in data_root.iterdir() if path.is_dir() and path.name.startswith("S")),
        key=lambda path: int(path.name[1:]) if path.name[1:].isdigit() else 10_000,
    )
    if not subjects:
        print(f"Không tìm thấy thư mục S*_E4_Data trong: {data_root}")
        return 2

    print(f"Dataset: {data_root}")
    print(f"Số người tham gia: {len(subjects)}\n")
    missing: list[str] = []

    for subject in subjects:
        e4_dir = subject / f"{subject.name}_E4_Data"
        print(f"[{subject.name}]")
        if not e4_dir.is_dir():
            print(f"  THIẾU thư mục {e4_dir.name}")
            missing.append(str(e4_dir))
            continue
        for sensor in SENSORS:
            csv_path = e4_dir / f"{sensor}.csv"
            if not csv_path.is_file():
                print(f"  THIẾU {sensor}.csv")
                missing.append(str(csv_path))
                continue
            if csv_path.stat().st_size == 0:
                print(f"  RỖNG  {sensor}.csv")
                continue
            try:
                count = count_samples(csv_path, subject.name, sensor)
                print(f"  {sensor:4} {count:>9,} mẫu ({csv_path.stat().st_size:,} bytes)")
            except (OSError, ValueError, StopIteration) as error:
                print(f"  LỖI  {sensor}.csv: {error}")
                missing.append(str(csv_path))

    print("\nKiểm kê xong. Không có file dữ liệu nào bị thay đổi.")
    if missing:
        print(f"Cần kiểm tra {len(missing)} mục bị thiếu hoặc không đọc được.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
