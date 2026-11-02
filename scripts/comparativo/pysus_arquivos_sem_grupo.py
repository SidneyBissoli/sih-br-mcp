"""Usage: pysus_arquivos_sem_grupo.py <md-log.csv>

Predict PySUS's group='RD' result: microdatasus total minus the rows that sit
in files whose group_id is NULL in PySUS's catalog (read-only)."""

import sys
from pathlib import Path

import duckdb
import pandas as pd

md = pd.read_csv(Path(sys.argv[1]), dtype={"comp": str, "uf": str})
con = duckdb.connect(str(Path.home() / "pysus" / "ducklake" / "catalog_sih.duckdb"), read_only=True)
nulls = con.sql(
    """select year, month, state from pysus.files
       where path like 'public/data/ftp/sih/RD/%' and group_id is null
         and (year = 2024 or (year = 2025 and month <= 4))"""
).fetchdf()
nulls["comp"] = nulls["year"].astype(str) + "-" + nulls["month"].map("{:02d}".format)
keys = set(zip(nulls["comp"], nulls["state"]))
lost = md[[(c, u) in keys for c, u in zip(md["comp"], md["uf"])]]
print("null-group files in window:", len(keys), "| matched in md log:", len(lost))
print("pneumonia rows in lost files:", int(lost["kept"].sum()), "| total:", int(md["kept"].sum()))
print("predicted PySUS group='RD':", int(md["kept"].sum() - lost["kept"].sum()))
print("lost files with ES:", sorted(c for c, u in keys if u == "ES"))
