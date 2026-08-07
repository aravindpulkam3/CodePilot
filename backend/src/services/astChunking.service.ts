import { Parser, Language, Query } from "web-tree-sitter";
import crypto from "crypto";
import path from "path";
import fs from "fs";
// import { FileASTMetadata } from "../types/summaryTypes.js";

export interface ChunkMetadata {
  file_path: string;
  language: string;
  symbol_type: string;
  symbol_name: string;
  start_line: number;
  end_line: number;
  content: string;
  content_hash: string;
  qualified_name?: string; // e.g. "UserService.createUser" for a method
  parent_symbol?: string; // enclosing class/interface/struct name, if any
  is_exported?: boolean; // true if wrapped in an export/export default
  docstring?: string | null; // leading comment / JSDoc / decorator / docstring
  chunk_index?: number; // set when a symbol was too large and got split
  chunk_total?: number; // total number of parts for a split symbol
}

export interface FileASTMetadata {
  filePath: string;
  folderPath: string;
  language: string;
  imports: string[];
  exports: string[];
  classes: string[];
  interfaces: string[];
  functions: string[];
  decorators: string[];
  annotations: string[];
  inheritance: { child: string; parents: string[] }[];
  sourceHash: string;
}

interface LangConfig {
  name: string;
  wasmPath: string;
  query: string;
}

const LANGUAGE_REGISTRY: Record<string, LangConfig> = {
  ".ts": {
    name: "TypeScript",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-typescript.wasm"),
    query: `
      (function_declaration) @function
      (method_definition) @method
      (class_declaration) @class
      (interface_declaration) @interface
      (enum_declaration) @enum
      (type_alias_declaration) @type
      (variable_declarator name: (identifier) value: (arrow_function)) @function
      (variable_declarator name: (identifier) value: (function_expression)) @function
      (public_field_definition value: (arrow_function)) @method
    `,
  },
  ".tsx": {
    name: "TypeScript (React)",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-tsx.wasm"), // TSX uses a unique parser
    query: `
      (function_declaration) @function
      (method_definition) @method
      (class_declaration) @class
      (interface_declaration) @interface
      (enum_declaration) @enum
      (type_alias_declaration) @type
      (variable_declarator name: (identifier) value: (arrow_function)) @function
      (variable_declarator name: (identifier) value: (function_expression)) @function
      (public_field_definition value: (arrow_function)) @method
    `,
  },
  ".js": {
    name: "JavaScript",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-javascript.wasm"),
    query: `
      (function_declaration) @function
      (method_definition) @method
      (class_declaration) @class
      (variable_declarator name: (identifier) value: (arrow_function)) @function
      (variable_declarator name: (identifier) value: (function_expression)) @function
      (field_definition value: (arrow_function)) @method
    `,
  },
  ".jsx": {
    name: "JavaScript (React)",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-javascript.wasm"), // JS parser handles JSX
    query: `
      (function_declaration) @function
      (method_definition) @method
      (class_declaration) @class
      (variable_declarator name: (identifier) value: (arrow_function)) @function
      (variable_declarator name: (identifier) value: (function_expression)) @function
      (field_definition value: (arrow_function)) @method
    `,
  },
  ".py": {
    name: "Python",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-python.wasm"),
    query: `
      (function_definition) @function
      (class_definition) @class
    `,
  },
  ".go": {
    name: "Go",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-go.wasm"),
    query: `
      (function_declaration) @function
      (method_declaration) @method
      (type_declaration) @class
    `,
  },
  ".cpp": {
    name: "C++",
    wasmPath: path.join(process.cwd(), "parsers", "tree-sitter-cpp.wasm"),
    query: `
      (function_definition) @function
      (class_specifier) @class
      (struct_specifier) @class
    `,
  },
};

// Symbols longer than this get split into overlapping parts so they stay
// within embedding / LLM context budgets. Overlap keeps logic that straddles
// a split boundary understandable in both parts.
const CHUNK_LIMITS = {
  maxLines: 200,
  overlapLines: 10,
};

export class AstChunkingService {
  private isInitialized = false;
  private loadedLanguages: Map<string, Language> = new Map();

