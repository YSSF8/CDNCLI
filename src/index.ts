#!/usr/bin/env node

import { program } from 'commander';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { logInfo, logSuccess, logWarning, logError, ProgressBar } from './logging';
import { getInstalledLibraries, getFileScore } from './libraryUtil';
import { highlightScriptTag } from './highlightCode';

program
    .name('cdn')
    .description('Fetches data from CDN to install libraries')
    .version('1.0.0');

program
    .command('install <name>')
    .description('Installs a library locally')
    .option('--select-only <files>', 'Comma-separated list of specific files to install')
    .option('--verbose', 'Show detailed logging')
    .action(async (name: string, options: { selectOnly?: string; verbose?: boolean }) => {
        let progressBarActive = false;
        let progressBar: ProgressBar | null = null;

        try {
            if (options.verbose) {
                logInfo(`Starting installation of library: ${name}`);
            }

            const encoded = encodeURIComponent(name.toLowerCase());
            logInfo(`Fetching library info for "${name}" from cdnjs...`);
            const response = await axios.get(`https://cdnjs.com/libraries/${encoded}`);
            const data = response.data;
            const $ = cheerio.load(data);

            const urls = $('.url')
                .map((index, element) => $(element).text())
                .get();

            if (urls.length === 0) {
                logError(`No files found for library: ${name}`);
                return;
            }

            if (options.verbose) {
                logInfo(`Found ${urls.length} total files for the library.`);
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
                    logInfo(`Filtered down to ${filteredUrls.length} files based on --select-only: ${selectedFiles.join(', ')}`);
                } else {
                    logWarning(`No files matched the --select-only criteria: ${selectedFiles.join(', ')}`);
                }
            }

            if (filteredUrls.length === 0) {
                if (selectedFiles) {
                    if (!options.verbose) {
                        logError(`No files match the selected criteria: ${selectedFiles.join(', ')}`);
                    }
                } else {
                    logError(`No files available for download for library: ${name}`);
                }
                return;
            }

            logInfo(`Preparing to download ${filteredUrls.length} file(s)...`);

            progressBar = new ProgressBar(filteredUrls.length);
            progressBarActive = true;
            let downloadedFiles = 0;

            const prioritizedUrls = filteredUrls.sort((a, b) => {
                const isMinA = a.includes('.min.');
                const isMinB = b.includes('.min.');
                if (isMinA && !isMinB) return -1;
                if (!isMinA && isMinB) return 1;
                return 0;
            });

            for (const url of prioritizedUrls) {

                const urlParts = url.split('/');
                const fileNameIndex = urlParts.length - 1;
                const versionIndex = fileNameIndex - 1;
                const libraryNameIndex = versionIndex - 1;

                if (fileNameIndex < 0 || versionIndex < 0 || libraryNameIndex < 3 || urlParts[libraryNameIndex] === 'libs') {

                    if (options.verbose && progressBar) progressBar.clear();
                    logWarning(`Could not parse library name/version/filename from URL: ${url}. Skipping.`);

                    if (progressBar) progressBar.update(downloadedFiles);
                    continue;
                }

                const libraryName = urlParts[libraryNameIndex];
                const fileName = urlParts[fileNameIndex];

                if (options.verbose) {

                    if (progressBar) progressBar.clear();
                    logInfo(`Downloading ${fileName}...`);

                }


                try {
                    const linkResponse = await axios.get(url, { responseType: 'arraybuffer' });
                    const linkData = linkResponse.data;

                    const cdnModulesDir = 'cdn_modules';
                    if (!fs.existsSync(cdnModulesDir)) {
                        fs.mkdirSync(cdnModulesDir);
                        if (options.verbose) {
                            if (progressBar) progressBar.clear();
                            logInfo(`Created directory: ${cdnModulesDir}`);
                        }
                    }

                    const libraryDir = path.join(cdnModulesDir, libraryName);
                    if (!fs.existsSync(libraryDir)) {
                        fs.mkdirSync(libraryDir);
                        if (options.verbose) {
                            if (progressBar) progressBar.clear();
                            logInfo(`Created directory: ${libraryDir}`);
                        }
                    }

                    const filePath = path.join(libraryDir, fileName);
                    fs.writeFileSync(filePath, linkData);

                    if (options.verbose) {

                        if (progressBar) progressBar.clear();
                        logSuccess(`Downloaded and saved: ${filePath}`);
                    }

                    downloadedFiles++;
                } catch (error: any) {

                    if (progressBarActive && progressBar) progressBar.clear();
                    logError(`Failed to fetch or save ${fileName} from ${url}: ${error.message}`);

                } finally {


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
                    logSuccess(`Successfully installed all ${downloadedFiles} files for library: ${name}`);
                } else {
                    logSuccess(`Successfully installed ${downloadedFiles} out of ${filteredUrls.length} files for library: ${name}`);
                }
            } else if (filteredUrls.length > 0) {
                logError(`No files were successfully downloaded for library: ${name}. Check previous errors.`);
            }


        } catch (error: any) {


            if (progressBarActive && progressBar) {
                progressBar.clear();
                progressBarActive = false;
            }

            if (axios.isAxiosError(error) && error.response?.status === 404) {
                logError(`Could not find library "${name}" on cdnjs (404).`);
            } else {
                logError(`Installation failed: ${error.message}`);
            }
        }
    });


