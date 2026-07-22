/* Thin wrapper around the vendored CodeMirror bundle: creates a configured
 * editor pane with language support, auto-indent, bracket closing, and a
 * toggleable read-only state. */

import {
  EditorView, EditorState, Compartment, keymap, lineNumbers,
  highlightActiveLine, defaultKeymap, history, historyKeymap, indentWithTab,
  indentOnInput, bracketMatching, syntaxHighlighting, defaultHighlightStyle,
  closeBrackets, closeBracketsKeymap, cpp, json,
} from "./vendor/codemirror.js";

const LANGS = { c: cpp, json };

export function makeEditor({ parent, lang, doc = "", readOnly = false, onChange }) {
  const roCompartment = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        highlightActiveLine(),
        syntaxHighlighting(defaultHighlightStyle),
        LANGS[lang](),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        roCompartment.of(EditorState.readOnly.of(readOnly)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && onChange) onChange();
        }),
      ],
    }),
  });
  return {
    view,
    get: () => view.state.doc.toString(),
    set: (text) => view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    }),
    setReadOnly: (ro) => {
      view.dispatch({ effects: roCompartment.reconfigure(EditorState.readOnly.of(ro)) });
      view.dom.classList.toggle("editor-readonly", ro);
    },
  };
}
