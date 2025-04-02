import { promises as fs } from 'fs';
import _fs from 'fs';
import path from 'path';
import { logWarning } from './logging';
import axios, { AxiosError } from 'axios';
import https from 'https';

/**
 * Scans the `cdn_modules` directory asynchronously and retrieves a list of installed libraries (directories).
 * Uses fs.readdir with withFileTypes: true for significantly better performance by reducing I/O operations.
 * @returns {Promise<string[]>} A promise that resolves with an array of folder names.
 * @throws {Error} Throws an error if the directory cannot be scanned.
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
            console.warn(`Directory not found: ${directoryPath}. Returning empty list.`);
        }
        throw new Error(`Unable to scan directory '${directoryPath}': ${err.message}`);
    }
}

/**
 * Scans the `cdn_modules` directory and retrieves a list of installed libraries.
 * This maintains the original callback interface by wrapping the async function.
 * @param {function} callback - A callback function that receives the result or an error.
 * @param {Error|null} callback.err - An error object if an error occurs, otherwise `null`.
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
 * Calculates a score for a file based on its name and the library it belongs to.
 * The score is determined by specific criteria such as file type, naming conventions, and optimizations.
 * (This function is generally fast; optimization focused on getInstalledLibraries)
 * @param fileName - The name of the file to score.
 * @param libraryName - The name of the library the file belongs to.
 * @returns The calculated score for the file.
 */
export function getFileScore(fileName: string, libraryName: string): number {
    let score = 0;

    if (fileName.indexOf('.min.') !== -1) {
        score += 10;
    }

    if (fileName.endsWith('.js') || fileName.endsWith('.css')) {
        score += 5;
    }

    if (
        fileName === `${libraryName}.js` ||
        fileName === 'index.js' ||
        fileName === 'main.js'
    ) {
        score += 8;
    }

    if (
        fileName.includes('min') ||
        fileName.includes('small') ||
        fileName.includes('slim')
    ) {
        score += 3;
    }

    return score;
}

/**
 * Recursively searches for files in a directory that match a given filter.
 * 
 * @param dirPath - The directory path to start searching from
 * @param baseDir - The base directory used to calculate relative paths
 * @param fileFilter - Callback function to determine if a file should be included
 * @param arrayOfFiles - Accumulator array for found file paths (used internally for recursion)
 * @returns Array of relative file paths (using forward slashes) that match the filter
 */
export function findFilesRecursive(
    dirPath: string,
    baseDir: string,
    fileFilter: (filePath: string) => boolean,
    arrayOfFiles: string[] = []): string[] {
    try {
        const files = _fs.readdirSync(dirPath, { withFileTypes: true });

        files.forEach(file => {
            const fullPath = path.join(dirPath, file.name);
            const relativePath = path.relative(baseDir, fullPath);

            if (file.isDirectory()) {
                findFilesRecursive(fullPath, baseDir, fileFilter, arrayOfFiles);
            } else if (file.isFile() && fileFilter(relativePath)) {
                arrayOfFiles.push(relativePath.split(path.sep).join('/'));
            }
        });
    } catch (error: any) {
        logWarning(`Could not read directory ${dirPath}: ${error.message}`);
    }
    return arrayOfFiles;
}

const downloadAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 5000
});

/**
 * Downloads a file from a URL with retry logic for transient failures.
 * 
 * @param url - The URL to download from
 * @param filePath - Local path where the file should be saved
 * @param options - Configuration options including verbose logging
 * @param maxRetries - Maximum number of retry attempts (default: 2)
 * @param initialDelay - Initial delay between retries in ms (default: 1500, doubles each retry)
 * @returns Promise that resolves with download success information
 * @throws Error when download fails after all retries or for non-retryable errors
 */
export async function downloadWithRetry(
    url: string,
    filePath: string,
    options: { verbose?: boolean },
    maxRetries: number = 2,
    initialDelay: number = 1500
): Promise<{ status: 'fulfilled'; path: string; url: string }> {
    let attempts = 0;
    let delay = initialDelay;

    while (attempts <= maxRetries) {
        try {
            const linkResponse = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 60000,
                httpsAgent: downloadAgent,
            });
            const linkData = linkResponse.data;
            await fs.writeFile(filePath, linkData);
            return { status: 'fulfilled', path: filePath, url: url };
        } catch (error) {
            attempts++;
            const isRetryable = (err: unknown): boolean => {
                if (axios.isAxiosError(err)) {
                    return (
                        err.code === 'ETIMEDOUT' ||
                        err.code === 'ECONNABORTED' ||
                        err.code === 'ECONNRESET' ||
                        (err.response?.status !== undefined && err.response.status >= 500)
                    );
                }
                if (error instanceof Error && typeof (error as any).code === 'string') {
                    const code = (error as any).code;
                    return code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'EPIPE';
                }
                return false;
            };

            if (isRetryable(error) && attempts <= maxRetries) {
                const errorCode = axios.isAxiosError(error) ? error.code : (error as any)?.code || 'UNKNOWN';
                if (options.verbose) {
                    logWarning(`[Retry ${attempts}/${maxRetries}] Failed to download ${path.basename(filePath)} (${errorCode}). Retrying in ${delay / 1000}s...`);
                }
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2;
            } else {
                let errorMessage = `Failed task for ${path.basename(filePath)} saving to ${filePath} from ${url}`;
                 if (axios.isAxiosError(error)) {
                    errorMessage += `: AxiosError: ${error.code || 'N/A'}`;
                    if (error.response) {
                        errorMessage += ` - Status: ${error.response.status} ${error.response.statusText}`;
                    } else if (error.request) {
                        errorMessage += ` - No response received (Code: ${error.code})`;
                    } else {
                        errorMessage += ` - ${error.message}`;
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
                if (attempts > 1) errorMessage += ` (failed after ${attempts - 1} retries)`;

                throw new Error(errorMessage);
            }
        }
    }
    throw new Error(`Download failed for ${url} after ${maxRetries} retries.`);
}