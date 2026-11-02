"""Reproduce the sih-br-mcp answer with PySUS: pneumonia (J12-J18) admissions of
Espirito Santo residents admitted in 2024, competences 2024-01..2025-04, all 27
state files, one file at a time.

Usage: replica_pysus.py <out_dir> [--probe]

Measured on Linux (WSL): on Windows, PySUS 2.11.7 returns an empty table for
every call (catalog paths become backslashed and fail a prefix check).
"""

import os
import sys
import time
from importlib.metadata import version
from pathlib import Path

import pandas as pd
import pysus

UFS = [
    "AC",
    "AL",
    "AM",
    "AP",
    "BA",
    "CE",
    "DF",
    "ES",
    "GO",
    "MA",
    "MG",
    "MS",
    "MT",
    "PA",
    "PB",
    "PE",
    "PI",
    "PR",
    "RJ",
    "RN",
    "RO",
    "RR",
    "RS",
    "SC",
    "SE",
    "SP",
    "TO",
]
COMPS = [(2024, m) for m in range(1, 13)] + [(2025, m) for m in range(1, 5)]
PNEUMONIA = {f"J{n}" for n in range(12, 19)}


def main(out_dir: Path, probe: bool) -> None:
    """Loop over the files, keep the matching rows, write log and result."""
    out_dir.mkdir(parents=True, exist_ok=True)
    pysus.set_cache(os.environ.get("PYSUS_CACHE", "/tmp/pysus-cache"))
    plan = [(2024, 4, "ES")] if probe else [(y, m, uf) for y, m in COMPS for uf in UFS]
    log = []
    kept = []
    t0 = time.perf_counter()
    for y, m, uf in plan:
        t1 = time.perf_counter()
        try:
            df = pysus.ftp.sih(state=uf, year=y, month=m, group="RD", as_dataframe=True)
        except Exception as e:  # noqa: BLE001 - keep going; failures are logged
            log.append(
                (
                    f"{y}-{m:02d}",
                    uf,
                    None,
                    None,
                    round(time.perf_counter() - t1, 1),
                    repr(e)[:200],
                )
            )
            continue
        if len(df) == 0:
            log.append((f"{y}-{m:02d}", uf, 0, 0, round(time.perf_counter() - t1, 1), "empty"))
            continue
        if probe:
            print(type(df), getattr(df, "shape", None))
            print(df.dtypes.head(20))
            print(df[["MUNIC_RES", "DT_INTER", "DIAG_PRINC", "MORTE"]].head())
        sub = df[
            df["MUNIC_RES"].astype(str).str[:2].eq("32")
            & df["DT_INTER"].astype(str).str[:4].eq("2024")
            & df["DIAG_PRINC"].astype(str).str[:3].isin(PNEUMONIA)
        ][["MUNIC_RES", "DT_INTER", "DIAG_PRINC", "MORTE"]]
        kept.append(sub)
        log.append(
            (
                f"{y}-{m:02d}",
                uf,
                len(df),
                len(sub),
                round(time.perf_counter() - t1, 1),
                "ok",
            )
        )
    total = time.perf_counter() - t0
    pd.DataFrame(log, columns=["comp", "uf", "rows", "kept", "secs", "status"]).to_csv(
        out_dir / "pysus-log.csv", index=False, encoding="utf-8"
    )
    pneu = pd.concat(kept) if kept else pd.DataFrame()
    deaths = int(pneu["MORTE"].astype(str).eq("1").sum()) if len(pneu) else 0
    by_group = (
        pneu["DIAG_PRINC"].astype(str).str[:3].value_counts().sort_index()
        if len(pneu)
        else None
    )
    with open(out_dir / "pysus-result.txt", "w", encoding="utf-8") as f:
        f.write(
            f"pysus {version('pysus')} | pandas {pd.__version__} | python {sys.version.split()[0]}\n"
        )
        f.write(f"total seconds {total:.1f} | files {len(plan)}\n")
        f.write(f"admissions {len(pneu)} | deaths {deaths}\n")
        f.write(f"{by_group}\n")
    print((out_dir / "pysus-result.txt").read_text(encoding="utf-8"))


if __name__ == "__main__":
    main(Path(sys.argv[1]), "--probe" in sys.argv)
