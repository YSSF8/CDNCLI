const Colors = {
    Reset: "\x1b[0m",
    Bright: "\x1b[1m",
    FgRed: "\x1b[31m",
    FgGreen: "\x1b[32m",
    FgYellow: "\x1b[33m",
    FgBlue: "\x1b[34m",
    FgMagenta: "\x1b[35m",
    FgCyan: "\x1b[36m",
    FgWhite: "\x1b[37m",
} as const;

const DELIMITER_COLOR = Colors.FgBlue;
const TAG_NAME_COLOR = Colors.FgMagenta;
const ATTR_NAME_COLOR = Colors.FgGreen;
const ATTR_VALUE_COLOR = Colors.FgYellow;
const RESET_COLOR = Colors.Reset;

/**
 * Escapes characters that have special meaning in regular expressions.
 * @param string - The string to escape.
 * @returns The string with regex special characters escaped.
 */
function escapeRegExp(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Highlights specified HTML tags (like <script> and <link>) within a string
 * using ANSI color codes. Handles attributes and self-closing tags.
 *
 * @param htmlString - The HTML string containing tags to highlight.
 * @param tagsToHighlight - An array of tag names (lowercase) to highlight, e.g., ['script', 'link'].
 * @returns The HTML string with specified tags highlighted.
 */
export function highlightHtmlTags(htmlString: string, tagsToHighlight: string[]): string {
    if (!tagsToHighlight || tagsToHighlight.length === 0) {
        return htmlString;
    }

    const tagNamesPattern = tagsToHighlight.map(tag => escapeRegExp(tag)).join('|');

    const tagRegex = new RegExp(
        `<(/?)(${tagNamesPattern})([^>]*)(\\/?)>`,
        'gi'
    );

    const attributeRegex = /\s+([^=>\s/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^'"\s/>]+)))?|\s+([^=>\s/]+)/g;

    return htmlString.replace(
        tagRegex,
        (
            _fullMatch: string,
            closingSlash: string | undefined,
            tagName: string,
            attributesString: string,
            selfClosingSlash: string | undefined
        ): string => {
            const highlightedTagName = `${TAG_NAME_COLOR}${tagName}${RESET_COLOR}`;
            const openingDelimiter = `${DELIMITER_COLOR}${closingSlash ? '</' : '<'}${RESET_COLOR}`;
            const closingDelimiter = `${DELIMITER_COLOR}${selfClosingSlash ? '/>' : '>'}${RESET_COLOR}`;

            let highlightedAttributes = '';
            let lastIndex = 0;
            let match;
            attributeRegex.lastIndex = 0;

            while ((match = attributeRegex.exec(attributesString)) !== null) {
                const fullAttributeMatchText = match[0];

                const attrNameWithValue = match[1];
                const valDouble = match[2];
                const valSingle = match[3];
                const valUnquoted = match[4];
                const booleanAttrName = match[5];

                let highlightedAttrSegment = '';

                if (attrNameWithValue) {
                    const highlightedAttrName = `${ATTR_NAME_COLOR}${attrNameWithValue}${RESET_COLOR}`;
                    if (valDouble !== undefined || valSingle !== undefined || valUnquoted !== undefined) {
                        const value = valDouble ?? valSingle ?? valUnquoted ?? '';
                        const quote = (valDouble !== undefined) ? '"' : (valSingle !== undefined) ? "'" : '';
                        highlightedAttrSegment = ` ${highlightedAttrName}${DELIMITER_COLOR}=${RESET_COLOR}${ATTR_VALUE_COLOR}${quote}${value}${quote}${RESET_COLOR}`;
                    } else {
                        highlightedAttrSegment = ` ${highlightedAttrName}`;
                    }
                } else if (booleanAttrName) {
                    highlightedAttrSegment = ` ${ATTR_NAME_COLOR}${booleanAttrName}${RESET_COLOR}`;
                }

                const nameToSearch = attrNameWithValue || booleanAttrName;
                const nameStartIndex = nameToSearch ? fullAttributeMatchText.indexOf(nameToSearch) : -1;

                if (nameStartIndex !== -1) {
                    const leadingWhitespace = fullAttributeMatchText.substring(0, nameStartIndex);
                    highlightedAttributes += leadingWhitespace + highlightedAttrSegment.trimStart();
                } else {

                    highlightedAttributes += fullAttributeMatchText;
                }

                lastIndex = attributeRegex.lastIndex;
            }

            highlightedAttributes += attributesString.substring(lastIndex);

            return `${openingDelimiter}${highlightedTagName}${highlightedAttributes.trimEnd()}${closingDelimiter}`;
        }
    );
}