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

const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;

program
    .name('cdn')
    .description('Fetches data from CDN to install libraries')
    .version(version);

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

        const concurrency = options.concurrency > 0 ? options.concurrency : 15;
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

            logInfo(`Fetching library info for "${name}"...`);

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
                .map(url => url.startsWith('//') ? `https:${url}` : url)
                .filter(url => !url.endsWith('.html'));

            if (urls.length === 0) {
                logError(`No actual asset files (JS/CSS etc.) found for library: ${name}`);
                return;
            }

            if (options.verbose) {
                logInfo(`Found ${urls.length} potential asset file(s) for the library.`);
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

            if (!options.verbose) {
                progressBar = new ProgressBar(prioritizedUrls.length);
                progressBarActive = true;
            } else {
                progressBar = null;
                progressBarActive = false;
            }

            let progressCounter = 0;
            let totalBytesDownloaded = 0;

            if (!fs.existsSync(cdnModulesDir)) {
                fs.mkdirSync(cdnModulesDir);
                if (options.verbose) logInfo(`Created directory: ${cdnModulesDir}`);
            }
            fs.mkdirSync(libraryBaseDir, { recursive: true });
            if (options.verbose) logInfo(`Ensured library directory exists: ${libraryBaseDir}`);

            const fileOutcomes: Array<{ status: 'fulfilled' | 'rejected'; url: string; reason?: any }> = [];

            const downloadPromises = prioritizedUrls.map(url => {
                return limit(async () => {
                    let result: { status: 'fulfilled'; path: string; url: string; size: number } | null = null;
                    let finalError: Error | null = null;
                    let filePath: string | null = null;
                    let downloadedSize = 0;

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
                            logWarning(`Could not determine version/path structure reliably for ${url}, saving directly under library base`);
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

                        const downloadResult = await downloadWithRetry(url, filePath, { verbose: options.verbose });
                        downloadedSize = downloadResult.size;
                        result = { ...downloadResult, status: 'fulfilled' };

                        if (options.verbose) {
                            logSuccess(`[${progressCounter + 1}/${prioritizedUrls.length}] Saved: ${filePath} (${(downloadedSize / 1024).toFixed(1)} KB)`);
                        }
                        fileOutcomes.push({ status: 'fulfilled', url: url });

                    } catch (error) {
                        finalError = error instanceof Error ? error : new Error(String(error));
                        const targetPathInfo = filePath ? ` (intended target: ${filePath})` : '';
                        logError(`Download failed for URL: ${url}${targetPathInfo}: ${finalError.message}`);
                        fileOutcomes.push({ status: 'rejected', url: url, reason: finalError });

                    } finally {
                        progressCounter++;
                        totalBytesDownloaded += downloadedSize;
                        if (progressBar) {
                            progressBar.update(progressCounter, totalBytesDownloaded);
                        }
                    }

                    if (finalError) {
                        throw finalError;
                    }
                    return result!;
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
                if (result.status === 'fulfilled' && result.value?.status === 'fulfilled') {
                    downloadedCount++;
                } else {
                    failedCount++;
                    if (!options.verbose && result.status === 'rejected') {
                        const reasonMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
                        logError(`Failed Task Summary [URL: ${url}]: ${reasonMsg || 'Unknown error during download task'}`);
                    }
                }
            });


            if (downloadedCount > 0) {
                const totalSizeKB = (totalBytesDownloaded / 1024).toFixed(1);
                const totalSizeMB = (totalBytesDownloaded / 1024 / 1024).toFixed(2);
                const sizeString = totalBytesDownloaded > 1024 * 500 ? `${totalSizeMB} MB` : `${totalSizeKB} KB`;

                if (failedCount === 0) {
                    logSuccess(`Successfully installed all ${downloadedCount} files (${sizeString}) for library "${name}" into ${libraryBaseDir} in ${durationSeconds}s`);
                } else {
                    logWarning(`Successfully installed ${downloadedCount} out of ${prioritizedUrls.length} files (${sizeString}) for library "${name}" into ${libraryBaseDir} in ${durationSeconds}s. ${failedCount} file(s) failed (check errors above).`);
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
                if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
                    logInfo('No libraries installed (cdn_modules directory not found).');
                } else {
                    logError(`Error reading library directory: ${err.message}`);
                }
                return;
            }

            if (folders && folders.length > 0) {
                logSuccess('Installed libraries:');
                folders.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
                folders.forEach(folder => console.log(`- ${folder}`));
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

            const actualName = folders?.find(folder => folder.toLowerCase() === name.toLowerCase());

            if (!actualName) {
                logError(`Library "${name}" base directory not found in ${cdnModulesDir}. Did you install it?`);
                return;
            }
            if (actualName !== name) {
                logInfo(`Using installed library directory: "${actualName}" (matched case-insensitively)`);
            }

            const libraryBaseDir = path.join(cdnModulesDir, actualName);
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
                    filteredFiles = allFiles.filter(fileRelPath => fileRelPath.startsWith(actualName + '/'));
                } else {
                    filteredFiles = allFiles.filter(fileRelPath => {
                        const normalizedFileRelPath = fileRelPath.split(path.sep).join('/');

                        if (!normalizedFileRelPath.startsWith(actualName + '/')) {
                            return false;
                        }

                        const pathWithinLib = normalizedFileRelPath.substring(actualName.length + 1);

                        return targetRelativePaths.some(targetRel => {
                            const targetFullPath = path.join(libraryBaseDir, targetRel);
                            const stats = fs.existsSync(targetFullPath) ? fs.statSync(targetFullPath) : null;

                            if (stats?.isDirectory()) {
                                const dirPrefix = targetRel.endsWith('/') ? targetRel : targetRel + '/';
                                return pathWithinLib.startsWith(dirPrefix);
                            } else if (stats?.isFile()) {
                                return pathWithinLib === targetRel;
                            } else {
                                logWarning(`Subpath target "${targetRel}" does not exist or is not a file/directory. Falling back to prefix match.`);
                                return pathWithinLib.startsWith(targetRel);
                            }
                        });
                    });

                    if (filteredFiles.length === 0 && allFiles.length > 0) {
                        logWarning(`No .js or .css files found matching the specified subpaths: ${subpaths.join(', ')} within ${libraryBaseDir}`);
                        return;
                    } else if (filteredFiles.length === 0 && allFiles.length === 0) {
                        return;
                    }
                }


                if (filteredFiles.length === 0) {
                    logWarning(`No relevant script/style files (.js, .css) found for library "${actualName}" with the specified criteria.`);
                    return;
                }

                const rankedFiles = filteredFiles
                    .map(relativeFilePath => ({
                        file: relativeFilePath,
                        score: getFileScore(relativeFilePath, actualName),
                    }))
                    .sort((a, b) => b.score - a.score);

                console.log(`\nRecommended script/link tags for library "${actualName}" (prioritized based on specified paths):`);
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

                const ColorsEmbed = {
                    Reset: "\x1b[0m",
                    FgYellow: "\x1b[33m",
                };

                console.log(`\n${ColorsEmbed.FgYellow}Note:${ColorsEmbed.Reset} Ensure your server serves the '${cdnModulesDir}' directory correctly.`);
                console.log(`      Paths shown are relative to the root where '${cdnModulesDir}' is served.`);


            } catch (readErr: any) {
                logError(`Error processing files for library "${actualName}": ${readErr.message}`);
                if (readErr.stack && process.env.NODE_ENV !== 'production') {
                    console.error(readErr.stack);
                }
                return;
            }
        });
    });

