#!/usr/bin/env node

import { program } from 'commander';
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import * as prettier from 'prettier';
import { logInfo, logSuccess, logWarning, logError, ProgressBar } from './logging';
import { getInstalledLibraries, getFileScore } from './libraryUtil';
import { highlightHtmlTags } from './highlightCode';
import { createLimiter } from './limiter';

program
    .name('cdn')
    .description('Fetches data from CDN to install libraries')
    .version('1.0.0');

program
    .command('install <name>')
    .alias('i')
    .description('Installs a library locally')
    .option('--select-only <files>', 'Comma-separated list of specific files to install')
    .option('--verbose', 'Show detailed logging')
    .option('--concurrency <number>', 'Maximum number of concurrent downloads', (value) => parseInt(value, 10), 10)
    .action(async (name: string, options: { selectOnly?: string; verbose?: boolean; concurrency: number }) => {
        const commandStartTime = Date.now();
        let progressBar: ProgressBar | null = null;
        let progressBarActive = false;

        const concurrency = options.concurrency > 0 ? options.concurrency : 10;
        if (options.verbose) {
            logInfo(`Using concurrency level: ${concurrency}`);
        }

        const limit = createLimiter(concurrency);

        try {
            if (options.verbose) {
                logInfo(`Starting installation of library: ${name}`);
            }

            const encoded = encodeURIComponent(name.toLowerCase());
            logInfo(`Fetching library info for "${name}" from cdnjs...`);
            const response = await axios.get(`https://cdnjs.com/libraries/${encoded}`, { timeout: 30000 });
            const $ = cheerio.load(response.data);

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
                if (selectedFiles && !options.verbose) {
                    logError(`No files match the selected criteria: ${selectedFiles.join(', ')}`);
                } else if (!selectedFiles) {
                    logError(`No files available for download for library: ${name}`);
                }
                return;
            }

            const prioritizedUrls = filteredUrls.sort((a, b) => {
                const isMinA = a.includes('.min.');
                const isMinB = b.includes('.min.');
                if (isMinA && !isMinB) return -1;
                if (!isMinA && isMinB) return 1;
                return 0;
            });

            logInfo(`Preparing to download ${prioritizedUrls.length} file(s)...`);

            progressBar = new ProgressBar(prioritizedUrls.length);
            progressBarActive = true;
            let progressCounter = 0;

            const cdnModulesDir = 'cdn_modules';
            if (!fs.existsSync(cdnModulesDir)) {
                fs.mkdirSync(cdnModulesDir);
                if (options.verbose) logInfo(`Created directory: ${cdnModulesDir}`);
            }

            const downloadPromises = prioritizedUrls.map(url => {
                return limit(async () => {
                    const urlParts = url.split('/');
                    const fileNameIndex = urlParts.length - 1;
                    const versionIndex = fileNameIndex - 1;
                    const libraryNameIndex = versionIndex - 1;

                    if (fileNameIndex < 0 || versionIndex < 0 || libraryNameIndex < 3 || urlParts[libraryNameIndex] === 'libs') {
                        throw new Error(`Could not parse library info from URL: ${url}. Skipping.`);
                    }

                    const libraryName = urlParts[libraryNameIndex];
                    const fileName = urlParts[fileNameIndex];

                    if (options.verbose) {
                        logInfo(`[${progressCounter + 1}/${prioritizedUrls.length}] Downloading ${fileName}...`);
                    }

                    let filePath = '';

                    try {
                        const linkResponse = await axios.get(url, { responseType: 'arraybuffer', timeout: 45000 });
                        const linkData = linkResponse.data;

                        const libraryDir = path.join(cdnModulesDir, libraryName);
                        fs.mkdirSync(libraryDir, { recursive: true });

                        filePath = path.join(libraryDir, fileName);
                        await fs.promises.writeFile(filePath, linkData);

                        if (options.verbose) {
                            logSuccess(`[${progressCounter + 1}/${prioritizedUrls.length}] Saved: ${filePath}`);
                        }
                        return { status: 'fulfilled', path: filePath, url: url };

                    } catch (error) {
                        let errorMessage = `Failed task for ${fileName} from ${url}`;
                        if (axios.isAxiosError(error)) {
                            errorMessage += `: AxiosError: ${error.code || 'N/A'}`;
                            if (error.response) {
                                errorMessage += ` - Status: ${error.response.status} ${error.response.statusText}`;
                            } else {
                                errorMessage += ` - ${error.message}`;
                            }
                        } else if (error instanceof Error) {
                            errorMessage += `: ${(error as Error).message}`;
                        } else {
                            errorMessage += `: Unknown error occurred.`;
                        }

                        throw new Error(errorMessage);
                    } finally {
                        if (progressBar) {
                            progressBar.update(++progressCounter);
                        }
                    }
                });
            });

            const results = await Promise.allSettled(downloadPromises);

            if (progressBar) {
                progressBar.complete();
                progressBarActive = false;
            }

            const commandEndTime = Date.now();
            const durationSeconds = ((commandEndTime - commandStartTime) / 1000).toFixed(1);

            let downloadedCount = 0;
            let failedCount = 0;

            results.forEach((result, index) => {
                if (result.status === 'fulfilled') {
                    downloadedCount++;
                } else {
                    failedCount++;
                    logError(`Failed [${prioritizedUrls[index]}]: ${result.reason.message}`);
                }
            });

            if (downloadedCount > 0) {
                if (failedCount === 0) {
                    logSuccess(`Successfully installed all ${downloadedCount} files for library: ${name} in ${durationSeconds}s`);
                } else {
                    logWarning(`Successfully installed ${downloadedCount} out of ${prioritizedUrls.length} files for library: ${name} in ${durationSeconds}s. ${failedCount} file(s) failed (check errors above).`);
                }
            } else if (prioritizedUrls.length > 0) {
                logError(`No files were successfully downloaded for library: ${name}. Check previous errors. Operation took ${durationSeconds}s`);
            }

        } catch (error) {
            const commandEndTime = Date.now();
            const durationSeconds = ((commandEndTime - commandStartTime) / 1000).toFixed(1);

            if (progressBarActive && progressBar) {
                progressBar.clear();
                progressBarActive = false;
            }

            if (axios.isAxiosError(error) && error.response?.status === 404) {
                logError(`Could not find library "${name}" on cdnjs (404). Failed in ${durationSeconds}s`);
            } else if (error instanceof Error) {
                logError(`Installation failed: ${error.message}. Operation took ${durationSeconds}s`);
            } else {
                logError(`An unexpected error occurred during installation. Operation took ${durationSeconds}s`);
            }
        }
    });

