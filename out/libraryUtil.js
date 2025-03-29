"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getInstalledLibraries = getInstalledLibraries;
exports.getFileScore = getFileScore;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
/**
 * Scans the `cdn_modules` directory and retrieves a list of installed libraries.
 * @param {function} callback - A callback function that receives the result or an error.
 * @param {Error|null} callback.err - An error object if an error occurs, otherwise `null`.
 * @param {string[]} [callback.folders] - An array of folder names representing installed libraries.
 */
function getInstalledLibraries(callback) {
    const directoryPath = path_1.default.join(__dirname, '..', 'cdn_modules');
    fs_1.default.readdir(directoryPath, (err, files) => {
        if (err) {
            callback(new Error('Unable to scan directory: ' + err));
            return;
        }
        const folders = [];
        let pending = files.length;
        if (!pending) {
            callback(null, []);
            return;
        }
        files.forEach(file => {
            const filePath = path_1.default.join(directoryPath, file);
            fs_1.default.stat(filePath, (err, stats) => {
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
function getFileScore(fileName, libraryName) {
    let score = 0;
    if (fileName.includes('.min.')) {
        score += 10;
    }
    if (fileName.endsWith('.js') || fileName.endsWith('.css')) {
        score += 5;
    }
    if (fileName === `${libraryName}.js` ||
        fileName === 'index.js' ||
        fileName === 'main.js') {
        score += 8;
    }
    if (fileName.includes('min') ||
        fileName.includes('small') ||
        fileName.includes('slim')) {
        score += 3;
    }
    return score;
}
