const Colors = {
    Reset: "\x1b[0m",
    FgRed: "\x1b[31m",
    FgGreen: "\x1b[32m",
    FgYellow: "\x1b[33m",
    FgBlue: "\x1b[34m",
    FgMagenta: "\x1b[35m",
    FgCyan: "\x1b[36m",
    FgWhite: "\x1b[37m",
};

/**
 * Highlights HTML syntax in a script tag.
 * @param scriptTag - The script tag to highlight.
 * @returns The highlighted script tag as a string.
 */
export function highlightScriptTag(scriptTag: string): string {
    const tagRegex = /(<script\s*)([^>]*)(>.*?<\/script>)/;

    const match = scriptTag.match(tagRegex);

    if (!match) {
        return scriptTag;
    }

    const [, openingTag, attributes, closingTag] = match;

    const highlightedOpeningTag = `${Colors.FgBlue}${openingTag}${Colors.Reset}`;

    const highlightedAttributes = attributes.replace(
        /(\S+)=("([^"]*)"|'([^']*)')|(\S+)/g,
        (_, keyWithValue, __, value1, value2, booleanAttr) => {
            if (keyWithValue) {
                const value = value1 || value2;
                return `${Colors.FgGreen}${keyWithValue}=${Colors.FgYellow}"${value}"${Colors.Reset}`;
            } else if (booleanAttr) {
                return `${Colors.FgGreen}${booleanAttr}${Colors.Reset}`;
            }
            return _;
        }
    );

    const highlightedClosingTag = `${Colors.FgBlue}${closingTag}${Colors.Reset}`;

    return `${highlightedOpeningTag}${highlightedAttributes}${highlightedClosingTag}`;
}