  public async init() {
    if (this.isInitialized) return;
    try {
      await Parser.init();
      this.isInitialized = true;
      console.log("[AST Chunker] Web-Tree-Sitter initialized successfully.");
    } catch (error) {
      console.error("[AST Chunker] Failed to initialize Web-Tree-Sitter:", error);
      throw error;
    }
  }

  private generateHash(content: string): string {
    return crypto.createHash("sha256").update(content).digest("hex");
  }

  private async getLanguage(wasmPath: string): Promise<Language | null> {
    if (this.loadedLanguages.has(wasmPath)) {
      return this.loadedLanguages.get(wasmPath)!;
    }
    if (!fs.existsSync(wasmPath)) {
      console.warn(`[AST Chunker] Missing parser at: ${wasmPath}. Gracefully skipping.`);
      return null;
    }
    try {
      const language = await Language.load(wasmPath);
      this.loadedLanguages.set(wasmPath, language);
      return language;
    } catch (error) {
      console.error(`[AST Chunker] Corrupted WASM file at ${wasmPath}`, error);
      return null;
    }
  }

  // --- Symbol name resolution ------------------------------------------
  // Different grammars put "name" in different places (e.g. Go wraps it in
  // a type_spec). Try the direct field first, then known special cases,
  // then fall back to the first identifier-like named child.
  private resolveSymbolName(node: any): string {
    const direct = node.childForFieldName?.("name");
    if (direct?.text) return direct.text;

    if (node.type === "type_declaration") {
      for (const child of node.namedChildren ?? []) {
        if (child.type === "type_spec") {
          const specName = child.childForFieldName?.("name");
          if (specName?.text) return specName.text;
        }
      }
    }

    for (const child of node.namedChildren ?? []) {
      if (
        child.type === "identifier" ||
        child.type === "type_identifier" ||
        child.type === "property_identifier" ||
        child.type === "field_identifier"
      ) {
        return child.text;
      }
    }

    return "anonymous";
  }

  // Walks up to find an enclosing class/interface/struct so methods can
  // carry a qualified name like "UserService.createUser" — important for
  // interview-mode context and for disambiguating same-named methods.
  private resolveParentSymbol(node: any): string | null {
    let current = node.parent;
    let depth = 0;
    while (current && depth < 6) {
      if (
        [
          "class_declaration",
          "class_specifier",
          "struct_specifier",
          "interface_declaration",
        ].includes(current.type)
      ) {
        const name = this.resolveSymbolName(current);
        return name !== "anonymous" ? name : null;
      }
      current = current.parent;
      depth++;
    }
    return null;
  }

  // Detects export / export default wrapping so retrieval can weight public
  // API surface differently from internal helpers.
  private resolveIsExported(node: any): boolean {
    let current = node.parent;
    let depth = 0;
    while (current && depth < 3) {
      if (typeof current.type === "string" && current.type.includes("export")) return true;
      current = current.parent;
      depth++;
    }
    return false;
  }

  // Pulls in immediately preceding comments/decorators (JSDoc, Python
  // docstrings-via-decorator, TS decorators) so a chunk carries the intent
  // behind the code, not just the code itself.
  private resolveLeadingContext(node: any): { boundaryNode: any; docstring: string | null } {
    let boundaryNode = node;
    const docstringParts: string[] = [];

    // Python: decorators are siblings of the def, both wrapped in decorated_definition
    if (node.parent?.type === "decorated_definition") {
      boundaryNode = node.parent;
    }

    let sibling = boundaryNode.previousNamedSibling;
    while (sibling && (sibling.type === "comment" || sibling.type === "decorator")) {
      docstringParts.unshift(sibling.text);
      boundaryNode = sibling;
      sibling = sibling.previousNamedSibling;
    }

    return {
      boundaryNode,
      docstring: docstringParts.length ? docstringParts.join("\n") : null,
    };
  }

