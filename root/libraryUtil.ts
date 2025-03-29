import fs from 'fs';
import path from 'path';

/**
 * Scans the `cdn_modules` directory and retrieves a list of installed libraries.
 * @param {function} callback - A callback function that receives the result or an error.
 * @param {Error|null} callback.err - An error object if an error occurs, otherwise `null`.
 * @param {string[]} [callback.folders] - An array of folder names representing installed libraries.
 */
export function getInstalledLibraries(callback: (err: Error | null, folders?: string[]) => void) {
    const directoryPath = path.join(__dirname, '..', 'cdn_modules');

    fs.readdir(directoryPath, (err, files) => {
        if (err) {
            callback(new Error('Unable to scan directory: ' + err));
            return;
        }

        const folders: string[] = [];
        let pending = files.length;

        if (!pending) {
            callback(null, []);
            return;
        }

        files.forEach(file => {
            const filePath = path.join(directoryPath, file);
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    callback(new Error('Unable to stat file: ' + err));
                    return;
                }

                if (stats.isDirectory()) {
                    folders.push(file);
                }

                pending--;
                if (!pending) {
                    callback(null, folders);
                }
            });
        });
    });
}

/**
 * Calculates a score for a file based on its name and the library it belongs to.
 * The score is determined by specific criteria such as file type, naming conventions, and optimizations.
 * @param fileName - The name of the file to score.
 * @param libraryName - The name of the library the file belongs to.
 * @returns The calculated score for the file.
 */
export function getFileScore(fileName: string, libraryName: string): number {
    let score = 0;

    if (fileName.includes('.min.')) {
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