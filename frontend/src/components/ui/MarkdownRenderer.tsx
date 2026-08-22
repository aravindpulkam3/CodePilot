import React, { useState } from "react";
import { Copy, Check } from "lucide-react";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  className = "",
}) => {
  if (!content) return null;

  // Split content by code blocks ```lang ... ```
  const parts = content.split(/(```[\s\S]*?```)/g);

  return (
    <div className={`space-y-3 leading-relaxed text-sm ${className}`}>
      {parts.map((part, index) => {
        if (part.startsWith("```")) {
          return <CodeBlock key={index} rawBlock={part} />;
        }
        return <FormattedParagraphs key={index} text={part} />;
      })}
    </div>
  );
};

interface CodeBlockProps {
  rawBlock: string;
}

const CodeBlock: React.FC<CodeBlockProps> = ({ rawBlock }) => {
  const [copied, setCopied] = useState(false);

  // Extract language and code
  const match = rawBlock.match(/^```(\w+)?\n?([\s\S]*?)```$/);
  const language = match ? match[1] || "code" : "code";
  const code = match ? match[2].trimEnd() : rawBlock.replace(/^```|```$/g, "");

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-3 rounded-lg overflow-hidden border border-slate-700/60 bg-slate-950 shadow-md">
      {/* Code Header */}
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-slate-900/90 border-b border-slate-800 text-[11px] font-mono text-slate-400">
        <span className="font-semibold uppercase tracking-wider text-slate-300">
          {language}
        </span>
        <button
          onClick={handleCopy}
          type="button"
          className="flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors"
          title="Copy code"
        >
          {copied ? (
            <>
              <Check className="h-3.5 w-3.5 text-emerald-400" />
              <span className="text-emerald-400 font-sans">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="h-3.5 w-3.5" />
              <span className="font-sans">Copy</span>
            </>
          )}
        </button>
      </div>

      {/* Code Content */}
      <pre className="p-3.5 text-xs font-mono overflow-x-auto text-slate-100 leading-relaxed scrollbar-thin scrollbar-thumb-slate-700">
        <code>{code}</code>
      </pre>
    </div>
  );
};

interface FormattedParagraphsProps {
  text: string;
}

const FormattedParagraphs: React.FC<FormattedParagraphsProps> = ({ text }) => {
  if (!text.trim()) return null;

  const lines = text.split("\n");
  const renderedElements: React.ReactNode[] = [];
  let currentListItems: React.ReactNode[] = [];
  let isNumberedList = false;

  const flushList = () => {
    if (currentListItems.length > 0) {
      if (isNumberedList) {
        renderedElements.push(
          <ol key={`ol-${renderedElements.length}`} className="list-decimal pl-5 space-y-1 my-2">
            {currentListItems}
          </ol>
        );
      } else {
        renderedElements.push(
          <ul key={`ul-${renderedElements.length}`} className="list-disc pl-5 space-y-1 my-2">
            {currentListItems}
          </ul>
        );
      }
      currentListItems = [];
    }
  };

  lines.forEach((line, idx) => {
    const trimmed = line.trim();

    // Headings
    if (trimmed.startsWith("### ")) {
      flushList();
      renderedElements.push(
        <h4 key={idx} className="text-sm font-bold text-slate-100 mt-3 mb-1">
          {formatInline(trimmed.slice(4))}
        </h4>
      );
      return;
    }
    if (trimmed.startsWith("## ")) {
      flushList();
      renderedElements.push(
        <h3 key={idx} className="text-base font-bold text-slate-100 mt-4 mb-1.5">
          {formatInline(trimmed.slice(3))}
        </h3>
      );
      return;
    }
    if (trimmed.startsWith("# ")) {
      flushList();
      renderedElements.push(
        <h2 key={idx} className="text-lg font-bold text-slate-100 mt-4 mb-2">
          {formatInline(trimmed.slice(2))}
        </h2>
      );
      return;
    }

    // Bullet list
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      if (isNumberedList) flushList();
      isNumberedList = false;
      currentListItems.push(
        <li key={idx} className="text-slate-300">
          {formatInline(trimmed.slice(2))}
        </li>
      );
      return;
    }

    // Numbered list
    const numMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
    if (numMatch) {
      if (!isNumberedList && currentListItems.length > 0) flushList();
      isNumberedList = true;
      currentListItems.push(
        <li key={idx} className="text-slate-300">
          {formatInline(numMatch[2])}
        </li>
      );
      return;
    }

    // Blockquote
    if (trimmed.startsWith("> ")) {
      flushList();
      renderedElements.push(
        <blockquote
          key={idx}
          className="border-l-2 border-signal-500/80 pl-3 py-1 my-2 text-slate-300 bg-signal-500/5 rounded-r text-xs italic"
        >
          {formatInline(trimmed.slice(2))}
        </blockquote>
      );
      return;
    }

    // Regular line
    flushList();
    if (trimmed) {
      renderedElements.push(
        <p key={idx} className="my-1.5 text-slate-200">
          {formatInline(line)}
        </p>
      );
    }
  });

  flushList();

  return <>{renderedElements}</>;
};

// Helper for inline markdown: `code`, **bold**, *italic*
function formatInline(text: string): React.ReactNode {
  // Regex splitting inline code, bold, italic
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g);

  return parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      return (
        <code
          key={index}
          className="px-1.5 py-0.5 mx-0.5 rounded font-mono text-[12px] bg-slate-800 text-teal-300 border border-slate-700/80 font-medium"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 3) {
      return (
        <strong key={index} className="font-semibold text-slate-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <em key={index} className="italic text-slate-200">
          {part.slice(1, -1)}
        </em>
      );
    }
    return part;
  });
}