  // Splits an oversized symbol into overlapping line-window parts so no
  // single chunk blows past embedding/LLM context limits.
  private splitLargeChunk(
    base: Omit<ChunkMetadata, "content" | "content_hash" | "chunk_index" | "chunk_total">,
    fullText: string,
  ): ChunkMetadata[] {
    const lines = fullText.split("\n");
    if (lines.length <= CHUNK_LIMITS.maxLines) {
      return [{ ...base, content: fullText, content_hash: this.generateHash(fullText) }];
    }

    const parts: ChunkMetadata[] = [];
    const step = CHUNK_LIMITS.maxLines - CHUNK_LIMITS.overlapLines;
    const totalParts = Math.ceil(lines.length / step);
    let partIndex = 0;

    for (let i = 0; i < lines.length; i += step) {
      const sliceLines = lines.slice(i, i + CHUNK_LIMITS.maxLines);
      const sliceText = sliceLines.join("\n");
      parts.push({
        ...base,
        symbol_name: `${base.symbol_name} (part ${partIndex + 1}/${totalParts})`,
        start_line: base.start_line + i,
        end_line: base.start_line + i + sliceLines.length - 1,
        content: sliceText,
        content_hash: this.generateHash(sliceText),
        chunk_index: partIndex + 1,
        chunk_total: totalParts,
      });
      partIndex++;
      if (i + CHUNK_LIMITS.maxLines >= lines.length) break;
    }
    return parts;
  }

  public async chunkFile(filePath: string, sourceCode: string): Promise<ChunkMetadata[]> {
    if (!this.isInitialized) {
      await this.init(); // Auto-initialize if forgotten
    }

    const ext = path.extname(filePath).toLowerCase();
    const config = LANGUAGE_REGISTRY[ext as keyof typeof LANGUAGE_REGISTRY];

    // Safely ignore unknown file types silently
    if (!config) return [];

    let parser: Parser | null = null;
    let tree: any = null;
    let query: Query | null = null;

    try {
      const language = await this.getLanguage(config.wasmPath);
      if (!language) return [];

      parser = new Parser();
      parser.setLanguage(language);

      tree = parser.parse(sourceCode);
      if (!tree) {
        console.warn(`[AST Chunker] Failed to build syntax tree for ${filePath}`);
        return [];
      }

      try {
        query = new Query(language, config.query);
      } catch (queryError) {
        console.error(`[AST Chunker] Invalid Tree-Sitter Query for ${ext} files:`, queryError);
        return [];
      }

      const matches = query.matches(tree.rootNode);
      const chunks: ChunkMetadata[] = [];
      const seenRanges = new Set<string>(); // dedupe when multiple patterns hit the same node

      for (const match of matches) {
        for (const capture of match.captures) {
          const node = capture.node;
          const rangeKey = `${node.startIndex}-${node.endIndex}`;
          if (seenRanges.has(rangeKey)) continue;
          seenRanges.add(rangeKey);

          try {
            const symbolType = capture.name;
            const symbolName = this.resolveSymbolName(node);
            const parentSymbol = this.resolveParentSymbol(node);
            const qualifiedName = parentSymbol ? `${parentSymbol}.${symbolName}` : symbolName;
            const isExported = this.resolveIsExported(node);
            const { boundaryNode, docstring } = this.resolveLeadingContext(node);

            const rawSpan = `${boundaryNode.startIndex !== node.startIndex ? "" : ""}${sourceCode.slice(
              boundaryNode.startIndex,
              node.endIndex,
            )}`;

            const header = [
              `// File: ${filePath}`,
              `// Language: ${config.name}`,
              `// Type: ${symbolType}`,
              `// Name: ${qualifiedName}`,
              isExported ? `// Exported: true` : null,
            ]
              .filter(Boolean)
              .join("\n");

            const enrichedContent = `${header}\n${rawSpan}`.trim();

            const base = {
              file_path: filePath,
              language: config.name,
              symbol_type: symbolType,
              symbol_name: symbolName,
              qualified_name: qualifiedName,
              parent_symbol: parentSymbol ?? undefined,
              is_exported: isExported,
              docstring,
              start_line: boundaryNode.startPosition.row + 1,
              end_line: node.endPosition.row + 1,
            };

            chunks.push(...this.splitLargeChunk(base, enrichedContent));
          } catch (nodeError) {
            // One malformed capture shouldn't take down chunking for the whole file.
            console.error(`[AST Chunker] Failed to process a symbol in ${filePath}:`, nodeError);
          }
        }
      }

      // Fallback: the parser succeeded but the query found nothing (script-style
      // file, config file, top-level-only code). Don't silently drop it from
      // the index — index the whole file instead of returning nothing.
      if (chunks.length === 0 && sourceCode.trim().length > 0) {
        const fallbackContent = `// File: ${filePath}\n// Language: ${config.name}\n// Type: file\n${sourceCode}`.trim();
        chunks.push(
          ...this.splitLargeChunk(
            {
              file_path: filePath,
              language: config.name,
              symbol_type: "file",
              symbol_name: path.basename(filePath),
              qualified_name: path.basename(filePath),
              parent_symbol: undefined,
              is_exported: false,
              docstring: null,
              start_line: 1,
              end_line: sourceCode.split("\n").length,
            },
            fallbackContent,
          ),
        );
      }

      console.log(`[AST Chunker] Extracted ${chunks.length} chunk(s) from ${filePath}`);
      return chunks;
    } catch (error) {
      console.error(`[AST Chunker] Unexpected error processing ${filePath}:`, error);
      return [];
    } finally {
      // Always release WASM memory, even if the parser crashes.
      if (tree) tree.delete();
      if (query) query.delete();
      if (parser) parser.delete();
    }
  }

