import { promises as fs } from 'fs';
import _fs from 'fs';
import path from 'path';
import { logWarning, logError } from './logging';
import axios, { AxiosError } from 'axios';
import https from 'https';

/**
 * Scans the `cdn_modules` directory asynchronously and retrieves a list of installed libraries (directories).
 * Uses fs.readdir with withFileTypes: true for significantly better performance by reducing I/O operations.
 * @returns {Promise<string[]>} A promise that resolves with an array of folder names.
 * @throws {Error} Throws an error if the directory cannot be scanned (will be caught by the callback wrapper).
 */
async function getInstalledLibrariesAsync(): Promise<string[]> {
    const directoryPath = path.resolve(process.cwd(), 'cdn_modules');

    try {
        const dirents = await fs.readdir(directoryPath, { withFileTypes: true });

        const folders = dirents
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);

        return folders;
    } catch (err: any) {
        if (err.code === 'ENOENT') {
            return [];
        }
        throw new Error(`Unable to scan directory '${directoryPath}': ${err.message}`);
    }
}

/**
 * Scans the `cdn_modules` directory and retrieves a list of installed libraries.
 * This maintains the original callback interface by wrapping the async function.
 * @param {function} callback - A callback function that receives the result or an error.
 * @param {Error|null} callback.err - An error object if an error occurs (except ENOENT), otherwise `null`.
 * @param {string[]} [callback.folders] - An array of folder names representing installed libraries.
 */
export function getInstalledLibraries(callback: (err: Error | null, folders?: string[]) => void): void {
    getInstalledLibrariesAsync()
        .then(folders => {
            process.nextTick(() => callback(null, folders));
        })
        .catch(err => {
            process.nextTick(() => callback(err));
        });
}


/**
 * Calculates a score for a file based on its path relative to the library root.
 * Higher scores indicate more likely primary files.
 *
 * @param relativeFilePath - The path of the file relative to the library root (e.g., "dist/library.min.js" or "library.js").
 * @param libraryName - The name of the library.
 * @returns The calculated score for the file.
 */
export function getFileScore(relativeFilePath: string, libraryName: string): number {
    let score = 0;
    const lowerFileName = path.basename(relativeFilePath).toLowerCase();
    const lowerRelativePath = relativeFilePath.toLowerCase().replace(/\\/g, '/');
    const lowerLibraryName = libraryName.toLowerCase();

    if (lowerRelativePath.includes('/src/') || lowerRelativePath.startsWith('src/')) score -= 20;
    if (lowerRelativePath.includes('/test/') || lowerRelativePath.includes('/spec/') || lowerRelativePath.includes('/demo/')) score -= 15;
    if (lowerRelativePath.includes('/docs/') || lowerRelativePath.startsWith('docs/')) score -= 10;
    if (lowerRelativePath.includes('/example') || lowerRelativePath.includes('/sample')) score -= 10;
    if (lowerFileName.endsWith('.esm.js') || lowerFileName.endsWith('.mjs')) score -= 5;
    if (lowerFileName.endsWith('.bundle.js') || lowerFileName.includes('bundle.')) score -= 2;

    if (lowerFileName === `${lowerLibraryName}.min.js` || lowerFileName === `index.min.js` || lowerFileName === `main.min.js`) {
        if (!lowerRelativePath.includes('/')) score += 50;
        else if (lowerRelativePath.startsWith('dist/') || lowerRelativePath.startsWith('build/') || lowerRelativePath.startsWith('lib/')) score += 45;
        else score += 30;
    }
    else if (lowerFileName === `${lowerLibraryName}.js` || lowerFileName === `index.js` || lowerFileName === `main.js`) {
        if (!lowerRelativePath.includes('/')) score += 40;
        else if (lowerRelativePath.startsWith('dist/') || lowerRelativePath.startsWith('build/') || lowerRelativePath.startsWith('lib/')) score += 35;
        else score += 25;
    }

    if (lowerFileName.includes('.min.')) {
        score += 10;
    }

    if (lowerRelativePath.startsWith('dist/') || lowerRelativePath.startsWith('build/') || lowerRelativePath.startsWith('lib/')) {
        score += 8;
    }
    if (lowerFileName.endsWith('.js') || lowerFileName.endsWith('.css')) {
        score += 5;
    }
    if (lowerFileName.includes('core') && (lowerFileName.endsWith('.js') || lowerFileName.endsWith('.css'))) score += 3;
    if (lowerFileName.includes('all') && lowerFileName.endsWith('.css')) score += 3;

    return Math.max(0, score);
}


/**
 * Recursively searches for files in a directory that match a given filter.
 * Uses synchronous fs calls for simplicity in this CLI context, but could be async if needed.
 *
 * @param dirPath - The absolute directory path to start searching from.
 * @param baseDir - The absolute base directory used to calculate relative paths.
 * @param fileFilter - Callback function to determine if a file should be included based on its relative path.
 * @param arrayOfFiles - Accumulator array for found file paths (used internally for recursion).
 * @returns Array of relative file paths (using forward slashes) that match the filter.
 * @throws Error if the initial dirPath cannot be read.
 */