program
    .command('uninstall <name>')

    .action((name: string) => {
        try {
            const cdnModulesDir = path.join('cdn_modules');

            if (name === '/') {
                if (!fs.existsSync(cdnModulesDir)) {
                    logError('No libraries are installed (cdn_modules directory not found).');
                    return;
                }

                const libraries = fs.readdirSync(cdnModulesDir, { withFileTypes: true })
                    .filter(dirent => dirent.isDirectory())
                    .map(dirent => dirent.name);

                if (libraries.length === 0) {
                    logInfo('No libraries found within cdn_modules directory.');


                    return;
                }

                logInfo(`Uninstalling all ${libraries.length} libraries...`);
                libraries.forEach(library => {
                    const libraryDir = path.join(cdnModulesDir, library);
                    try {
                        fs.rmSync(libraryDir, { recursive: true, force: true });
                        logSuccess(`Successfully uninstalled library: ${library}`);
                    } catch (rmError: any) {
                        logError(`Failed to remove directory for ${library}: ${rmError.message}`)
                    }
                });

                if (fs.readdirSync(cdnModulesDir).length === 0) {
                    try {
                        fs.rmdirSync(cdnModulesDir);
                        logInfo(`Removed empty cdn_modules directory.`);
                    } catch (rmdirError: any) {
                        logWarning(`Could not remove cdn_modules directory: ${rmdirError.message}`);
                    }
                }

                logSuccess('All libraries have been uninstalled.');
            } else {
                const libraryDir = path.join(cdnModulesDir, name);

                if (!fs.existsSync(libraryDir)) {
                    logError(`Library "${name}" is not installed (directory not found).`);
                    return;
                }

                if (!fs.statSync(libraryDir).isDirectory()) {
                    logError(`Path "${libraryDir}" exists but is not a directory. Cannot uninstall.`);
                    return;
                }

                fs.rmSync(libraryDir, { recursive: true, force: true });
                logSuccess(`Successfully uninstalled library: ${name}`);

                if (fs.existsSync(cdnModulesDir) && fs.readdirSync(cdnModulesDir).length === 0) {
                    try {
                        fs.rmdirSync(cdnModulesDir);
                        logInfo(`Removed empty cdn_modules directory.`);
                    } catch (rmdirError: any) {
                        logWarning(`Could not remove cdn_modules directory: ${rmdirError.message}`);
                    }
                }
            }
        } catch (error: any) {
            logError(`Failed to uninstall library "${name}": ${error.message}`);
        }
    });

program
    .command('list')

    .description('Lists all installed libraries found in cdn_modules')
    .action(() => {
        getInstalledLibraries((err, folders) => {
            if (err) {

                if ((err as any).code === 'ENOENT') {
                    logInfo('No libraries installed (cdn_modules directory not found).');
                } else {
                    logError(`Error reading library directory: ${err.message}`);
                }
                return;
            }

            if (folders && folders.length > 0) {
                logSuccess('Installed libraries:');

                folders.sort().forEach(folder => console.log(`- ${folder}`));
            } else {
                logInfo('No libraries found in the cdn_modules directory.');
            }
        });
    });

program
    .command('script-tag <name>')

    .description('Generates prioritized script tags for an installed library')
    .action((name: string) => {
        getInstalledLibraries((err, folders) => {
            if (err) {
                if ((err as any).code === 'ENOENT') {
                    logError(`Library "${name}" cannot be found because the cdn_modules directory does not exist.`);
                } else {
                    logError(`Error checking installed libraries: ${err.message}`);
                }
                return;
            }

            if (!folders || !folders.includes(name)) {
                logError(`Library "${name}" is not installed.`);
                return;
            }

            const libraryDir = path.join('cdn_modules', name);
            let files: string[];
            try {
                files = fs.readdirSync(libraryDir).filter(file => {

                    return file.endsWith('.js') || file.endsWith('.css');
                });
            } catch (readErr: any) {
                logError(`Error reading files for library "${name}" in ${libraryDir}: ${readErr.message}`);
                return;
            }


            if (files.length === 0) {
                logWarning(`No script/style files (.js, .css) found in library "${name}".`);
                return;
            }

            const rankedFiles = files
                .map(file => ({
                    file,
                    score: getFileScore(file, name),
                }))
                .sort((a, b) => b.score - a.score);

            console.log(`\nRecommended script/link tags for library "${name}" (prioritized):`);
            rankedFiles.forEach(({ file }) => {
                let tag: string;
                const filePath = `/cdn_modules/${name}/${file}`;

                if (file.endsWith('.css')) {
                    tag = `<link rel="stylesheet" href="${filePath}">`;
                } else {

                    tag = `<script src="${filePath}" defer></script>`;
                }

                console.log(highlightScriptTag(tag));
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


program.parse(process.argv);