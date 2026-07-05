import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.abspath(__file__))

EXCLUDE_DIRS = {
    ".git", "__pycache__", "node_modules", "venv", ".venv", "env",
    "output", "logs", ".pytest_cache", "dist", "build", ".mypy_cache",
}

EXTENSIONS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".scss",
    ".sh", ".ps1", ".sql", ".json", ".yaml", ".yml",
}

stats = defaultdict(lambda: [0, 0])  # ext -> [files, lines]
total_files = 0
total_lines = 0

for dirpath, dirnames, filenames in os.walk(ROOT):
    dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
    for fname in filenames:
        ext = os.path.splitext(fname)[1]
        if ext not in EXTENSIONS:
            continue
        fpath = os.path.join(dirpath, fname)
        try:
            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                n = sum(1 for _ in f)
        except OSError:
            continue
        stats[ext][0] += 1
        stats[ext][1] += n
        total_files += 1
        total_lines += n

print(f"{'Ext':<8}{'Files':>8}{'Lines':>10}")
for ext, (files, lines) in sorted(stats.items(), key=lambda x: -x[1][1]):
    print(f"{ext:<8}{files:>8}{lines:>10}")
print("-" * 26)
print(f"{'TOTAL':<8}{total_files:>8}{total_lines:>10}")