export function findFilesRecursive(
    dirPath: string,
    baseDir: string,
    fileFilter: (relativeFilePath: string) => boolean,
    arrayOfFiles: string[] = []): string[] {
    let files: _fs.Dirent[];
    try {
        files = _fs.readdirSync(dirPath, { withFileTypes: true });
    } catch (error: any) {
        if (dirPath !== baseDir) {
            logError(`Could not read directory ${dirPath}: ${error.message}`);
        } else {
            throw new Error(`Failed to read initial directory ${dirPath}: ${error.message}`);
        }
        return arrayOfFiles;
    }

    files.forEach(file => {
        const fullPath = path.join(dirPath, file.name);
        const relativePath = path.relative(baseDir, fullPath).split(path.sep).join('/');

        if (file.isDirectory()) {
            findFilesRecursive(fullPath, baseDir, fileFilter, arrayOfFiles);
        } else if (file.isFile() && fileFilter(relativePath)) {
            arrayOfFiles.push(relativePath);
        }
    });

    return arrayOfFiles;
}

const downloadAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 5000
});

/**
 * Downloads a file from a URL with retry logic for transient network failures.
 *
 * @param url - The URL to download from.
 * @param filePath - The local absolute path where the file should be saved.
 * @param options - Configuration options including verbose logging.
 * @param maxRetries - Maximum number of retry attempts (default: 2).
 * @param initialDelay - Initial delay between retries in ms (default: 1500, doubles each retry).
 * @returns A promise that resolves with download success information including file size.
 * @throws An error when download fails after all retries or for non-retryable errors.
 */
export async function downloadWithRetry(
    url: string,
    filePath: string,
    options: { verbose?: boolean },
    maxRetries: number = 2,
    initialDelay: number = 1500
): Promise<{ status: 'fulfilled'; path: string; url: string; size: number }> {
    let attempts = 0;
    let delay = initialDelay;

    while (attempts <= maxRetries) {
        try {
            const linkResponse = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 60000,
                httpsAgent: downloadAgent
            });

            if (!linkResponse.data || linkResponse.data.byteLength === 0) {
                throw new Error(`Received empty response from ${url}`);
            }

            const linkData = Buffer.from(linkResponse.data);
            const size = linkData.byteLength;

            await fs.writeFile(filePath, linkData);

            return { status: 'fulfilled', path: filePath, url: url, size: size };

        } catch (error) {
            attempts++;
            const isRetryable = (err: unknown): boolean => {
                if (axios.isAxiosError(err)) {
                    return (
                        err.code === 'ETIMEDOUT' ||
                        err.code === 'ECONNABORTED' ||
                        err.code === 'ECONNRESET' ||
                        err.code === 'EPIPE' ||
                        (err.response?.status !== undefined && err.response.status >= 500)
                    );
                }
                if (error instanceof Error && typeof (error as any).code === 'string') {
                    const code = (error as any).code;
                    return code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED';
                }
                if (error instanceof Error && error.message.includes('Received empty response')) {
                    return true;
                }

                return false;
            };

            if (isRetryable(error) && attempts <= maxRetries) {
                const errorCode = axios.isAxiosError(error) ? (error.code ?? `Status ${error.response?.status}`) : ((error as any)?.code || 'UNKNOWN');
                const retryMsg = `[Retry ${attempts}/${maxRetries}] Failed download for ${path.basename(filePath)} (${errorCode}). Retrying in ${delay / 1000}s...`;
                if (options.verbose) {
                    logWarning(retryMsg);
                }
                else if (attempts === 1) {
                    console.log(`Download attempt failed for ${path.basename(filePath)}, retrying...`);
                }

                await new Promise(resolve => setTimeout(resolve, delay));
                delay = Math.min(delay * 2, 10000);
            } else {
                let errorMessage = `Failed task for ${path.basename(filePath)} saving to ${filePath} from ${url}`;
                if (axios.isAxiosError(error)) {
                    errorMessage += `: AxiosError: ${error.code || 'N/A'}`;
                    if (error.response) {
                        errorMessage += ` - Status: ${error.response.status} ${error.response.statusText}`;
                    } else if (error.request) {
                        errorMessage += ` - No response received (Code: ${error.code})`;
                    }
                    if (error.message && !errorMessage.includes(error.message)) {
                        errorMessage += ` (${error.message})`;
                    }
                } else if (error instanceof Error) {
                    if ('code' in error && typeof error.code === 'string') {
                        errorMessage += `: ${(error as NodeJS.ErrnoException).code} - ${error.message}`;
                    } else {
                        errorMessage += `: ${error.message}`;
                    }
                } else {
                    errorMessage += `: Unknown error occurred.`;
                }
                if (attempts > 1) errorMessage += ` (failed after ${attempts - 1} ${attempts > 2 ? 'retries' : 'retry'})`;

                throw new Error(errorMessage);
            }
        }
    }

    throw new Error(`Download failed for ${url} after ${maxRetries} retries.`);
}