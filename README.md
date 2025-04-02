# CDNCLI

*A Command-Line Tool for Managing CDN Libraries*

![Demo](https://img.shields.io/badge/status-active-brightgreen)
![Version](https://img.shields.io/badge/version-1.3.1-blue)

CDNCLI lets you **install, uninstall, and generate script tags** for libraries from [cdnjs](https://cdnjs.com) with ease. It’s perfect for local development, prototyping, or managing frontend dependencies without npm.

---

## ✨ Features

✅ **Install Libraries** – Download libraries (or specific files) into `cdn_modules/`.  
✅ **Uninstall Libraries** – Remove one, multiple, or all installed libraries.  
✅ **List Installed Libraries** – See what’s in your `cdn_modules/`.  
✅ **Generate Embed Tags** – Get prioritized `<script>` or `<link>` tags for local use.  
✅ **Insert into HTML** – Automatically inject tags into your HTML files.  
✅ **Concurrent Downloads** – Speed up installs with configurable concurrency.  
✅ **Retry Logic** – Auto-retries failed downloads with exponential backoff.  
✅ **Verbose Logging** – Debug with detailed output.  
✅ **Syntax Highlighting** – Colorized HTML tags for readability.  

---

## 🚀 Installation

```bash
git clone https://github.com/YSSF8/CDNCLI.git
cd CDNCLI
npm install
npm link
```

---

## 📖 Usage

### 1. Install a Library

Download a library (with optional file filtering):
```bash
cdn install jquery
cdn install lodash --select-only lodash.min.js,lodash.core.js
cdn install react --concurrency 10 --verbose
```

**Options:**
- `--select-only` – Only download specific files (comma-separated).
- `--concurrency` – Max parallel downloads (default: `5`).
- `--verbose` – Show detailed logs.

---

### 2. Uninstall Libraries
Remove one or more libraries:
```bash
cdn uninstall jquery
cdn uninstall lodash react
```

**Uninstall ALL libraries:**
```bash
cdn uninstall /
```

---

### 3. List Installed Libraries

```bash
cdn list
```

---

### 4. Generate Embed Tags

Get optimized `<script>` or `<link>` tags for local use:
```bash
cdn embed jquery
cdn embed bootstrap dist/css/bootstrap.min.css
```

---

### 5. Insert Tags into HTML

Automatically inject a library’s script/link into your HTML file:
```bash
cdn insert jquery index.html head
cdn insert bootstrap bootstrap.min.css index.html head
```
**Arguments:**

- `<library-name>` – Name of the installed library.
- `[filename]` – Optional specific file (e.g., `jquery.min.js`).
- `<html-file>` – Path to your HTML file.
- `<location>` – Where to insert (`head` or `body`).

---

## 📂 Directory Structure

```
cdn_modules/       # Installed libraries go here
├── jquery/
├── lodash/
└── ...
```

---

## 🔧 Advanced Options

- **Concurrency Control** – Speed up downloads with `--concurrency`.
  ```bash
  cdn install fontawesome --concurrency 8
  ```
- **Retry Logic** – Failed downloads automatically retry (with delays).
- **Prettier Integration** – Formatted HTML output when inserting tags.

---

## 💡 Example Workflow

```bash
# 1. Install jQuery
cdn install jquery

# 2. Generate script tags
cdn embed jquery

# 3. Insert into HTML
cdn insert jquery index.html head

# 4. Uninstall when done
cdn uninstall jquery
```

---

## 📜 License

MIT © [YSSF](https://github.com/YSSF8)

---

### 🔗 Notes

- Ensure your server serves the `cdn_modules` directory.
- Uses **cdnjs** – if their API changes, updates may be needed.