  public async extractFileAstMetadata(
    filePath: string,
    sourceCode: string,
  ): Promise<FileASTMetadata | null> {
    if (!this.isInitialized) await this.init();
 
    const ext = path.extname(filePath).toLowerCase();
    const config = LANGUAGE_REGISTRY[ext as keyof typeof LANGUAGE_REGISTRY];
    if (!config) return null;
 
    let parser: Parser | null = null;
    let tree: any = null;
 
    try {
      const language = await this.getLanguage(config.wasmPath);
      if (!language) return null;
 
      parser = new Parser();
      parser.setLanguage(language);
      tree = parser.parse(sourceCode);
      if (!tree) return null;
 
      const imports = new Set<string>();
      const exports = new Set<string>();
      const decorators = new Set<string>();
      const inheritance: { child: string; parents: string[] }[] = [];
 
      const visit = (node: any) => {
        switch (node.type) {
          case "import_statement":
          case "import_from_statement": {
            const src = node.childForFieldName?.("source");
            imports.add(src?.text ? src.text.replace(/['"]/g, "") : node.text.split("\n")[0].trim());
            break;
          }
          case "export_statement":
            exports.add(node.text.split("\n")[0].trim());
            break;
          case "decorator":
            decorators.add(node.text.trim());
            break;
          case "class_declaration":
          case "class_specifier": {
            const nameNode = node.childForFieldName?.("name");
            const heritage = node.childForFieldName?.("superclass") ?? node.childForFieldName?.("heritage");
            if (nameNode?.text && heritage?.text) {
              inheritance.push({
                child: nameNode.text,
                parents: [heritage.text.replace(/^extends\s+/, "").trim()],
              });
            }
            break;
          }
          default:
            break;
        }
        for (const child of node.namedChildren ?? []) visit(child);
      };
      visit(tree.rootNode);
 
      const symbols = await this.chunkFile(filePath, sourceCode);
 
      return {
        filePath,
        folderPath: path.dirname(filePath),
        language: config.name,
        imports: Array.from(imports),
        exports: Array.from(exports),
        classes: symbols.filter((s) => s.symbol_type === "class").map((s) => s.symbol_name),
        interfaces: symbols.filter((s) => s.symbol_type === "interface").map((s) => s.symbol_name),
        functions: symbols
          .filter((s) => s.symbol_type === "function" || s.symbol_type === "method")
          .map((s) => s.qualified_name ?? s.symbol_name),
        decorators: Array.from(decorators),
        annotations: [], // reserved for languages with distinct annotation syntax (e.g. Java)
        inheritance,
        sourceHash: this.generateHash(sourceCode),
      };
    } catch (error) {
      console.error(`[AST Chunker] Failed to extract file metadata for ${filePath}:`, error);
      return null;
    } finally {
      if (tree) tree.delete();
      if (parser) parser.delete();
    }
  }

}

export const astChunker = new AstChunkingService();