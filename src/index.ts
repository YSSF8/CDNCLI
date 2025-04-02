#!/usr/bin/env node

import { program } from 'commander';
import axios, { AxiosError } from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import * as prettier from 'prettier';
import { logInfo, logSuccess, logWarning, logError, ProgressBar } from './logging';
import { getInstalledLibraries, getFileScore, findFilesRecursive, downloadWithRetry } from './libraryUtil';
import { highlightHtmlTags } from './highlightCode';
import { createLimiter } from './limiter';

program
    .name('cdn')
    .description('Fetches data from CDN to install libraries')
    .version('1.0.0');

program
    .command('install <name>')
    .alias('i')
    .description('Installs a library locally into cdn_modules/<name>')
    .option('--select-only <files>', 'Comma-separated list of specific files to install')
    .option('--verbose', 'Show detailed logging')
    .option('--concurrency <number>', 'Maximum number of concurrent downloads', (value) => parseInt(value, 10), 5)
    .action(async (name: string, options: { selectOnly?: string; verbose?: boolean; concurrency: number }) => {
        const commandStartTime = Date.now();
        let progressBar: ProgressBar | null = null;
        let progressBarActive = false;

        const concurrency = options.concurrency > 0 ? options.concurrency : 5;
        if (options.verbose) {
            logInfo(`Using concurrency level: ${concurrency}`);
        }

        const limit = createLimiter(concurrency);

        const cdnModulesDir = 'cdn_modules';
        const libraryBaseDir = path.join(cdnModulesDir, name);

        try {
            if (options.verbose) {
                logInfo(`Starting installation of library: ${name}`);
            }

            const encoded = encodeURIComponent(name.toLowerCase());
            const libraryInfoUrl = `https://cdnjs.com/libraries/${encoded}`;

            logInfo(`Fetching library info for "${name}" from ${libraryInfoUrl}...`);

            let response;
            try {
                const fetchStartTime = Date.now();
                if (options.verbose) logInfo(`  - Attempting GET request to ${libraryInfoUrl} with timeout 45000ms...`);

                response = await axios.get(libraryInfoUrl, {
                    timeout: 45000,
                });

                const fetchEndTime = Date.now();
                if (options.verbose) logInfo(`  - Successfully fetched library info page. Status: ${response.status}. Duration: ${fetchEndTime - fetchStartTime}ms`);

            } catch (fetchError) {
                const fetchEndTime = Date.now();
                let detailedErrorMessage = `Failed during initial library info fetch from ${libraryInfoUrl}`;
                if (axios.isAxiosError(fetchError)) {
                    detailedErrorMessage += `: AxiosError: ${fetchError.code || 'N/A'}`;
                    if (fetchError.response) {
                        detailedErrorMessage += ` - Status: ${fetchError.response.status}`;
                    } else if (fetchError.request) {
                        detailedErrorMessage += ` - No response received`;
                    }
                    if (fetchError.message) {
                        detailedErrorMessage += ` (${fetchError.message})`;
                    }
                } else if (fetchError instanceof Error) {
                    detailedErrorMessage += `: ${fetchError.message}`;
                } else {
                    detailedErrorMessage += `: Unknown error object type.`;
                }
                detailedErrorMessage += ` (Attempt duration: ${fetchEndTime - commandStartTime}ms)`;
                throw new Error(detailedErrorMessage);
            }


            const $ = cheerio.load(response.data);

            const urls = $('.url')
                .map((index, element) => $(element).text())
                .get()
                .map(url => url.startsWith('//') ? `https:${url}` : url);

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

            logInfo(`Preparing to download ${prioritizedUrls.length} file(s) into ${libraryBaseDir}...`);

            progressBar = new ProgressBar(prioritizedUrls.length);
            progressBarActive = true;
            let progressCounter = 0;

            if (!fs.existsSync(cdnModulesDir)) {
                fs.mkdirSync(cdnModulesDir);
                if (options.verbose) logInfo(`Created directory: ${cdnModulesDir}`);
            }
            fs.mkdirSync(libraryBaseDir, { recursive: true });
            if (options.verbose) logInfo(`Ensured library directory exists: ${libraryBaseDir}`);

            const fileOutcomes: Array<{ status: 'fulfilled' | 'rejected'; url: string; reason?: any }> = [];

            const downloadPromises = prioritizedUrls.map(url => {
                return limit(async () => {
                    let result: { status: 'fulfilled'; path: string; url: string } | null = null;
                    let finalError: Error | null = null;
                    let filePath: string | null = null;

                    try {
                        const urlParts = new URL(url).pathname.split('/').filter(Boolean);
                        const libsIndex = urlParts.findIndex(part => part === 'libs');
                        if (libsIndex === -1 || libsIndex + 2 >= urlParts.length) {
                            throw new Error(`Could not parse standard cdnjs path structure from URL: ${url}. Skipping.`);
                        }

                        const relativePathParts = urlParts.slice(libsIndex + 3);
                        if (relativePathParts.length === 0) {
                            const fileNameFromUrl = urlParts[urlParts.length - 1];
                            if (!fileNameFromUrl || !fileNameFromUrl.includes('.')) {
                                throw new Error(`Could not determine relative file path from URL: ${url}. Skipping.`);
                            }
                            logWarning(`Could not determine version/path structure reliably for ${url}, saving as ${fileNameFromUrl}`);
                            relativePathParts.push(fileNameFromUrl);
                        }

                        const relativeFilePath = relativePathParts.join(path.sep);
                        const fileName = path.basename(relativeFilePath);
                        filePath = path.join(libraryBaseDir, relativeFilePath);
                        const fileDir = path.dirname(filePath);

                        if (options.verbose) {
                            logInfo(`[${progressCounter + 1}/${prioritizedUrls.length}] Preparing to download:`);
                            logInfo(`  - URL: ${url}`);
                            logInfo(`  - Target Path: ${filePath}`);
                        }

                        await fs.promises.mkdir(fileDir, { recursive: true });

                        if (options.verbose) {
                            logInfo(`  - Attempting download now...`);
                        }

                        result = await downloadWithRetry(url, filePath, { verbose: options.verbose });

                        if (options.verbose) {
                            logSuccess(`[${progressCounter + 1}/${prioritizedUrls.length}] Saved: ${filePath}`);
                        }
                        fileOutcomes.push({ status: 'fulfilled', url: url });

                    } catch (error) {
                        finalError = error instanceof Error ? error : new Error(String(error));
                        const targetPathInfo = filePath ? ` (intended target: ${filePath})` : '';
                        logError(`Download failed for URL: ${url}${targetPathInfo}`);
                        fileOutcomes.push({ status: 'rejected', url: url, reason: finalError });
                        throw finalError;

                    } finally {
                        if (progressBar) {
                            progressBar.update(++progressCounter);
                        }
                    }
                    return result;
                });
            });

            const settledResults = await Promise.allSettled(downloadPromises);

            if (progressBar) {
                progressBar.complete();
                progressBarActive = false;
            }

            const commandEndTime = Date.now();
            const durationSeconds = ((commandEndTime - commandStartTime) / 1000).toFixed(1);

            let downloadedCount = 0;
            let failedCount = 0;

            settledResults.forEach((result, index) => {
                const url = prioritizedUrls[index];
                if (result.status === 'fulfilled') {
                    downloadedCount++;
                } else {
                    failedCount++;
                    const reasonMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
                    logError(`Failed Download Task [URL: ${url}]: ${reasonMsg || 'Unknown error during download task'}`);
                }
            });


            if (downloadedCount > 0) {
                if (failedCount === 0) {
                    logSuccess(`Successfully installed all ${downloadedCount} files for library "${name}" into ${libraryBaseDir} in ${durationSeconds}s`);
                } else {
                    logWarning(`Successfully installed ${downloadedCount} out of ${prioritizedUrls.length} files for library "${name}" into ${libraryBaseDir} in ${durationSeconds}s. ${failedCount} file(s) failed (check errors above).`);
                }
            } else if (prioritizedUrls.length > 0) {
                logError(`No files were successfully downloaded for library: ${name}. Check previous errors. Operation took ${durationSeconds}s`);
            } else {
                logWarning(`No files were selected or available for download for library: ${name}. Operation took ${durationSeconds}s`);
            }

        } catch (error) {
            const commandEndTime = Date.now();
            const durationSeconds = ((commandEndTime - commandStartTime) / 1000).toFixed(1);

            if (progressBarActive && progressBar) {
                progressBar.clear();
                progressBarActive = false;
            }

            let errorMessage = "An unknown issue occurred";

            if (axios.isAxiosError(error)) {
                if (error.response?.status === 404) {
                    errorMessage = `Could not find library "${name}" on cdnjs (404)`;
                } else {
                    errorMessage = `Axios Error: ${error.code || 'N/A'}`;
                    if (error.response) {
                        errorMessage += ` - Status: ${error.response.status}`;
                    } else if (error.request) {
                        errorMessage += ` - No response received`;
                    }
                    if (error.message && errorMessage !== error.message) {
                        errorMessage += ` (${error.message})`;
                    }
                }
            } else if (error instanceof Error) {
                errorMessage = error.message ? error.message : "Caught Error object without a message";
            } else {
                try {
                    errorMessage = `Caught non-Error value: ${String(error)}`;
                } catch (stringifyError) {
                    errorMessage = "Caught a non-standard error that could not be stringified.";
                }
            }

            logError(`Installation failed: ${errorMessage}. Operation took ${durationSeconds}s`);

            if (options.verbose) {
                console.error("\n--- Verbose Error Details ---");
                console.error("Error Type:", typeof error);
                console.error("Raw Error Object:", error);
                if (error instanceof Error && error.stack) {
                    console.error("Stack Trace:\n", error.stack);
                }
                console.error("---------------------------\n");
            }

            process.exitCode = 1;
        }
    });

