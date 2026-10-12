import { applyEdits, findNodeAtLocation, format, getNodeValue, modify, parseTree, printParseErrorCode } from 'jsonc-parser';
import type { FormattingOptions, JSONPath, Node, ParseError } from 'jsonc-parser';
import { isDeepStrictEqual } from 'node:util';
import { OverseerError } from '../core/errors.js';

/** Parses a JSON/JSONC config; throws CONFIG_PARSE unless the root is an object. */
function parseRoot(text: string, file: string): Node | undefined {
  if (text.trim() === '') return undefined;
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new OverseerError('CONFIG_PARSE', `${file}: ${printParseErrorCode(first.error)} at offset ${first.offset}`);
  }
  if (!root || root.type !== 'object') throw new OverseerError('CONFIG_PARSE', `${file}: top-level value is not an object`);
  return root;
}

function formatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /^([ \t]+)["/]/m.exec(text)?.[1];
  if (indent?.startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent ? indent.length : 2, eol };
}

/** Value at `keyPath`, or undefined when absent. Throws CONFIG_PARSE on malformed text. */
export function getJsonValue(text: string | undefined, keyPath: JSONPath, file: string): unknown {
  if (text === undefined) return undefined;
  const root = parseRoot(text, file);
  if (!root) return undefined;
  const node = findNodeAtLocation(root, keyPath);
  return node ? getNodeValue(node) : undefined;
}

/**
 * Returns the config text with `keyPath` set to `value`, preserving comments and formatting.
 * `schema` is written as `$schema` only when the file is created (`text` undefined or blank).
 * Returns `text` unchanged when the stored value already deep-equals `value`.
 */
export function setJsonValue(
  text: string | undefined,
  keyPath: JSONPath,
  value: unknown,
  file: string,
  schema?: string,
): string {
  const creating = text === undefined || text.trim() === '';
  if (!creating && isDeepStrictEqual(getJsonValue(text, keyPath, file), value)) return text;
  if (creating) {
    const options = formatting('');
    let out = '{}';
    if (schema) out = applyEdits(out, modify(out, ['$schema'], schema, {}));
    out = applyEdits(out, modify(out, keyPath, value, {}));
    return `${applyEdits(out, format(out, undefined, options))}\n`;
  }
  parseRoot(text, file);
  // Format only the inserted span: jsonc-parser's built-in formatting reflows the whole surrounding lines.
  const [edit] = modify(text, keyPath, value, {});
  if (!edit) return text;
  const out = applyEdits(text, [edit]);
  // Include the surrounding whitespace and an adjacent bracket so gaps inside a formerly empty container get line breaks.
  let start = edit.offset;
  let end = edit.offset + edit.content.length;
  while (start > 0 && /\s/.test(out[start - 1]!)) start--;
  if (start > 0 && '{['.includes(out[start - 1]!)) start--;
  while (end < out.length && /\s/.test(out[end]!)) end++;
  if (end < out.length && '}]'.includes(out[end]!)) end++;
  return applyEdits(out, format(out, { offset: start, length: end - start }, { ...formatting(text), keepLines: false }));
}

/**
 * Removes each present key path, then prunes containers along those paths that became empty.
 * `empty` is true when nothing but `$schema` remains (the caller may delete the file).
 */
export function removeJsonValues(
  text: string,
  keyPaths: JSONPath[],
  file: string,
): { text: string; changed: boolean; empty: boolean } {
  let out = text;
  let changed = false;
  // Unformatted removal deletes exactly the property (and its separator), restoring the pre-install text.
  for (const keyPath of keyPaths) {
    const root = parseRoot(out, file);
    if (!root || !findNodeAtLocation(root, keyPath)) continue;
    out = applyEdits(out, modify(out, keyPath, undefined, {}));
    changed = true;
    for (let depth = keyPath.length - 1; depth > 0; depth--) {
      const parentPath = keyPath.slice(0, depth);
      const parent = findNodeAtLocation(parseRoot(out, file)!, parentPath);
      if (!parent || parent.type !== 'object' || (parent.children?.length ?? 0) > 0) break;
      out = applyEdits(out, modify(out, parentPath, undefined, {}));
    }
  }
  const root = parseRoot(out, file);
  const keys = (root?.children ?? []).map((prop) => prop.children?.[0]?.value as string);
  return { text: out, changed, empty: keys.every((key) => key === '$schema') };
}
