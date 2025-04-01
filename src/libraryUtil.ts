import { promises as fs } from 'fs';
import _fs from 'fs';
import path from 'path';
import { logWarning } from './logging';

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