program
    .command('uninstall [names...]')
    .alias('un')
    .description('Uninstalls one or more specified libraries, or all libraries if "/" is the only argument')
    .action((names: string[]) => {
        const commandStartTime = Date.now();
        let uninstalledCount = 0;
        let failedCount = 0;
        const cdnModulesDir = path.join('cdn_modules');

        if (!fs.existsSync(cdnModulesDir)) {
            logError('No libraries are installed (cdn_modules directory not found).');
            return;
        }

        if (names.length === 1 && names[0] === '/') {
            const libraries = fs.readdirSync(cdnModulesDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);

            if (libraries.length === 0) {
                logInfo('No libraries found within cdn_modules directory to uninstall.');
            } else {
                logInfo(`Uninstalling all ${libraries.length} libraries...`);
                libraries.forEach(library => {
                    const libraryDir = path.join(cdnModulesDir, library);
                    try {
                        fs.rmSync(libraryDir, { recursive: true, force: true });
                        logSuccess(`Successfully uninstalled library: ${library}`);
                        uninstalledCount++;
                    } catch (rmError) {
                        logError(`Failed to remove directory for ${library}: ${(rmError as Error).message}`);
                        failedCount++;
                    }
                });
            }
        } else if (names.length > 0) {
            logInfo(`Attempting to uninstall ${names.length} specified libraries: ${names.join(', ')}`);

            const allInstalled = fs.readdirSync(cdnModulesDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);
            const installedLookup = new Map(allInstalled.map(name => [name.toLowerCase(), name]));

            names.forEach(name => {
                if (name === '/') {
                    logWarning(`Ignoring '/' argument when specific library names are provided.`);
                    return;
                }

                let actualLibraryName = installedLookup.get(name.toLowerCase());
                let libraryDir: string | null = null;

                if (actualLibraryName) {
                    libraryDir = path.join(cdnModulesDir, actualLibraryName);
                } else {
                    const exactPath = path.join(cdnModulesDir, name);
                    if (fs.existsSync(exactPath) && fs.statSync(exactPath).isDirectory()) {
                        libraryDir = exactPath;
                        actualLibraryName = name;
                    }
                }


                if (!libraryDir || !actualLibraryName) {
                    logWarning(`Library "${name}" is not installed or not found. Skipping.`);
                    failedCount++;
                    return;
                }

                if (!fs.statSync(libraryDir).isDirectory()) {
                    logError(`Path for "${actualLibraryName}" exists but is not a directory (${libraryDir}). Cannot uninstall.`);
                    failedCount++;
                    return;
                }

                try {
                    fs.rmSync(libraryDir, { recursive: true, force: true });
                    logSuccess(`Successfully uninstalled library: ${actualLibraryName}`);
                    uninstalledCount++;
                } catch (error) {
                    logError(`Failed to uninstall library "${actualLibraryName}": ${(error as Error).message}`);
                    failedCount++;
                }
            });
        } else {
            logError('No library names specified for uninstallation.');
            program.outputHelp();
            return;
        }

        if (fs.existsSync(cdnModulesDir) && fs.readdirSync(cdnModulesDir).length === 0) {
            try {
                fs.rmdirSync(cdnModulesDir);
                logInfo(`Removed empty cdn_modules directory.`);
            } catch (rmdirError) {
                logWarning(`Could not remove cdn_modules directory: ${(rmdirError as Error).message}`);
            }
        }

        const commandEndTime = Date.now();
        const durationSeconds = ((commandEndTime - commandStartTime) / 1000).toFixed(1);

        if (uninstalledCount > 0 && failedCount === 0) {
            logSuccess(`Finished uninstalling ${uninstalledCount} libraries in ${durationSeconds}s.`);
        } else if (uninstalledCount > 0 && failedCount > 0) {
            logWarning(`Completed uninstall process in ${durationSeconds}s. Successfully uninstalled ${uninstalledCount} libraries, but failed to uninstall ${failedCount} (see errors above).`);
        } else if (uninstalledCount === 0 && failedCount > 0) {
            logError(`Uninstall process completed in ${durationSeconds}s, but failed to uninstall ${failedCount} requested libraries (see errors above).`);
        } else if (uninstalledCount === 0 && failedCount === 0 && !(names.length === 1 && names[0] === '/')) {
            logInfo(`No matching installed libraries found for the names provided. Operation took ${durationSeconds}s.`);
        } else if (names.length === 1 && names[0] === '/') {
            logInfo(`Uninstall process finished in ${durationSeconds}s. No libraries were present to uninstall.`);
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
    .command('embed <name> [subpaths...]')
    .description('Generates prioritized script/link tags for an installed library (searches recursively)')
    .action((name: string, subpaths: string[]) => {
        const cdnModulesDir = 'cdn_modules';

        getInstalledLibraries((err, folders) => {
            if (err) {
                if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                    logError(`Cannot check library "${name}" because the ${cdnModulesDir} directory does not exist.`);
                } else {
                    logError(`Error checking installed libraries: ${err.message}`);
                }
                return;
            }

            if (!folders || !folders.includes(name)) {
                logError(`Library "${name}" base directory not found in ${cdnModulesDir}. Did you install it?`);
                return;
            }

            const libraryBaseDir = path.join(cdnModulesDir, name);
            const searchPaths: string[] = [];
            const targetRelativePaths: string[] = [];

            if (!subpaths || subpaths.length === 0 || (subpaths.length === 1 && subpaths[0] === '.')) {
                searchPaths.push(libraryBaseDir);
                targetRelativePaths.push('.');
                logInfo(`Scanning all .js/.css files recursively in ${libraryBaseDir}...`);
            } else {
                logInfo(`Scanning for .js/.css files within specified subpaths of ${libraryBaseDir}: ${subpaths.join(', ')}`);
                subpaths.forEach(sp => {
                    const fullSubPath = path.join(libraryBaseDir, sp);
                    searchPaths.push(fullSubPath);

                    let targetRelative = sp.split(path.sep).join('/');
                    if (targetRelative.endsWith('/')) {
                        targetRelative = targetRelative.slice(0, -1);
                    }
                    targetRelativePaths.push(targetRelative);
                });
            }

            let allFiles: string[] = [];
            try {
                allFiles = findFilesRecursive(
                    libraryBaseDir,
                    cdnModulesDir,
                    (filePath) => filePath.endsWith('.js') || filePath.endsWith('.css')
                );

                if (allFiles.length === 0) {
                    logWarning(`No .js or .css files found recursively within ${libraryBaseDir}.`);
                    return;
                }

                let filteredFiles: string[] = [];
                if (targetRelativePaths.length === 1 && targetRelativePaths[0] === '.') {
                    filteredFiles = allFiles;
                } else {
                    filteredFiles = allFiles.filter(fileRelPath => {
                        const pathWithoutLibName = fileRelPath.substring(name.length + 1);

                        return targetRelativePaths.some(targetRel => {
                            const targetFullPath = path.join(libraryBaseDir, targetRel);
                            const stats = fs.existsSync(targetFullPath) ? fs.statSync(targetFullPath) : null;

                            if (stats?.isDirectory()) {
                                const dirPrefix = targetRel.endsWith('/') ? targetRel : targetRel + '/';
                                return pathWithoutLibName.startsWith(dirPrefix);
                            } else if (stats?.isFile()) {
                                return pathWithoutLibName === targetRel;
                            } else {
                                return pathWithoutLibName.startsWith(targetRel);
                            }
                        });
                    });

                    if (filteredFiles.length === 0 && allFiles.length > 0) {
                        logWarning(`No .js or .css files found matching the specified subpaths: ${subpaths.join(', ')} within ${libraryBaseDir}`);
                        logInfo(`Found ${allFiles.length} total files in the library.`);
                        return;
                    } else if (filteredFiles.length === 0 && allFiles.length === 0) {
                        return;
                    }
                }


                if (filteredFiles.length === 0) {
                    logWarning(`No relevant script/style files (.js, .css) found for library "${name}" with the specified criteria.`);
                    return;
                }

                const rankedFiles = filteredFiles
                    .map(relativeFilePath => ({
                        file: relativeFilePath,
                        score: getFileScore(relativeFilePath, name),
                    }))
                    .sort((a, b) => b.score - a.score);

                console.log(`\nRecommended script/link tags for library "${name}" (prioritized based on specified paths):`);
                rankedFiles.forEach(({ file }) => {
                    let tag: string;
                    const webPath = `/${file}`;

                    if (file.endsWith('.css')) {
                        tag = `<link rel="stylesheet" href="${webPath}">`;
                    } else {
                        tag = `<script src="${webPath}" defer></script>`;
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

                console.log(`\n${Colors.FgYellow}Note:${Colors.Reset} Ensure your server serves the '${cdnModulesDir}' directory (or the specific library folder '${name}') correctly.`);
                console.log(`      Paths shown are relative to the root of where '${cdnModulesDir}' is served.`);


            } catch (readErr: any) {
                logError(`Error processing files for library "${name}": ${readErr.message}`);
                if (readErr.stack) console.error(readErr.stack);
                return;
            }
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