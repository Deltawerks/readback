// Windows PowerShell reads piped stdin in the console code page, not UTF-8, so
// anything outside ASCII arrives mangled: an accented user name in a path sends
// the receiver to a folder that does not exist. Escape it: JSON parsers,
// ConvertFrom-Json included, turn \uXXXX back into the same string.
export function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uFFFF]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
