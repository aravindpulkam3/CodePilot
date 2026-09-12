import { Parser, Language, Query } from "web-tree-sitter";
import crypto from "crypto";
import path from "path";
import fs from "fs";

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
      (public_field_definition value: (function_expression)) @method
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
      (public_field_definition value: (function_expression)) @method
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
      (field_definition value: (function_expression)) @method
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
      (field_definition value: (function_expression)) @method
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
      (type_spec) @class
      (type_alias) @class
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

// Hard limit for the full embedding payload, including whitespace and headers.
const CHUNK_BUDGET_CHARS = 6000;

// Minimum non-whitespace characters a top-level gap needs before it earns its
// own chunk. Keeps a stray blank line or lone "}" between two functions from
// becoming a retrievable row.
const MIN_TOP_LEVEL_GAP_CHARS = 10;

interface SymbolMeta {
  symbolType: string;
  symbolName: string;
  qualifiedName: string;
  parentSymbol: string | null;
  isExported: boolean;
  docstring: string | null;
  signature?: string;
}

interface PartInfo {
  index: number;
  total: number;
}

interface Range {
  startIndex: number;
  endIndex: number;
  startRow: number;
  endRow: number;
  context?: string;
}

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
    if (!fs.existsSync(wasmPath)) {//This checks the filesystem.
      console.warn(`[AST Chunker] Missing parser at: ${wasmPath}.`);
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

  private measureSize(text: string): number {
    return text.length;
  }

  private compact(text: string, limit = 1000): string {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (normalized.length <= limit) return normalized;
    const half = Math.floor((limit - 5) / 2);
    const head = normalized.slice(0, half).replace(/[\uD800-\uDBFF]$/, "");
    const tail = normalized.slice(-half).replace(/^[\uDC00-\uDFFF]/, "");
    return `${head} ... ${tail}`;
  }

  private contextHeader(ancestors: string[]): string {
    if (!ancestors.length) return "";
    // Compact each ancestor separately: truncating the joined path would erase
    // entire intermediate conditions. Fail safely for unrepresentable depth.
    const perAncestor = Math.floor((1000 - (ancestors.length - 1) * 3) / ancestors.length);
    if (perAncestor < 24) throw new Error("Control-flow nesting exceeds the context budget");
    return ancestors.map((ancestor) => this.compact(ancestor, perAncestor)).join(" > ");
  }

  private resolveCppDeclarator(node: any): string | null {
    if (!node) return null;
    if (node.type === "operator_cast") return node.text.split("(")[0].trim();
    if (["identifier", "field_identifier", "qualified_identifier", "destructor_name", "operator_name"].includes(node.type)) {
      return node.text;
    }
    const declarator = node.childForFieldName?.("declarator");
    if (declarator) return this.resolveCppDeclarator(declarator);
    // Parenthesized declarators do not expose a declarator field.
    for (const child of node.namedChildren ?? []) {
      if (child.type.includes("declarator") || child.type === "operator_cast") {
        const name = this.resolveCppDeclarator(child);
        if (name) return name;
      }
    }
    return null;
  }

  // --- Symbol name resolution ------------------------------------------
  // Different grammars put "name" in different places (e.g. Go wraps it in
  // a type_spec). Try the direct field first, then known special cases,
  // then fall back to the first identifier-like named child.
  private resolveSymbolName(node: any): string {
    if (node.type === "class_static_block") return "static";
    const direct = node.childForFieldName?.("name");
    if (direct?.text) return direct.text;

    const cppName = this.resolveCppDeclarator(node.childForFieldName?.("declarator"));
    if (cppName) return cppName;

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
    const receiver = node.childForFieldName?.("receiver");
    const receiverType = receiver?.namedChildren?.[0]?.childForFieldName?.("type");
    if (receiverType) return receiverType.text.replace(/^\*\s*/, "");
    let current = node.parent;
    let depth = 0;
    while (current && depth < 6) {
      if (
        [
          "class_declaration",
          "class_definition",
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

  // Finds a node's body/block field so we can walk its statements (AST-
  // boundary splitting) or find where its signature ends (skeleton
  // declaration/member lines). Go's struct/interface body sits one level
  // deeper, inside type_declaration -> type_spec -> type (mirrors
  // resolveSymbolName's Go special case). Returns null if the grammar has
  // nothing body-shaped here (e.g. an interface method signature with no
  // body) — callers treat that as "nothing further to recurse into."
  private findBodyField(node: any): any | null {
    if (!node) return null;
    const body = node.childForFieldName?.("body");
    if (body) return body;
    if (node.type === "type_spec") {
      const type = node.childForFieldName?.("type");
      return type?.namedChildren?.find((child: any) => child.type === "field_declaration_list") ?? null;
    }
    const value = node.childForFieldName?.("value");
    if (value && ["arrow_function", "function_expression"].includes(value.type)) {
      return value.childForFieldName?.("body") ?? null;
    }
    if (node.type === "type_declaration") {
      for (const child of node.namedChildren ?? []) {
        if (child.type === "type_spec") {
          const typeNode = child.childForFieldName?.("type");
          const nestedBody = typeNode?.childForFieldName?.("body");
          if (nestedBody) return nestedBody;
        }
      }
    }
    return null;
  }

  private signature(node: any, sourceCode: string): string {
    const body = this.findBodyField(node);
    return this.compact(sourceCode.slice(node.startIndex, body?.startIndex ?? node.endIndex));
  }

  private isContained(inner: any, outer: any): boolean {
    return inner !== outer && inner.startIndex >= outer.startIndex && inner.endIndex <= outer.endIndex;
  }

  // Runs the language's tree-sitter query and returns every captured node,
  // deduped by exact span (guards two patterns matching the same node) —
  // this is the raw symbol inventory shared by chunkFile() (which decides
  // HOW to chunk them, based on size/containment) and
  // extractFileAstMetadata() (which just wants to know what's declared,
  // independent of any chunking decision).
  private captureSymbols(rootNode: any, query: Query): Array<{ node: any; symbolType: string }> {
    const matches = query.matches(rootNode);
    const seenRanges = new Set<string>();
    const out: Array<{ node: any; symbolType: string }> = [];
    for (const match of matches) {
      for (const capture of match.captures) {
        const node = capture.node;
        const rangeKey = `${node.startIndex}-${node.endIndex}`;
        if (seenRanges.has(rangeKey)) continue;
        seenRanges.add(rangeKey);
        out.push({ node, symbolType: capture.name });
      }
    }
    return out;
  }

  private buildHeader(opts: {
    filePath: string;
    languageName: string;
    symbolType: string;
    qualifiedName: string;
    isExported: boolean;
    parentSymbol?: string | null;
    partInfo?: PartInfo;
    signature?: string;
    context?: string;
  }): string {
    return [
      `// File: ${this.compact(opts.filePath, 400)}`,
      `// Language: ${opts.languageName}`,
      `// Type: ${opts.symbolType}`,
      `// Name: ${this.compact(opts.qualifiedName, 400)}`,
      opts.isExported ? `// Exported: true` : null,
      opts.parentSymbol ? `// Class: ${this.compact(opts.parentSymbol, 400)}` : null,
      opts.partInfo ? `// Part: ${opts.partInfo.index} of ${opts.partInfo.total}` : null,
      opts.partInfo && opts.signature ? `// Signature: ${opts.signature}` : null,
      opts.context ? `// Context: ${opts.context}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  // Builds one chunk covering [rangeStart, rangeEnd) of sourceCode — used
  // both for a whole-node chunk (fits the budget) and for one AST-boundary
  // part of an oversized symbol. qualified_name stays identical across
  // parts (never suffixed); only symbol_name and the chunk_index/chunk_total
  // columns carry the part distinction, plus the header's own "// Part:"
  // line — deliberate, see the plan's note on today's ambiguous behavior.
  private buildChunkFromRange(
    rangeStart: number,
    rangeEnd: number,
    sourceCode: string,
    filePath: string,
    config: LangConfig,
    meta: SymbolMeta,
    startLine: number,
    endLine: number,
    partInfo?: PartInfo,
    context?: string,
  ): ChunkMetadata {
    const symbolName = partInfo ? `${meta.symbolName} (part ${partInfo.index}/${partInfo.total})` : meta.symbolName;
    const header = this.buildHeader({
      filePath,
      languageName: config.name,
      symbolType: meta.symbolType,
      qualifiedName: meta.qualifiedName,
      isExported: meta.isExported,
      parentSymbol: meta.parentSymbol,
      partInfo,
      signature: meta.signature,
      context,
    });
    const content = `${header}\n${sourceCode.slice(rangeStart, rangeEnd)}`.trim();
    return {
      file_path: filePath,
      language: config.name,
      symbol_type: meta.symbolType,
      symbol_name: symbolName,
      qualified_name: meta.qualifiedName,
      parent_symbol: meta.parentSymbol ?? undefined,
      is_exported: meta.isExported,
      docstring: meta.docstring,
      start_line: startLine,
      end_line: endLine,
      content,
      content_hash: this.generateHash(content),
      chunk_index: partInfo?.index,
      chunk_total: partInfo?.total,
    };
  }

  // Preserve all source intervals, preferring whole AST children. Textual cuts
  // are reserved for leaves that cannot be reduced further by the grammar.
  private buildAstAwareParts(
    node: any, sourceCode: string, wholeStart: number, wholeEnd: number,
    capacity: (context: string) => number,
  ): Range[] {
    const lineStarts = [0];
    for (let i = 0; i < sourceCode.length; i++) {
      if (sourceCode[i] === "\n") lineStarts.push(i + 1);
    }
    const row = (index: number): number => {
      let low = 0;
      let high = lineStarts.length;
      while (low + 1 < high) {
        const mid = (low + high) >>> 1;
        if (lineStarts[mid] <= index) low = mid;
        else high = mid;
      }
      return low;
    };
    const parts: Range[] = [];
    const emit = (start: number, end: number, context: string) => {
      if (end <= start) return;
      const previous = parts[parts.length - 1];
      if (previous && previous.context === context && previous.endIndex === start &&
          end - previous.startIndex <= capacity(context)) {
        previous.endIndex = end;
        previous.endRow = row(end - 1);
      } else {
        parts.push({ startIndex: start, endIndex: end, startRow: row(start), endRow: row(end - 1), context });
      }
    };
    const textual = (start: number, end: number, context: string) => {
      const limit = capacity(context);
      if (limit < 2) throw new Error("Chunk headers leave no room for source");
      while (start < end) {
        let cut = Math.min(end, start + limit);
        if (cut < end) {
          const newline = sourceCode.lastIndexOf("\n", cut - 1);
          if (newline >= start) cut = newline + 1;
          if (cut > start && /[\uD800-\uDBFF]/.test(sourceCode[cut - 1]) &&
              /[\uDC00-\uDFFF]/.test(sourceCode[cut])) cut--;
        }
        emit(start, cut, context);
        start = cut;
      }
    };
    const walk = (current: any, start: number, end: number, ancestors: string[]) => {
      const context = this.contextHeader(ancestors);
      if (end - start <= capacity(context)) {
        emit(start, end, context);
        return;
      }
      const body = this.findBodyField(current);
      const isControl = /(?:statement|clause|case|block|default)$/.test(current?.type ?? "");
      const container = !isControl && body?.namedChildren?.length ? body : current;
      const children: any[] = (container?.namedChildren ?? []).filter(
        (child: any) => child.startIndex >= start && child.endIndex <= end &&
          child.endIndex > child.startIndex,
      );
      if (!children.length) {
        textual(start, end, context);
        return;
      }
      let nested = ancestors;
      if (current && isControl &&
          !["expression_statement", "return_statement", "lexical_declaration"].includes(current.type)) {
        const contextBody = body ?? children.find((child) => /block|body/.test(child.type));
        const firstStatement = children.find((child) => child.type.endsWith("statement"));
        const prefixEnd = contextBody?.startIndex ?? firstStatement?.startIndex ?? children[0].startIndex;
        let prefix = this.compact(sourceCode.slice(current.startIndex, prefixEnd), 240);
        if (current.type === "do_statement") {
          const condition = current.childForFieldName?.("condition");
          if (condition) prefix += ` while ${this.compact(condition.text, 240)}`;
        }
        nested = [...ancestors, prefix || current.type];
      } else if (body && current !== node) {
        nested = [...ancestors, this.signature(current, sourceCode)];
      }
      // Keep braces/comments/branch keywords in the source and carry the
      // enclosing semantic prefix with every recursively emitted inner part.
      let cursor = start;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const childEnd = i === children.length - 1 ? end : child.endIndex;
        const alternative = current?.childForFieldName?.("alternative");
        const childContext = alternative && alternative.id === child.id && child.type !== "else_clause"
          ? [...nested, "else"] : nested;
        walk(child, cursor, childEnd, childContext);
        cursor = childEnd;
      }
    };
    walk(node, wholeStart, wholeEnd, []);
    return parts;
  }

  private boundedChunks(
    node: any, start: number, end: number, sourceCode: string,
    filePath: string, config: LangConfig, meta: SymbolMeta,
    startLine: number, endLine: number,
  ): ChunkMetadata[] {
    const whole = this.buildChunkFromRange(start, end, sourceCode, filePath, config, meta, startLine, endLine);
    if (this.measureSize(whole.content) <= CHUNK_BUDGET_CHARS) return [whole];
    // The number of nonempty parts cannot exceed the source's UTF-16 length.
    // Reserve that digit width so final numbering cannot exceed the budget.
    const maxParts = Math.max(1, sourceCode.length);
    const capacity = (context: string) => CHUNK_BUDGET_CHARS - 1 - this.buildHeader({
      filePath, languageName: config.name, symbolType: meta.symbolType,
      qualifiedName: meta.qualifiedName, parentSymbol: meta.parentSymbol,
      isExported: meta.isExported, signature: meta.signature, context,
      partInfo: { index: maxParts, total: maxParts },
    }).length;
    const parts = this.buildAstAwareParts(node, sourceCode, start, end, capacity);
    return parts.map((part, i) => this.buildChunkFromRange(
      part.startIndex, part.endIndex, sourceCode, filePath, config, meta,
      part.startRow + 1, part.endRow + 1, { index: i + 1, total: parts.length }, part.context,
    ));
  }

  // Retain declarations that capture queries omit, stripping executable bodies.
  private structuralDeclaration(node: any, sourceCode: string): string {
    const body = this.findBodyField(node);
    if (body) return `${sourceCode.slice(node.startIndex, body.startIndex).trimEnd()} { ... }`;
    let result = "";
    let cursor = node.startIndex;
    for (const child of node.namedChildren ?? []) {
      result += sourceCode.slice(cursor, child.startIndex);
      result += this.structuralDeclaration(child, sourceCode);
      cursor = child.endIndex;
    }
    return result + sourceCode.slice(cursor, node.endIndex);
  }

  private buildClassSkeletonAndMembers(
    classNode: any, meta: SymbolMeta, boundaryNode: any,
    captured: Array<{ node: any; symbolType: string }>, sourceCode: string,
    filePath: string, config: LangConfig,
  ): ChunkMetadata[] | null {
    const body = this.findBodyField(classNode);
    if (!body) return null;
    const directMembers = captured.filter((c) => this.isContained(c.node, classNode) &&
      !captured.some((mid) => this.isContained(mid.node, classNode) && this.isContained(c.node, mid.node)));
    for (const declaration of body.namedChildren) {
      if (this.findBodyField(declaration) && !directMembers.some((member) =>
        (member.node.startIndex === declaration.startIndex && member.node.endIndex === declaration.endIndex) ||
        this.isContained(member.node, declaration))) {
        directMembers.push({ node: declaration, symbolType: declaration.type === "class_static_block" ? "block" : "method" });
      }
    }
    directMembers.sort((a, b) => a.node.startIndex - b.node.startIndex);
    if (!directMembers.length) return null;
    const declarations = body.namedChildren.map((child: any) => this.structuralDeclaration(child, sourceCode));
    const opening = sourceCode.slice(boundaryNode.startIndex, body.startIndex);
    const braces = body.text.startsWith("{");
    const lines = [opening + (braces ? "{" : ""), ...declarations.map((s: string) => `  ${s}`), ...(braces ? ["}"] : [])];
    const skeletonSource = lines.join("\n");
    let cursor = 0;
    const skeletonNodes = lines.map((line: string) => {
      const startIndex = cursor;
      cursor += line.length + 1;
      return { startIndex, endIndex: cursor - 1, namedChildren: [] };
    });
    const skeleton = this.boundedChunks({ namedChildren: skeletonNodes }, 0, skeletonSource.length,
      skeletonSource, filePath, config, { ...meta, symbolType: "class_skeleton" },
      boundaryNode.startPosition.row + 1, classNode.endPosition.row + 1);
    // Synthetic skeleton ranges cite the original class, not generated lines.
    for (const chunk of skeleton) {
      chunk.start_line = boundaryNode.startPosition.row + 1;
      chunk.end_line = classNode.endPosition.row + 1;
    }
    return [...skeleton, ...directMembers.flatMap((member) =>
      this.processNode(member.node, member.symbolType, captured, sourceCode, filePath, config))];
  }

  private processNode(
    node: any, symbolType: string, captured: Array<{ node: any; symbolType: string }>,
    sourceCode: string, filePath: string, config: LangConfig,
  ): ChunkMetadata[] {
    const symbolName = this.resolveSymbolName(node);
    const parentSymbol = this.resolveParentSymbol(node);
    const qualifiedName = parentSymbol ? `${parentSymbol}.${symbolName}` : symbolName;
    const { boundaryNode, docstring } = this.resolveLeadingContext(node);
    const meta: SymbolMeta = { symbolType, symbolName, qualifiedName, parentSymbol,
      isExported: this.resolveIsExported(node), docstring, signature: this.signature(node, sourceCode) };
    const whole = this.buildChunkFromRange(boundaryNode.startIndex, node.endIndex, sourceCode,
      filePath, config, meta, boundaryNode.startPosition.row + 1, node.endPosition.row + 1);
    if (this.measureSize(whole.content) <= CHUNK_BUDGET_CHARS) return [whole];
    if (symbolType === "class") {
      const skeleton = this.buildClassSkeletonAndMembers(node, meta, boundaryNode, captured, sourceCode, filePath, config);
      if (skeleton) return skeleton;
    }
    return this.boundedChunks(node, boundaryNode.startIndex, node.endIndex, sourceCode,
      filePath, config, meta, boundaryNode.startPosition.row + 1, node.endPosition.row + 1);
  }

  // Everything at file scope that no captured symbol covers: imports,
  // side-effecting calls (app.use(...), route registration), top-level
  // constants, trailing bootstrap code. Before this, a file containing even
  // one function silently dropped all of it — buildWholeFileFallback only runs
  // when NOTHING was captured, so this material was never chunked, never
  // embedded, and could never be retrieved.
  //
  // `consumed` MUST be each root's [boundaryNode.startIndex, node.endIndex),
  // the same span processNode chunks — using the bare node start instead would
  // put a symbol's leading JSDoc in both its own chunk and the gap before it.
  private buildTopLevelGapChunks(
    consumed: { start: number; end: number }[],
    sourceCode: string,
    filePath: string,
    config: LangConfig,
    rootNode: any,
  ): ChunkMetadata[] {
    const merged: { start: number; end: number }[] = [];
    for (const range of [...consumed].sort((a, b) => a.start - b.start)) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }

    // The complement of the consumed spans over the whole file.
    const gaps: { start: number; end: number }[] = [];
    let cursor = 0;
    for (const range of merged) {
      if (range.start > cursor) gaps.push({ start: cursor, end: range.start });
      cursor = Math.max(cursor, range.end);
    }
    if (cursor < sourceCode.length) gaps.push({ start: cursor, end: sourceCode.length });

    const lineStarts = [0];
    for (let i = 0; i < sourceCode.length; i++) {
      if (sourceCode[i] === "\n") lineStarts.push(i + 1);
    }
    const lineAt = (index: number): number => {
      let low = 0;
      let high = lineStarts.length;
      while (low + 1 < high) {
        const mid = (low + high) >>> 1;
        if (lineStarts[mid] <= index) low = mid;
        else high = mid;
      }
      return low + 1;
    };

    const name = `${path.basename(filePath)} (top-level)`;
    const meta: SymbolMeta = {
      symbolType: "module_top_level", symbolName: name, qualifiedName: name,
      parentSymbol: null, isExported: false, docstring: null,
    };

    const chunks: ChunkMetadata[] = [];
    for (const gap of gaps) {
      // Trim to the gap's real content, so blank runs between symbols don't
      // inflate the reported line range.
      let start = gap.start;
      let end = gap.end;
      while (start < end && /\s/.test(sourceCode[start])) start++;
      while (end > start && /\s/.test(sourceCode[end - 1])) end--;
      if (end <= start) continue;
      if (sourceCode.slice(start, end).replace(/\s+/g, "").length < MIN_TOP_LEVEL_GAP_CHARS) continue;

      chunks.push(...this.boundedChunks(rootNode, start, end, sourceCode, filePath, config, meta,
        lineAt(start), lineAt(end - 1)));
    }
    return chunks;
  }

  // Only successful parses without captured symbols use whole-file fallback.
  private buildWholeFileFallback(sourceCode: string, filePath: string, config: LangConfig, rootNode: any): ChunkMetadata[] {
    const meta: SymbolMeta = {
      symbolType: "file", symbolName: path.basename(filePath), qualifiedName: path.basename(filePath),
      parentSymbol: null, isExported: false, docstring: null,
    };
    return this.boundedChunks(rootNode, 0, sourceCode.length, sourceCode, filePath, config, meta,
      1, sourceCode.split("\n").length);
  }
  // Guards the UNIQUE(repository_id, file_path, content_hash) constraint —
  // the INSERT in repositoryIndex.service.ts has no ON CONFLICT clause, so
  // any collision within a file throws and rolls back the whole indexing
  // transaction. Mirrors documentationChunking.service.ts's existing,
  // already-proven pre-insert dedup for the same constraint.
  private dedupeByContentHash(chunks: ChunkMetadata[], filePath: string): ChunkMetadata[] {
    const seen = new Set<string>();
    const out: ChunkMetadata[] = [];
    for (const c of chunks) {
      if (seen.has(c.content_hash)) {
        console.warn(
          `[AST Chunker] Duplicate content_hash within ${filePath} for ${c.qualified_name ?? c.symbol_name} — skipping`,
        );
        continue;
      }
      seen.add(c.content_hash);
      out.push(c);
    }
    return out;
  }

  public async chunkFile(filePath: string, sourceCode: string): Promise<ChunkMetadata[]> {
    const ext = path.extname(filePath).toLowerCase();
    const config = LANGUAGE_REGISTRY[ext as keyof typeof LANGUAGE_REGISTRY];

    // Safely ignore unknown file types silently
    if (!config || !sourceCode.trim()) return [];
    if (!this.isInitialized) await this.init();

    let parser: Parser | null = null;
    let tree: any = null;
    let query: Query | null = null;

    try {
      const language = await this.getLanguage(config.wasmPath);
      if (!language) throw new Error(`Parser unavailable: ${config.wasmPath}`);

      parser = new Parser();
      parser.setLanguage(language);

      tree = parser.parse(sourceCode);
      if (!tree) throw new Error(`Failed to build syntax tree for ${filePath}`);
      query = new Query(language, config.query);

      const captured = this.captureSymbols(tree.rootNode, query);

      // Roots = captured nodes not contained inside any other captured
      // node's span. Only roots are chunking entry points — a method inside
      // a class is never independently chunked here; it's only ever reached
      // via the class's own recursion (processNode -> buildClassSkeletonAndMembers),
      // which only happens when the class is too large to stay whole. This
      // is the fix for the duplication bug: today, class + every method
      // inside it are both independently captured and both independently
      // chunked, unconditionally.
      const roots = captured.filter((c) => !captured.some((o) => o !== c && this.isContained(c.node, o.node)));

      let chunks: ChunkMetadata[] = [];
      // Each root's consumed span, recorded so the leftover top-level material
      // between them can be chunked too. resolveLeadingContext is pure and
      // cheap, and calling it here returns exactly the boundaryNode processNode
      // resolves internally — which is what keeps a symbol's leading comments
      // out of the neighbouring gap chunk.
      const consumedRanges: { start: number; end: number }[] = [];
      for (const root of roots) {
        const { boundaryNode } = this.resolveLeadingContext(root.node);
        consumedRanges.push({ start: boundaryNode.startIndex, end: root.node.endIndex });
        const symbolChunks = this.processNode(root.node, root.symbolType, captured, sourceCode, filePath, config);
        if (!symbolChunks.length) throw new Error(`No chunks produced for ${this.resolveSymbolName(root.node)}`);
        chunks.push(...symbolChunks);
      }

      if (captured.length > 0) {
        chunks.push(
          ...this.buildTopLevelGapChunks(consumedRanges, sourceCode, filePath, config, tree.rootNode),
        );
      }

      if (captured.length === 0) {
        chunks = this.buildWholeFileFallback(sourceCode, filePath, config, tree.rootNode);
      }

      if (!chunks.length || chunks.some((chunk) => this.measureSize(chunk.content) > CHUNK_BUDGET_CHARS)) {
        throw new Error("Invalid chunk output: empty file representation or exceeded payload budget");
      }
      chunks = this.dedupeByContentHash(chunks, filePath);

      console.log(`[AST Chunker] Extracted ${chunks.length} chunk(s) from ${filePath}`);
      return chunks;
    } catch (error) {
      throw new Error(`AST chunking failed for ${filePath}`, { cause: error });
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
    let query: Query | null = null;

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

      // classes/interfaces/functions are derived independently from the
      // same capture query chunkFile() uses — NOT from chunkFile()'s
      // output, which reflects chunking decisions (skeleton-vs-whole,
      // member-or-not) that have nothing to do with "what symbols does this
      // file declare." This keeps Phase 2 summarization's ground-truth
      // inventory (summarizer.service.ts feeds these lists straight into
      // the file-summary LLM prompt) complete regardless of how large any
      // given class/function is — a large class that becomes a
      // class_skeleton chunk, or a small class's methods that never get
      // their own chunk row, must still show up here. Also removes the
      // previous double-parse (this used to call chunkFile() a second time
      // solely for this).
      let classes: string[] = [];
      let interfaces: string[] = [];
      let functions: string[] = [];
      try {
        query = new Query(language, config.query);
        const captured = this.captureSymbols(tree.rootNode, query);
        for (const { node, symbolType } of captured) {
          const symbolName = this.resolveSymbolName(node);
          if (symbolType === "class") {
            classes.push(symbolName);
          } else if (symbolType === "interface") {
            interfaces.push(symbolName);
          } else if (symbolType === "function" || symbolType === "method") {
            const parentSymbol = this.resolveParentSymbol(node);
            functions.push(parentSymbol ? `${parentSymbol}.${symbolName}` : symbolName);
          }
        }
      } catch (queryError) {
        console.error(`[AST Chunker] Invalid Tree-Sitter Query for ${ext} files:`, queryError);
      }

      return {
        filePath,
        folderPath: path.dirname(filePath),
        language: config.name,
        imports: Array.from(imports),
        exports: Array.from(exports),
        classes,
        interfaces,
        functions,
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
      if (query) query.delete();
      if (parser) parser.delete();
    }
  }

}

export const astChunker = new AstChunkingService();