program
    .command('uninstall <name>')
    .alias('un')
    .action((name: string) => {
        const commandStartTime = Date.now();
        try {
            const cdnModulesDir = path.join('cdn_modules');
            let uninstalledCount = 0;

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
                    const commandEndTime = Date.now();
                    const durationSeconds = ((commandEndTime - commandStartTime) / 1000).toFixed(1);
                    logInfo(`Uninstall check finished in ${durationSeconds}s`);
                    return;
                }

                logInfo(`Uninstalling all ${libraries.length} libraries...`);
                libraries.forEach(library => {
                    const libraryDir = path.join(cdnModulesDir, library);
                    try {
                        fs.rmSync(libraryDir, { recursive: true, force: true });
                        logSuccess(`Successfully uninstalled library: ${library}`);
                        uninstalledCount++;
                    } catch (rmError) {
                        logError(`Failed to remove directory for ${library}: ${(rmError as Error).message}`)
                    }
                });

                if (fs.readdirSync(cdnModulesDir).length === 0) {
                    try {
                        fs.rmdirSync(cdnModulesDir);
                        logInfo(`Removed empty cdn_modules directory.`);
                    } catch (rmdirError) {
                        logWarning(`Could not remove cdn_modules directory: ${(rmdirError as Error).message}`);
                    }
                }

                const commandEndTime = Date.now();
                const durationSeconds = ((commandEndTime - commandStartTime) / 1000).toFixed(1);
                logSuccess(`Finished uninstalling ${uninstalledCount} libraries in ${durationSeconds}s`);
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

                const commandEndTime = Date.now();
                const durationSeconds = ((commandEndTime - commandStartTime) / 1000).toFixed(1);
                logSuccess(`Successfully uninstalled library: ${name} in ${durationSeconds}s`);

                if (fs.existsSync(cdnModulesDir) && fs.readdirSync(cdnModulesDir).length === 0) {
                    try {
                        fs.rmdirSync(cdnModulesDir);
                        logInfo(`Removed empty cdn_modules directory.`);
                    } catch (rmdirError) {
                        logWarning(`Could not remove cdn_modules directory: ${(rmdirError as Error).message}`);
                    }
                }
            }
        } catch (error) {
            const commandEndTime = Date.now();
            const durationSeconds = ((commandEndTime - commandStartTime) / 1000).toFixed(1);
            logError(`Failed to uninstall library "${name}": ${(error as Error).message}. Operation took ${durationSeconds}s`);
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
    .command('embed <name>')
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

                console.log(highlightHtmlTags(tag, ['link', 'script']));
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

program
    .command('insert <library-name>')
    .argument('[filename]', 'Optional specific file to insert (e.g., jquery.min.js)')
    .argument('<html-file>', 'HTML file to modify')
    .argument('<location>', 'Location in HTML (head or body)')
    .description('Inserts a script/link tag for a library file into an HTML file')
    .action(async (libraryName: string, filename: string | undefined, htmlFile: string, location: string) => {
        try {
            const targetLocation = location.toLowerCase();
            if (targetLocation !== 'head' && targetLocation !== 'body') {
                logError(`Invalid location "${location}". Must be 'head' or 'body'.`);
                return;
            }

            if (!fs.existsSync(htmlFile)) {
                logError(`HTML file not found: ${htmlFile}`);
                return;
            }
            try {
                fs.accessSync(htmlFile, fs.constants.R_OK | fs.constants.W_OK);
            } catch (accessErr) {
                logError(`Cannot read/write HTML file: ${htmlFile}. Check permissions.`);
                return;
            }

            const cdnModulesDir = 'cdn_modules';
            const libraryDir = path.join(cdnModulesDir, libraryName);
            let actualLibraryName = libraryName;

            if (!fs.existsSync(libraryDir) || !fs.statSync(libraryDir).isDirectory()) {
                let found = false;
                if (fs.existsSync(cdnModulesDir)) {
                    const dirs = fs.readdirSync(cdnModulesDir, { withFileTypes: true })
                        .filter(d => d.isDirectory())
                        .map(d => d.name);
                    const match = dirs.find(dir => dir.toLowerCase() === libraryName.toLowerCase());
                    if (match) {
                        actualLibraryName = match;
                        found = true;
                    }
                }
                if (!found) {
                    logError(`Library "${libraryName}" is not installed (directory not found in ${cdnModulesDir}).`);
                    return;
                }
            }
            const actualLibraryDir = path.join(cdnModulesDir, actualLibraryName);

            let fileToInsert: string | null = null;
            let filesInLib: string[];
            try {
                filesInLib = fs.readdirSync(actualLibraryDir).filter(file =>
                    (file.endsWith('.js') || file.endsWith('.css')) && !file.endsWith('.map')
                );
            } catch (readErr) {
                logError(`Error reading library directory ${actualLibraryDir}: ${(readErr as Error).message}`);
                return;
            }

            if (filesInLib.length === 0) {
                logError(`No suitable .js or .css files found in ${actualLibraryDir}.`);
                return;
            }

            if (filename) {
                const foundFile = filesInLib.find(f => f.toLowerCase() === filename.toLowerCase());
                if (!foundFile) {
                    logError(`Specified file "${filename}" not found in ${actualLibraryDir}.`);
                    logInfo(`Available files: ${filesInLib.join(', ')}`);
                    return;
                }
                fileToInsert = foundFile;
                logInfo(`Using specified file: ${fileToInsert}`);
            } else {
                const rankedFiles = filesInLib
                    .map(file => ({
                        file,
                        score: getFileScore(file, actualLibraryName),
                    }))
                    .sort((a, b) => b.score - a.score);

                if (rankedFiles.length > 0) {
                    fileToInsert = rankedFiles[0].file;
                    logInfo(`No specific file requested, selecting best match: ${fileToInsert}`);
                } else {
                    logError(`Could not determine a best file to insert in ${actualLibraryDir}.`);
                    return;
                }
            }

            if (!fileToInsert) {
                logError("Failed to determine file for insertion.");
                return;
            }

            let tagToInsert: string;
            const filePath = `/cdn_modules/${actualLibraryName}/${fileToInsert}`;
            const fileExt = path.extname(fileToInsert).toLowerCase();

            if (fileExt === '.css') {
                tagToInsert = `<link rel="stylesheet" href="${filePath}">`;
            } else if (fileExt === '.js') {
                tagToInsert = `<script src="${filePath}" defer></script>`;
            } else {
                logError(`Unsupported file type for insertion: ${fileToInsert}`);
                return;
            }

            logInfo(`Reading HTML file: ${htmlFile}`);
            const htmlContent = fs.readFileSync(htmlFile, 'utf-8');
            const $ = cheerio.load(htmlContent, {
                // Try to preserve some whitespace characteristics if possible with cheerio options
                // Note: Cheerio is not a full layout engine, perfect preservation isn't guaranteed.
                // decodeEntities: false // Might help sometimes? Often not needed.
            });

            const targetElement = $(targetLocation);
            if (targetElement.length === 0) {
                logError(`Could not find <${targetLocation}> tag in ${htmlFile}. Ensure it's valid HTML.`);
                return;
            }

            let tagExists = false;
            const selector = fileExt === '.css' ? `link[href="${filePath}"]` : `script[src="${filePath}"]`;
            if ($(targetLocation).find(selector).length > 0) {
                tagExists = true;
            }

            if (tagExists) {
                logWarning(`Tag for "${filePath}" already exists in <${targetLocation}> of ${htmlFile}. No changes made.`);
                return;
            }

            logInfo(`Inserting tag into <${targetLocation}>...`);
            targetElement.append(`\n    ${tagToInsert}\n`);

            const rawHtmlOutput = $.html();
            let finalHtmlOutput = rawHtmlOutput;

            try {
                logInfo('Formatting HTML output...');
                finalHtmlOutput = await prettier.format(rawHtmlOutput, {
                    parser: 'html',
                });
                if (!finalHtmlOutput.endsWith('\n')) {
                    finalHtmlOutput += '\n';
                }
            } catch (formatError) {
                logWarning(`Could not format HTML output using prettier: ${(formatError as Error).message}`);
                logWarning('Writing unformatted HTML instead.');
            }


            logInfo(`Writing changes back to ${htmlFile}`);
            fs.writeFileSync(htmlFile, finalHtmlOutput, 'utf-8');

            logSuccess(`Successfully inserted tag for ${fileToInsert} into ${htmlFile}`);
            console.log(highlightHtmlTags(`Inserted: ${tagToInsert}`, ['link', 'script']));


        } catch (error: any) {
            logError(`Failed to insert tag: ${error.message}`);
            if (error.stack) {
                console.error(error.stack);
            }
        }
    });

program.parse(process.argv);