program
    .command('insert <library-name>')
    .argument('[filename]', 'Optional specific file path relative to the library root (e.g., "dist/jquery.min.js" or "addon/edit/closebrackets.js")')
    .argument('<html-file>', 'HTML file to modify')
    .argument('<location>', 'Location in HTML (head or body)')
    .description('Inserts a script/link tag for a library file into an HTML file')
    .action(async (libraryName: string, filename: string | undefined, htmlFile: string, location: string) => {
        const commandStartTime = Date.now();
        try {
            const targetLocation = location.toLowerCase();
            if (targetLocation !== 'head' && targetLocation !== 'body') {
                logError(`Invalid location "${location}". Must be 'head' or 'body'.`);
                process.exitCode = 1;
                return;
            }

            if (!fs.existsSync(htmlFile)) {
                logError(`HTML file not found: ${htmlFile}`);
                process.exitCode = 1;
                return;
            }
            try {
                fs.accessSync(htmlFile, fs.constants.R_OK | fs.constants.W_OK);
            } catch (accessErr) {
                logError(`Cannot read/write HTML file: ${htmlFile}. Check permissions.`);
                process.exitCode = 1;
                return;
            }

            const cdnModulesDir = 'cdn_modules';
            const baseLibraryDir = path.join(cdnModulesDir, libraryName);
            let actualLibraryName = libraryName;
            let actualLibraryDir = baseLibraryDir;

            if (!fs.existsSync(baseLibraryDir) || !fs.statSync(baseLibraryDir).isDirectory()) {
                let found = false;
                if (fs.existsSync(cdnModulesDir)) {
                    const dirs = fs.readdirSync(cdnModulesDir, { withFileTypes: true })
                        .filter(d => d.isDirectory())
                        .map(d => d.name);
                    const match = dirs.find(dir => dir.toLowerCase() === libraryName.toLowerCase());
                    if (match) {
                        actualLibraryName = match;
                        actualLibraryDir = path.join(cdnModulesDir, actualLibraryName);
                        found = true;
                        logInfo(`Using installed library directory: "${actualLibraryName}" (matched case-insensitively)`);
                    }
                }
                if (!found) {
                    logError(`Library "${libraryName}" is not installed (directory not found in ${cdnModulesDir}).`);
                    process.exitCode = 1;
                    return;
                }
            }

            let fileToInsertRelativePath: string | null = null;
            let allPotentialFiles: string[] = [];

            try {
                allPotentialFiles = findFilesRecursive(
                    actualLibraryDir,
                    actualLibraryDir,
                    (filePath) => (filePath.endsWith('.js') || filePath.endsWith('.css')) && !filePath.endsWith('.map')
                );

            } catch (readErr) {
                logError(`Error scanning library directory ${actualLibraryDir}: ${(readErr as Error).message}`);
                process.exitCode = 1;
                return;
            }

            if (allPotentialFiles.length === 0) {
                logError(`No suitable .js or .css files found recursively within ${actualLibraryDir}.`);
                process.exitCode = 1;
                return;
            }

            if (filename) {
                const normalizedFilename = filename.replace(/\\/g, '/');
                const targetFullPath = path.join(actualLibraryDir, normalizedFilename);

                if (fs.existsSync(targetFullPath) && fs.statSync(targetFullPath).isFile()) {
                    const foundInScan = allPotentialFiles.some(p => p === normalizedFilename);
                    if (foundInScan) {
                        fileToInsertRelativePath = normalizedFilename;
                        logInfo(`Using specified file: ${fileToInsertRelativePath}`);
                    } else {
                        logError(`Specified path "${filename}" exists but is not a recognized JS/CSS file (or is a .map file).`);
                        logInfo(`Available files:\n - ${allPotentialFiles.join('\n - ')}`);
                        process.exitCode = 1;
                        return;
                    }
                } else {
                    logError(`Specified file "${filename}" not found within ${actualLibraryDir}.`);
                    logInfo(`Available files (relative to ${actualLibraryName}):\n - ${allPotentialFiles.join('\n - ')}`);
                    process.exitCode = 1;
                    return;
                }
            } else {
                const rankedFiles = allPotentialFiles
                    .map(relativeFilePath => ({
                        file: relativeFilePath,
                        score: getFileScore(relativeFilePath, actualLibraryName),
                    }))
                    .sort((a, b) => b.score - a.score);

                if (rankedFiles.length > 0) {
                    fileToInsertRelativePath = rankedFiles[0].file;
                    logInfo(`No specific file requested, selecting best match recursively: ${fileToInsertRelativePath}`);
                } else {
                    logError(`Could not determine a best file to insert in ${actualLibraryDir}.`);
                    process.exitCode = 1;
                    return;
                }
            }

            if (!fileToInsertRelativePath) {
                logError("Internal error: Failed to determine file for insertion.");
                process.exitCode = 1;
                return;
            }

            let tagToInsert: string;
            const webPath = `/cdn_modules/${actualLibraryName}/${fileToInsertRelativePath.replace(/\\/g, '/')}`;
            const fileExt = path.extname(fileToInsertRelativePath).toLowerCase();

            if (fileExt === '.css') {
                tagToInsert = `<link rel="stylesheet" href="${webPath}">`;
            } else if (fileExt === '.js') {
                tagToInsert = `<script src="${webPath}" defer></script>`;
            } else {
                logError(`Unsupported file type for insertion: ${fileToInsertRelativePath}`);
                process.exitCode = 1;
                return;
            }

            logInfo(`Reading HTML file: ${htmlFile}`);
            const htmlContent = fs.readFileSync(htmlFile, 'utf-8');
            const $ = cheerio.load(htmlContent, {
                xmlMode: false
            });

            const targetElement = $(targetLocation);
            if (targetElement.length === 0) {
                logError(`Could not find <${targetLocation}> tag in ${htmlFile}. Ensure it's valid HTML.`);
                process.exitCode = 1;
                return;
            }

            const selector = fileExt === '.css' ? `link[href="${webPath}"]` : `script[src="${webPath}"]`;
            if ($(selector).length > 0) {
                logWarning(`Tag for "${webPath}" already exists in ${htmlFile}. No changes made.`);
                return;
            }

            logInfo(`Inserting tag into <${targetLocation}>...`);
            targetElement.append(`\n    ${tagToInsert}\n`);

            const rawHtmlOutput = $.html();
            let finalHtmlOutput = rawHtmlOutput;

            try {
                logInfo('Formatting HTML output using Prettier...');
                finalHtmlOutput = await prettier.format(rawHtmlOutput, {
                    parser: 'html',
                    endOfLine: 'lf',
                });
                if (!finalHtmlOutput.endsWith('\n')) {
                    finalHtmlOutput += '\n';
                }
            } catch (formatError) {
                logWarning(`Could not format HTML output using prettier: ${(formatError as Error).message}`);
                logWarning('Writing potentially unformatted HTML instead.');
                if (!finalHtmlOutput.endsWith('\n')) {
                    finalHtmlOutput += '\n';
                }
            }

            logInfo(`Writing changes back to ${htmlFile}`);
            fs.writeFileSync(htmlFile, finalHtmlOutput, 'utf-8');

            logSuccess(`Successfully inserted tag for ${fileToInsertRelativePath} into ${htmlFile}`);
            console.log(highlightHtmlTags(`Inserted: ${tagToInsert}`, ['link', 'script']));

            const commandEndTime = Date.now();
            const durationSeconds = ((commandEndTime - commandStartTime) / 1000).toFixed(1);
            logInfo(`Insert operation completed in ${durationSeconds}s`);


        } catch (error: any) {
            const commandEndTime = Date.now();
            const durationSeconds = ((commandEndTime - commandStartTime) / 1000).toFixed(1);
            logError(`Failed to insert tag: ${error.message}. Operation took ${durationSeconds}s`);
            if (error.stack && process.env.NODE_ENV !== 'production') {
                console.error(error.stack);
            }
            process.exitCode = 1;
        }
    });

program.parse(process.argv);