"use client";

// SPDX-License-Identifier: Apache-2.0

import { useMemo, useRef, useState } from "react";
import CodeMirror, { EditorView, type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorSelection } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { Icon } from "@/components/icons";

/** Wrap the selection in `before`/`after` markers (bold, italic, code span).
 * With no selection, inserts empty markers and drops the cursor between them. */
function wrapSelection(view: EditorView, before: string, after: string) {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    const insert = `${before}${selected}${after}`;
    return {
      changes: { from: range.from, to: range.to, insert },
      range: selected
        ? EditorSelection.range(range.from + before.length, range.from + before.length + selected.length)
        : EditorSelection.range(range.from + before.length, range.from + before.length),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  view.focus();
}

/** Prefix each line touched by the selection with `prefix` (heading, bullet, numbered list). */
function prefixLines(view: EditorView, prefix: string) {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const startLine = state.doc.lineAt(range.from);
    const endLine = state.doc.lineAt(range.to);
    const lineChanges = [];
    for (let n = startLine.number; n <= endLine.number; n++) {
      lineChanges.push({ from: state.doc.line(n).from, insert: prefix });
    }
    return {
      changes: lineChanges,
      range: EditorSelection.range(range.from + prefix.length, range.to + prefix.length * (endLine.number - startLine.number + 1)),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  view.focus();
}

/** Insert a fenced code block; wraps the selection as the block body if there is one. */
function insertCodeBlock(view: EditorView) {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const selected = state.sliceDoc(range.from, range.to);
    const insert = selected ? `\`\`\`\n${selected}\n\`\`\`` : "```\n\n```";
    return {
      changes: { from: range.from, to: range.to, insert },
      range: EditorSelection.cursor(range.from + (selected ? 4 + selected.length + 1 : 4)),
    };
  });
  view.dispatch(state.update(changes, { scrollIntoView: true, userEvent: "input" }));
  view.focus();
}

const TOOLBAR_ACTIONS: { label: string; icon: "bold" | "italic" | "heading" | "list" | "code"; apply: (view: EditorView) => void }[] = [
  { label: "Bold", icon: "bold", apply: (v) => wrapSelection(v, "**", "**") },
  { label: "Italic", icon: "italic", apply: (v) => wrapSelection(v, "*", "*") },
  { label: "Heading", icon: "heading", apply: (v) => prefixLines(v, "## ") },
  { label: "List", icon: "list", apply: (v) => prefixLines(v, "- ") },
  { label: "Code block", icon: "code", apply: (v) => insertCodeBlock(v) },
];

const editorTheme = EditorView.theme(
  {
    "&": {
      color: "var(--color-dark-text)",
      backgroundColor: "var(--color-dark)",
      fontSize: "12px",
    },
    ".cm-content": {
      caretColor: "var(--color-lime)",
      fontFamily: "var(--font-mono, monospace)",
      padding: "10px 12px",
    },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-lime)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "var(--color-dark-hover)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--color-dark)",
      color: "var(--color-dark-dim)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "var(--color-dark-track)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--color-dark-track)" },
    ".cm-scroller": { overflow: "auto" },
    "&.cm-editor.cm-focused": { outline: "none" },
  },
  { dark: true }
);

/**
 * Plain-text system-prompt editor (not WYSIWYG — the value is sent to the LLM
 * verbatim, so no HTML markup can leak in). Markdown syntax highlighting +
 * line numbers + a fullscreen toggle make long, structured prompts easier to
 * edit than a bare `<textarea>`, without changing what gets persisted.
 */
export function PromptEditor({
  value,
  onChange,
  minHeight = "180px",
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  minHeight?: string;
  placeholder?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const extensions = useMemo(() => [markdown(), editorTheme, EditorView.lineWrapping], []);
  const cmRef = useRef<ReactCodeMirrorRef>(null);

  const lines = value ? value.split("\n").length : 0;
  const chars = value.length;

  const toolbar = (
    <div className="flex items-center gap-0.5 border-b border-dark-line bg-dark-deep px-1.5 py-1">
      {TOOLBAR_ACTIONS.map((action) => (
        <button
          key={action.label}
          type="button"
          title={action.label}
          aria-label={action.label}
          onMouseDown={(e) => {
            // Prevent the button from stealing focus away from the editor
            // before we read its current selection.
            e.preventDefault();
            const view = cmRef.current?.view;
            if (view) action.apply(view);
          }}
          className="rounded-md p-2.5 text-dark-soft transition-colors hover:bg-dark-hover/30 hover:text-dark-text sm:p-1.5"
        >
          <Icon name={action.icon} size={13} strokeWidth={2} />
        </button>
      ))}
    </div>
  );

  const editor = (
    <div className={`overflow-hidden rounded-lg border border-dark-line ${expanded ? "flex flex-1 flex-col" : ""}`}>
      {toolbar}
      <CodeMirror
        ref={cmRef}
        value={value}
        onChange={onChange}
        extensions={extensions}
        theme="dark"
        placeholder={placeholder}
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true }}
        height={expanded ? "100%" : undefined}
        minHeight={expanded ? undefined : minHeight}
        className={expanded ? "flex-1 overflow-auto" : ""}
      />
    </div>
  );

  if (!expanded) {
    return (
      <div className="space-y-1.5">
        {editor}
        <div className="flex items-center justify-between font-mono text-[10px] text-dark-dim">
          <span>{lines} lines · {chars} chars</span>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="inline-flex min-h-9 items-center gap-1 px-2 text-dark-soft transition-colors hover:text-dark-text sm:min-h-0 sm:px-0"
          >
            <Icon name="maximize" size={11} strokeWidth={2} />
            expand
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex h-[100dvh] flex-col gap-2 bg-dark p-3 sm:p-6">
      <div className="flex items-center justify-between font-mono text-[11px] text-dark-soft">
        <span>{lines} lines · {chars} chars</span>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="inline-flex min-h-9 items-center gap-1 px-2 text-dark-soft transition-colors hover:text-dark-text sm:min-h-0 sm:px-0"
        >
          <Icon name="minimize" size={12} strokeWidth={2} />
          collapse
        </button>
      </div>
      {editor}
    </div>
  );
}
