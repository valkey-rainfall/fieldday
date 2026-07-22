/* Entry point for the vendored CodeMirror bundle (docs/vendor/codemirror.js).
 * Regenerate with: npm run build:editor
 * The bundle is committed so the site stays a static page with no build
 * step for contributors and no CDN dependency at runtime. */

export { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
export { EditorState, Compartment } from "@codemirror/state";
export { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
export { indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
export { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
export { cpp } from "@codemirror/lang-cpp";
export { json } from "@codemirror/lang-json";
