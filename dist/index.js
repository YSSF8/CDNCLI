#!/usr/bin/env node
"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const axios_1 = __importDefault(require("axios"));
const cheerio = __importStar(require("cheerio"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const logging_1 = require("./logging");
const libraryUtil_1 = require("./libraryUtil");
const highlightCode_1 = require("./highlightCode");
commander_1.program
    .name('cdn')
    .description('Fetches data from CDN to install libraries')
    .version('1.0.0');
commander_1.program
    .command('install <name>')
    .description('Installs a library locally')
    .option('--select-only <files>', 'Comma-separated list of specific files to install')
    .option('--verbose', 'Show detailed logging')
    .action((name, options) => __awaiter(void 0, void 0, void 0, function* () {
    var _a;
    let progressBarActive = false;
    let progressBar = null;
    try {
        if (options.verbose) {
            (0, logging_1.logInfo)(`Starting installation of library: ${name}`);
        }
        const encoded = encodeURIComponent(name.toLowerCase());
        (0, logging_1.logInfo)(`Fetching library info for "${name}" from cdnjs...`);
        const response = yield axios_1.default.get(`https://cdnjs.com/libraries/${encoded}`);
        const data = response.data;
        const $ = cheerio.load(data);
        const urls = $('.url')
            .map((index, element) => $(element).text())
            .get();
        if (urls.length === 0) {
            (0, logging_1.logError)(`No files found for library: ${name}`);
            return;
        }
        if (options.verbose) {
            (0, logging_1.logInfo)(`Found ${urls.length} total files for the library.`);
        }
        const selectedFiles = options.selectOnly
            ? options.selectOnly.split(',').map(file => file.trim())
            : null;
        const filteredUrls = selectedFiles
            ? urls.filter(url => {
                const fileName = url.split('/').pop();
                return fileName && selectedFiles.includes(fileName);
            })
            : urls;
        if (options.verbose && selectedFiles) {
            if (filteredUrls.length > 0) {
                (0, logging_1.logInfo)(`Filtered down to ${filteredUrls.length} files based on --select-only: ${selectedFiles.join(', ')}`);
            }
            else {
                (0, logging_1.logWarning)(`No files matched the --select-only criteria: ${selectedFiles.join(', ')}`);
            }
        }
        if (filteredUrls.length === 0) {
            if (selectedFiles) {
                if (!options.verbose) {
                    (0, logging_1.logError)(`No files match the selected criteria: ${selectedFiles.join(', ')}`);
                }
            }
            else {
                (0, logging_1.logError)(`No files available for download for library: ${name}`);
            }
            return;
        }
        (0, logging_1.logInfo)(`Preparing to download ${filteredUrls.length} file(s)...`);
        progressBar = new logging_1.ProgressBar(filteredUrls.length);
        progressBarActive = true;
        let downloadedFiles = 0;
        const prioritizedUrls = filteredUrls.sort((a, b) => {
            const isMinA = a.includes('.min.');
            const isMinB = b.includes('.min.');
            if (isMinA && !isMinB)
                return -1;
            if (!isMinA && isMinB)
                return 1;
            return 0;
        });
        for (const url of prioritizedUrls) {
            const urlParts = url.split('/');
            const fileNameIndex = urlParts.length - 1;
            const versionIndex = fileNameIndex - 1;
            const libraryNameIndex = versionIndex - 1;
            if (fileNameIndex < 0 || versionIndex < 0 || libraryNameIndex < 3 || urlParts[libraryNameIndex] === 'libs') {
                if (options.verbose && progressBar)
                    progressBar.clear();
                (0, logging_1.logWarning)(`Could not parse library name/version/filename from URL: ${url}. Skipping.`);
                if (progressBar)
                    progressBar.update(downloadedFiles);
                continue;
            }
            const libraryName = urlParts[libraryNameIndex];
            const fileName = urlParts[fileNameIndex];
            if (options.verbose) {
                if (progressBar)
                    progressBar.clear();
                (0, logging_1.logInfo)(`Downloading ${fileName}...`);
            }
            try {
                const linkResponse = yield axios_1.default.get(url, { responseType: 'arraybuffer' });
                const linkData = linkResponse.data;
                const cdnModulesDir = 'cdn_modules';
                if (!fs_1.default.existsSync(cdnModulesDir)) {
                    fs_1.default.mkdirSync(cdnModulesDir);
                    if (options.verbose) {
                        if (progressBar)
                            progressBar.clear();
                        (0, logging_1.logInfo)(`Created directory: ${cdnModulesDir}`);
                    }
                }
                const libraryDir = path_1.default.join(cdnModulesDir, libraryName);
                if (!fs_1.default.existsSync(libraryDir)) {
                    fs_1.default.mkdirSync(libraryDir);
                    if (options.verbose) {
                        if (progressBar)
                            progressBar.clear();
                        (0, logging_1.logInfo)(`Created directory: ${libraryDir}`);
                    }
                }
                const filePath = path_1.default.join(libraryDir, fileName);
                fs_1.default.writeFileSync(filePath, linkData);
                if (options.verbose) {
                    if (progressBar)
                        progressBar.clear();
                    (0, logging_1.logSuccess)(`Downloaded and saved: ${filePath}`);
                }
                downloadedFiles++;
            }
            catch (error) {
                if (progressBarActive && progressBar)
                    progressBar.clear();
                (0, logging_1.logError)(`Failed to fetch or save ${fileName} from ${url}: ${error.message}`);
            }
            finally {
                if (progressBar) {
                    progressBar.update(downloadedFiles);
                }
            }
        }
        if (progressBar) {
            progressBar.update(downloadedFiles);
            progressBar.complete();
            progressBarActive = false;
        }
        if (downloadedFiles > 0) {
            if (downloadedFiles === filteredUrls.length) {
                (0, logging_1.logSuccess)(`Successfully installed all ${downloadedFiles} files for library: ${name}`);
            }
            else {
                (0, logging_1.logSuccess)(`Successfully installed ${downloadedFiles} out of ${filteredUrls.length} files for library: ${name}`);
            }
        }
        else if (filteredUrls.length > 0) {
            (0, logging_1.logError)(`No files were successfully downloaded for library: ${name}. Check previous errors.`);
        }
    }
    catch (error) {
        if (progressBarActive && progressBar) {
            progressBar.clear();
            progressBarActive = false;
        }
        if (axios_1.default.isAxiosError(error) && ((_a = error.response) === null || _a === void 0 ? void 0 : _a.status) === 404) {
            (0, logging_1.logError)(`Could not find library "${name}" on cdnjs (404).`);
        }
        else {
            (0, logging_1.logError)(`Installation failed: ${error.message}`);
        }
    }
}));
commander_1.program
    .command('uninstall <name>')
    .action((name) => {
    try {
        const cdnModulesDir = path_1.default.join('cdn_modules');
        if (name === '/') {
            if (!fs_1.default.existsSync(cdnModulesDir)) {
                (0, logging_1.logError)('No libraries are installed (cdn_modules directory not found).');
                return;
            }
            const libraries = fs_1.default.readdirSync(cdnModulesDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);
            if (libraries.length === 0) {
                (0, logging_1.logInfo)('No libraries found within cdn_modules directory.');
                return;
            }
            (0, logging_1.logInfo)(`Uninstalling all ${libraries.length} libraries...`);
            libraries.forEach(library => {
                const libraryDir = path_1.default.join(cdnModulesDir, library);
                try {
                    fs_1.default.rmSync(libraryDir, { recursive: true, force: true });
                    (0, logging_1.logSuccess)(`Successfully uninstalled library: ${library}`);
                }
                catch (rmError) {
                    (0, logging_1.logError)(`Failed to remove directory for ${library}: ${rmError.message}`);
                }
            });
            if (fs_1.default.readdirSync(cdnModulesDir).length === 0) {
                try {
                    fs_1.default.rmdirSync(cdnModulesDir);
                    (0, logging_1.logInfo)(`Removed empty cdn_modules directory.`);
                }
                catch (rmdirError) {
                    (0, logging_1.logWarning)(`Could not remove cdn_modules directory: ${rmdirError.message}`);
                }
            }
            (0, logging_1.logSuccess)('All libraries have been uninstalled.');
        }
        else {
            const libraryDir = path_1.default.join(cdnModulesDir, name);
            if (!fs_1.default.existsSync(libraryDir)) {
                (0, logging_1.logError)(`Library "${name}" is not installed (directory not found).`);
                return;
            }
            if (!fs_1.default.statSync(libraryDir).isDirectory()) {
                (0, logging_1.logError)(`Path "${libraryDir}" exists but is not a directory. Cannot uninstall.`);
                return;
            }
            fs_1.default.rmSync(libraryDir, { recursive: true, force: true });
            (0, logging_1.logSuccess)(`Successfully uninstalled library: ${name}`);
            if (fs_1.default.existsSync(cdnModulesDir) && fs_1.default.readdirSync(cdnModulesDir).length === 0) {
                try {
                    fs_1.default.rmdirSync(cdnModulesDir);
                    (0, logging_1.logInfo)(`Removed empty cdn_modules directory.`);
                }
                catch (rmdirError) {
                    (0, logging_1.logWarning)(`Could not remove cdn_modules directory: ${rmdirError.message}`);
                }
            }
        }
    }
    catch (error) {
        (0, logging_1.logError)(`Failed to uninstall library "${name}": ${error.message}`);
    }
});
commander_1.program
    .command('list')
    .description('Lists all installed libraries found in cdn_modules')
    .action(() => {
    (0, libraryUtil_1.getInstalledLibraries)((err, folders) => {
        if (err) {
            if (err.code === 'ENOENT') {
                (0, logging_1.logInfo)('No libraries installed (cdn_modules directory not found).');
            }
            else {
                (0, logging_1.logError)(`Error reading library directory: ${err.message}`);
            }
            return;
        }
        if (folders && folders.length > 0) {
            (0, logging_1.logSuccess)('Installed libraries:');
            folders.sort().forEach(folder => console.log(`- ${folder}`));
        }
        else {
            (0, logging_1.logInfo)('No libraries found in the cdn_modules directory.');
        }
    });
});
commander_1.program
    .command('script-tag <name>')
    .description('Generates prioritized script tags for an installed library')
    .action((name) => {
    (0, libraryUtil_1.getInstalledLibraries)((err, folders) => {
        if (err) {
            if (err.code === 'ENOENT') {
                (0, logging_1.logError)(`Library "${name}" cannot be found because the cdn_modules directory does not exist.`);
            }
            else {
                (0, logging_1.logError)(`Error checking installed libraries: ${err.message}`);
            }
            return;
        }
        if (!folders || !folders.includes(name)) {
            (0, logging_1.logError)(`Library "${name}" is not installed.`);
            return;
        }
        const libraryDir = path_1.default.join('cdn_modules', name);
        let files;
        try {
            files = fs_1.default.readdirSync(libraryDir).filter(file => {
                return file.endsWith('.js') || file.endsWith('.css');
            });
        }
        catch (readErr) {
            (0, logging_1.logError)(`Error reading files for library "${name}" in ${libraryDir}: ${readErr.message}`);
            return;
        }
        if (files.length === 0) {
            (0, logging_1.logWarning)(`No script/style files (.js, .css) found in library "${name}".`);
            return;
        }
        const rankedFiles = files
            .map(file => ({
            file,
            score: (0, libraryUtil_1.getFileScore)(file, name),
        }))
            .sort((a, b) => b.score - a.score);
        console.log(`\nRecommended script/link tags for library "${name}" (prioritized):`);
        rankedFiles.forEach(({ file }) => {
            let tag;
            const filePath = `/cdn_modules/${name}/${file}`;
            if (file.endsWith('.css')) {
                tag = `<link rel="stylesheet" href="${filePath}">`;
            }
            else {
                tag = `<script src="${filePath}" defer></script>`;
            }
            console.log((0, highlightCode_1.highlightScriptTag)(tag));
        });
        const Colors = {
            Reset: "\x1b[0m",
            Bright: "\x1b[1m",
            Dim: "\x1b[2m",
            Underscore: "\x1b[4m",
            Blink: "\x1b[5m",
            Reverse: "\x1b[7m",
            Hidden: "\x1b[8m",
            FgBlack: "\x1b[30m",
            FgRed: "\x1b[31m",
            FgGreen: "\x1b[32m",
            FgYellow: "\x1b[33m",
            FgBlue: "\x1b[34m",
            FgMagenta: "\x1b[35m",
            FgCyan: "\x1b[36m",
            FgWhite: "\x1b[37m",
            BgBlack: "\x1b[40m",
            BgRed: "\x1b[41m",
            BgGreen: "\x1b[42m",
            BgYellow: "\x1b[43m",
            BgBlue: "\x1b[44m",
            BgMagenta: "\x1b[45m",
            BgCyan: "\x1b[46m",
            BgWhite: "\x1b[47m",
        };
        console.log(`\n${Colors.FgYellow}Note:${Colors.Reset} Ensure your server serves the 'cdn_modules' directory correctly.`);
    });
});
commander_1.program.parse(process.argv);
