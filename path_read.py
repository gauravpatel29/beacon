from pathlib import Path

# =====================================================================
# CONFIGURATION
# =====================================================================

# Output text file in the root directory
OUTPUT_FILE = "frontend_codebase.txt"

# Only include backend and frontend source files
ALLOWED_EXTENSIONS = {
    # Frontend
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".html",
    ".css",
    ".vue",
    ".svelte",
}

# Folders to completely skip/ignore
IGNORED_DIRS = {
    "node_modules",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".git",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".vscode",
    ".idea",
    "coverage",
    ".pytest_cache",
}

# Config files and minified bundles to skip (even if they have .js / .py extension)
IGNORED_FILE_PATTERNS = {
    "webpack.config.",
    "vite.config.",
    "tailwind.config.",
    "postcss.config.",
    "next.config.",
    "babel.config.",
    "jest.config.",
    "eslintrc",
    "prettierrc",
    ".min.js",
    ".min.css",
    "setup.py",
}


def is_valid_file(file_path: Path, output_file_name: str) -> bool:
    """Checks if a file should be included based on extension and ignore rules."""
    # 1. Do not read the output file itself
    if file_path.name == output_file_name:
        return False

    # 2. Check if the file is inside any ignored directory
    for part in file_path.parts:
        if part in IGNORED_DIRS or part.startswith("."):
            return False

    # 3. Check extension
    if file_path.suffix.lower() not in ALLOWED_EXTENSIONS:
        return False

    # 4. Check if filename matches any ignored configuration pattern
    name_lower = file_path.name.lower()
    for pattern in IGNORED_FILE_PATTERNS:
        if pattern in name_lower:
            return False

    return True


def export_codebase(root_dir: str = "."):
    root = Path(root_dir).resolve()
    output_path = root / OUTPUT_FILE

    print("=" * 60)
    print(f"Scanning project at: {root}")
    print("=" * 60)

    # Collect all matching files
    files_to_export = [
        f for f in root.rglob("*") if f.is_file() and is_valid_file(f, OUTPUT_FILE)
    ]

    if not files_to_export:
        print("No matching frontend or backend files found.")
        return

    # Write all contents to the single output .txt file
    with open(output_path, "w", encoding="utf-8") as out:
        out.write(f"PROJECT frontend CODEBASE EXPORT\n")
        out.write(f"Total Files Exported: {len(files_to_export)}\n")
        out.write("=" * 80 + "\n\n")

        for idx, file_path in enumerate(files_to_export, start=1):
            relative_path = file_path.relative_to(root)
            print(f"[{idx}/{len(files_to_export)}] Adding: {relative_path}")

            # Write formatted section headers for easy reading
            out.write("=" * 80 + "\n")
            out.write(f"FILE: {relative_path}\n")
            out.write("=" * 80 + "\n")

            try:
                content = file_path.read_text(
                    encoding="utf-8", errors="replace"
                )
                out.write(
                    content if content.strip() else "[FILE IS EMPTY]\n"
                )
            except Exception as e:
                out.write(f"[ERROR READING FILE: {e}]\n")

            out.write("\n\n")

    print("=" * 60)
    print(f"Done! Successfully exported {len(files_to_export)} files.")
    print(f"Saved to: {output_path}")
    print("=" * 60)


if __name__ == "__main__":
    export_codebase()