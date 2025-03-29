# CDNCLI

CDNCLI is a command-line interface (CLI) tool for managing libraries from CDNs. It allows you to install, uninstall, list, and generate script tags for libraries fetched from [cdnjs](https://cdnjs.com).

## Features

- **Install Libraries**: Download specific libraries and their files from cdnjs.
- **Uninstall Libraries**: Remove installed libraries from your local `cdn_modules` directory.
- **List Installed Libraries**: View all libraries currently installed.
- **Generate Script Tags**: Create prioritized `<script>` or `<link>` tags for installed libraries.

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd CDNCLI
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the project (if needed):
   ```bash
   npx tsc
   ```

4. Link the CLI globally:
   ```bash
   npm link
   ```

## Usage

Once installed, you can use the `cdn` command to interact with the CLI.

### Commands

#### Install a Library
Installs a library locally in the `cdn_modules` directory.

```bash
cdn install <library-name> [options]
```

**Options**:
- `--select-only <files>`: Comma-separated list of specific files to install.
- `--verbose`: Show detailed logging during the installation process.

**Example**:
```bash
cdn install jquery --select-only jquery.min.js --verbose
```

#### Uninstall a Library
Uninstalls a specific library or all libraries.

```bash
cdn uninstall <library-name>
```

**Example**:
```bash
cdn uninstall jquery
```

To uninstall all libraries:
```bash
cdn uninstall /
```

#### List Installed Libraries
Lists all libraries installed in the `cdn_modules` directory.

```bash
cdn list
```

#### Generate Script Tags
Generates prioritized `<script>` or `<link>` tags for an installed library.

```bash
cdn script-tag <library-name>
```

**Example**:
```bash
cdn script-tag jquery
```

#### Insert Script/Link Tags
Inserts a script or link tag for an installed library into an HTML file.

```bash
cdn insert <library-name> [filename] <html-file> <location>
```

**Arguments**:
- `library-name`: Name of the installed library
- `filename`: Specific file to insert (e.g., jquery.min.js)
- `html-file`: Path to the HTML file to modify
- `location`: Where to insert the tag (`head` or `body`)

**Example**:
```bash
cdn insert jquery jquery.js index.html head
```

## Directory Structure

- `cdn_modules/`: Directory where libraries are installed.
- `src/`: Source code for the CLI.
  - `index.ts`: Main entry point for the CLI.
  - `logging.ts`: Utility functions for logging and progress bars.
  - `libraryUtil.ts`: Functions for managing installed libraries.
  - `highlightCode.ts`: Syntax highlighting for generated script tags.

## Development

### Prerequisites
- Node.js (v16 or higher)
- TypeScript

### Build the Project
Compile the TypeScript files into JavaScript:

```bash
npx tsc
```

### Run Locally
Run the CLI locally without linking:

```bash
node dist/index.js <command>
```

### Testing
You can add unit tests for the utility functions and commands. Use a testing framework like Jest or Mocha.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Author

Created by **YSSF**.

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

## Notes

- Ensure your server serves the `cdn_modules` directory correctly when using the generated script tags.
- This tool relies on the structure of cdnjs. If their API or website changes, updates to this tool may be required.
