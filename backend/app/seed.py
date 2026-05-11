"""Generate the JSON data fixtures. Run as: ``python -m app.seed``."""

from app.data import build_year, write_year_to_disk, CITY


def main() -> None:
    print(f"Seeding {CITY['name']} {CITY['year']}...")
    year = build_year(CITY["year"])
    write_year_to_disk(year)
    print(f"  wrote {len(year)} day files + aggregates")


if __name__ == "__main__":
    main()
